import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebhookKey } from "../_shared/webhook-auth.ts";
import { normalizePhone } from "../_shared/phone-utils.ts";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import {
  type AnalysisContext,
  buildUserPrompt,
  type ConversationMessage,
  type GroundedAnalysis,
  groundAnalysis,
  isAnalysisContaminated,
  parseModelJson,
  SYSTEM_PROMPT,
} from "../_shared/ai-grounding.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const MIN_INTERVAL_MS = Number(Deno.env.get("AI_MIN_INTERVAL_MINUTES") ?? "3") * 60_000;
const MIN_NEW_MESSAGES = Number(Deno.env.get("AI_MIN_NEW_MESSAGES") ?? "1");
const MAX_CONTEXT_MESSAGES = 80;
const AI_TIMEOUT_MS = Number(Deno.env.get("AI_TIMEOUT_MS") ?? "120000");

type AuthResult =
  | { ok: true; isWebhook: false; userId: string; userEmail: string | null }
  | { ok: true; isWebhook: true; tenantId: string }
  | { ok: false; error: string };

async function authenticate(req: Request): Promise<AuthResult> {
  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (jwt) {
    const { data, error } = await supa.auth.getUser(jwt);
    if (!error && data.user) {
      return { ok: true, isWebhook: false, userId: data.user.id, userEmail: data.user.email ?? null };
    }
  }
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const result = await validateWebhookKey(apiKey);
    if (result.ok) return { ok: true, isWebhook: true, tenantId: result.tenantId };
  }
  return { ok: false, error: "unauthorized" };
}

async function callAI(systemPrompt: string, userPrompt: string): Promise<{ text: string; model: string }> {
  const apiKey = Deno.env.get("AI_API_KEY") ?? "";
  const provider = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const model = Deno.env.get("AI_MODEL") ?? (
    provider === "openai" ? "gpt-4o-mini" :
    provider === "ollama" ? "qwen2.5:7b" :
    "claude-sonnet-4-20250514"
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    if (provider === "ollama") {
      const ollamaUrl = Deno.env.get("AI_OLLAMA_URL");
      if (!ollamaUrl) throw new Error("AI_OLLAMA_URL not configured for Ollama provider");

      const ollamaKey = apiKey || Deno.env.get("AI_OLLAMA_KEY") || "";
      const endpoint = `${ollamaUrl.replace(/\/$/, "")}/api/chat`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          format: "json",
          stream: false,
          options: { temperature: 0, num_ctx: 8192 },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Ollama error ${res.status}: ${err}`);
      }
      const data = await res.json();
      return { text: data.message?.content ?? "", model };
    }

    if (provider === "openai") {
      if (!apiKey) throw new Error("AI_API_KEY not configured");
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`OpenAI error ${res.status}: ${err}`);
      }
      const data = await res.json();
      return { text: data.choices?.[0]?.message?.content ?? "", model };
    }

    // Default: Anthropic
    if (!apiKey) throw new Error("AI_API_KEY not configured");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }
    const data = await res.json();
    const content = data.content?.find((b: { type: string }) => b.type === "text");
    return { text: content?.text ?? "", model };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`AI provider timeout after ${AI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type ConversationRow = Record<string, any>;

// Contexto da análise: SOMENTE mensagens desta conversa, desta empresa.
async function loadContext(tenantId: string, conv: ConversationRow): Promise<{ ctx: AnalysisContext; unanalyzedIds: string[] }> {
  // Últimas mensagens (antes pegava as 80 mais ANTIGAS e ignorava as novas).
  const { data: rows } = await supa
    .from("whatsapp_messages")
    .select("id, direction, body, timestamp, content_type, ai_analyzed")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conv.id)
    .in("content_type", ["text", "image", "document", "location", "contact"])
    .order("timestamp", { ascending: false })
    .limit(MAX_CONTEXT_MESSAGES);
  const ordered = (rows ?? []).slice().reverse();
  const messages: ConversationMessage[] = ordered
    .filter((m) => m.body && String(m.body).trim().length > 0)
    .map((m) => ({ id: m.id, direction: m.direction, body: m.body, content_type: m.content_type, timestamp: m.timestamp }));

  const { data: tenant } = await supa.from("tenants").select("name").eq("id", tenantId).maybeSingle();
  const { data: onboarding } = await supa
    .from("tenant_onboarding")
    .select("business_segment")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // Nome real: CRM (se preenchido) ou o nome do WhatsApp. Nunca o que a IA "acha".
  let crmName: string | null = null;
  if (conv.tracking_session_id) {
    const { data: session } = await supa
      .from("tracking_sessions")
      .select("customer_name")
      .eq("id", conv.tracking_session_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    crmName = session?.customer_name ?? null;
  }
  const contact = conv.contact as ConversationRow | null;
  const contactName = (crmName || contact?.push_name || "").trim() || null;

  return {
    ctx: {
      tenantName: tenant?.name ?? null,
      businessSegment: onboarding?.business_segment ?? null,
      contactName,
      messages,
    },
    unanalyzedIds: ordered.filter((m) => !m.ai_analyzed).map((m) => m.id),
  };
}

async function updateCRM(tenantId: string, conv: ConversationRow, analysis: GroundedAnalysis) {
  if (!conv.tracking_session_id) return;
  const { data: session } = await supa
    .from("tracking_sessions")
    .select("customer_name, customer_email, customer_phone")
    .eq("id", conv.tracking_session_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!session) return;

  // Só dados escritos na conversa e só para campos vazios: não sobrescreve o CRM.
  const updates: Record<string, unknown> = {};
  const info = analysis.contact_info;
  if (info.name.value && !session.customer_name) updates.customer_name = info.name.value;
  if (info.email.value && !session.customer_email) updates.customer_email = info.email.value;
  if (info.phone.value && !session.customer_phone) {
    const normalized = normalizePhone(info.phone.value);
    if (normalized) updates.customer_phone = normalized;
  }
  if (!Object.keys(updates).length) return;

  updates.last_crm_activity_at = new Date().toISOString();
  await supa.from("tracking_sessions").update(updates).eq("id", conv.tracking_session_id).eq("tenant_id", tenantId);
  await supa.from("crm_activities").insert({
    tenant_id: tenantId,
    tracking_session_id: conv.tracking_session_id,
    activity_type: "system",
    body: "ai_data_extraction",
    metadata: { source: "ai_analyzer", fields_updated: Object.keys(updates).filter((k) => k !== "last_crm_activity_at") },
  });
}

async function saveAnalysis(
  tenantId: string,
  conv: ConversationRow,
  analysis: GroundedAnalysis,
  messagesCount: number,
  lastMsgId: string,
  model: string,
): Promise<number> {
  const insightRow = {
    tenant_id: tenantId,
    conversation_id: conv.id,
    extracted_name: analysis.contact_info.name.value,
    extracted_email: analysis.contact_info.email.value,
    extracted_phone: analysis.contact_info.phone.value,
    extracted_address: analysis.contact_info.address.value,
    products_of_interest: analysis.commercial.products_of_interest.map((p) => p.name),
    objections: analysis.commercial.objections.map((o) => o.text),
    preferences: {},
    commercial_notes: analysis.commercial_notes,
    summary: analysis.summary,
    intent: analysis.intent,
    sentiment: analysis.sentiment,
    purchase_probability: analysis.purchase_probability,
    confidence_score: analysis.sale_signals.length ? Math.max(...analysis.sale_signals.map((s) => s.confidence)) : 0,
    last_analyzed_message_id: lastMsgId,
    // Total de mensagens com texto que a análise leu (antes somava a cada execução).
    messages_analyzed_count: messagesCount,
    model_used: model,
    extracted_data: analysis.contact_info,
    evidence: {
      stage: analysis.stage,
      commercial: analysis.commercial,
      sale_signals: analysis.sale_signals,
      discarded_unsupported: analysis.discarded,
    },
    processing_basis: "legitimate_interest",
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supa
    .from("conversation_insights")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conv.id)
    .maybeSingle();
  if (existing) await supa.from("conversation_insights").update(insightRow).eq("id", existing.id).eq("tenant_id", tenantId);
  else await supa.from("conversation_insights").insert(insightRow);

  await supa.from("whatsapp_conversations").update({
    ai_summary: analysis.summary,
    ai_intent: analysis.intent,
    ai_sentiment: analysis.sentiment,
    ai_purchase_probability: analysis.purchase_probability,
    ai_analyzed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", conv.id).eq("tenant_id", tenantId);

  let created = 0;
  for (const sig of analysis.sale_signals) {
    const { data: existingSignal } = await supa
      .from("sale_signals")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conv.id)
      .eq("signal_type", sig.type)
      .in("status", ["detected", "confirmed", "converted"])
      .limit(1)
      .maybeSingle();
    if (existingSignal) continue;

    // Venda confirmada exige confirmação escrita pela empresa (validada em ai-grounding).
    const isConfirmedSale = sig.type === "confirmed_sale";
    const isDeclared = sig.type === "declared_purchase";
    const { data: inserted, error } = await supa.from("sale_signals").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      tracking_session_id: conv.tracking_session_id ?? null,
      product_name: sig.product,
      product_category: null,
      estimated_value: null,
      signal_type: sig.type,
      confidence: sig.confidence,
      evidence_text: sig.evidence,
      evidence_messages: sig.source_msg_ids,
      requires_human_confirmation: !isConfirmedSale,
      status: isConfirmedSale ? "confirmed" : "detected",
      confirmed_at: isConfirmedSale ? new Date().toISOString() : null,
      purchase_data: isConfirmedSale || isDeclared ? {
        product: sig.product,
        evidence: sig.evidence,
        detected_at: new Date().toISOString(),
        ready_for_capi: isConfirmedSale,
        requires_verification: !isConfirmedSale,
      } : null,
    }).select("id").maybeSingle();
    if (error) continue;
    created++;
    if (isConfirmedSale && inserted?.id) {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sale-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ action: "confirm_sale", tenant_id: tenantId, signal_id: inserted.id }),
      }).catch(() => {});
    }
  }
  return created;
}

async function markAnalyzed(tenantId: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) {
    await supa.from("whatsapp_messages").update({ ai_analyzed: true }).eq("tenant_id", tenantId).in("id", ids.slice(i, i + 100));
  }
}

function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "unknown_error";
  return msg.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***").replace(/key[=: ]+\S+/gi, "key=***");
}

// Chama a IA e valida a resposta contra as mensagens. Se a IA falhar ou
// devolver lixo, a análise sai só das regras sobre as mensagens.
async function analyzeWithAI(ctx: AnalysisContext): Promise<{ analysis: GroundedAnalysis; model: string; aiError: string | null }> {
  try {
    const result = await callAI(SYSTEM_PROMPT, buildUserPrompt(ctx));
    const raw = parseModelJson(result.text);
    return { analysis: groundAnalysis(raw, ctx), model: raw ? result.model : `${result.model} (resposta inválida; regras)`, aiError: raw ? null : "ai_parse_failed" };
  } catch (err) {
    const aiError = safeError(err);
    console.error("ai_call_failed:", aiError);
    return { analysis: groundAnalysis(null, ctx), model: "regras (IA indisponível)", aiError };
  }
}

// Sinais antigos sem base nas mensagens viram "rejected". Vendas já
// confirmadas/convertidas não são alteradas (registro comercial legítimo).
async function rejectUnsupportedSignals(tenantId: string, convId: string, analysis: GroundedAnalysis, ctx: AnalysisContext): Promise<number> {
  const { data: signals } = await supa
    .from("sale_signals")
    .select("id, signal_type, evidence_text, status")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", convId)
    .eq("status", "detected");
  const bodies = ctx.messages.map((m) => String(m.body ?? "").toLowerCase());
  const validTypes = new Set<string>(analysis.sale_signals.map((s) => s.type));
  // Etapas iniciais com trecho real continuam válidas mesmo abaixo da etapa atual.
  const earlyStages = analysis.stage === "abandonment" ? [] : ["interest", "high_intent"];
  let rejected = 0;
  for (const sig of signals ?? []) {
    const evidence = String(sig.evidence_text ?? "").toLowerCase().trim();
    const evidenceFound = evidence.length > 1 && bodies.some((b) => b.includes(evidence));
    if (evidenceFound && (validTypes.has(sig.signal_type) || earlyStages.includes(sig.signal_type))) continue;
    await supa.from("sale_signals").update({ status: "rejected" }).eq("id", sig.id).eq("tenant_id", tenantId);
    rejected++;
  }
  return rejected;
}

async function reprocessConversation(tenantId: string, conv: ConversationRow, useAI: boolean) {
  const { ctx, unanalyzedIds } = await loadContext(tenantId, conv);
  if (!ctx.messages.length) return { conversation_id: conv.id, skipped: "no_analyzable_content" };
  const { analysis, model, aiError } = useAI
    ? await analyzeWithAI(ctx)
    : { analysis: groundAnalysis(null, ctx), model: "regras", aiError: null };
  const lastMsgId = ctx.messages[ctx.messages.length - 1].id;
  const created = await saveAnalysis(tenantId, conv, analysis, ctx.messages.length, lastMsgId, model);
  const rejected = await rejectUnsupportedSignals(tenantId, conv.id, analysis, ctx);
  await markAnalyzed(tenantId, unanalyzedIds);
  return { conversation_id: conv.id, summary: analysis.summary, stage: analysis.stage, signals_created: created, signals_rejected: rejected, ai_error: aiError };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "analyze_conversation");
  const tenantId = String(body.tenant_id ?? (auth.isWebhook ? auth.tenantId : "") ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (auth.isWebhook) {
    if (auth.tenantId !== tenantId) return json({ error: "tenant_mismatch" }, 403);
  } else {
    const roles = action.startsWith("reprocess") ? ["owner", "admin"] as const : undefined;
    if (!(await canOperateTenantOrPlatform(supa, tenantId, auth.userId, auth.userEmail, roles ? [...roles] : undefined))) {
      return json({ error: "forbidden" }, 403);
    }
  }

  // Reprocessa as análises da empresa a partir das mensagens reais.
  // Por padrão só as contaminadas (nome/produto/objeção que não existem na conversa);
  // {"all": true} reprocessa todas.
  if (action === "reprocess_tenant") {
    const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), 500);
    const { data: insights } = await supa
      .from("conversation_insights")
      .select("conversation_id, summary, extracted_name, products_of_interest, objections")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    const results: unknown[] = [];
    let checked = 0;
    for (const insight of insights ?? []) {
      const { data: conv } = await supa
        .from("whatsapp_conversations")
        .select("*, contact:whatsapp_contacts(*)")
        .eq("id", insight.conversation_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!conv) continue;
      checked++;
      if (!body.all) {
        const { ctx } = await loadContext(tenantId, conv);
        if (!isAnalysisContaminated(insight, ctx) && !/\b(joão silva|joao silva|corte de cabelo|achei caro)\b/i.test(String(insight.summary ?? ""))) continue;
      }
      results.push(await reprocessConversation(tenantId, conv, body.use_ai !== false));
    }
    return json({ ok: true, action, checked, reprocessed: results.length, results });
  }

  const conversationId = String(body.conversation_id ?? "");
  if (!conversationId) return json({ error: "missing_conversation_id" }, 400);

  const { data: conv } = await supa
    .from("whatsapp_conversations")
    .select("*, contact:whatsapp_contacts(*)")
    .eq("id", conversationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!conv) return json({ error: "conversation_not_found" }, 404);

  if (action === "reprocess_conversation") {
    return json({ ok: true, action, ...(await reprocessConversation(tenantId, conv, body.use_ai !== false)) });
  }

  if (action === "analyze_conversation" || action === "prepare_analysis") {
    const lastAnalyzed = conv.ai_analyzed_at ? new Date(conv.ai_analyzed_at).getTime() : 0;
    const elapsed = Date.now() - lastAnalyzed;
    const { count: newMsgCount } = await supa
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .eq("ai_analyzed", false);
    const newCount = newMsgCount ?? 0;
    if (elapsed < MIN_INTERVAL_MS && newCount < MIN_NEW_MESSAGES) {
      return json({ ok: true, skipped: "cooldown", new_messages: newCount, next_eligible_ms: MIN_INTERVAL_MS - elapsed });
    }
    if (newCount === 0) return json({ ok: true, skipped: "no_new_messages" });

    const { ctx, unanalyzedIds } = await loadContext(tenantId, conv);
    if (!ctx.messages.length) return json({ ok: true, skipped: "no_analyzable_content" });
    const lastMsgId = ctx.messages[ctx.messages.length - 1].id;

    if (action === "prepare_analysis") {
      // Fluxo n8n (Prepare → Ollama → Submit): prompt sem exemplos e sem análise anterior.
      return json({
        ok: true,
        action,
        conversation_id: conversationId,
        tenant_id: tenantId,
        system_prompt: SYSTEM_PROMPT,
        user_prompt: buildUserPrompt(ctx),
        messages_count: ctx.messages.length,
        unanalyzed_count: unanalyzedIds.length,
        last_message_id: lastMsgId,
        model_suggestion: Deno.env.get("AI_MODEL") ?? "qwen2.5:7b",
        ollama_options: { temperature: 0, format: "json" },
      });
    }

    const { analysis, model, aiError } = await analyzeWithAI(ctx);
    const created = await saveAnalysis(tenantId, conv, analysis, ctx.messages.length, lastMsgId, model);
    await updateCRM(tenantId, conv, analysis);
    await markAnalyzed(tenantId, unanalyzedIds);
    return json({
      ok: true,
      conversation_id: conversationId,
      messages_analyzed: ctx.messages.length,
      summary: analysis.summary,
      stage: analysis.stage,
      sentiment: analysis.sentiment,
      purchase_probability: analysis.purchase_probability,
      sale_signals_count: analysis.sale_signals.length,
      sale_signals_created: created,
      discarded_unsupported: analysis.discarded.length,
      ai_error: aiError,
    });
  }

  if (action === "submit_analysis") {
    const aiResponseText = body.ai_response_text;
    if (!aiResponseText || typeof aiResponseText !== "string") return json({ error: "missing_ai_response_text" }, 400);

    // Valida contra as mensagens reais desta conversa (não confia no texto do n8n).
    const { ctx, unanalyzedIds } = await loadContext(tenantId, conv);
    if (!ctx.messages.length) return json({ ok: true, skipped: "no_analyzable_content" });
    const raw = parseModelJson(aiResponseText);
    const analysis = groundAnalysis(raw, ctx);
    const model = `${String(body.model_used ?? "ollama-via-n8n")}${raw ? "" : " (resposta inválida; regras)"}`;
    const lastMsgId = ctx.messages[ctx.messages.length - 1].id;
    const created = await saveAnalysis(tenantId, conv, analysis, ctx.messages.length, lastMsgId, model);
    await updateCRM(tenantId, conv, analysis);
    await markAnalyzed(tenantId, unanalyzedIds);
    return json({
      ok: true,
      action,
      conversation_id: conversationId,
      messages_analyzed: ctx.messages.length,
      summary: analysis.summary,
      stage: analysis.stage,
      sentiment: analysis.sentiment,
      purchase_probability: analysis.purchase_probability,
      sale_signals_count: analysis.sale_signals.length,
      sale_signals_created: created,
      discarded_unsupported: analysis.discarded.length,
      ai_parse_failed: !raw,
    });
  }

  if (action === "get_insights") {
    const { data: insight } = await supa
      .from("conversation_insights")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .maybeSingle();
    const { data: signals } = await supa
      .from("sale_signals")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    return json({ ok: true, insight, sale_signals: signals ?? [] });
  }

  return json({ error: "unknown_action" }, 400);
});
