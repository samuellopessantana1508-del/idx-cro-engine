// Catálogo dos blocos do editor de automações (nome, ícone, cor, configuração inicial e resumo).
import type { LucideIcon } from "lucide-react";
import {
  Ban, Bell, CalendarClock, Clock, GitBranch, Headphones, Hourglass, Image as ImageIcon, KanbanSquare, ListOrdered, ListTodo,
  MessageCircleQuestion, MessageSquareText, PenLine, Sparkles, Split, Square, Tag, Target, UserCheck, Webhook, Zap,
} from "lucide-react";
import type { NodeType } from "../../../../supabase/functions/_shared/flow-core";

export type Group = "trigger" | "send" | "time" | "logic" | "crm" | "integrations" | "end";

// cores no estilo FlowZap: gatilho verde, mensagens azul, tempo âmbar, lógica violeta, ações rosa
export const GROUPS: { id: Group; label: string; color: string; soft: string }[] = [
  { id: "trigger", label: "Gatilho", color: "#16a34a", soft: "#ecfdf3" },
  { id: "send", label: "Mensagens", color: "#2563eb", soft: "#eff4ff" },
  { id: "time", label: "Tempo e espera", color: "#d97706", soft: "#fff8eb" },
  { id: "logic", label: "Decisões", color: "#7c3aed", soft: "#f5f1ff" },
  { id: "crm", label: "CRM e equipe", color: "#db2777", soft: "#fdf0f7" },
  { id: "integrations", label: "Integrações", color: "#0d9488", soft: "#ecfdfa" },
  { id: "end", label: "Fim", color: "#475569", soft: "#f1f5f9" },
];
export const groupOf = (g: Group) => GROUPS.find((x) => x.id === g)!;

export type BlockDef = {
  type: NodeType;
  group: Group;
  label: string;
  icon: LucideIcon;
  hint: string;
  defaults: Record<string, any>;
};

export const BLOCKS: BlockDef[] = [
  { type: "trigger", group: "trigger", label: "Gatilho", icon: Zap, hint: "O que inicia a automação", defaults: { kind: "keyword", keywords: "", matchMode: "smart" } },

  { type: "send_text", group: "send", label: "Mensagem", icon: MessageSquareText, hint: "Texto com variáveis e variações", defaults: { text: "" } },
  { type: "send_media", group: "send", label: "Imagem, vídeo, áudio ou PDF", icon: ImageIcon, hint: "Arquivo por link", defaults: { mediaType: "image", url: "", caption: "" } },
  { type: "send_menu", group: "send", label: "Menu de opções", icon: ListOrdered, hint: "O cliente responde com o número", defaults: { text: "Como posso te ajudar?", options: "Quero saber os preços\nFalar com um atendente", timeout: 24, timeoutUnit: "hours" } },
  { type: "ask", group: "send", label: "Pergunta", icon: MessageCircleQuestion, hint: "Pergunta e guarda a resposta", defaults: { text: "", saveAs: "", saveTo: "", timeout: 24, timeoutUnit: "hours" } },
  { type: "ai_reply", group: "send", label: "Resposta com IA", icon: Sparkles, hint: "A IA responde com base nas suas instruções", defaults: { prompt: "", maxChars: 600 } },

  { type: "wait", group: "time", label: "Esperar", icon: Clock, hint: "Pausa por minutos, horas ou dias", defaults: { amount: 1, unit: "days" } },
  { type: "wait_response", group: "time", label: "Aguardar resposta", icon: Hourglass, hint: "Segue por “respondeu” ou “não respondeu”", defaults: { timeout: 24, timeoutUnit: "hours" } },
  { type: "business_hours", group: "time", label: "Horário comercial", icon: CalendarClock, hint: "Só continua dentro do horário", defaults: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] } },

  { type: "condition", group: "logic", label: "Condição", icon: GitBranch, hint: "Sim ou não, por regras", defaults: { match: "all", rules: [{ field: "last_message", op: "contains", value: "" }] } },
  { type: "split_ab", group: "logic", label: "Teste A/B", icon: Split, hint: "Divide os contatos em dois caminhos", defaults: { percent: 50 } },

  { type: "tag", group: "crm", label: "Etiqueta", icon: Tag, hint: "Adiciona ou remove etiqueta do contato", defaults: { action: "add", tag: "" } },
  { type: "crm_deal", group: "crm", label: "Negociação no funil", icon: KanbanSquare, hint: "Cria ou move a negociação", defaults: { action: "create", stage_id: null, title: "WhatsApp — {nome}" } },
  { type: "task", group: "crm", label: "Criar tarefa", icon: ListTodo, hint: "Tarefa para o responsável", defaults: { title: "Retornar para {nome}", taskType: "follow_up", dueInHours: 2 } },
  { type: "assign", group: "crm", label: "Distribuir para vendedor", icon: UserCheck, hint: "Rodízio ou pessoa fixa", defaults: { strategy: "round_robin", user_id: null } },
  { type: "notify", group: "crm", label: "Avisar a equipe", icon: Bell, hint: "Notificação dentro do CRO", defaults: { message: "{nome} precisa de atenção", to: null } },
  { type: "set_field", group: "crm", label: "Salvar informação", icon: PenLine, hint: "Grava um dado no contato", defaults: { field: "", value: "" } },
  { type: "conversion", group: "crm", label: "Marcar marco", icon: Target, hint: "Registra interesse (não é venda)", defaults: { label: "interesse" } },

  { type: "webhook", group: "integrations", label: "Webhook", icon: Webhook, hint: "Envia os dados para outro sistema", defaults: { url: "", method: "POST", body: "" } },

  { type: "handoff", group: "end", label: "Passar para atendente", icon: Headphones, hint: "O robô para e a equipe assume", defaults: { message: "Vou te passar para alguém da equipe, só um instante 🙂" } },
  { type: "optout", group: "end", label: "Descadastrar (SAIR)", icon: Ban, hint: "Não envia mais nada a este contato", defaults: {} },
  { type: "end", group: "end", label: "Fim", icon: Square, hint: "Encerra a automação", defaults: {} },
];
export const blockOf = (t: NodeType) => BLOCKS.find((b) => b.type === t) ?? BLOCKS[BLOCKS.length - 1];

export const TRIGGER_KINDS: { id: string; label: string; hint: string }[] = [
  { id: "keyword", label: "Palavra-chave", hint: "Mensagem com uma das palavras (aceita erro de digitação)" },
  { id: "first_message", label: "Primeira mensagem", hint: "Primeiro contato de um número novo" },
  { id: "message", label: "Qualquer mensagem", hint: "Toda mensagem que não estiver em outra automação" },
  { id: "campaign", label: "Respondeu um disparo", hint: "Resposta a uma campanha de disparo" },
  { id: "tag", label: "Etiqueta adicionada", hint: "Quando o contato recebe uma etiqueta" },
  { id: "stage", label: "Entrou numa etapa do funil", hint: "Quando a negociação muda de etapa" },
  { id: "manual", label: "Início manual", hint: "Você escolhe os contatos e inicia" },
  { id: "webhook", label: "Webhook (outro sistema)", hint: "Seu site, formulário, n8n, Zapier… chamam um endereço" },
];

export const UNITS: Record<string, string> = { minutes: "min", hours: "h", days: "dias" };
export const UNIT_OPTIONS = [{ id: "minutes", label: "minutos" }, { id: "hours", label: "horas" }, { id: "days", label: "dias" }];
export const VARIABLES = [
  { v: "{primeiro_nome}", label: "Primeiro nome" }, { v: "{nome}", label: "Nome" }, { v: "{empresa}", label: "Empresa" },
  { v: "{cidade}", label: "Cidade" }, { v: "{telefone}", label: "Telefone" }, { v: "{resposta}", label: "Última resposta" },
];
export const WEBHOOK_VAR = { v: "{var.trigger.campo}", label: "Dado enviado pelo webhook" };

const cut = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lines = (s: unknown) => (Array.isArray(s) ? s : String(s ?? "").split("\n")).map((x) => String(x).trim()).filter(Boolean);

export type SummaryCtx = { stageName?: (id: string) => string | undefined; userName?: (id: string) => string | undefined; campaignName?: (id: string) => string | undefined };

/** Texto curto que aparece dentro do bloco no desenho. */
export function summary(type: NodeType, c: Record<string, any>, ctx: SummaryCtx = {}): string {
  switch (type) {
    case "trigger": {
      const k = TRIGGER_KINDS.find((x) => x.id === (c.kind ?? "message"));
      if (c.kind === "keyword") { const kws = lines(String(c.keywords ?? "").replace(/,/g, "\n")); return kws.length ? `Mensagem com: ${kws.slice(0, 4).join(", ")}${kws.length > 4 ? "…" : ""}` : "Defina as palavras-chave"; }
      if (c.kind === "tag") return c.tag ? `Etiqueta “${c.tag}” adicionada` : "Escolha a etiqueta";
      if (c.kind === "stage") return c.stage_id ? `Entrou em “${ctx.stageName?.(c.stage_id) ?? "etapa"}”` : "Escolha a etapa";
      if (c.kind === "webhook") return "Chamada de outro sistema (webhook)";
      if (c.kind === "campaign") return c.campaign_id ? `Respondeu “${ctx.campaignName?.(c.campaign_id) ?? "disparo"}”` : "Respondeu qualquer disparo";
      return `${k?.label ?? "Mensagem"}${c.onlyOutsideHours ? " · fora do horário" : ""}`;
    }
    case "send_text": return c.text ? cut(c.text) : "Escreva a mensagem";
    case "send_media": return c.url ? `${({ image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento" } as Record<string, string>)[c.mediaType] ?? "Arquivo"}${c.caption ? ` · ${cut(c.caption, 50)}` : ""}` : "Escolha o arquivo";
    case "send_menu": return c.text ? cut(c.text, 70) : "Escreva o menu";
    case "ask": return c.text ? cut(c.text, 70) : "Escreva a pergunta";
    case "ai_reply": return c.prompt ? cut(c.prompt, 80) : "Explique como a IA deve responder";
    case "wait": return `Esperar ${c.amount ?? 1} ${UNITS[c.unit ?? "minutes"] ?? ""}`;
    case "wait_response": return `Até ${c.timeout ?? 24} ${UNITS[c.timeoutUnit ?? "hours"]} pela resposta`;
    case "business_hours": return `${c.start ?? "08:00"}–${c.end ?? "18:00"} · ${daysLabel(c.days ?? [1, 2, 3, 4, 5])}`;
    case "condition": {
      const rules: any[] = Array.isArray(c.rules) ? c.rules : [];
      return rules.length ? rules.map(ruleLabel).join(c.match === "any" ? " ou " : " e ") : "Defina a regra";
    }
    case "split_ab": return `A ${c.percent ?? 50}% · B ${100 - Number(c.percent ?? 50)}%`;
    case "tag": return c.tag ? `${c.action === "remove" ? "Remover" : "Adicionar"} “${c.tag}”` : "Escolha a etiqueta";
    case "crm_deal": return c.action === "move" ? `Mover para “${ctx.stageName?.(c.stage_id) ?? "etapa"}”` : `Criar negociação${c.stage_id ? ` em “${ctx.stageName?.(c.stage_id) ?? "etapa"}”` : ""}`;
    case "task": return cut(c.title || "Tarefa", 70) + ` · em ${c.dueInHours ?? 1}h`;
    case "assign": return c.strategy === "user" && c.user_id ? `Para ${ctx.userName?.(c.user_id) ?? "vendedor"}` : "Rodízio entre vendedores";
    case "notify": return cut(c.message || "Aviso", 70);
    case "set_field": return c.field ? `${c.field} = ${cut(String(c.value ?? ""), 40)}` : "Escolha o campo";
    case "conversion": return `Marco: ${c.label || "interesse"}`;
    case "webhook": return c.url ? cut(String(c.url).replace(/^https?:\/\//, ""), 50) : "Informe o endereço";
    case "handoff": return c.message ? cut(c.message, 70) : "A equipe assume a conversa";
    case "optout": return "Não envia mais mensagens";
    case "end": return "Encerra aqui";
    default: return "";
  }
}

const DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function daysLabel(d: number[]) {
  const s = [...d].sort().join(",");
  if (s === "1,2,3,4,5") return "seg a sex";
  if (s === "1,2,3,4,5,6") return "seg a sáb";
  if (s === "0,1,2,3,4,5,6") return "todos os dias";
  return d.map((x) => DAYS[x]).join(", ");
}

export const RULE_FIELDS = [
  { id: "last_message", label: "Última mensagem" },
  { id: "responded", label: "Respondeu" },
  { id: "has_tag", label: "Tem etiqueta" },
  { id: "business_hours", label: "Dentro do horário" },
  { id: "contact_field", label: "Dado do contato" },
  { id: "variable", label: "Resposta salva" },
];
export const TEXT_OPS = [
  { id: "contains", label: "contém" }, { id: "not_contains", label: "não contém" }, { id: "equals", label: "é igual a" },
  { id: "not_equals", label: "é diferente de" }, { id: "starts_with", label: "começa com" }, { id: "keyword", label: "parece com (palavras)" },
  { id: "not_empty", label: "está preenchido" }, { id: "empty", label: "está vazio" }, { id: "gt", label: "maior que" }, { id: "lt", label: "menor que" },
];
export function ruleLabel(r: Record<string, any>) {
  const op = TEXT_OPS.find((o) => o.id === (r.op ?? "equals"))?.label ?? "";
  switch (r.field) {
    case "responded": return r.op === "empty" ? "não respondeu" : "respondeu";
    case "has_tag": return `${r.op === "not_equals" ? "não tem" : "tem"} etiqueta “${r.value ?? ""}”`;
    case "business_hours": return r.op === "not_equals" ? "fora do horário" : "dentro do horário";
    case "contact_field": return `${r.key || "campo"} ${op} ${["not_empty", "empty"].includes(r.op) ? "" : `“${r.value ?? ""}”`}`.trim();
    case "variable": return `${r.key || "resposta"} ${op} ${["not_empty", "empty"].includes(r.op) ? "" : `“${r.value ?? ""}”`}`.trim();
    default: return `mensagem ${op} ${["not_empty", "empty"].includes(r.op) ? "" : `“${r.value ?? ""}”`}`.trim();
  }
}
