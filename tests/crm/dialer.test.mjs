// Discador: importação, marcação, resultados e isolamento (stack LOCAL).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null);
  return c;
};
let admin, seller, other, viewer, A, B;
const LIST = `Farmácias teste ${Date.now()}`;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug <> 'clinica-sorriso' order by slug limit 1`);
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  other = await login("dona@perfumaria.local");
});

const rows = [
  { nome: "Drogaria Central", telefone: "(11) 3333-4444", cidade: "São Paulo", uf: "sp", bairro: "Centro", cnpj: "11.222.333/0001-81" },
  { nome: "Farmácia Bem Estar", telefone: "21 98888-7777", cidade: "Rio de Janeiro", uf: "RJ" },
  { nome: "Duplicada", telefone: "+55 11 3333-4444", cidade: "São Paulo", uf: "SP" },
  { nome: "Sem telefone", telefone: "123", cidade: "X", uf: "MG" },
  { nome: "Farmácia Retorno", telefone: "3132221111", cidade: "Belo Horizonte", uf: "MG" },
];

test("importação normaliza telefone, ignora repetidos e inválidos", async () => {
  const { data, error } = await seller.rpc("crm_dial_import", { p_tenant_id: A, p_list: LIST, p_rows: rows });
  assert.equal(error, null, error?.message);
  assert.deepEqual(data, { total: 5, inserted: 3, duplicates: 1, invalid: 1 });
  assert.equal(sql(`select phone || '|' || uf || '|' || cnpj from crm_dial_leads where list_name = '${LIST}' and name = 'Drogaria Central'`), "551133334444|SP|11222333000181");
  // reimportar não duplica
  const again = await seller.rpc("crm_dial_import", { p_tenant_id: A, p_list: LIST, p_rows: rows });
  assert.equal(again.data.inserted, 0);
});

test("outra empresa não vê nem importa na lista", async () => {
  const { data } = await other.from("crm_dial_leads").select("id").eq("list_name", LIST);
  assert.equal(data.length, 0);
  const imp = await other.rpc("crm_dial_import", { p_tenant_id: A, p_list: LIST, p_rows: rows });
  assert.ok(imp.error, "importar em empresa alheia deveria falhar");
  const ov = await other.rpc("crm_dial_overview", { p_tenant_id: A, p_list: LIST });
  assert.equal(ov.data.total, 0);
});

test("tocar no número marca como ligado e conta ligações; desfazer volta para a fila", async () => {
  const id = sql(`select id from crm_dial_leads where list_name = '${LIST}' and name = 'Farmácia Bem Estar'`);
  let r = await seller.rpc("crm_dial_mark_called", { p_id: id });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.data.status, "called");
  r = await seller.rpc("crm_dial_mark_called", { p_id: id });
  assert.equal(r.data.call_count, 2);
  const ov = await seller.rpc("crm_dial_overview", { p_tenant_id: A, p_list: LIST });
  assert.equal(ov.data.called, 1);
  assert.equal(ov.data.called_today, 1);
  r = await seller.rpc("crm_dial_reset", { p_id: id });
  assert.equal(r.data.status, "pending");
});

test("reunião cria empresa, contato, histórico e negociação no CRM (uma vez só)", async () => {
  const id = sql(`select id from crm_dial_leads where list_name = '${LIST}' and name = 'Drogaria Central'`);
  await seller.rpc("crm_dial_mark_called", { p_id: id });
  const r = await seller.rpc("crm_dial_set_outcome", { p_id: id, p_outcome: "meeting", p_notes: "Reunião quinta 10h com o dono" });
  assert.equal(r.error, null, r.error?.message);
  assert.ok(r.data.contact_id);
  const c = sql(`select c.phone || '|' || co.name || '|' || co.document || '|' || c.source_channel from crm_contacts c join crm_companies co on co.id = c.company_id where c.id = '${r.data.contact_id}'`);
  assert.equal(c, "551133334444|Drogaria Central|11222333000181|outbound");
  assert.equal(sql(`select count(*) from crm_deals where contact_id = '${r.data.contact_id}' and status = 'open'`), "1");
  assert.ok(Number(sql(`select count(*) from crm_timeline where contact_id = '${r.data.contact_id}' and kind = 'call_log'`)) >= 1);
  // repetir o resultado não cria outra negociação
  await seller.rpc("crm_dial_set_outcome", { p_id: id, p_outcome: "meeting" });
  assert.equal(sql(`select count(*) from crm_deals where contact_id = '${r.data.contact_id}'`), "1");
});

test("retornar cria tarefa de ligação para o dia seguinte às 9h; sem interesse não cria contato", async () => {
  const id = sql(`select id from crm_dial_leads where list_name = '${LIST}' and name = 'Farmácia Retorno'`);
  const r = await seller.rpc("crm_dial_set_outcome", { p_id: id, p_outcome: "callback" });
  assert.equal(r.error, null, r.error?.message);
  const t = sql(`select task_type || '|' || to_char(due_at at time zone 'America/Sao_Paulo', 'HH24:MI') || '|' || ((due_at at time zone 'America/Sao_Paulo')::date - (now() at time zone 'America/Sao_Paulo')::date) from crm_tasks where contact_id = '${r.data.contact_id}' order by created_at desc limit 1`);
  assert.equal(t, "call|09:00|1");
  const id2 = sql(`select id from crm_dial_leads where list_name = '${LIST}' and name = 'Farmácia Bem Estar'`);
  const r2 = await seller.rpc("crm_dial_set_outcome", { p_id: id2, p_outcome: "not_interested" });
  assert.equal(r2.data.contact_id, null);
  const bad = await seller.rpc("crm_dial_set_outcome", { p_id: id2, p_outcome: "vendido" });
  assert.ok(bad.error);
});

test("somente leitura não marca ligação", async () => {
  const email = sql(`select u.email from auth.users u join tenant_users tu on tu.user_id = u.id where tu.tenant_id = '${A}' and tu.role = 'viewer' limit 1`);
  if (!email) return; // seed sem usuário de leitura
  viewer = await login(email);
  const id = sql(`select id from crm_dial_leads where list_name = '${LIST}' limit 1`);
  const r = await viewer.rpc("crm_dial_mark_called", { p_id: id });
  assert.ok(r.error, "leitura não deveria conseguir marcar");
});
