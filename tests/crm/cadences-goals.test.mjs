// Cadências, metas, registro de atividades e assistente (stack LOCAL).
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
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 1000000;
const phone = (n) => `5511${String(90000000 + ((TAG * 7 + n) % 9999999)).padStart(9, "9")}`;
let admin, seller, other, A, B, sellerId, cadenceId, contactId;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug <> 'clinica-sorriso' order by slug limit 1`);
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  other = await login("dona@perfumaria.local");
  sellerId = sql(`select id from auth.users where email = 'ana.vendas@clinica.local'`);
});

test("cadência: só gestor cria; vendedor não", async () => {
  const denied = await seller.from("crm_cadences").insert({ tenant_id: A, name: "Indevida" }).select();
  assert.ok(denied.error || !denied.data?.length, "vendedor não deveria criar cadência");
  const c = ok(await admin.from("crm_cadences").insert({ tenant_id: A, name: `Farmácias ${TAG}` }).select().single());
  cadenceId = c.id;
  ok(await admin.from("crm_cadence_steps").insert([
    { tenant_id: A, cadence_id: c.id, position: 0, wait_days: 0, channel: "call", title: "Primeira ligação" },
    { tenant_id: A, cadence_id: c.id, position: 1, wait_days: 2, channel: "whatsapp", template: "Oi {primeiro_nome}, aqui é da IDX. Podemos falar sobre a {empresa}?" },
    { tenant_id: A, cadence_id: c.id, position: 2, wait_days: 3, channel: "call" },
  ]));
});

test("inscrever cria a 1ª tarefa; repetir não duplica", async () => {
  const company = ok(await seller.from("crm_companies").insert({ tenant_id: A, name: `Drogaria Teste ${TAG}` }).select().single());
  const ct = ok(await seller.from("crm_contacts").insert({ tenant_id: A, name: "Marina Souza", phone: phone(1), company_id: company.id }).select().single());
  contactId = ct.id;
  assert.deepEqual(ok(await seller.rpc("crm_cadence_enroll", { p_cadence_id: cadenceId, p_contact_ids: [ct.id] })), { enrolled: 1, skipped: 0 });
  assert.deepEqual(ok(await seller.rpc("crm_cadence_enroll", { p_cadence_id: cadenceId, p_contact_ids: [ct.id] })), { enrolled: 0, skipped: 1 });
  const tasks = ok(await seller.from("crm_tasks").select("*").eq("contact_id", ct.id).eq("status", "open"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task_type, "call");
  assert.equal(tasks[0].title, "Primeira ligação: Marina Souza");
  assert.ok(Math.abs(new Date(tasks[0].due_at) - Date.now()) < 60_000);
});

test("concluir avança para o WhatsApp com texto pronto, às 9h daqui a 2 dias", async () => {
  const [t1] = ok(await seller.from("crm_tasks").select("id").eq("contact_id", contactId).eq("status", "open"));
  ok(await seller.from("crm_tasks").update({ status: "done", completed_at: new Date().toISOString(), completed_by: sellerId }).eq("id", t1.id));
  const [t2] = ok(await seller.from("crm_tasks").select("*").eq("contact_id", contactId).eq("status", "open"));
  assert.equal(t2.task_type, "whatsapp");
  assert.equal(t2.description, `Oi Marina, aqui é da IDX. Podemos falar sobre a Drogaria Teste ${TAG}?`);
  const local = sql(`select to_char(due_at at time zone 'America/Sao_Paulo', 'HH24:MI') || '|' || ((due_at at time zone 'America/Sao_Paulo')::date - (now() at time zone 'America/Sao_Paulo')::date) from crm_tasks where id = '${t2.id}'`);
  assert.equal(local, "09:00|2");
  // a ligação concluída entra no registro de atividades
  assert.equal(sql(`select count(*) from crm_activity_events where ref_id = '${t1.id}' and kind = 'call'`), "1");
});

test("resposta no WhatsApp pausa a cadência, cancela tarefas e avisa o responsável", async () => {
  const inst = sql(`insert into whatsapp_instances(tenant_id, instance_name, status) values ('${A}', 'cad-${TAG}', 'connected') returning id`).split("\n")[0];
  const wc = sql(`insert into whatsapp_contacts(tenant_id, instance_id, wa_id, phone) values ('${A}', '${inst}', '${phone(1)}@s.whatsapp.net', '${phone(1)}') returning id`).split("\n")[0];
  const conv = sql(`insert into whatsapp_conversations(tenant_id, instance_id, contact_id) values ('${A}', '${inst}', '${wc}') returning id`).split("\n")[0];
  sql(`insert into whatsapp_messages(tenant_id, conversation_id, direction, body) values ('${A}', '${conv}', 'inbound', 'Oi! Pode me ligar amanhã')`);
  const enr = sql(`select status || '|' || stop_reason from crm_cadence_enrollments where contact_id = '${contactId}'`);
  assert.equal(enr, "stopped|reply");
  assert.equal(sql(`select count(*) from crm_tasks where contact_id = '${contactId}' and status = 'open'`), "0");
  assert.equal(sql(`select count(*) from crm_notifications where link_id = '${contactId}' and title like '%respondeu no WhatsApp'`), "1");
});

test("negociação ganha encerra a cadência do contato", async () => {
  const ct = ok(await seller.from("crm_contacts").insert({ tenant_id: A, name: "Paulo Lima", phone: phone(2) }).select().single());
  ok(await seller.rpc("crm_cadence_enroll", { p_cadence_id: cadenceId, p_contact_ids: [ct.id] }));
  const pipe = sql(`select default_pipeline_id from crm_settings where tenant_id = '${A}'`);
  const open = sql(`select id from crm_stages where pipeline_id = '${pipe}' and kind = 'open' order by position limit 1`);
  const won = sql(`select id from crm_stages where pipeline_id = '${pipe}' and kind = 'won' limit 1`);
  const deal = ok(await seller.from("crm_deals").insert({ tenant_id: A, pipeline_id: pipe, stage_id: open, title: "Paulo", contact_id: ct.id, value: 300 }).select().single());
  ok(await seller.from("crm_deals").update({ stage_id: won, status: "won", won_at: new Date().toISOString() }).eq("id", deal.id));
  assert.equal(sql(`select status || '|' || stop_reason from crm_cadence_enrollments where contact_id = '${ct.id}'`), "stopped|deal_won");
});

test("outra empresa não vê nem inscreve na cadência", async () => {
  const r = await other.rpc("crm_cadence_enroll", { p_cadence_id: cadenceId, p_contact_ids: [contactId] });
  assert.ok(r.error);
  const ov = await other.rpc("crm_cadence_overview", { p_tenant_id: A });
  assert.ok(ov.error);
  const mine = ok(await admin.rpc("crm_cadence_overview", { p_tenant_id: A }));
  const c = mine.find((x) => x.id === cadenceId);
  assert.equal(c.steps.length, 3);
  assert.equal(c.replied_count, 1);
  assert.equal(c.won_count, 1);
});

test("metas: ligações e reuniões do discador contam, sem duplicar; desfazer retira", async () => {
  ok(await admin.from("crm_goals").insert([
    { tenant_id: A, name: `Ligações ${TAG}`, metric: "calls", scope: "company", period: "month", target: 200 },
    { tenant_id: A, name: `Reuniões Ana ${TAG}`, metric: "meetings", scope: "user", user_id: sellerId, period: "week", target: 2 },
  ]));
  const denied = await seller.from("crm_goals").insert({ tenant_id: A, name: "x", metric: "calls", target: 1 }).select();
  assert.ok(denied.error || !denied.data?.length, "vendedor não deveria criar meta");

  const LIST = `Metas ${TAG}`;
  ok(await seller.rpc("crm_dial_import", { p_tenant_id: A, p_list: LIST, p_rows: [
    { nome: "Farmácia Um", telefone: phone(11), cidade: "SP", uf: "SP" },
    { nome: "Farmácia Dois", telefone: phone(12), cidade: "SP", uf: "SP" },
  ] }));
  const leads = ok(await seller.from("crm_dial_leads").select("id,name").eq("list_name", LIST).order("name"));
  const before = ok(await seller.rpc("crm_goals_progress", { p_tenant_id: A }));
  const calls0 = before.find((g) => g.name === `Ligações ${TAG}`).actual;
  const meet0 = Number(before.find((g) => g.name === `Reuniões Ana ${TAG}`).actual);
  for (const l of leads) ok(await seller.rpc("crm_dial_mark_called", { p_id: l.id }));
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  ok(await seller.rpc("crm_dial_set_outcome", { p_id: leads[1].id, p_outcome: "meeting", p_notes: "Quer ver proposta", p_due_at: due, p_objection: "preço" }));
  // repetir o mesmo resultado não conta reunião de novo
  ok(await seller.rpc("crm_dial_set_outcome", { p_id: leads[1].id, p_outcome: "meeting", p_notes: null }));

  const g = ok(await seller.rpc("crm_goals_progress", { p_tenant_id: A }));
  const calls = g.find((x) => x.name === `Ligações ${TAG}`);
  const meet = g.find((x) => x.name === `Reuniões Ana ${TAG}`);
  assert.equal(Number(calls.actual) - Number(calls0), 2);
  assert.ok(calls.by_user.some((u) => u.user_id === sellerId));
  assert.equal(Number(meet.actual) - meet0, 1, "a reunião (com tarefa agendada) conta uma vez só");
  assert.equal(Number(meet.pct), Math.round(1000 * Number(meet.actual) / 2) / 10);
  const lead = sql(`select objection || '|' || (contact_id is not null) from crm_dial_leads where id = '${leads[1].id}'`);
  assert.equal(lead, "preço|true");
  assert.equal(sql(`select count(*) from crm_tasks where task_type = 'meeting' and contact_id = (select contact_id from crm_dial_leads where id = '${leads[1].id}')`), "1");

  ok(await seller.rpc("crm_dial_reset", { p_id: leads[0].id }));
  const g2 = ok(await seller.rpc("crm_goals_progress", { p_tenant_id: A }));
  assert.equal(Number(g2.find((x) => x.name === `Ligações ${TAG}`).actual) - Number(calls0), 1);
  assert.ok((await other.rpc("crm_goals_progress", { p_tenant_id: A })).error, "outra empresa não vê metas");
});

test("assistente: cria empresa, contato, negociação e tarefa a partir do plano", async () => {
  const due = new Date(Date.now() + 86400000).toISOString();
  const r = ok(await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: {
    source: "voice", transcript: "Falei com o Carlos da Drogaria Nova, quer proposta de 800 reais, ligar amanhã",
    contact: { name: "Carlos", phone: phone(21), company: `Drogaria Nova ${TAG}`, city: "Campinas", uf: "sp" },
    deal: { action: "create", title: "Proposta Drogaria Nova", value: 800 },
    task: { type: "call", title: "Ligar para fechar", due_at: due },
    note: "Quer proposta de 800 reais", objection: "prazo de pagamento",
  } }));
  assert.ok(r.contact_id && r.deal_id && r.task_id);
  assert.equal(sql(`select ct.name || '|' || co.name || '|' || ct.state from crm_contacts ct join crm_companies co on co.id = ct.company_id where ct.id = '${r.contact_id}'`), `Carlos|Drogaria Nova ${TAG}|SP`);
  assert.equal(sql(`select value || '|' || status || '|' || owner_id from crm_deals where id = '${r.deal_id}'`), `800.00|open|${sellerId}`);
  assert.equal(sql(`select title from crm_tasks where id = '${r.task_id}'`), "Ligar para fechar: Carlos");
  assert.equal(sql(`select count(*) from crm_timeline where contact_id = '${r.contact_id}' and kind = 'note' and body like '%Objeção: prazo de pagamento%'`), "1");
  // mesmo telefone de novo → reaproveita o contato
  const r2 = ok(await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: { source: "text", contact: { phone: phone(21) }, note: "Mandei a proposta" } }));
  assert.equal(r2.contact_id, r.contact_id);
});

test("assistente nunca marca venda: etapa ganha é recusada", async () => {
  const won = sql(`select s.id from crm_stages s join crm_settings cs on cs.default_pipeline_id = s.pipeline_id where cs.tenant_id = '${A}' and s.kind = 'won' limit 1`);
  const r = await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: {
    contact: { name: "Teste venda", phone: phone(22) }, deal: { action: "create", stage_id: won, value: 1000 } } });
  assert.ok(r.error);
  assert.match(r.error.message, /manualmente/);
  assert.equal(sql(`select count(*) from crm_contacts where phone = '${phone(22)}'`), "0", "nada deve ser gravado quando recusa");
});

test("assistente no discador: retorno com data e objeção", async () => {
  const LIST = `Assist ${TAG}`;
  ok(await seller.rpc("crm_dial_import", { p_tenant_id: A, p_list: LIST, p_rows: [{ nome: "Farmácia Voz", telefone: phone(31), cidade: "Recife", uf: "PE" }] }));
  const [lead] = ok(await seller.from("crm_dial_leads").select("id").eq("list_name", LIST));
  const due = "2030-03-15T17:00:00.000Z";
  const r = ok(await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: {
    source: "voice", transcript: "Pediu para ligar sexta às 14h, achou caro", dial_lead_id: lead.id, dial_outcome: "callback",
    task: { type: "call", due_at: due }, note: "Pediu retorno sexta 14h", objection: "achou caro" } }));
  assert.ok(r.contact_id);
  assert.equal(sql(`select outcome || '|' || objection from crm_dial_leads where id = '${lead.id}'`), "callback|achou caro");
  assert.equal(sql(`select count(*) from crm_tasks where contact_id = '${r.contact_id}' and due_at = '${due}' and task_type = 'call'`), "1");
});

test("busca por telefone (extensão): acha pelo celular com/sem 9º dígito; outra empresa não", async () => {
  const p = phone(21);
  const without9 = p.slice(0, 4) + p.slice(5); // 55 11 + 8 dígitos
  const c = ok(await seller.rpc("crm_lookup_phone", { p_tenant_id: A, p_phone: `+${without9}` }));
  assert.equal(c.name, "Carlos");
  assert.equal(c.deals[0].title, "Proposta Drogaria Nova");
  assert.equal(ok(await seller.rpc("crm_lookup_phone", { p_tenant_id: A, p_phone: "5599999999999" })), null);
  assert.ok((await other.rpc("crm_lookup_phone", { p_tenant_id: A, p_phone: p })).error);
});
