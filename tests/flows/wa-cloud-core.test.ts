// Regras puras da API oficial do WhatsApp (sem rede).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCloudError, cloudPayload, parseCloudWebhook, templateFromMeta } from "../../supabase/functions/_shared/wa-cloud-core.ts";

test("envio: texto, mídia e modelo no formato da Meta", () => {
  assert.deepEqual(cloudPayload({ phone: "+55 (11) 98888-7777", body: "Oi!" }), {
    messaging_product: "whatsapp", recipient_type: "individual", to: "5511988887777", type: "text", text: { body: "Oi!", preview_url: false },
  });
  const img = cloudPayload({ phone: "5511988887777", body: "Catálogo", media_url: "https://x.com/cat.png", media_type: "image" });
  assert.deepEqual(img.image, { link: "https://x.com/cat.png", caption: "Catálogo" });
  const doc = cloudPayload({ phone: "5511988887777", body: "", media_url: "https://x.com/a/tabela%20preco.pdf?v=1", media_type: "document" });
  assert.deepEqual(doc.document, { link: "https://x.com/a/tabela%20preco.pdf?v=1", filename: "tabela preco.pdf" });
  const audio = cloudPayload({ phone: "5511988887777", body: "legenda", media_url: "https://x.com/a.ogg", media_type: "audio" });
  assert.deepEqual(audio.audio, { link: "https://x.com/a.ogg" }, "áudio não leva legenda");
  const tpl = cloudPayload({ phone: "5511988887777", body: "x", template: { name: "boas_vindas", language: "pt_BR", params: ["Ana", ""] } });
  assert.deepEqual(tpl.template, {
    name: "boas_vindas", language: { code: "pt_BR" },
    components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "-" }] }],
  });
  const noParams = cloudPayload({ phone: "5511988887777", template: { name: "ola", language: "pt_BR", params: [] } });
  assert.equal("components" in (noParams.template as object), false);
});

test("erros da Meta: janela de 24 h, número sem WhatsApp, limite, token", () => {
  assert.match(classifyCloudError({ code: 131047 }).message, /24 horas/);
  assert.deepEqual(classifyCloudError({ code: 131026 }).invalid, true);
  assert.equal(classifyCloudError({ code: 130429 }).retry, true);
  assert.equal(classifyCloudError({ code: 190 }).auth, true);
  assert.equal(classifyCloudError({ code: 100, message: "Unsupported get request" }).auth, false);
  assert.match(classifyCloudError({ code: 999, error_data: { details: "algo" } }).message, /Meta: algo \(código 999\)/);
});

test("webhook: mensagens de vários tipos, nome do contato e status; ignora outro número", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "111" },
      contacts: [{ wa_id: "5511988887777", profile: { name: "Rita" } }],
      messages: [
        { from: "5511988887777", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "Oi Ref: ab12-cd34" } },
        { from: "5511988887777", id: "wamid.2", timestamp: "1700000001", type: "image", image: { caption: "foto", mime_type: "image/jpeg" } },
        { from: "5511988887777", id: "wamid.3", timestamp: "1700000002", type: "interactive", interactive: { button_reply: { title: "Quero" } } },
        { from: "5511988887777", id: "wamid.4", timestamp: "1700000003", type: "location", location: { latitude: -23.5, longitude: -46.6, name: "Loja" } },
        { from: "5511988887777", id: "wamid.5", timestamp: "1700000004", type: "order" },
      ],
      statuses: [{ id: "wamid.9", status: "failed", errors: [{ code: 131026 }] }, { id: "wamid.8", status: "read" }],
    } }] },
    { changes: [{ field: "messages", value: { metadata: { phone_number_id: "222" }, messages: [{ from: "1", id: "x", type: "text", text: { body: "outro" } }] } }] }],
  };
  const { messages, statuses } = parseCloudWebhook(payload, "111");
  assert.equal(messages.length, 5);
  assert.deepEqual([messages[0].body, messages[0].push_name, messages[0].via, messages[0].ts], ["Oi Ref: ab12-cd34", "Rita", "cloud_api", new Date(1700000000000).toISOString()]);
  assert.deepEqual([messages[1].type, messages[1].body, messages[1].mime], ["image", "foto", "image/jpeg"]);
  assert.deepEqual([messages[2].type, messages[2].body], ["text", "Quero"]);
  assert.equal(messages[3].body, "Loja · -23.5,-46.6");
  assert.equal(messages[4].type, "unknown");
  assert.equal(statuses.length, 2);
  assert.match(String(statuses[0].error), /não tem WhatsApp/);
});

test("modelos: texto do corpo e número de variáveis", () => {
  const t = templateFromMeta({ name: "promo", language: "pt_BR", status: "approved", category: "MARKETING", components: [
    { type: "HEADER", format: "TEXT", text: "Oferta" },
    { type: "BODY", text: "Olá {{1}}, sua {{2}} chegou. {{1}}!" },
  ] });
  assert.deepEqual([t.status, t.body_text, t.header_text, t.param_count], ["APPROVED", "Olá {{1}}, sua {{2}} chegou. {{1}}!", "Oferta", 2]);
});
