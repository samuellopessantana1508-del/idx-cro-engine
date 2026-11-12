// Conexão única: mensagens que chegam pela conexão do CRO (QR) são lidas pela IA de vendas,
// como acontecia no fluxo antigo (Evolution + n8n). Stack LOCAL com IA simulada.
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
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const TAG = Date.now() % 100000;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
const tick = () => fetch(`${URL_}/functions/v1/cro-flows`, { method: "POST", headers: { "x-gateway-token": TOKEN, "Content-Type": "application/json" }, body: "{}" });
const until = async (fn, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 400)); } throw new Error("tempo esgotado"); };
let aiServer, A, inst, aiCalls = 0;

before(async () => {
  aiServer = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const isAnalysis = b.includes("inteligência comercial");
      if (isAnalysis) aiCalls++;
      const content = isAnalysis ? JSON.stringify({
        summary: "Cliente pediu 2 caixas e o pix para pagar",
        intent: "comprar",
        sentiment: "positive",
        purchase_probability: 0.8,
        sale_signals: [{ type: "high_intent", confidence: 0.8, evidence: "Quero fechar 2 caixas, pode mandar o pix", estimated_value: null }],
      }) : "ok";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise((r) => aiServer.listen(11999, "127.0.0.1", r));
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  const admin = createClient(URL_, ANON, { auth: { persistSession: false } });
  assert.equal((await admin.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" })).error, null);
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'leitura IA ${TAG}')`);
  sql(`update wa_flows set status = 'paused' where status = 'active'`);
  inst = ok(await admin.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
});
after(() => aiServer?.close());

test("mensagem pela conexão do CRO é lida pela IA e vira sinal de venda", async () => {
  const phone = `55119${String(83000000 + TAG).slice(-8)}`;
  ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: phone, phone, push_name: "Rita", body: "Quero fechar 2 caixas, pode mandar o pix", wa_message_id: `AIR${TAG}A` } }));
  const conv = sql(`select c.id from whatsapp_conversations c join whatsapp_contacts w on w.id = c.contact_id where w.instance_id = '${inst.id}' and w.phone = '${phone}'`);
  assert.ok(conv);

  // ainda dentro da janela de 8 s: não lê (espera mensagens seguidas)
  const before = aiCalls;
  await tick(); await new Promise((r) => setTimeout(r, 1500));
  assert.equal(aiCalls, before);

  sql(`update whatsapp_conversations set last_message_at = now() - interval '10 seconds' where id = '${conv}'`);
  assert.equal((await tick()).status, 200);
  await until(() => sql(`select count(*) from whatsapp_messages where conversation_id = '${conv}' and direction = 'inbound' and ai_analyzed = false`) === "0");
  assert.equal(sql(`select summary from conversation_insights where conversation_id = '${conv}'`), "Cliente pediu 2 caixas e o pix para pagar");
  assert.equal(sql(`select signal_type from sale_signals where conversation_id = '${conv}'`), "high_intent");

  // não lê de novo sem mensagem nova
  const calls = aiCalls;
  await tick(); await new Promise((r) => setTimeout(r, 1500));
  assert.equal(aiCalls, calls);
});
