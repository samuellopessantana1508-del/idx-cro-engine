import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebhookKey } from "../_shared/webhook-auth.ts";
import { normalizePhone } from "../_shared/phone-utils.ts";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";

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

const SYSTEM_PROMPT = `Você é um assistente de inteligência comercial para negócios locais brasileiros.
Analise conversas de WhatsApp e extraia informações comerciais estruturadas.

REGRAS OBRIGATÓRIAS:
- Extraia APENAS informações explicitamente mencionadas na conversa
- Se uma informação não está clara ou é ambígua, marque confiança abaixo de 0.5
- NÃO invente, suponha ou infira dados não mencionados
- Preserve exatamente como as informações foram escritas pelo contato
- Para cada dado extraído, cite a mensagem fonte
- Identifique sinais de venda baseados SOMENTE em evidências concretas
- Respeite minimização de dados: extraia apenas o necessário para CRM comercial
- Informações sensíveis (CPF, RG, dados bancários) devem ser IGNORADAS

Retorne EXCLUSIVAMENTE um JSON válido, sem markdown, sem explicações adicionais.`;

function buildUserPrompt(
  messages: Array<{ direction: string; body: string | null; timestamp: string; id: string; content_type: string }>,
  previousInsight: Record<string, unknown> | null,
): string {
  const msgLines = messages.map((m) => {
    const who = m.direction === "inbound" ? "CLIENTE" : "EMPRESA";
    const ts = new Date(m.timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const text = m.content_type === "text" ? (m.body ?? "") : `[${m.content_type}]${m.body ? ` ${m.body}` : ""}`;
    return `[${ts}] ${who} (msg:${m.id.substring(0, 8)}): ${text}`;
  }).join("\n");

  const previousContext = previousInsight
    ? `\nANÁLISE ANTERIOR (atualize com as novas mensagens, não descarte dados anteriores confirmados):\n${JSON.stringify(previousInsight, null, 2)}\n`
    : "";

  return `${previousContext}
MENSAGENS PARA ANALISAR:
${msgLines}

Retorne um JSON com esta estrutura exata:
{
  "contact_info": {
    "name": {"value": "string ou null", "confidence": 0.0-1.0, "source_msg_ids": ["ids"]},
    "email": {"value": "string ou null", "confidence": 0.0-1.0, "source_msg_ids": ["ids"]},
    "phone": {"value": "string ou null", "confidence": 0.0-1.0, "source_msg_ids": ["ids"]},
    "address": {"value": "string ou null", "confidence": 0.0-1.0, "source_msg_ids": ["ids"]}
  },
  "commercial": {
    "products_of_interest": [{"name": "string", "confidence": 0.0-1.0, "source_msg_ids": ["ids"]}],
    "objections": [{"text": "string", "source_msg_ids": ["ids"]}],
    "preferences": {"key": "value"},
    "budget_mentioned": "string ou null",
    "urgency": "low|medium|high|null"
  },
  "sale_signals": [
    {
      "type": "interest|negotiation|commitment|confirmed_sale|post_sale",
      "product": "string ou null",
      "estimated_value": null,
      "evidence": "citação curta da conversa",
      "confidence": 0.0-1.0,
      "source_msg_ids": ["ids"]
    }
  ],
  "summary": "resumo conciso da conversa em 1-2 frases",
  "intent": "intenção principal do cliente",
  "sentiment": "positive|neutral|negative",
  "purchase_probability": 0.0-1.0,
  "commercial_notes": "observações comerciais relevantes ou null"
}`;
}

async function callAI(systemPrompt: string, userPrompt: string): Promise<{ text: string; model: string }> {
  const apiKey = Deno.env.get("AI_API_KEY") ?? "";
  if (!apiKey) throw new Error("AI_API_KEY not configured");

  const provider = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const model = Deno.env.get("AI_MODEL") ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514");

  if (provider === "openai") {
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
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`OpenAI error ${res.status}: ${err}`);
    }
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content ?? "", model };
  }

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
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const content = data.content?.find((b: { type: string }) => b.type === "text");
  return { text: content?.text ?? "", model };
}

function parseAIResponse(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  text = text.substring(start, end + 1);

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractField(obj: unknown): { value: string | null; confidence: number; sources: string[] } {
  if (!obj || typeof obj !== "object") return { value: null, confidence: 0, sources: [] };
  const o = obj as Record<string, unknown>;
  return {
    value: o.value ? String(o.value) : null,
    confidence: Number(o.confidence ?? 0),
    sources: Array.isArray(o.source_msg_ids) ? o.source_msg_ids.map(String) : [],
  };
}

async function updateCRM(
  tenantId: string,
  conversationId: string,
  analysis: Record<string, unknown>,
) {
  const contact = analysis.contact_info as Record<string, unknown> | undefined;
  if (!contact) return;

  const { data: conv } = await supa
    .from("whatsapp_conversations")
    .select("tracking_session_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (!conv?.tracking_session_id) return;

  const name = extractField(contact.name);
  const email = extractField(contact.email);
  const phone = extractField(contact.phone);

  const updates: Record<string, unknown> = {};
  if (name.value && name.confidence >= 0.7) updates.customer_name = name.value;
  if (email.value && email.confidence >= 0.7) updates.customer_email = email.value;
  if (phone.value && phone.confidence >= 0.7) {
    const normalized = normalizePhone(phone.value);
    if (normalized) updates.customer_phone = normalized;
  }

  if (Object.keys(updates).length > 0) {
    updates.last_crm_activity_at = new Date().toISOString();
    await supa.from("tracking_sessions").update(updates).eq("id", conv.tracking_session_id);

    await supa.from("crm_activities").insert({
      tenant_id: tenantId,
      tracking_session_id: conv.tracking_session_id,
      activity_type: "system",
      body: "ai_data_extraction",
      metadata: {
        source: "ai_analyzer",
        fields_updated: Object.keys(updates).filter((k) => k !== "last_crm_activity_at"),
        confidence: { name: name.confidence, email: email.confidence, phone: phone.confidence },
      },
    });
  }
}

async function upsertInsight(
  tenantId: string,
  conversationId: string,
  analysis: Record<string, unknown>,
  lastMsgId: string,
  analyzedCount: number,
  model: string,
) {
  const contact = analysis.contact_info as Record<string, unknown> | undefined;
  const commercial = analysis.commercial as Record<string, unknown> | undefined;
  const saleSignals = analysis.sale_signals as Array<Record<string, unknown>> | undefined;

  const name = extractField(contact?.name);
  const email = extractField(contact?.email);
  const phone = extractField(contact?.phone);
  const address = extractField(contact?.address);

  const products = Array.isArray(commercial?.products_of_interest)
    ? (commercial.products_of_interest as Array<Record<string, unknown>>).map((p) => String(p.name ?? p)).filter(Boolean)
    : [];
  const objections = Array.isArray(commercial?.objections)
    ? (commercial.objections as Array<Record<string, unknown>>).map((o) => String(o.text ?? o)).filter(Boolean)
    : [];

  const purchaseProb = Math.min(1, Math.max(0, Number(analysis.purchase_probability ?? 0)));
  const sentiment = ["positive", "neutral", "negative"].includes(String(analysis.sentiment))
    ? String(analysis.sentiment)
    : "neutral";

  const insightRow = {
    tenant_id: tenantId,
    conversation_id: conversationId,
    extracted_name: name.value,
    extracted_email: email.value,
    extracted_phone: phone.value,
    extracted_address: address.value,
    products_of_interest: products,
    objections,
    preferences: commercial?.preferences ?? {},
    commercial_notes: analysis.commercial_notes ? String(analysis.commercial_notes) : null,
    summary: analysis.summary ? String(analysis.summary) : null,
    intent: analysis.intent ? String(analysis.intent) : null,
    sentiment,
    purchase_probability: purchaseProb,
    confidence_score: Math.min(1, Math.max(0,
      (name.confidence + email.confidence + phone.confidence) / 3,
    )),
    last_analyzed_message_id: lastMsgId,
    messages_analyzed_count: analyzedCount,
    model_used: model,
    extracted_data: analysis.contact_info ?? {},
    evidence: {
      commercial: analysis.commercial ?? {},
      sale_signals: saleSignals ?? [],
    },
    processing_basis: "legitimate_interest",
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supa
    .from("conversation_insights")
    .select("id, messages_analyzed_count")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (existing) {
    insightRow.messages_analyzed_count = (existing.messages_analyzed_count ?? 0) + analyzedCount;
    await supa.from("conversation_insights").update(insightRow).eq("id", existing.id);
  } else {
    await supa.from("conversation_insights").insert(insightRow);
  }

  await supa.from("whatsapp_conversations").update({
    ai_summary: insightRow.summary,
    ai_intent: insightRow.intent,
    ai_sentiment: insightRow.sentiment,
    ai_purchase_probability: insightRow.purchase_probability,
    ai_analyzed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", conversationId);

  let signalsCreated = 0;
  if (saleSignals && saleSignals.length > 0) {
    const { data: conv } = await supa
      .from("whatsapp_conversations")
      .select("tracking_session_id")
      .eq("id", conversationId)
      .maybeSingle();

    for (const sig of saleSignals) {
      const signalType = String(sig.type ?? "interest");
      if (!["interest", "negotiation", "commitment", "confirmed_sale", "post_sale"].includes(signalType)) continue;

      const conf = Math.min(1, Math.max(0, Number(sig.confidence ?? 0)));
      if (conf < 0.3) continue;

      const productName = sig.product ? String(sig.product) : null;
      const { data: existing } = await supa
        .from("sale_signals")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("signal_type", signalType)
        .eq("tenant_id", tenantId)
        .in("status", ["detected", "confirmed"])
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const isAutoConfirmable = signalType === "confirmed_sale" && conf >= 0.9 && sig.evidence;

      const { error: insertErr } = await supa.from("sale_signals").insert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        tracking_session_id: conv?.tracking_session_id ?? null,
        product_name: sig.product ? String(sig.product) : null,
        product_category: sig.category ? String(sig.category) : null,
        estimated_value: sig.estimated_value ? Number(sig.estimated_value) : null,
        signal_type: signalType,
        confidence: conf,
        evidence_text: sig.evidence ? String(sig.evidence) : null,
        evidence_messages: sig.source_msg_ids ?? [],
        requires_human_confirmation: !isAutoConfirmable,
        purchase_data: signalType === "confirmed_sale" ? {
          product: sig.product,
          value: sig.estimated_value,
          evidence: sig.evidence,
          detected_at: new Date().toISOString(),
          ready_for_capi: true,
        } : null,
      });
      if (!insertErr) signalsCreated++;
    }
  }
  return signalsCreated;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "analyze_conversation");
  const tenantId = String(body.tenant_id ?? (auth.isWebhook ? auth.tenantId : "") ?? "");
  const conversationId = String(body.conversation_id ?? "");

  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!conversationId) return json({ error: "missing_conversation_id" }, 400);

  if (auth.isWebhook) {
    if (auth.tenantId !== tenantId) {
      return json({ error: "tenant_mismatch" }, 403);
    }
  } else {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, auth.userId, auth.userEmail))) {
      return json({ error: "forbidden" }, 403);
    }
  }

  const { data: conv } = await supa
    .from("whatsapp_conversations")
    .select("*, contact:whatsapp_contacts(*)")
    .eq("id", conversationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!conv) return json({ error: "conversation_not_found" }, 404);

  if (action === "analyze_conversation") {
    const lastAnalyzed = conv.ai_analyzed_at ? new Date(conv.ai_analyzed_at).getTime() : 0;
    const elapsed = Date.now() - lastAnalyzed;

    const { count: newMsgCount } = await supa
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("ai_analyzed", false);

    const newCount = newMsgCount ?? 0;
    if (elapsed < MIN_INTERVAL_MS && newCount < MIN_NEW_MESSAGES) {
      return json({ ok: true, skipped: "cooldown", new_messages: newCount, next_eligible_ms: MIN_INTERVAL_MS - elapsed });
    }

    if (newCount === 0) {
      return json({ ok: true, skipped: "no_new_messages" });
    }

    const { data: allMessages } = await supa
      .from("whatsapp_messages")
      .select("id, direction, body, timestamp, content_type, ai_analyzed")
      .eq("conversation_id", conversationId)
      .in("content_type", ["text", "image", "document", "location", "contact"])
      .order("timestamp", { ascending: true })
      .limit(MAX_CONTEXT_MESSAGES);

    if (!allMessages || allMessages.length === 0) {
      return json({ ok: true, skipped: "no_text_messages" });
    }

    const textMessages = allMessages.filter((m) => m.body && m.body.trim().length > 0);
    if (textMessages.length === 0) {
      return json({ ok: true, skipped: "no_analyzable_content" });
    }

    const unanalyzedIds = allMessages.filter((m) => !m.ai_analyzed).map((m) => m.id);

    let previousInsight: Record<string, unknown> | null = null;
    const { data: existingInsight } = await supa
      .from("conversation_insights")
      .select("extracted_data, evidence, summary, intent, sentiment, purchase_probability")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (existingInsight) previousInsight = existingInsight;

    const prompt = buildUserPrompt(textMessages, previousInsight);

    let aiResult: { text: string; model: string };
    try {
      aiResult = await callAI(SYSTEM_PROMPT, prompt);
    } catch (err) {
      console.error("ai_call_failed", err);
      return json({ error: "ai_call_failed" }, 502);
    }

    const analysis = parseAIResponse(aiResult.text);
    if (!analysis) {
      return json({ error: "ai_parse_failed", raw_length: aiResult.text.length }, 502);
    }

    const lastMsgId = allMessages[allMessages.length - 1].id;
    const signalsCreated = await upsertInsight(tenantId, conversationId, analysis, lastMsgId, unanalyzedIds.length, aiResult.model);
    await updateCRM(tenantId, conversationId, analysis);

    if (unanalyzedIds.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < unanalyzedIds.length; i += batchSize) {
        const batch = unanalyzedIds.slice(i, i + batchSize);
        await supa
          .from("whatsapp_messages")
          .update({ ai_analyzed: true })
          .in("id", batch);
      }
    }

    return json({
      ok: true,
      conversation_id: conversationId,
      messages_analyzed: unanalyzedIds.length,
      summary: analysis.summary,
      sentiment: analysis.sentiment,
      purchase_probability: analysis.purchase_probability,
      sale_signals_count: Array.isArray(analysis.sale_signals) ? analysis.sale_signals.length : 0,
      sale_signals_created: signalsCreated,
    });
  }

  if (action === "get_insights") {
    const { data: insight } = await supa
      .from("conversation_insights")
      .select("*")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    const { data: signals } = await supa
      .from("sale_signals")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });

    return json({ ok: true, insight, sale_signals: signals ?? [] });
  }

  return json({ error: "unknown_action" }, 400);
});
