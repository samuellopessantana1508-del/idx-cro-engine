// API oficial do WhatsApp (Meta WhatsApp Cloud API) — segunda opção de conexão do CRO.
//
// Webhook da Meta (configurado no app da Meta, um endereço por empresa):
//   GET  /wa-cloud/webhook/<instance_id>   verificação (hub.verify_token)
//   POST /wa-cloud/webhook/<instance_id>   mensagens recebidas e status (assinatura X-Hub-Signature-256)
// Tela (usuário logado):
//   POST /wa-cloud {action: "save"|"test"|"sync_templates"|"remove"|"flush", tenant_id, ...}
// Interno (chave de serviço ou token do motor):
//   POST /wa-cloud/flush                    envia o que está na fila de todas as conexões oficiais
//
// O envio e o recebimento usam as mesmas regras do QR Code (fila wa_outbox, SAIR, horários e
// limites de disparo, caixa de entrada, automações, IA e atribuição).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decrypt, encrypt } from "../_shared/encryption.ts";
import { cloudPayload, classifyCloudError, type OutboxItem, parseCloudWebhook, templateFromMeta } from "../_shared/wa-cloud-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH = (Deno.env.get("META_GRAPH_BASE") || "https://graph.facebook.com").replace(/\/$/, "");
const VERSION = Deno.env.get("WA_GRAPH_VERSION") || "v21.0";
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-gateway-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Secret = {
  instance_id: string; tenant_id: string; status: string; phone_number_id: string | null; waba_id: string | null;
  access_token_enc: string; app_secret_enc: string | null; verify_token: string; source?: string;
};

async function secretFor(instanceId: string): Promise<Secret | null> {
  const { data } = await svc.rpc("wa_cloud_secret", { p_instance: instanceId });
  return (data as Secret | null) ?? null;
}

async function graph(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${GRAPH}/${VERSION}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  return { ok: res.ok && !body.error, status: res.status, body };
}

function inBackground(p: Promise<unknown>) {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else void p;
}

async function internal(fn: string, body: Record<string, unknown> = {}) {
  await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => console.error(fn, (e as Error).message));
}

// ---------------------------------------------------------------------------
// Envio: pega a fila da conexão oficial e manda pela Graph API
// ---------------------------------------------------------------------------
async function flushInstance(instanceId: string, deadline: number): Promise<{ sent: number; failed: number }> {
  const sec = await secretFor(instanceId);
  if (!sec?.phone_number_id || sec.status !== "connected") return { sent: 0, failed: 0 };
  const token = await decrypt(sec.access_token_enc);
  let sent = 0, failed = 0;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    const { data: item, error } = await svc.rpc("wa_gw_claim", { p_token: null, p_instance: instanceId });
    if (error) { console.error("claim", error.message); break; }
    if (!item) break;
    const m = item as Record<string, any>;
    let result: { ok: boolean; status: number; body: Record<string, any> };
    try {
      result = await graph(token, `${sec.phone_number_id}/messages`, { method: "POST", body: JSON.stringify(cloudPayload(m as OutboxItem)) });
    } catch (e) {
      await svc.rpc("wa_gw_result", { p_token: null, p_outbox_id: m.id, p_ok: false, p_error: `Sem resposta da Meta: ${(e as Error).message}`, p_retry: true });
      failed++;
      continue;
    }
    if (result.ok) {
      const waId = result.body.messages?.[0]?.id ?? null;
      const jid = result.body.contacts?.[0]?.wa_id ?? null;
      await svc.rpc("wa_gw_result", { p_token: null, p_outbox_id: m.id, p_ok: true, p_wa_message_id: waId, p_jid: jid });
      sent++;
    } else {
      const err = classifyCloudError(result.body.error ?? { message: `HTTP ${result.status}` });
      await svc.rpc("wa_gw_result", { p_token: null, p_outbox_id: m.id, p_ok: false, p_error: err.message, p_invalid: err.invalid, p_retry: err.retry });
      failed++;
      if (err.auth) {
        // token vencido/sem permissão: para de tentar e avisa na tela de conexão
        await svc.rpc("wa_cloud_mark", { p_instance: instanceId, p_ok: false, p_phone: null, p_info: {}, p_error: err.message });
        break;
      }
    }
  }
  return { sent, failed };
}

async function flushAll(tenantId?: string) {
  let q = svc.from("whatsapp_instances").select("id").eq("provider", "cloud_api").eq("status", "connected");
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data } = await q;
  const deadline = Date.now() + 45_000;
  const out: Record<string, unknown> = {};
  for (const row of (data ?? []) as { id: string }[]) out[row.id] = await flushInstance(row.id, deadline);
  return out;
}

// ---------------------------------------------------------------------------
// Configuração (tela)
// ---------------------------------------------------------------------------
async function userAccess(req: Request, tenantId: string) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await db.auth.getUser(auth.slice(7));
  if (!u?.user) return null;
  const { data: access } = await db.rpc("crm_my_access", { p_tenant_id: tenantId });
  return { user: u.user, db, access: (access ?? {}) as { read?: boolean; write?: boolean; configure?: boolean } };
}

async function cloudInstanceOf(tenantId: string): Promise<string | null> {
  const { data } = await svc.from("whatsapp_instances").select("id").eq("tenant_id", tenantId).eq("provider", "cloud_api")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function testConnection(instanceId: string) {
  const sec = await secretFor(instanceId);
  if (!sec?.phone_number_id) return { ok: false, error: "Informe o ID do número (Phone Number ID)" };
  const token = await decrypt(sec.access_token_enc);
  const r = await graph(token, `${sec.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`);
  if (!r.ok) {
    const err = classifyCloudError(r.body.error ?? { message: `HTTP ${r.status}` });
    await svc.rpc("wa_cloud_mark", { p_instance: instanceId, p_ok: false, p_phone: null, p_info: {}, p_error: err.message });
    return { ok: false, error: err.message };
  }
  const info: Record<string, unknown> = { verified_name: r.body.verified_name ?? null, quality_rating: r.body.quality_rating ?? null };
  // liga o app da Meta à conta (sem isso o webhook não recebe mensagens)
  let warning: string | null = null;
  if (sec.waba_id) {
    // conexão pelo cadastro incorporado: o próprio CRO aponta o webhook desta conta para o endereço da empresa
    const body = sec.source === "embedded"
      ? JSON.stringify({ override_callback_uri: `${SUPABASE_URL}/functions/v1/wa-cloud/webhook/${instanceId}`, verify_token: sec.verify_token })
      : "{}";
    const sub = await graph(token, `${sec.waba_id}/subscribed_apps`, { method: "POST", body });
    if (!sub.ok) warning = `Não foi possível ligar o webhook à conta: ${classifyCloudError(sub.body.error ?? {}).message}`;
  } else {
    warning = "Sem o ID da conta (WABA ID) não é possível buscar os modelos aprovados.";
  }
  await svc.rpc("wa_cloud_mark", { p_instance: instanceId, p_ok: true, p_phone: String(r.body.display_phone_number ?? ""), p_info: info, p_error: null });
  return { ok: true, warning, phone: r.body.display_phone_number, verified_name: r.body.verified_name };
}

async function syncTemplates(instanceId: string) {
  const sec = await secretFor(instanceId);
  if (!sec?.waba_id) return { ok: false, error: "Informe o ID da conta do WhatsApp Business (WABA ID) para buscar os modelos." };
  const token = await decrypt(sec.access_token_enc);
  const all: Record<string, unknown>[] = [];
  let path: string | null = `${sec.waba_id}/message_templates?limit=200&fields=name,language,status,category,components`;
  for (let page = 0; path && page < 10; page++) {
    const r = await graph(token, path);
    if (!r.ok) return { ok: false, error: classifyCloudError(r.body.error ?? {}).message };
    for (const t of (r.body.data ?? []) as Record<string, any>[]) all.push(templateFromMeta(t));
    const next = r.body.paging?.next as string | undefined;
    path = next ? next.replace(/^https?:\/\/[^/]+\/v[\d.]+\//, "") : null;
  }
  const { data, error } = await svc.rpc("wa_templates_replace", { p_instance: instanceId, p_templates: all });
  if (error) return { ok: false, error: error.message };
  return { ok: true, total: data, approved: all.filter((t) => t.status === "APPROVED").length };
}

// ---------------------------------------------------------------------------
// Cadastro incorporado da Meta (Embedded Signup): "Conectar WhatsApp Oficial"
// ---------------------------------------------------------------------------
const APP_ID = () => Deno.env.get("META_APP_ID") ?? "";
const APP_SECRET = () => Deno.env.get("META_APP_SECRET") ?? "";
const CONFIG_ID = () => Deno.env.get("WA_EMBEDDED_CONFIG_ID") ?? "";
const SDK_VERSION = () => Deno.env.get("WA_EMBEDDED_SDK_VERSION") || Deno.env.get("META_GRAPH_VERSION") || VERSION;

function embeddedAvailable() {
  return !!(APP_ID() && APP_SECRET() && CONFIG_ID());
}

async function graphApp(path: string) {
  const res = await fetch(`${GRAPH}/${VERSION}/${path}`, { signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  return { ok: res.ok && !body.error, status: res.status, body };
}

/** Descobre a conta (WABA) e o número quando a janela da Meta não informou (ex.: popup fechado cedo). */
async function discoverAssets(token: string): Promise<{ waba_id: string | null; phone_number_id: string | null }> {
  const dbg = await graphApp(`debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${APP_ID()}|${APP_SECRET()}`)}`);
  const scopes = (dbg.body?.data?.granular_scopes ?? []) as { scope: string; target_ids?: string[] }[];
  const waba = scopes.find((x) => x.scope === "whatsapp_business_management")?.target_ids?.[0]
    ?? scopes.find((x) => x.scope === "whatsapp_business_messaging")?.target_ids?.[0] ?? null;
  if (!waba) return { waba_id: null, phone_number_id: null };
  const nums = await graph(token, `${waba}/phone_numbers?fields=id,display_phone_number,verified_name`);
  return { waba_id: waba, phone_number_id: nums.body?.data?.[0]?.id ?? null };
}

async function embeddedConnect(tenantId: string, userId: string, input: { code: string; waba_id?: string; phone_number_id?: string; business_id?: string }) {
  if (!embeddedAvailable()) return { ok: false, error: "O cadastro incorporado da Meta ainda não foi configurado no servidor (WA_EMBEDDED_CONFIG_ID)." };
  // 1) troca o código pelo token da empresa (fica no nome do Business Manager do cliente)
  const ex = await graphApp(`oauth/access_token?client_id=${encodeURIComponent(APP_ID())}&client_secret=${encodeURIComponent(APP_SECRET())}&code=${encodeURIComponent(input.code)}`);
  const token = ex.body?.access_token as string | undefined;
  if (!ex.ok || !token) return { ok: false, error: `A Meta recusou a autorização: ${classifyCloudError(ex.body?.error ?? { message: `HTTP ${ex.status}` }).message}` };

  let wabaId = String(input.waba_id ?? "").replace(/\D/g, "") || null;
  let phoneId = String(input.phone_number_id ?? "").replace(/\D/g, "") || null;
  if (!wabaId || !phoneId) {
    const found = await discoverAssets(token);
    wabaId = wabaId ?? found.waba_id;
    phoneId = phoneId ?? found.phone_number_id;
  }
  if (!wabaId || !phoneId) return { ok: false, error: "A Meta não informou a conta e o número. Refaça a conexão escolhendo o número do WhatsApp." };

  // 2) guarda (token e chave do app criptografados) e marca como cadastro incorporado
  const { data: saved, error } = await svc.rpc("wa_cloud_save", {
    p_tenant_id: tenantId, p_phone_number_id: phoneId, p_waba_id: wabaId,
    p_token_enc: await encrypt(token), p_token_hint: token.slice(-4), p_secret_enc: await encrypt(APP_SECRET()),
    p_keep_secret: false, p_user: userId,
  });
  if (error) return { ok: false, error: error.message };
  const inst = (saved as { instance_id: string }).instance_id;
  // 3) registra o número na API (o PIN de 6 dígitos vira a confirmação em duas etapas do número)
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const reg = await graph(token, `${phoneId}/register`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", pin }) });
  await svc.from("wa_cloud_credentials").update({
    source: "embedded", business_id: String(input.business_id ?? "").replace(/\D/g, "") || null,
    pin_enc: reg.ok ? await encrypt(pin) : null,
  }).eq("instance_id", inst);
  // número que já rodava na API: a Meta responde que já está registrado — segue normalmente
  const regWarning = reg.ok ? null : classifyCloudError(reg.body?.error ?? {}).message;

  // 4) liga o webhook desta conta ao CRO, confere o número e baixa os modelos
  const test = await testConnection(inst);
  if (test.ok) await syncTemplates(inst).catch(() => null);
  const already = /already|registrad|registered/i.test(String(reg.body?.error?.message ?? "") + String(reg.body?.error?.error_user_msg ?? ""));
  return { ok: test.ok, error: test.ok ? undefined : test.error, warning: test.ok ? (test.warning ?? (regWarning && !already ? `Registro do número: ${regWarning}` : null)) : undefined };
}

// ---------------------------------------------------------------------------
// Webhook da Meta
// ---------------------------------------------------------------------------
async function validSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const REF_RE = /(?:^|[^a-z0-9])([a-z0-9]{4}-[a-z0-9]{4})(?:[^a-z0-9-]|$)/i;

async function handleWebhook(req: Request, instanceId: string) {
  const sec = await secretFor(instanceId);
  if (!sec) return new Response("not found", { status: 404 });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === sec.verify_token;
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }

  const raw = await req.text();
  if (sec.app_secret_enc) {
    const secret = await decrypt(sec.app_secret_enc);
    if (!(await validSignature(raw, req.headers.get("x-hub-signature-256"), secret))) return new Response("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }

  const { messages, statuses } = parseCloudWebhook(payload, sec.phone_number_id);
  let inbound = 0;
  for (const msg of messages) {
    const { error } = await svc.rpc("wa_gw_ingest", { p_token: null, p_instance: instanceId, p_msg: msg });
    if (error) { console.error("ingest", error.message); continue; }
    inbound++;
    const ref = REF_RE.exec(String(msg.body ?? ""))?.[1]?.toLowerCase();
    if (ref) inBackground(fetch(`${SUPABASE_URL}/functions/v1/go/confirm?ref=${encodeURIComponent(ref)}`, {
      method: "POST", headers: { apikey: ANON }, signal: AbortSignal.timeout(20_000),
    }).catch(() => {}));
  }
  for (const st of statuses) {
    await svc.rpc("wa_cloud_status", { p_instance: instanceId, p_wa_message_id: st.id, p_status: st.status, p_error: st.error });
  }
  if (inbound > 0) {
    // automações respondem e o que entrou na fila é enviado logo em seguida
    inBackground((async () => {
      await internal("cro-flows");
      await flushAll(sec.tenant_id);
    })());
  }
  // a Meta só precisa do 200 rápido
  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname;

  const hook = path.match(/\/webhook\/([0-9a-f-]{36})\/?$/i);
  if (hook) return await handleWebhook(req, hook[1]);

  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  if (/\/flush\/?$/.test(path)) {
    const authz = req.headers.get("Authorization") ?? "";
    let allowed = authz === `Bearer ${SERVICE}`;
    if (!allowed) {
      const { error } = await svc.rpc("wa_gw_instances", { p_token: req.headers.get("x-gateway-token") ?? "" });
      allowed = !error;
    }
    if (!allowed) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, result: await flushAll() });
  }

  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const tenantId = String(body.tenant_id ?? "");
  const action = String(body.action ?? "");
  if (!tenantId) return json({ error: "tenant_id obrigatório" }, 400);
  const ua = await userAccess(req, tenantId);
  if (!ua) return json({ error: "Faça login novamente" }, 401);

  try {
    if (action === "flush") {
      if (!ua.access.write) return json({ error: "Sem permissão" }, 403);
      return json({ ok: true, result: await flushAll(tenantId) });
    }
    if (action === "sync_templates") {
      if (!ua.access.write) return json({ error: "Sem permissão" }, 403);
      const inst = await cloudInstanceOf(tenantId);
      if (!inst) return json({ error: "Configure a API oficial primeiro" }, 400);
      const r = await syncTemplates(inst);
      return r.ok ? json(r) : json({ error: r.error }, 400);
    }
    if (action === "embedded_config") {
      // dados públicos para abrir o popup da Meta (nada secreto)
      return json({ available: embeddedAvailable(), app_id: APP_ID() || null, config_id: CONFIG_ID() || null, version: SDK_VERSION() });
    }
    if (!ua.access.configure) return json({ error: "Somente gestores podem configurar a API oficial" }, 403);

    if (action === "embedded_connect") {
      const code = String(body.code ?? "").trim();
      if (!code) return json({ error: "A Meta não devolveu a autorização. Tente de novo." }, 400);
      const r = await embeddedConnect(tenantId, ua.user.id, { code, waba_id: body.waba_id, phone_number_id: body.phone_number_id, business_id: body.business_id });
      const { data: channel } = await ua.db.rpc("wa_channel_get", { p_tenant_id: tenantId });
      return json({ ok: r.ok, error: r.error, warning: r.warning ?? null, channel }, r.ok || channel ? 200 : 400);
    }

    if (action === "save") {
      const phoneNumberId = String(body.phone_number_id ?? "").replace(/\D/g, "");
      const wabaId = String(body.waba_id ?? "").replace(/\D/g, "");
      const tokenIn = String(body.access_token ?? "").trim();
      const secretIn = String(body.app_secret ?? "").trim();
      if (!phoneNumberId) return json({ error: "Informe o ID do número (Phone Number ID)" }, 400);
      if (!wabaId) return json({ error: "Informe o ID da conta do WhatsApp Business (WABA ID)" }, 400);
      let tokenEnc: string | null = null, hint: string | null = null;
      const existing = await cloudInstanceOf(tenantId);
      if (tokenIn) { tokenEnc = await encrypt(tokenIn); hint = tokenIn.slice(-4); }
      else if (existing) {
        const s = await secretFor(existing);
        if (s) { tokenEnc = s.access_token_enc; const { data: c } = await ua.db.rpc("wa_channel_get", { p_tenant_id: tenantId }); hint = (c as any)?.cloud?.token_hint ?? null; }
      }
      if (!tokenEnc) return json({ error: "Cole o token de acesso permanente" }, 400);
      const { data: saved, error } = await svc.rpc("wa_cloud_save", {
        p_tenant_id: tenantId, p_phone_number_id: phoneNumberId, p_waba_id: wabaId,
        p_token_enc: tokenEnc, p_token_hint: hint, p_secret_enc: secretIn ? await encrypt(secretIn) : null,
        p_keep_secret: !secretIn, p_user: ua.user.id,
      });
      if (error) return json({ error: error.message }, 400);
      const inst = (saved as { instance_id: string }).instance_id;
      const test = await testConnection(inst);
      if (test.ok) await syncTemplates(inst).catch(() => null);
      const { data: channel } = await ua.db.rpc("wa_channel_get", { p_tenant_id: tenantId });
      return json({ ok: test.ok, error: test.ok ? undefined : test.error, warning: test.ok ? test.warning : undefined, channel });
    }
    if (action === "test") {
      const inst = await cloudInstanceOf(tenantId);
      if (!inst) return json({ error: "Configure a API oficial primeiro" }, 400);
      const test = await testConnection(inst);
      const { data: channel } = await ua.db.rpc("wa_channel_get", { p_tenant_id: tenantId });
      return json({ ok: test.ok, error: test.ok ? undefined : test.error, warning: test.ok ? test.warning : undefined, channel });
    }
    if (action === "remove") {
      await svc.rpc("wa_cloud_remove", { p_tenant_id: tenantId });
      const { data: channel } = await ua.db.rpc("wa_channel_get", { p_tenant_id: tenantId });
      return json({ ok: true, channel });
    }
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    console.error("wa-cloud", (e as Error).message);
    return json({ error: "Falha ao falar com a Meta. Tente de novo em instantes." }, 502);
  }
});
