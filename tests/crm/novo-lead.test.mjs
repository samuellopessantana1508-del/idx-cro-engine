// Caminhos de lead: resposta a disparo vira negociação em "Novo lead" (stack LOCAL).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
let A, camp;
const TAG = Date.now() % 100000;
const ph = (n) => `55319${String(TAG).padStart(5, "0")}${String(n).padStart(3, "0")}`; // 13 dígitos, celular com 9

before(() => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  sql(`select idx_private.crm_ensure_defaults('${A}')`);
  camp = sql(`insert into wa_campaigns (tenant_id, name, messages, status) values ('${A}', 'Leads ${TAG}', array['Oi'], 'completed') returning id`).split("\n")[0];
  for (const n of [1, 2, 3, 4]) {
    sql(`insert into wa_campaign_recipients (tenant_id, campaign_id, phone, name, status, sent_at) values ('${A}', '${camp}', '${ph(n)}', 'Cliente ${n} ${TAG}', 'sent', now() - interval '1 hour')`);
  }
});

const stageOf = (phone) => sql(`select coalesce(string_agg(s.legacy_status || ':' || d.source_channel || ':' || d.title, ','), '') from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${A}' and c.phone_match_key = idx_private.phone_match_key('${phone}') and d.status = 'open'`);
const reply = (phone) => sql(`update wa_campaign_recipients set replied_at = now() where campaign_id = '${camp}' and phone = '${phone}'`);

test("resposta ao disparo cria contato e negociação em “Novo lead”", () => {
  reply(ph(1));
  assert.equal(stageOf(ph(1)), `new:whatsapp:Disparo — Cliente 1 ${TAG}`);
  assert.ok(sql(`select crm_contact_id from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(1)}'`));
});

test("quem pediu SAIR não vira lead", () => {
  sql(`insert into wa_optouts (tenant_id, phone, source) values ('${A}', '${ph(2).slice(0, 4) + ph(2).slice(5)}', 'keyword')`);
  reply(ph(2));
  assert.equal(stageOf(ph(2)), "");
});

test("contato que já tem negociação aberta não ganha outra", () => {
  const c = sql(`select idx_private.crm_contact_for_phone('${A}', '${ph(3)}', 'Cliente 3', null, 'whatsapp', 'known')`);
  const st = sql(`select id from crm_stages where tenant_id = '${A}' and kind = 'open' and archived_at is null order by position desc limit 1`);
  const pipe = sql(`select pipeline_id from crm_stages where id = '${st}'`);
  sql(`insert into crm_deals (tenant_id, pipeline_id, stage_id, title, contact_id) values ('${A}', '${pipe}', '${st}', 'Já existia ${TAG}', '${c}')`);
  reply(ph(3));
  assert.equal(sql(`select count(*) from crm_deals where contact_id = '${c}' and status = 'open'`), "1");
  assert.equal(sql(`select title from crm_deals where contact_id = '${c}'`), `Já existia ${TAG}`);
});

test("marcar resposta de novo não duplica", () => {
  reply(ph(4));
  sql(`update wa_campaign_recipients set replied_at = null where campaign_id = '${camp}' and phone = '${ph(4)}'`);
  reply(ph(4));
  assert.equal(stageOf(ph(4)).split(",").length, 1);
});
