// "Conectar WhatsApp Oficial" pelo cadastro incorporado da Meta (Embedded Signup), Graph API simulada (11996).
// Stack LOCAL com META_APP_ID=111222333 META_APP_SECRET=segredo-do-app-idx WA_EMBEDDED_CONFIG_ID=987654321.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const WABA = `30${TAG}`, PNID = `40${TAG}`, BM = `50${TAG}`;
const CODE = `codigo-${TAG}`;
const TOKEN = `EAAB-empresa-${TAG}`;
const calls = [];
let graph, A, ownerJwt, sellerJwt, alreadyRegistered = false;

const fn = async (jwt, body) => {
  const r = await fetch(`${URL_}/functions/v1/wa-cloud`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null);
  return r.data.session.access_token;
};

before(async () => {
  graph = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: b ? JSON.parse(b) : null, auth: req.headers.authorization });
      const reply = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      const p = url.pathname.replace(/^\/v[\d.]+\//, "/");
      if (p === "/oauth/access_token") {
        if (url.searchParams.get("client_id") !== "111222333" || url.searchParams.get("client_secret") !== "segredo-do-app-idx") return reply(400, { error: { code: 101, message: "Invalid client" } });
        if (url.searchParams.get("code") !== CODE) return reply(400, { error: { code: 100, message: "Invalid verification code format." } });
        return reply(200, { access_token: TOKEN, token_type: "bearer" });
      }
      if (p === "/debug_token") return reply(200, { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }, { scope: "whatsapp_business_messaging", target_ids: [WABA] }] } });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 190, message: "Invalid OAuth access token" } });
      if (p === `/${WABA}/phone_numbers`) return reply(200, { data: [{ id: PNID, display_phone_number: "+55 11 3333-4444", verified_name: "Douratto Buffet" }] });
      if (p === `/${PNID}/register`) {
        if (alreadyRegistered) return reply(400, { error: { code: 100, message: "Phone number already registered", error_user_msg: "already registered" } });
        return reply(200, { success: true });
      }
      if (p === `/${PNID}`) return reply(200, { display_phone_number: "+55 11 3333-4444", verified_name: "Douratto Buffet", quality_rating: "GREEN" });
      if (p === `/${WABA}/subscribed_apps`) return reply(200, { success: true });
      if (p === `/${WABA}/message_templates`) return reply(200, { data: [{ name: "confirmacao_evento", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Olá {{1}}, seu evento está confirmado." }] }] });
      reply(404, { error: { code: 100, message: `rota simulada não existe: ${p}` } });
    });
  });
  await new Promise((r) => graph.listen(11996, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  ownerJwt = await login("dono@clinica.local");
  sellerJwt = await login("bruno.vendas@clinica.local");
});
after(async () => {
  graph?.close();
  sql(`update wa_channel_settings set active_provider = 'gateway' where tenant_id = '${A}'`);
});

test("dados públicos para abrir o popup da Meta (sem segredo)", async () => {
  const r = await fn(ownerJwt, { action: "embedded_config", tenant_id: A });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.available, r.body.app_id, r.body.config_id], [true, "111222333", "987654321"]);
  assert.equal(JSON.stringify(r.body).includes("segredo"), false);
});

test("vendedor não conecta; código inválido é recusado com aviso", async () => {
  assert.equal((await fn(sellerJwt, { action: "embedded_connect", tenant_id: A, code: CODE })).status, 403);
  const bad = await fn(ownerJwt, { action: "embedded_connect", tenant_id: A, code: "errado", waba_id: WABA, phone_number_id: PNID });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /A Meta recusou a autorização/);
});

test("conectar: troca o código, registra o número, liga o webhook desta empresa e traz os modelos", async () => {
  const before = calls.length;
  const r = await fn(ownerJwt, { action: "embedded_connect", tenant_id: A, code: CODE, waba_id: WABA, phone_number_id: PNID, business_id: BM });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const c = r.body.channel.cloud;
  assert.deepEqual([c.status, c.source, c.business_id, c.verified_name, c.templates], ["connected", "embedded", BM, "Douratto Buffet", 1]);
  assert.equal(r.body.channel.active, "gateway", "conectar não troca a conexão em uso sozinho");

  const mine = calls.slice(before);
  const reg = mine.find((x) => x.path.endsWith(`/${PNID}/register`));
  assert.match(reg.body.pin, /^\d{6}$/);
  assert.equal(reg.body.messaging_product, "whatsapp");
  const sub = mine.find((x) => x.path.endsWith(`/${WABA}/subscribed_apps`));
  assert.equal(sub.body.override_callback_uri, `${URL_}/functions/v1/wa-cloud/webhook/${c.id}`);
  assert.equal(sub.body.verify_token, sql(`select verify_token from wa_cloud_credentials where instance_id = '${c.id}'`));

  // token da empresa, chave do app e PIN guardados só criptografados
  const row = sql(`select access_token_enc || '|' || app_secret_enc || '|' || pin_enc from wa_cloud_credentials where instance_id = '${c.id}'`);
  assert.doesNotMatch(row, /EAAB|segredo|^\d{6}$/);
  assert.equal(sql(`select source from wa_cloud_credentials where instance_id = '${c.id}'`), "embedded");

  // a assinatura do webhook passa a ser a do app da IDX
  const payload = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PNID }, messages: [{ from: "5511977776666", id: `wamid.emb.${TAG}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Quero orçamento" } }] } }] }] });
  const { createHmac } = await import("node:crypto");
  const sig = "sha256=" + createHmac("sha256", "segredo-do-app-idx").update(payload).digest("hex");
  const hook = await fetch(`${URL_}/functions/v1/wa-cloud/webhook/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: payload });
  assert.equal(hook.status, 200);
  assert.equal(sql(`select count(*) from whatsapp_messages where wa_message_id = 'wamid.emb.${TAG}'`), "1");
});

test("número que já rodava na API e janela da Meta sem os dados: descobre a conta e conecta", async () => {
  alreadyRegistered = true;
  const r = await fn(ownerJwt, { action: "embedded_connect", tenant_id: A, code: CODE });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.warning ?? null, null, "já registrado não é erro");
  assert.equal(r.body.channel.cloud.phone_number_id, PNID);
  assert.equal(r.body.channel.cloud.waba_id, WABA);
  assert.equal(sql(`select count(*) from whatsapp_instances where tenant_id = '${A}' and provider = 'cloud_api'`), "1", "reconectar não duplica a conexão");
});
