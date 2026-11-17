// Caixa de entrada: enviar arquivo (PDF, imagem, áudio...) pela mesma fila do CRO, com o link no histórico.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  ok(await c.auth.signInWithPassword({ email, password: "Teste@12345" }));
  return c;
};
const TAG = Date.now() % 100000;
const ph = (n) => `55119${String(50000000 + TAG * 10 + n).slice(-8)}`;
const TOKEN = randomBytes(32).toString("hex");
const gw = createClient(URL_, ANON, { auth: { persistSession: false } });
const G = (fn, args) => gw.rpc(fn, { p_token: TOKEN, ...args });
const PDF = "https://exemplo.supabase.co/functions/v1/flow-media/abc/Apresentacao.pdf";
let A, owner, inst, conv;

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'media ${TAG}')`);
  sql(`insert into wa_channel_settings (tenant_id, active_provider) values ('${A}', 'gateway') on conflict (tenant_id) do update set active_provider = 'gateway'`);
  owner = await login("dono@clinica.local");
  inst = ok(await owner.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" }));
  ok(await G("wa_gw_instance_update", { p_instance: inst.id, p_status: "connected", p_phone: "5511900000001" }));
  const r = ok(await G("wa_gw_ingest", { p_instance: inst.id, p_msg: { from_me: false, wa_id: ph(1), phone: ph(1), push_name: "Gabriela", body: "Quero conhecer", wa_message_id: `IM${TAG}in` } }));
  conv = r.conversation_id;
});

test("enviar PDF pela conversa: entra na fila com o arquivo, sai pelo motor e fica no histórico com o link", async () => {
  const id = ok(await owner.rpc("wa_send_media", { p_tenant_id: A, p_media_url: PDF, p_media_type: "document", p_file_name: "Apresentação.pdf", p_caption: null, p_conversation_id: conv }));
  assert.equal(sql(`select concat_ws('|', source, media_type, media_url, file_name, body, status) from wa_outbox where id = '${id}'`),
    `manual|document|${PDF}|Apresentação.pdf||queued`);
  const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
  assert.equal(m.id, id);
  assert.equal(m.media_url, PDF);
  ok(await G("wa_gw_result", { p_outbox_id: id, p_ok: true, p_wa_message_id: `IM${TAG}pdf`, p_jid: `${ph(1)}@s.whatsapp.net` }));
  assert.equal(sql(`select concat_ws('|', direction, content_type, media_url, body) from whatsapp_messages where wa_message_id = 'IM${TAG}pdf'`),
    `outbound|document|${PDF}|Apresentação.pdf`);
});

test("áudio e imagem com legenda", async () => {
  const aud = ok(await owner.rpc("wa_send_media", { p_tenant_id: A, p_media_url: "https://x.test/a.ogg", p_media_type: "audio", p_file_name: "audio.ogg", p_caption: null, p_conversation_id: conv }));
  const img = ok(await owner.rpc("wa_send_media", { p_tenant_id: A, p_media_url: "https://x.test/f.jpg", p_media_type: "image", p_file_name: "f.jpg", p_caption: "Nosso salão", p_conversation_id: conv }));
  assert.equal(sql(`select string_agg(media_type || ':' || coalesce(nullif(body, ''), '-'), ',' order by media_type) from wa_outbox where id in ('${aud}', '${img}')`), "audio:-,image:Nosso salão");
});

test("validações: tipo, link, permissão e SAIR", async () => {
  const bad = (args) => owner.rpc("wa_send_media", { p_tenant_id: A, p_media_type: "document", p_media_url: PDF, p_file_name: "a.pdf", p_caption: null, p_conversation_id: conv, ...args });
  assert.ok((await bad({ p_media_type: "exe" })).error, "tipo inválido deveria ser recusado");
  assert.ok((await bad({ p_media_url: "http://inseguro.test/a.pdf" })).error, "link sem https deveria ser recusado");
  assert.ok((await bad({ p_media_url: null })).error, "sem arquivo deveria ser recusado");
  const viewer = await login("leitura@clinica.local");
  assert.ok((await viewer.rpc("wa_send_media", { p_tenant_id: A, p_media_url: PDF, p_media_type: "document", p_file_name: "a.pdf", p_caption: null, p_conversation_id: conv })).error, "perfil leitura não envia");
  const other = await login("dona@perfumaria.local");
  assert.ok((await other.rpc("wa_send_media", { p_tenant_id: A, p_media_url: PDF, p_media_type: "document", p_file_name: "a.pdf", p_caption: null, p_conversation_id: conv })).error, "outra empresa não pode enviar");
  sql(`insert into wa_optouts (tenant_id, phone) values ('${A}', '${ph(2)}') on conflict do nothing`);
  assert.ok((await owner.rpc("wa_send_media", { p_tenant_id: A, p_media_url: PDF, p_media_type: "document", p_file_name: "a.pdf", p_caption: null, p_phone: ph(2) })).error, "quem pediu SAIR não recebe");
});

test("texto continua aparecendo como antes (sem link)", async () => {
  const id = ok(await owner.rpc("wa_send_message", { p_tenant_id: A, p_body: "Bom dia!", p_conversation_id: conv }));
  // processa a fila (o áudio e a imagem do teste anterior saem antes) até chegar no texto
  for (let i = 0; i < 5; i++) {
    const m = ok(await G("wa_gw_claim", { p_instance: inst.id }));
    if (!m) break;
    ok(await G("wa_gw_result", { p_outbox_id: m.id, p_ok: true, p_wa_message_id: `IM${TAG}q${i}`, p_jid: `${ph(1)}@s.whatsapp.net` }));
    if (m.id === id) {
      assert.equal(sql(`select concat_ws('|', content_type, coalesce(media_url, 'sem-link'), body) from whatsapp_messages where wa_message_id = 'IM${TAG}q${i}'`), "text|sem-link|Bom dia!");
      return;
    }
  }
  assert.fail("o texto não saiu da fila");
});

test("áudio enviado fica no histórico com o player (link do arquivo)", async () => {
  assert.equal(sql(`select count(*) from whatsapp_messages where conversation_id = '${conv}' and content_type = 'audio' and media_url = 'https://x.test/a.ogg'`), "1");
});
