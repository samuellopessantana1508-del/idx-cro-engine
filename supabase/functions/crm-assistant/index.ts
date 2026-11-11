// Assistente do CRM: transforma um resumo falado/digitado em um PLANO de ações
// (contato, negociação, tarefa, resultado da ligação). NÃO grava nada: o
// usuário revisa e confirma; quem grava é a RPC crm_assistant_apply (com RLS).
// Regras: não inventar dados; interesse não é venda (nunca ganha/perdida).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseRules, zonedToUtcIso, localNow, type DialOutcome } from "../_shared/assistant-rules.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const AI_TIMEOUT_MS = Number(Deno.env.get("AI_ASSISTANT_TIMEOUT_MS") ?? 15000);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const OUTCOMES: DialOutcome[] = ["talked", "meeting", "callback", "no_answer", "not_interested", "invalid"];
const TASK_TYPES = ["call", "meeting", "follow_up", "proposal", "whatsapp", "visit", "email", "task"];
const WEEK = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

type Stage = { id: string; name: string; kind: string; position: number; pipeline_id: string };

async function callAI(system: string, user: string): Promise<string> {
  const apiKey = Deno.env.get("AI_API_KEY") ?? "";
  const provider = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const model = Deno.env.get("AI_MODEL") ?? (provider === "openai" ? "gpt-4o-mini" : provider === "ollama" ? "qwen2.5:7b" : "claude-sonnet-4-20250514");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    if (provider === "ollama") {
      const url = Deno.env.get("AI_OLLAMA_URL");
      if (!url) throw new Error("IA não configurada");
      const key = apiKey || Deno.env.get("AI_OLLAMA_KEY") || "";
      const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, stream: false, format: "json", options: { temperature: 0 },
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`IA ${res.status}`);
      return (await res.json()).message?.content ?? "";
    }
    if (!apiKey) throw new Error("IA não configurada");
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 900, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`IA ${res.status}`);
      return (await res.json()).choices?.[0]?.message?.content ?? "";
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 900, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`IA ${res.status}`);
    const data = await res.json();
    return data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw: string): Record<string, any> | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Faça login" }, 401);
  const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: ue } = await db.auth.getUser(auth.slice(7));
  if (ue || !u?.user) return json({ error: "Sessão expirada — entre de novo" }, 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Corpo inválido" }, 400); }
  const tenantId = String(body.tenant_id ?? "");
  const text = String(body.text ?? "").trim().slice(0, 4000);
  const source = body.source === "voice" ? "voice" : "text";
  const ctx = (body.context ?? {}) as { dial_lead_id?: string; contact_id?: string };
  if (!tenantId || !text) return json({ error: "Fale ou escreva o que aconteceu" }, 400);

  const { data: access } = await db.rpc("crm_my_access", { p_tenant_id: tenantId });
  if (!access?.write) return json({ error: "Sem permissão para registrar no CRM desta empresa" }, 403);

  const [{ data: tenant }, { data: settings }] = await Promise.all([
    db.from("tenants").select("timezone, name").eq("id", tenantId).maybeSingle(),
    db.from("crm_settings").select("default_pipeline_id").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  const tz = tenant?.timezone || "America/Sao_Paulo";
  const { data: stagesRaw } = await db.from("crm_stages").select("id,name,kind,position,pipeline_id")
    .eq("tenant_id", tenantId).is("archived_at", null).order("position");
  const stages = ((stagesRaw ?? []) as Stage[]).filter((s) => s.kind === "open" && (!settings?.default_pipeline_id || s.pipeline_id === settings.default_pipeline_id));

  let lead: Record<string, any> | null = null;
  if (ctx.dial_lead_id) {
    const { data } = await db.from("crm_dial_leads").select("id,name,phone,city,uf,contact_id,outcome").eq("id", ctx.dial_lead_id).maybeSingle();
    lead = data;
  }
  let contactCtx: Record<string, any> | null = null;
  const contactId = ctx.contact_id || lead?.contact_id;
  if (contactId) {
    const { data } = await db.from("crm_contacts").select("id,name,phone").eq("id", contactId).maybeSingle();
    if (data?.phone) {
      const { data: full } = await db.rpc("crm_lookup_phone", { p_tenant_id: tenantId, p_phone: data.phone });
      contactCtx = full ?? data;
    } else contactCtx = data;
  }

  const rules = parseRules(text, tz);
  const now = localNow(tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowLabel = `${WEEK[now.wd]}, ${pad(now.d)}/${pad(now.m)}/${now.y} ${pad(now.h)}:${pad(now.min)}`;

  const system = `Você registra atendimentos comerciais num CRM brasileiro. Leia o relato do vendedor e devolva SOMENTE um JSON:
{"summary": "1 frase objetiva do que aconteceu",
 "dial_outcome": ${lead ? `"talked"|"meeting"|"callback"|"no_answer"|"not_interested"|"invalid"` : "null"},
 "contact": {"name": string|null, "phone": string|null, "company": string|null, "email": string|null, "city": string|null, "uf": string|null},
 "deal": {"action": "create"|"none", "title": string|null, "value": number|null, "stage_name": string|null},
 "task": {"type": "call"|"meeting"|"follow_up"|"proposal"|"whatsapp"|"visit", "title": string, "due_local": "AAAA-MM-DDTHH:mm"} | null,
 "objection": string|null,
 "note": "anotação curta para o histórico"}
Regras:
- Use SOMENTE o que está no relato. Não invente nome, telefone, empresa ou valor: use null.
- Agora é ${nowLabel} (${tz}). Converta "amanhã", "sexta", "dia 20 às 14h" para due_local. Sem hora dita → 09:00.
- Interesse NÃO é venda. Nunca indique venda fechada; negociação só "create" se houver reunião marcada, pedido de proposta ou valor.
- dial_outcome: meeting = reunião/visita marcada; callback = pediu para ligar depois; talked = conversou sem próximo passo claro.
- Se pediu retorno ou marcou reunião, crie a task correspondente com a data dita.
- objection: o motivo de resistência dito (ex.: "achou caro", "já tem fornecedor"), senão null.
- stage_name, se usado, deve ser um destes: ${stages.map((s) => s.name).join(", ") || "(nenhum)"}.`;
  const userPrompt = [
    lead ? `Ligação do discador para: ${lead.name} (${lead.city ?? ""}/${lead.uf ?? ""}), telefone ${lead.phone}.` : "",
    contactCtx ? `Contato já cadastrado: ${contactCtx.name ?? ""} ${contactCtx.phone ?? ""}; negociações abertas: ${
      (contactCtx.deals ?? []).filter((d: any) => d.status === "open").map((d: any) => `${d.title} (${d.stage_name}, R$ ${d.value})`).join("; ") || "nenhuma"}.` : "",
    `Relato: """${text}"""`,
  ].filter(Boolean).join("\n");

  let ai: Record<string, any> | null = null;
  let engine: "ai" | "rules" = "rules";
  let aiError: string | null = null;
  try {
    ai = parseJson(await callAI(system, userPrompt));
    if (ai) engine = "ai";
  } catch (e) {
    aiError = e instanceof Error ? e.message : String(e);
  }

  // ----- monta o plano, combinando IA (quando houver) e regras -----
  const warnings: string[] = [];
  const c = ai?.contact ?? {};
  const contact = {
    name: str(c.name) ?? rules.contact.name,
    phone: (str(c.phone, 30) ?? rules.contact.phone)?.replace(/\D/g, "") || undefined,
    company: str(c.company) ?? rules.contact.company,
    email: str(c.email)?.toLowerCase() ?? rules.contact.email,
    city: str(c.city, 80),
    uf: str(c.uf, 2)?.toUpperCase(),
  };

  let outcome: DialOutcome | null = null;
  if (lead) {
    const o = ai?.dial_outcome;
    outcome = OUTCOMES.includes(o) ? o : rules.dial_outcome ?? "talked";
  }

  const dueLocal = (typeof ai?.task?.due_local === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ai.task.due_local) ? ai.task.due_local.slice(0, 16) : null) ?? rules.due_local;
  let task: Record<string, any> | null = null;
  if (ai?.task && typeof ai.task === "object") {
    task = { type: TASK_TYPES.includes(ai.task.type) ? ai.task.type : "follow_up", title: str(ai.task.title) ?? "Próximo passo" };
  } else if (outcome === "callback" || (!lead && rules.dial_outcome === "callback")) {
    task = { type: "call", title: "Retornar ligação" };
  } else if (outcome === "meeting" || (!lead && rules.dial_outcome === "meeting")) {
    task = { type: "meeting", title: "Reunião" };
  } else if (rules.wants_proposal) {
    task = { type: "proposal", title: "Enviar proposta" };
  } else if (dueLocal) {
    task = { type: "follow_up", title: "Próximo passo" };
  }
  if (outcome === "callback" && task) task.type = "call";
  if (outcome === "meeting" && task) task.type = "meeting";
  if (task) {
    task.due_local = dueLocal;
    task.due_at = dueLocal ? zonedToUtcIso(dueLocal, tz) : null;
    if (!task.due_at && (outcome === "callback" || outcome === "meeting")) warnings.push("Não entendi a data — confira antes de salvar.");
  }

  const value = num(ai?.deal?.value) ?? rules.value;
  const wantsDeal = ai?.deal?.action === "create" || outcome === "meeting" || rules.wants_proposal || (value !== null && value > 0);
  const stage = ai?.deal?.stage_name ? stages.find((s) => s.name.toLowerCase() === String(ai.deal.stage_name).toLowerCase()) : undefined;
  const deal = wantsDeal && outcome !== "not_interested" && outcome !== "invalid" && outcome !== "no_answer"
    ? { action: "create", title: str(ai?.deal?.title) ?? (contact.company || contact.name || lead?.name ? `${rules.wants_proposal ? "Proposta" : "Oportunidade"} — ${contact.company || contact.name || lead?.name}` : null), value, stage_id: stage?.id ?? null, stage_name: stage?.name ?? null }
    : { action: "none" };

  // contato já existe?
  let match: Record<string, any> | null = contactCtx;
  if (!match && contact.phone) {
    const { data } = await db.rpc("crm_lookup_phone", { p_tenant_id: tenantId, p_phone: contact.phone });
    match = data ?? null;
  }
  if (!lead && !match && !contact.name && !contact.phone && !contact.company) warnings.push("Diga o nome ou o telefone do cliente para eu achar ou cadastrar.");

  const plan = {
    source, transcript: text,
    dial_lead_id: lead?.id ?? null, dial_outcome: outcome,
    contact_id: match?.id ?? null,
    contact,
    deal,
    task,
    objection: str(ai?.objection, 200) ?? rules.objection,
    note: str(ai?.note, 1000) ?? str(ai?.summary, 1000) ?? text.slice(0, 1000),
    summary: str(ai?.summary, 300) ?? null,
  };
  return json({ plan, match, engine, ai_error: engine === "rules" ? aiError : null, warnings, timezone: tz });
});
