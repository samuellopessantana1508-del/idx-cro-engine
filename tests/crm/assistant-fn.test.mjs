// Função crm-assistant (stack LOCAL). Rode a stack com
//   AI_PROVIDER=ollama AI_OLLAMA_URL=http://127.0.0.1:11999 bash /opt/stack/start.sh
// O teste sobe uma "IA" falsa nessa porta quando precisa; sem ela, vale a reserva por regras.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 1000000;
let seller, other, A, sellerToken, otherToken, lead, aiServer, aiReply = null;

const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null);
  return [c, r.data.session.access_token];
};
const call = (token, body) => fetch(`${URL_}/functions/v1/crm-assistant`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const localSP = (iso) => new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16).replace(" ", "T");

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  [seller, sellerToken] = await login("ana.vendas@clinica.local");
  [other, otherToken] = await login("dona@perfumaria.local");
  const list = `Assistente ${TAG}`;
  const imp = await seller.rpc("crm_dial_import", { p_tenant_id: A, p_list: list, p_rows: [{ nome: "Drogaria Bom Preço", telefone: `3133${String(TAG).padStart(6, "0")}`, cidade: "Contagem", uf: "MG" }] });
  assert.equal(imp.error, null, imp.error?.message);
  lead = (await seller.from("crm_dial_leads").select("id").eq("list_name", list).single()).data;
  aiServer = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      if (!aiReply) { res.writeHead(500); res.end("off"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: JSON.stringify(aiReply) } }));
    });
  });
  await new Promise((r) => aiServer.listen(11999, "127.0.0.1", r));
});
after(() => aiServer?.close());

test("sem login → 401; outra empresa → 403", async () => {
  assert.equal((await call(null, { tenant_id: A, text: "oi" })).status, 401);
  assert.equal((await call(otherToken, { tenant_id: A, text: "liguei" })).status, 403);
});

test("sem IA: regras entendem retorno com data, objeção, e o plano aplica", async () => {
  aiReply = null;
  const r = await call(sellerToken, { tenant_id: A, source: "voice", text: "Falei com a Marta, achou caro, pediu para ligar sexta às 14h", context: { dial_lead_id: lead.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { plan, engine } = r.body;
  assert.equal(engine, "rules");
  assert.equal(plan.dial_outcome, "callback");
  assert.equal(plan.task.type, "call");
  assert.match(plan.task.due_local, /T14:00$/);
  assert.equal(new Date(plan.task.due_local + ":00-03:00").getDay(), 5, "sexta-feira");
  assert.equal(localSP(plan.task.due_at), plan.task.due_local);
  assert.equal(plan.objection, "Preço / orçamento");
  assert.equal(plan.contact.name, "Marta");
  assert.equal(plan.deal.action, "none");
  const ap = await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: plan });
  assert.equal(ap.error, null, ap.error?.message);
  assert.equal(sql(`select outcome || '|' || objection from crm_dial_leads where id = '${lead.id}'`), "callback|Preço / orçamento");
  assert.equal(sql(`select count(*) from crm_tasks where contact_id = '${ap.data.contact_id}' and task_type = 'call' and due_at = '${plan.task.due_at}'`), "1");
});

test("com IA: usa a resposta, mapeia etapa e acha o contato existente", async () => {
  const stage = sql(`select s.name from crm_stages s join crm_settings c on c.default_pipeline_id = s.pipeline_id where c.tenant_id = '${A}' and s.kind = 'open' order by s.position offset 1 limit 1`);
  aiReply = {
    summary: "Reunião marcada para apresentar a solução",
    dial_outcome: "meeting",
    contact: { name: "Marta", phone: null, company: "Drogaria Bom Preço" },
    deal: { action: "create", title: "Drogaria Bom Preço — Plano anual", value: "R$ 2.400,00", stage_name: stage },
    task: { type: "meeting", title: "Apresentação", due_local: "2030-01-10T10:30" },
    objection: null, note: "Gostou, quer ver apresentação",
  };
  const r = await call(sellerToken, { tenant_id: A, source: "text", text: "marquei reunião dia 10 de janeiro 10:30, plano anual de 2400", context: { dial_lead_id: lead.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { plan, engine, match } = r.body;
  assert.equal(engine, "ai");
  assert.equal(plan.dial_outcome, "meeting");
  assert.equal(plan.deal.value, 2400);
  assert.equal(plan.deal.stage_name, stage);
  assert.equal(plan.task.due_at, "2030-01-10T13:30:00.000Z");
  assert.ok(match?.id, "contato criado no teste anterior deve ser reconhecido");
  assert.equal(plan.contact_id, match.id);
  const ap = await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: plan });
  assert.equal(ap.error, null, ap.error?.message);
  // a reunião do discador já cria a negociação; o assistente só completa valor/etapa (sem duplicar)
  assert.equal(sql(`select count(*) || '|' || max(value) from crm_deals where contact_id = '${match.id}' and status = 'open'`), "1|2400.00");
  assert.equal(sql(`select count(*) from crm_tasks where contact_id = '${match.id}' and task_type = 'meeting' and due_at = '2030-01-10T13:30:00Z'`), "1");
});

test("IA tentando etapa inexistente/ganha não vira venda", async () => {
  aiReply = { dial_outcome: null, contact: { name: "Rui", phone: "11 97777-1234" }, deal: { action: "create", value: 900, stage_name: "Venda ganha" }, task: null, note: "fechou!" };
  const r = await call(sellerToken, { tenant_id: A, text: "o Rui fechou 900" });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.deal.stage_id, null, "etapa ganha não é oferecida à IA");
  const ap = await seller.rpc("crm_assistant_apply", { p_tenant_id: A, p_plan: r.body.plan });
  assert.equal(ap.error, null);
  assert.equal(sql(`select status from crm_deals where id = '${ap.data.deal_id}'`), "open");
});
