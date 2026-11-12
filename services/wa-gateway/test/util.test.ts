import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneCandidates, parseMessage, mapStatus, isTransient, backoffMs, typingMs } from "../src/util.js";

test("normaliza telefones como o banco", () => {
  assert.equal(normalizePhone("(11) 98765-4321"), "5511987654321");
  assert.equal(normalizePhone("5511987654321@s.whatsapp.net"), "5511987654321");
  assert.equal(normalizePhone("5511987654321:12@s.whatsapp.net"), "5511987654321");
  assert.equal(normalizePhone("011 3333-4444"), "551133334444");
  assert.equal(normalizePhone("1203630@g.us"), null);
  assert.equal(normalizePhone("123456789@lid"), null);
  assert.equal(normalizePhone("123"), null);
});

test("9º dígito: tenta com e sem", () => {
  assert.deepEqual(phoneCandidates("5511987654321"), ["5511987654321", "551187654321"]);
  assert.deepEqual(phoneCandidates("551187654321"), ["551187654321", "5511987654321"]);
  assert.deepEqual(phoneCandidates("551133334444"), ["551133334444"], "fixo não ganha 9");
  assert.deepEqual(phoneCandidates("14155550100"), ["14155550100"]);
});

test("mensagens: texto, legenda, efêmera, @lid, grupo e protocolo", () => {
  const t = parseMessage({ key: { remoteJid: "5511987654321@s.whatsapp.net", id: "A1", fromMe: false }, pushName: "Ana", messageTimestamp: 1794400000, message: { conversation: "SAIR" } })!;
  assert.equal(t.body, "SAIR"); assert.equal(t.phone, "5511987654321"); assert.equal(t.push_name, "Ana"); assert.equal(t.type, "text");
  assert.equal(t.ts, new Date(1794400000 * 1000).toISOString());
  const img = parseMessage({ key: { remoteJid: "5511987654321@s.whatsapp.net", id: "A2" }, message: { ephemeralMessage: { message: { imageMessage: { caption: "foto", mimetype: "image/jpeg" } } } } })!;
  assert.equal(img.type, "image"); assert.equal(img.body, "foto");
  const lid = parseMessage({ key: { remoteJid: "998877@lid", remoteJidAlt: "5511987654321@s.whatsapp.net", id: "A3" }, message: { extendedTextMessage: { text: "oi", contextInfo: { stanzaId: "Q1" } } } })!;
  assert.equal(lid.phone, "5511987654321"); assert.equal(lid.wa_id, "5511987654321"); assert.equal(lid.quoted_id, "Q1");
  const lidNoPhone = parseMessage({ key: { remoteJid: "998877@lid", id: "A4" }, message: { conversation: "oi" } })!;
  assert.equal(lidNoPhone.phone, null); assert.equal(lidNoPhone.wa_id, "998877");
  assert.equal(parseMessage({ key: { remoteJid: "1203@g.us", id: "G" }, message: { conversation: "x" } }), null);
  assert.equal(parseMessage({ key: { remoteJid: "status@broadcast", id: "S" }, message: { conversation: "x" } }), null);
  assert.equal(parseMessage({ key: { remoteJid: "5511987654321@s.whatsapp.net", id: "P" }, message: { protocolMessage: { type: 0 } } }), null);
  const mine = parseMessage({ key: { remoteJid: "5511987654321@s.whatsapp.net", id: "M", fromMe: true }, pushName: "Eu", message: { conversation: "enviado do celular" } })!;
  assert.equal(mine.from_me, true); assert.equal(mine.push_name, undefined, "não troca o nome do cliente pelo nosso");
});

test("status, erros transitórios, reconexão e digitação", () => {
  assert.equal(mapStatus(2), "sent"); assert.equal(mapStatus(3), "delivered"); assert.equal(mapStatus(5), "read"); assert.equal(mapStatus(1), null);
  assert.equal(isTransient(new Error("Connection Closed")), true);
  assert.equal(isTransient(new Error("Timed Out")), true);
  assert.equal(isTransient(new Error("not-authorized")), false);
  assert.equal(backoffMs(0), 3000); assert.equal(backoffMs(50), 60000);
  assert.ok(typingMs("oi", () => 0.5) >= 1500 && typingMs("x".repeat(1000), () => 1) <= 7200);
});
