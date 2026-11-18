// Usuários: remover o acesso de alguém à empresa (e devolver depois).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
let A, owner, seller, viewer, other, sellerId, ownerId;

const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null, r.error?.message);
  return { c, jwt: r.data.session.access_token, id: r.data.user.id };
};
const admin = (who, body) => fetch(`${URL_}/functions/v1/tenant-admin`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${who.jwt}` }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  owner = await login("dono@clinica.local");
  seller = await login("bruno.vendas@clinica.local");
  viewer = await login("leitura@clinica.local");
  other = await login("dona@perfumaria.local");
  sellerId = seller.id; ownerId = owner.id;
  sql(`update tenant_users set status = 'active' where tenant_id = '${A}'`);
});

test("dono remove o acesso de um vendedor: some na hora (CRM, empresas e dados)", async () => {
  assert.equal((await seller.c.rpc("crm_my_access", { p_tenant_id: A })).data.read, true);
  const r = await admin(owner, { action: "remove_user", tenant_id: A, user_id: sellerId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sql(`select status from tenant_users where tenant_id = '${A}' and user_id = '${sellerId}'`), "disabled");
  // a sessão que já estava aberta perde o acesso na próxima chamada
  assert.equal((await seller.c.rpc("crm_my_access", { p_tenant_id: A })).data.read, false);
  const deals = await seller.c.from("crm_deals").select("id").eq("tenant_id", A).limit(1);
  assert.equal((deals.data ?? []).length, 0);
  const boot = await admin(seller, { action: "bootstrap" });
  assert.ok(!boot.body.tenants.some((t) => t.id === A), "a empresa não aparece mais para ele");
  assert.match(sql(`select action from platform_audit_log where action = 'tenant_user.removed' order by created_at desc limit 1`), /removed/);
  // remover de novo não dá erro
  assert.equal((await admin(owner, { action: "remove_user", tenant_id: A, user_id: sellerId })).body.already_removed, true);
});

test("devolver acesso: reenviar o convite reativa", async () => {
  const r = await admin(owner, { action: "resend_invite", tenant_id: A, email: "bruno.vendas@clinica.local" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sql(`select status || ':' || role from tenant_users where tenant_id = '${A}' and user_id = '${sellerId}'`), "active:operator");
  assert.equal((await seller.c.rpc("crm_my_access", { p_tenant_id: A })).data.read, true);
});

test("proteções: não remove a si mesmo, nem o último dono; leitura e outra empresa não removem", async () => {
  assert.equal((await admin(owner, { action: "remove_user", tenant_id: A, user_id: ownerId })).status, 400);
  assert.equal((await admin(viewer, { action: "remove_user", tenant_id: A, user_id: sellerId })).status, 403);
  assert.equal((await admin(other, { action: "remove_user", tenant_id: A, user_id: sellerId })).status, 403);
  assert.equal((await admin(owner, { action: "remove_user", tenant_id: A, user_id: "00000000-0000-0000-0000-000000000000" })).status, 404);
  // outro dono pode ser removido por um dono, mas nunca o último dono ativo
  sql(`update tenant_users set role = 'owner' where tenant_id = '${A}' and user_id = '${sellerId}'`);
  const r = await admin(owner, { action: "remove_user", tenant_id: A, user_id: sellerId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sql(`update tenant_users set role = 'admin', status = 'active' where tenant_id = '${A}' and user_id = '${sellerId}'`);
  // admin (não dono) não remove dono
  const adminUser = { ...seller };
  assert.equal((await admin(adminUser, { action: "remove_user", tenant_id: A, user_id: ownerId })).status, 403);
  sql(`update tenant_users set role = 'operator', status = 'active' where tenant_id = '${A}' and user_id = '${sellerId}'`);
});
