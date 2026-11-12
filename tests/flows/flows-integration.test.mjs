// Automações de WhatsApp de ponta a ponta (stack LOCAL): banco + Edge Function cro-flows + fila única.
// Simula o motor do WhatsApp chamando wa_gw_* e o "tick" da cro-flows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const TAG = Date.now() % 100000;
const ph = (n) => `55119${String(80000000 + (TAG * 37 + n * 7919) % 9999999).padStart(8, "0").slice(-8)}`;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
let admin, seller, other, A, inst, msgN = 0;

const tick = async () => {
  const r = await fetch(`${URL_}/functions/v1/cro-flows`, { method: "POST", headers: { "x-gateway-token": TOKEN, "Content-Type": "application/json" }, body: "{}" });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  return b;
};
const inbound = (phone, body, name = "Cliente Teste") =>
  G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: phone, phone, push_name: name, body, wa_message_id: `FLW${TAG}-${++msgN}` } }).then(ok);
const outbox = (phone) => sql(`select coalesce(string_agg(coalesce(nullif(body,''), '[' || media_type || ']'), ' || ' order by created_at, id), '') from wa_outbox where phone = '${phone}' and source = 'flow'`);
// o motor envia tudo o que está na fila (prioridade manual/flow) e confirma
const drain = async () => {
  for (let i = 0; i < 50; i++) {
    const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
    if (!m) return;
    ok(await G("wa_gw_result", { p_outbox_id: m.id, p_ok: true, p_wa_message_id: `OUT${TAG}-${randomBytes(4).toString("hex")}`, p_jid: `${m.phone}@s.whatsapp.net` }));
  }
};
const due = (flowId) => sql(`update wa_flow_runs set resume_at = now() - interval '1 second' where flow_id = '${flowId}' and status = 'waiting'`);

// mocks: IA (Ollama) e webhook externo
const hooks = [];
let aiServer, hookServer, hookPort;
before(async () => {
  aiServer = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = JSON.parse(b || "{}");
      const last = body.messages?.at(-1)?.content ?? "";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: { content: `Resposta da IA para: ${last}` } }));
    });
  });
  await new Promise((r) => aiServer.listen(11999, "127.0.0.1", r)).catch(() => {});
  hookServer = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      hooks.push(JSON.parse(b || "{}"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ pedido: 123 }));
    });
  });
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  hookPort = hookServer.address().port;

  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  other = await login("dona@perfumaria.local");
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'fluxos ${TAG}')`);
  // isolamento entre execuções do teste
  sql(`update wa_flows set status = 'paused' where status = 'active'`);
  sql(`update wa_flow_runs set status = 'cancelled' where status in ('running','waiting')`);
  sql(`update wa_flow_queue set processed_at = now() where processed_at is null`);
  sql(`update wa_outbox set status = 'canceled' where status = 'queued'`);
  sql(`update wa_campaigns set status = 'canceled' where status = 'running'`);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
});
after(() => { aiServer?.close(); hookServer?.close(); });

const N = (id, type, config = {}, x = 0) => ({ id, type, position: { x, y: 0 }, data: { config } });
const E = (source, target, sourceHandle = null) => ({ id: `${source}-${target}-${sourceHandle ?? "n"}`, source, target, sourceHandle });
let main;

const mainGraph = () => ({
  nodes: [
    N("t", "trigger", { kind: "keyword", keywords: "preço\norçamento" }),
    N("hi", "send_text", { text: "Oi {primeiro_nome}! 👋" }),
    N("m", "send_menu", { text: "Como posso ajudar?", options: "Ver catálogo\nFalar com atendente", timeout: 2, timeoutUnit: "hours" }),
    N("img", "send_media", { mediaType: "image", url: "https://exemplo.com/catalogo.jpg", caption: "Catálogo de {primeiro_nome}" }),
    N("tg", "tag", { tag: "catalogo" }),
    N("deal", "crm_deal", { action: "create", title: "Catálogo — {nome}" }),
    N("w", "wait", { amount: 1, unit: "minutes" }),
    N("fu", "send_text", { text: "Gostou do catálogo?" }),
    N("h", "handoff", { message: "Já chamo alguém da equipe 🙂" }),
    N("tk", "task", { title: "Ligar para {nome} (não respondeu o menu)", dueInHours: 1 }),
  ],
  edges: [E("t", "hi"), E("hi", "m"), E("m", "img", "opt0"), E("img", "tg"), E("tg", "deal"), E("deal", "w"), E("w", "fu"), E("m", "h", "opt1"), E("m", "tk", "timeout")],
});

test("só gestor cria/edita automação; outra empresa não enxerga", async () => {
  const denied = await seller.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: "X", p_graph: mainGraph() });
  assert.match(denied.error?.message ?? "", /gestores/);
  main = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Preço ${TAG}`, p_graph: mainGraph() }));
  assert.equal(main.status, "draft");
  assert.equal(main.trigger_kind, "keyword");
  const two = await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: "dois gatilhos", p_graph: { nodes: [N("a", "trigger"), N("b", "trigger")], edges: [] } });
  assert.match(two.error?.message ?? "", /um gatilho/);
  const seen = ok(await other.from("wa_flows").select("id").eq("id", main.id));
  assert.equal(seen.length, 0);
  const list = ok(await seller.rpc("wa_flow_list", { p_tenant_id: A }));
  assert.ok(list.some((f) => f.id === main.id));
  // funções do servidor não ficam expostas
  const q = await admin.rpc("wa_flow_claim_queue", { p_limit: 5 });
  assert.ok(q.error, "usuário não pode puxar a fila do motor");
});

test("rascunho não responde; ativado responde pela mesma fila e conexão", async () => {
  const p = ph(1);
  await inbound(p, "qual o preço?", "Ana Paula");
  await tick();
  assert.equal(outbox(p), "", "rascunho não age");
  main = ok(await admin.rpc("wa_flow_set_status", { p_flow_id: main.id, p_status: "active" }));
  assert.equal(main.status, "active");
  await inbound(p, "me passa o orçamento");
  await tick();
  assert.equal(outbox(p), "Oi Ana! 👋 || Como posso ajudar?\n\n1️⃣ Ver catálogo\n2️⃣ Falar com atendente\n\n_Responda com o número da opção._");
  // o motor pega as mensagens da automação como as manuais (antes de campanhas) e registra na caixa de entrada
  await drain();
  assert.equal(sql(`select count(*) from wa_outbox where phone = '${p}' and source = 'flow' and status = 'sent'`), "2");
  assert.equal(sql(`select count(*) from whatsapp_messages m join whatsapp_conversations c on c.id = m.conversation_id join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${p}' and m.direction = 'outbound'`), "2");
  const run = sql(`select status || ':' || wait_kind || ':' || current_node from wa_flow_runs where flow_id = '${main.id}' and phone = '${p}'`);
  assert.equal(run, "waiting:menu:m");
});

test("menu → opção 1: mídia, etiqueta, negociação no funil, espera e follow-up", async () => {
  const p = ph(1);
  await inbound(p, "1");
  await tick();
  assert.equal(sql(`select media_type || ' ' || media_url || ' ' || body from wa_outbox where phone = '${p}' and media_url is not null`), "image https://exemplo.com/catalogo.jpg Catálogo de Ana");
  assert.equal(sql(`select 'catalogo' = any(tags) from crm_contacts where tenant_id = '${A}' and phone = '${p}'`), "t");
  assert.equal(sql(`select d.title || '|' || s.kind || '|' || d.source_channel from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id where c.phone = '${p}' and d.status = 'open'`), "Catálogo — Ana Paula|open|whatsapp");
  assert.equal(sql(`select wait_kind from wa_flow_runs where flow_id = '${main.id}' and phone = '${p}'`), "delay");
  await tick();
  assert.doesNotMatch(outbox(p), /Gostou/, "espera de verdade");
  due(main.id);
  await tick();
  assert.match(outbox(p), /Gostou do catálogo\?$/);
  assert.equal(sql(`select status from wa_flow_runs where flow_id = '${main.id}' and phone = '${p}'`), "completed");
  // mídia sai pelo motor com tipo e link
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(m.media_type, "image");
  assert.equal(m.media_url, "https://exemplo.com/catalogo.jpg");
  ok(await G("wa_gw_result", { p_outbox_id: m.id, p_ok: true, p_wa_message_id: `MEDIA${TAG}`, p_jid: `${p}@s.whatsapp.net` }));
  assert.equal(sql(`select content_type from whatsapp_messages where wa_message_id = 'MEDIA${TAG}'`), "image");
  await drain();
  // números por bloco
  const st = ok(await admin.rpc("wa_flow_stats", { p_flow_id: main.id }));
  assert.equal(st.nodes.m.enter, 1);
  assert.equal(st.nodes.img.sent, 1);
  assert.equal(st.runs.completed, 1);
  const runs = ok(await admin.rpc("wa_flow_runs_list", { p_flow_id: main.id }));
  assert.equal(runs[0].name, "Ana Paula");
  assert.ok(runs[0].path.some((e) => e.node === "w" && e.event === "enter"));
});

test("não repete para o mesmo contato dentro do intervalo (reentrada)", async () => {
  const p = ph(1);
  const before = outbox(p);
  await inbound(p, "preço de novo?");
  await tick();
  assert.equal(outbox(p), before);
});

test("opção 2 passa para atendente: robô para e equipe é avisada", async () => {
  const p = ph(2);
  await inbound(p, "preço", "Bruno");
  await tick();
  await inbound(p, "falar com atendente");
  await tick();
  assert.match(outbox(p), /Já chamo alguém da equipe/);
  assert.equal(sql(`select c.bot_mode from whatsapp_conversations c join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${p}'`), "human");
  assert.ok(Number(sql(`select count(*) from crm_notifications where tenant_id = '${A}' and title like 'Bruno quer falar com um atendente'`)) >= 1);
  const n = outbox(p);
  await inbound(p, "preço?");
  await tick();
  assert.equal(outbox(p), n, "conversa com atendente: nenhum robô responde");
  // devolver ao robô
  const conv = sql(`select c.id from whatsapp_conversations c join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${p}'`);
  const denied = await other.rpc("wa_conversation_bot", { p_conversation_id: conv, p_mode: "bot" });
  assert.ok(denied.error);
  ok(await seller.rpc("wa_conversation_bot", { p_conversation_id: conv, p_mode: "bot" }));
  await drain();
});

test("sem resposta no prazo: segue pelo caminho 'Não respondeu' (tarefa no CRM)", async () => {
  const p = ph(3);
  await inbound(p, "orcamento", "Carla Dias");
  await tick();
  due(main.id);
  await tick();
  assert.equal(sql(`select t.title from crm_tasks t join crm_contacts c on c.id = t.contact_id where c.phone = '${p}'`), "Ligar para Carla Dias (não respondeu o menu)");
  await drain();
});

test("atendente respondeu há pouco: robô não entra na conversa", async () => {
  const p = ph(4);
  ok(await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "Oi, aqui é a Ana", p_phone: p }));
  await drain();
  await inbound(p, "qual o preço?");
  await tick();
  assert.equal(outbox(p), "");
});

test("quem pediu SAIR não recebe nada da automação", async () => {
  const p = ph(5);
  await inbound(p, "SAIR");
  await inbound(p, "preço");
  await tick();
  assert.equal(outbox(p), "");
});

test("teste manual em rascunho: IA responde, pergunta salva variável, webhook com caminho de erro", async () => {
  const g = {
    nodes: [
      N("t", "trigger", { kind: "manual" }),
      N("q", "ask", { text: "Qual sua cidade?", saveAs: "cidade", saveTo: "cidade" }),
      N("ai", "ai_reply", { prompt: "Somos uma farmácia. Seja breve." }),
      N("wh", "webhook", { url: `http://127.0.0.1:${hookPort}/novo`, body: "cidade={var.cidade}" }),
      N("ok", "send_text", { text: "Pedido {var.webhook.pedido} registrado para {var.cidade}" }),
      N("err", "notify", { message: "Webhook falhou" }),
    ],
    edges: [E("t", "q"), E("q", "ai", "answered"), E("ai", "wh"), E("wh", "ok", "ok"), E("wh", "err", "error")],
  };
  const f = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `IA ${TAG}`, p_graph: g }));
  const notActive = await admin.rpc("wa_flow_start", { p_flow_id: f.id, p_phones: [ph(6)] });
  assert.match(notActive.error?.message ?? "", /Ative/);
  const many = await admin.rpc("wa_flow_start", { p_flow_id: f.id, p_phones: [ph(6), ph(7)], p_test: true });
  assert.match(many.error?.message ?? "", /um número/);
  const r = ok(await admin.rpc("wa_flow_start", { p_flow_id: f.id, p_phones: [ph(6)], p_test: true }));
  assert.equal(r.queued, 1);
  await tick();
  assert.equal(outbox(ph(6)), "Qual sua cidade?");
  await drain();
  await inbound(ph(6), "Campinas");
  await tick();
  assert.equal(outbox(ph(6)), "Qual sua cidade? || Resposta da IA para: Campinas || Pedido 123 registrado para Campinas");
  assert.equal(hooks.at(-1).telefone, ph(6));
  assert.equal(hooks.at(-1).variaveis.cidade, "Campinas");
  assert.equal(sql(`select city from crm_contacts where tenant_id = '${A}' and phone = '${ph(6)}'`), "Campinas");
  assert.equal(sql(`select is_test from wa_flow_runs where flow_id = '${f.id}'`), "t");
  await drain();
});

test("gatilho por etiqueta e início manual espaçado (anti-bloqueio)", async () => {
  const g = { nodes: [N("t", "trigger", { kind: "tag", tag: "Quente" }), N("s", "send_text", { text: "Oi {primeiro_nome}, separei uma condição especial!" })], edges: [E("t", "s")] };
  const f = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Etiqueta ${TAG}`, p_graph: g, p_reentry: "once" }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "active" }));
  const p = ph(8);
  const c = ok(await admin.from("crm_contacts").insert({ tenant_id: A, name: "Diego Lima", phone: p }).select("id").single());
  ok(await admin.from("crm_contacts").update({ tags: ["quente"] }).eq("id", c.id));
  await tick();
  assert.equal(outbox(p), "Oi Diego, separei uma condição especial!");
  // 'uma vez por contato': tirar e pôr a etiqueta de novo não repete
  ok(await admin.from("crm_contacts").update({ tags: [] }).eq("id", c.id));
  ok(await admin.from("crm_contacts").update({ tags: ["quente"] }).eq("id", c.id));
  await tick();
  assert.equal(outbox(p), "Oi Diego, separei uma condição especial!");

  const m = { nodes: [N("t", "trigger", { kind: "manual" }), N("s", "send_text", { text: "Olá {primeiro_nome}" })], edges: [E("t", "s")] };
  const mf = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Manual ${TAG}`, p_graph: m }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: mf.id, p_status: "active" }));
  const res = ok(await seller.rpc("wa_flow_start", { p_flow_id: mf.id, p_contact_ids: [c.id], p_phones: [ph(9), ph(5)] }));
  assert.equal(res.queued, 2);
  assert.equal(res.skipped_optout, 1, "quem pediu SAIR fica de fora");
  await tick();
  const sentNow = Number(sql(`select count(*) from wa_outbox where flow_run_id in (select id from wa_flow_runs where flow_id = '${mf.id}')`));
  assert.equal(sentNow, 1, "o segundo contato só sai depois do intervalo");
  sql(`update wa_flow_queue set not_before = now() where flow_id = '${mf.id}' and processed_at is null`);
  await tick();
  assert.equal(Number(sql(`select count(*) from wa_outbox where flow_run_id in (select id from wa_flow_runs where flow_id = '${mf.id}')`)), 2);
  await drain();
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "archived" }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: mf.id, p_status: "archived" }));
});

test("pausar segura as esperas; cancelar execução tira as mensagens da fila", async () => {
  const g = { nodes: [N("t", "trigger", { kind: "keyword", keywords: "promo" }), N("s", "send_text", { text: "Promo!" }), N("w", "wait", { amount: 5, unit: "minutes" }), N("s2", "send_text", { text: "Ainda quer?" })],
    edges: [E("t", "s"), E("s", "w"), E("w", "s2")] };
  const f = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Pausa ${TAG}`, p_graph: g, p_priority: 5 }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "active" }));
  const p = ph(10);
  await inbound(p, "tem promo?");
  await tick();
  assert.equal(outbox(p), "Promo!");
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "paused" }));
  due(f.id);
  await tick();
  assert.equal(outbox(p), "Promo!");
  assert.equal(sql(`select status from wa_flow_runs where flow_id = '${f.id}'`), "waiting");
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "active" }));
  due(f.id);
  await tick();
  assert.equal(outbox(p), "Promo! || Ainda quer?");
  await drain();
  const p2 = ph(11);
  await inbound(p2, "promo");
  await tick();
  const run = sql(`select id from wa_flow_runs where flow_id = '${f.id}' and phone = '${p2}'`);
  ok(await seller.rpc("wa_flow_cancel_run", { p_run_id: run }));
  assert.equal(sql(`select status from wa_outbox where flow_run_id = '${run}'`), "canceled");
  assert.equal(sql(`select status from wa_flow_runs where id = '${run}'`), "cancelled");
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "archived" }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: main.id, p_status: "paused" }));
});

test("webhook: outro sistema inicia a automação com dados próprios; endereço errado é recusado", async () => {
  const g = { nodes: [N("t", "trigger", { kind: "webhook" }), N("s", "send_text", { text: "Oi {primeiro_nome}! Recebemos seu pedido de {var.trigger.produto} 🙌" })], edges: [E("t", "s")] };
  const f = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Webhook ${TAG}`, p_graph: g }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "active" }));
  const denied = await seller.rpc("wa_flow_hook_secret", { p_flow_id: f.id });
  assert.ok(denied.error, "vendedor não vê o segredo");
  const secret = ok(await admin.rpc("wa_flow_hook_secret", { p_flow_id: f.id }));
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(sql(`select count(*) from wa_flow_hooks where flow_id = '${f.id}'`), "1");
  const leak = await admin.from("wa_flow_hooks").select("*");
  assert.equal((leak.data ?? []).length, 0, "tabela do segredo não aparece pela API");
  const p = ph(12);
  const url = `${URL_}/functions/v1/cro-flows/hook/${f.id}/${secret}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefone: p, nome: "Rafaela Lima", produto: "Kit Verão" }) });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(outbox(p), "Oi Rafaela! Recebemos seu pedido de Kit Verão 🙌");
  assert.equal(sql(`select name from crm_contacts where tenant_id = '${A}' and phone = '${p}'`), "Rafaela Lima");
  const bad = await fetch(`${URL_}/functions/v1/cro-flows/hook/${f.id}/${"0".repeat(64)}`, { method: "POST", body: JSON.stringify({ telefone: p }) });
  assert.equal(bad.status, 404);
  const noPhone = await fetch(url, { method: "POST", body: JSON.stringify({ nome: "x" }) });
  assert.equal(noPhone.status, 400);
  // trocar o endereço invalida o antigo
  const s2 = ok(await admin.rpc("wa_flow_hook_secret", { p_flow_id: f.id, p_rotate: true }));
  assert.notEqual(s2, secret);
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ telefone: p }) })).status, 404);
  await drain();
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: f.id, p_status: "archived" }));
});

test("atendimento em equipe: transferir conversa avisa a pessoa; concluir e reabrir quando o cliente volta", async () => {
  const p = ph(13);
  await inbound(p, "olá, preciso de ajuda", "Sérgio");
  const conv = sql(`select c.id from whatsapp_conversations c join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${p}'`);
  const sellerId = sql(`select id from auth.users where email = 'ana.vendas@clinica.local'`);
  const outsider = sql(`select id from auth.users where email = 'dona@perfumaria.local'`);
  const bad = await admin.rpc("wa_conversation_assign", { p_conversation_id: conv, p_user_id: outsider });
  assert.match(bad.error?.message ?? "", /não faz parte/);
  ok(await admin.rpc("wa_conversation_assign", { p_conversation_id: conv, p_user_id: sellerId }));
  assert.equal(sql(`select assigned_to from whatsapp_conversations where id = '${conv}'`), sellerId);
  assert.ok(Number(sql(`select count(*) from crm_notifications where user_id = '${sellerId}' and title like 'Conversa transferida para você: Sérgio%'`)) >= 1);
  ok(await seller.rpc("wa_conversation_close", { p_conversation_id: conv, p_closed: true }));
  assert.equal(sql(`select status from whatsapp_conversations where id = '${conv}'`), "archived");
  await inbound(p, "ainda estou aqui");
  assert.equal(sql(`select status from whatsapp_conversations where id = '${conv}'`), "active");
  const other2 = await other.rpc("wa_conversation_close", { p_conversation_id: conv, p_closed: true });
  assert.ok(other2.error, "outra empresa não mexe");
});

test("respostas rápidas: cada empresa vê só as suas", async () => {
  const id = ok(await seller.rpc("wa_quick_reply_save", { p_tenant_id: A, p_id: null, p_title: `Horário ${TAG}`, p_body: "Atendemos de seg a sex, 8h às 18h." }));
  const mine = ok(await seller.from("wa_quick_replies").select("id").eq("id", id));
  assert.equal(mine.length, 1);
  const theirs = ok(await other.from("wa_quick_replies").select("id").eq("id", id));
  assert.equal(theirs.length, 0);
  ok(await seller.rpc("wa_quick_reply_delete", { p_id: id }));
});

test("contato numa espera de outra automação não entra em uma nova por cima; só a mais recente responde", async () => {
  main = ok(await admin.rpc("wa_flow_set_status", { p_flow_id: main.id, p_status: "active" }));
  const promo = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Promo ${TAG}`, p_graph: {
    nodes: [N("t", "trigger", { kind: "keyword", keywords: "visita" }), N("a", "send_text", { text: "Promo do dia!" }), N("w", "wait", { amount: 1, unit: "hours" }), N("b", "send_text", { text: "Ainda quer a promo?" })],
    edges: [E("t", "a"), E("a", "w"), E("w", "b")] } }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: promo.id, p_status: "active" }));
  const p = ph(40);
  await inbound(p, "quero uma visita", "Dora");
  await tick();
  assert.equal(outbox(p), "Promo do dia!");
  await inbound(p, "e o preço?");
  await tick();
  assert.equal(outbox(p), "Promo do dia!", "não começa a automação de preço no meio da outra");
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: promo.id, p_status: "paused" }));
  sql(`update wa_flow_runs set status = 'cancelled' where flow_id = '${promo.id}'`);
  await drain();

  // duas execuções esperando resposta do mesmo contato: só a mais recente segue
  const q = ph(41);
  await inbound(q, "preço", "Eva");
  await tick();
  const runId = sql(`select id from wa_flow_runs where flow_id = '${main.id}' and phone = '${q}'`);
  const twin = ok(await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `Preço cópia ${TAG}`, p_graph: mainGraph() }));
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: twin.id, p_status: "active" }));
  const old = sql(`insert into wa_flow_runs (tenant_id, flow_id, instance_id, phone, conversation_id, status, current_node, wait_kind, state, updated_at)
    select tenant_id, '${twin.id}', instance_id, phone, conversation_id, status, current_node, wait_kind, state, now() - interval '1 hour' from wa_flow_runs where id = '${runId}' returning id`).split("\n")[0];
  await inbound(q, "1");
  await tick();
  assert.equal((outbox(q).match(/Catálogo de Eva/g) ?? []).length, 1, "o catálogo vai uma vez só");
  assert.equal(sql(`select status from wa_flow_runs where id = '${old}'`), "cancelled");
  ok(await admin.rpc("wa_flow_set_status", { p_flow_id: twin.id, p_status: "paused" }));
  await drain();
});
