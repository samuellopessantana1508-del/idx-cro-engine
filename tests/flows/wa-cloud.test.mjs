// API oficial do WhatsApp (Meta Cloud API) de ponta a ponta, com a Graph API simulada (porta 11996).
// Usa a empresa "Perfumaria Aroma" para não mexer na conexão das outras suítes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const PNID = `10${TAG}`;
const WABA = `20${TAG}`;
const SECRET = "segredo-do-app";
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 300)); } throw new Error("tempo esgotado"); };
const ph = (n) => `55119${String(70000000 + TAG * 13 + n).slice(-8)}`;

const sent = []; // mensagens recebidas pela "Meta"
let graph, owner, ownerJwt, seller, B, A, inst, verify;

const fn = async (jwt, body, path = "") => {
  const r = await fetch(`${URL_}/functions/v1/wa-cloud${path}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const hook = (payload, sign = true) => {
  const raw = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (sign) headers["X-Hub-Signature-256"] = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return fetch(`${URL_}/functions/v1/wa-cloud/webhook/${inst}`, { method: "POST", headers, body: raw });
};
const inbound = (phone, body, id) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
  metadata: { phone_number_id: PNID }, contacts: [{ wa_id: phone, profile: { name: "Cliente Oficial" } }],
  messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }] });

before(async () => {
  graph = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const reply = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer EAAG-token-certo") return reply(401, { error: { code: 190, message: "Invalid OAuth access token" } });
      if (req.method === "GET" && url.pathname === `/v21.0/${PNID}`) return reply(200, { display_phone_number: "+55 11 4000-1234", verified_name: "Perfumaria Aroma", quality_rating: "GREEN", id: PNID });
      if (req.method === "POST" && url.pathname === `/v21.0/${WABA}/subscribed_apps`) return reply(200, { success: true });
      if (req.method === "GET" && url.pathname === `/v21.0/${WABA}/message_templates`) return reply(200, { data: [
        { name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Olá {{1}}! Temos novidades na {{2}}." }] },
        { name: "em_analise", language: "pt_BR", status: "PENDING", components: [{ type: "BODY", text: "Oi" }] },
      ] });
      if (req.method === "POST" && url.pathname === `/v21.0/${PNID}/messages`) {
        const m = JSON.parse(b);
        sent.push(m);
        if (m.to.endsWith("9999")) return reply(400, { error: { code: 131026, message: "Receiver is incapable of receiving this message" } });
        if (m.type === "text" && /FORA/.test(m.text.body)) return reply(400, { error: { code: 131047, message: "Re-engagement message" } });
        return reply(200, { messaging_product: "whatsapp", contacts: [{ input: m.to, wa_id: m.to }], messages: [{ id: `wamid.${TAG}.${sent.length}` }] });
      }
      reply(404, { error: { code: 100, message: `rota simulada não existe: ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((r) => graph.listen(11996, "127.0.0.1", r));
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const s = await owner.auth.signInWithPassword({ email: "dona@perfumaria.local", password: "Teste@12345" });
  assert.equal(s.error, null);
  ownerJwt = s.data.session.access_token;
  seller = createClient(URL_, ANON, { auth: { persistSession: false } });
  assert.equal((await seller.auth.signInWithPassword({ email: "ana.vendas@clinica.local", password: "Teste@12345" })).error, null);
  sql(`update wa_flows set status = 'paused' where tenant_id = '${B}' and status = 'active'`);
});
after(async () => {
  graph?.close();
  // volta a empresa para o QR Code (outras suítes)
  sql(`update wa_channel_settings set active_provider = 'gateway' where tenant_id = '${B}'`);
});

test("configurar: token errado avisa; token certo conecta, liga o webhook e traz os modelos aprovados", async () => {
  const bad = await fn(ownerJwt, { action: "save", tenant_id: B, phone_number_id: PNID, waba_id: WABA, access_token: "EAAG-errado", app_secret: SECRET });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /token de acesso/);
  assert.equal(bad.body.channel.cloud.status, "disconnected");
  // não dá para usar antes de funcionar
  assert.match((await owner.rpc("wa_channel_set", { p_tenant_id: B, p_provider: "cloud_api" })).error?.message ?? "", /teste a API oficial/);

  const good = await fn(ownerJwt, { action: "save", tenant_id: B, phone_number_id: PNID, waba_id: WABA, access_token: "EAAG-token-certo" });
  assert.equal(good.body.ok, true, JSON.stringify(good.body));
  const c = good.body.channel.cloud;
  assert.deepEqual([c.status, c.verified_name, c.quality, c.templates, c.has_app_secret, c.token_hint], ["connected", "Perfumaria Aroma", "GREEN", 1, true, "erto"]);
  assert.match(c.phone, /551140001234/);
  assert.ok(c.verify_token?.length >= 32);
  inst = c.id; verify = c.verify_token;
  // o token nunca sai do banco em texto
  assert.doesNotMatch(sql(`select access_token_enc from wa_cloud_credentials where instance_id = '${inst}'`), /EAAG/);
  assert.equal(good.body.channel.active, "gateway", "configurar não troca a conexão sozinho");
});

test("permissões: vendedor de outra empresa e anônimo não configuram nem leem o código do webhook", async () => {
  const { data: sess } = await seller.auth.getSession();
  const r = await fn(sess.session.access_token, { action: "save", tenant_id: B, phone_number_id: "1", waba_id: "2", access_token: "x" });
  assert.equal(r.status, 403);
  assert.ok((await seller.rpc("wa_channel_get", { p_tenant_id: B })).error);
  assert.ok((await seller.rpc("wa_channel_set", { p_tenant_id: A, p_provider: "cloud_api" })).error, "vendedor não troca a conexão");
  const anon = await fetch(`${URL_}/functions/v1/wa-cloud`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON }, body: JSON.stringify({ action: "flush", tenant_id: B }) });
  assert.equal(anon.status, 401);
  // rotas internas continuam exigindo o token do motor ou a chave de serviço
  for (const path of ["wa-cloud/flush", "cro-flows", "cro-cron"]) {
    const r = await fetch(`${URL_}/functions/v1/${path}`, { method: "POST", headers: { apikey: ANON, "x-gateway-token": "" } });
    assert.equal(r.status, 401, path);
  }
});

test("webhook: verificação da Meta e assinatura obrigatória quando há chave secreta do app", async () => {
  const okV = await fetch(`${URL_}/functions/v1/wa-cloud/webhook/${inst}?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=4242`);
  assert.equal(okV.status, 200);
  assert.equal(await okV.text(), "4242");
  const badV = await fetch(`${URL_}/functions/v1/wa-cloud/webhook/${inst}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`);
  assert.equal(badV.status, 403);
  const unsigned = await hook(inbound(ph(1), "sem assinatura", `wamid.in.${TAG}.0`), false);
  assert.equal(unsigned.status, 401);
  assert.equal(sql(`select count(*) from whatsapp_messages where wa_message_id = 'wamid.in.${TAG}.0'`), "0");
});

test("usar a API oficial: mensagem recebida entra na caixa e a resposta sai pela Meta", async () => {
  ok(await owner.rpc("wa_channel_set", { p_tenant_id: B, p_provider: "cloud_api" }));
  const p = ph(2);
  assert.equal((await hook(inbound(p, "Olá, quero o catálogo", `wamid.in.${TAG}.1`))).status, 200);
  const conv = sql(`select m.conversation_id from whatsapp_messages m where m.wa_message_id = 'wamid.in.${TAG}.1'`);
  assert.ok(conv);
  assert.equal(sql(`select raw_payload->>'via' from whatsapp_messages where wa_message_id = 'wamid.in.${TAG}.1'`), "cloud_api");
  assert.equal(sql(`select push_name from whatsapp_contacts w join whatsapp_conversations c on c.contact_id = w.id where c.id = '${conv}'`), "Cliente Oficial");
  // reenvio do mesmo webhook (a Meta repete) não duplica
  await hook(inbound(p, "Olá, quero o catálogo", `wamid.in.${TAG}.1`));
  assert.equal(sql(`select count(*) from whatsapp_messages where wa_message_id = 'wamid.in.${TAG}.1'`), "1");

  const w = ok(await owner.rpc("wa_conversation_window", { p_conversation_id: conv }));
  assert.deepEqual([w.provider, w.open], ["cloud_api", true]);

  const outId = ok(await owner.rpc("wa_send_message", { p_tenant_id: B, p_body: "Segue o catálogo!", p_conversation_id: conv }));
  assert.equal(sql(`select instance_id from wa_outbox where id = '${outId}'`), inst);
  const before = sent.length;
  const f = await fn(ownerJwt, { action: "flush", tenant_id: B });
  assert.equal(f.status, 200);
  assert.deepEqual(sent.slice(before).map((m) => [m.to, m.type, m.text?.body]), [[p, "text", "Segue o catálogo!"]]);
  assert.equal(sql(`select status from wa_outbox where id = '${outId}'`), "sent");
  const waId = sql(`select wa_message_id from wa_outbox where id = '${outId}'`);
  assert.equal(sql(`select direction || '|' || body from whatsapp_messages where wa_message_id = '${waId}'`), "outbound|Segue o catálogo!");

  // status da Meta: entregue → lido
  const status = (s, extra = {}) => hook({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PNID }, statuses: [{ id: waId, status: s, ...extra }] } }] }] });
  await status("delivered"); await status("read"); await status("delivered");
  assert.equal(sql(`select status from whatsapp_messages where wa_message_id = '${waId}'`), "read");
});

test("fora da janela de 24 h: texto livre falha com aviso claro; modelo aprovado sai", async () => {
  const p = ph(3);
  const out = ok(await owner.rpc("wa_send_message", { p_tenant_id: B, p_body: "FORA da janela", p_phone: p }));
  await fn(ownerJwt, { action: "flush", tenant_id: B });
  assert.match(sql(`select status || '|' || error from wa_outbox where id = '${out}'`), /^failed\|Fora da janela de 24 horas/);

  assert.match((await owner.rpc("wa_send_template", { p_tenant_id: B, p_phone: p, p_template: { name: "em_analise", language: "pt_BR", params: [] } })).error?.message ?? "", /não aprovado/);
  assert.match((await owner.rpc("wa_send_template", { p_tenant_id: B, p_phone: p, p_template: { name: "boas_vindas", language: "pt_BR", params: ["Ana"] } })).error?.message ?? "", /2 variável/);
  const t = ok(await owner.rpc("wa_send_template", { p_tenant_id: B, p_phone: p, p_template: { name: "boas_vindas", language: "pt_BR", params: ["Ana", "loja"] } }));
  const before = sent.length;
  await fn(ownerJwt, { action: "flush", tenant_id: B });
  const m = sent.slice(before)[0];
  assert.deepEqual([m.type, m.template.name, m.template.components[0].parameters.map((x) => x.text)], ["template", "boas_vindas", ["Ana", "loja"]]);
  assert.equal(sql(`select status || '|' || body from wa_outbox where id = '${t}'`), "sent|Olá Ana! Temos novidades na loja.");
});

test("disparo pela API oficial exige modelo e usa as variáveis de cada contato", async () => {
  const camp = ok(await owner.rpc("wa_campaign_save", { p_tenant_id: B, p_id: null, p_name: `Oficial ${TAG}`, p_messages: ["Olá {nome}"], p_start_hour: 0, p_end_hour: 24 }));
  ok(await owner.rpc("wa_campaign_add_recipients", { p_campaign_id: camp, p_source: "rows", p_rows: [{ nome: "Bia", telefone: ph(4) }, { nome: "Caio", telefone: `55119${String(TAG).padStart(4, "0").slice(-4)}9999` }] }));
  assert.match((await owner.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "start" })).error?.message ?? "", /modelo aprovado/);
  ok(await owner.rpc("wa_campaign_set_template", { p_campaign_id: camp, p_template: { name: "boas_vindas", language: "pt_BR", params: ["{nome}", "Perfumaria"] } }));
  ok(await owner.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "start" }));
  assert.equal(sql(`select instance_id from wa_campaigns where id = '${camp}'`), inst);
  const before = sent.length;
  for (let i = 0; i < 2; i++) {
    sql(`update wa_campaigns set next_send_at = now() - interval '1 second' where id = '${camp}'`);
    await fn(ownerJwt, { action: "flush", tenant_id: B });
  }
  const msgs = sent.slice(before);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map((m) => m.template.components[0].parameters[0].text).sort(), ["Bia", "Caio"]);
  assert.deepEqual(sql(`select string_agg(name || ':' || status, ',' order by name) from wa_campaign_recipients where campaign_id = '${camp}'`), "Bia:sent,Caio:invalid");
});

test("automação responde sozinha a quem escreve pela API oficial", async () => {
  const N = (id, type, config = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { config } });
  const flow = ok(await owner.rpc("wa_flow_save", { p_tenant_id: B, p_id: null, p_name: `Oficial ${TAG}`, p_graph: {
    nodes: [N("t", "trigger", { kind: "keyword", keywords: "horário" }), N("a", "send_text", { text: "Abrimos às 9h, {nome}!" })],
    edges: [{ id: "e1", source: "t", target: "a", sourceHandle: null }] } }));
  ok(await owner.rpc("wa_flow_set_status", { p_flow_id: flow.id, p_status: "active" }));
  const p = ph(5);
  const before = sent.length;
  await hook(inbound(p, "qual o horário?", `wamid.in.${TAG}.5`));
  await until(() => sent.slice(before).some((m) => m.to === p));
  const m = sent.slice(before).find((x) => x.to === p);
  assert.match(m.text.body, /^Abrimos às 9h, Cliente/);
  ok(await owner.rpc("wa_flow_set_status", { p_flow_id: flow.id, p_status: "paused" }));
});

test("voltar para o QR Code: o envio volta para a conexão do QR", async () => {
  ok(await owner.rpc("wa_gateway_connect", { p_tenant_id: B, p_action: "connect" }));
  ok(await owner.rpc("wa_channel_set", { p_tenant_id: B, p_provider: "gateway" }));
  const out = ok(await owner.rpc("wa_send_message", { p_tenant_id: B, p_body: "pelo QR", p_phone: ph(6) }));
  assert.equal(sql(`select i.provider from wa_outbox o join whatsapp_instances i on i.id = o.instance_id where o.id = '${out}'`), "gateway");
  sql(`update wa_outbox set status = 'canceled' where id = '${out}'`);
  assert.match((await owner.rpc("wa_send_template", { p_tenant_id: B, p_phone: ph(6), p_template: { name: "boas_vindas", language: "pt_BR", params: ["a", "b"] } })).error?.message ?? "", /só com a API oficial/);
});
