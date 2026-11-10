// Integração CRM ↔ IDX legado, automações, KPIs e importação (stack LOCAL).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
let admin, seller, A, token;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  admin = createClient(URL_, ANON, { auth: { persistSession: false } });
  await admin.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" });
  seller = createClient(URL_, ANON, { auth: { persistSession: false } });
  await seller.auth.signInWithPassword({ email: "ana.vendas@clinica.local", password: "Teste@12345" });
  token = (await seller.auth.getSession()).data.session.access_token;
});

test("venda confirmada no fluxo legado (Edge Function crm) vira negociação ganha + pedido rastreável, uma única vez", async () => {
  const call = () => fetch(`${URL_}/functions/v1/crm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update_stage", ref: "lead-carla", status: "sold", revenue: 1200 }),
  }).then((r) => r.json());
  const res = await call();
  assert.equal(res.error, undefined, JSON.stringify(res));
  await call(); // repetição não pode duplicar
  const deal = sql(`select d.status || '|' || d.value from crm_deals d join tracking_sessions t on t.id = d.tracking_session_id where t.ref = 'lead-carla'`);
  assert.equal(deal, "won|1200.00");
  const orders = sql(`select count(*) || '|' || max(status) || '|' || max(evidence_type) from crm_orders o join tracking_sessions t on t.id = o.tracking_session_id where t.ref = 'lead-carla'`);
  assert.equal(orders, "1|confirmed|legacy_confirmation");
  // evento CAPI continua sendo registrado pelo fluxo existente (sem credenciais locais ele falha, mas é registrado)
  assert.ok(Number(sql(`select count(*) from capi_events c join tracking_sessions t on t.id = c.tracking_session_id where t.ref = 'lead-carla' and c.event_name = 'Purchase'`)) >= 1);
});

test("venda desfeita no fluxo legado cancela o pedido espelho (sem apagar histórico)", async () => {
  await fetch(`${URL_}/functions/v1/crm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update_stage", ref: "lead-carla", status: "lost" }),
  });
  assert.equal(sql(`select status from crm_orders o join tracking_sessions t on t.id = o.tracking_session_id where t.ref = 'lead-carla'`), "cancelled");
  assert.equal(sql(`select d.status from crm_deals d join tracking_sessions t on t.id = d.tracking_session_id where t.ref = 'lead-carla'`), "lost");
});

test("venda marcada automaticamente pela IA fica pendente (não conta como receita)", async () => {
  const ts = sql(`select id from tracking_sessions where ref = 'lead-maria'`);
  const conv = sql(`select id from whatsapp_conversations limit 1`);
  sql(`insert into sale_signals(tenant_id, conversation_id, tracking_session_id, signal_type, confidence, evidence_text, status, auto_confirmed, requires_human_confirmation)
       values ('${A}', '${conv}', '${ts}', 'confirmed_sale', 0.95, 'cliente disse que vai pagar', 'confirmed', true, false)`);
  sql(`update tracking_sessions set lead_status = 'sold', revenue = 150, sold_at = now() where id = '${ts}'`);
  assert.equal(sql(`select status || '|' || evidence_type from crm_orders where tracking_session_id = '${ts}'`), "pending|ai_auto_unreviewed");
  const k = await admin.rpc("crm_kpis", { p_tenant_id: A, p_from: new Date(Date.now() - 86400e3 * 30).toISOString(), p_to: new Date(Date.now() + 86400e3).toISOString() });
  assert.equal(k.error, null, k.error?.message);
  assert.ok(k.data.metrics.pending_sales.value >= 1);
});

test("automação ativa cria tarefa e registra execução; inativa não faz nada", async () => {
  const pipe = sql(`select default_pipeline_id from crm_settings where tenant_id = '${A}'`);
  const stage = sql(`select id from crm_stages where pipeline_id = '${pipe}' order by position limit 1`);
  const before = await admin.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: stage, title: "Sem automação" }).select().single();
  assert.equal(sql(`select count(*) from crm_tasks where deal_id = '${before.data.id}'`), "0");

  const rule = await admin.from("crm_automation_rules").update({ enabled: true }).eq("tenant_id", A).eq("template_key", "new_deal_first_contact").select().single();
  assert.equal(rule.error, null, rule.error?.message);
  const sellerId = sql(`select id from auth.users where email = 'ana.vendas@clinica.local'`);
  const d = await admin.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: stage, title: "Paciente indicação", owner_id: sellerId }).select().single();
  const task = sql(`select owner_id || '|' || priority || '|' || title from crm_tasks where deal_id = '${d.data.id}'`);
  assert.equal(task, `${sellerId}|high|Primeiro contato com Paciente indicação`);
  assert.equal(sql(`select status from crm_automation_runs where record_id = '${d.data.id}'`), "success");
  // a negociação agora tem próxima atividade
  assert.equal(sql(`select next_activity_at is not null from crm_deals where id = '${d.data.id}'`), "t");
  await admin.from("crm_automation_rules").update({ enabled: false }).eq("tenant_id", A).eq("template_key", "new_deal_first_contact");
});

test("concluir tarefa atualiza linha do tempo e última atividade", async () => {
  const t = sql(`select id from crm_tasks where tenant_id = '${A}' and status = 'open' limit 1`);
  const r = await seller.from("crm_tasks").update({ status: "done", outcome: "Liguei, agendou avaliação" }).eq("id", t).select("status, completed_at, completed_by").single();
  assert.equal(r.error, null, r.error?.message);
  assert.ok(r.data.completed_at);
  assert.equal(sql(`select count(*) from crm_timeline where kind = 'task_done' and metadata->>'task_id' = '${t}'`), "1");
});

test("KPIs informam indisponibilidade em vez de zero enganoso", async () => {
  const k = await admin.rpc("crm_kpis", { p_tenant_id: A, p_from: "2026-01-01", p_to: "2027-01-01" });
  assert.equal(k.error, null, k.error?.message);
  const m = k.data.metrics;
  assert.equal(m.cac.available, false, "sem investimento sincronizado não há CAC");
  assert.equal(m.cac.value, null);
  assert.equal(m.nrr.available, false, "sem receita recorrente não há NRR");
  assert.ok(m.open_deals.value > 0);
  for (const key of Object.keys(m)) {
    assert.ok(m[key].formula && m[key].source && m[key].label, `${key} sem definição`);
  }
});

test("importação CSV: cria, detecta duplicado e reporta erro por linha", async () => {
  const r = await admin.rpc("crm_import", {
    p_tenant_id: A, p_entity: "contacts", p_file_name: "teste.csv",
    p_rows: [
      { name: "Importado Um", phone: "21 99777-0001", email: "um@exemplo.com", company: "Empresa X", tags: "vip;indicação" },
      { name: "Maria Duplicada", phone: "+55 11 98765-0001" },
      { name: "Telefone ruim", phone: "123" },
      { name: "", phone: "", email: "" },
    ],
  });
  assert.equal(r.error, null, r.error?.message);
  assert.deepEqual([r.data.created, r.data.skipped, r.data.errors], [1, 1, 2]);
  assert.equal(sql(`select c.name || '|' || co.name || '|' || array_to_string(c.tags, ',') from crm_contacts c join crm_companies co on co.id = c.company_id where c.phone = '5521997770001'`),
    "Importado Um|Empresa X|vip,indicação");
});

test("mesclagem manual move histórico e preserva o duplicado arquivado", async () => {
  const keep = sql(`select id from crm_contacts where tenant_id = '${A}' and name = 'Importado Um'`);
  const dup = (await admin.from("crm_contacts").insert({ tenant_id: A, name: "Importado 1 (dup)", email: "um+dup@exemplo.com" }).select().single()).data.id;
  await admin.from("crm_tasks").insert({ tenant_id: A, title: "Tarefa do duplicado", contact_id: dup });
  const r = await admin.rpc("crm_merge_contacts", { p_keep: keep, p_merge: dup });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(sql(`select count(*) from crm_tasks where contact_id = '${keep}' and title = 'Tarefa do duplicado'`), "1");
  assert.equal(sql(`select merged_into_id = '${keep}' from crm_contacts where id = '${dup}'`), "t");
  // vendedor não mescla
  const s = await seller.rpc("crm_merge_contacts", { p_keep: keep, p_merge: dup });
  assert.ok(s.error);
});
