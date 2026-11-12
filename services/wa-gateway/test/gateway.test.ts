// Integração: motor completo com WhatsApp SIMULADO contra o banco LOCAL.
// Requer a stack local (scripts/local-stack) + seed. ANON_KEY no ambiente.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { Db } from "../src/db.js";
import { Gateway, FlowTicker, runFlows } from "../src/main.js";
import type { SocketFactory, SocketLike } from "../src/session.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY!;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q: string) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TOKEN = randomBytes(32).toString("hex");
const TAG = Date.now() % 100000;
const ph = (n: number) => `55119${String(60000000 + TAG * 10 + n).slice(-8)}`;
const wait = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("tempo esgotado");
};

class FakeSock extends EventEmitter implements SocketLike {
  ev = { on: (e: string, cb: (a: any) => void) => this.on(e, cb) };
  user: { id: string } | null = null;
  sent: Array<{ jid: string; text: string; content: Record<string, any> }> = [];
  presence: string[] = [];
  failNext: string | null = null;
  ended = false;
  async onWhatsApp(j: string) {
    // fixo terminado em 0000 não tem WhatsApp; celular só existe SEM o 9º dígito se terminar em 77
    const d = j.replace(/\D/g, "");
    if (d.endsWith("0000")) return [];
    if (d.endsWith("77") && d.length === 13) return [];
    return [{ exists: true, jid: `${d}@s.whatsapp.net` }];
  }
  async sendMessage(jid: string, c: Record<string, any>) {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
    this.sent.push({ jid, text: c.text ?? c.caption ?? "", content: c });
    return { key: { id: `FAKE${TAG}-${this.sent.length}` } };
  }
  async sendPresenceUpdate(t: string) { this.presence.push(t); }
  async groupFetchAllParticipating() {
    return { "120363000000000001@g.us": { subject: "Farmácias de Campinas", participants: [{ id: "a" }, { id: "b" }, { id: "c" }] },
             "120363000000000002@g.us": { subject: "Família", participants: [{ id: "a" }] } };
  }
  async groupMetadata(jid: string) {
    if (!jid.endsWith("@g.us")) throw new Error("item-not-found");
    return { subject: "Farmácias de Campinas", participants: [
      { id: "5519988887777@s.whatsapp.net", notify: "Drogaria Bom Preço", admin: "admin" },
      { id: "123456789012345@lid", phoneNumber: "5519977776666@s.whatsapp.net", notify: "Farmácia Vida" },
      { id: "998877665544332@lid" },
      { id: `${(this.user?.id ?? "").replace(/:.*$/, "")}@s.whatsapp.net` },
    ] };
  }
  async logout() { this.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } }); }
  end() { this.ended = true; }
  scan(phone = "5511900000001") { this.user = { id: `${phone}:3@s.whatsapp.net` }; this.emit("connection.update", { connection: "open" }); }
}

let sock: FakeSock;
let created = 0;
const factory: SocketFactory = async () => {
  const s = new FakeSock();
  sock = s;
  created++;
  // o QR só aparece enquanto ninguém leu (como no WhatsApp de verdade)
  setTimeout(() => { if (!s.user) s.emit("connection.update", { qr: "2@FAKEQRDATA" }); }, 50);
  return { sock, saveCreds: async () => {} };
};

const silent = { info() {}, warn() {}, error(...a: unknown[]) { console.error(...a); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-gw-"));
let gw: Gateway, flows: FlowTicker, A: string, inst: string, admin: any, seller: any;

before(async () => {
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'gw-test ${TAG}')`);
  sql(`update wa_campaigns set status = 'canceled' where status = 'running'`);
  sql(`update wa_outbox set status = 'canceled' where status in ('queued', 'sending')`);
  sql(`update wa_flows set status = 'paused' where status = 'active'`);
  sql(`update wa_flow_runs set status = 'cancelled' where status in ('running', 'waiting')`);
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  const login = async (email: string) => {
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
    assert.equal(r.error, null);
    return c;
  };
  admin = await login("dono@clinica.local");
  seller = await login("ana.vendas@clinica.local");
  // garante conexão pedida e só a do tenant A como gateway ativo
  sql(`update whatsapp_instances set desired_status = 'disconnected' where provider = 'gateway'`);
  const r = await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" });
  assert.equal(r.error, null, r.error?.message);
  inst = r.data.id;
  flows = new FlowTicker(() => runFlows(URL_, ANON, TOKEN, silent), { debounceMs: 100, everyMs: 2000 });
  gw = new Gateway(new Db(URL_, ANON, TOKEN), factory, dir, silent, { syncMs: 300, pollMs: 200, typing: true, onInbound: () => flows.poke() });
  gw.start();
  flows.start();
});

after(async () => { flows.stop(); await gw.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test("QR aparece no CRO e, depois de ler, fica conectado com o número", async () => {
  await wait(() => sql(`select coalesce(qr_code_data, '') from whatsapp_instances where id = '${inst}'`).startsWith("data:image/png;base64,"));
  assert.equal(sql(`select status from whatsapp_instances where id = '${inst}'`), "connecting");
  sock.scan();
  await wait(() => sql(`select status from whatsapp_instances where id = '${inst}'`) === "connected");
  assert.equal(sql(`select phone_number || '|' || (qr_code_data is null) from whatsapp_instances where id = '${inst}'`), "5511900000001|true");
});

test("resposta manual: sai na hora, com 'digitando', e entra no histórico", async () => {
  const r = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "Olá, aqui é da IDX!", p_phone: ph(1) });
  assert.equal(r.error, null, r.error?.message);
  await wait(() => sql(`select status from wa_outbox where id = '${r.data}'`) === "sent");
  assert.deepEqual(sock.sent.at(-1), { jid: `${ph(1)}@s.whatsapp.net`, text: "Olá, aqui é da IDX!", content: { text: "Olá, aqui é da IDX!" } });
  assert.ok(sock.presence.includes("composing"));
  assert.equal(sql(`select direction || '|' || body from whatsapp_messages where wa_message_id = (select wa_message_id from wa_outbox where id = '${r.data}')`), "outbound|Olá, aqui é da IDX!");
});

test("número sem 9º dígito no WhatsApp é encontrado; fixo sem WhatsApp vira 'inválido'", async () => {
  const p77 = `5511987654${String(TAG % 10)}77`;
  const r1 = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "teste 9", p_phone: p77 });
  await wait(() => sql(`select status from wa_outbox where id = '${r1.data}'`) === "sent");
  assert.equal(sock.sent.at(-1)!.jid, `${p77.slice(0, 4)}${p77.slice(5)}@s.whatsapp.net`);
  const r2 = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "teste fixo", p_phone: "551133330000" });
  await wait(() => sql(`select status from wa_outbox where id = '${r2.data}'`) === "failed");
  assert.match(sql(`select error from wa_outbox where id = '${r2.data}'`), /não tem WhatsApp/);
});

test("queda de conexão no envio: tenta de novo e não perde a mensagem", async () => {
  sock.failNext = "Connection Closed";
  const r = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "vai na segunda", p_phone: ph(2) });
  await wait(() => sql(`select status from wa_outbox where id = '${r.data}'`) === "sent");
  assert.equal(sql(`select attempts from wa_outbox where id = '${r.data}'`), "2");
});

test("disparo: envia um por vez respeitando o intervalo; resposta e SAIR chegam ao CRO", async () => {
  const c = await seller.rpc("wa_campaign_save", { p_tenant_id: A, p_id: null, p_name: `GW ${TAG}`,
    p_messages: ["Oi {primeiro_nome}!"], p_min_delay: 15, p_max_delay: 15, p_start_hour: 0, p_end_hour: 24 });
  assert.equal(c.error, null, c.error?.message);
  await seller.rpc("wa_campaign_add_recipients", { p_campaign_id: c.data, p_source: "rows",
    p_rows: [{ nome: "Paula Reis", telefone: ph(3) }, { nome: "Rui Melo", telefone: ph(4) }] });
  const before = sock.sent.length;
  await seller.rpc("wa_campaign_action", { p_campaign_id: c.data, p_action: "start" });
  await wait(() => sock.sent.length === before + 1);
  const t1 = Date.now();
  assert.match(sock.sent.at(-1)!.text, /^Oi (Paula|Rui)!\n\nSe não quiser receber mais mensagens, responda SAIR\.$/);
  // cliente responde SAIR antes do 2º envio? Não: o 2º é outro número. Primeiro a resposta normal:
  const first = sock.sent.at(-1)!.jid.replace(/@.*/, "");
  sock.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: `${first}@s.whatsapp.net`, id: `IN${TAG}1`, fromMe: false }, pushName: "Cliente", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Tenho interesse" } }] });
  await wait(() => sql(`select count(*) from wa_campaign_recipients where campaign_id = '${c.data}' and replied_at is not null`) === "1");
  // o 2º envio só depois de ~15 s
  await wait(() => sock.sent.length === before + 2, 25000);
  assert.ok(Date.now() - t1 >= 13500, `intervalo de ${Date.now() - t1} ms`);
  await wait(() => sql(`select status from wa_campaigns where id = '${c.data}'`) === "completed", 10000);
  // SAIR vindo de um @lid com número alternativo
  sock.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "77788899@lid", remoteJidAlt: `${ph(4)}@s.whatsapp.net`, id: `IN${TAG}2`, fromMe: false }, message: { conversation: "sair" } }] });
  await wait(() => sql(`select count(*) from wa_optouts where tenant_id = '${A}' and phone = '${ph(4)}'`) === "1");
  // mensagem enviada pelo celular também aparece na conversa
  sock.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: `${first}@s.whatsapp.net`, id: `OUT${TAG}3`, fromMe: true }, message: { conversation: "respondi pelo celular" } }] });
  await wait(() => sql(`select direction from whatsapp_messages where wa_message_id = 'OUT${TAG}3'`) === "outbound");
  // confirmação de leitura
  const wid = sql(`select wa_message_id from wa_campaign_recipients where campaign_id = '${c.data}' and phone = '${first}'`);
  sock.emit("messages.update", [{ key: { id: wid, fromMe: true }, update: { status: 4 } }]);
  await wait(() => sql(`select status from whatsapp_messages where wa_message_id = '${wid}'`) === "read");
});

test("automação: mensagem recebida dispara resposta com texto e imagem pelo mesmo número", async () => {
  sql(`update wa_flows set status = 'paused' where status = 'active'`);
  const N = (id: string, type: string, config: any) => ({ id, type, position: { x: 0, y: 0 }, data: { config } });
  const graph = {
    nodes: [N("t", "trigger", { kind: "keyword", keywords: "catálogo" }), N("s", "send_text", { text: "Oi {primeiro_nome}, segue:" }),
      N("i", "send_media", { mediaType: "image", url: "https://exemplo.com/cat.jpg", caption: "Catálogo" }),
      N("d", "send_media", { mediaType: "document", url: "https://exemplo.com/tabela%20precos.pdf" })],
    edges: [{ id: "a", source: "t", target: "s" }, { id: "b", source: "s", target: "i" }, { id: "c", source: "i", target: "d" }],
  };
  const f = await admin.rpc("wa_flow_save", { p_tenant_id: A, p_id: null, p_name: `GW fluxo ${TAG}`, p_graph: graph });
  assert.equal(f.error, null, f.error?.message);
  assert.equal((await admin.rpc("wa_flow_set_status", { p_flow_id: f.data.id, p_status: "active" })).error, null);
  const before = sock.sent.length;
  const p = ph(8); // (final 77 simula número sem 9º dígito no FakeSock; aqui não)
  sock.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: `${p}@s.whatsapp.net`, id: `INF${TAG}`, fromMe: false }, pushName: "Marta Alves", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "me manda o catalogo" } }] });
  await wait(() => sock.sent.length >= before + 3, 20000);
  const out = sock.sent.slice(before);
  assert.equal(out[0].text, "Oi Marta, segue:");
  assert.deepEqual(out[1].content, { image: { url: "https://exemplo.com/cat.jpg" }, caption: "Catálogo" });
  assert.equal(out[2].content.document.url, "https://exemplo.com/tabela%20precos.pdf");
  assert.equal(out[2].content.fileName, "tabela precos.pdf");
  assert.equal(out[2].content.mimetype, "application/pdf");
  await wait(() => sql(`select count(*) from whatsapp_messages m join whatsapp_conversations c on c.id = m.conversation_id join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${p}' and m.direction = 'outbound'`) === "3");
  await admin.rpc("wa_flow_set_status", { p_flow_id: f.data.id, p_status: "archived" });
});

test("grupos: lista os grupos e extrai participantes com número (sem quem esconde o número)", async () => {
  const denied = await seller.rpc("wa_groups_request", { p_tenant_id: A, p_kind: "list" });
  assert.match(denied.error?.message ?? "", /gestores/);
  const job = await admin.rpc("wa_groups_request", { p_tenant_id: A, p_kind: "list" });
  assert.equal(job.error, null, job.error?.message);
  await wait(() => sql(`select status from wa_group_jobs where id = '${job.data}'`) === "done");
  const groups = JSON.parse(sql(`select result::text from wa_group_jobs where id = '${job.data}'`)).groups;
  assert.deepEqual(groups[0], { jid: "120363000000000001@g.us", subject: "Farmácias de Campinas", size: 3 });
  const job2 = await admin.rpc("wa_groups_request", { p_tenant_id: A, p_kind: "members", p_group_jid: "120363000000000001@g.us" });
  assert.equal(job2.error, null, job2.error?.message);
  await wait(() => sql(`select status from wa_group_jobs where id = '${job2.data}'`) === "done");
  const r = JSON.parse(sql(`select result::text from wa_group_jobs where id = '${job2.data}'`));
  assert.equal(r.total, 4);
  assert.equal(r.hidden, 1);
  assert.deepEqual(r.members.map((m: any) => m.phone), ["5519988887777", "5519977776666"]);
  assert.equal(r.members[0].admin, true);
  // importa para o CRM com etiqueta
  const imp = await admin.rpc("crm_contacts_tag_import", { p_tenant_id: A, p_rows: r.members, p_tag: "grupo-farmacias", p_source: "whatsapp_group" });
  assert.equal(imp.error, null, imp.error?.message);
  assert.equal(imp.data.created + imp.data.existing, 2);
  assert.equal(sql(`select count(*) from crm_contacts where tenant_id = '${A}' and 'grupo-farmacias' = any(tags) and phone in ('5519988887777','5519977776666')`), "2");
});

test("pausar pelo CRO para tudo; desconectar fecha a sessão; conectar religa", async () => {
  await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "disconnect" });
  await wait(() => sql(`select status from whatsapp_instances where id = '${inst}'`) === "disconnected");
  assert.equal(gw.session(inst), undefined);
  const r = await seller.rpc("wa_send_message", { p_tenant_id: A, p_body: "enquanto desconectado", p_phone: ph(5) });
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(sql(`select status from wa_outbox where id = '${r.data}'`), "queued", "fica na fila, não se perde");
  const n = created;
  await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" });
  await wait(() => created === n + 1);
  sock.scan();
  await wait(() => sql(`select status from wa_outbox where id = '${r.data}'`) === "sent");
});

test("queda da conexão (rede): reconecta sozinho, sem desistir", async () => {
  const n = created;
  sock.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
  // backoff inicial de 3 s
  await wait(() => created === n + 1, 8000);
  sock.scan();
  await wait(() => sql(`select status from whatsapp_instances where id = '${inst}'`) === "connected");
});

test("sair do número (logout) apaga a sessão salva", async () => {
  fs.mkdirSync(path.join(dir, inst), { recursive: true });
  fs.writeFileSync(path.join(dir, inst, "creds.json"), "{}");
  await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "logout" });
  await wait(() => !fs.existsSync(path.join(dir, inst)));
  await wait(() => sql(`select desired_status || '|' || status from whatsapp_instances where id = '${inst}'`) === "disconnected|disconnected");
});
