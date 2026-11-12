// Atribuição de campanha → WhatsApp → CRM → venda (stack LOCAL).
// O lead clica no link (/go), chega no WhatsApp com "Ref: xxxx-xxxx" e o CRO precisa ligar
// conversa, contato e negócio à campanha sozinho — sem ninguém digitar o telefone na mão.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
const rnd = () => Math.random().toString(36).slice(2, 6).padEnd(4, "x");
let admin, adminJwt, A, inst;

const newSession = (ref) => sql(`insert into tracking_sessions (tenant_id, ref, utm_source, utm_medium, utm_campaign, fbclid, clicked_at)
  values ('${A}', '${ref}', 'facebook', 'cpc', 'campanha-${TAG}', 'fbclid${TAG}', now()) returning id`).split("\n")[0];

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  admin = createClient(URL_, ANON, { auth: { persistSession: false } });
  const s = await admin.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" });
  assert.equal(s.error, null);
  adminJwt = s.data.session.access_token;
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'atribuição ${TAG}')`);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
});

test("lead chega no WhatsApp com o código: conversa, contato e negócio ficam com a campanha", async () => {
  const ref = `${rnd()}-${rnd()}`;
  const ts = newSession(ref);
  const phone = `55119${String(80000000 + TAG).slice(-8)}`;
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: {
    from_me: false, wa_id: phone, phone, push_name: "Paula Lead", body: `Olá! Quero saber mais. Ref: ${ref.toUpperCase()}`, wa_message_id: `ATR${TAG}A` } }));

  assert.equal(sql(`select tracking_session_id from whatsapp_conversations c join whatsapp_contacts w on w.id = c.contact_id where w.instance_id = '${inst.id}' and w.phone = '${phone}'`), ts);
  assert.equal(sql(`select customer_phone || '|' || customer_name from tracking_sessions where id = '${ts}'`), `${phone}|Paula Lead`);
  assert.match(sql(`select tags::text from tracking_sessions where id = '${ts}'`), /entrou no whatsapp/);

  const contact = sql(`select acquisition_basis || '|' || utm_source || '|' || utm_campaign || '|' || first_tracking_session_id from crm_contacts where tenant_id = '${A}' and phone_match_key like '%' || right('${phone}', 8) and archived_at is null order by created_at desc limit 1`);
  assert.equal(contact, `known|facebook|campanha-${TAG}|${ts}`);

  const deals = sql(`select count(*) || '|' || count(*) filter (where tracking_session_id = '${ts}') from crm_deals d join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${A}' and c.phone_match_key like '%' || right('${phone}', 8) and d.status = 'open'`);
  assert.equal(deals, "1|1", "um único negócio, ligado à campanha (sem duplicar)");
});

test("venda confirmada pelo telefone em outro formato (sem 55 e sem o 9) encontra a campanha", async () => {
  const ref = `${rnd()}-${rnd()}`;
  const ts = newSession(ref);
  const phone = `55119${String(81000000 + TAG).slice(-8)}`;
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: {
    from_me: false, wa_id: phone, phone, body: `ref: ${ref}`, wa_message_id: `ATR${TAG}B` } }));
  const sem9 = phone.slice(2, 4) + phone.slice(5); // 11 + 8 dígitos
  const res = await fetch(`${URL_}/functions/v1/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ tenant_id: A, customer_phone: sem9, revenue: 320 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(sql(`select lead_status || '|' || revenue::int from tracking_sessions where id = '${ts}'`), "sold|320");
});

test("mensagem sem código não liga nada; código de outra empresa é ignorado", async () => {
  const ref = `${rnd()}-${rnd()}`;
  const B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  const tsB = sql(`insert into tracking_sessions (tenant_id, ref, clicked_at) values ('${B}', '${ref}', now()) returning id`).split("\n")[0];
  const phone = `55119${String(82000000 + TAG).slice(-8)}`;
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: {
    from_me: false, wa_id: phone, phone, body: `Oi! Ref: ${ref}`, wa_message_id: `ATR${TAG}C` } }));
  assert.equal(sql(`select coalesce(customer_phone, '') from tracking_sessions where id = '${tsB}'`), "");
  assert.equal(sql(`select coalesce(tracking_session_id::text, '') from whatsapp_conversations c join whatsapp_contacts w on w.id = c.contact_id where w.instance_id = '${inst.id}' and w.phone = '${phone}'`), "");
});

test("confirmação de entrada pelo código é única (o Lead não vai duas vezes)", async () => {
  const ref = `${rnd()}-${rnd()}`;
  const ts = newSession(ref);
  const hit = () => fetch(`${URL_}/functions/v1/go/confirm?ref=${ref}`, { method: "POST", headers: { apikey: ANON } });
  const [r1, r2] = await Promise.all([hit(), hit()]);
  assert.ok(r1.status < 300 && r2.status < 300);
  assert.notEqual(sql(`select coalesce(whatsapp_opened_at::text, '') from tracking_sessions where id = '${ts}'`), "");
});
