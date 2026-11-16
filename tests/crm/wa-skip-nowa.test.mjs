// Número que já falhou por não ter WhatsApp não entra de novo em outro disparo.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const ph = (n) => `55119${String(60000000 + TAG * 10 + n).slice(-8)}`;
let A, admin, old;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  admin = createClient(URL_, ANON, { auth: { persistSession: false } });
  ok(await admin.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" }));
  const save = (name) => admin.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: name, p_messages: ["Oi {nome}"], p_min_delay: 15, p_max_delay: 20, p_daily_limit: 100, p_start_hour: 0, p_end_hour: 24, p_opt_out_footer: false });
  old = ok(await save(`Antigo ${TAG}`));
  sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, error) values
       ('${A}', '${old}', '${ph(1)}', 'Fixo sem WhatsApp', 'failed', 'Este número não tem WhatsApp ou não pode receber mensagens.'),
       ('${A}', '${old}', '${ph(2)}', 'Falhou por outro motivo', 'failed', 'Meta: limite de mensagens de marketing'),
       ('${A}', '${old}', '${ph(3)}', 'Inválido', 'invalid', null)`);
});

test("disparo novo pula quem já falhou por não ter WhatsApp e conta em sem_whatsapp", async () => {
  const camp = ok(await admin.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Novo ${TAG}`, p_messages: ["Oi"], p_min_delay: 15, p_max_delay: 20, p_daily_limit: 100, p_start_hour: 0, p_end_hour: 24, p_opt_out_footer: false }));
  // o primeiro chega sem o 9º dígito: tem que reconhecer do mesmo jeito
  const no9 = ph(1).slice(0, 4) + ph(1).slice(5);
  const r = ok(await admin.rpc("wa_campaign_add_recipients", { p_campaign_id: camp, p_source: "rows", p_rows: [
    { telefone: no9, nome: "Fixo sem WhatsApp" }, { telefone: ph(2), nome: "Outro motivo" }, { telefone: ph(3), nome: "Inválido" }, { telefone: ph(4), nome: "Novo" }] }));
  assert.equal(r.sem_whatsapp, 2);
  assert.equal(r.added, 2);
  const phones = sql(`select string_agg(phone, ',' order by phone) from wa_campaign_recipients where campaign_id = '${camp}'`).split(",");
  assert.deepEqual(phones.sort(), [ph(2), ph(4)].sort());
});
