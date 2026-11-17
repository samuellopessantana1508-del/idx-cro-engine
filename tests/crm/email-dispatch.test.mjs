// Disparos de e-mail (aba Disparos): só e-mail ou junto com WhatsApp, envio pelo Resend (simulado).
// Stack LOCAL iniciada com RESEND_API_KEY=re_teste RESEND_API_URL=http://127.0.0.1:11995 RESEND_FROM="IDX CRO <acesso@exemplo.com>"
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 1000000;
const mails = [];
let resend, A, owner, viewer, other;

const client = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null, r.error?.message);
  return { c, jwt: r.data.session.access_token };
};
const tick = (auth = `Bearer ${SERVICE}`, action = "tick") => fetch(`${URL_}/functions/v1/email-dispatch`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: auth }, body: JSON.stringify({ action }),
});
const save = (c, p) => c.rpc("email_campaign_save", {
  p_tenant_id: A, p_id: null, p_name: `E-mail ${TAG}`, p_subject: "Oferta para {empresa}", p_body: "Olá, {nome}!\n\nVeja nossa proposta para {cidade}: https://exemplo.com/oferta",
  p_reply_to: "Vendas@Clinica.local", p_button_label: "Ver apresentação", p_button_url: "https://exemplo.com/apresentacao.pdf", p_per_minute: 20, p_daily_limit: 500, ...p,
});

before(async () => {
  resend = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const m = JSON.parse(b);
      if (m.to[0].startsWith("recusado")) { res.statusCode = 422; return res.end(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" })); }
      mails.push(m);
      res.end(JSON.stringify({ id: `email_${mails.length}` }));
    });
  });
  await new Promise((r) => resend.listen(11995, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  owner = await client("dono@clinica.local");
  viewer = await client("leitura@clinica.local");
  other = await client("dona@perfumaria.local");
  sql(`update email_campaigns set status = 'canceled' where status = 'running'`);
});
after(() => resend?.close());

test("só e-mail: público colado, envio com remetente da empresa, variáveis, botão e descadastro", async () => {
  const { data: id, error } = await save(owner.c, {});
  assert.equal(error, null, error?.message);
  const add = await owner.c.rpc("email_campaign_add_recipients", { p_campaign_id: id, p_source: "rows", p_rows: [
    { email: `Joao${TAG}@Exemplo.com`, nome: "João Silva", empresa: "Farmácia Bem", cidade: "Campinas" },
    { email: `joao${TAG}@exemplo.com`, nome: "Repetido" },
    { email: "não-é-email", nome: "Inválido" },
    { email: `maria${TAG}@exemplo.com`, nome: "Maria" },
  ] });
  assert.equal(add.error, null, add.error?.message);
  assert.deepEqual([add.data.added, add.data.total, add.data.invalid_email, add.data.duplicates], [2, 2, 1, 1]);

  // não envia antes de iniciar
  await (await tick()).json();
  assert.equal(mails.filter((m) => m.to[0].includes(String(TAG))).length, 0);

  assert.equal((await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "start" })).error, null);
  const r = await (await tick()).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = mails.find((x) => x.to[0] === `joao${TAG}@exemplo.com`);
  assert.ok(m, "e-mail enviado");
  assert.equal(m.subject, "Oferta para Farmácia Bem");
  assert.match(m.from, /^Clínica Sorriso <disparos@exemplo\.com>$/);
  assert.equal(m.reply_to, "vendas@clinica.local");
  assert.match(m.text, /Olá, João Silva!/);
  assert.match(m.text, /proposta para Campinas/);
  assert.match(m.html, /href="https:\/\/exemplo\.com\/apresentacao\.pdf"/);
  assert.match(m.html, /Ver apresentação/);
  const unsub = m.headers["List-Unsubscribe"].slice(1, -1);
  assert.match(unsub, /\/functions\/v1\/email-dispatch\/sair\?t=[0-9a-f-]{36}$/);
  assert.ok(m.html.includes(unsub), "link de descadastro no rodapé");

  const list = (await owner.c.rpc("email_campaign_list", { p_tenant_id: A })).data.find((c) => c.id === id);
  assert.deepEqual([list.status, list.sent, list.pending], ["completed", 2, 0]);

  // descadastro pelo link: página de confirmação e a pessoa não entra mais
  const page = await fetch(unsub);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /descadastrado/);
  assert.equal(sql(`select count(*) from email_optouts where tenant_id = '${A}' and email = 'joao${TAG}@exemplo.com'`), "1");
  const { data: id2 } = await save(owner.c, { p_name: `Segundo ${TAG}` });
  const add2 = await owner.c.rpc("email_campaign_add_recipients", { p_campaign_id: id2, p_source: "rows", p_rows: [{ email: `joao${TAG}@exemplo.com` }] });
  assert.equal(add2.data.opted_out, 1);
  assert.equal(sql(`select status from email_campaign_recipients where campaign_id = '${id2}'`), "opted_out");
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id2, p_action: "archive" });
});

test("para uma pessoa só, histórico no contato e e-mail recusado vira inválido", async () => {
  const contact = sql(`insert into crm_contacts (tenant_id, name, email) values ('${A}', 'Contato ${TAG}', 'contato${TAG}@exemplo.com') returning id`).split("\n")[0];
  const { data: id } = await save(owner.c, { p_name: `Uma pessoa ${TAG}` });
  await owner.c.rpc("email_campaign_add_recipients", { p_campaign_id: id, p_source: "rows", p_rows: [{ email: `contato${TAG}@exemplo.com` }, { email: `recusado${TAG}@exemplo.com` }] });
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "start" });
  // o usuário logado pode pedir o envio na hora
  const r = await tick(`Bearer ${owner.jwt}`, "kick");
  assert.equal(r.status, 200);
  assert.equal(sql(`select string_agg(status, ',' order by email) from email_campaign_recipients where campaign_id = '${id}'`), "sent,invalid");
  assert.match(sql(`select title from crm_timeline where contact_id = '${contact}' and kind = 'email_log'`), /E-mail enviado: Oferta para Contato/);
});

test("limite por minuto segura o resto para a próxima volta", async () => {
  const { data: id } = await save(owner.c, { p_name: `Limite ${TAG}`, p_per_minute: 2 });
  await owner.c.rpc("email_campaign_add_recipients", { p_campaign_id: id, p_source: "rows",
    p_rows: Array.from({ length: 5 }, (_, i) => ({ email: `lote${i}.${TAG}@exemplo.com` })) });
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "start" });
  await tick();
  assert.equal(sql(`select count(*) from email_campaign_recipients where campaign_id = '${id}' and status = 'sent'`), "2");
  assert.equal(sql(`select status from email_campaigns where id = '${id}'`), "running");
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "cancel" });
  await tick();
  assert.equal(sql(`select count(*) from email_campaign_recipients where campaign_id = '${id}' and status = 'sent'`), "2", "cancelado não envia mais");
});

test("junto com WhatsApp: o e-mail pega os mesmos contatos do disparo (e-mail do contato ou da planilha)", async () => {
  const contact = sql(`insert into crm_contacts (tenant_id, name, phone, email) values ('${A}', 'Escola ${TAG}', '+5511977${String(TAG).padStart(6, "0")}', 'escola${TAG}@exemplo.com') returning id`).split("\n")[0];
  const { data: wa, error } = await owner.c.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `WA ${TAG}`, p_messages: ["Oi {nome}"] });
  assert.equal(error, null, error?.message);
  await owner.c.rpc("wa_campaign_add_recipients", { p_campaign_id: wa, p_source: "contacts", p_contact_ids: [contact] });
  await owner.c.rpc("wa_campaign_add_recipients", { p_campaign_id: wa, p_source: "rows",
    p_rows: [{ nome: "Agro Planilha", telefone: `+5564988${String(TAG).padStart(6, "0")}`, email: `agro${TAG}@exemplo.com` },
             { nome: "Sem e-mail", telefone: `+5564977${String(TAG).padStart(6, "0")}` }] });
  const { data: id } = await save(owner.c, { p_name: `Junto ${TAG}`, p_wa_campaign_id: wa });
  const add = await owner.c.rpc("email_campaign_add_recipients", { p_campaign_id: id, p_source: "wa_campaign" });
  assert.equal(add.error, null, add.error?.message);
  assert.equal(add.data.added, 2);
  assert.equal(sql(`select string_agg(email, ',' order by email) from email_campaign_recipients where campaign_id = '${id}'`),
    `agro${TAG}@exemplo.com,escola${TAG}@exemplo.com`);
  const list = (await owner.c.rpc("email_campaign_list", { p_tenant_id: A })).data.find((c) => c.id === id);
  assert.equal(list.wa_campaign_id, wa);
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "archive" });
});

test("permissões e validações", async () => {
  assert.ok((await save(viewer.c, {})).error, "leitura não cria disparo");
  assert.ok((await save(other.c, {})).error, "outra empresa não cria");
  assert.ok((await save(owner.c, { p_subject: " " })).error, "assunto obrigatório");
  assert.ok((await save(owner.c, { p_button_url: "http://inseguro.com" })).error, "botão só https");
  assert.ok((await save(owner.c, { p_reply_to: "nao-e-email" })).error, "resposta inválida");
  const { data: id } = await save(owner.c, { p_name: `Perm ${TAG}` });
  assert.ok((await other.c.rpc("email_campaign_add_recipients", { p_campaign_id: id, p_source: "rows", p_rows: [{ email: "x@y.com" }] })).error);
  assert.ok((await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "start" })).error, "sem público não inicia");
  assert.equal((await tick(`Bearer ${ANON}`)).status, 401, "anônimo não dispara a fila");
  assert.equal((await tick(`Bearer ${owner.jwt}`, "tick")).status, 401, "usuário só pode pedir kick");
  assert.ok((await owner.c.rpc("email_claim", { p_limit: 5 })).error, "fila só para o servidor");
  assert.ok((await owner.c.rpc("email_unsubscribe", { p_token: id })).error, "descadastro só pelo link");
  const bad = await fetch(`${URL_}/functions/v1/email-dispatch/sair?t=00000000-0000-0000-0000-000000000000`);
  assert.match(await bad.text(), /Link inválido/);
  await owner.c.rpc("email_campaign_action", { p_campaign_id: id, p_action: "archive" });
});
