// Testes de isolamento multiempresa e permissões do CRM, contra a stack LOCAL
// (Postgres + PostgREST + GoTrue reais, com as migrations do repositório).
// Pré-requisito: scripts/local-stack (reset-db + start) e tests/crm/seed-local.mjs.
// Uso: SUPABASE_URL=http://127.0.0.1:54321 ANON_KEY=... node --test tests/crm/rls-isolation.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const PASSWORD = "Teste@12345";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();

const clients = {};
let A, B;

async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  for (const [k, email] of Object.entries({
    platform: "plataforma@idx.local", adminA: "dono@clinica.local", sellerA1: "ana.vendas@clinica.local",
    sellerA2: "bruno.vendas@clinica.local", marketingA: "marketing@clinica.local", viewerA: "leitura@clinica.local",
    adminB: "dona@perfumaria.local", sellerB: "vendas@perfumaria.local",
  })) clients[k] = await login(email);
});

const uid = (k) => sql(`select id from auth.users where email = '${{
  adminA: "dono@clinica.local", sellerA1: "ana.vendas@clinica.local", sellerA2: "bruno.vendas@clinica.local", sellerB: "vendas@perfumaria.local",
}[k]}'`);

test("empresa B não enxerga nenhum dado comercial da empresa A", async () => {
  const c = clients.adminB;
  for (const table of ["crm_contacts", "crm_deals", "crm_orders", "crm_tasks", "crm_timeline", "crm_pipelines", "crm_stages",
    "crm_rfv_scores", "crm_audit_log", "vw_crm_deals", "vw_crm_contacts", "vw_crm_timeline", "crm_automation_rules"]) {
    const { data, error } = await c.from(table).select("*").eq("tenant_id", A);
    assert.equal(error, null, `${table}: ${error?.message}`);
    assert.equal(data.length, 0, `${table} vazou ${data.length} linhas da empresa A`);
  }
  // e enxerga os próprios
  const own = await c.from("crm_contacts").select("id").eq("tenant_id", B);
  assert.ok(own.data.length >= 4);
});

test("empresa B não consegue escrever na empresa A", async () => {
  const c = clients.adminB;
  const ins = await c.from("crm_contacts").insert({ tenant_id: A, name: "Intruso", phone: "11999990000" });
  assert.ok(ins.error, "insert em outra empresa deveria falhar");
  const upd = await c.from("crm_contacts").update({ name: "Hackeado" }).eq("tenant_id", A).select();
  assert.equal(upd.data?.length ?? 0, 0);
  assert.equal(sql(`select count(*) from crm_contacts where name = 'Hackeado'`), "0");
  const del = await c.from("crm_deals").delete().eq("tenant_id", A).select();
  assert.equal(del.data?.length ?? 0, 0);
  for (const fn of [["crm_kpis", { p_tenant_id: A, p_from: "2020-01-01", p_to: "2030-01-01" }], ["crm_compute_rfv", { p_tenant_id: A }],
    ["crm_rfv_dashboard", { p_tenant_id: A }], ["crm_setup_tenant", { p_tenant_id: A }], ["crm_run_scheduled", { p_tenant_id: A }],
    ["crm_import", { p_tenant_id: A, p_entity: "contacts", p_rows: [{ name: "x" }] }]]) {
    const r = await c.rpc(fn[0], fn[1]);
    assert.ok(r.error, `${fn[0]} deveria recusar acesso à empresa A`);
  }
});

test("FK composta impede vincular negociação de A a contato de B", async () => {
  const contactB = sql(`select id from crm_contacts where tenant_id = '${B}' limit 1`);
  const pipe = sql(`select default_pipeline_id from crm_settings where tenant_id = '${A}'`);
  const stage = sql(`select id from crm_stages where pipeline_id = '${pipe}' order by position limit 1`);
  const r = await clients.adminA.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: stage, title: "Cruzado", contact_id: contactB });
  assert.ok(r.error, "deveria falhar por FK composta");
  const stageB = sql(`select id from crm_stages where tenant_id = '${B}' limit 1`);
  const r2 = await clients.adminA.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: stageB, title: "Etapa de B" });
  assert.ok(r2.error, "não pode usar etapa de outra empresa");
});

test("responsável precisa ser usuário da empresa", async () => {
  const pipe = sql(`select default_pipeline_id from crm_settings where tenant_id = '${A}'`);
  const stage = sql(`select id from crm_stages where pipeline_id = '${pipe}' order by position limit 1`);
  const r = await clients.adminA.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: stage, title: "Dono errado", owner_id: uid("sellerB") });
  assert.ok(r.error);
  assert.match(r.error.message, /responsável/i);
});

test("viewer lê, mas não escreve", async () => {
  const c = clients.viewerA;
  const read = await c.from("crm_deals").select("id").eq("tenant_id", A);
  assert.ok(read.data.length > 0);
  assert.ok((await c.from("crm_contacts").insert({ tenant_id: A, name: "Viewer" })).error);
  assert.ok((await c.from("crm_tasks").insert({ tenant_id: A, title: "x" })).error);
  const upd = await c.from("crm_deals").update({ title: "viewer edit" }).eq("tenant_id", A).select();
  assert.equal(upd.data?.length ?? 0, 0);
  // permissão legada corrigida: viewer não altera sinais de venda da IA
  const ss = await c.from("sale_signals").update({ status: "confirmed" }).eq("tenant_id", A).select();
  assert.equal(ss.data?.length ?? 0, 0);
  const access = await c.rpc("crm_my_access", { p_tenant_id: A });
  assert.equal(access.data.role, "viewer");
  assert.equal(access.data.write, false);
});

test("marketing edita contatos mas não registra vendas nem configura funil", async () => {
  const c = clients.marketingA;
  const ins = await c.from("crm_contacts").insert({ tenant_id: A, name: "Lead do formulário", email: "form@exemplo.com", source_channel: "form" }).select().single();
  assert.equal(ins.error, null, ins.error?.message);
  const order = await c.from("crm_orders").insert({ tenant_id: A, contact_id: ins.data.id, gross_amount: 100 });
  assert.ok(order.error, "marketing não pode registrar venda");
  const pipe = sql(`select default_pipeline_id from crm_settings where tenant_id = '${A}'`);
  assert.ok((await c.from("crm_stages").insert({ tenant_id: A, pipeline_id: pipe, name: "Nova" })).error);
});

test("vendedor com visibilidade 'own' só vê e altera as próprias negociações", async () => {
  sql(`update crm_settings set seller_visibility = 'own' where tenant_id = '${A}'`);
  const s1 = uid("sellerA1"), s2 = uid("sellerA2");
  const [d1, d2] = sql(`select id from crm_deals where tenant_id = '${A}' and contact_id is not null order by created_at limit 2`).split("\n");
  sql(`update crm_deals set owner_id = '${s1}' where id = '${d1}'; update crm_deals set owner_id = '${s2}' where id = '${d2}'`);
  try {
    const { data } = await clients.sellerA1.from("crm_deals").select("id, owner_id").eq("tenant_id", A);
    assert.ok(data.some((d) => d.id === d1));
    assert.ok(!data.some((d) => d.id === d2), "não deveria ver negociação do colega");
    assert.ok(data.every((d) => d.owner_id === s1 || d.owner_id === null));
    const upd = await clients.sellerA1.from("crm_deals").update({ title: "roubada" }).eq("id", d2).select();
    assert.equal(upd.data?.length ?? 0, 0);
    // não pode "pegar" a negociação do colega transferindo para si
    const steal = await clients.sellerA1.from("crm_deals").update({ owner_id: s1 }).eq("id", d2).select();
    assert.equal(steal.data?.length ?? 0, 0);
    // gestor (admin) vê tudo
    const all = await clients.adminA.from("crm_deals").select("id").eq("tenant_id", A);
    assert.ok(all.data.some((d) => d.id === d2));
  } finally {
    sql(`update crm_settings set seller_visibility = 'all' where tenant_id = '${A}'`);
  }
});

test("vendedor não altera configuração do funil", async () => {
  const st = sql(`select id from crm_stages where tenant_id = '${A}' limit 1`);
  const upd = await clients.sellerA1.from("crm_stages").update({ name: "X" }).eq("id", st).select();
  assert.equal(upd.data?.length ?? 0, 0);
});

test("linha do tempo: usuário não forja eventos de sistema nem autoria", async () => {
  const contact = sql(`select id from crm_contacts where tenant_id = '${A}' limit 1`);
  const fake = await clients.sellerA1.from("crm_timeline").insert({ tenant_id: A, contact_id: contact, kind: "order", title: "Venda falsa", actor_id: uid("sellerA1") });
  assert.ok(fake.error);
  const spoof = await clients.sellerA1.from("crm_timeline").insert({ tenant_id: A, contact_id: contact, kind: "note", title: "Nota", actor_id: uid("sellerA2") });
  assert.ok(spoof.error);
  const ok = await clients.sellerA1.from("crm_timeline").insert({ tenant_id: A, contact_id: contact, kind: "note", title: "Anotação", body: "Cliente pediu retorno", actor_id: uid("sellerA1") });
  assert.equal(ok.error, null, ok.error?.message);
});

test("anon não lê nada do CRM", async () => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  for (const t of ["crm_contacts", "crm_deals", "crm_orders", "vw_crm_deals"]) {
    const r = await c.from(t).select("id").limit(1);
    assert.ok(r.error || r.data.length === 0, `${t} exposto ao anon`);
  }
});

test("administrador da plataforma acessa as duas empresas", async () => {
  const a = await clients.platform.from("crm_contacts").select("id").eq("tenant_id", A);
  const b = await clients.platform.from("crm_contacts").select("id").eq("tenant_id", B);
  assert.ok(a.data.length > 0 && b.data.length > 0);
});

test("regras financeiras: pedido grátis com valor é recusado; cancelado e grátis não contam no RFV", async () => {
  const contact = sql(`select id from crm_contacts where tenant_id = '${B}' and name = 'Iara Mendes'`);
  const bad = await clients.adminB.from("crm_orders").insert({ tenant_id: B, contact_id: contact, gross_amount: 50, is_free: true });
  assert.ok(bad.error);
  await clients.adminB.rpc("crm_compute_rfv", { p_tenant_id: B });
  const iara = await clients.adminB.from("crm_rfv_scores").select("*").eq("contact_id", contact);
  assert.equal(iara.data.length, 0, "pedido gratuito não pode gerar cliente no RFV");
  const gui = sql(`select purchase_count from crm_rfv_scores s join crm_contacts c on c.id = s.contact_id where c.name = 'Guilherme Teles'`);
  assert.equal(gui, "1", "pedido cancelado não pode contar");
});

test("estorno total tira a compra do RFV; parcelas não viram compras", async () => {
  const contact = sql(`select id from crm_contacts where tenant_id = '${B}' and name = 'Beatriz Rocha'`);
  const o = await clients.adminB.from("crm_orders").insert({ tenant_id: B, contact_id: contact, gross_amount: 600, installments: 3, status: "confirmed", evidence_type: "payment" }).select().single();
  assert.equal(o.error, null, o.error?.message);
  for (let i = 1; i <= 3; i++) {
    const p = await clients.adminB.from("crm_payments").insert({ tenant_id: B, order_id: o.data.id, amount: 200, installment_number: i });
    assert.equal(p.error, null, p.error?.message);
  }
  await clients.adminB.rpc("crm_compute_rfv", { p_tenant_id: B });
  let s = (await clients.adminB.from("crm_rfv_scores").select("*").eq("contact_id", contact).single()).data;
  assert.equal(s.purchase_count, 2, "3 parcelas = 1 compra");
  assert.equal(Number(s.net_revenue), 989);
  const st = sql(`select status from crm_orders where id = '${o.data.id}'`);
  assert.equal(st, "paid");
  await clients.adminB.from("crm_payments").insert({ tenant_id: B, order_id: o.data.id, kind: "refund", amount: 600 });
  assert.equal(sql(`select status from crm_orders where id = '${o.data.id}'`), "refunded");
  await clients.adminB.rpc("crm_compute_rfv", { p_tenant_id: B });
  s = (await clients.adminB.from("crm_rfv_scores").select("*").eq("contact_id", contact).single()).data;
  assert.equal(s.purchase_count, 1);
  assert.equal(Number(s.net_revenue), 389);
});

test("automação não aceita disparo externo", async () => {
  const r = await clients.adminA.from("crm_automation_rules").insert({ tenant_id: A, name: "Enviar WhatsApp", trigger_event: "deal_created", actions: [{ type: "send_whatsapp", text: "Oi" }] });
  assert.ok(r.error);
  assert.match(r.error.message, /não permitida/);
});

test("mudança de etapa grava histórico, status e tempo na etapa", async () => {
  const deal = sql(`select id from crm_deals where tenant_id = '${A}' and status = 'open' and contact_id is not null limit 1`);
  const won = sql(`select id from crm_stages where tenant_id = '${A}' and kind = 'won' limit 1`);
  const r = await clients.sellerA1.from("crm_deals").update({ stage_id: won }).eq("id", deal).select("status, won_at").single();
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.data.status, "won");
  assert.ok(r.data.won_at);
  assert.equal(sql(`select count(*) > 1 from crm_deal_stage_history where deal_id = '${deal}'`), "t");
  assert.equal(sql(`select count(*) from crm_timeline where deal_id = '${deal}' and kind = 'deal_won'`), "1");
  // ganhar a negociação NÃO cria receita sozinho
  assert.equal(sql(`select count(*) from crm_orders where deal_id = '${deal}'`), "0");
});

test("duplicidade: mesmo telefone em formato diferente é bloqueado", async () => {
  const r = await clients.adminA.from("crm_contacts").insert({ tenant_id: A, name: "Maria 2", phone: "(11) 98765-0001" });
  assert.ok(r.error, "deveria bloquear telefone duplicado");
  const d = await clients.adminA.rpc("crm_find_duplicates", { p_tenant_id: A, p_phone: "1187650001" });
  assert.equal(d.data.length, 1, "deveria sugerir o contato equivalente (9º dígito)");
});
