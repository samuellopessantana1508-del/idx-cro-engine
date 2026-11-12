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
import { Gateway } from "../src/main.js";
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
  sent: Array<{ jid: string; text: string }> = [];
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
  async sendMessage(jid: string, c: { text: string }) {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
    this.sent.push({ jid, text: c.text });
    return { key: { id: `FAKE${TAG}-${this.sent.length}` } };
  }
  async sendPresenceUpdate(t: string) { this.presence.push(t); }
  async logout() { this.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } }); }
  end() { this.ended = true; }
  scan(phone = "5511900000001") { this.user = { id: `${phone}:3@s.whatsapp.net` }; this.emit("connection.update", { connection: "open" }); }
}

let sock: FakeSock;
let created = 0;
const factory: SocketFactory = async () => {
  sock = new FakeSock();
  created++;
  setTimeout(() => sock.emit("connection.update", { qr: "2@FAKEQRDATA" }), 50);
  return { sock, saveCreds: async () => {} };
};

const silent = { info() {}, warn() {}, error(...a: unknown[]) { console.error(...a); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-gw-"));
let gw: Gateway, A: string, inst: string, admin: any, seller: any;

before(async () => {
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'gw-test ${TAG}')`);
  sql(`update wa_campaigns set status = 'canceled' where status = 'running'`);
  sql(`update wa_outbox set status = 'canceled' where status in ('queued', 'sending')`);
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
  gw = new Gateway(new Db(URL_, ANON, TOKEN), factory, dir, silent, { syncMs: 300, pollMs: 200, typing: true });
  gw.start();
});

after(async () => { await gw.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

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
  assert.deepEqual(sock.sent.at(-1), { jid: `${ph(1)}@s.whatsapp.net`, text: "Olá, aqui é da IDX!" });
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
