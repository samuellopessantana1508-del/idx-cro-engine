import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowTicker, trackingRef } from "../src/main.js";
import { messageContent } from "../src/session.js";

test("automações: rajada de mensagens vira uma chamada; nunca duas ao mesmo tempo", async () => {
  let calls = 0, live = 0, maxLive = 0;
  const t = new FlowTicker(async () => { calls++; live++; maxLive = Math.max(maxLive, live); await new Promise((r) => setTimeout(r, 80)); live--; }, { debounceMs: 30, everyMs: 100000 });
  for (let i = 0; i < 5; i++) t.poke();
  await new Promise((r) => setTimeout(r, 60));
  t.poke(); // chega durante a execução: roda de novo depois, não em paralelo
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(maxLive, 1);
  assert.equal(calls, 2);
  t.stop();
});

test("conteúdo das mensagens: texto, imagem com legenda, áudio, documento com nome", () => {
  assert.deepEqual(messageContent({ id: "1", phone: "x", body: "oi", source: "flow" }), { text: "oi" });
  assert.deepEqual(messageContent({ id: "1", phone: "x", body: "", source: "flow", media_url: "https://a/b.jpg", media_type: "image" }), { image: { url: "https://a/b.jpg" }, caption: undefined });
  assert.equal(messageContent({ id: "1", phone: "x", body: "", source: "flow", media_url: "https://a/v.ogg", media_type: "audio" }).ptt, true);
  const d = messageContent({ id: "1", phone: "x", body: "Segue", source: "flow", media_url: "https://a/x.xlsx?t=1", media_type: "document", file_name: null });
  assert.equal(d.fileName, "x.xlsx");
  assert.equal(d.mimetype, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(d.caption, "Segue");
});

test("rastreio: lê o código do link de campanha na mensagem do lead", () => {
  assert.equal(trackingRef("Olá, quero saber mais. Ref: ab12-CD34"), "ab12-cd34");
  assert.equal(trackingRef("ref:k9x2-77aa"), "k9x2-77aa");
  assert.equal(trackingRef("Oi, tudo bem?"), null);
  assert.equal(trackingRef("abcde-fghij"), null);
  assert.equal(trackingRef(undefined), null);
});
