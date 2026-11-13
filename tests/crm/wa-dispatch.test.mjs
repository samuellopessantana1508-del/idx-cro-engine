// Disparos + motor único de WhatsApp (stack LOCAL). Simula o motor (gateway) chamando as funções wa_gw_*.
import { test, before } from "node:test";
import assert from "node:assert/strict";
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
const ph = (n) => `55119${String(70000000 + TAG * 10 + n).slice(-8)}`;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
let admin, seller, viewer, other, A, B, inst, camp, adminId;

const hourNow = () => Number(sql(`select extract(hour from now() at time zone 'America/Sao_Paulo')::int`));
const due = (id) => sql(`update wa_campaigns set next_send_at = now() - interval '1 second' where id = '${id}'`);

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
  adminId = sql(`select id from auth.users where email = 'dono@clinica.local'`);
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  viewer = await login("leitura@clinica.local");
  other = await login("dona@perfumaria.local");
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'teste ${TAG}')`);
  // isolamento: cada execução começa sem disparos ativos na conexão de teste
  sql(`update wa_campaigns set status = 'canceled' where status = 'running'`);
  sql(`update wa_outbox set status = 'canceled' where status = 'queued'`);
  sql(`update wa_flows set status = 'paused' where status = 'active'`);
});

test("motor sem token (ou com token errado) é recusado", async () => {
  const r1 = await gw.rpc("wa_gw_instances", { p_token: "x".repeat(40) });
  assert.match(r1.error?.message ?? "", /gateway_unauthorized/);
  const r2 = await seller.rpc("wa_gw_claim", { p_token: "y".repeat(64), p_instance: A });
  assert.ok(r2.error, "usuário logado também não pode usar funções do motor sem token");
});

test("conectar: só gestor; cria conexão 'gateway' e o motor enxerga", async () => {
  const denied = await seller.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" });
  assert.match(denied.error?.message ?? "", /administradores/);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
  assert.equal(inst.provider, "gateway");
  assert.equal(inst.desired_status, "connected");
  assert.equal(inst.api_key_hash, null);
  const list = ok(await G("wa_gw_instances", {}));
  assert.ok(list.some((i) => i.id === inst.id && i.desired_status === "connected"));
  // QR e conexão chegam à tela
  ok(await G("wa_gw_instance_update", { p_instance: inst.id, p_status: "connecting", p_qr: "data:image/png;base64,QR" }));
  assert.equal(ok(await seller.rpc("wa_gateway_instance", { p_tenant_id: A })).qr_code_data, "data:image/png;base64,QR");
  ok(await G("wa_gw_instance_update", { p_instance: inst.id, p_status: "connected", p_phone: "5511900000001" }));
  const now = ok(await seller.rpc("wa_gateway_instance", { p_tenant_id: A }));
  assert.equal(now.status, "connected");
  assert.equal(now.qr_code_data, null);
  // outra empresa não vê
  const x = await other.rpc("wa_gateway_instance", { p_tenant_id: A });
  assert.ok(x.error);
});

test("campanha: validações de segurança (intervalo, limite, mensagens)", async () => {
  const bad1 = await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: "X", p_messages: ["oi"], p_min_delay: 5 });
  assert.match(bad1.error?.message ?? "", /15 segundos/);
  const bad2 = await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: "X", p_messages: ["oi"], p_daily_limit: 900 });
  assert.ok(bad2.error);
  const bad3 = await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: "X", p_messages: ["  "] });
  assert.match(bad3.error?.message ?? "", /mensagem/);
  const ro = await viewer.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: "X", p_messages: ["oi"] });
  assert.ok(ro.error, "somente leitura não cria disparo");
});

test("público: lista do discador, linhas coladas, duplicados, inválidos e SAIR", async () => {
  camp = ok(await seller.rpc("wa_campaign_save", {
    p_tenant_id: A, p_id: null, p_name: `Farmácias ${TAG}`,
    p_messages: ["{Olá|Oi} {primeiro_nome}, tudo bem? Vi a {empresa} em {cidade}."],
    p_start_hour: 0, p_end_hour: 24,
  }));
  sql(`insert into crm_dial_leads(tenant_id, list_name, name, phone, city, uf) values
       ('${A}', 'WA ${TAG}', 'Drogaria Alfa', '${ph(1)}', 'Campinas', 'SP'),
       ('${A}', 'WA ${TAG}', 'Farmácia Beta', '${ph(2)}', 'Santos', 'SP'),
       ('${A}', 'WA ${TAG}', 'Farmácia Gama', '${ph(3)}', 'Curitiba', 'PR')`);
  sql(`update crm_dial_leads set outcome = 'not_interested' where tenant_id = '${A}' and phone = '${ph(3)}'`);
  sql(`insert into wa_optouts(tenant_id, phone) values ('${A}', '${ph(2)}') on conflict do nothing`);
  const r = ok(await seller.rpc("wa_campaign_add_recipients", { p_campaign_id: camp, p_source: "dial_list", p_list_name: `WA ${TAG}` }));
  assert.equal(r.added, 2, "não-interessado fica de fora");
  assert.equal(r.opted_out, 1);
  const r2 = ok(await seller.rpc("wa_campaign_add_recipients", {
    p_campaign_id: camp, p_source: "rows",
    p_rows: [{ nome: "Carlos Lima", telefone: `(11) 9${ph(4).slice(-8, -4)}-${ph(4).slice(-4)}`, cidade: "São Paulo" },
             { nome: "Repetido", telefone: ph(1) }, { nome: "Sem número", telefone: "123" }],
  }));
  assert.equal(r2.added, 1);
  assert.equal(r2.invalid_phone, 1);
  assert.equal(r2.duplicates, 1);
  const [row] = ok(await seller.rpc("wa_campaign_list", { p_tenant_id: A })).filter((c) => c.id === camp);
  assert.equal(Number(row.total), 3);
  assert.equal(Number(row.pending), 2);
  assert.equal(Number(row.opted_out), 1);
  assert.equal(row.status, "draft");
});

test("nada sai antes de clicar em Iniciar", async () => {
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
});

test("iniciar → motor recebe mensagem personalizada com rodapé SAIR; intervalo é respeitado", async () => {
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "start" }));
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(m.source, "campaign");
  assert.equal(m.phone, ph(1));
  assert.match(m.body, /^(Olá|Oi) Drogaria, tudo bem\? Vi a Drogaria Alfa em Campinas\./);
  assert.match(m.body, /responda SAIR\.$/);
  assert.doesNotMatch(m.body, /[{}]/);
  // logo em seguida: aguarda o intervalo aleatório (25–60 s)
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
  const wait = Number(sql(`select extract(epoch from next_send_at - now()) from wa_campaigns where id = '${camp}'`));
  assert.ok(wait > 20 && wait <= 61, `intervalo ${wait}s`);
  // envio confirmado → aparece na caixa de entrada do CRO como saída
  ok(await G("wa_gw_result", { p_outbox_id: m.id, p_ok: true, p_wa_message_id: `WAMSG${TAG}A`, p_jid: `${ph(1)}@s.whatsapp.net` }));
  assert.equal(sql(`select status from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(1)}'`), "sent");
  assert.equal(sql(`select direction || '|' || status from whatsapp_messages where wa_message_id = 'WAMSG${TAG}A'`), "outbound|sent");
  // o mesmo evento chegando de novo pelo WhatsApp (eco) não duplica
  const dup = ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: true, wa_id: ph(1), phone: ph(1), body: m.body, wa_message_id: `WAMSG${TAG}A` } }));
  assert.equal(dup.duplicate, true);
  ok(await G("wa_gw_status", { p_instance: inst.id, p_wa_message_id: `WAMSG${TAG}A`, p_status: "read" }));
  ok(await G("wa_gw_status", { p_instance: inst.id, p_wa_message_id: `WAMSG${TAG}A`, p_status: "delivered" }));
  assert.equal(sql(`select status from whatsapp_messages where wa_message_id = 'WAMSG${TAG}A'`), "read", "status não volta atrás");
});

test("resposta do cliente: marca 'respondeu', avisa quem disparou e cai na mesma conversa", async () => {
  const before = Number(sql(`select count(*) from crm_notifications where tenant_id = '${A}' and title like '%respondeu ao disparo%'`));
  // WhatsApp entrega o número sem o 9º dígito
  const no9 = ph(1).slice(0, 4) + ph(1).slice(5);
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: ph(1), phone: no9, push_name: "Drogaria Alfa", body: "Oi, quanto custa?", wa_message_id: `WAMSG${TAG}R` } }));
  assert.notEqual(sql(`select replied_at from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(1)}'`), "");
  const after = Number(sql(`select count(*) from crm_notifications where tenant_id = '${A}' and title like '%respondeu ao disparo%'`));
  assert.equal(after, before + 1);
  assert.equal(sql(`select count(distinct conversation_id) from whatsapp_messages where wa_message_id in ('WAMSG${TAG}A', 'WAMSG${TAG}R')`), "1");
  assert.equal(sql(`select unread_count from whatsapp_conversations c join whatsapp_messages m on m.conversation_id = c.id where m.wa_message_id = 'WAMSG${TAG}R'`), "1");
});

test("resposta manual da caixa de entrada tem prioridade e respeita SAIR", async () => {
  const conv = sql(`select conversation_id from whatsapp_messages where wa_message_id = 'WAMSG${TAG}R'`);
  const id = ok(await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "Olá! Te mando a tabela.", p_conversation_id: conv }));
  due(camp);
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(m.id, id);
  assert.equal(m.source, "manual");
  assert.equal(m.body, "Olá! Te mando a tabela.", "resposta manual não leva rodapé");
  // falha de conexão: volta para a fila
  ok(await G("wa_gw_result", { p_outbox_id: id, p_ok: false, p_error: "Connection Closed", p_retry: true }));
  assert.equal(sql(`select status from wa_outbox where id = '${id}'`), "queued");
  const again = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(again.id, id);
  ok(await G("wa_gw_result", { p_outbox_id: id, p_ok: true, p_wa_message_id: `WAMSG${TAG}M`, p_jid: `${ph(1)}@s.whatsapp.net` }));
  assert.equal(sql(`select status from wa_outbox where id = '${id}'`), "sent");
  // viewer não envia
  assert.ok((await viewer.rpc("wa_send_message", { p_tenant_id: A, p_body: "x", p_phone: ph(1) })).error);
});

test("SAIR: descadastra, tira da fila e bloqueia envios futuros", async () => {
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: ph(4), phone: ph(4), body: " Sair! ", wa_message_id: `WAMSG${TAG}S` } }));
  assert.equal(sql(`select count(*) from wa_optouts where tenant_id = '${A}' and phone = '${ph(4)}'`), "1");
  assert.equal(sql(`select status from wa_campaign_recipients where campaign_id = '${camp}' and phone = '${ph(4)}'`), "opted_out");
  const r = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "oi", p_phone: ph(4) });
  assert.match(r.error?.message ?? "", /SAIR/);
  // a única mensagem que ainda sai é a confirmação do SAIR
  const confirm = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.match(confirm.body, /^Combinado! Registramos o seu pedido/);
  assert.equal(confirm.phone, ph(4));
  ok(await G("wa_gw_result", { p_outbox_id: confirm.id, p_ok: true, p_wa_message_id: `CONF${TAG}` }));
  // sem pendentes → disparo termina sozinho
  due(camp);
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
  assert.equal(sql(`select status from wa_campaigns where id = '${camp}'`), "completed");
  // vendedor não pode reativar; gestor pode
  assert.ok((await seller.rpc("wa_optout_set", { p_tenant_id: A, p_phone: ph(4), p_optout: false })).error);
});

test("horário: fora da janela não envia e reagenda para a abertura", async () => {
  const h = hourNow();
  const start = (h + 2) % 24 === 0 ? 1 : (h + 2) % 24;
  const c2 = ok(await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Janela ${TAG}`, p_messages: ["Oi {nome}"],
    p_start_hour: Math.min(start, 22), p_end_hour: Math.min(start, 22) + 1 }));
  ok(await seller.rpc("wa_campaign_add_recipients", { p_campaign_id: c2, p_source: "rows", p_rows: [{ nome: "Teste", telefone: ph(5) }] }));
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c2, p_action: "start" }));
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
  const nextHour = Number(sql(`select extract(hour from next_send_at at time zone 'America/Sao_Paulo') from wa_campaigns where id = '${c2}'`));
  assert.equal(nextHour, Math.min(start, 22));
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c2, p_action: "cancel" }));
  assert.equal(sql(`select status from wa_campaign_recipients where campaign_id = '${c2}'`), "skipped");
});

test("limite diário por número: atingiu, só volta amanhã", async () => {
  const c3 = ok(await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `Limite ${TAG}`, p_messages: ["Oi {nome}"],
    p_daily_limit: 1, p_start_hour: 0, p_end_hour: 24 }));
  ok(await seller.rpc("wa_campaign_add_recipients", { p_campaign_id: c3, p_source: "rows", p_rows: [{ nome: "Um", telefone: ph(6) }, { nome: "Dois", telefone: ph(7) }] }));
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c3, p_action: "start" }));
  // já houve 1 envio de campanha hoje neste número (teste anterior) → bloqueado
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
  const next = sql(`select (next_send_at at time zone 'America/Sao_Paulo')::date > (now() at time zone 'America/Sao_Paulo')::date from wa_campaigns where id = '${c3}'`);
  assert.equal(next, "t");
  // pausa / editar / retomar
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c3, p_action: "pause" }));
  ok(await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: c3, p_name: `Limite ${TAG}`, p_messages: ["Oi {nome}", "Olá {nome}"], p_daily_limit: 300, p_start_hour: 0, p_end_hour: 24 }));
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c3, p_action: "resume" }));
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.match(m.body, /^(Oi|Olá) (Um|Dois)/);
  // número inexistente no WhatsApp
  ok(await G("wa_gw_result", { p_outbox_id: m.id, p_ok: false, p_error: "Número sem WhatsApp", p_invalid: true }));
  assert.equal(sql(`select status from wa_campaign_recipients where outbox_id = '${m.id}'`), "invalid");
  ok(await seller.rpc("wa_campaign_action", { p_campaign_id: c3, p_action: "cancel" }));
});

test("motor caiu no meio do envio: marca como interrompido, não reenvia", async () => {
  const id = ok(await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "teste queda", p_phone: ph(8) }));
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(m.id, id);
  sql(`update wa_outbox set claimed_at = now() - interval '5 minutes' where id = '${id}'`);
  assert.equal(ok(await G("wa_gw_recover", { p_instance: inst.id })) >= 0, true);
  assert.equal(sql(`select status from wa_outbox where id = '${id}'`), "failed");
  assert.equal(ok(await G("wa_gw_claim", { p_instance: inst.id })), null);
});

test("isolamento: outra empresa não vê disparos, fila nem descadastros", async () => {
  assert.equal(ok(await other.from("wa_campaigns").select("id").eq("tenant_id", A)).length, 0);
  assert.equal(ok(await other.from("wa_outbox").select("id").eq("tenant_id", A)).length, 0);
  assert.equal(ok(await other.from("wa_optouts").select("phone").eq("tenant_id", A)).length, 0);
  assert.ok((await other.rpc("wa_campaign_action", { p_campaign_id: camp, p_action: "pause" })).error);
  const tk = await gw.from("wa_gateway_tokens").select("*");
  assert.ok(tk.error || tk.data.length === 0, "hash do token não é legível pela API");
  assert.ok(ok(await seller.from("wa_campaigns").select("id").eq("tenant_id", A)).length >= 1);
});
