// Resposta automática (boas-vindas do WhatsApp Business) logo após o disparo não conta como resposta.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const ph = (n) => `55119${String(70000000 + TAG * 10 + n).slice(-8)}`;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const svc = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
let A, inst, camp;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'autoreply ${TAG}')`);
  const admin = createClient(URL_, ANON, { auth: { persistSession: false } });
  ok(await admin.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" }));
  sql(`insert into wa_channel_settings (tenant_id, active_provider) values ('${A}', 'gateway') on conflict (tenant_id) do update set active_provider = 'gateway'`);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
  ok(await G("wa_gw_instance_update", { p_instance: inst.id, p_status: "connected", p_phone: "5511900000001" }));
  camp = ok(await admin.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Auto ${TAG}`, p_messages: ["Oi {nome}"], p_min_delay: 15, p_max_delay: 20, p_daily_limit: 100, p_start_hour: 0, p_end_hour: 24, p_opt_out_footer: false }));
  sql(`update wa_campaigns set status = 'running', instance_id = '${inst.id}', followups = '[{"after_hours":4,"text":"Oi {nome}, conseguiu ver?"}]' where id = '${camp}'`);
  sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values
       ('${A}', '${camp}', '${ph(1)}', 'Escola Bot', 'sent', now() - interval '2 seconds'),
       ('${A}', '${camp}', '${ph(2)}', 'Escola Gente', 'sent', now() - interval '3 minutes')`);
});

const replied = (p) => sql(`select (replied_at is not null)::text from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${p}'`);
const leads = (p) => sql(`select count(*) from crm_deals d join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${A}' and c.phone_match_key = idx_private.phone_match_key('${p}') and d.status = 'open'`);
const say = (p, body, id) => G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: p, phone: p, push_name: "Escola", body, wa_message_id: `AR${TAG}${id}` } });

test("boas-vindas automática segundos depois do envio: não conta como resposta, sem lead, segue nos follow-ups", async () => {
  ok(await say(ph(1), "Bem vindo ao Atendimento do Colégio!", "a"));
  assert.equal(replied(ph(1)), "false");
  assert.equal(leads(ph(1)), "0");
  // a mensagem continua na caixa de entrada
  assert.equal(sql(`select count(*) from whatsapp_messages where wa_message_id = 'AR${TAG}a'`), "1");
  // 4 h depois, ainda recebe o follow-up
  sql(`update wa_campaign_recipients set sent_at = now() - interval '5 hours' where campaign_id = '${camp}' and phone = '${ph(1)}'`);
  ok(await svc.rpc("wa_followups_tick", { p_limit: 500 }));
  assert.equal(sql(`select count(*) from wa_outbox where phone = '${ph(1)}' and source = 'followup'`), "1");
});

test("depois, a resposta de uma pessoa conta normalmente (respondeu + Novo lead)", async () => {
  ok(await say(ph(1), "Ainda avaliando", "b"));
  assert.equal(replied(ph(1)), "true");
  assert.equal(leads(ph(1)), "1");
});

test("resposta minutos depois do envio conta na hora", async () => {
  ok(await say(ph(2), "Já planejamos", "c"));
  assert.equal(replied(ph(2)), "true");
  assert.equal(leads(ph(2)), "1");
});
