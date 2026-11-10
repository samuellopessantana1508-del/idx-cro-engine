import type { Lifecycle, Priority, RfvSegment, TaskType } from "./types";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moneyShort = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });

export function brl(v: number | null | undefined, compact = false): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return (compact && Math.abs(Number(v)) >= 10000 ? moneyShort : money).format(Number(v));
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(v));
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${num(v, 1)}%`;
}

export function phoneLabel(e164: string | null | undefined): string {
  if (!e164) return "";
  const d = e164.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    return rest.length === 9 ? `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}` : `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return `+${d}`;
}

export function waLink(e164: string | null | undefined): string | null {
  const d = (e164 ?? "").replace(/\D/g, "");
  return d ? `https://wa.me/${d}` : null;
}

export function initials(text: string | null | undefined): string {
  const t = (text ?? "").replace(/@.*/, "").replace(/[._-]+/g, " ").trim();
  if (!t) return "?";
  const parts = t.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? "")).toUpperCase();
}

export function emailName(email: string | null | undefined): string {
  if (!email) return "Sem responsável";
  const base = email.split("@")[0].replace(/[._-]+/g, " ");
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

const dtf = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
const dtfTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const tf = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function shortDate(v: string | null | undefined): string {
  if (!v) return "—";
  return dtf.format(new Date(v.length === 10 ? `${v}T12:00:00` : v)).replace(".", "");
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return "—";
  return dtfTime.format(new Date(v)).replace(".", "");
}

export function timeOnly(v: string | null | undefined): string {
  return v ? tf.format(new Date(v)) : "";
}

export function relative(v: string | null | undefined): string {
  if (!v) return "—";
  const diff = new Date(v).getTime() - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const label = m < 1 ? "agora" : m < 60 ? `${m} min` : h < 24 ? `${h} h` : d < 30 ? `${d} d` : shortDate(v);
  if (label === "agora" || d >= 30) return label;
  return diff < 0 ? `há ${label}` : `em ${label}`;
}

export function dueState(v: string | null | undefined): "overdue" | "today" | "soon" | "later" | "none" {
  if (!v) return "none";
  const t = new Date(v).getTime();
  const now = Date.now();
  if (t < now) return "overdue";
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (t <= end.getTime()) return "today";
  if (t - now < 3 * 86400000) return "soon";
  return "later";
}

export function toLocalInput(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseMoney(v: string): number {
  const clean = v.replace(/[^\d,.-]/g, "");
  if (!clean) return 0;
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

export const channelLabels: Record<string, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  tiktok_ads: "TikTok Ads",
  whatsapp: "WhatsApp",
  smart_link: "Smart Link",
  form: "Formulário",
  landing_page: "Landing page",
  referral: "Indicação",
  outbound: "Prospecção",
  import: "Importação",
  manual: "Cadastro manual",
  organic: "Orgânico",
  instagram: "Instagram",
  site: "Site",
};

export function channelLabel(c: string | null | undefined): string {
  if (!c) return "Origem desconhecida";
  return channelLabels[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

export const basisLabels: Record<string, { label: string; hint: string }> = {
  known: { label: "Origem conhecida", hint: "Registrada a partir de evidência (clique rastreado, UTM ou identificador de anúncio)." },
  declared: { label: "Origem declarada", hint: "Informada manualmente ou na importação; não há rastreio técnico." },
  inferred: { label: "Origem inferida", hint: "Sugestão do sistema/IA; não é comprovação de atribuição." },
  unknown: { label: "Origem não comprovada", hint: "Não existe evidência suficiente para atribuir a uma campanha." },
};

export const lifecycleLabels: Record<Lifecycle, string> = {
  lead: "Lead",
  mql: "MQL",
  sal: "SAL",
  sql: "SQL",
  opportunity: "Oportunidade",
  customer: "Cliente",
  inactive: "Inativo",
};

export const priorityLabels: Record<Priority, string> = { low: "Baixa", normal: "Normal", high: "Alta", urgent: "Urgente" };

export const taskTypeLabels: Record<TaskType, string> = {
  call: "Ligação",
  meeting: "Reunião",
  follow_up: "Follow-up",
  callback: "Retorno",
  task: "Tarefa",
  proposal: "Proposta",
  email: "E-mail",
  whatsapp: "WhatsApp",
  visit: "Visita",
  other: "Outra",
};

export const segmentInfo: Record<RfvSegment, { label: string; tone: string; action: string; description: string }> = {
  champions: { label: "Campeões", tone: "green", action: "Fidelização, benefícios e pedido de indicação", description: "Compram com frequência, recentemente e com alto valor." },
  loyal: { label: "Clientes leais", tone: "teal", action: "Relacionamento e reconhecimento", description: "Compram com frequência e recentemente." },
  high_value_at_risk: { label: "Alto valor em risco", tone: "red", action: "Contato prioritário e diagnóstico", description: "Alto valor histórico, mas sem compra recente." },
  at_risk: { label: "Em risco", tone: "orange", action: "Ação preventiva", description: "Recência em queda." },
  new: { label: "Novos clientes", tone: "blue", action: "Onboarding e estímulo à segunda compra", description: "Primeira compra recente." },
  potential: { label: "Potencial de crescimento", tone: "purple", action: "Nutrição e recompra", description: "Compram recentemente, mas com pouca frequência." },
  hibernating: { label: "Hibernando", tone: "amber", action: "Campanha de reativação", description: "Longo período sem comprar." },
  lost: { label: "Perdidos", tone: "gray", action: "Tentativa de recuperação ou inativação", description: "Inatividade além do ciclo esperado." },
  no_purchase: { label: "Sem histórico de compra", tone: "slate", action: "Jornada de aquisição e conversão", description: "Ainda sem compra válida." },
};

export const segmentOrder: RfvSegment[] = ["champions", "loyal", "potential", "new", "at_risk", "high_value_at_risk", "hibernating", "lost"];

export const orderStatusLabels: Record<string, string> = {
  pending: "Aguardando confirmação",
  confirmed: "Confirmada",
  paid: "Paga",
  partially_refunded: "Devolução parcial",
  refunded: "Estornada",
  cancelled: "Cancelada",
};

export const evidenceLabels: Record<string, string> = {
  payment: "Pagamento recebido",
  contract: "Contrato assinado",
  invoice: "Nota fiscal",
  pos: "Venda no balcão / PDV",
  manual_confirmation: "Confirmação do vendedor",
  legacy_confirmation: "Confirmada no IDX (Atender)",
  ai_signal_reviewed: "Sinal da IA revisado",
  ai_auto_unreviewed: "Marcada pela IA (sem revisão)",
  import: "Importação",
};

export const roleLabels: Record<string, string> = {
  admin: "Administrador",
  manager: "Gestor",
  sales: "Vendedor",
  marketing: "Marketing",
  service: "Atendimento",
  success: "Customer Success",
  viewer: "Somente leitura",
};

export function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string; details?: string } | null;
  const msg = e?.message ?? String(err ?? "");
  if (/crm_contacts_tenant_phone_key|duplicate key.*phone/i.test(msg)) return "Já existe um contato com este telefone. Use a busca para abri-lo.";
  if (/row-level security|permission denied|42501/i.test(msg) || e?.code === "42501") return "Seu perfil não tem permissão para esta ação.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Sem conexão com o servidor. Seus dados não foram perdidos — tente novamente.";
  if (/violates foreign key/i.test(msg)) return "Registro relacionado não encontrado nesta empresa.";
  return msg.replace(/^.*?ERROR:\s*/, "") || "Algo deu errado. Tente novamente.";
}
