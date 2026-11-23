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
  theme: { color: string; accent: string };
};

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
