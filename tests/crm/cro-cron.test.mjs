// Rotinas automáticas (função cro-cron) com a Meta SIMULADA em 127.0.0.1:11996.
// Stack com META_GRAPH_BASE=http://127.0.0.1:11996
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
const TOKEN = randomBytes(32).toString("hex");
const cron = (tok) => fetch(`${URL_}/functions/v1/cro-cron`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, ...(tok ? { "x-gateway-token": tok } : {}) }, body: "{}" })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
let A, ownerId, graphCalls = 0, failGraph = false;

const graph = http.createServer((req, res) => {
  graphCalls++;
  const u = new URL(req.url, "http://x");
  if (failGraph) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Error validating access token", code: 190 } })); }
  const page = Number(u.searchParams.get("page") ?? "0");
  const day = (d) => `2026-11-0${d}`;
  const data = Array.from({ length: 3 }, (_, i) => ({ campaign_id: `c${page}${i}`, campaign_name: `Camp ${page}${i}`, spend: "10.5", impressions: "100", reach: "80", clicks: "5", date_start: day(i + 1), date_stop: day(i + 1) }));
  const body = { data, ...(page === 0 ? { paging: { next: `http://127.0.0.1:11996${u.pathname}?page=1&access_token=x` } } : {}) };
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
});

before(async () => {
  await new Promise((r) => graph.listen(11996, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  ownerId = sql(`select user_id from tenant_users where tenant_id = '${A}' and role in ('owner','admin') and status = 'active' and user_id is not null limit 1`);
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'cron')`);
  sql(`insert into tenant_meta_credentials(tenant_id, access_token, enabled, selected_ad_account_id, selected_ad_account_name, facebook_token_expires_at, last_verified_at, integration_status)
       values ('${A}', 'tok-teste', true, '123', 'Conta Teste', now() + interval '5 days', now() - interval '2 days', 'connected')
       on conflict (tenant_id) do update set access_token = 'tok-teste', enabled = true, selected_ad_account_id = '123', facebook_token_expires_at = now() + interval '5 days',
         last_verified_at = now() - interval '2 days', integration_status = 'connected', last_error = null`);
  sql(`delete from meta_campaign_insights where tenant_id = '${A}'`);
  sql(`delete from crm_notifications where tenant_id = '${A}' and (dedup_key like 'meta-%' or dedup_key like 'wa-off-%')`);
});
after(() => graph.close());

test("sem o token do motor: recusa", async () => {
  assert.equal((await cron(null)).status, 401);
  assert.equal((await cron("x".repeat(64))).status, 401);
});

test("rodada: automações do CRM, avisos e gastos da Meta (todas as páginas)", async () => {
  // WhatsApp do CRO caído há 1 hora
  sql(`insert into whatsapp_instances(tenant_id, instance_name, provider, status, desired_status, phone_number)
       values ('${A}', 'cron-${Date.now()}', 'gateway', 'disconnected', 'connected', '5511900000001')`);
  sql(`update whatsapp_instances set updated_at = now() - interval '1 hour' where tenant_id = '${A}' and provider = 'gateway'`);
  const r = await cron(TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const jobs = Object.fromEntries(r.body.results.map((x) => [x.job, x]));
  assert.ok(jobs.automacoes_crm.result.empresas >= 2);
  assert.equal(jobs.meta_gastos.result.detalhe[A], 6, "3 da 1ª página + 3 da 2ª");
  assert.equal(sql(`select count(*) from meta_campaign_insights where tenant_id = '${A}'`), "6");
  assert.equal(sql(`select integration_status || '|' || (last_verified_at > now() - interval '1 minute') from tenant_meta_credentials where tenant_id = '${A}'`), "connected|true");
  assert.match(sql(`select title from crm_notifications where tenant_id = '${A}' and user_id = '${ownerId}' and dedup_key like 'meta-exp-%'`), /Reconecte a Meta: o acesso vence em 5 dia/);
  assert.match(sql(`select title from crm_notifications where tenant_id = '${A}' and dedup_key like 'wa-off-%' limit 1`), /WhatsApp do CRO desconectado/);
  assert.equal(sql(`select count(*) from cro_jobs where last_ok`), "3");
});

test("segunda rodada na mesma hora: não repete aviso nem chama a Meta de novo", async () => {
  const before = graphCalls;
  const n1 = sql(`select count(*) from crm_notifications where tenant_id = '${A}'`);
  const r = await cron(TOKEN);
  assert.equal(r.body.ok, true);
  assert.equal(graphCalls, before, "Meta já sincronizada nas últimas 20 h");
  assert.equal(sql(`select count(*) from crm_notifications where tenant_id = '${A}'`), n1);
});

test("Meta recusa o token: marca 'precisa de atenção', avisa e não quebra as outras rotinas", async () => {
  failGraph = true;
  sql(`update tenant_meta_credentials set last_verified_at = now() - interval '2 days' where tenant_id = '${A}'`);
  const r = await cron(TOKEN);
  const jobs = Object.fromEntries(r.body.results.map((x) => [x.job, x]));
  assert.equal(jobs.automacoes_crm.ok, true);
  assert.equal(jobs.meta_gastos.result.detalhe[A], "meta_insights_failed");
  assert.equal(sql(`select integration_status from tenant_meta_credentials where tenant_id = '${A}'`), "needs_attention");
  assert.doesNotMatch(sql(`select last_error from tenant_meta_credentials where tenant_id = '${A}'`), /tok-teste/, "não grava o token no erro");
  await cron(TOKEN);
  assert.match(sql(`select title from crm_notifications where tenant_id = '${A}' and dedup_key like 'meta-err-%'`), /Meta precisa de atenção/);
  failGraph = false;
});

test("saúde do sistema na tela", async () => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email: "ana.vendas@clinica.local", password: "Teste@12345" });
  const h = (await c.rpc("cro_health", { p_tenant_id: A })).data;
  assert.ok(h.motor_visto_em);
  assert.equal(h.rotinas.automacoes_crm.ok, true);
  assert.equal(h.meta.status, "needs_attention");
  assert.ok("google_maps" in h && "whatsapp" in h);
  const other = createClient(URL_, ANON, { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: "dona@perfumaria.local", password: "Teste@12345" });
  assert.ok((await other.rpc("cro_health", { p_tenant_id: A })).error);
});
