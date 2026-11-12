// Núcleo das automações (sem banco). Rode: node --import tsx --test tests/flows/flow-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchKeyword, interpolate, inBusinessHours, nextBusinessTime, matchTrigger, validateGraph, startState, step, outputsOf,
  type Graph, type FlowContext, type FlowEffects, type OutMsg, type RunState,
} from "../../supabase/functions/_shared/flow-core.ts";

function fx() {
  const sent: string[] = [], tags: string[] = [], log: string[] = [], calls: string[] = [];
  let webhookOk = true;
  const effects: FlowEffects = {
    async send(m: OutMsg) { sent.push(m.kind === "text" ? m.text : `[${m.mediaType}] ${m.url} ${m.caption ?? ""}`); },
    async tag(a, t) { tags.push(`${a}:${t}`); },
    async setField(f, v) { calls.push(`field:${f}=${v}`); },
    async crmDeal(c) { calls.push(`deal:${c.action}:${c.stage_id ?? ""}`); },
    async task(c) { calls.push(`task:${c.title}`); },
    async assign() { calls.push("assign"); },
    async notify(c) { calls.push(`notify:${c.message}`); },
    async conversion(l) { calls.push(`conv:${l}`); },
    async webhook() { return webhookOk ? { ok: true, status: 200, data: { ok: 1 } } : { ok: false, status: 500 }; },
    async ai(c) { return `IA respondeu a "${c.message}"`; },
    async handoff() { calls.push("handoff"); },
    async optout() { calls.push("optout"); },
    log(n, e) { log.push(`${n}:${e}`); },
  };
  return { effects, sent, tags, log, calls, setWebhook: (v: boolean) => { webhookOk = v; } };
}
const ctx = (f: ReturnType<typeof fx>, over: Partial<FlowContext> = {}): FlowContext => ({
  now: new Date("2026-11-12T13:00:00Z"), tz: "America/Sao_Paulo", contact: { name: "Ana Souza", phone: "5511999990000", tags: ["cliente"] },
  random: () => 0, effects: f.effects, ...over,
});
const N = (id: string, type: any, config: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { config } });
const E = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}-${target}-${sourceHandle}`, source, target, sourceHandle });

test("palavra-chave como no original: erro de digitação, sinônimo, acento", () => {
  assert.equal(matchKeyword("Qual o preço?", "preco"), true);
  assert.equal(matchKeyword("qual o prexo", "preco"), true);
  assert.equal(matchKeyword("quanto custa?", "preco"), true);
  assert.equal(matchKeyword("bom dia!", "oi"), true);
  assert.equal(matchKeyword("quero comprar", "preco"), false);
  assert.equal(matchKeyword("SIM", "sim", "exact"), true);
  assert.equal(matchKeyword("sim, claro", "sim", "exact"), false);
});

test("variáveis e sorteio {a|b}", () => {
  const t = interpolate("{Oi|Olá} {primeiro_nome}, sua resposta: {resposta} {var.cidade} {xyz}", { name: "Ana Souza" }, { lastResponse: "ok", cidade: "Santos" }, () => 0.99);
  assert.equal(t, "Olá Ana, sua resposta: ok Santos {xyz}");
});

test("horário comercial no fuso da empresa", () => {
  const cfg = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
  assert.equal(inBusinessHours(new Date("2026-11-12T13:00:00Z"), "America/Sao_Paulo", cfg), true);   // qui 10h
  assert.equal(inBusinessHours(new Date("2026-11-12T22:00:00Z"), "America/Sao_Paulo", cfg), false);  // qui 19h
  assert.equal(inBusinessHours(new Date("2026-11-14T13:00:00Z"), "America/Sao_Paulo", cfg), false);  // sáb
  assert.equal(nextBusinessTime(new Date("2026-11-13T22:30:00Z"), "America/Sao_Paulo", cfg).toISOString(), "2026-11-16T12:00:00.000Z"); // sex 19h30 → seg 9h
});

test("gatilhos", () => {
  const g = (config: any): Graph => ({ nodes: [N("t", "trigger", config)], edges: [] });
  assert.equal(matchTrigger(g({ kind: "keyword", keywords: "preço\norçamento" }), { kind: "message", text: "me passa o orcamento", firstMessage: false }), true);
  assert.equal(matchTrigger(g({ kind: "keyword", keywords: "preço" }), { kind: "message", text: "oi", firstMessage: false }), false);
  assert.equal(matchTrigger(g({ kind: "first_message" }), { kind: "message", text: "oi", firstMessage: false }), false);
  assert.equal(matchTrigger(g({ kind: "first_message" }), { kind: "message", text: "oi", firstMessage: true }), true);
  assert.equal(matchTrigger(g({ kind: "tag", tag: "Quente" }), { kind: "tag", tag: "quente" }), true);
  assert.equal(matchTrigger(g({ kind: "message", onlyOutsideHours: true }), { kind: "message", text: "oi", firstMessage: false }, new Date("2026-11-12T13:00:00Z")), false);
  assert.equal(matchTrigger(g({ kind: "message", onlyOutsideHours: true }), { kind: "message", text: "oi", firstMessage: false }, new Date("2026-11-12T23:30:00Z")), true);
});

const menuFlow: Graph = {
  nodes: [
    N("t", "trigger", { kind: "first_message" }),
    N("hi", "send_text", { text: "{Oi|Olá} {primeiro_nome}! 👋" }),
    N("m", "send_menu", { text: "Como posso ajudar?", options: "Preços\nFalar com atendente", timeout: 2, timeoutUnit: "hours" }),
    N("p", "send_text", { text: "Nossos preços: ..." }),
    N("h", "handoff", { message: "Um atendente já vai te responder" }),
    N("o", "send_text", { text: "Não entendi 🙂" }),
    N("tm", "tag", { tag: "sem-resposta" }),
  ],
  edges: [E("t", "hi"), E("hi", "m"), E("m", "p", "opt0"), E("m", "h", "opt1"), E("m", "o", "other"), E("m", "tm", "timeout")],
};

test("menu: envia opções numeradas, espera e segue pela resposta (número ou texto)", async () => {
  const f = fx();
  let s = await step(menuFlow, startState(menuFlow, { text: "oi" }), ctx(f));
  assert.equal(s.status, "waiting");
  assert.equal(s.wait?.kind, "menu");
  assert.equal(s.wait?.until, "2026-11-12T15:00:00.000Z");
  assert.deepEqual(f.sent[0], "Oi Ana! 👋");
  assert.match(f.sent[1], /Como posso ajudar\?\n\n1️⃣ Preços\n2️⃣ Falar com atendente/);
  const s2 = await step(menuFlow, s, ctx(f), { message: "2" });
  assert.equal(s2.status, "completed");
  assert.ok(f.calls.includes("handoff"));
  const f2 = fx();
  s = await step(menuFlow, startState(menuFlow), ctx(f2));
  s = await step(menuFlow, s, ctx(f2), { message: "quero saber os preços" });
  assert.equal(f2.sent.at(-1), "Nossos preços: ...");
  const f3 = fx();
  s = await step(menuFlow, startState(menuFlow), ctx(f3));
  s = await step(menuFlow, s, ctx(f3), { message: "batata" });
  assert.equal(f3.sent.at(-1), "Não entendi 🙂");
  const f4 = fx();
  s = await step(menuFlow, startState(menuFlow), ctx(f4));
  s = await step(menuFlow, s, ctx(f4), { timeout: true });
  assert.deepEqual(f4.tags, ["add:sem-resposta"]);
});

test("pergunta: salva a resposta e usa depois; follow-up quando não responde", async () => {
  const g: Graph = {
    nodes: [N("t", "trigger", { kind: "manual" }), N("q", "ask", { text: "Qual sua cidade?", saveAs: "cidade", saveTo: "cidade" }),
      N("ok", "send_text", { text: "Atendemos {var.cidade}!" }), N("fu", "send_text", { text: "Oi {primeiro_nome}, ainda está aí?" })],
    edges: [E("t", "q"), E("q", "ok", "answered"), E("q", "fu", "timeout")],
  };
  const f = fx();
  let s = await step(g, startState(g), ctx(f));
  s = await step(g, s, ctx(f), { message: " Campinas " });
  assert.equal(f.sent.at(-1), "Atendemos Campinas!");
  assert.ok(f.calls.includes("field:cidade=Campinas"));
  const f2 = fx();
  s = await step(g, startState(g), ctx(f2));
  s = await step(g, s, ctx(f2), { timeout: true });
  assert.equal(f2.sent.at(-1), "Oi Ana, ainda está aí?");
});

test("esperar, condição, teste A/B, ações de CRM e webhook com caminho de erro", async () => {
  const g: Graph = {
    nodes: [N("t", "trigger", { kind: "manual" }), N("w", "wait", { amount: 2, unit: "days" }),
      N("c", "condition", { rules: [{ field: "has_tag", value: "cliente" }, { field: "business_hours", op: "equals" }], match: "all" }),
      N("ab", "split_ab", { percent: 30 }), N("d", "crm_deal", { action: "create", title: "Lead {nome}" }),
      N("k", "task", { title: "Ligar para {nome}", dueInHours: 2 }), N("wh", "webhook", { url: "https://x.test/h" }),
      N("err", "notify", { message: "Webhook falhou para {nome}" }), N("no", "conversion", { label: "x" })],
    edges: [E("t", "w"), E("w", "c"), E("c", "ab", "yes"), E("c", "no", "no"), E("ab", "d", "a"), E("ab", "k", "b"), E("d", "wh"), E("wh", "err", "error")],
  };
  const f = fx();
  f.setWebhook(false);
  let s = await step(g, startState(g), ctx(f));
  assert.equal(s.wait?.kind, "delay");
  assert.equal(s.wait?.until, "2026-11-14T13:00:00.000Z");
  s = await step(g, s, ctx(f));
  assert.deepEqual(f.calls, ["deal:create:", "notify:Webhook falhou para Ana Souza"]);
  assert.equal(s.status, "completed");
  const f2 = fx();
  s = await step(g, await step(g, startState(g), ctx(f2, { random: () => 0.5 })), ctx(f2, { random: () => 0.5 }));
  assert.deepEqual(f2.calls, ["task:Ligar para Ana Souza"]);
});

test("aguardar resposta: respondeu x não respondeu", async () => {
  const g: Graph = { nodes: [N("t", "trigger", { kind: "manual" }), N("w", "wait_response", { timeout: 1, timeoutUnit: "days" }), N("y", "send_text", { text: "Obrigado por responder: {resposta}" }), N("n", "send_text", { text: "Lembrete" })],
    edges: [E("t", "w"), E("w", "y", "replied"), E("w", "n", "timeout")] };
  const f = fx();
  let s = await step(g, startState(g, { text: "oi" }), ctx(f));
  assert.equal(s.vars.lastResponse, "");
  s = await step(g, s, ctx(f), { message: "tenho interesse" });
  assert.equal(f.sent.at(-1), "Obrigado por responder: tenho interesse");
});

test("IA, mídia, horário comercial e contato que pediu SAIR", async () => {
  const g: Graph = { nodes: [N("t", "trigger", { kind: "message" }), N("bh", "business_hours", { start: "09:00", end: "18:00" }), N("ai", "ai_reply", { prompt: "Seja breve" }), N("img", "send_media", { mediaType: "image", url: "https://x.test/a.jpg", caption: "Catálogo de {primeiro_nome}" })],
    edges: [E("t", "bh"), E("bh", "ai"), E("ai", "img")] };
  const f = fx();
  const night = ctx(f, { now: new Date("2026-11-12T23:00:00Z") });
  let s = await step(g, startState(g, { text: "quanto custa?" }), night);
  assert.equal(s.wait?.kind, "business_hours");
  assert.equal(s.wait?.until, "2026-11-13T12:00:00.000Z");
  s = await step(g, s, ctx(f, { now: new Date("2026-11-13T12:00:00Z") }));
  assert.deepEqual(f.sent, ['IA respondeu a "quanto custa?"', "[image] https://x.test/a.jpg Catálogo de Ana"]);
  const f2 = fx();
  const r = await step(g, startState(g), ctx(f2, { contact: { name: "X", optedOut: true } }));
  assert.equal(r.status, "cancelled");
  assert.equal(f2.sent.length, 0);
});

test("validação: gatilho, mensagens vazias, blocos soltos e laço sem espera", () => {
  const bad: Graph = { nodes: [N("t", "trigger", { kind: "keyword" }), N("a", "send_text", { text: "" }), N("b", "send_text", { text: "x" }), N("z", "send_text", { text: "solto" })],
    edges: [E("t", "a"), E("a", "b"), E("b", "a")] };
  const msgs = validateGraph(bad).map((i) => i.message);
  assert.ok(msgs.includes("Informe as palavras-chave"));
  assert.ok(msgs.includes("Escreva a mensagem"));
  assert.ok(msgs.some((m) => /solto/.test(m)));
  assert.ok(msgs.some((m) => /círculo/.test(m)));
  assert.deepEqual(validateGraph(menuFlow), []);
  assert.deepEqual(outputsOf(menuFlow.nodes[2]).map((o) => o.id), ["opt0", "opt1", "other", "timeout"]);
});

test("laço com espera é permitido e não trava", async () => {
  const g: Graph = { nodes: [N("t", "trigger", { kind: "manual" }), N("s", "send_text", { text: "ping" }), N("w", "wait", { amount: 1, unit: "minutes" })],
    edges: [E("t", "s"), E("s", "w"), E("w", "s")] };
  assert.deepEqual(validateGraph(g), []);
  const f = fx();
  let s: RunState = await step(g, startState(g), ctx(f));
  for (let i = 0; i < 3; i++) s = await step(g, s, ctx(f));
  assert.equal(f.sent.length, 4);
  assert.equal(s.status, "waiting");
});

test("variável vazia não deixa espaço sobrando, pontuação do usuário fica", () => {
  assert.equal(interpolate("Oi {primeiro_nome}!", {}, {}), "Oi!");
  assert.equal(interpolate("Oi {primeiro_nome}, tudo bem?", {}, {}), "Oi, tudo bem?");
  assert.equal(interpolate("Olá {nome} da {empresa} :)", { name: "Ana" }, {}), "Olá Ana da :)");
  assert.equal(interpolate("Preços: ... e mais !", {}, {}), "Preços: ... e mais !");
});
