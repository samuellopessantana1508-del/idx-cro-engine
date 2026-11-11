import { deepStrictEqual as assertEquals } from "node:assert";
import { parseRules, parseWhen, zonedToUtcIso } from "../../supabase/functions/_shared/assistant-rules.ts";

const TZ = "America/Sao_Paulo";
// quarta-feira, 11/11/2026 10:00 em São Paulo (13:00 UTC)
const NOW = new Date("2026-11-11T13:00:00Z");

Deno.test("datas relativas em português", () => {
  assertEquals(parseWhen("liga amanhã às 14h", TZ, NOW), "2026-11-12T14:00");
  assertEquals(parseWhen("pediu para ligar sexta às 15:30", TZ, NOW), "2026-11-13T15:30");
  assertEquals(parseWhen("retornar segunda de manhã", TZ, NOW), "2026-11-16T09:00");
  assertEquals(parseWhen("me liga quarta", TZ, NOW), "2026-11-18T09:00");
  assertEquals(parseWhen("reunião dia 20 às 10", TZ, NOW), "2026-11-20T10:00");
  assertEquals(parseWhen("visita 05/12 3 da tarde", TZ, NOW), "2026-12-05T09:00".replace("09:00", "15:00"));
  assertEquals(parseWhen("liga às 9h", TZ, NOW), "2026-11-12T09:00"); // 9h já passou hoje
  assertEquals(parseWhen("liga às 16h", TZ, NOW), "2026-11-11T16:00");
  assertEquals(parseWhen("depois de amanhã", TZ, NOW), "2026-11-13T09:00");
  assertEquals(parseWhen("conversamos bem", TZ, NOW), null);
});

Deno.test("fuso de São Paulo para UTC", () => {
  assertEquals(zonedToUtcIso("2026-11-12T14:00", TZ), "2026-11-12T17:00:00.000Z");
});

Deno.test("resultado, valor, objeção, contato", () => {
  const r = parseRules("Falei com o Carlos da Drogaria Nova Esperança, achou caro mas quer proposta de R$ 1.500,00, liga sexta 14h", TZ, NOW);
  assertEquals(r.dial_outcome, "callback");
  assertEquals(r.value, 1500);
  assertEquals(r.objection, "Preço / orçamento");
  assertEquals(r.contact.name, "Carlos");
  assertEquals(r.contact.company, "Drogaria Nova Esperança");
  assertEquals(r.wants_proposal, true);
  assertEquals(r.due_local, "2026-11-13T14:00");
  assertEquals(parseRules("não atendeu, caixa postal", TZ, NOW).dial_outcome, "no_answer");
  assertEquals(parseRules("marquei reunião quinta às 10h com a dona", TZ, NOW).dial_outcome, "meeting");
  assertEquals(parseRules("sem interesse, já tem fornecedor", TZ, NOW).objection, "Já tem fornecedor");
  assertEquals(parseRules("número errado", TZ, NOW).dial_outcome, "invalid");
  assertEquals(parseRules("falei com o Rui da Drogaria São João 2, quer proposta", TZ, NOW).contact.company, "Drogaria São João 2");
  assertEquals(parseRules("liguei na Farmácia Popular do Centro hoje", TZ, NOW).contact.company, "Farmácia Popular do Centro");
  assertEquals(parseRules("cliente novo telefone (31) 98765-4321 quer 3 mil", TZ, NOW).contact.phone, "31987654321");
  assertEquals(parseRules("cliente novo quer 3 mil", TZ, NOW).value, 3000);
});
