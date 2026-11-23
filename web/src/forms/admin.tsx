// Formulários dentro do CRO: lista, editor com pré-visualização ao vivo e respostas com o caminho de cada visita.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, BarChart3, Check, CheckSquare, Copy, ExternalLink, Eye, FileText, Globe, ImagePlus, LayoutList,
  ListChecks, Monitor, MousePointerClick, Plus, Smartphone, Trash2, Type, Upload, X,
} from "lucide-react";
import * as crmApi from "../crm/api";
import { useCrm } from "../crm/context";
import { dateTime, errorText, num, relative } from "../crm/format";
import { Confirm, Empty, Field, Modal, Segmented, Skeleton } from "../crm/ui";
import * as api from "./api";
import { FormRenderer, OPTION_ICONS, type Phase } from "./renderer";
import {
  FONTS, PALETTES, newOption, newQuestion, normalizeContent, slugify, templateContent,
  type FormContent, type FormListRow, type FormQuestion, type FormRow, type FormSession, type FormSettings, type FormStyle, type PublicForm, type QuestionType,
} from "./types";
import "./forms.css";
import "./admin.css";

const PUBLIC_BASE = typeof window !== "undefined" ? window.location.origin : "https://croengine.pro";
const publicUrl = (slug: string) => `${PUBLIC_BASE}/f/?${slug}`;
const STYLE_LABEL: Record<FormStyle, string> = { card: "Cartão", steps: "Uma pergunta por tela" };

function readParam() { return new URLSearchParams(window.location.search).get("form"); }
function writeParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("form", id); else url.searchParams.delete("form");
  window.history.replaceState(null, "", url);
}

export function FormsView() {
  const [openId, setOpenId] = useState<string | null>(readParam);
  const open = (id: string | null) => { writeParam(id); setOpenId(id); };
  useEffect(() => () => writeParam(null), []);
  if (openId) return <FormEditor key={openId} formId={openId} onBack={() => open(null)} onDuplicated={open} />;
  return <FormList onOpen={open} />;
}

async function copy(text: string, notify: (m: string) => void) {
  try { await navigator.clipboard.writeText(text); notify("Link copiado."); } catch { notify(text); }
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------
function FormList({ onOpen }: { onOpen: (id: string) => void }) {
  const crm = useCrm();
  const [rows, setRows] = useState<FormListRow[] | null>(null);
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api.formList(crm.tenantId, Number(days)).then(setRows).catch((e) => { crm.notify(errorText(e)); setRows([]); });
  }, [crm, days]);
  useEffect(() => { load(); }, [load, crm.refreshKey]);

  const totals = useMemo(() => (rows ?? []).reduce((a, r) => ({ views: a.views + r.views, leads: a.leads + r.leads }), { views: 0, leads: 0 }), [rows]);

  return (
    <div className="crm-page fa-page">
      <div className="fa-head">
        <div>
          <h2>Formulários</h2>
          <p className="crm-muted">Páginas de perguntas com o seu link. Quem responde entra no CRM como contato e negociação, com as respostas, a origem do anúncio e cada clique.</p>
        </div>
        {crm.access.configure && <button type="button" className="crm-btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Novo formulário</button>}
      </div>

      <BrandCard />

      {rows && rows.length > 0 && (
        <div className="fa-toolbar">
          <span className="crm-muted">{num(totals.views)} visitas e {num(totals.leads)} contatos recebidos</span>
          <Segmented size="sm" value={days} onChange={setDays} options={[{ value: "7", label: "7 dias" }, { value: "30", label: "30 dias" }, { value: "90", label: "90 dias" }]} />
        </div>
      )}

      {!rows ? <Skeleton rows={3} height={84} /> : rows.length === 0 ? (
        <Empty icon={<FileText />} title="Nenhum formulário ainda"
          text="Crie um questionário no estilo Cartão ou Uma pergunta por tela. Cada resposta vira contato no CRM."
          action={crm.access.configure ? <button type="button" className="crm-btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Criar o primeiro</button> : undefined} />
      ) : (
        <div className="fa-list">
          {rows.map((r) => {
            const conv = r.views ? Math.round((r.leads / r.views) * 100) : 0;
            return (
              <div key={r.id} className="fa-row" onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.id); }}>
                <div className={`fa-thumb ${r.style}`}>{r.style === "card" ? <LayoutList size={18} /> : <Type size={18} />}</div>
                <div className="fa-row-main">
                  <div className="fa-row-title">
                    <strong>{r.name}</strong>
                    <span className={`fa-status ${r.status}`}>{r.status === "published" ? "No ar" : "Rascunho"}</span>
                  </div>
                  <span className="crm-muted">{STYLE_LABEL[r.style]} · /f/?{r.slug} · {r.last_lead_at ? `último contato ${relative(r.last_lead_at)}` : `editado ${relative(r.updated_at)}`}</span>
                </div>
                <div className="fa-nums">
                  <div><strong>{num(r.views)}</strong><small>visitas</small></div>
                  <div><strong>{num(r.starts)}</strong><small>começaram</small></div>
                  <div><strong>{num(r.leads)}</strong><small>contatos</small></div>
                  <div><strong>{conv}%</strong><small>conversão</small></div>
                </div>
                <div className="fa-row-actions" onClick={(e) => e.stopPropagation()}>
                  {r.status === "published" && <>
                    <button type="button" className="crm-icon-btn" title="Copiar link" onClick={() => copy(publicUrl(r.slug), crm.notify)}><Copy size={16} /></button>
                    <a className="crm-icon-btn" title="Abrir" href={publicUrl(r.slug)} target="_blank" rel="noreferrer"><ExternalLink size={16} /></a>
                  </>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && <NewFormModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </div>
  );
}

function NewFormModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const crm = useCrm();
  const [style, setStyle] = useState<FormStyle>("card");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim() || "Novo formulário";
    setBusy(true);
    try {
      const base = slugify(`${crm.tenantName}-${n}`).slice(0, 48) || "formulario";
      const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const f = await api.formSave(crm.tenantId, null, {
        name: n, slug, style, content: templateContent(style, crm.tenantName),
        settings: { create_deal: true, tags: [], stage_id: null, owner_id: null },
      });
      onCreated(f.id);
    } catch (e) { crm.notify(errorText(e)); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Novo formulário" width={640}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" disabled={busy} onClick={create}>{busy ? "Criando…" : "Criar e editar"}</button></>}>
      <div className="fa-new">
        <Field label="Nome (só aparece para a equipe)">
          <input className="crm-input" autoFocus value={name} placeholder="Ex.: Questionário lipo" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        </Field>
        <div className="fa-style-pick">
          {(["card", "steps"] as FormStyle[]).map((s) => (
            <button key={s} type="button" className={style === s ? "on" : ""} onClick={() => setStyle(s)}>
              <div className={`fa-mini ${s}`}>
                {s === "card" ? <><i className="bar" /><i className="cover" /><i className="l1" /><i className="l2" /><i className="grid" /></> : <><i className="logo" /><i className="h1" /><i className="h2" /><i className="li" /><i className="li" /><i className="btn" /></>}
              </div>
              <strong>{STYLE_LABEL[s]}</strong>
              <small>{s === "card" ? "Capa com foto, perguntas em cartões com ícones e aviso no rodapé. Bom para clínicas e profissionais." : "Tela limpa com a logo, título grande e uma pergunta por vez. Bom para anúncios e diagnósticos."}</small>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Logo e cor da empresa: usadas em todos os formulários. */
function BrandCard() {
  const crm = useCrm();
  const [logo, setLogo] = useState(crm.settings?.logo_url ?? "");
  const [color, setColor] = useState(crm.settings?.brand_color ?? "#0E3850");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setLogo(crm.settings?.logo_url ?? ""); setColor(crm.settings?.brand_color ?? "#0E3850"); }, [crm.settings]);
  if (!crm.access.configure) return null;
  const save = async (patch: { logo_url?: string | null; brand_color?: string | null }) => {
    try { await crmApi.saveSettings(crm.tenantId, patch); await crm.reloadStructure(); crm.notify("Marca atualizada."); } catch (e) { crm.notify(errorText(e)); }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) { crm.notify("Use uma imagem PNG, JPG ou WEBP."); return; }
    if (file.size > 3 * 1024 * 1024) { crm.notify("A logo precisa ter até 3 MB."); return; }
    setBusy(true);
    try { const up = await crmApi.uploadFlowMedia(crm.tenantId, file); setLogo(up.url); await save({ logo_url: up.url }); }
    catch (e) { crm.notify(errorText(e)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return (
    <div className="fa-brand">
      <div className="fa-brand-logo" style={{ background: logo ? "#fff" : color }}>
        {logo ? <img src={logo} alt="Logo" /> : <span>{crm.tenantName.slice(0, 2).toUpperCase()}</span>}
      </div>
      <div className="fa-brand-text">
        <strong>Logo de {crm.tenantName}</strong>
        <span className="crm-muted">Aparece no topo de todos os formulários. PNG com fundo transparente fica melhor.</span>
      </div>
      <label className="fa-color" title="Cor principal da marca">
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} onBlur={() => save({ brand_color: color })} />
        <span>{color.toUpperCase()}</span>
      </label>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
      <button type="button" className="crm-btn ghost" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} /> {busy ? "Enviando…" : logo ? "Trocar logo" : "Enviar logo"}</button>
      {logo && <button type="button" className="crm-icon-btn" title="Remover logo" onClick={() => { setLogo(""); save({ logo_url: null }); }}><X size={16} /></button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
type Tab = "content" | "look" | "crm" | "answers";
type Draft = { name: string; slug: string; style: FormStyle; content: FormContent; settings: FormSettings };

function FormEditor({ formId, onBack, onDuplicated }: { formId: string; onBack: () => void; onDuplicated: (id: string) => void }) {
  const crm = useCrm();
  const [row, setRow] = useState<FormRow | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState<Tab>("content");
  const [screen, setScreen] = useState<Phase>({ kind: "intro" });
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [busy, setBusy] = useState(false);
  const [archive, setArchive] = useState(false);
  const editable = crm.access.configure;

  useEffect(() => {
    api.formGet(formId).then((r) => {
      const d: Draft = { name: r.name, slug: r.slug, style: r.style, content: normalizeContent(r.content, r.style, crm.tenantName), settings: r.settings ?? {} };
      setRow(r); setDraft(d); setSaved(JSON.stringify(d));
    }).catch((e) => { crm.notify(errorText(e)); onBack(); });
  }, [formId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft ? JSON.stringify(draft) !== saved : false;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setC = (fn: (c: FormContent) => FormContent) => setDraft((d) => (d ? { ...d, content: fn(d.content) } : d));

  const save = async (): Promise<FormRow | null> => {
    if (!draft) return null;
    const slug = slugify(draft.slug);
    if (slug.length < 3) { crm.notify("O endereço precisa ter ao menos 3 letras ou números."); return null; }
    setBusy(true);
    try {
      const r = await api.formSave(crm.tenantId, formId, { ...draft, slug });
      const d = { ...draft, slug };
      setRow(r); setDraft(d); setSaved(JSON.stringify(d));
      return r;
    } catch (e) { crm.notify(errorText(e)); return null; }
    finally { setBusy(false); }
  };
  const setStatus = async (status: FormRow["status"]) => {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const r = await api.formSetStatus(formId, status);
      setRow(r);
      crm.notify(status === "published" ? "Formulário no ar." : status === "draft" ? "Formulário tirado do ar." : "Formulário arquivado.");
      if (status === "archived") onBack();
    } catch (e) { crm.notify(errorText(e)); }
    finally { setBusy(false); }
  };

  const duplicate = async () => {
    if (!draft) return;
    try {
      const slug = `${slugify(draft.slug).slice(0, 52)}-${Math.random().toString(36).slice(2, 6)}`;
      const f = await api.formSave(crm.tenantId, null, { ...draft, name: `${draft.name} (cópia)`, slug });
      crm.notify("Cópia criada como rascunho.");
      onDuplicated(f.id);
    } catch (e) { crm.notify(errorText(e)); }
  };

  // atalhos de teclado: Ctrl+S salva
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (dirty && editable) save(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const preview: PublicForm | null = useMemo(() => draft && ({
    id: formId, slug: draft.slug, name: draft.name, style: draft.style, content: draft.content,
    brand: { name: crm.tenantName, logo_url: crm.settings?.logo_url ?? null, color: crm.settings?.brand_color ?? null },
  }), [draft, formId, crm.tenantName, crm.settings]);

  if (!row || !draft || !preview) return <div className="crm-page"><Skeleton rows={6} /></div>;
  const qs = draft.content.questions;
  const screens: { v: string; label: string; phase: Phase }[] = [
    { v: "intro", label: "Abertura", phase: { kind: "intro" } },
    ...qs.map((q, i) => ({ v: `q${i}`, label: `${i + 1}`, phase: { kind: "q", i } as Phase })),
    { v: "capture", label: "Contato", phase: { kind: "capture" } },
    { v: "done", label: "Final", phase: { kind: "done" } },
  ];
  const screenKey = screen.kind === "q" ? `q${Math.min(screen.i, qs.length - 1)}` : screen.kind;
  const shownPhase: Phase = screen.kind === "q" && !qs.length ? { kind: "intro" } : screen.kind === "q" ? { kind: "q", i: Math.min(screen.i, qs.length - 1) } : screen;

  return (
    <div className="fa-editor">
      <div className="fa-ebar">
        <button type="button" className="crm-btn ghost" onClick={() => { if (!dirty || window.confirm("Sair sem salvar as alterações?")) onBack(); }}><ArrowLeft size={16} /> Formulários</button>
        <input className="fa-name" value={draft.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} aria-label="Nome do formulário" />
        <span className={`fa-status ${row.status}`}>{row.status === "published" ? "No ar" : "Rascunho"}</span>
        <div className="fa-ebar-right">
          {row.status === "published" && <>
            <button type="button" className="crm-btn ghost" onClick={() => copy(publicUrl(row.slug), crm.notify)}><Copy size={15} /> Copiar link</button>
            <a className="crm-icon-btn" title="Abrir o formulário" href={publicUrl(row.slug)} target="_blank" rel="noreferrer"><ExternalLink size={16} /></a>
          </>}
          {editable && <button type="button" className={`crm-btn ${dirty && row.status === "published" ? "primary" : "ghost"}`} disabled={!dirty || busy} onClick={async () => { if (await save()) crm.notify(row.status === "published" ? "Alterações publicadas: o link já mostra a versão nova." : "Rascunho salvo."); }}>
            {!dirty ? "Salvo" : row.status === "published" ? "Salvar e atualizar no ar" : "Salvar rascunho"}
          </button>}
          {editable && (row.status === "published"
            ? <button type="button" className="crm-btn ghost" disabled={busy} onClick={() => setStatus("draft")}>Tirar do ar</button>
            : <button type="button" className="crm-btn primary" disabled={busy} onClick={() => setStatus("published")}><Globe size={15} /> Publicar</button>)}
        </div>
      </div>

      {dirty && row.status === "published" && <div className="fa-live-note">Você está mexendo num formulário que está no ar. O cliente só vê as mudanças quando você clicar em <b>Salvar e atualizar no ar</b>.</div>}
      {row.status !== "published" && <div className="fa-live-note draft">Rascunho: o link <b>/f/?{row.slug}</b> só abre para o cliente depois de <b>Publicar</b>.</div>}
      <div className="fa-body">
        <aside className="fa-side">
          <div className="fa-tabs" role="tablist">
            {([["content", "Conteúdo"], ["look", "Aparência"], ["crm", "CRM"], ["answers", "Respostas"]] as [Tab, string][]).map(([v, l]) => (
              <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{l}</button>
            ))}
          </div>
          <fieldset className="fa-side-scroll" disabled={!editable && tab !== "answers"}>
            {tab === "content" && <ContentTab draft={draft} setC={setC} goTo={setScreen} />}
            {tab === "look" && <LookTab draft={draft} set={set} setC={setC} onReset={() => { if (window.confirm("Trocar todo o conteúdo pelo modelo inicial?")) { set({ content: templateContent(draft.style, crm.tenantName) }); setScreen({ kind: "intro" }); } }} />}
            {tab === "crm" && <CrmTab draft={draft} set={set} />}
            {tab === "answers" && <AnswersTab form={row} />}
          </fieldset>
        </aside>

        <section className="fa-preview">
          <div className="fa-pv-bar">
            <div className="fa-pv-screens">
              {screens.map((s) => (
                <button key={s.v} type="button" className={screenKey === s.v ? "on" : ""} onClick={() => setScreen(s.phase)} title={s.v.startsWith("q") ? qs[Number(s.v.slice(1))]?.title : s.label}>{s.label}</button>
              ))}
            </div>
            <div className="fa-pv-device">
              <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")} title="Computador"><Monitor size={15} /></button>
              <button type="button" className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")} title="Celular"><Smartphone size={15} /></button>
            </div>
          </div>
          <div className={`fa-pv-frame ${device}`}>
            <div className="fa-pv-url"><Globe size={12} /> {PUBLIC_BASE.replace(/^https?:\/\//, "")}/f/?{slugify(draft.slug) || "…"}</div>
            <div className="fa-pv-scroll">
              <FormRenderer key={`${screenKey}-${draft.style}`} form={preview} preview startAt={shownPhase} />
            </div>
          </div>
          <p className="fa-pv-hint"><Eye size={13} /> Pré-visualização: dá para clicar e navegar. Nada é gravado no CRM aqui.</p>
        </section>
      </div>

      {editable && (
        <div className="fa-danger">
          <button type="button" className="crm-link" onClick={duplicate}><Copy size={13} /> Duplicar formulário</button>
          <button type="button" className="crm-link danger" onClick={() => setArchive(true)}><Trash2 size={13} /> Arquivar formulário</button>
        </div>
      )}
      <Confirm open={archive} danger title="Arquivar formulário?" confirmLabel="Arquivar"
        text="O link deixa de funcionar. As respostas já recebidas continuam no CRM."
        onConfirm={() => { setArchive(false); setStatus("archived"); }} onClose={() => setArchive(false)} />
    </div>
  );
}

function Section({ title, children, open: initial = true, right }: { title: string; children: ReactNode; open?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`fa-sec${open ? " open" : ""}`}>
      <div className="fa-sec-head">
        <button type="button" onClick={() => setOpen(!open)}><ArrowDown size={14} className="fa-caret" /> {title}</button>
        {right}
      </div>
      {open && <div className="fa-sec-body">{children}</div>}
    </div>
  );
}

const T = ({ value, onChange, placeholder, rows }: { value?: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) =>
  rows ? <textarea className="crm-input" rows={rows} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    : <input className="crm-input" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;

function ImageField({ value, onChange, label }: { value?: string; onChange: (url: string) => void; label: string }) {
  const crm = useCrm();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const up = async (f?: File) => {
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) { crm.notify("Use PNG, JPG ou WEBP."); return; }
    setBusy(true);
    try { onChange((await crmApi.uploadFlowMedia(crm.tenantId, f)).url); } catch (e) { crm.notify(errorText(e)); } finally { setBusy(false); if (ref.current) ref.current.value = ""; }
  };
  return (
    <div className="fa-img">
      <span className="fa-img-label">{label}</span>
      <div className="fa-img-row">
        <div className="fa-img-thumb">{value ? <img src={value} alt="" /> : <ImagePlus size={16} />}</div>
        <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => up(e.target.files?.[0])} />
        <button type="button" className="crm-btn ghost sm" disabled={busy} onClick={() => ref.current?.click()}>{busy ? "Enviando…" : value ? "Trocar" : "Enviar imagem"}</button>
        {value && <button type="button" className="crm-icon-btn" title="Remover" onClick={() => onChange("")}><X size={14} /></button>}
      </div>
    </div>
  );
}

function ContentTab({ draft, setC, goTo }: { draft: Draft; setC: (fn: (c: FormContent) => FormContent) => void; goTo: (p: Phase) => void }) {
  const c = draft.content;
  const header = (p: Partial<FormContent["header"]>) => setC((x) => ({ ...x, header: { ...x.header, ...p } }));
  const intro = (p: Partial<FormContent["intro"]>) => setC((x) => ({ ...x, intro: { ...x.intro, ...p } }));
  const capture = (p: Partial<FormContent["capture"]>) => setC((x) => ({ ...x, capture: { ...x.capture, ...p } }));
  const done = (p: Partial<FormContent["done"]>) => setC((x) => ({ ...x, done: { ...x.done, ...p } }));
  const setQ = (i: number, q: FormQuestion) => setC((x) => ({ ...x, questions: x.questions.map((y, j) => (j === i ? q : y)) }));
  const moveQ = (i: number, d: -1 | 1) => setC((x) => {
    const qs = [...x.questions]; const j = i + d; if (j < 0 || j >= qs.length) return x;
    [qs[i], qs[j]] = [qs[j], qs[i]]; return { ...x, questions: qs };
  });
  const addQ = (type: QuestionType) => { setC((x) => ({ ...x, questions: [...x.questions, newQuestion(type)] })); goTo({ kind: "q", i: c.questions.length }); };

  return (
    <>
      <Section title="Topo e marca">
        <Field label="Nome que aparece" hint="Ex.: nome do profissional ou da empresa."><T value={c.header.name} onChange={(v) => header({ name: v })} /></Field>
        <Field label="Linha de baixo" hint="Registro profissional, cidade, especialidade."><T value={c.header.subtitle} onChange={(v) => header({ subtitle: v })} placeholder="CRM-GO 00000 · Rio Verde · GO" /></Field>
        {draft.style === "card" && <ImageField label="Foto (rosto do profissional ou da equipe)" value={c.header.avatar_url} onChange={(v) => header({ avatar_url: v })} />}
        <ImageField label="Logo só deste formulário (opcional, senão usa a da empresa)" value={c.header.logo_url} onChange={(v) => header({ logo_url: v })} />
      </Section>

      <Section title="Abertura" right={<button type="button" className="crm-link" onClick={() => goTo({ kind: "intro" })}>ver</button>}>
        {draft.style === "card" && <>
          <Field label="Texto pequeno na capa"><T value={c.intro.eyebrow} onChange={(v) => intro({ eyebrow: v })} /></Field>
          <Field label="Selo"><T value={c.intro.badge} onChange={(v) => intro({ badge: v })} placeholder="Ex.: Lipo HD" /></Field>
        </>}
        <Field label="Título" hint="Coloque **entre asteriscos** o que deve ficar em negrito."><T rows={2} value={c.intro.title} onChange={(v) => intro({ title: v })} /></Field>
        <Field label="Texto de apoio"><T rows={2} value={c.intro.subtitle} onChange={(v) => intro({ subtitle: v })} /></Field>
        <ListEditor label={draft.style === "card" ? "Tópicos com ✓" : "Tópicos (comece com um emoji)"} items={c.intro.bullets} onChange={(b) => intro({ bullets: b })} />
        {draft.style === "steps" && <Field label="Observação em itálico"><T rows={2} value={c.intro.note} onChange={(v) => intro({ note: v })} /></Field>}
        <Field label="Texto do botão"><T value={c.intro.cta} onChange={(v) => intro({ cta: v })} /></Field>
        {draft.style === "card" && <Field label="Linha abaixo do botão"><T value={c.intro.footnote} onChange={(v) => intro({ footnote: v })} /></Field>}
      </Section>

      <Section title={`Perguntas (${c.questions.length})`}>
        {c.questions.map((q, i) => (
          <QuestionEditor key={q.id} q={q} i={i} total={c.questions.length} style={draft.style}
            onChange={(nq) => setQ(i, nq)} onMove={(d) => moveQ(i, d)} onFocus={() => goTo({ kind: "q", i })}
            onRemove={() => { setC((x) => ({ ...x, questions: x.questions.filter((_, j) => j !== i) })); goTo({ kind: "intro" }); }} />
        ))}
        <div className="fa-addq">
          <button type="button" className="crm-btn ghost sm" onClick={() => addQ("choice")}><MousePointerClick size={14} /> Escolha única</button>
          <button type="button" className="crm-btn ghost sm" onClick={() => addQ("multi")}><CheckSquare size={14} /> Várias escolhas</button>
          <button type="button" className="crm-btn ghost sm" onClick={() => addQ("text")}><Type size={14} /> Resposta escrita</button>
        </div>
      </Section>

      <Section title="Dados de contato" right={<button type="button" className="crm-link" onClick={() => goTo({ kind: "capture" })}>ver</button>}>
        <Field label="Título"><T value={c.capture.title} onChange={(v) => capture({ title: v })} /></Field>
        <Field label="Texto de apoio"><T value={c.capture.subtitle} onChange={(v) => capture({ subtitle: v })} /></Field>
        <div className="fa-checks">
          <label><input type="checkbox" checked={c.capture.fields.name} onChange={(e) => capture({ fields: { ...c.capture.fields, name: e.target.checked } })} /> Nome</label>
          <label><input type="checkbox" checked={c.capture.fields.phone} onChange={(e) => capture({ fields: { ...c.capture.fields, phone: e.target.checked } })} /> WhatsApp</label>
          <label><input type="checkbox" checked={c.capture.fields.email} onChange={(e) => capture({ fields: { ...c.capture.fields, email: e.target.checked } })} /> E-mail</label>
          {c.capture.fields.email && <label><input type="checkbox" checked={!!c.capture.email_required} onChange={(e) => capture({ email_required: e.target.checked })} /> E-mail obrigatório</label>}
        </div>
        {!c.capture.fields.phone && !c.capture.fields.email && <p className="fa-warn">Peça WhatsApp ou e-mail: sem um dos dois o contato não entra no CRM.</p>}
        <Field label="Texto do botão"><T value={c.capture.button} onChange={(v) => capture({ button: v })} /></Field>
        <Field label="Frase de privacidade"><T value={c.capture.privacy} onChange={(v) => capture({ privacy: v })} /></Field>
      </Section>

      <Section title="Tela final" right={<button type="button" className="crm-link" onClick={() => goTo({ kind: "done" })}>ver</button>}>
        <Field label="Título"><T value={c.done.title} onChange={(v) => done({ title: v })} /></Field>
        <Field label="Texto"><T rows={2} value={c.done.text} onChange={(v) => done({ text: v })} /></Field>
        <Field label="Botão (opcional)"><T value={c.done.button_label} onChange={(v) => done({ button_label: v })} placeholder="Falar agora no WhatsApp" /></Field>
        <Field label="Link do botão" hint="Um link de WhatsApp (wa.me/55…), agenda ou site."><T value={c.done.button_url} onChange={(v) => done({ button_url: v })} placeholder="https://wa.me/5564999999999" /></Field>
      </Section>

      <Section title="Aviso no rodapé" open={false}>
        <Field label="Texto" hint="Ex.: exigências do conselho profissional. Deixe vazio para não mostrar."><T rows={2} value={c.disclaimer} onChange={(v) => setC((x) => ({ ...x, disclaimer: v }))} /></Field>
      </Section>
    </>
  );
}

function ListEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="fa-listed">
      <span className="fa-img-label">{label}</span>
      {items.map((b, i) => (
        <div key={i} className="fa-listed-row">
          <input className="crm-input" value={b} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="crm-icon-btn" title="Remover" onClick={() => onChange(items.filter((_, j) => j !== i))}><X size={14} /></button>
        </div>
      ))}
      {items.length < 8 && <button type="button" className="crm-link" onClick={() => onChange([...items, ""])}><Plus size={13} /> Adicionar tópico</button>}
    </div>
  );
}

const TYPE_LABEL: Record<QuestionType, string> = { choice: "Escolha única", multi: "Várias escolhas", text: "Resposta escrita" };

function QuestionEditor({ q, i, total, style, onChange, onMove, onRemove, onFocus }: {
  q: FormQuestion; i: number; total: number; style: FormStyle;
  onChange: (q: FormQuestion) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onFocus: () => void;
}) {
  const [iconFor, setIconFor] = useState<string | null>(null);
  const setOpt = (id: string, p: Partial<FormQuestion["options"][number]>) => onChange({ ...q, options: q.options.map((o) => (o.id === id ? { ...o, ...p } : o)) });
  return (
    <div className="fa-q" onFocusCapture={onFocus}>
      <div className="fa-q-head">
        <span className="fa-q-n">{i + 1}</span>
        <select className="crm-input sm" value={q.type} onChange={(e) => {
          const type = e.target.value as QuestionType;
          onChange({ ...q, type, options: type === "text" ? [] : q.options.length ? q.options : [newOption(1), newOption(2)] });
        }}>
          {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <div className="fa-q-tools">
          <button type="button" className="crm-icon-btn" disabled={i === 0} title="Subir" onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
          <button type="button" className="crm-icon-btn" disabled={i === total - 1} title="Descer" onClick={() => onMove(1)}><ArrowDown size={14} /></button>
          <button type="button" className="crm-icon-btn" title="Excluir pergunta" onClick={onRemove}><Trash2 size={14} /></button>
        </div>
      </div>
      <input className="crm-input fa-q-title" value={q.title} placeholder="Pergunta" onChange={(e) => onChange({ ...q, title: e.target.value })} />
      <input className="crm-input sm" value={q.help ?? ""} placeholder="Explicação abaixo da pergunta (opcional)" onChange={(e) => onChange({ ...q, help: e.target.value })} />
      {q.type === "text" ? (
        <input className="crm-input sm" value={q.placeholder ?? ""} placeholder="Texto de exemplo dentro do campo" onChange={(e) => onChange({ ...q, placeholder: e.target.value })} />
      ) : (
        <div className="fa-opts">
          {q.options.map((o, k) => {
            const Icon = o.icon ? OPTION_ICONS[o.icon] : null;
            return (
              <div key={o.id} className="fa-opt">
                {style === "card" ? (
                  <div className="fa-opt-icon">
                    <button type="button" className="fa-icon-btn" title="Ícone" onClick={() => setIconFor(iconFor === o.id ? null : o.id)}>{Icon ? <Icon size={15} /> : <ImagePlus size={14} />}</button>
                    {iconFor === o.id && (
                      <div className="fa-icon-pop">
                        <button type="button" onClick={() => { setOpt(o.id, { icon: undefined }); setIconFor(null); }} title="Sem ícone"><X size={14} /></button>
                        {Object.entries(OPTION_ICONS).map(([k2, I]) => <button key={k2} type="button" className={o.icon === k2 ? "on" : ""} onClick={() => { setOpt(o.id, { icon: k2 }); setIconFor(null); }}><I size={15} /></button>)}
                      </div>
                    )}
                  </div>
                ) : <span className="fa-opt-key">{String.fromCharCode(65 + k)}</span>}
                <input className="crm-input sm" value={o.label} onChange={(e) => setOpt(o.id, { label: e.target.value })} />
                <button type="button" className="crm-icon-btn" title="Remover opção" disabled={q.options.length <= 1} onClick={() => onChange({ ...q, options: q.options.filter((x) => x.id !== o.id) })}><X size={14} /></button>
              </div>
            );
          })}
          {q.options.length < 12 && <button type="button" className="crm-link" onClick={() => onChange({ ...q, options: [...q.options, newOption(q.options.length + 1)] })}><Plus size={13} /> Adicionar opção</button>}
        </div>
      )}
      <label className="fa-req"><input type="checkbox" checked={q.required !== false} onChange={(e) => onChange({ ...q, required: e.target.checked })} /> Obrigatória</label>
    </div>
  );
}

function LookTab({ draft, set, setC, onReset }: { draft: Draft; set: (p: Partial<Draft>) => void; setC: (fn: (c: FormContent) => FormContent) => void; onReset: () => void }) {
  const th = draft.content.theme;
  const theme = (p: Partial<FormContent["theme"]>) => setC((x) => ({ ...x, theme: { ...x.theme, ...p } }));
  const fontSelect = (value: string | undefined, onChange: (v: string) => void, def: string) => (
    <select className="crm-input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">Padrão do estilo ({def})</option>
      {Object.entries(FONTS).map(([k, f]) => <option key={k} value={k} style={{ fontFamily: f.family }}>{f.label}{f.serif ? " (com serifa)" : ""}</option>)}
    </select>
  );
  return (
    <>
      <Section title="Estilo">
        <div className="fa-style-pick compact">
          {(["card", "steps"] as FormStyle[]).map((s) => (
            <button key={s} type="button" className={draft.style === s ? "on" : ""} onClick={() => set({ style: s })}>
              <div className={`fa-mini ${s}`}>
                {s === "card" ? <><i className="bar" /><i className="cover" /><i className="l1" /><i className="l2" /><i className="grid" /></> : <><i className="logo" /><i className="h1" /><i className="h2" /><i className="li" /><i className="li" /><i className="btn" /></>}
              </div>
              <strong>{STYLE_LABEL[s]}</strong>
            </button>
          ))}
        </div>
        <p className="crm-muted fa-small">Trocar o estilo mantém os textos e as perguntas.</p>
      </Section>
      <Section title="Cores">
        <div className="fa-palettes">
          {PALETTES.map((p) => (
            <button key={p.name} type="button" title={p.name} className={th.color.toLowerCase() === p.color.toLowerCase() && th.accent.toLowerCase() === p.accent.toLowerCase() ? "on" : ""}
              onClick={() => theme({ color: p.color, accent: p.accent, bg: p.bg ?? "" })}>
              <i style={{ background: p.color }} /><i style={{ background: p.accent }} /><i style={{ background: p.bg ?? (draft.style === "card" ? "#f4f6f8" : "#fff") }} />
            </button>
          ))}
        </div>
        <div className="fa-colors">
          <label className="fa-color big"><input type="color" value={th.color} onChange={(e) => theme({ color: e.target.value })} /><span><strong>Cor principal</strong><small>{draft.style === "card" ? "Topo, capa, rodapé e botões" : "Detalhes e textos de destaque"}</small></span></label>
          <label className="fa-color big"><input type="color" value={th.accent} onChange={(e) => theme({ accent: e.target.value })} /><span><strong>Cor de destaque</strong><small>{draft.style === "card" ? "Botão final" : "Botão, opções e barra"}</small></span></label>
          <label className="fa-color big"><input type="color" value={th.bg || (draft.style === "card" ? "#f4f6f8" : "#ffffff")} onChange={(e) => theme({ bg: e.target.value })} />
            <span><strong>Fundo da página</strong><small>{th.bg ? <button type="button" className="crm-link" onClick={(e) => { e.preventDefault(); theme({ bg: "" }); }}>voltar ao padrão</button> : "Padrão do estilo"}</small></span></label>
        </div>
        <p className="crm-muted fa-small">O texto sobre cada cor fica claro ou escuro sozinho para continuar legível.</p>
      </Section>
      <Section title="Fontes">
        <Field label="Títulos e perguntas">{fontSelect(th.title_font, (v) => theme({ title_font: v }), draft.style === "card" ? "Fraunces" : "Inter")}</Field>
        <Field label="Textos, opções e botões">{fontSelect(th.body_font, (v) => theme({ body_font: v }), "Inter")}</Field>
      </Section>
      <Section title="Cantos">
        <Segmented size="sm" value={(th.radius || "") as "" | "square" | "soft" | "round"} onChange={(v) => theme({ radius: v })}
          options={[{ value: "", label: "Padrão" }, { value: "square", label: "Retos" }, { value: "soft", label: "Suaves" }, { value: "round", label: "Redondos" }]} />
      </Section>
      <Section title="Endereço">
        <Field label="Link do formulário" hint="Só letras minúsculas, números e hífen. Mudar o endereço quebra links que já foram divulgados.">
          <div className="fa-slug"><span>/f/?</span><input className="crm-input" value={draft.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></div>
        </Field>
      </Section>
      <Section title="Recomeçar" open={false}>
        <p className="crm-muted fa-small">Troca textos, perguntas e cores pelo modelo inicial do estilo {STYLE_LABEL[draft.style]}. Dá para desfazer saindo sem salvar.</p>
        <button type="button" className="crm-btn ghost sm" onClick={onReset}>Voltar ao modelo</button>
      </Section>
    </>
  );
}

function CrmTab({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const crm = useCrm();
  const s = draft.settings;
  const upd = (p: Partial<FormSettings>) => set({ settings: { ...s, ...p } });
  const [tag, setTag] = useState("");
  const openStages = crm.stages.filter((st) => st.kind === "open");
  return (
    <>
      <Section title="O que acontece quando alguém responde">
        <ul className="fa-flow">
          <li><Check size={14} /> O contato é criado (ou encontrado pelo WhatsApp) com origem <b>formulário</b>.</li>
          <li><Check size={14} /> As respostas, a campanha, o anúncio e o aparelho ficam na linha do tempo.</li>
          <li><Check size={14} /> Quem estiver no comando recebe um aviso no sino.</li>
        </ul>
        <label className="fa-req"><input type="checkbox" checked={s.create_deal !== false} onChange={(e) => upd({ create_deal: e.target.checked })} /> Criar negociação no funil</label>
        {s.create_deal !== false && <>
          <Field label="Etapa do funil">
            <select className="crm-input" value={s.stage_id ?? ""} onChange={(e) => upd({ stage_id: e.target.value || null })}>
              <option value="">Primeira etapa do funil principal</option>
              {crm.pipelines.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {openStages.filter((st) => st.pipeline_id === p.id).map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Título da negociação" hint="O nome da pessoa entra no final. Ex.: Lipo · Maria"><input className="crm-input" value={s.deal_title ?? ""} placeholder={draft.name} onChange={(e) => upd({ deal_title: e.target.value })} /></Field>
        </>}
        <Field label="Responsável">
          <select className="crm-input" value={s.owner_id ?? ""} onChange={(e) => upd({ owner_id: e.target.value || null })}>
            <option value="">Ninguém em especial</option>
            {crm.members.map((m) => <option key={m.user_id} value={m.user_id}>{crm.memberLabel(m.user_id)}</option>)}
          </select>
        </Field>
        <div className="fa-listed">
          <span className="fa-img-label">Etiquetas no contato</span>
          <div className="fa-tags">
            <span className="fa-tag auto">formulário: {draft.name}</span>
            {(s.tags ?? []).map((t) => <span key={t} className="fa-tag">{t}<button type="button" onClick={() => upd({ tags: (s.tags ?? []).filter((x) => x !== t) })}><X size={11} /></button></span>)}
          </div>
          <div className="fa-listed-row">
            <input className="crm-input sm" value={tag} placeholder="Nova etiqueta" onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && tag.trim()) { e.preventDefault(); upd({ tags: Array.from(new Set([...(s.tags ?? []), tag.trim()])) }); setTag(""); }
            }} />
            <button type="button" className="crm-btn ghost sm" disabled={!tag.trim()} onClick={() => { upd({ tags: Array.from(new Set([...(s.tags ?? []), tag.trim()])) }); setTag(""); }}>Adicionar</button>
          </div>
        </div>
      </Section>
      <Section title="Rastreamento de anúncios">
        <p className="crm-muted fa-small">O formulário já guarda sozinho utm_source, utm_campaign, utm_content, fbclid e gclid do link do anúncio. No anúncio, use o link copiado e acrescente os parâmetros com &, por exemplo: …/f/?seu-formulario&utm_source=instagram&utm_campaign=lipo.</p>
        <Field label="Pixel da Meta (opcional)" hint="Só o número. Dispara PageView ao abrir e Lead ao enviar.">
          <input className="crm-input" inputMode="numeric" value={s.pixel_id ?? ""} placeholder="123456789012345" onChange={(e) => upd({ pixel_id: e.target.value.replace(/\D/g, "").slice(0, 20) })} />
        </Field>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------
const EVENT_LABEL: Record<string, string> = {
  view: "Abriu o formulário", start: "Começou", step_view: "Viu", answer: "Respondeu", back: "Voltou", click: "Clicou",
  capture_view: "Chegou nos dados de contato", submit: "Enviou", done_click: "Clicou no botão final",
};

function AnswersTab({ form }: { form: FormRow }) {
  const crm = useCrm();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [only, setOnly] = useState<"leads" | "all">("leads");
  const [funnel, setFunnel] = useState<{ step: number; reached: number }[] | null>(null);
  const [sessions, setSessions] = useState<FormSession[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setFunnel(null); setSessions(null);
    api.formFunnel(form.id, Number(days)).then(setFunnel).catch(() => setFunnel([]));
    api.formSessions(form.id, { onlyLeads: only === "leads", days: Number(days) }).then(setSessions).catch((e) => { crm.notify(errorText(e)); setSessions([]); });
  }, [form.id, days, only]); // eslint-disable-line react-hooks/exhaustive-deps

  const qs = form.content.questions ?? [];
  const stepLabel = (s: number) => (s === 0 ? "Abriram" : s <= qs.length ? `${s}. ${qs[s - 1]?.title ?? ""}` : "Enviaram os dados");
  const top = funnel?.[0]?.reached || 0;

  return (
    <div className="fa-answers">
      <div className="fa-ans-filters">
        <Segmented size="sm" value={days} onChange={setDays} options={[{ value: "7", label: "7 dias" }, { value: "30", label: "30 dias" }, { value: "90", label: "90 dias" }]} />
      </div>
      <Section title="Onde as pessoas param">
        {!funnel ? <Skeleton rows={3} height={22} /> : top === 0 ? <p className="crm-muted fa-small">Ainda sem visitas neste período.</p> : (
          <div className="fa-funnel">
            {funnel.map((f, i) => {
              const pct = Math.round((f.reached / top) * 100);
              const prev = i > 0 ? funnel[i - 1].reached : f.reached;
              const drop = prev ? Math.round(((prev - f.reached) / prev) * 100) : 0;
              return (
                <div key={f.step} className="fa-fn-row">
                  <div className="fa-fn-label"><span title={stepLabel(f.step)}>{stepLabel(f.step)}</span><b>{num(f.reached)}</b></div>
                  <div className="fa-fn-bar"><i style={{ width: `${Math.max(pct, 2)}%` }} /></div>
                  <small>{pct}%{i > 0 && drop > 0 ? ` · ${drop}% saíram aqui` : ""}</small>
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section title="Visitas" right={<Segmented size="sm" value={only} onChange={setOnly} options={[{ value: "leads", label: "Enviaram" }, { value: "all", label: "Todas" }]} />}>
        {!sessions ? <Skeleton rows={4} height={44} /> : sessions.length === 0 ? <p className="crm-muted fa-small">{only === "leads" ? "Ninguém enviou ainda neste período." : "Nenhuma visita neste período."}</p> : (
          <div className="fa-sessions">
            {sessions.map((s) => (
              <SessionRow key={s.id} s={s} qs={qs} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function origin(s: FormSession): string {
  if (s.utm_source || s.utm_campaign) return [s.utm_source, s.utm_medium, s.utm_campaign].filter(Boolean).join(" / ");
  if (s.fbclid) return "Anúncio Meta";
  if (s.gclid) return "Anúncio Google";
  if (s.referrer) { try { return new URL(s.referrer).hostname.replace(/^www\./, ""); } catch { return s.referrer; } }
  return "Direto";
}

function SessionRow({ s, qs, open, onToggle }: { s: FormSession; qs: FormQuestion[]; open: boolean; onToggle: () => void }) {
  const crm = useCrm();
  const done = !!s.completed_at;
  const titleOf = (id: string) => qs.find((q) => q.id === id)?.title ?? id;
  const answered = Object.keys(s.answers ?? {}).length;
  const ordered = [...qs.filter((q) => s.answers?.[q.id] !== undefined).map((q) => q.id), ...Object.keys(s.answers ?? {}).filter((k) => !qs.some((q) => q.id === k))];
  const t0 = s.events?.[0] ? new Date(s.events[0].t).getTime() : 0;
  const tEnd = s.events?.length ? new Date(s.events[s.events.length - 1].t).getTime() : 0;
  const secs = t0 && tEnd ? Math.round((tEnd - t0) / 1000) : 0;
  return (
    <div className={`fa-ses${open ? " open" : ""}`}>
      <button type="button" className="fa-ses-head" onClick={onToggle}>
        <span className={`fa-dot ${done ? "ok" : ""}`} />
        <span className="fa-ses-who">
          <strong>{s.name || (done ? "Sem nome" : "Visitante")}</strong>
          <small>{done ? (s.phone || s.email || "") : `parou em ${s.max_step === 0 ? "abertura" : s.max_step > qs.length ? "dados de contato" : `pergunta ${s.max_step}`} · ${answered} resposta(s)`}</small>
        </span>
        <span className="fa-ses-meta"><small>{origin(s)}</small><small>{s.device ? s.device.charAt(0).toUpperCase() + s.device.slice(1) : ""} · {relative(s.created_at)}</small></span>
      </button>
      {open && (
        <div className="fa-ses-body">
          {ordered.length > 0 && (
            <dl className="fa-qa">
              {ordered.map((k) => <div key={k}><dt>{titleOf(k)}</dt><dd>{s.answers[k]}</dd></div>)}
            </dl>
          )}
          <div className="fa-ses-grid">
            <div><small>Origem</small><span>{origin(s)}</span></div>
            {s.utm_content && <div><small>Anúncio (utm_content)</small><span>{s.utm_content}</span></div>}
            {s.utm_term && <div><small>Termo</small><span>{s.utm_term}</span></div>}
            <div><small>Tempo no formulário</small><span>{secs ? (secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`) : "-"}</span></div>
            <div><small>Entrou em</small><span>{dateTime(s.created_at)}</span></div>
            {s.landing_url && <div className="wide"><small>Link de entrada</small><span className="fa-break">{s.landing_url}</span></div>}
          </div>
          {s.events?.length > 0 && (
            <details className="fa-events">
              <summary><BarChart3 size={13} /> Caminho completo ({s.events.length} cliques e telas)</summary>
              <ol>
                {s.events.map((e, i) => (
                  <li key={i}>
                    <time>{new Date(e.t).toLocaleTimeString("pt-BR")}</time>
                    <span>{EVENT_LABEL[e.e] ?? e.e}{e.e === "step_view" && e.s ? ` a pergunta ${e.s}` : ""}{e.q ? `: ${titleOf(e.q)}` : ""}{e.a ? ` → ${e.a}` : ""}{e.label ? ` (${e.label})` : ""}{e.ms ? ` · ${(e.ms / 1000).toFixed(1)} s` : ""}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <div className="fa-ses-actions">
            {s.contact_id && <button type="button" className="crm-btn ghost sm" onClick={() => crm.openContact(s.contact_id!)}><ListChecks size={14} /> Abrir contato</button>}
            {s.deal_id && <button type="button" className="crm-btn ghost sm" onClick={() => crm.openDeal(s.deal_id!)}>Abrir negociação</button>}
          </div>
        </div>
      )}
    </div>
  );
}
