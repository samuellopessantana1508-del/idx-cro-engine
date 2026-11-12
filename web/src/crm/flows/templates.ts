// Modelos prontos de automação (o usuário escolhe um e ajusta).
import type { Graph, NodeType } from "../../../../supabase/functions/_shared/flow-core";

const X = 320, Y = 170;
const n = (id: string, type: NodeType, col: number, row: number, config: Record<string, any>) =>
  ({ id, type, position: { x: col * X, y: row * Y }, data: { config } });
const e = (source: string, target: string, sourceHandle: string | null = null) =>
  ({ id: `e-${source}-${sourceHandle ?? "n"}-${target}`, source, target, sourceHandle });

export type Template = { id: string; name: string; description: string; emoji: string; graph: () => Graph; reentry?: "once" | "cooldown" | "always"; cooldown?: number };

export const TEMPLATES: Template[] = [
  {
    id: "blank", name: "Em branco", emoji: "✨", description: "Comece só com o gatilho e monte do seu jeito.",
    graph: () => ({ nodes: [n("t", "trigger", 0, 0, { kind: "keyword", keywords: "", matchMode: "smart" })], edges: [] }),
  },
  {
    id: "welcome", name: "Boas-vindas com menu", emoji: "👋", description: "Recebe quem chama pela primeira vez, mostra um menu e encaminha cada opção.",
    reentry: "once",
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 1, { kind: "first_message" }),
        n("hi", "send_text", 1, 1, { text: "{Olá|Oi} {primeiro_nome}! 👋 Que bom falar com você." }),
        n("m", "send_menu", 2, 1, { text: "Como posso te ajudar?", options: "Ver produtos e preços\nFazer um pedido\nFalar com um atendente", timeout: 12, timeoutUnit: "hours" }),
        n("p", "send_text", 3, 0, { text: "Perfeito! Vou te mandar nossa tabela atualizada. Qual produto você procura?" }),
        n("pt", "tag", 4, 0, { action: "add", tag: "interesse-precos" }),
        n("d", "crm_deal", 3, 1, { action: "create", title: "Pedido WhatsApp — {nome}" }),
        n("dt", "task", 4, 1, { title: "Montar pedido de {nome}", taskType: "follow_up", dueInHours: 1 }),
        n("h", "handoff", 3, 2, { message: "Vou te passar para alguém da equipe, só um instante 🙂" }),
        n("x", "tag", 3, 3, { action: "add", tag: "sem-resposta" }),
      ],
      edges: [e("t", "hi"), e("hi", "m"), e("m", "p", "opt0"), e("p", "pt"), e("m", "d", "opt1"), e("d", "dt"), e("m", "h", "opt2"), e("m", "h", "other"), e("m", "x", "timeout")],
    }),
  },
  {
    id: "after_hours", name: "Fora do horário", emoji: "🌙", description: "Responde na hora quando a equipe não está e cria uma tarefa para retornar cedo.",
    cooldown: 12,
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 0, { kind: "message", onlyOutsideHours: true, hours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] } }),
        n("s", "send_text", 1, 0, { text: "Oi {primeiro_nome}! Nosso atendimento é de segunda a sexta, das 8h às 18h. Já anotei sua mensagem e te respondemos logo cedo 🙏" }),
        n("tg", "tag", 2, 0, { action: "add", tag: "fora-do-horario" }),
        n("bh", "business_hours", 3, 0, { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }),
        n("k", "task", 4, 0, { title: "Responder {nome} (chamou fora do horário)", taskType: "whatsapp", dueInHours: 1 }),
      ],
      edges: [e("t", "s"), e("s", "tg"), e("tg", "bh"), e("bh", "k")],
    }),
  },
  {
    id: "campaign_reply", name: "Resposta de disparo", emoji: "📣", description: "Quem responde a um disparo: separa quem não quer, cria a negociação e chama um vendedor.",
    reentry: "once",
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 1, { kind: "campaign" }),
        n("c", "condition", 1, 1, { match: "any", rules: [{ field: "last_message", op: "keyword", value: "não quero, sem interesse, não tenho interesse, pare" }] }),
        n("no", "send_text", 2, 0, { text: "Sem problemas, {primeiro_nome}! Obrigado pelo retorno 🙏" }),
        n("not", "tag", 3, 0, { action: "add", tag: "sem-interesse" }),
        n("y", "send_text", 2, 2, { text: "Que bom, {primeiro_nome}! Vou te passar para um especialista que já te explica tudo." }),
        n("d", "crm_deal", 3, 2, { action: "create", title: "Disparo — {nome}" }),
        n("a", "assign", 4, 2, { strategy: "round_robin" }),
        n("h", "handoff", 5, 2, { message: "" }),
      ],
      edges: [e("t", "c"), e("c", "no", "yes"), e("no", "not"), e("c", "y", "no"), e("y", "d"), e("d", "a"), e("a", "h")],
    }),
  },
  {
    id: "qualify", name: "Qualificação de orçamento", emoji: "📝", description: "Faz perguntas, guarda as respostas no contato e já cria a negociação com tarefa.",
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 0, { kind: "keyword", keywords: "orçamento\ncotação\npreço", matchMode: "smart" }),
        n("q1", "ask", 1, 0, { text: "Claro! Para eu montar seu orçamento: qual o nome da sua empresa?", saveAs: "empresa", saveTo: "empresa", timeout: 6, timeoutUnit: "hours" }),
        n("q2", "ask", 2, 0, { text: "E em qual cidade vocês ficam?", saveAs: "cidade", saveTo: "cidade", timeout: 6, timeoutUnit: "hours" }),
        n("q3", "ask", 3, 0, { text: "Quais produtos e quantidades você precisa?", saveAs: "pedido", timeout: 6, timeoutUnit: "hours" }),
        n("d", "crm_deal", 4, 0, { action: "create", title: "Orçamento — {var.empresa}" }),
        n("k", "task", 5, 0, { title: "Enviar orçamento: {var.pedido}", taskType: "proposal", dueInHours: 2 }),
        n("ok", "send_text", 6, 0, { text: "Anotado, {primeiro_nome}! Em até 2 horas te mando o orçamento por aqui ✅" }),
        n("fu", "send_text", 2, 1, { text: "Oi {primeiro_nome}, ainda quer o orçamento? É só me responder 🙂" }),
      ],
      edges: [e("t", "q1"), e("q1", "q2", "answered"), e("q2", "q3", "answered"), e("q3", "d", "answered"), e("d", "k"), e("k", "ok"), e("q1", "fu", "timeout"), e("q2", "fu", "timeout"), e("q3", "fu", "timeout")],
    }),
  },
  {
    id: "cold_lead", name: "Recuperar lead frio", emoji: "🔁", description: "Sequência de follow-up para quem parou de responder. Você inicia para os contatos escolhidos.",
    reentry: "always",
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 0, { kind: "manual" }),
        n("s1", "send_text", 1, 0, { text: "Oi {primeiro_nome}, tudo bem? Passando para saber se ainda posso te ajudar com aquele pedido 🙂" }),
        n("w1", "wait_response", 2, 0, { timeout: 2, timeoutUnit: "days" }),
        n("r", "notify", 3, 1, { message: "{nome} respondeu o follow-up" }),
        n("h", "handoff", 4, 1, { message: "" }),
        n("s2", "send_text", 3, 0, { text: "{primeiro_nome}, separei uma condição especial esta semana. Quer que eu te mande?" }),
        n("w2", "wait_response", 4, 0, { timeout: 3, timeoutUnit: "days" }),
        n("cold", "tag", 5, 0, { action: "add", tag: "lead-frio" }),
      ],
      edges: [e("t", "s1"), e("s1", "w1"), e("w1", "r", "replied"), e("r", "h"), e("w1", "s2", "timeout"), e("s2", "w2"), e("w2", "r", "replied"), e("w2", "cold", "timeout")],
    }),
  },
  {
    id: "ai_agent", name: "Atendimento com IA", emoji: "🤖", description: "A IA conversa com o cliente usando as suas instruções e chama um humano quando pedirem.",
    cooldown: 6,
    graph: () => ({
      nodes: [
        n("t", "trigger", 0, 0, { kind: "message" }),
        n("c", "condition", 1, 0, { match: "any", rules: [{ field: "last_message", op: "keyword", value: "atendente, humano, pessoa, falar com alguém" }] }),
        n("ai", "ai_reply", 2, 1, { prompt: "Somos [descreva sua empresa]. Horário: seg a sex, 8h às 18h. Ajude o cliente a escolher produtos e tirar dúvidas. Se perguntarem preço, diga que um vendedor envia a tabela atualizada.", maxChars: 600 }),
        n("w", "wait_response", 3, 1, { timeout: 30, timeoutUnit: "minutes" }),
        n("h", "handoff", 2, 0, { message: "Claro! Já chamo alguém da equipe 🙂" }),
      ],
      edges: [e("t", "c"), e("c", "h", "yes"), e("c", "ai", "no"), e("ai", "w"), e("w", "c", "replied")],
    }),
  },
];
