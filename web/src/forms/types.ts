// Formulários do CRO: o mesmo formato serve para o editor, a pré-visualização e a página pública.

export type FormStyle = "card" | "steps";
export type QuestionType = "choice" | "multi" | "text";

export type FormOption = { id: string; label: string; icon?: string };
export type FormQuestion = {
  id: string;
  type: QuestionType;
  title: string;
  help?: string;
  options: FormOption[];
  placeholder?: string;
  required?: boolean;
};

export type FormContent = {
  header: { name: string; subtitle?: string; avatar_url?: string; logo_url?: string };
  intro: {
    eyebrow?: string;
    badge?: string;
    title: string;
    subtitle?: string;
    bullets: string[];
    note?: string;
    cta: string;
    footnote?: string;
  };
  questions: FormQuestion[];
  capture: {
    title: string;
    subtitle?: string;
    fields: { name: boolean; phone: boolean; email: boolean };
    email_required?: boolean;
    button: string;
    privacy?: string;
  };
  done: { title: string; text?: string; button_label?: string; button_url?: string };
  disclaimer?: string;
  theme: {
    color: string;
    accent: string;
    /** fundo da página (vazio = padrão do estilo) */
    bg?: string;
    /** fontes (chave de FONTS; vazio = padrão do estilo) */
    title_font?: string;
    body_font?: string;
    /** cantos: vazio = padrão do estilo */
    radius?: "" | "square" | "soft" | "round";
  };
};

/** Fontes do Google oferecidas no editor. */
export const FONTS: Record<string, { label: string; family: string; css: string; serif?: boolean }> = {
  inter: { label: "Inter", family: "Inter", css: "Inter:wght@400;500;600;700" },
  fraunces: { label: "Fraunces", family: "Fraunces", css: "Fraunces:opsz,wght@9..144,500;9..144,600", serif: true },
  playfair: { label: "Playfair Display", family: "Playfair Display", css: "Playfair+Display:wght@500;600;700", serif: true },
  lora: { label: "Lora", family: "Lora", css: "Lora:wght@500;600;700", serif: true },
  dmserif: { label: "DM Serif Display", family: "DM Serif Display", css: "DM+Serif+Display", serif: true },
  poppins: { label: "Poppins", family: "Poppins", css: "Poppins:wght@400;500;600;700" },
  montserrat: { label: "Montserrat", family: "Montserrat", css: "Montserrat:wght@400;500;600;700" },
  nunito: { label: "Nunito", family: "Nunito", css: "Nunito:wght@400;600;700;800" },
  dmsans: { label: "DM Sans", family: "DM Sans", css: "DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700" },
  outfit: { label: "Outfit", family: "Outfit", css: "Outfit:wght@400;500;600;700" },
};

const RADIUS = {
  square: { btn: "3px", box: "3px", card: "6px" },
  soft: { btn: "10px", box: "10px", card: "18px" },
  round: { btn: "999px", box: "18px", card: "30px" },
} as const;

/** cor de texto legível sobre um fundo (#rrggbb) */
export function onColor(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.45 ? "#0f172a" : "#fff";
}

/** variáveis CSS do tema (cores, fontes, cantos) */
export function themeVars(t: FormContent["theme"]): Record<string, string> {
  const color = t.color || "#0E3850";
  const accent = t.accent || color;
  const v: Record<string, string> = { "--fc": color, "--fa": accent, "--fon": onColor(color), "--fona": onColor(accent) };
  if (t.bg && /^#[0-9a-f]{6}$/i.test(t.bg)) v["--fbg"] = t.bg;
  const tf = t.title_font && FONTS[t.title_font];
  const bf = t.body_font && FONTS[t.body_font];
  if (tf) v["--fft"] = `"${tf.family}", ${tf.serif ? "Georgia, serif" : "system-ui, sans-serif"}`;
  if (bf) v["--ffb"] = `"${bf.family}", ${bf.serif ? "Georgia, serif" : "system-ui, sans-serif"}`;
  const r = t.radius && RADIUS[t.radius];
  if (r) { v["--fr-btn"] = r.btn; v["--fr-box"] = r.box; v["--fr-card"] = r.card; }
  return v;
}

/** carrega no navegador as fontes escolhidas que ainda não estão na página */
export function ensureFonts(t: FormContent["theme"]) {
  if (typeof document === "undefined") return;
  for (const k of ["inter", "fraunces", t.title_font, t.body_font]) {
    const f = k && FONTS[k];
    if (!f) continue;
    const id = `ff-font-${k}`;
    if (document.getElementById(id)) continue;
    const l = document.createElement("link");
    l.id = id; l.rel = "stylesheet"; l.href = `https://fonts.googleapis.com/css2?family=${f.css}&display=swap`;
    document.head.appendChild(l);
  }
}

/** paletas prontas para começar rápido */
export const PALETTES: { name: string; color: string; accent: string; bg?: string }[] = [
  { name: "Azul petróleo", color: "#0E3850", accent: "#0E3850" },
  { name: "Preto e laranja", color: "#111111", accent: "#F97316" },
  { name: "Verde saúde", color: "#065F46", accent: "#10B981", bg: "#F0FDF4" },
  { name: "Vinho", color: "#7F1D1D", accent: "#B45309", bg: "#FFFBF5" },
  { name: "Roxo", color: "#3B0764", accent: "#9333EA", bg: "#FAF5FF" },
  { name: "Rosa estética", color: "#831843", accent: "#DB2777", bg: "#FFF1F5" },
  { name: "Dourado", color: "#1C1917", accent: "#B8860B", bg: "#FAF7F0" },
  { name: "Azul confiança", color: "#1E3A8A", accent: "#2563EB" },
];

export type FormSettings = {
  stage_id?: string | null;
  owner_id?: string | null;
  tags?: string[];
  pixel_id?: string;
  create_deal?: boolean;
  deal_title?: string;
};

export type PublicForm = {
  id: string;
  slug: string;
  name: string;
  style: FormStyle;
  content: FormContent;
  pixel_id?: string | null;
  brand: { name: string; logo_url?: string | null; color?: string | null };
};

export type FormRow = {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  style: FormStyle;
  content: FormContent;
  settings: FormSettings;
  updated_at: string;
  published_at?: string | null;
};

export type FormListRow = {
  id: string; slug: string; name: string; status: FormRow["status"]; style: FormStyle; updated_at: string;
  views: number; starts: number; leads: number; last_lead_at: string | null;
};

export type FormSession = {
  id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  max_step: number;
  answers: Record<string, string>;
  events: { t: string; e: string; s?: number; q?: string; a?: string; label?: string; ms?: number }[];
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
  fbclid: string | null; gclid: string | null; referrer: string | null; landing_url: string | null; device: string | null;
  name: string | null; phone: string | null; email: string | null; contact_id: string | null; deal_id: string | null;
};

const uid = () => Math.random().toString(36).slice(2, 8);
export const newQuestion = (type: QuestionType = "choice"): FormQuestion => ({
  id: `q_${uid()}`,
  type,
  title: "Nova pergunta",
  help: "",
  options: type === "text" ? [] : [{ id: uid(), label: "Opção 1" }, { id: uid(), label: "Opção 2" }],
  required: true,
});
export const newOption = (n: number): FormOption => ({ id: uid(), label: `Opção ${n}` });

/** Modelo inicial: o "Cartão" segue o questionário do Dr. Gilberto; "Uma pergunta por tela" segue o formulário de tráfego. */
export function templateContent(style: FormStyle, brandName: string): FormContent {
  if (style === "steps") {
    return {
      header: { name: brandName },
      intro: {
        title: "**Mais clientes** para o seu negócio: **sem depender só de indicação**",
        bullets: ["📈 Mais pedidos todo mês", "🔥 Contatos de quem já quer comprar", "📅 Agenda cheia com previsibilidade", "🏆 Seja referência na sua cidade"],
        note: "→ Leva menos de 1 minuto. Responda e receba um diagnóstico do seu caso.",
        cta: "Quero receber o diagnóstico",
        subtitle: "",
      },
      questions: [
        { id: "q_area", type: "choice", title: "Qual é o seu segmento?", options: [{ id: "a", label: "Saúde" }, { id: "b", label: "Comércio" }, { id: "c", label: "Serviços" }, { id: "d", label: "Outro" }], required: true },
        { id: "q_fat", type: "choice", title: "Quanto a empresa fatura por mês?", options: [{ id: "a", label: "Até R$ 30 mil" }, { id: "b", label: "R$ 30 a 100 mil" }, { id: "c", label: "R$ 100 a 300 mil" }, { id: "d", label: "Mais de R$ 300 mil" }], required: true },
        { id: "q_hoje", type: "multi", title: "Como os clientes chegam hoje?", help: "Pode marcar mais de uma.", options: [{ id: "a", label: "Indicação" }, { id: "b", label: "Instagram" }, { id: "c", label: "Google" }, { id: "d", label: "Anúncios" }], required: true },
      ],
      capture: { title: "Para onde enviamos o diagnóstico?", subtitle: "Um especialista vai te chamar no WhatsApp.", fields: { name: true, phone: true, email: false }, button: "Enviar respostas", privacy: "Seus dados ficam só com a nossa equipe." },
      done: { title: "Respostas recebidas! ✅", text: "Em breve um especialista fala com você no WhatsApp.", button_label: "", button_url: "" },
      disclaimer: "",
      theme: { color: "#111111", accent: "#F97316" },
    };
  }
  return {
    header: { name: brandName, subtitle: "" },
    intro: {
      eyebrow: "Questionário de orientação",
      badge: "Avaliação",
      title: "Entenda qual é o próximo passo para o seu caso",
      subtitle: "Cada caso tem um ponto de partida diferente. Estas perguntas organizam o seu.",
      bullets: ["Entenda **o que a avaliação observa** no seu caso", "Organize **dúvidas e rotina** antes da consulta", "Ao final, **uma orientação para o seu momento**"],
      cta: "Entender o meu caso",
      footnote: "Atendimento com registro profissional",
    },
    questions: [
      { id: "q_objetivo", type: "choice", title: "O que você mais gostaria de mudar?", help: "Não existe resposta certa. Escolha a mais próxima do que você sente hoje.", required: true,
        options: [{ id: "a", label: "Reduzir gordura localizada", icon: "target" }, { id: "b", label: "Melhorar o contorno", icon: "sparkles" }, { id: "c", label: "Ter mais definição", icon: "activity" }, { id: "d", label: "Ainda estou descobrindo", icon: "compass" }] },
      { id: "q_quando", type: "choice", title: "Quando você pensa em resolver isso?", required: true,
        options: [{ id: "a", label: "Nos próximos 30 dias", icon: "calendar" }, { id: "b", label: "Em até 3 meses", icon: "clock" }, { id: "c", label: "Ainda sem data", icon: "help" }] },
    ],
    capture: { title: "Para onde enviamos a sua orientação?", subtitle: "A equipe responde pelo WhatsApp, sem compromisso.", fields: { name: true, phone: true, email: false }, button: "Ver a minha orientação", privacy: "Seus dados ficam só com a equipe de atendimento." },
    done: { title: "Pronto! Recebemos as suas respostas", text: "A equipe vai te chamar no WhatsApp com a orientação para o seu caso.", button_label: "Falar agora no WhatsApp", button_url: "" },
    disclaimer: "Este questionário tem finalidade informativa e não substitui uma consulta.",
    theme: { color: "#0E3850", accent: "#0E3850" },
  };
}

/** Garante todos os campos (formulários antigos ou editados à mão). */
export function normalizeContent(c: Partial<FormContent> | null | undefined, style: FormStyle, brandName: string): FormContent {
  const base = templateContent(style, brandName);
  const x = (c ?? {}) as Partial<FormContent>;
  return {
    header: { ...base.header, ...(x.header ?? {}) },
    intro: { ...base.intro, ...(x.intro ?? {}), bullets: x.intro?.bullets ?? base.intro.bullets },
    questions: (x.questions ?? base.questions).map((q) => ({ ...q, options: q.options ?? [], type: q.type ?? "choice" })),
    capture: { ...base.capture, ...(x.capture ?? {}), fields: { ...base.capture.fields, ...(x.capture?.fields ?? {}) } },
    done: { ...base.done, ...(x.done ?? {}) },
    disclaimer: x.disclaimer ?? base.disclaimer,
    theme: { ...base.theme, ...(x.theme ?? {}) },
  };
}

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
