// Automações da Douratto (recriadas do Kommo) de ponta a ponta pela API oficial, com a Meta simulada (11996).
// Usa a empresa "Perfumaria Aroma" como estande; stack LOCAL com flow-media, wa-cloud e cro-flows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";
import { qualificacaoGraph, sondagemGraph, STAGES } from "../../scripts/douratto/flows.mjs";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const PNID = `70${TAG}`, WABA = `80${TAG}`;
const sent = [];
let graph, B, owner, jwt, inst, pdfUrl, stages = {}, campSond, campProp, flowA, flowB;
const ph = (n) => `55649${String(91000000 + TAG * 7 + n).slice(-8)}`;
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 300)); } throw new Error("tempo esgotado"); };
const to = (p) => sent.filter((m) => m.to === p);

const cloudFn = async (body) => {
  const r = await fetch(`${URL_}/functions/v1/wa-cloud`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });
  return r.json();
};
const flush = () => cloudFn({ action: "flush", tenant_id: B });
const tick = () => fetch(`${URL_}/functions/v1/cro-flows`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" }, body: "{}" });
let msgN = 0;
const reply = (phone, payload) => fetch(`${URL_}/functions/v1/wa-cloud/webhook/${inst}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PNID }, contacts: [{ wa_id: phone, profile: { name: "Coordenação" } }],
    messages: [{ from: phone, id: `wamid.d.${TAG}.${++msgN}`, timestamp: String(Math.floor(Date.now() / 1000)), ...payload }] } }] }] }),
});
const text = (phone, body) => reply(phone, { type: "text", text: { body } });
const button = (phone, title) => reply(phone, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title } } });
const tplButton = (phone, t) => reply(phone, { type: "button", button: { text: t, payload: t } });
const settle = async (phone, n) => { await until(async () => { await flush(); return to(phone).length >= n; }); };

before(async () => {
  graph = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const p = new URL(req.url, "http://x").pathname.replace(/^\/v[\d.]+\//, "/");
      const send = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
      if (p === `/${PNID}`) return send({ display_phone_number: "+55 64 3333-0000", verified_name: "Douratto Buffet", quality_rating: "GREEN" });
      if (p === `/${WABA}/subscribed_apps`) return send({ success: true });
      if (p === `/${WABA}/message_templates`) return send({ data: [
        { name: "douratto_escolas_sondagem_2026", language: "pt_BR", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Olá! Tudo bem? 😊\nAqui é o Samuel, da Douratto Buffet, em Rio Verde." }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Já planejamos" }, { type: "QUICK_REPLY", text: "Ainda avaliando" }, { type: "QUICK_REPLY", text: "Não vamos realiza" }] }] },
        { name: "douratto_escola_proposta", language: "pt_BR", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Olá, {{1}}! Aqui é o Samuel, do Douratto Buffet, de Rio Verde, falando sobre a confraternização de encerramento do ano letivo da {{2}}." }] },
      ] });
      if (p === `/${PNID}/messages`) { const m = JSON.parse(b); sent.push(m); return send({ contacts: [{ wa_id: m.to }], messages: [{ id: `wamid.out.${TAG}.${sent.length}` }] }); }
      res.statusCode = 404; send({ error: { code: 100, message: p } });
    });
  });
  await new Promise((r) => graph.listen(11996, "127.0.0.1", r));
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const s = await owner.auth.signInWithPassword({ email: "dona@perfumaria.local", password: "Teste@12345" });
  assert.equal(s.error, null);
  jwt = s.data.session.access_token;
  // conexão oficial da "Douratto" (Meta simulada) e em uso
  sql(`update wa_flows set status = 'paused' where tenant_id = '${B}' and status = 'active'`);
  sql(`update wa_campaigns set status = 'canceled' where tenant_id = '${B}' and status in ('running','paused')`);
  const saved = await fetch(`${URL_}/functions/v1/wa-cloud`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ action: "save", tenant_id: B, phone_number_id: PNID, waba_id: WABA, access_token: "EAAG-douratto" }) }).then((r) => r.json());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  inst = saved.channel.cloud.id;
  sql(`update wa_cloud_credentials set app_secret_enc = null where instance_id = '${inst}'`);
  ok(await owner.rpc("wa_channel_set", { p_tenant_id: B, p_provider: "cloud_api" }));
});
after(async () => {
  graph?.close();
  sql(`update wa_channel_settings set active_provider = 'gateway' where tenant_id = '${B}'`);
  sql(`update wa_flows set status = 'paused' where tenant_id = '${B}' and status = 'active'`);
});

test("arquivo da apresentação enviado pelo computador vira link público que o WhatsApp baixa", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, ...new TextEncoder().encode(`Douratto ${TAG}`)]);
  const form = new FormData();
  form.append("tenant_id", B);
  form.append("file", new Blob([pdf], { type: "application/pdf" }), "Apresentação Douratto.pdf");
  const r = await fetch(`${URL_}/functions/v1/flow-media`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${jwt}` }, body: form });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.media_type, "document");
  pdfUrl = j.url;
  const back = await fetch(pdfUrl);
  assert.equal(back.headers.get("content-type"), "application/pdf");
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), pdf);
  // sem login não envia; tipo estranho é recusado
  const anon = await fetch(`${URL_}/functions/v1/flow-media`, { method: "POST", headers: { apikey: ANON }, body: form });
  assert.equal(anon.status, 401);
  const bad = new FormData(); bad.append("tenant_id", B); bad.append("file", new Blob(["x"], { type: "application/x-msdownload" }), "a.exe");
  assert.equal((await fetch(`${URL_}/functions/v1/flow-media`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${jwt}` }, body: bad })).status, 400);
});

test("funil do Kommo, público com etiqueta, disparos com modelo e automações criados", async () => {
  const pipe = sql(`insert into crm_pipelines (tenant_id, name, position) values ('${B}', 'Confraternização Fim de Ano 2026 ${TAG}', 9) returning id`).split("\n")[0];
  STAGES.forEach((st, i) => { stages[st.key] = sql(`insert into crm_stages (tenant_id, pipeline_id, name, position, probability, kind) values ('${B}', '${pipe}', '${st.name}', ${i}, 10, 'open') returning id`).split("\n")[0]; });
  const tag = `escolas-fim-de-ano-${TAG}`;
  ok(await owner.rpc("crm_contacts_tag_import", { p_tenant_id: B, p_rows: [1, 2, 3, 4, 5, 6].map((n) => ({ nome: `Escola ${n}`, telefone: ph(n) })), p_tag: tag, p_source: "kommo" }));

  await cloudFn({ action: "sync_templates", tenant_id: B });
  campSond = ok(await owner.rpc("wa_campaign_save", { p_tenant_id: B, p_id: null, p_name: `Escolas · Sondagem ${TAG}`, p_messages: ["sondagem"], p_start_hour: 0, p_end_hour: 24, p_min_delay: 15, p_max_delay: 15 }));
  ok(await owner.rpc("wa_campaign_set_template", { p_campaign_id: campSond, p_template: { name: "douratto_escolas_sondagem_2026", language: "pt_BR", params: [] } }));
  ok(await owner.rpc("wa_campaign_add_recipients", { p_campaign_id: campSond, p_source: "rows", p_rows: [{ nome: "Escola 1", telefone: ph(1) }, { nome: "Escola 2", telefone: ph(2) }] }));
  campProp = ok(await owner.rpc("wa_campaign_save", { p_tenant_id: B, p_id: null, p_name: `Escolas · Proposta ${TAG}`, p_messages: ["proposta"], p_start_hour: 0, p_end_hour: 24, p_min_delay: 15, p_max_delay: 15 }));
  ok(await owner.rpc("wa_campaign_set_template", { p_campaign_id: campProp, p_template: { name: "douratto_escola_proposta", language: "pt_BR", params: ["{primeiro_nome}", "{nome}"] } }));
  ok(await owner.rpc("wa_campaign_add_recipients", { p_campaign_id: campProp, p_source: "rows", p_rows: [3, 4, 5, 6].map((n) => ({ nome: `Escola ${n}`, telefone: ph(n) })) }));

  flowA = ok(await owner.rpc("wa_flow_save", { p_tenant_id: B, p_id: null, p_name: `Douratto - Escolas - Fim de Ano 2026 ${TAG}`, p_graph: sondagemGraph({ campaignId: campSond, pdfUrl, stages }) }));
  flowB = ok(await owner.rpc("wa_flow_save", { p_tenant_id: B, p_id: null, p_name: `FIM DE ANO - ESCOLAS ${TAG}`, p_graph: qualificacaoGraph({ campaignId: campProp, pdfUrl, stages }) }));
  ok(await owner.rpc("wa_flow_set_status", { p_flow_id: flowA.id, p_status: "active" }));
  ok(await owner.rpc("wa_flow_set_status", { p_flow_id: flowB.id, p_status: "active" }));

  for (const c of [campSond, campProp]) ok(await owner.rpc("wa_campaign_action", { p_campaign_id: c, p_action: "start" }));
  for (let i = 0; i < 8; i++) { sql(`update wa_campaigns set next_send_at = now() - interval '1 second' where id in ('${campSond}','${campProp}')`); await flush(); }
  for (const n of [1, 2]) assert.equal(to(ph(n))[0]?.template?.name, "douratto_escolas_sondagem_2026");
  for (const n of [3, 4, 5, 6]) {
    const t = to(ph(n))[0]?.template;
    assert.equal(t?.name, "douratto_escola_proposta");
    assert.deepEqual(t.components[0].parameters.map((x) => x.text), ["Escola", `Escola ${n}`]);
  }
});

test("sondagem: “Já planejamos” → botões → “Quero receber” → PDF e etapa “Apresentação enviada”", async () => {
  const p = ph(1);
  await tplButton(p, "Já planejamos");
  await settle(p, 2);
  const menu = to(p)[1];
  assert.equal(menu.type, "interactive");
  assert.match(menu.interactive.body.text, /^Que ótimo! 🎉/);
  assert.deepEqual(menu.interactive.action.buttons.map((b) => b.reply.title), ["Quero receber", "Agora não"]);
  assert.equal(sql(`select s.name from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${B}' and c.phone = '${p}' and d.status = 'open'`), "Contato feito");

  await button(p, "Quero receber");
  await settle(p, 3);
  const doc = to(p)[2];
  assert.equal(doc.type, "document");
  assert.equal(doc.document.link, pdfUrl);
  assert.match(doc.document.caption, /Segue a apresentação da Douratto Buffet/);
  await until(() => sql(`select s.name from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${B}' and c.phone = '${p}' and d.status = 'open'`) === "Apresentação enviada");
});

test("sondagem: “Não vamos realiza” → agradecimento", async () => {
  const p = ph(2);
  await tplButton(p, "Não vamos realiza");
  await settle(p, 2);
  assert.match(to(p)[1].text.body, /^Entendido! 😊/);
});

test("qualificação: “Quero ver” → PDF → nº de pessoas → data → Qualificado + tarefa de proposta", async () => {
  const p = ph(3);
  await tplButton(p, "Quero ver");
  await settle(p, 4);
  assert.match(to(p)[1].text.body, /^Perfeito! 🎉/);
  assert.equal(to(p)[2].type, "document");
  assert.match(to(p)[3].text.body, /Quantas pessoas participarão/);
  await text(p, "80");
  await settle(p, 5);
  assert.match(to(p)[4].text.body, /qual data vocês estão pensando/);
  await text(p, "12/12/2026");
  await until(() => sql(`select s.name from crm_deals d join crm_stages s on s.id = d.stage_id join crm_contacts c on c.id = d.contact_id where c.tenant_id = '${B}' and c.phone = '${p}' and d.status = 'open'`) === "Qualificado");
  assert.equal(sql(`select custom->>'numero_pessoas' || '|' || (custom->>'data_pretendida') from crm_contacts where tenant_id = '${B}' and phone = '${p}'`), "80|12/12/2026");
  assert.match(sql(`select t.title || '|' || t.description from crm_tasks t join crm_contacts c on c.id = t.contact_id where c.phone = '${p}' order by t.created_at desc limit 1`), /^Montar proposta.*Nº de pessoas/s);
});

test("SAIR exato: o CRO descadastra, encerra a automação e manda a confirmação (como o Kommo)", async () => {
  const p = ph(4);
  await tplButton(p, "Quero ver");
  await settle(p, 4);
  await text(p, "sair");
  await settle(p, 5);
  assert.match(to(p)[4].text.body, /^Combinado! Registramos o seu pedido/);
  assert.equal(sql(`select count(*) from wa_optouts where tenant_id = '${B}' and phone = '${p}'`), "1");
  await tick();
  assert.equal(sql(`select status from wa_flow_runs where flow_id = '${flowB.id}' and phone = '${p}'`), "cancelled");
  // depois do pedido nada mais sai para ela
  assert.match((await owner.rpc("wa_send_message", { p_tenant_id: B, p_body: "oi", p_phone: p })).error?.message ?? "", /SAIR/);
  await flush();
  assert.equal(to(p).length, 5, "só a confirmação");
});

test("“pode parar de mandar”: a automação confirma, marca opt-out, cria tarefa e descadastra", async () => {
  const p = ph(6);
  await tplButton(p, "Quero ver");
  await settle(p, 4);
  await text(p, "Pode parar de mandar, obrigado");
  await settle(p, 5);
  assert.match(to(p)[4].text.body, /^Combinado! Registramos o seu pedido/);
  await until(() => sql(`select count(*) from wa_optouts where tenant_id = '${B}' and phone = '${p}'`) === "1");
  assert.match(sql(`select tags::text from crm_contacts where tenant_id = '${B}' and phone = '${p}'`), /opt-out marketing/);
  assert.match(sql(`select title from crm_tasks t join crm_contacts c on c.id = t.contact_id where c.phone = '${p}' order by t.created_at desc limit 1`), /^Opt-out/);
  await flush();
  assert.equal(to(p).length, 5, "confirmação uma vez só");
});

test("qualificação: 24 h sem resposta → tarefa, sem insistência automática", async () => {
  const p = ph(5);
  await tplButton(p, "Quero ver");
  await settle(p, 4);
  sql(`update wa_flow_runs set resume_at = now() - interval '1 second' where flow_id = '${flowB.id}' and phone = '${p}' and status = 'waiting'`);
  await tick();
  await until(() => sql(`select count(*) from crm_tasks t join crm_contacts c on c.id = t.contact_id where c.tenant_id = '${B}' and c.phone = '${p}' and t.title like 'Escola não respondeu%'`) === "1");
  await flush();
  assert.equal(to(p).length, 4, "nenhuma mensagem extra");
});
