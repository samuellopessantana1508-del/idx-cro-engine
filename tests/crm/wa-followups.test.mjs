// Follow-ups de disparo para quem não respondeu (stack LOCAL, motor simulado chamando wa_gw_*).
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
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null);
  return c;
};
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const ph = (n) => `55119${String(80000000 + TAG * 10 + n).slice(-8)}`;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const svc = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
const tick = async () => ok(await svc.rpc("wa_followups_tick", { p_limit: 500 }));
let admin, seller, A, inst, camp;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'followups ${TAG}')`);
  sql(`insert into wa_channel_settings (tenant_id, active_provider) values ('${A}', 'gateway') on conflict (tenant_id) do update set active_provider = 'gateway'`);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
  ok(await G("wa_gw_instance_update", { p_instance: inst.id, p_status: "connected", p_phone: "5511900000001" }));
  sql(`update wa_outbox set status = 'canceled' where status = 'queued'`);
  sql(`update wa_campaigns set followups = '[]' where followups <> '[]'`);
  camp = ok(await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Follow ${TAG}`, p_messages: ["Oi {nome}"], p_min_delay: 15, p_max_delay: 20, p_daily_limit: 100, p_start_hour: 0, p_end_hour: 24, p_opt_out_footer: false }));
  sql(`update wa_campaigns set status = 'completed', instance_id = '${inst.id}' where id = '${camp}'`);
  for (const n of [1, 2, 3, 4]) {
    sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values ('${A}', '${camp}', '${ph(n)}', 'Cliente ${n}', 'sent', now() - interval '5 hours')`);
  }
});

const STEPS = [
  { after_hours: 4, label: "D0 +4h", text: "Oi {nome}, conseguiu ver?" },
  { after_hours: 24, label: "D1", text: "Passando de novo, {nome}" },
  { after_hours: 168, label: "D7", text: "Último contato: obrigado, {nome}! Fico à disposição." },
];
const queued = (phone) => sql(`select coalesce(string_agg(body, ' || ' order by created_at), '') from wa_outbox where phone = '${phone}' and source = 'followup' and status <> 'canceled'`);
const ago = (phone, h) => sql(`update wa_campaign_recipients set sent_at = now() - interval '${h} hours', followup_at = case when followup_at is null then null else now() - interval '3 hours' end where campaign_id = '${camp}' and phone = '${phone}'`);

test("configurar: valida ordem, prazo e conteúdo; só quem edita o CRM", async () => {
  const bad = await seller.rpc("wa_campaign_set_followups", { p_campaign_id: camp, p_followups: [{ after_hours: 24, text: "a" }, { after_hours: 4, text: "b" }] });
  assert.match(bad.error?.message ?? "", /ordem/);
  const empty = await seller.rpc("wa_campaign_set_followups", { p_campaign_id: camp, p_followups: [{ after_hours: 4, text: " " }] });
  assert.match(empty.error?.message ?? "", /mensagem ou de um modelo/);
  const other = await login("dona@perfumaria.local");
  assert.ok((await other.rpc("wa_campaign_set_followups", { p_campaign_id: camp, p_followups: STEPS })).error);
  const saved = ok(await seller.rpc("wa_campaign_set_followups", { p_campaign_id: camp, p_followups: STEPS }));
  assert.deepEqual(saved.map((s) => s.after_hours), [4, 24, 168]);
});

test("D0+4h: quem não respondeu recebe o 1º follow-up; quem respondeu ou pediu SAIR não recebe", async () => {
  sql(`update wa_campaign_recipients set replied_at = now() - interval '1 hour' where campaign_id = '${camp}' and phone = '${ph(2)}'`);
  sql(`insert into wa_optouts (tenant_id, phone, source) values ('${A}', '${ph(3)}', 'keyword')`);
  await tick();
  assert.equal(queued(ph(1)), "Oi Cliente 1, conseguiu ver?");
  assert.equal(queued(ph(4)), "Oi Cliente 4, conseguiu ver?");
  assert.equal(queued(ph(2)), "");
  assert.equal(queued(ph(3)), "");
  // rodar de novo não repete
  await tick();
  assert.equal(queued(ph(1)).split(" || ").length, 1);
});

test("o motor envia o follow-up pela fila (QR Code)", async () => {
  const items = [];
  for (let i = 0; i < 4; i++) { const it = ok(await G("wa_gw_claim", { p_instance: inst.id })); if (!it) break; items.push(it); ok(await G("wa_gw_result", { p_outbox_id: it.id, p_ok: true, p_wa_message_id: `fu-${TAG}-${i}`, p_error: null, p_jid: null, p_invalid: false, p_retry: false })); }
  const fu = items.filter((i) => i.source === "followup").map((i) => i.phone).sort();
  assert.deepEqual(fu, [ph(1), ph(4)].sort());
  assert.equal(sql(`select count(*) from wa_outbox where source = 'followup' and phone in ('${ph(1)}', '${ph(4)}') and status = 'sent'`), "2");
});

test("D1 só depois de 24 h; respondeu no meio → a sequência para", async () => {
  await tick();
  assert.equal(queued(ph(1)).split(" || ").length, 1, "ainda não deu 24 h");
  ago(ph(1), 25); ago(ph(4), 25);
  sql(`update wa_campaign_recipients set replied_at = now() where campaign_id = '${camp}' and phone = '${ph(4)}'`);
  await tick();
  assert.equal(queued(ph(1)), "Oi Cliente 1, conseguiu ver? || Passando de novo, Cliente 1");
  assert.equal(queued(ph(4)), "Oi Cliente 4, conseguiu ver?");
});

test("D7 é a despedida e encerra; nada depois disso", async () => {
  ago(ph(1), 170);
  await tick();
  assert.match(queued(ph(1)), /Último contato: obrigado, Cliente 1! Fico à disposição\.$/);
  ago(ph(1), 400);
  await tick();
  assert.equal(queued(ph(1)).split(" || ").length, 3);
  assert.equal(sql(`select followup_step from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(1)}'`), "3");
});

test("fora do horário do disparo não envia; disparo cancelado não envia", async () => {
  sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values ('${A}', '${camp}', '${ph(5)}', 'Cliente 5', 'sent', now() - interval '5 hours')`);
  const h = Number(sql(`select extract(hour from now() at time zone 'America/Sao_Paulo')::int`));
  sql(`update wa_campaigns set start_hour = ${(h + 1) % 24}, end_hour = ${h + 1 >= 24 ? 24 : h + 2 > 24 ? 24 : Math.max(h + 2, ((h + 1) % 24) + 1)} where id = '${camp}'`);
  if (h !== 23) { await tick(); assert.equal(queued(ph(5)), ""); }
  sql(`update wa_campaigns set start_hour = 0, end_hour = 24, status = 'canceled' where id = '${camp}'`);
  await tick();
  assert.equal(queued(ph(5)), "");
  sql(`update wa_campaigns set status = 'completed' where id = '${camp}'`);
  await tick();
  assert.equal(queued(ph(5)), "Oi Cliente 5, conseguiu ver?");
});

test("API oficial: passo sem modelo é pulado (Meta não aceita texto livre fora da janela de 24 h)", async () => {
  sql(`update wa_channel_settings set active_provider = 'cloud_api' where tenant_id = '${A}'`);
  const cloud = sql(`select id from whatsapp_instances where tenant_id = '${A}' and provider = 'cloud_api' limit 1`);
  if (!cloud) {
    sql(`insert into whatsapp_instances (tenant_id, provider, status, instance_name) values ('${A}', 'cloud_api', 'connected', 'cloud-${TAG}')`);
  } else sql(`update whatsapp_instances set status = 'connected' where id = '${cloud}'`);
  sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values ('${A}', '${camp}', '${ph(6)}', 'Cliente 6', 'sent', now() - interval '5 hours')`);
  await tick();
  assert.equal(queued(ph(6)), "");
  assert.match(sql(`select error from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(6)}'`), /sem modelo aprovado/);
  // com modelo aprovado: vai o modelo com a variável do contato
  const cl = sql(`select id from whatsapp_instances where tenant_id = '${A}' and provider = 'cloud_api' limit 1`);
  sql(`insert into wa_templates (tenant_id, instance_id, name, language, status, category, body_text, param_count) values ('${A}', '${cl}', 'fu_teste_${TAG}', 'pt_BR', 'APPROVED', 'MARKETING', 'Oi {{1}}, tudo bem?', 1)`);
  ok(await seller.rpc("wa_campaign_set_followups", { p_campaign_id: camp, p_followups: [
    { after_hours: 4, template: { name: `fu_teste_${TAG}`, language: "pt_BR", params: ["{nome}"] } }, ...STEPS.slice(1)] }));
  sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values ('${A}', '${camp}', '${ph(7)}', 'Cliente 7', 'sent', now() - interval '5 hours')`);
  await tick();
  assert.equal(sql(`select body || '|' || (template->>'name') || '|' || (template->'params'->>0) || '|' || instance_id from wa_outbox where phone = '${ph(7)}' and source = 'followup'`), `Oi Cliente 7, tudo bem?|fu_teste_${TAG}|Cliente 7|${cl}`);
  sql(`update wa_channel_settings set active_provider = 'gateway' where tenant_id = '${A}'`);
});
