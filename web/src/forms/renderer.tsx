// Desenha o formulário nos dois estilos. É o mesmo componente na página pública e na pré-visualização do editor.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity, ArrowLeft, ArrowRight, Calendar, Check, ChevronRight, CircleHelp, Clock, Compass, Heart, Home, MessageCircle,
  Scale, ShieldCheck, Sparkles, Star, Target, ThumbsUp, TrendingUp, User, Users, Wallet, Zap,
} from "lucide-react";
import { ensureFonts, themeVars, type FormContent, type FormQuestion, type PublicForm } from "./types";

export const OPTION_ICONS: Record<string, typeof Star> = {
  target: Target, sparkles: Sparkles, activity: Activity, compass: Compass, calendar: Calendar, clock: Clock, help: CircleHelp,
  heart: Heart, star: Star, home: Home, user: User, users: Users, wallet: Wallet, zap: Zap, trending: TrendingUp, thumbs: ThumbsUp,
  scale: Scale, chat: MessageCircle, shield: ShieldCheck,
};

/** **negrito** dentro dos textos do formulário. */
export function Rich({ text }: { text?: string }) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>))}</>;
}

export type Phase = { kind: "intro" } | { kind: "q"; i: number } | { kind: "capture" } | { kind: "done" };
export type TrackFn = (event: string, step: number, data?: Record<string, unknown>) => void;

type Props = {
  form: PublicForm;
  preview?: boolean;
  /** só na pré-visualização: em qual tela abrir */
  startAt?: Phase;
  onTrack?: TrackFn;
  onSubmit?: (answers: Record<string, string>, contact: { name: string; phone: string; email: string }) => Promise<void>;
};

const maskPhone = (v: string) => {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};

export function FormRenderer({ form, preview, startAt, onTrack, onSubmit }: Props) {
  const c = form.content;
  const qs = c.questions;
  const [phase, setPhase] = useState<Phase>(startAt ?? { kind: "intro" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Record<string, string[]>>({});
  const [text, setText] = useState("");
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const track = (e: string, s: number, d?: Record<string, unknown>) => { if (!preview) onTrack?.(e, s, d); };

  useEffect(() => { if (startAt) setPhase(startAt); }, [startAt]);
  useEffect(() => {
    shownAt.current = Date.now();
    setError("");
    if (phase.kind === "q") {
      track("step_view", phase.i + 1, { question: qs[phase.i]?.id });
      setText(answers[qs[phase.i]?.id] && qs[phase.i]?.type === "text" ? answers[qs[phase.i].id] : "");
    }
    if (phase.kind === "capture") track("capture_view", qs.length + 1);
    if (typeof window !== "undefined" && !preview) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // estilo "uma pergunta por tela": as letras A, B, C… do teclado escolhem a opção
  useEffect(() => {
    if (preview || form.style !== "steps" || phase.kind !== "q") return;
    const q = qs[phase.i];
    if (!q || q.type !== "choice") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const k = e.key.toUpperCase().charCodeAt(0) - 65;
      if (e.key.length === 1 && k >= 0 && k < q.options.length) answer(q, phase.i, q.options[k].label, q.options[k].label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = qs.length;
  const stepNo = phase.kind === "q" ? phase.i + 1 : phase.kind === "capture" ? total + 1 : 0;
  const progress = phase.kind === "intro" ? 0 : phase.kind === "done" ? 100 : Math.round((stepNo - 1) / (total + 1) * 100);

  const next = (i: number) => setPhase(i + 1 < total ? { kind: "q", i: i + 1 } : { kind: "capture" });
  const answer = (q: FormQuestion, i: number, value: string, label?: string) => {
    setAnswers((a) => ({ ...a, [q.id]: value }));
    track("answer", i + 1, { question: q.id, answer: value, label, ms: Date.now() - shownAt.current });
    window.setTimeout(() => next(i), q.type === "choice" ? 220 : 0);
  };
  const back = () => {
    if (phase.kind === "q") { track("back", phase.i + 1); setPhase(phase.i === 0 ? { kind: "intro" } : { kind: "q", i: phase.i - 1 }); }
    if (phase.kind === "capture") { track("back", total + 1); setPhase(total ? { kind: "q", i: total - 1 } : { kind: "intro" }); }
  };
  const start = () => { track("start", 1); setPhase(total ? { kind: "q", i: 0 } : { kind: "capture" }); };

  const submit = async () => {
    const digits = contact.phone.replace(/\D/g, "");
    if (c.capture.fields.name && !contact.name.trim()) return setError("Digite o seu nome.");
    if (c.capture.fields.phone && (digits.length < 10 || digits.length > 11)) return setError("Digite um WhatsApp com DDD.");
    if (c.capture.fields.email && (c.capture.email_required || contact.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) return setError("Digite um e-mail válido.");
    if (preview) { setPhase({ kind: "done" }); return; }
    setBusy(true);
    setError("");
    try {
      await onSubmit?.(answers, contact);
      setPhase({ kind: "done" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível enviar. Tente de novo.");
    } finally { setBusy(false); }
  };

  const vars = themeVars(c.theme) as CSSProperties;
  useEffect(() => { ensureFonts(c.theme); }, [c.theme.title_font, c.theme.body_font]); // eslint-disable-line react-hooks/exhaustive-deps
  const logo = c.header.logo_url || form.brand.logo_url || "";
  const doneUrl = (c.done.button_url || "").trim();

  const question = phase.kind === "q" ? qs[phase.i] : null;
  // funções (não componentes): assim o campo de texto não perde o foco a cada letra
  const questionBody = (q: FormQuestion, i: number) => {
    if (q.type === "text") {
      return (
        <form className="ff-text" onSubmit={(e) => { e.preventDefault(); if (q.required !== false && !text.trim()) { setError("Escreva a sua resposta."); return; } answer(q, i, text.trim()); }}>
          <textarea autoFocus={!preview} value={text} placeholder={q.placeholder || "Escreva aqui…"} rows={3} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="ff-btn">Continuar <ArrowRight size={16} /></button>
        </form>
      );
    }
    const sel = multi[q.id] ?? (answers[q.id] ? answers[q.id].split(" · ") : []);
    return (
      <>
        <div className={`ff-options${form.style === "card" ? " grid" : ""}`} role={q.type === "multi" ? "group" : "radiogroup"}>
          {q.options.map((o, k) => {
            const Icon = o.icon ? OPTION_ICONS[o.icon] : null;
            const on = q.type === "multi" ? sel.includes(o.label) : answers[q.id] === o.label;
            return (
              <button key={o.id} type="button" className={`ff-option${on ? " on" : ""}`} aria-pressed={on}
                onClick={() => {
                  if (q.type === "multi") {
                    const list = on ? sel.filter((x) => x !== o.label) : [...sel, o.label];
                    setMulti((m) => ({ ...m, [q.id]: list }));
                    track("click", i + 1, { question: q.id, label: o.label });
                  } else answer(q, i, o.label, o.label);
                }}>
                {form.style === "steps" && <span className="ff-key">{String.fromCharCode(65 + k)}</span>}
                {form.style === "card" && Icon && <span className="ff-ico"><Icon size={18} /></span>}
                <span className="ff-olabel">{o.label}</span>
                {on && form.style === "steps" && <Check size={16} className="ff-check" />}
              </button>
            );
          })}
        </div>
        {q.type === "multi" && (
          <button type="button" className="ff-btn" onClick={() => {
            if (q.required !== false && !sel.length) { setError("Escolha ao menos uma opção."); return; }
            answer(q, i, sel.join(" · "));
          }}>Continuar <ArrowRight size={16} /></button>
        )}
      </>
    );
  };

  const capture = (
    <form className="ff-capture" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {c.capture.fields.name && (
        <label><span>Nome</span><input autoComplete="name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} placeholder="Seu nome" /></label>
      )}
      {c.capture.fields.phone && (
        <label><span>WhatsApp</span><input inputMode="tel" autoComplete="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: maskPhone(e.target.value) })} placeholder="(64) 99999-9999" /></label>
      )}
      {c.capture.fields.email && (
        <label><span>E-mail{c.capture.email_required ? "" : " (opcional)"}</span><input type="email" autoComplete="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} placeholder="voce@email.com" /></label>
      )}
      {error && <p className="ff-error" role="alert">{error}</p>}
      <button type="submit" className="ff-btn" disabled={busy}>{busy ? "Enviando…" : c.capture.button || "Enviar"} {!busy && <ArrowRight size={16} />}</button>
      {c.capture.privacy && <p className="ff-privacy"><ShieldCheck size={14} /> {c.capture.privacy}</p>}
    </form>
  );

  const doneBlock = (
    <div className="ff-done">
      <div className="ff-done-ico"><Check size={28} /></div>
      <h2><Rich text={c.done.title} /></h2>
      {c.done.text && <p><Rich text={c.done.text} /></p>}
      {c.done.button_label && doneUrl && (
        <a className="ff-btn" href={doneUrl} target="_blank" rel="noreferrer" onClick={() => track("done_click", total + 2, { label: c.done.button_label })}>
          {c.done.button_label} <ChevronRight size={16} />
        </a>
      )}
    </div>
  );

  // ----------------------------------------------------------------- estilo "Uma pergunta por tela"
  if (form.style === "steps") {
    return (
      <div className={`ff ff-steps${preview ? " preview" : ""}`} style={vars}>
        {phase.kind !== "intro" && <div className="ff-bar"><i style={{ width: `${progress}%` }} /></div>}
        <header className="ff-s-head">
          {logo ? <img src={logo} alt={form.brand.name} /> : <strong>{c.header.name || form.brand.name}</strong>}
        </header>
        <main className="ff-s-main" key={phase.kind === "q" ? `q${phase.i}` : phase.kind}>
          {phase.kind === "intro" && (
            <section className="ff-s-intro ff-anim">
              <h1><Rich text={c.intro.title} /></h1>
              {c.intro.subtitle && <p className="ff-s-sub"><Rich text={c.intro.subtitle} /></p>}
              {c.intro.bullets.length > 0 && <ul>{c.intro.bullets.map((b, i) => <li key={i}><Rich text={b} /></li>)}</ul>}
              {c.intro.note && <p className="ff-s-note"><Rich text={c.intro.note} /></p>}
              <button type="button" className="ff-btn accent" onClick={start}>{c.intro.cta || "Começar"} <ArrowRight size={16} /></button>
            </section>
          )}
          {question && phase.kind === "q" && (
            <section className="ff-s-q ff-anim">
              <p className="ff-s-count">{phase.i + 1} <ArrowRight size={12} /> {total}</p>
              <h2><Rich text={question.title} /></h2>
              {question.help && <p className="ff-s-help">{question.help}</p>}
              {questionBody(question, phase.i)}
              {error && <p className="ff-error" role="alert">{error}</p>}
              <button type="button" className="ff-link" onClick={back}><ArrowLeft size={14} /> Voltar</button>
            </section>
          )}
          {phase.kind === "capture" && (
            <section className="ff-s-q ff-anim">
              <h2><Rich text={c.capture.title} /></h2>
              {c.capture.subtitle && <p className="ff-s-help">{c.capture.subtitle}</p>}
              {capture}
              <button type="button" className="ff-link" onClick={back}><ArrowLeft size={14} /> Voltar</button>
            </section>
          )}
          {phase.kind === "done" && <section className="ff-s-q ff-anim">{doneBlock}</section>}
        </main>
        {c.disclaimer && <footer className="ff-s-foot">{c.disclaimer}</footer>}
      </div>
    );
  }

  // ----------------------------------------------------------------- estilo "Cartão"
  const avatar = c.header.avatar_url;
  const lw = c.header.logo_white ? " white" : "";
  const TopBar = (
    <div className="ff-top">
      <div className="ff-top-in">
        <div className="ff-who">
          {avatar && <img className="ff-avatar sm" src={avatar} alt="" />}
          <div><strong>{c.header.name || form.brand.name}</strong>{c.header.subtitle && <small>{c.header.subtitle}</small>}</div>
        </div>
        {logo && <img className={`ff-top-logo${lw}`} src={logo} alt="" />}
      </div>
    </div>
  );
  const shell = (children: ReactNode) => <div className="ff-card ff-anim">{children}</div>;

  return (
    <div className={`ff ff-cardstyle${preview ? " preview" : ""}`} style={vars}>
      {TopBar}
      {phase.kind !== "intro" && phase.kind !== "done" && (
        <div className="ff-progress">
          <div className="ff-progress-in">
            <div className="ff-progress-row">
              <span>{phase.kind === "q" ? `Pergunta ${phase.i + 1} de ${total}` : "Última etapa"}</span>
              <button type="button" className="ff-link" onClick={back}><ArrowLeft size={13} /> Voltar</button>
            </div>
            <div className="ff-bar in"><i style={{ width: `${Math.max(progress, 6)}%` }} /></div>
          </div>
        </div>
      )}
      <main className="ff-c-main" key={phase.kind === "q" ? `q${phase.i}` : phase.kind}>
        {phase.kind === "intro" && shell(<>
            <div className={`ff-cover${avatar ? " has-avatar" : ""}`}>
              {logo ? <img className={`ff-cover-mark${lw}`} src={logo} alt="" aria-hidden /> : <i className="ff-cover-ring" aria-hidden />}
              {c.intro.eyebrow && <p className="ff-eyebrow">{c.intro.eyebrow}</p>}
              {logo && <img className={`ff-cover-logo${lw}`} src={logo} alt="" />}
            </div>
            <div className="ff-intro">
              {avatar && (
                <div className="ff-avatar-wrap">
                  <span className="ff-halo" aria-hidden /><span className="ff-halo2" aria-hidden />
                  <img className="ff-avatar lg" src={avatar} alt={c.header.name || form.brand.name} />
                </div>
              )}
              <p className="ff-name">{c.header.name || form.brand.name}</p>
              {c.header.subtitle && <p className="ff-sub">{c.header.subtitle}</p>}
              {c.intro.badge && <span className="ff-badge"><Star size={12} /> {c.intro.badge}</span>}
              <h1><Rich text={c.intro.title} /></h1>
              {c.intro.subtitle && <p className="ff-lead"><Rich text={c.intro.subtitle} /></p>}
              {c.intro.bullets.length > 0 && (
                <ul className="ff-checks">{c.intro.bullets.map((b, i) => <li key={i}><span><Check size={12} /></span><p><Rich text={b} /></p></li>)}</ul>
              )}
              <button type="button" className="ff-btn wide" onClick={start}>{c.intro.cta || "Começar"} <ChevronRight size={16} /></button>
              {c.intro.footnote && <p className="ff-foot"><ShieldCheck size={13} /> {c.intro.footnote}</p>}
            </div>
          </>)}
        {question && phase.kind === "q" && shell(<>
            <div className="ff-q">
              <h2><Rich text={question.title} /></h2>
              {question.help && <p className="ff-help">{question.help}</p>}
              {questionBody(question, phase.i)}
              {error && <p className="ff-error" role="alert">{error}</p>}
            </div>
          </>)}
        {phase.kind === "capture" && shell(<>
            <div className="ff-q">
              <h2><Rich text={c.capture.title} /></h2>
              {c.capture.subtitle && <p className="ff-help">{c.capture.subtitle}</p>}
              {capture}
            </div>
          </>)}
        {phase.kind === "done" && shell(<div className="ff-q">{doneBlock}</div>)}
      </main>
      {(c.disclaimer || logo) && (
        <footer className="ff-c-foot">
          <div className="ff-c-foot-in">
            {logo && <img className={lw.trim()} src={logo} alt="" />}
            {c.disclaimer && <div className="ff-aviso"><strong>Aviso</strong><p>{c.disclaimer}</p></div>}
            <small>{c.header.name || form.brand.name}{c.header.subtitle ? ` · ${c.header.subtitle}` : ""}</small>
          </div>
        </footer>
      )}
    </div>
  );
}

export type { FormContent };
