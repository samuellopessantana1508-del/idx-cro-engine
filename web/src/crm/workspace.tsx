import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../styles/crm.css";
import { Bell, Building2, Check, KanbanSquare, ListTodo, Mic, PhoneCall, Plus, Search, ShieldAlert, User, UserPlus, X } from "lucide-react";
import * as api from "./api";
import { CrmContext, useCrm, type CrmCtx, type QuickCreateKind } from "./context";
import { brl, channelLabels, emailName, errorText, parseMoney, phoneLabel, relative } from "./format";
import type { Company, CrmAccess, CrmNotification, CrmSettings, CrmView, LossReason, Member, Offer, Pipeline, Priority, Stage } from "./types";
import { Empty, Field, Modal, Spinner } from "./ui";
import { DealsView } from "./deals";
import { DealDrawer } from "./deal-drawer";
import { TaskModal } from "./records";
import { HomeView, RoutineView } from "./home";
import { CompaniesView, ContactPage, ContactsView } from "./contacts";
import { TasksView } from "./tasks";
import { ProductsView } from "./catalog";
import { RfvView } from "./rfv";
import { ReportsView } from "./reports";
import { AutomationsView, ImportView, SettingsView } from "./admin";
import { DialerView } from "./dialer";
import { CadencesView } from "./cadences";
import { GoalsView } from "./goals";
import { DispatchView } from "./dispatch";
import { McpView } from "./mcp";
const FlowsView = lazy(() => import("./flows").then((m) => ({ default: m.FlowsView })));
import { AssistantModal, type AssistantContext } from "./assistant";
import type { AssistantPlan } from "./types";

export const crmViewTitles: Record<CrmView["name"], string> = {
  home: "Visão comercial",
  routine: "Minha rotina",
  deals: "Negociações",
  contacts: "Contatos",
  contact: "Contato",
  companies: "Empresas",
  tasks: "Tarefas e agenda",
  products: "Produtos e serviços",
  rfv: "Clientes e RFV",
  reports: "Indicadores",
  automations: "Automações",
  settings: "Configurações do CRM",
  import: "Importar e exportar",
  dialer: "Discador",
  cadences: "Cadências",
  goals: "Metas",
  dispatch: "Disparos de WhatsApp",
  flows: "Automações de WhatsApp",
  mcp: "Conectar ao Claude (MCP)",
};

type Props = {
  tenantId: string;
  tenantName: string;
  userId: string;
  view: CrmView;
  onNavigate: (v: CrmView) => void;
  notify: (msg: string) => void;
};

export function CrmWorkspace({ tenantId, tenantName, userId, view, onNavigate, notify }: Props) {
  const [access, setAccess] = useState<CrmAccess | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [lossReasons, setLossReasons] = useState<LossReason[]>([]);
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dealId, setDealId] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ kind: QuickCreateKind; defaults: Record<string, unknown> } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [assistant, setAssistant] = useState<{ context?: AssistantContext; onApplied?: (r: { plan: AssistantPlan; contact_id: string | null; deal_id: string | null; task_id: string | null }) => void } | null>(null);

  const reloadStructure = useCallback(async () => {
    const acc = await api.myAccess(tenantId);
    setAccess(acc);
    if (!acc.read) return;
    let s = await api.loadPipelines(tenantId);
    if (!s.pipelines.length && acc.configure) {
      await api.setupTenant(tenantId);
      s = await api.loadPipelines(tenantId);
    }
    setPipelines(s.pipelines);
    setStages(s.stages);
    setLossReasons(s.lossReasons);
    setSettings(s.settings);
    const [m, o] = await Promise.all([api.loadMembers(tenantId).catch(() => []), api.loadOffers(tenantId).catch(() => [])]);
    setMembers(m);
    setOffers(o);
  }, [tenantId]);

  useEffect(() => {
    let alive = true;
    setAccess(null); setError(null); setDealId(null);
    reloadStructure()
      .then(() => { if (alive) void api.runScheduled(tenantId); })
      .catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [reloadStructure, tenantId]);

  // atalhos: Ctrl/Cmd+K busca global; "n" nova negociação; "t" nova tarefa
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".crm-overlay")) return;
      if (e.key === "/") { e.preventDefault(); setSearchOpen(true); }
      if (access?.write && e.key === "n") { e.preventDefault(); setQuick({ kind: "deal", defaults: {} }); }
      if (access?.write && e.key === "t") { e.preventDefault(); setQuick({ kind: "task", defaults: {} }); }
      if (access?.write && e.key === "c") { e.preventDefault(); setQuick({ kind: "contact", defaults: {} }); }
      if (access?.write && e.key === "v") { e.preventDefault(); setAssistant({}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [access]);

  const memberLabel = useCallback((id: string | null | undefined) => {
    if (!id) return "Sem responsável";
    const m = members.find((x) => x.user_id === id);
    return m ? emailName(m.email) : "Usuário";
  }, [members]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const ctx: CrmCtx | null = useMemo(() => access ? {
    tenantId, tenantName, userId, access, members, pipelines, stages, lossReasons, settings, offers, refreshKey, notify, refresh,
    reloadStructure: async () => { try { await reloadStructure(); } catch (e) { notify(errorText(e)); } },
    navigate: (v) => { setDealId(null); onNavigate(v); },
    openDeal: (id) => setDealId(id),
    openContact: (id) => { setDealId(null); onNavigate({ name: "contact", id }); },
    quickCreate: (kind, defaults = {}) => setQuick({ kind, defaults }),
    memberLabel,
    openAssistant: (context, onApplied) => setAssistant({ context, onApplied }),
  } : null, [access, tenantId, tenantName, userId, members, pipelines, stages, lossReasons, settings, offers, refreshKey, notify, refresh, reloadStructure, onNavigate, memberLabel]);

  if (error) {
    return (
      <div className="crm-root">
        <Empty icon={<ShieldAlert />} title="Não foi possível abrir o CRM" text={error}
          action={<button type="button" className="crm-btn primary" onClick={() => { setError(null); reloadStructure().catch((e) => setError(errorText(e))); }}>Tentar novamente</button>} />
      </div>
    );
  }
  if (!ctx) return <div className="crm-root"><Spinner label="Abrindo o CRM…" /></div>;
  if (!ctx.access.read) {
    return <div className="crm-root"><Empty icon={<ShieldAlert />} title="Sem acesso ao CRM desta empresa" text="Peça ao administrador da empresa para liberar seu acesso." /></div>;
  }
  if (!pipelines.length) {
    return <div className="crm-root"><Empty icon={<KanbanSquare />} title="O CRM desta empresa ainda não foi ativado" text="Um administrador da empresa precisa abrir o CRM uma vez para criar o funil padrão." /></div>;
  }

  return (
    <CrmContext.Provider value={ctx}>
      <div className="crm-root">
        <div className="crm-commandbar">
          <button type="button" className="crm-searchbox" onClick={() => setSearchOpen(true)}>
            <Search size={16} /> <span>Buscar contatos, negociações, empresas…</span> <kbd>Ctrl K</kbd>
          </button>
          <div className="crm-commandbar-right">
            {ctx.access.write && <button type="button" className="crm-btn ghost" onClick={() => setAssistant({})} title="Fale ou escreva o que aconteceu — atalho: tecla V"><Mic size={16} /> Registrar</button>}
            {ctx.access.write && <button type="button" className="crm-btn ghost" onClick={() => setQuick({ kind: "contact", defaults: {} })} title="Cliente rápido — atalho: tecla C" aria-label="Cliente rápido"><PhoneCall size={16} /> <span className="crm-hide-mobile">Cliente rápido</span></button>}
            {ctx.access.write && <QuickCreateMenu onPick={(kind) => setQuick({ kind, defaults: {} })} />}
            <NotificationBell />
          </div>
        </div>
        <ViewSwitch view={view} />
        {dealId && <DealDrawer key={dealId} dealId={dealId} onClose={() => setDealId(null)} />}
        {quick?.kind === "deal" && <DealQuickModal defaults={quick.defaults} onClose={() => setQuick(null)} onCreated={(id) => { setQuick(null); refresh(); setDealId(id); }} />}
        {quick?.kind === "contact" && <ContactQuickModal defaults={quick.defaults} onClose={() => setQuick(null)} onCreated={(id, openIt) => { setQuick(null); refresh(); if (openIt) ctx.openContact(id); }} />}
        {quick?.kind === "company" && <CompanyModal onClose={() => setQuick(null)} onSaved={() => { setQuick(null); refresh(); }} />}
        {quick?.kind === "task" && <TaskModal defaults={quick.defaults as never} onClose={() => setQuick(null)} onSaved={() => { setQuick(null); refresh(); }} />}
        {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
        {assistant && <AssistantModal context={assistant.context} onApplied={assistant.onApplied} onClose={() => setAssistant(null)} />}
      </div>
    </CrmContext.Provider>
  );
}

function ViewSwitch({ view }: { view: CrmView }) {
  switch (view.name) {
    case "home": return <HomeView />;
    case "routine": return <RoutineView />;
    case "deals": return <DealsView />;
    case "contacts": return <ContactsView />;
    case "contact": return <ContactPage key={view.id} contactId={view.id} />;
    case "companies": return <CompaniesView />;
    case "tasks": return <TasksView />;
    case "products": return <ProductsView />;
    case "rfv": return <RfvView />;
    case "reports": return <ReportsView />;
    case "automations": return <AutomationsView />;
    case "settings": return <SettingsView />;
    case "import": return <ImportView />;
    case "dialer": return <DialerView />;
    case "cadences": return <CadencesView />;
    case "goals": return <GoalsView />;
    case "dispatch": return <DispatchView />;
    case "flows": return <Suspense fallback={<div className="crm-page"><p className="crm-muted">Carregando automações…</p></div>}><FlowsView /></Suspense>;
    case "mcp": return <McpView />;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Barra de comandos
// ---------------------------------------------------------------------------
function QuickCreateMenu({ onPick }: { onPick: (k: QuickCreateKind) => void }) {
  const [open, setOpen] = useState(false);
  const items: { k: QuickCreateKind; label: string; icon: ReactNode; key?: string }[] = [
    { k: "deal", label: "Negociação", icon: <KanbanSquare size={15} />, key: "N" },
    { k: "contact", label: "Cliente / contato", icon: <UserPlus size={15} />, key: "C" },
    { k: "task", label: "Tarefa / atividade", icon: <ListTodo size={15} />, key: "T" },
    { k: "company", label: "Empresa", icon: <Building2 size={15} /> },
  ];
  return (
    <div className="crm-dropdown" onMouseLeave={() => setOpen(false)}>
      <button type="button" className="crm-btn primary" onClick={() => setOpen((o) => !o)}><Plus size={16} /> Criar</button>
      {open && (
        <div className="crm-menu right">
          {items.map((i) => (
            <button type="button" key={i.k} onClick={() => { setOpen(false); onPick(i.k); }}>
              {i.icon} <span className="grow">{i.label}</span> {i.key && <kbd>{i.key}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const { tenantId, userId, refreshKey, openDeal, openContact, notify } = useCtx();
  const [items, setItems] = useState<CrmNotification[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { api.loadNotifications(tenantId, userId).then(setItems).catch(() => setItems([])); }, [tenantId, userId]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load, refreshKey]);
  const unread = items.filter((n) => !n.read_at);

  async function markAll() {
    try { await api.markNotificationsRead(unread.map((n) => n.id)); load(); } catch (e) { notify(errorText(e)); }
  }
  function go(n: CrmNotification) {
    setOpen(false);
    if (!n.read_at) void api.markNotificationsRead([n.id]).then(load).catch(() => undefined);
    if (n.link_type === "deal" && n.link_id) openDeal(n.link_id);
    else if (n.link_type === "contact" && n.link_id) openContact(n.link_id);
  }

  return (
    <div className="crm-dropdown">
      <button type="button" className="crm-icon-btn bell" onClick={() => setOpen((o) => !o)} aria-label="Notificações">
        <Bell size={18} />{unread.length > 0 && <em>{unread.length > 9 ? "9+" : unread.length}</em>}
      </button>
      {open && (
        <div className="crm-menu right wide" onMouseLeave={() => setOpen(false)}>
          <div className="crm-menu-head"><strong>Notificações</strong>{unread.length > 0 && <button type="button" className="crm-link" onClick={markAll}><Check size={13} /> Marcar todas como lidas</button>}</div>
          {items.length === 0 ? <p className="crm-muted small pad">Nenhuma notificação. Alertas de automações aparecem aqui.</p> : items.slice(0, 15).map((n) => (
            <button type="button" key={n.id} className={`crm-notif sev-${n.severity}${n.read_at ? "" : " unread"}`} onClick={() => go(n)}>
              <strong>{n.title}</strong>
              {n.body && <span>{n.body}</span>}
              <small>{relative(n.created_at)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const useCtx = useCrm;

// ---------------------------------------------------------------------------
// Busca global
// ---------------------------------------------------------------------------
function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { tenantId, openContact, openDeal, navigate } = useCtx();
  const [term, setTerm] = useState("");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.globalSearch>> | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (term.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => { api.globalSearch(tenantId, term).then((r) => { setRes(r); setCursor(0); }).catch(() => setRes(null)); }, 180);
    return () => clearTimeout(t);
  }, [term, tenantId]);

  const flat = useMemo(() => [
    ...(res?.contacts ?? []).map((c) => ({ key: `c${c.id}`, go: () => openContact(c.id), icon: <User size={15} />, title: c.name ?? phoneLabel(c.phone), sub: [phoneLabel(c.phone), c.email].filter(Boolean).join(" · "), group: "Contatos" })),
    ...(res?.deals ?? []).map((d) => ({ key: `d${d.id}`, go: () => openDeal(d.id), icon: <KanbanSquare size={15} />, title: d.title, sub: `${d.stage_name} · ${brl(d.value)}${d.contact_name ? ` · ${d.contact_name}` : ""}`, group: "Negociações" })),
    ...(res?.companies ?? []).map((c) => ({ key: `e${c.id}`, go: () => navigate({ name: "companies" }), icon: <Building2 size={15} />, title: c.name, sub: c.city ?? "", group: "Empresas" })),
  ], [res, openContact, openDeal, navigate]);

  function pick(i: number) { const it = flat[i]; if (!it) return; onClose(); it.go(); }

  return (
    <div className="crm-overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="crm-palette" role="dialog" aria-label="Busca global">
        <div className="crm-palette-input">
          <Search size={18} />
          <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Nome, telefone, e-mail, negociação ou empresa…"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === "Enter") pick(cursor);
            }} />
          <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
        </div>
        <div className="crm-palette-results">
          {term.trim().length < 2 ? <p className="crm-muted small pad">Digite ao menos 2 caracteres. Use ↑ ↓ e Enter para abrir.</p>
            : !res ? <p className="crm-muted small pad">Buscando…</p>
            : flat.length === 0 ? <p className="crm-muted small pad">Nada encontrado para “{term}”.</p>
            : flat.map((it, i) => (
              <div key={it.key}>
                {(i === 0 || flat[i - 1].group !== it.group) && <h5>{it.group}</h5>}
                <button type="button" className={i === cursor ? "on" : ""} onMouseEnter={() => setCursor(i)} onClick={() => pick(i)}>
                  {it.icon}<span className="grow"><strong>{it.title}</strong><small>{it.sub}</small></span>
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seletor de contato (busca + criação inline)
// ---------------------------------------------------------------------------
export type PickedContact = { id: string; name: string | null; phone: string | null; company_id?: string | null } | null;

export function ContactPicker({ value, onChange, allowNew = true, onNew }: {
  value: PickedContact; onChange: (c: PickedContact) => void; allowNew?: boolean; onNew?: (term: string) => void;
}) {
  const { tenantId } = useCtx();
  const [term, setTerm] = useState("");
  const [list, setList] = useState<NonNullable<PickedContact>[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (term.trim().length < 2) { setList([]); return; }
    const t = setTimeout(() => { api.searchContacts(tenantId, term).then(setList).catch(() => setList([])); }, 200);
    return () => clearTimeout(t);
  }, [term, tenantId]);

  if (value) {
    return (
      <div className="crm-picked">
        <User size={14} /> <strong>{value.name ?? phoneLabel(value.phone)}</strong> {value.name && value.phone && <small>{phoneLabel(value.phone)}</small>}
        <button type="button" className="crm-icon-btn" onClick={() => onChange(null)} aria-label="Trocar contato"><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="crm-picker">
      <input value={term} onChange={(e) => { setTerm(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Buscar por nome, telefone ou e-mail…" />
      {open && term.trim().length >= 2 && (
        <div className="crm-menu">
          {list.map((c) => (
            <button type="button" key={c.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(c); setTerm(""); setOpen(false); }}>
              <User size={14} /> <span className="grow">{c.name ?? "Sem nome"} <small>{phoneLabel(c.phone)}</small></span>
            </button>
          ))}
          {list.length === 0 && <p className="crm-muted small pad">Nenhum contato encontrado.</p>}
          {allowNew && onNew && <button type="button" className="new" onMouseDown={(e) => e.preventDefault()} onClick={() => { onNew(term); setOpen(false); }}><UserPlus size={14} /> Cadastrar “{term}” como novo contato</button>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criação rápida: negociação
// ---------------------------------------------------------------------------
const sourceOptions = ["manual", "whatsapp", "meta_ads", "google_ads", "instagram", "site", "form", "landing_page", "referral", "outbound", "organic"];

function DealQuickModal({ defaults, onClose, onCreated }: { defaults: Record<string, unknown>; onClose: () => void; onCreated: (id: string) => void }) {
  const { tenantId, userId, access, pipelines, stages, settings, members, notify } = useCtx();
  const initialPipeline = String(defaults.pipeline_id ?? settings?.default_pipeline_id ?? pipelines[0]?.id ?? "");
  const [pipelineId, setPipelineId] = useState(initialPipeline);
  const openStages = stages.filter((s) => s.pipeline_id === pipelineId && s.kind === "open").sort((a, b) => a.position - b.position);
  const [stageId, setStageId] = useState(String(defaults.stage_id ?? openStages[0]?.id ?? ""));
  const [title, setTitle] = useState("");
  const [contact, setContact] = useState<PickedContact>((defaults.contact as PickedContact) ?? null);
  const [newContact, setNewContact] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [value, setValue] = useState("");
  const [owner, setOwner] = useState(access.role === "sales" ? userId : "");
  const [close, setClose] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [source, setSource] = useState("manual");
  const [busy, setBusy] = useState(false);
  const [dups, setDups] = useState<Awaited<ReturnType<typeof api.findDuplicates>>>([]);

  useEffect(() => {
    if (!openStages.find((s) => s.id === stageId)) setStageId(openStages[0]?.id ?? "");
  }, [pipelineId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkDup() {
    if (!newContact || (!newContact.phone && !newContact.email)) { setDups([]); return; }
    try { setDups(await api.findDuplicates(tenantId, newContact.phone, newContact.email)); } catch { setDups([]); }
  }

  async function save() {
    const contactName = contact?.name ?? newContact?.name ?? "";
    const finalTitle = title.trim() || (contactName ? `Negociação — ${contactName}` : "");
    if (!finalTitle) { notify("Dê um nome para a negociação ou escolha um contato."); return; }
    if (!stageId) { notify("Escolha a etapa."); return; }
    setBusy(true);
    try {
      let contactId = contact?.id ?? null;
      let companyId = contact?.company_id ?? null;
      if (!contactId && newContact && (newContact.name.trim() || newContact.phone.trim())) {
        const c = await api.createContact({
          tenant_id: tenantId, name: newContact.name.trim() || null, phone: newContact.phone.trim() || null, email: newContact.email.trim() || null,
          owner_id: owner || null, source_channel: source, acquisition_basis: source === "manual" ? "unknown" : "declared",
        } as never);
        contactId = c.id; companyId = c.company_id;
      }
      const d = await api.createDeal({
        tenant_id: tenantId, pipeline_id: pipelineId, stage_id: stageId, title: finalTitle, contact_id: contactId, company_id: companyId,
        value: parseMoney(value), owner_id: owner || null, expected_close_date: close || null, priority,
        source_channel: source, attribution_basis: source === "manual" ? "unknown" : "declared",
      });
      notify("Negociação criada");
      onCreated(d.id);
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Nova negociação" width={620}
      footer={<><span className="crm-muted small grow">Atalho: tecla N em qualquer tela do CRM</span><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>{busy ? "Criando…" : "Criar negociação"}</button></>}>
      <div className="crm-form-grid">
        <Field label="Contato" span={2}>
          {newContact ? (
            <div className="crm-inline-new">
              <input value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Nome" />
              <input value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} onBlur={checkDup} placeholder="WhatsApp com DDD" inputMode="tel" />
              <input value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} onBlur={checkDup} placeholder="E-mail (opcional)" />
              <button type="button" className="crm-icon-btn" onClick={() => { setNewContact(null); setDups([]); }} aria-label="Cancelar novo contato"><X size={14} /></button>
            </div>
          ) : (
            <ContactPicker value={contact} onChange={setContact} onNew={(t) => setNewContact(/\d{6,}/.test(t.replace(/\D/g, "")) ? { name: "", phone: t, email: "" } : { name: t, phone: "", email: "" })} />
          )}
          {!contact && !newContact && <button type="button" className="crm-link small" onClick={() => setNewContact({ name: "", phone: "", email: "" })}><UserPlus size={13} /> Cadastrar novo contato</button>}
        </Field>
        {dups.length > 0 && (
          <div className="crm-callout warn span-2">
            <span>Já existe contato com estes dados: </span>
            {dups.map((d) => <button type="button" key={d.id} className="crm-link" onClick={() => { setContact({ id: d.id, name: d.name, phone: d.phone }); setNewContact(null); setDups([]); }}>usar {d.name ?? phoneLabel(d.phone)}</button>)}
          </div>
        )}
        <Field label="Nome da negociação" span={2}><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={contact?.name || newContact?.name ? `Negociação — ${contact?.name ?? newContact?.name}` : "Ex.: Implante — Maria"} /></Field>
        <Field label="Valor estimado (R$)"><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Fechamento previsto"><input type="date" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
        {pipelines.length > 1 && (
          <Field label="Funil"><select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        )}
        <Field label="Etapa"><select value={stageId} onChange={(e) => setStageId(e.target.value)}>{openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Responsável">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Sem responsável</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}{m.user_id === userId ? " (eu)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Origem" hint="Origem informada manualmente é registrada como “declarada”, nunca como comprovada.">
          <select value={source} onChange={(e) => setSource(e.target.value)}>{sourceOptions.map((s) => <option key={s} value={s}>{channelLabels[s] ?? s}</option>)}</select>
        </Field>
        <Field label="Prioridade">
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Criação rápida: contato
// ---------------------------------------------------------------------------
function ContactQuickModal({ defaults, onClose, onCreated }: { defaults: Record<string, unknown>; onClose: () => void; onCreated: (id: string, open: boolean) => void }) {
  const { tenantId, userId, members, notify, openContact, refresh } = useCtx();
  const blank = { phone: String(defaults.phone ?? ""), name: String(defaults.name ?? ""), company: "", note: "" };
  const [f, setF] = useState(blank);
  const [isCall, setIsCall] = useState(true);
  const [followUp, setFollowUp] = useState<"none" | "1" | "3" | "7">("none");
  const [more, setMore] = useState(false);
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState("phone");
  const [owner, setOwner] = useState(userId);
  const [consent, setConsent] = useState<"unknown" | "granted" | "denied">("unknown");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [dups, setDups] = useState<Awaited<ReturnType<typeof api.findDuplicates>>>([]);
  const [busy, setBusy] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const phoneRef = useRef<HTMLInputElement>(null);
  const linkDealId = defaults.link_deal_id ? String(defaults.link_deal_id) : null;

  useEffect(() => { api.loadCompanies(tenantId).then(setCompanies).catch(() => setCompanies([])); }, [tenantId, savedCount]);
  useEffect(() => { if (savedCount > 0) phoneRef.current?.focus(); }, [savedCount]);
  // procura duplicado enquanto digita o telefone (a partir de 10 dígitos)
  useEffect(() => {
    const digits = f.phone.replace(/\D/g, "");
    if (digits.length < 10 && !email.trim()) { setDups([]); return; }
    const t = setTimeout(() => { api.findDuplicates(tenantId, digits.length >= 10 ? f.phone : undefined, email || undefined).then(setDups).catch(() => setDups([])); }, 300);
    return () => clearTimeout(t);
  }, [f.phone, email, tenantId]);

  const dueAt = () => { if (followUp === "none") return null; const d = new Date(); d.setDate(d.getDate() + Number(followUp)); d.setHours(9, 0, 0, 0); return d.toISOString(); };

  async function logCallAndFollowUp(contactId: string, who: string) {
    if (isCall || f.note.trim()) {
      await api.addNote({ tenant_id: tenantId, contact_id: contactId, kind: isCall ? "call_log" : "note", title: isCall ? "Ligação" : "Observação", body: f.note.trim() || "Ligação registrada", actor_id: userId });
    }
    const due = dueAt();
    if (due) await api.saveTask({ tenant_id: tenantId, task_type: "call", title: `Retornar ligação: ${who}`, description: f.note.trim() || null, contact_id: contactId, owner_id: owner || userId, due_at: due, priority: "normal" });
  }

  async function companyIdFor(name: string) {
    const n = name.trim();
    if (!n) return null;
    const found = companies.find((c) => c.name.trim().toLowerCase() === n.toLowerCase());
    if (found) return found.id;
    const c = await api.saveCompany({ tenant_id: tenantId, name: n, owner_id: owner || null });
    return c.id;
  }

  async function addToExisting(d: { id: string; name: string | null; phone: string | null }) {
    setBusy(true);
    try {
      await logCallAndFollowUp(d.id, d.name ?? phoneLabel(d.phone) ?? "cliente");
      notify(`Registrado em ${d.name ?? "contato existente"}${followUp !== "none" ? " · retorno agendado" : ""}`);
      refresh(); onClose();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  async function save(mode: "close" | "open" | "next") {
    if (!f.name.trim() && !f.phone.trim() && !email.trim()) { notify("Informe ao menos o telefone ou o nome."); phoneRef.current?.focus(); return; }
    setBusy(true);
    try {
      const companyId = await companyIdFor(f.company);
      const c = await api.createContact({
        tenant_id: tenantId, name: f.name.trim() || null, phone: f.phone.trim() || null, email: email.trim() || null, company_id: companyId,
        job_title: jobTitle.trim() || null, city: city.trim() || null, owner_id: owner || null, notes: f.note.trim() || null,
        source_channel: source, acquisition_basis: source === "manual" ? "unknown" : "declared", marketing_consent: consent,
      } as never);
      await logCallAndFollowUp(c.id, f.name.trim() || phoneLabel(c.phone) || "cliente");
      if (linkDealId) await api.updateDeal(linkDealId, { contact_id: c.id, company_id: c.company_id ?? undefined } as never);
      notify(`Cliente salvo${followUp !== "none" ? " · retorno agendado" : ""}`);
      if (mode === "next") {
        setF(blank); setEmail(""); setJobTitle(""); setCity(""); setDups([]); setFollowUp("none"); setBusy(false); setSavedCount((n) => n + 1); refresh();
      } else onCreated(c.id, mode === "open" && !linkDealId);
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save("close"); }
    else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") { e.preventDefault(); void save("close"); }
  };
  const dup = dups[0];

  return (
    <Modal open onClose={onClose} title="Novo cliente" width={560}
      footer={<>
        <span className="crm-muted small grow">Enter salva · {savedCount > 0 ? `${savedCount} salvo(s) nesta sessão` : "Ctrl+Enter salva de dentro da observação"}</span>
        <button type="button" className="crm-btn ghost" onClick={() => save("next")} disabled={busy}>Salvar e novo</button>
        {!linkDealId && <button type="button" className="crm-btn ghost" onClick={() => save("open")} disabled={busy}>Salvar e abrir</button>}
        <button type="button" className="crm-btn primary" onClick={() => save("close")} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
      </>}>
      <div className="crm-quick" onKeyDown={onKey}>
        <div className="crm-form-grid">
          <Field label="Telefone / WhatsApp"><input ref={phoneRef} autoFocus value={f.phone} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, phone: v })); }} inputMode="tel" placeholder="(11) 98888-7777" autoComplete="off" /></Field>
          <Field label="Nome"><input value={f.name} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, name: v })); }} placeholder="Nome do cliente" autoComplete="off" /></Field>
          <Field label="Empresa" span={2} hint={f.company.trim() && !companies.some((c) => c.name.trim().toLowerCase() === f.company.trim().toLowerCase()) ? "Empresa nova — será cadastrada ao salvar." : undefined}>
            <input value={f.company} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, company: v })); }} list="crm-quick-companies" placeholder="Digite ou escolha (opcional)" autoComplete="off" />
            <datalist id="crm-quick-companies">{companies.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          </Field>
        </div>
        {dup && (
          <div className="crm-callout warn">
            <span><strong>{dup.name ?? phoneLabel(dup.phone)}</strong> já está cadastrado ({dup.match_reason}).</span>
            <button type="button" className="crm-btn primary xs" onClick={() => addToExisting(dup)} disabled={busy}>Registrar {isCall ? "ligação" : "observação"} nele</button>
            <button type="button" className="crm-link small" onClick={() => { onClose(); openContact(dup.id); }}>Abrir cadastro</button>
          </div>
        )}
        <Field label="Observação"><textarea rows={3} value={f.note} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, note: v })); }} placeholder="O que foi conversado, interesse, próximo passo…" /></Field>
        <div className="crm-quick-row">
          <label className="crm-check"><input type="checkbox" checked={isCall} onChange={(e) => setIsCall(e.target.checked)} /> Registrar como ligação no histórico</label>
          <div className="crm-quick-follow">
            <span>Retornar:</span>
            {([["none", "Não"], ["1", "Amanhã"], ["3", "3 dias"], ["7", "1 semana"]] as const).map(([v, l]) => (
              <button type="button" key={v} className={`crm-chip${followUp === v ? " on" : ""}`} onClick={() => setFollowUp(v)}>{l}</button>
            ))}
          </div>
        </div>
        <button type="button" className="crm-link small self-start" onClick={() => setMore((m) => !m)}>{more ? "Menos detalhes" : "+ Mais detalhes (e-mail, cargo, cidade, responsável, origem)"}</button>
        {more && (
          <div className="crm-form-grid">
            <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Cargo"><input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} /></Field>
            <Field label="Cidade"><input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
            <Field label="Origem"><select value={source} onChange={(e) => setSource(e.target.value)}>{["phone", ...sourceOptions].map((s) => <option key={s} value={s}>{channelLabels[s] ?? s}</option>)}</select></Field>
            <Field label="Responsável">
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Sem responsável</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}{m.user_id === userId ? " (eu)" : ""}</option>)}
              </select>
            </Field>
            <Field label="Consentimento de marketing (LGPD)">
              <select value={consent} onChange={(e) => setConsent(e.target.value as typeof consent)}>
                <option value="unknown">Não informado</option><option value="granted">Autorizou comunicações</option><option value="denied">Não autorizou</option>
              </select>
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Empresa (criar/editar)
// ---------------------------------------------------------------------------
export function CompanyModal({ company, onClose, onSaved }: { company?: Company; onClose: () => void; onSaved: (c: Company) => void }) {
  const { tenantId, members, notify } = useCtx();
  const [f, setF] = useState<Partial<Company>>(company ?? { name: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Company, v: string) => setF((x) => ({ ...x, [k]: v || null }));
  async function save() {
    if (!f.name?.trim()) { notify("Informe o nome da empresa."); return; }
    setBusy(true);
    try {
      const saved = await api.saveCompany({
        id: company?.id, tenant_id: tenantId, name: f.name.trim(), document: f.document ?? null, domain: f.domain ?? null, segment: f.segment ?? null,
        size: f.size ?? null, city: f.city ?? null, state: f.state ?? null, phone: f.phone ?? null, owner_id: f.owner_id ?? null, notes: f.notes ?? null,
      });
      notify(company ? "Empresa atualizada" : "Empresa cadastrada");
      onSaved(saved);
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={company ? "Editar empresa" : "Nova empresa"} width={600}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input value={f.name ?? ""} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, name: v })); }} /></Field>
        <Field label="CNPJ / documento"><input value={f.document ?? ""} onChange={(e) => set("document", e.target.value)} /></Field>
        <Field label="Site / domínio"><input value={f.domain ?? ""} onChange={(e) => set("domain", e.target.value)} /></Field>
        <Field label="Segmento"><input value={f.segment ?? ""} onChange={(e) => set("segment", e.target.value)} placeholder="Ex.: Odontologia" /></Field>
        <Field label="Porte">
          <select value={f.size ?? ""} onChange={(e) => set("size", e.target.value)}>
            <option value="">—</option><option value="mei">MEI</option><option value="micro">Micro</option><option value="small">Pequena</option><option value="medium">Média</option><option value="large">Grande</option>
          </select>
        </Field>
        <Field label="Cidade"><input value={f.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="UF"><input value={f.state ?? ""} maxLength={2} onChange={(e) => set("state", e.target.value.toUpperCase())} /></Field>
        <Field label="Telefone"><input value={f.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="Responsável pela conta">
          <select value={f.owner_id ?? ""} onChange={(e) => set("owner_id", e.target.value)}>
            <option value="">—</option>{members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
          </select>
        </Field>
        <Field label="Observações" span={2}><textarea rows={2} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
