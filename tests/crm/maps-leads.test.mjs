// Busca automática no Google Maps → discador → disparo (stack LOCAL, Google Places SIMULADO).
// Rode a stack com:  ENCRYPTION_KEY=<64 hex> PLACES_API_URL=http://127.0.0.1:11998 bash /opt/stack/start.sh
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
const TAG = Date.now() % 100000;
const KEY = `AIzaTEST${randomBytes(14).toString("hex")}`;
const fn = (token, body, extra = {}) => fetch(`${URL_}/functions/v1/maps-leads`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

// ---- Google Places simulado ----
const seenKeys = new Set();
const calls = [];
const hash = (t) => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9000, 7);
const phoneFor = (loc, i) => `(11) 9${String(1000 + ((TAG + hash(loc)) % 9000))}-${String(1000 + i).padStart(4, "0")}`;
function placesFor(text, page) {
  const loc = text.split(" em ")[1] ?? "x";
  const base = page * 20;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const n = base + i;
    out.push({
      id: `pl-${TAG}-${loc}-${n}`, displayName: { text: `Farmácia ${loc} ${n}` }, formattedAddress: `Rua ${n}, ${loc}`,
      nationalPhoneNumber: phoneFor(loc, n), rating: 4 + (n % 10) / 10, userRatingCount: 10 + n, businessStatus: "OPERATIONAL",
      googleMapsUri: `https://maps.google.com/?cid=${n}`,
      addressComponents: [
        { longText: "Centro", types: ["sublocality_level_1", "sublocality"] },
        { longText: loc.split(",")[0], types: ["administrative_area_level_2"] },
        { longText: "São Paulo", shortText: "SP", types: ["administrative_area_level_1"] },
      ],
    });
  }
  if (page === 0) {
    out.push({ id: `pl-${TAG}-${loc}-rede`, displayName: { text: "Drogasil" }, nationalPhoneNumber: "(11) 3333-1111", businessStatus: "OPERATIONAL" });
    out.push({ id: `pl-${TAG}-${loc}-fechada`, displayName: { text: "Farmácia Fechada" }, nationalPhoneNumber: "(11) 98888-0000", businessStatus: "CLOSED_PERMANENTLY" });
    out.push({ id: `pl-${TAG}-${loc}-semfone`, displayName: { text: "Farmácia Sem Fone" }, businessStatus: "OPERATIONAL" });
  }
  return { places: out, ...(page < 1 ? { nextPageToken: `p${page + 1}` } : {}) };
}
const mock = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const key = req.headers["x-goog-api-key"];
    seenKeys.add(key);
    const body = JSON.parse(b || "{}");
    calls.push(body);
    if (key === "AIzaREVOGADA00000000000000000000000") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }));
    }
    const page = body.pageToken ? Number(body.pageToken.slice(1)) : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(placesFor(body.textQuery, page)));
  });
});

let admin, seller, viewer, other, A, src, camp, TOKEN;
before(async () => {
  await new Promise((r) => mock.listen(11998, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
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
  // o disparo precisa da conexão do WhatsApp cadastrada (não depende de outro teste ter rodado antes)
  assert.equal((await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" })).error, null);
  sql(`delete from maps_usage where tenant_id = '${A}'`);
  sql(`update lead_sources set active = false where tenant_id = '${A}'`);
  TOKEN = randomBytes(32).toString("hex");
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'maps ${TAG}')`);
});
after(() => mock.close());
const tok = async (c) => (await c.auth.getSession()).data.session.access_token;

test("chave do Google: só gestor salva; fica criptografada e a tela só vê o final", async () => {
  const r1 = await fn(await tok(seller), { action: "set_key", tenant_id: A, api_key: KEY });
  assert.equal(r1.status, 403);
  const bad = await fn(await tok(admin), { action: "set_key", tenant_id: A, api_key: "123" });
  assert.equal(bad.status, 400);
  const r2 = await fn(await tok(admin), { action: "set_key", tenant_id: A, api_key: KEY });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.key_hint, KEY.slice(-4));
  const st = (await seller.rpc("maps_status", { p_tenant_id: A })).data;
  assert.equal(st.has_key, true);
  assert.equal(st.key_hint, KEY.slice(-4));
  assert.ok(!sql(`select api_key_enc from maps_settings where tenant_id = '${A}'`).includes(KEY), "não pode ficar em texto puro");
  const read = await admin.from("maps_settings").select("*");
  assert.ok(read.error || read.data.length === 0, "a tabela da chave não é legível pela API");
  assert.ok((await other.rpc("maps_status", { p_tenant_id: A })).error);
});

test("prévia: mostra posição, nota e telefone; ignora fechadas; não grava", async () => {
  const before = Number(sql(`select count(*) from crm_dial_leads where tenant_id = '${A}'`));
  const r = await fn(await tok(seller), { action: "preview", tenant_id: A, query: "farmácia", location: `Moema ${TAG}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(seenKeys.has(KEY), "usa a chave salva (descriptografada no servidor)");
  assert.equal(calls.at(-1).textQuery, `farmácia em Moema ${TAG}`);
  assert.equal(calls.at(-1).languageCode, "pt-BR");
  assert.equal(r.body.closed, 1);
  const p0 = r.body.places[0];
  assert.equal(p0.rank, 1);
  assert.equal(p0.city, "Moema " + TAG);
  assert.equal(p0.uf, "SP");
  assert.equal(p0.district, "Centro");
  assert.ok(p0.rating >= 4);
  assert.equal(Number(sql(`select count(*) from crm_dial_leads where tenant_id = '${A}'`)), before);
  assert.equal((await fn(await tok(viewer), { action: "preview", tenant_id: A, query: "x", location: "y" })).status, 403);
});

test("buscar agora: grava no discador sem duplicar, sem redes, sem quem não tem telefone, com rodízio de locais", async () => {
  // um telefone que já existe em outra lista não entra de novo
  const dupPhone = phoneFor(`Bairro A ${TAG}`, 2).replace(/\D/g, "");
  sql(`insert into crm_dial_leads(tenant_id, list_name, name, phone) values ('${A}', 'Outra ${TAG}', 'Já existe', '55${dupPhone}')`);
  const save = await seller.rpc("lead_source_save", {
    p_tenant_id: A, p_id: null, p_name: `Farmácias ${TAG}`, p_query: "farmácia",
    p_locations: [`Bairro A ${TAG}`, `Bairro B ${TAG}`, `Bairro C ${TAG}`], p_list_name: `Google Maps ${TAG}`,
    p_locations_per_run: 2, p_max_new_per_run: 100, p_pages_per_location: 2,
  });
  assert.equal(save.error, null, save.error?.message);
  src = save.data;
  const r = await fn(await tok(seller), { action: "run", source_id: src });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.error, null);
  assert.equal(r.body.api_calls, 4, "2 locais × 2 páginas");
  assert.equal(r.body.inserted, 19, "20 farmácias − 1 já existente");
  assert.equal(r.body.duplicates, 1);
  assert.equal(r.body.chains, 2);
  assert.equal(r.body.no_phone, 2);
  const row = sql(`select maps_rank || '|' || rating || '|' || reviews || '|' || city || '|' || uf || '|' || source || '|' || district
                     from crm_dial_leads where tenant_id = '${A}' and place_id = 'pl-${TAG}-Bairro A ${TAG}-0'`);
  assert.match(row, /^1\|4\.0\|10\|Bairro A \d+\|SP\|google_places\|📍 Nº 1 no Google · ⭐ 4\.0 \(10\) · Rua 0/);
  assert.equal(sql(`select count(*) from crm_dial_leads where tenant_id = '${A}' and list_name = 'Google Maps ${TAG}'`), "19");
  // 2ª execução: Bairro C e volta para o A (A já está todo no discador → só duplicados)
  const r2 = await fn(await tok(seller), { action: "run", source_id: src });
  assert.deepEqual(r2.body.error, null);
  assert.equal(r2.body.inserted, 10);
  assert.ok(calls.slice(-4).some((c) => c.textQuery.endsWith(`Bairro C ${TAG}`)));
  assert.ok(calls.slice(-4).some((c) => c.textQuery.endsWith(`Bairro A ${TAG}`)));
  assert.equal(sql(`select calls from maps_usage where tenant_id = '${A}'`), "9", "1 prévia + 8 da busca");
  const notif = sql(`select count(*) from crm_notifications where tenant_id = '${A}' and title like '%novo(s) cliente(s) do Google Maps%'`);
  assert.ok(Number(notif) >= 2);
});

test("disparo com alimentação automática: começa vazio e recebe os novos clientes da busca", async () => {
  const c = await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Auto ${TAG}`, p_messages: ["Oi {empresa}, vi vocês em {cidade} (nota {nota})."], p_start_hour: 0, p_end_hour: 24 });
  camp = c.data;
  const s1 = await seller.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "start" });
  assert.match(s1.error?.message ?? "", /alimentação automática/);
  assert.equal((await seller.rpc("wa_campaign_set_auto_feed", { p_campaign_id: camp, p_auto: true })).error, null);
  assert.equal((await seller.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "start" })).error, null);
  await seller.rpc("lead_source_save", {
    p_tenant_id: A, p_id: src, p_name: `Farmácias ${TAG}`, p_query: "farmácia",
    p_locations: [`Bairro D ${TAG}`, `Bairro A ${TAG}`, `Bairro B ${TAG}`, `Bairro C ${TAG}`], p_list_name: `Google Maps ${TAG}`,
    p_locations_per_run: 1, p_max_new_per_run: 3, p_pages_per_location: 1, p_campaign_id: camp,
  });
  const r = await fn(await tok(seller), { action: "run", source_id: src });
  assert.equal(r.body.inserted, 3, "respeita o máximo por execução");
  assert.equal(r.body.to_campaign, 3);
  // motor recebe a mensagem com as variáveis do Google
  const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
  const inst = sql(`select id from whatsapp_instances where tenant_id = '${A}' and provider = 'gateway' order by created_at limit 1`);
  sql(`update wa_campaigns set status = 'canceled' where tenant_id = '${A}' and status = 'running' and id <> '${camp}'`);
  sql(`update wa_campaigns set instance_id = '${inst}', next_send_at = now() where id = '${camp}'`);
  sql(`update wa_outbox set status = 'canceled' where instance_id = '${inst}' and status = 'queued'`);
  sql(`delete from wa_outbox where instance_id = '${inst}' and source = 'campaign' and sent_at > now() - interval '1 day'`);
  const m = (await gw.rpc("wa_gw_claim", { p_token: TOKEN, p_instance: inst })).data;
  assert.match(m.body, /^Oi Farmácia Bairro D \d+ \d+, vi vocês em Bairro D \d+ \(nota \d,\d\)\./);
  // fila zerou: continua "Enviando", esperando os próximos
  sql(`update wa_campaign_recipients set status = 'sent', sent_at = now() where campaign_id = '${camp}' and status = 'pending'`);
  await gw.rpc("wa_gw_result", { p_token: TOKEN, p_outbox_id: m.id, p_ok: true, p_wa_message_id: `MAPS${TAG}` });
  assert.equal(sql(`select status from wa_campaigns where id = '${camp}'`), "running");
});

test("automático: o motor chama a cada 10 min e só roda as fontes vencidas", async () => {
  const no = await fn(null, { action: "cron" }, { "x-gateway-token": "z".repeat(64) });
  assert.equal(no.status, 401);
  sql(`update lead_sources set auto = true, next_run_at = now() - interval '1 minute', campaign_id = null, max_new_per_run = 50 where id = '${src}'`);
  const r = await fn(null, { action: "cron" }, { "x-gateway-token": TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ran, 1);
  const next = sql(`select (next_run_at > now())::text || '|' || extract(hour from next_run_at at time zone 'America/Sao_Paulo') from lead_sources where id = '${src}'`);
  assert.equal(next, "true|7", "reagenda para a próxima vez que der 7h");
  const again = await fn(null, { action: "cron" }, { "x-gateway-token": TOKEN });
  assert.equal(again.body.ran, 0, "não roda duas vezes");
  assert.equal(sql(`select trigger from lead_source_runs where source_id = '${src}' order by started_at desc limit 1`), "auto");
});

test("custo: limite mensal bloqueia novas buscas", async () => {
  const used = Number(sql(`select calls from maps_usage where tenant_id = '${A}'`));
  assert.equal((await seller.rpc("maps_set_limit", { p_tenant_id: A, p_limit: used })).error?.message ? "x" : "", "x", "vendedor não muda limite");
  assert.equal((await admin.rpc("maps_set_limit", { p_tenant_id: A, p_limit: used })).error, null);
  const r = await fn(await tok(seller), { action: "run", source_id: src });
  assert.match(r.body.error ?? "", /Limite mensal/);
  const p = await fn(await tok(seller), { action: "preview", tenant_id: A, query: "farmácia", location: "x" });
  assert.match(p.body.error ?? "", /Limite mensal/);
  await admin.rpc("maps_set_limit", { p_tenant_id: A, p_limit: 900 });
});

test("chave inválida: mensagem clara e a execução registra o erro", async () => {
  await fn(await tok(admin), { action: "set_key", tenant_id: A, api_key: "AIzaREVOGADA00000000000000000000000" });
  const r = await fn(await tok(seller), { action: "run", source_id: src });
  assert.match(r.body.error ?? "", /Chave do Google inválida/);
  assert.match(sql(`select last_result->>'error' from lead_sources where id = '${src}'`), /inválida/);
  assert.equal(sql(`select running_since is null from lead_sources where id = '${src}'`), "t", "destrava a fonte");
  await fn(await tok(admin), { action: "set_key", tenant_id: A, api_key: KEY });
});

test("extrator do FlowZap original: 7 buscas, até 3 páginas, contatos com etiqueta e no discador", async () => {
  const before = calls.length;
  const cidade = `Campinas ${TAG}`;
  const r = await fn(await tok(seller), { action: "auto_extract", tenant_id: A, ramo: "farmácia", cidade, list_name: `FZ ${TAG}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const queries = calls.slice(before).filter((c) => !c.pageToken).map((c) => c.textQuery);
  assert.deepEqual(queries, [
    `farmácia em ${cidade}`, `farmácia ${cidade}`, `melhores farmácia em ${cidade}`, `farmácia perto de ${cidade}`,
    `farmácia centro ${cidade}`, `farmácia zona sul ${cidade}`, `farmácia zona norte ${cidade}`,
  ]);
  assert.ok(calls.slice(before).every((c) => c.languageCode === "pt-BR"));
  assert.equal(r.body.api_calls, calls.length - before);
  assert.ok(r.body.total > 0 && r.body.total <= 120);
  assert.equal(r.body.imported + r.body.duplicate + r.body.invalid + r.body.optout, r.body.total);
  const tag = `farmácia-campinas-${TAG}`;
  assert.equal(r.body.tag, tag);
  assert.equal(Number(sql(`select count(*) from crm_contacts where tenant_id = '${A}' and '${tag}' = any(tags)`)), r.body.imported + r.body.duplicate);
  // (em execuções repetidas do teste os telefones simulados já existem: aí só há duplicados, sem endereço novo)
  if (r.body.imported > 0) assert.match(sql(`select custom->>'endereco' from crm_contacts where tenant_id = '${A}' and '${tag}' = any(tags) and coalesce(custom->>'endereco', '') <> '' limit 1`), /Rua/);
  assert.equal(Number(sql(`select count(*) from crm_dial_leads where tenant_id = '${A}' and list_name = 'FZ ${TAG}'`)), r.body.to_dialer);
  // de novo: tudo já existe → só duplicados, sem criar contatos repetidos
  const r2 = await fn(await tok(seller), { action: "auto_extract", tenant_id: A, ramo: "farmácia", cidade });
  assert.equal(r2.body.imported, 0);
  assert.equal(r2.body.duplicate, r.body.imported + r.body.duplicate);
  assert.equal(sql(`select count(*) from lead_extractions where tenant_id = '${A}' and source = 'auto:farmácia:${cidade}'`), "2");
  const v = await fn(await tok(viewer), { action: "auto_extract", tenant_id: A, ramo: "farmácia", cidade });
  assert.equal(v.status, 403);
});

test("isolamento: outra empresa não vê nem roda as buscas", async () => {
  assert.equal((await other.from("lead_sources").select("id").eq("tenant_id", A)).data.length, 0);
  const r = await fn(await tok(other), { action: "run", source_id: src });
  assert.equal(r.status, 403);
  assert.ok((await other.rpc("lead_source_delete", { p_id: src })).error);
});
