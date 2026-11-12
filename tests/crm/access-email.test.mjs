// E-mails de acesso pelo Resend (convite, reenviar, link de acesso, nova senha).
// Stack LOCAL iniciada com RESEND_API_KEY=re_teste RESEND_API_URL=http://127.0.0.1:11995 APP_URL=http://127.0.0.1:5173
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
const mails = [];
let resend, A, B, ownerA, ownerB, seller;

const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null, r.error?.message);
  return r.data.session.access_token;
};
const admin = async (jwt, body) => {
  const r = await fetch(`${URL_}/functions/v1/tenant-admin`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const authEmail = (body, ip = "10.0.0.1") => fetch(`${URL_}/functions/v1/auth-email`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, "x-forwarded-for": ip }, body: JSON.stringify(body) });
const linkOf = (m) => m.text.match(/(https?:\/\/\S+verify\S+)/)?.[1];
const follow = async (url) => {
  const r = await fetch(url, { redirect: "manual" });
  return r.headers.get("location") ?? "";
};

before(async () => {
  resend = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== "Bearer re_teste") { res.statusCode = 401; return res.end(JSON.stringify({ message: "API key is invalid" })); }
      const m = JSON.parse(b);
      if (m.to[0].includes("falha")) { res.statusCode = 403; return res.end(JSON.stringify({ name: "validation_error", message: "The domain is not verified. Please, add and verify your domain." })); }
      mails.push(m);
      res.end(JSON.stringify({ id: `email_${mails.length}` }));
    });
  });
  await new Promise((r) => resend.listen(11995, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  ownerA = await login("dono@clinica.local");
  ownerB = await login("dona@perfumaria.local");
  seller = await login("ana.vendas@clinica.local");
  sql(`delete from auth_email_requests`);
});
after(() => resend?.close());

test("convite de pessoa nova: cria o acesso e manda o e-mail com o link que funciona", async () => {
  const email = `novo${TAG}@exemplo.com`;
  const r = await admin(ownerA, { action: "invite_user", tenant_id: A, email, role: "operator" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.email_sent, r.body.already_active], [true, true, false]);
  const m = mails.find((x) => x.to[0] === email);
  assert.ok(m, "e-mail não saiu");
  assert.match(m.subject, /Clínica Sorriso/);
  assert.match(m.html, /Aceitar convite e criar senha/);
  assert.match(m.html, /vendedor\(a\)/);
  assert.equal(sql(`select role || '|' || status from tenant_users where tenant_id = '${A}' and email = '${email}'`), "operator|active");
  assert.equal(sql(`select status || '|' || email_status || '|' || (email_sent_at is not null) from tenant_invites where tenant_id = '${A}' and email = '${email}'`), "sent|sent|true");
  // o link entra no app já logado (token de acesso no redirecionamento)
  const loc = await follow(linkOf(m));
  assert.match(loc, /^http:\/\/127\.0\.0\.1:5173\/.*access_token=/);
});

test("quem já tem conta em outra empresa é adicionado e avisado (antes dava erro)", async () => {
  const before = mails.length;
  const r = await admin(ownerB, { action: "invite_user", tenant_id: B, email: "ana.vendas@clinica.local", role: "viewer" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.email_sent, true);
  const m = mails.slice(before).find((x) => x.to[0] === "ana.vendas@clinica.local");
  assert.match(m.subject, /Perfumaria Aroma/);
  assert.match(m.html, /mais uma empresa/);
  assert.equal(sql(`select role from tenant_users where tenant_id = '${B}' and email = 'ana.vendas@clinica.local'`), "viewer");
});

test("reenviar acesso e convite para quem já tem acesso também avisam por e-mail", async () => {
  const email = `novo${TAG}@exemplo.com`;
  const before = mails.length;
  const r = await admin(ownerA, { action: "resend_invite", tenant_id: A, email });
  assert.equal(r.body.email_sent, true, JSON.stringify(r.body));
  const again = await admin(ownerA, { action: "invite_user", tenant_id: A, email, role: "operator" });
  assert.deepEqual([again.body.already_active, again.body.email_sent], [true, true]);
  assert.equal(mails.length, before + 2);
  const missing = await admin(ownerA, { action: "resend_invite", tenant_id: A, email: `ninguem${TAG}@exemplo.com` });
  assert.equal(missing.status, 404);
});

test("falha do Resend: acesso liberado, aviso claro e situação gravada", async () => {
  const email = `falha${TAG}@exemplo.com`;
  const r = await admin(ownerA, { action: "invite_user", tenant_id: A, email, role: "viewer" });
  assert.equal(r.status, 200);
  assert.equal(r.body.email_sent, false);
  assert.match(r.body.email_error, /domínio do remetente não está verificado/);
  assert.equal(sql(`select status from tenant_users where tenant_id = '${A}' and email = '${email}'`), "active");
  assert.match(sql(`select email_status || '|' || email_error from tenant_invites where tenant_id = '${A}' and email = '${email}'`), /^failed\|O domínio/);
});

test("permissões: vendedor não convida; e-mail inválido é recusado", async () => {
  assert.equal((await admin(seller, { action: "invite_user", tenant_id: A, email: `x${TAG}@exemplo.com`, role: "viewer" })).status, 403);
  assert.equal((await admin(ownerA, { action: "invite_user", tenant_id: A, email: "sem-arroba", role: "viewer" })).status, 400);
});

test("tela de login: link de acesso e nova senha só para quem tem conta, sem revelar quem tem", async () => {
  sql(`delete from auth_email_requests`);
  let before = mails.length;
  const ok1 = await authEmail({ action: "link", email: "dono@clinica.local" });
  assert.equal(ok1.status, 200);
  const m = mails.slice(before).find((x) => x.to[0] === "dono@clinica.local");
  assert.match(m.subject, /link de acesso/);
  assert.match(await follow(linkOf(m)), /access_token=/);

  before = mails.length;
  const ghost = await authEmail({ action: "link", email: `fantasma${TAG}@exemplo.com` });
  assert.equal(ghost.status, 200, "mesma resposta para quem não tem conta");
  assert.equal(mails.length, before);

  const rec = await authEmail({ action: "recovery", email: "dono@clinica.local" });
  assert.equal(rec.status, 200);
  const rm = mails.at(-1);
  assert.match(rm.subject, /nova senha/);
  const loc = await follow(linkOf(rm));
  assert.match(loc, /senha=nova/);
  assert.match(loc, /type=recovery/);

  assert.equal((await authEmail({ action: "link", email: "x" })).status, 400);
});

test("limite de pedidos: 3 por e-mail por hora e 10 por origem", async () => {
  sql(`delete from auth_email_requests`);
  const email = "dona@perfumaria.local";
  for (let i = 0; i < 3; i++) assert.equal((await authEmail({ action: "link", email }, "10.0.0.2")).status, 200);
  const blocked = await authEmail({ action: "link", email }, "10.0.0.3");
  assert.equal(blocked.status, 429);
  for (let i = 0; i < 10; i++) await authEmail({ action: "link", email: `outro${i}${TAG}@exemplo.com` }, "10.0.0.9");
  assert.equal((await authEmail({ action: "link", email: `mais${TAG}@exemplo.com` }, "10.0.0.9")).status, 429);
  assert.match(sql(`select email_hash from auth_email_requests limit 1`), /^[0-9a-f]{64}$/, "guarda só o hash");
});
