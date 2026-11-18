// Importar negociações de outros CRMs (formato do RD Station CRM): contatos criados, etapa desconhecida,
// vendidas/perdidas, valores e datas brasileiros, reimportação e nenhuma automação disparada.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = String(Date.now() % 1000000).padStart(6, "0");
let A, owner, viewer;

// como sai a exportação do RD Station CRM, já mapeada pela tela
const rows = () => [
  { external_id: `rd-${TAG}-1`, title: `Formatura Escola ${TAG}`, value: "R$ 12.500,00", pipeline: "Funil de vendas", stage: `Etapa RD ${TAG}`,
    deal_status: "Em andamento", owner_name: "Carla Souza", created_at: "03/11/2026 10:22", expected_close_date: "20/12/2026",
    name: `Diretora ${TAG}`, phone: `(64) 99${TAG.slice(0, 3)}-${TAG.slice(3)}0, (64) 3621-0000`, email: `diretora${TAG}@escola.com.br`,
    company: `Escola ${TAG}`, source: "RD Station", notes: "Quer orçamento para 300 pessoas" },
  { external_id: `rd-${TAG}-2`, title: `Casamento ${TAG}`, value: "8000", stage: "Ganho", deal_status: "Vendida", name: `Noiva ${TAG}`, email: `noiva${TAG}@gmail.com` },
  { external_id: `rd-${TAG}-3`, title: `Aniversário ${TAG}`, value: "1.500", deal_status: "Perdida", lost_reason: "Preço", name: `Pai ${TAG}`, email: `pai${TAG}@gmail.com` },
];

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  const login = async (email) => {
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
    assert.equal(r.error, null, r.error?.message);
    return c;
  };
  owner = await login("dono@clinica.local");
  viewer = await login("leitura@clinica.local");
  // uma regra de automação ligada e um fluxo de WhatsApp por etapa: a importação não pode acionar nenhum
  sql(`insert into crm_automation_rules (tenant_id, name, trigger_event, actions, enabled)
       values ('${A}', 'Tarefa em negociação nova ${TAG}', 'deal_created', '[{"type":"create_task","title":"Ligar"}]', true)`);
});

test("RD Station: negociação aberta entra com contato, empresa, valor, data e anotação; etapa desconhecida vai para a 1ª", async () => {
  const r = await owner.rpc("crm_import", { p_tenant_id: A, p_entity: "deals", p_rows: rows(), p_file_name: "rd.csv",
    p_options: { origin: "RD Station CRM", unknown_stage: "first", closed_deals: "skip", on_duplicate: "skip" } });
  assert.equal(r.error, null, r.error?.message);
  assert.deepEqual([r.data.created, r.data.skipped, r.data.errors, r.data.contacts_created], [1, 2, 0, 1]);
  const d = sql(`select d.value || '|' || d.expected_close_date || '|' || d.status || '|' || s.position || '|' || c.name || '|' || c.phone || '|' || c.email || '|' || co.name || '|' || array_to_string(c.tags, ',') || '|' || array_to_string(d.tags, ',')
                   from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id join crm_companies co on co.id = d.company_id
                  where d.tenant_id = '${A}' and d.custom->>'id_origem' = 'rd-${TAG}-1'`);
  const first = sql(`select min(position) from crm_stages s join crm_settings st on st.default_pipeline_id = s.pipeline_id where st.tenant_id = '${A}' and s.archived_at is null`);
  const phone = sql(`select idx_private.normalize_phone('(64) 99${TAG.slice(0, 3)}-${TAG.slice(3)}0')`);
  assert.ok(phone, "usa o primeiro telefone válido da célula");
  assert.equal(d, `12500.00|2026-12-20|open|${first}|Diretora ${TAG}|${phone}|diretora${TAG}@escola.com.br|Escola ${TAG}|importado-rd-station-crm|importado-rd-station-crm`);
  const note = sql(`select body from crm_timeline t join crm_deals d on d.id = t.deal_id where d.custom->>'id_origem' = 'rd-${TAG}-1' and t.kind = 'import'`);
  assert.match(note, /Importado de RD Station CRM \(rd\.csv\)/);
  assert.match(note, new RegExp(`Etapa de origem: Etapa RD ${TAG}`));
  assert.match(note, /Responsável de origem: Carla Souza/);
  assert.match(note, /Quer orçamento para 300 pessoas/);
  // nenhuma automação, cadência ou fluxo de WhatsApp foi acionado
  assert.equal(sql(`select count(*) from crm_automation_runs r join crm_deals d on d.id = r.record_id where d.custom->>'id_origem' like 'rd-${TAG}-%'`), "0");
  assert.equal(sql(`select count(*) from crm_tasks t join crm_deals d on d.id = t.deal_id where d.custom->>'id_origem' like 'rd-${TAG}-%'`), "0");
  assert.equal(sql(`select count(*) from wa_flow_queue where phone like '%${TAG.slice(3)}0'`), "0");
  // fora da importação, a automação continua funcionando
  assert.equal(sql(`select coalesce(current_setting('idx.importing', true), '')`), "");
});

test("reimportar o mesmo arquivo não duplica; vendidas/perdidas podem entrar como ganhas/perdidas", async () => {
  const again = await owner.rpc("crm_import", { p_tenant_id: A, p_entity: "deals", p_rows: rows(), p_file_name: "rd.csv",
    p_options: { origin: "RD Station CRM", unknown_stage: "first", closed_deals: "import_status" } });
  assert.equal(again.error, null, again.error?.message);
  assert.deepEqual([again.data.created, again.data.skipped], [2, 1], "a 1ª já existia; as fechadas entram agora");
  assert.equal(sql(`select string_agg(custom->>'id_origem' || '=' || status, ',' order by custom->>'id_origem') from crm_deals where tenant_id = '${A}' and custom->>'id_origem' like 'rd-${TAG}-%'`),
    `rd-${TAG}-1=open,rd-${TAG}-2=won,rd-${TAG}-3=lost`);
  assert.equal(sql(`select value from crm_deals where custom->>'id_origem' = 'rd-${TAG}-3'`), "1500.00");
  assert.match(sql(`select body from crm_timeline t join crm_deals d on d.id = t.deal_id where d.custom->>'id_origem' = 'rd-${TAG}-3'`), /Motivo da perda: Preço/);
});

test("contatos de outro CRM (RD Station Marketing) e permissão", async () => {
  const r = await owner.rpc("crm_import", { p_tenant_id: A, p_entity: "contacts", p_file_name: "leads-rd.csv",
    p_rows: [{ name: `Lead MKT ${TAG}`, email: `lead${TAG}@empresa.com`, phone: "", tags: "evento;b2b", job_title: "Gerente" }],
    p_options: { origin: "RD Station Marketing" } });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.data.created, 1);
  assert.equal(sql(`select array_to_string(tags, ',') from crm_contacts where email = 'lead${TAG}@empresa.com'`), "evento,b2b,importado-rd-station-marketing");
  const v = await viewer.rpc("crm_import", { p_tenant_id: A, p_entity: "deals", p_rows: rows(), p_options: {} });
  assert.ok(v.error, "leitura não importa");
});
