import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUserPrompt,
  groundAnalysis,
  isAnalysisContaminated,
  parseModelJson,
  SYSTEM_PROMPT,
} from "../supabase/functions/_shared/ai-grounding.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

const msg = (id, direction, body, content_type = "text") => ({ id: `${id}-0000-0000`, direction, body, content_type });

// Conversa real da Rede Sanmar.
const arthur = {
  tenantName: "Rede Sanmar",
  businessSegment: null,
  contactName: "Arthur IDX",
  messages: [msg("m1", "inbound", "Eu estou interessado"), msg("m2", "inbound", "Quero comprar")],
};

// Resposta inventada que o qwen2.5:1.5b gerou em produção.
const hallucinated = {
  nome_cliente: "João Silva",
  produtos: [{ nome: "Corte de cabelo", trecho: "corte de cabelo" }],
  objecoes: [{ texto: "Achei caro", trecho: "achei caro" }],
  sinais: [{ tipo: "confirmed_sale", trecho: "Quero comprar" }],
  summary: "João Silva está interessado em comprar um corte de cabelo, mas expressou preocupações sobre o preço.",
};

const EXPECTED_ARTHUR = "Arthur IDX demonstrou interesse em comprar, mas ainda não informou qual produto ou serviço deseja. Nenhuma objeção foi identificada.";

test("Rede Sanmar / Arthur IDX: resumo fiel mesmo com a IA inventando", () => {
  const result = groundAnalysis(hallucinated, arthur);
  assert.equal(result.summary, EXPECTED_ARTHUR);
  assert.equal(result.contact_info.name.value, null);
  assert.deepEqual(result.commercial.products_of_interest, []);
  assert.equal(result.commercial.product_identified, false);
  assert.deepEqual(result.commercial.objections, []);
  assert.ok(!result.sale_signals.some((s) => s.type === "confirmed_sale"), "não pode virar venda confirmada");
  assert.ok(!JSON.stringify(result).includes("João"));
  assert.ok(!/cabelo|caro\b/i.test(result.summary));
  assert.ok(result.discarded.includes("nome") && result.discarded.includes("produto") && result.discarded.includes("objecao"));
  assert.ok(result.purchase_probability <= 0.5);
});

test("Rede Sanmar / Arthur IDX: resumo fiel quando a IA falha (só regras)", () => {
  const result = groundAnalysis(null, arthur);
  assert.equal(result.summary, EXPECTED_ARTHUR);
  assert.equal(result.stage, "high_intent");
  assert.equal(result.sale_signals[0].evidence, "Quero comprar");
});

test("prompt não contém exemplos que o modelo possa copiar", () => {
  const prompt = SYSTEM_PROMPT + buildUserPrompt(arthur);
  for (const forbidden of ["João", "Silva", "cabelo", "Corte", "Achei caro", "barbearia", "abc12345"]) {
    assert.ok(!prompt.includes(forbidden), `prompt contém "${forbidden}"`);
  }
  assert.ok(prompt.includes("Arthur IDX"), "nome real do WhatsApp vai no prompt");
  assert.ok(prompt.includes("Eu estou interessado") && prompt.includes("Quero comprar"));
});

test("análise antiga com João Silva/corte de cabelo é detectada como contaminada", () => {
  assert.equal(
    isAnalysisContaminated({ extracted_name: "João Silva", products_of_interest: ["Corte de cabelo"], objections: ["Achei caro"] }, arthur),
    true,
  );
  const fresh = groundAnalysis(null, arthur);
  assert.equal(
    isAnalysisContaminated({ extracted_name: fresh.contact_info.name.value, products_of_interest: [], objections: [] }, arthur),
    false,
  );
});

test("farmácia: produto citado pelo cliente é aceito, produto inventado é descartado", () => {
  const ctx = {
    tenantName: "Farmácia Central",
    businessSegment: "farmácia",
    contactName: "Maria",
    messages: [msg("f1", "inbound", "Vocês têm dipirona?"), msg("f2", "outbound", "Temos sim, R$ 12,90")],
  };
  const result = groundAnalysis({ produtos: [{ nome: "Dipirona", trecho: "dipirona" }, { nome: "Amoxicilina", trecho: "x" }] }, ctx);
  assert.deepEqual(result.commercial.products_of_interest, [{ name: "Dipirona" }]);
  assert.equal(result.stage, "interest");
  assert.equal(result.summary, "Maria demonstrou interesse em Dipirona. Nenhuma objeção foi identificada.");
});

test("clínica: agendar consulta é intenção forte, não venda", () => {
  const ctx = { contactName: "Paulo", messages: [msg("c1", "inbound", "Quero agendar uma consulta para amanhã")] };
  const result = groundAnalysis({ sinais: [{ tipo: "confirmed_sale", trecho: "Quero agendar uma consulta" }] }, ctx);
  assert.equal(result.stage, "high_intent");
  assert.ok(!result.sale_signals.some((s) => s.type === "confirmed_sale"));
});

test("veterinária: 'vou pensar' depois do interesse é desistência", () => {
  const ctx = {
    contactName: "Ana",
    messages: [msg("v1", "inbound", "Quanto custa a vacina?"), msg("v2", "outbound", "R$ 90"), msg("v3", "inbound", "Vou pensar e te aviso")],
  };
  const result = groundAnalysis(null, ctx);
  assert.equal(result.stage, "abandonment");
  assert.match(result.summary, /^Ana indicou que não pretende seguir com a compra agora\./);
});

test("loja: negociação, compra declarada e venda confirmada pela empresa", () => {
  const negotiation = groundAnalysis(null, { contactName: "Rui", messages: [msg("l1", "inbound", "Tem desconto no pix?")] });
  assert.equal(negotiation.stage, "negotiation");

  const declared = groundAnalysis({ sinais: [{ tipo: "confirmed_sale", trecho: "Já paguei" }] }, {
    contactName: "Rui",
    messages: [msg("l2", "inbound", "Quero comprar o tênis"), msg("l3", "inbound", "Já paguei")],
  });
  assert.equal(declared.stage, "declared_purchase", "declaração do cliente não é venda confirmada");
  assert.match(declared.summary, /pagamento ainda não foi confirmado/);

  const confirmed = groundAnalysis(null, {
    contactName: "Rui",
    messages: [msg("l4", "inbound", "Quero comprar o tênis"), msg("l5", "inbound", "Já paguei"), msg("l6", "outbound", "Pagamento confirmado, obrigado!")],
  });
  assert.equal(confirmed.stage, "confirmed_sale");
});

test("objeção só existe se o cliente escreveu", () => {
  const said = groundAnalysis({ objecoes: [{ texto: "achei caro", trecho: "Achei caro" }] }, {
    contactName: "Bia",
    messages: [msg("o1", "inbound", "Quanto custa?"), msg("o2", "outbound", "R$ 300"), msg("o3", "inbound", "Achei caro")],
  });
  assert.deepEqual(said.commercial.objections, [{ text: "achei caro" }]);
  assert.match(said.summary, /Objeções identificadas: achei caro\./);
});

test("nome dito pelo cliente é aceito; nome inventado não", () => {
  const ctx = { contactName: null, messages: [msg("n1", "inbound", "Oi, meu nome é Carla Souza e quero saber o valor")] };
  assert.equal(groundAnalysis({ nome_cliente: "Carla Souza" }, ctx).contact_info.name.value, "Carla Souza");
  assert.equal(groundAnalysis({ nome_cliente: "Fernanda Lima" }, ctx).contact_info.name.value, null);
  assert.match(groundAnalysis({ nome_cliente: "Fernanda Lima" }, ctx).summary, /^O cliente demonstrou interesse/);
});

test("isolamento: dados de outra empresa nunca entram na análise", () => {
  const empresaA = { tenantName: "Pet Shop A", contactName: "Lucas", messages: [msg("a1", "inbound", "Tem ração de gato?")] };
  const empresaB = { tenantName: "Clínica B", contactName: "Helena", messages: [msg("b1", "inbound", "Quero marcar exame de sangue")] };
  const promptA = buildUserPrompt(empresaA);
  assert.ok(!promptA.includes("Helena") && !promptA.includes("exame") && !promptA.includes("Clínica B"));
  // IA "vazando" contexto da empresa B na análise da A.
  const leaked = groundAnalysis({ nome_cliente: "Helena", produtos: [{ nome: "Exame de sangue", trecho: "exame de sangue" }] }, empresaA);
  assert.equal(leaked.contact_info.name.value, null);
  assert.deepEqual(leaked.commercial.products_of_interest, []);
  assert.ok(!JSON.stringify(leaked).includes("Helena"));
  assert.match(leaked.summary, /^Lucas demonstrou interesse/);
});

test("JSON inválido do modelo não quebra a análise", () => {
  assert.equal(parseModelJson("isso não é json"), null);
  assert.deepEqual(parseModelJson('```json\n{"produtos": []}\n```'), { produtos: [] });
  assert.equal(groundAnalysis(parseModelJson("{quebrado"), arthur).summary, EXPECTED_ARTHUR);
});

test("Edge Functions: contagem absoluta, isolamento por tenant e sem análise anterior no prompt", () => {
  const analyze = read("supabase/functions/ai-analyze/index.ts");
  assert.match(analyze, /messages_analyzed_count: messagesCount/);
  assert.doesNotMatch(analyze, /existing\.messages_analyzed_count \?\? 0\) \+/);
  assert.doesNotMatch(analyze, /ANÁLISE ANTERIOR/);
  assert.match(analyze, /\.from\("whatsapp_messages"\)[\s\S]{0,120}\.eq\("tenant_id", tenantId\)[\s\S]{0,60}\.eq\("conversation_id", conv\.id\)/);
  assert.match(analyze, /reprocess_tenant/);
  assert.match(analyze, /status: "rejected"/);
  const ingest = read("supabase/functions/n8n-webhook/index.ts");
  assert.match(ingest, /instance_tenant_mismatch/);
  assert.match(ingest, /sentByCompany \? undefined/);
});
