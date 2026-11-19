// Automação de prospecção de farmácias (IDX): todos os caminhos de todas as opções.
// Rode: node --import tsx --test tests/flows/farmacias.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraph, startState, step, outputsOf, interpolate, type FlowContext, type FlowEffects, type OutMsg, type RunState } from "../../supabase/functions/_shared/flow-core.ts";
// @ts-ignore módulo .mjs sem tipos
import { farmaciasGraph, OPENER, FOLLOWUPS, CAMPAIGN } from "../../scripts/idx/farmacias.mjs";

const stages = { novo: "st-novo", followup: "st-fu", reuniao: "st-reuniao" };
const graph = farmaciasGraph({ campaignId: "camp-1", stages });

function sim() {
  const sent: string[] = [], calls: string[] = [], fields: Record<string, string> = {};
  const effects: FlowEffects = {
    async send(m: OutMsg) { sent.push(m.kind === "text" ? m.text : `[${m.mediaType}]`); },
    async tag(a, t) { calls.push(`tag:${a}:${t}`); },
    async setField(f, v) { fields[f] = v; calls.push(`field:${f}`); },
    async crmDeal(c) { calls.push(`deal:${c.action}:${c.stage_id}`); },
    async task(c) { calls.push(`task:${c.type}:${c.title}`); },
    async assign() { calls.push("assign"); },
    async notify(c) { calls.push(`notify:${c.message}`); },
    async conversion(l) { calls.push(`conv:${l}`); },
    async webhook() { return { ok: true, status: 200 }; },
    async ai() { return ""; },
    async handoff() { calls.push("handoff"); },
    async optout() { calls.push("optout"); },
    log() {},
  };
  const ctx: FlowContext = { now: new Date("2026-11-18T13:00:00Z"), tz: "America/Sao_Paulo", contact: { name: "Drogaria Bom Preço", phone: "5564999990000", tags: [] }, random: () => 0, effects };
  return { sent, calls, fields, ctx };
}

/** Conversa: primeira resposta ao disparo e depois cada resposta (null = 24 h sem resposta). */
async function talk(first: string, ...replies: (string | null)[]) {
  const s = sim();
  let st: RunState = await step(graph, startState(graph, { text: first }), s.ctx);
  for (const r of replies) {
    assert.equal(st.status, "waiting", `esperava resposta antes de “${r}” (nó ${st.node})`);
    st = await step(graph, st, s.ctx, r === null ? { timeout: true } : { message: r });
  }
  for (const m of s.sent) assert.doesNotMatch(m, /\{[a-z_.]+\}/i, `variável sem trocar: ${m}`);
  return { ...s, st };
}
const has = (calls: string[], prefix: string) => calls.some((c) => c.startsWith(prefix));

test("grafo válido: todas as saídas de todos os blocos estão ligadas", () => {
  const errors = validateGraph(graph).filter((i) => i.level === "error");
  assert.deepEqual(errors, []);
  const ids = new Set(graph.nodes.map((n: any) => n.id));
  for (const e of graph.edges) { assert.ok(ids.has(e.source), e.source); assert.ok(ids.has(e.target), `${e.source} → ${e.target}`); }
  for (const n of graph.nodes) {
    for (const o of outputsOf(n)) {
      const ok = graph.edges.some((e: any) => e.source === n.id && (e.sourceHandle ?? "next") === o.id);
      assert.ok(ok, `saída “${o.id}” do bloco ${n.id} sem ligação`);
    }
  }
});

test("disparo, follow-ups e limites do disparo", () => {
  assert.match(OPENER, /1️⃣ Sim, sou eu/);
  assert.match(OPENER, /Aqui é o Arthur, da IDX/);
  assert.equal(FOLLOWUPS.length, 5);
  const hours = FOLLOWUPS.map((f: any) => f.after_hours);
  assert.deepEqual([...hours].sort((a, b) => a - b), hours);
  assert.ok(CAMPAIGN.min_delay_sec >= 5 && CAMPAIGN.max_delay_sec >= CAMPAIGN.min_delay_sec);
  for (const t of [OPENER, ...FOLLOWUPS.map((f: any) => f.text)]) {
    assert.doesNotMatch(t, /tr[aá]fego|an[uú]ncio pago|gr[aá]tis/i, "não falar em tráfego pago nem “grátis”");
    assert.doesNotMatch(t, /https?:\/\//, "sem link na prospecção fria");
  }
  assert.doesNotMatch(interpolate(OPENER, { name: "X" } as any, {}, () => 0), /\{[a|]/);
});

test("caminho completo: confirma o dono → 2 perguntas → reunião por vídeo", async () => {
  const r = await talk("1", "1", "3", "1", "2", "quinta às 10h");
  assert.equal(r.st.status, "completed");
  assert.ok(has(r.calls, "deal:upsert:st-novo") && has(r.calls, "deal:upsert:st-reuniao"));
  assert.ok(has(r.calls, "task:meeting:Confirmar reunião de 30 min com Drogaria Bom Preço"));
  assert.ok(has(r.calls, "notify:📅"));
  assert.deepEqual(
    { g: r.fields.google_posicao_percebida, rc: r.fields.recompra, per: r.fields.periodo_reuniao, h: r.fields.horario_reuniao },
    { g: "Acha que aparece", rc: "Depende do cliente", per: "Tarde", h: "quinta às 10h" });
  const all = r.sent.join("\n");
  assert.match(all, /calendly\.com\/idxparasuaempresa/);
  assert.match(all, /remédio de uso contínuo/);
  assert.match(all, /8 mil cliques/);
  assert.doesNotMatch(all, /tr[aá]fego|gr[aá]tis|—/i);
  assert.ok(!has(r.calls, "handoff"));
});

test("respostas por texto também avançam (“sou eu”, “pode ser”, período por texto)", async () => {
  const r = await talk("Sou eu mesmo, pode falar", "não sei", "a gente liga pro cliente às vezes", "Sim, pode ser", "de manhã cedo", "sexta 9h");
  assert.equal(r.st.status, "completed");
  assert.ok(has(r.calls, "deal:upsert:st-reuniao"));
  assert.equal(r.fields.periodo_reuniao, "Manhã"); // texto livre que lembra a opção conta como a opção
});

test("“Eu sou o dono” não vai para o caminho de outra pessoa", async () => {
  const r = await talk("eu sou o dono");
  assert.equal(r.st.node, "q1");
});

test("prefere ligação", async () => {
  const r = await talk("1", "2", "1", "2", "amanhã às 15h");
  assert.equal(r.st.status, "completed");
  assert.ok(has(r.calls, "task:callback:Ligar para") && has(r.calls, "deal:upsert:st-fu") && has(r.calls, "notify:📞"));
  assert.equal(r.fields.horario_ligacao, "amanhã às 15h");
});

test("agora não na reunião → diagnóstico por escrito (sim e não)", async () => {
  const a = await talk("1", "3", "3", "3", "1");
  assert.ok(has(a.calls, "task:whatsapp:Enviar diagnóstico") && has(a.calls, "deal:upsert:st-fu"));
  const b = await talk("1", "3", "3", "3", "2");
  assert.ok(has(b.calls, "tag:add:farmácia: agora não") && !has(b.calls, "task:whatsapp"));
});

test("primeira resposta: agora não, não, outra pessoa, SAIR", async () => {
  for (const msg of ["3", "Agora não", "não", "Não tenho interesse"]) {
    const r = await talk(msg);
    assert.equal(r.st.status, "completed", msg);
    assert.ok(has(r.calls, "tag:add:farmácia: agora não"), msg);
    assert.ok(!has(r.calls, "deal:"), `${msg}: não abre negócio`);
  }
  const o = await talk("2", "É o Carlos, 64 99999-1234");
  assert.ok(has(o.calls, "task:whatsapp:Falar com o responsável") && o.fields.responsavel === "É o Carlos, 64 99999-1234");
  const ot = await talk("não sou eu, é o dono", null);
  assert.equal(ot.st.status, "completed");
  assert.ok(!has(ot.calls, "task:"));
  for (const msg of ["SAIR", "sair", "Parar", "não me mande mais mensagem"]) {
    const r = await talk(msg);
    assert.ok(has(r.calls, "optout") && has(r.calls, "tag:add:opt-out marketing"), msg);
  }
});

test("SAIR no meio da conversa, em qualquer pergunta", async () => {
  for (const before of [[], ["1"], ["1", "1"]]) {
    const r = await talk("1", ...before, "sair");
    assert.ok(has(r.calls, "optout"), `depois de ${before.length} respostas`);
  }
  const d = await talk("1", "1", "1", "1", "1", "sair");
  assert.ok(has(d.calls, "optout"), "no pedido de horário");
  const l = await talk("1", "1", "1", "2", "parar");
  assert.ok(has(l.calls, "optout"), "no horário da ligação");
  const p = await talk("2", "sair");
  assert.ok(has(p.calls, "optout"), "no pedido do responsável");
});

test("pergunta ou objeção fora do roteiro passa para a equipe", async () => {
  for (const [replies, msg] of [[[], "quanto custa?"], [["1"], "já tenho agência"], [["1", "1"], "qual o valor"], [["1", "1"], "como funciona isso?"]] as const) {
    const r = await talk("1", ...replies, msg);
    assert.equal(r.st.status, "completed", msg);
    assert.ok(has(r.calls, "handoff") && has(r.calls, "notify:💬"), msg);
  }
  const e = await talk("1", "1", "1", "3", "me manda o preço");
  assert.ok(has(e.calls, "handoff"), "texto livre no diagnóstico por escrito");
});

test("24 h sem resposta em cada etapa cria tarefa (sem insistência automática)", async () => {
  const cases: [string[], string][] = [
    [[], "Conversa parou (Google)"], [["1"], "Conversa parou (Recompra)"], [["1", "1"], "Convite sem resposta"],
    [["1", "1", "1"], "Aceitou a reunião mas não passou o horário"], [["1", "1", "1", "1"], "Aceitou a reunião mas não passou o horário"],
    [["1", "1", "2"], "Pediu ligação mas não passou o horário"],
  ];
  for (const [replies, title] of cases) {
    const r = await talk("1", ...replies, null);
    assert.equal(r.st.status, "completed", title);
    assert.ok(r.calls.some((c) => c.includes(title)), `${title}: ${r.calls.join(" | ")}`);
  }
  const e = await talk("1", "1", "1", "3", null);
  assert.equal(e.st.status, "completed");
});

test("emoji de número e várias mensagens seguidas", async () => {
  for (const first of ["1️⃣", "1", "1.", "Bom dia\n1️⃣", "Sim, sou eu", "sou eu mesma"]) {
    const r = await talk(first);
    assert.equal(r.st.node, "q1", JSON.stringify(first));
  }
  const a = await talk("1️⃣", "1️⃣", "Bom dia\n3️⃣");
  assert.deepEqual([a.fields.google_posicao_percebida, a.fields.recompra], ["Acha que aparece", "Depende do cliente"]);
  assert.equal(a.st.node, "oferta");
  const b = await talk("Bom dia\n2️⃣");
  assert.equal(b.st.node, "ask_resp");
  const c = await talk("Olá\n3️⃣");
  assert.ok(has(c.calls, "tag:add:farmácia: agora não"));
  const d = await talk("1", "3 por dia");
  assert.equal(d.fields.google_posicao_percebida, "3 por dia", "“3 por dia” é resposta, não a opção 3");
});

test("resposta automática da farmácia não conta como resposta da pessoa", async () => {
  const auto = "‎Drograria Brisas agradece seu contato. Como podemos ajudar?";
  const a = await talk(auto);
  assert.equal(a.st.node, "w_auto");
  assert.equal(a.sent.length, 0, "não responde a robô");
  const b = await talk(auto, "1️⃣");
  assert.equal(b.st.node, "q1");
  const c = await talk("A Farmácia X agradece a sua mensagem. Informamos que nosso horário de atendimento é de segunda a sexta", null, "1");
  assert.equal(c.st.node, "q1", "40 min sem a pessoa: explica, pergunta de novo e segue");
  assert.match(c.sent[0], /Arthur, da IDX/);
  const d = await talk(auto, "Olá! Seja bem-vindo à Farmácia Y 💊");
  assert.equal(d.st.node, "w_auto2", "segunda mensagem automática: só espera");
  const e = await talk("Olá! 😊 Seja bem-vindo à Miligrama 💊\nTrabalhamos com fórmulas", "Não tenho interesse");
  assert.ok(has(e.calls, "tag:add:farmácia: agora não"));
});

test("só cumprimentou ou perguntou quem é: explica e pergunta de novo", async () => {
  for (const first of ["Bom dia", "Oi, tudo bem?", "quem é?", "Boa tarde! Quem fala?", "Do que se trata?"]) {
    const r = await talk(first);
    assert.equal(r.st.node, "confirma", first);
  }
  assert.equal((await talk("Bom dia", "1")).st.node, "q1");
  assert.equal((await talk("oi", "Sou eu sim")).st.node, "q1");
  assert.equal((await talk("Oi", "2")).st.node, "ask_resp");
  assert.ok(has((await talk("Oi", "3")).calls, "tag:add:farmácia: agora não"));
  assert.equal((await talk("Oi", "oi?")).st.node, "q1", "não explica duas vezes");
});

test("recusa no meio das perguntas encerra com educação", async () => {
  for (const msg of ["Não tenho interesse", "não, obrigado", "agora não"]) {
    const r = await talk("1", "1", msg);
    assert.ok(has(r.calls, "tag:add:farmácia: agora não"), msg);
    assert.equal(r.st.status, "completed");
  }
  for (const msg of ["Não tenho farmácia mais", "número errado", "Vendi a farmácia"]) {
    assert.ok(has((await talk(msg)).calls, "tag:add:farmácia: agora não"), msg);
  }
});
