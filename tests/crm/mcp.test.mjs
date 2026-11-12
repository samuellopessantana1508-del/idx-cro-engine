// Conector MCP do CRO (stack LOCAL). Usa o SDK OFICIAL de cliente MCP para validar o protocolo.
//   npm i --prefix /tmp/mcpsdk @modelcontextprotocol/sdk   (ou MCP_SDK=<pasta node_modules>)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const SDK = process.env.MCP_SDK ?? "/tmp/mcpsdk/node_modules";
const { Client } = await import(`${SDK}/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${SDK}/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`);

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const MCP = `${URL_}/functions/v1/cro-mcp`;
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
let A, B, admin, seller, viewer, other, readTok, writeTok, viewerTok, otherTok;

async function connect(token, viaUrl = false) {
  const client = new Client({ name: "teste-cro", version: "1.0.0" });
  const transport = viaUrl
    ? new StreamableHTTPClientTransport(new URL(`${MCP}/${token}`))
    : new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  const login = async (email) => {
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
    assert.equal(r.error, null);
    return c;
  };
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  viewer = await login("leitura@clinica.local");
  other = await login("dona@perfumaria.local");
});

test("tokens: criados no CRO, aparecem uma vez, só o dono vê; leitura não pode virar ação", async () => {
  const r = await seller.rpc("mcp_token_create", { p_tenant_id: A, p_name: `Claude ${TAG}`, p_scope: "read" });
  assert.equal(r.error, null, r.error?.message);
  readTok = r.data.token;
  assert.match(readTok, /^cro_[a-f0-9]{64}$/);
  writeTok = (await seller.rpc("mcp_token_create", { p_tenant_id: A, p_name: `Claude ações ${TAG}`, p_scope: "write" })).data.token;
  const v = await viewer.rpc("mcp_token_create", { p_tenant_id: A, p_name: "x", p_scope: "write" });
  assert.match(v.error?.message ?? "", /só permite tokens de leitura/);
  viewerTok = (await viewer.rpc("mcp_token_create", { p_tenant_id: A, p_name: "leitura", p_scope: "read" })).data.token;
  otherTok = (await other.rpc("mcp_token_create", { p_tenant_id: B, p_name: "outra", p_scope: "write" })).data.token;
  assert.equal(sql(`select count(*) from mcp_tokens where token_hash = '${readTok}'`), "0", "token não fica salvo em texto");
  const mine = (await seller.from("mcp_tokens").select("name, token_prefix, scope")).data;
  assert.ok(mine.every((t) => !("token_hash" in t)) && mine.some((t) => t.name === `Claude ${TAG}`));
  assert.equal((await other.from("mcp_tokens").select("id").eq("tenant_id", A)).data.length, 0);
  const cross = await other.rpc("mcp_token_create", { p_tenant_id: A, p_name: "x", p_scope: "read" });
  assert.ok(cross.error, "não cria token para empresa que não é sua");
});

test("protocolo MCP com o SDK oficial: initialize, ferramentas, prompts", async () => {
  const c = await connect(readTok);
  const info = c.getServerVersion();
  assert.equal(info.name, "idx-cro-engine");
  assert.match(c.getInstructions(), /Clínica Sorriso/);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("resumo_comercial") && tools.includes("discador"));
  assert.ok(!tools.includes("enviar_whatsapp"), "token de leitura não vê ações");
  const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ["analisar_disparos", "prospectar_farmacias", "rotina_do_dia"]);
  const p = await c.getPrompt({ name: "rotina_do_dia" });
  assert.match(p.messages[0].content.text, /resumo_comercial/);
  await c.close();
  const w = await connect(writeTok);
  const wt = (await w.listTools()).tools;
  assert.ok(wt.find((t) => t.name === "enviar_whatsapp").annotations.openWorldHint);
  assert.equal(wt.find((t) => t.name === "resumo_comercial").annotations.readOnlyHint, true);
  await w.close();
});

test("token no endereço (para o conector personalizado do Claude.ai) também funciona", async () => {
  const c = await connect(readTok, true);
  const r = await call(c, "resumo_comercial", { dias: 30 });
  assert.equal(r.isError, undefined);
  assert.equal(r.data.empresa, "Clínica Sorriso");
  assert.ok("indicadores" in r.data && "discador" in r.data && "tarefas" in r.data);
  assert.ok(r.structuredContent.empresa);
  await c.close();
});

test("sem token / revogado → 401", async () => {
  const res = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
  const t = (await seller.rpc("mcp_token_create", { p_tenant_id: A, p_name: "revogar", p_scope: "read" })).data;
  assert.equal((await seller.rpc("mcp_token_revoke", { p_id: t.id })).error, null);
  const res2 = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(res2.status, 401);
});

test("leitura: contatos, discador, tarefas e disparos com os dados da empresa certa", async () => {
  sql(`insert into crm_contacts(tenant_id, name, phone, city) values ('${A}', 'Paula MCP ${TAG}', '5511977${String(TAG).padStart(6, "0")}', 'Campinas')`);
  sql(`insert into crm_contacts(tenant_id, name, phone) values ('${B}', 'Outra Empresa ${TAG}', '5511966${String(TAG).padStart(6, "0")}')`);
  const c = await connect(readTok);
  const found = (await call(c, "buscar_contatos", { busca: `MCP ${TAG}` })).data;
  assert.equal(found.length, 1);
  assert.equal(found[0].cidade, "Campinas");
  assert.equal((await call(c, "buscar_contatos", { busca: `Outra Empresa ${TAG}` })).data.length, 0, "não vê outra empresa");
  assert.equal((await call(c, "buscar_contatos", { busca: `977${String(TAG).padStart(6, "0")}` })).data[0].nome, `Paula MCP ${TAG}`, "busca por telefone");
  const ficha = (await call(c, "ver_contato", { contato_id: found[0].id })).data;
  assert.equal(ficha.contato.nome, `Paula MCP ${TAG}`);
  const d = (await call(c, "discador", { limite: 5 })).data;
  assert.ok("resumo" in d && Array.isArray(d.leads));
  assert.ok(Array.isArray((await call(c, "listar_disparos")).data));
  assert.ok(Array.isArray((await call(c, "listar_tarefas", { filtro: "todas", so_minhas: false })).data));
  assert.ok(Array.isArray((await call(c, "conversas_whatsapp")).data));
  // ação com token de leitura é recusada mesmo chamando direto
  const w = await call(c, "criar_tarefa", { titulo: "x" });
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /só de leitura|desconhecida/);
  // contato de outra empresa pelo ID
  const otherId = sql(`select id from crm_contacts where tenant_id = '${B}' and name = 'Outra Empresa ${TAG}'`);
  const x = await call(c, "ver_contato", { contato_id: otherId });
  assert.equal(x.isError, true);
  await c.close();
});

test("ações: criar contato (sem duplicar), tarefa, nota, concluir — tudo em nome do usuário e auditado", async () => {
  const c = await connect(writeTok);
  const sellerId = sql(`select id from auth.users where email = 'ana.vendas@clinica.local'`);
  const ct = (await call(c, "criar_contato", { nome: `Rui MCP ${TAG}`, telefone: `(11) 95${String(TAG).padStart(3, "0")}-${String(TAG).slice(-4).padStart(4, "1")}`, empresa: `Drogaria MCP ${TAG}` })).data;
  assert.equal(ct.ja_existia, false);
  const again = (await call(c, "criar_contato", { nome: "Rui de novo", telefone: `(11) 95${String(TAG).padStart(3, "0")}-${String(TAG).slice(-4).padStart(4, "1")}` })).data;
  assert.equal(again.ja_existia, true);
  assert.equal(again.contato_id, ct.contato_id);
  assert.equal(sql(`select c.owner_id || '|' || co.name from crm_contacts c join crm_companies co on co.id = c.company_id where c.id = '${ct.contato_id}'`), `${sellerId}|Drogaria MCP ${TAG}`);
  const tk = (await call(c, "criar_tarefa", { titulo: "Ligar para o Rui", tipo: "call", contato_id: ct.contato_id, vencimento: "2026-12-01T15:00:00-03:00" })).data;
  assert.equal(sql(`select owner_id || '|' || task_type || '|' || to_char(due_at at time zone 'America/Sao_Paulo', 'HH24:MI') from crm_tasks where id = '${tk.tarefa_id}'`), `${sellerId}|call|15:00`);
  assert.equal((await call(c, "adicionar_nota", { contato_id: ct.contato_id, texto: "Prefere ligação à tarde" })).isError, undefined);
  assert.equal(sql(`select actor_id || '|' || body from crm_timeline where contact_id = '${ct.contato_id}' and kind = 'note'`), `${sellerId}|Prefere ligação à tarde`);
  assert.equal((await call(c, "concluir_tarefa", { tarefa_id: tk.tarefa_id, resultado: "Agendou visita" })).isError, undefined);
  assert.equal(sql(`select status from crm_tasks where id = '${tk.tarefa_id}'`), "done");
  const bad = await call(c, "criar_tarefa", { titulo: "x", tipo: "invalido" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Tipo de tarefa inválido/);
  assert.equal(sql(`select count(*) from mcp_calls where tool = 'criar_contato' and user_id = '${sellerId}' and ok`) >= "2", true);
  assert.ok(Number(sql(`select count(*) from mcp_calls where tool = 'criar_tarefa' and not ok and error is not null`)) >= 1, "falhas também ficam registradas");
  await c.close();
});

test("ações de WhatsApp e disparo passam pelas mesmas proteções", async () => {
  const c = await connect(writeTok);
  sql(`insert into wa_optouts(tenant_id, phone) values ('${A}', '5511944${String(TAG).padStart(6, "0")}') on conflict do nothing`);
  const r = await call(c, "enviar_whatsapp", { telefone: `5511944${String(TAG).padStart(6, "0")}`, mensagem: "oi" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /SAIR/);
  const ok = await call(c, "enviar_whatsapp", { telefone: `5511933${String(TAG).padStart(6, "0")}`, mensagem: "Olá! Aqui é da IDX." });
  if (sql(`select count(*) from whatsapp_instances where tenant_id = '${A}' and provider = 'gateway'`) !== "0") {
    assert.equal(ok.data.na_fila, true);
    assert.equal(sql(`select created_by = (select id from auth.users where email = 'ana.vendas@clinica.local') from wa_outbox where id = '${ok.data.envio_id}'`), "t");
  }
  const camp = sql(`insert into wa_campaigns(tenant_id, name, messages) values ('${A}', 'MCP ${TAG}', '{"oi"}') returning id`).split("\n")[0];
  const st = await call(c, "controlar_disparo", { disparo_id: camp, acao: "iniciar" });
  assert.equal(st.isError, true, "sem público não inicia");
  assert.match(st.content[0].text, /Adicione contatos/);
  await c.close();
});

test("isolamento: token de outra empresa só vê a própria", async () => {
  const c = await connect(otherTok);
  const r = (await call(c, "resumo_comercial")).data;
  assert.equal(r.empresa, "Perfumaria Aroma");
  const anyA = (await call(c, "buscar_contatos", { busca: `MCP ${TAG}` })).data;
  assert.equal(anyA.length, 0);
  await c.close();
});
