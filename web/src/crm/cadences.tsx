import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Mail, MessageCircle, Pause, Phone, Play, Plus, Repeat, Search, Trash2, UserPlus, X, ListTodo } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { dateTime, errorText, relative } from "./format";
import type { Cadence, CadenceChannel, CadenceEnrollment, CadenceStep } from "./types";
import { Confirm, Empty, Field, Modal, Pill, Skeleton, Tabs } from "./ui";

export const channelInfo: Record<CadenceChannel, { label: string; icon: JSX.Element }> = {
  call: { label: "Ligar", icon: <Phone size={14} /> },
  whatsapp: { label: "WhatsApp", icon: <MessageCircle size={14} /> },
  email: { label: "E-mail", icon: <Mail size={14} /> },
  task: { label: "Tarefa", icon: <ListTodo size={14} /> },
};

const stopReasons: Record<string, string> = {
  reply: "Respondeu no WhatsApp", deal_won: "Negociação ganha", deal_lost: "Negociação perdida",
  task_canceled: "Tarefa cancelada", manual: "Encerrada manualmente", completed: "Concluída",
};

const suggested: { name: string; description: string; steps: CadenceStep[] } = {
  name: "Prospecção por telefone",
  description: "Ligação, WhatsApp de apoio e nova tentativa. Para quando o cliente responde.",
  steps: [
    { position: 0, wait_days: 0, channel: "call", title: "1ª ligação", template: null },
    { position: 1, wait_days: 1, channel: "whatsapp", title: "WhatsApp de apresentação", template: "Oi {primeiro_nome}, tudo bem? Tentei falar com você por telefone sobre a {empresa}. Posso te ligar em um horário melhor?" },
    { position: 2, wait_days: 2, channel: "call", title: "2ª ligação", template: null },
    { position: 3, wait_days: 3, channel: "whatsapp", title: "Último contato", template: "{primeiro_nome}, vou encerrar por aqui para não incomodar. Se fizer sentido conversar, é só responder esta mensagem. 🙂" },
  ],
};

/** "Dia 0 · Ligar → Dia 1 · WhatsApp…" (dias acumulados) */
export function StepsLine({ steps }: { steps: CadenceStep[] }) {
  let day = 0;
  return (
    <div className="crm-cad-steps">
      {steps.map((s, i) => {
        day += s.wait_days;
        return (
          <span key={s.id ?? i} className={`crm-cad-step ch-${s.channel}`} title={s.title ?? channelInfo[s.channel].label}>
            {channelInfo[s.channel].icon}<b>Dia {day}</b> {s.title || channelInfo[s.channel].label}
          </span>
        );
      })}
    </div>
  );
}

export function CadencesView() {
  const { tenantId, access, refreshKey, notify, openContact, memberLabel } = useCrm();
  const [tab, setTab] = useState<"list" | "running">("list");
  const [items, setItems] = useState<Cadence[] | null>(null);
  const [runs, setRuns] = useState<CadenceEnrollment[] | null>(null);
  const [editing, setEditing] = useState<Cadence | "new" | "suggested" | null>(null);
  const [enrollFor, setEnrollFor] = useState<Cadence | null>(null);
  const [archiving, setArchiving] = useState<Cadence | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");

  const load = useCallback(async () => {
    try { setItems(await api.loadCadences(tenantId)); } catch (e) { notify(errorText(e)); setItems([]); }
  }, [tenantId, notify]);
  const loadRuns = useCallback(async () => {
    try { setRuns(await api.loadEnrollments(tenantId, {})); } catch (e) { notify(errorText(e)); setRuns([]); }
  }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { if (tab === "running") void loadRuns(); }, [tab, loadRuns, refreshKey]);

  const shownRuns = useMemo(() => (runs ?? []).filter((r) => filter === "all" || r.status === "active"), [runs, filter]);

  async function toggle(c: Cadence) {
    try { await api.setCadenceActive(c.id, !c.active); notify(c.active ? "Cadência pausada — ninguém novo entra" : "Cadência ativada"); void load(); }
    catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: "list", label: "Cadências", count: items?.length },
            { value: "running", label: "Contatos em cadência", count: items?.reduce((s, c) => s + c.active_count, 0) },
          ]} />
        </div>
        <div className="crm-toolbar-right">
          {access.configure && <button type="button" className="crm-btn primary" onClick={() => setEditing("new")}><Plus size={16} /> Nova cadência</button>}
        </div>
      </div>
      <p className="crm-muted small">Cada passo vira uma tarefa no dia certo. O WhatsApp nunca é enviado sozinho: a tarefa traz o texto pronto e você envia com um toque. A cadência para quando o contato responde no WhatsApp ou a negociação é ganha/perdida.</p>

      {tab === "list" ? (items === null ? <Skeleton rows={3} height={110} /> : items.length === 0 ? (
        <Empty icon={<Repeat />} title="Nenhuma cadência ainda" text="Monte uma sequência de ligações e mensagens para não esquecer nenhum retorno."
          action={access.configure ? <button type="button" className="crm-btn primary" onClick={() => setEditing("suggested")}>Começar com a sugerida</button> : undefined} />
      ) : (
        <div className="crm-cad-grid">
          {items.map((c) => (
            <section key={c.id} className={`crm-panel crm-cad-card${c.active ? "" : " paused"}`}>
              <header>
                <h3>{c.name}</h3>
                {!c.active && <Pill tone="orange">Pausada</Pill>}
              </header>
              {c.description && <p className="crm-muted small">{c.description}</p>}
              <StepsLine steps={c.steps} />
              <div className="crm-cad-stats">
                <span><b>{c.active_count}</b> em andamento</span>
                <span><b>{c.replied_count}</b> responderam</span>
                <span><b>{c.won_count}</b> viraram venda</span>
                <span><b>{c.completed_count}</b> concluídas</span>
              </div>
              <footer className="crm-row gap wrap">
                {access.write && c.active && <button type="button" className="crm-btn primary sm" onClick={() => setEnrollFor(c)}><UserPlus size={15} /> Inscrever contatos</button>}
                {access.configure && <button type="button" className="crm-btn ghost sm" onClick={() => setEditing(c)}>Editar</button>}
                {access.configure && <button type="button" className="crm-btn ghost sm" onClick={() => toggle(c)}>{c.active ? <><Pause size={14} /> Pausar</> : <><Play size={14} /> Ativar</>}</button>}
                {access.configure && <button type="button" className="crm-icon-btn" onClick={() => setArchiving(c)} aria-label="Arquivar cadência"><Trash2 size={15} /></button>}
              </footer>
            </section>
          ))}
        </div>
      )) : (
        <section className="crm-panel">
          <header>
            <h3>Contatos em cadência</h3>
            <select className="crm-select sm" value={filter} onChange={(e) => setFilter(e.target.value as "active" | "all")}>
              <option value="active">Em andamento</option><option value="all">Todos</option>
            </select>
          </header>
          {runs === null ? <Skeleton rows={4} /> : shownRuns.length === 0 ? <p className="crm-muted small pad">Ninguém {filter === "active" ? "em andamento" : "inscrito"} ainda.</p> : (
            <div className="crm-table-wrap">
              <table className="crm-table">
                <thead><tr><th>Contato</th><th>Cadência</th><th>Passo</th><th>Próxima ação</th><th>Responsável</th><th>Situação</th><th /></tr></thead>
                <tbody>
                  {shownRuns.map((r) => (
                    <tr key={r.id}>
                      <td><button type="button" className="crm-link" onClick={() => openContact(r.contact_id)}>{r.contact_name ?? r.contact_phone}</button></td>
                      <td>{r.cadence_name}</td>
                      <td>{Math.min(r.steps_done + (r.status === "active" ? 1 : 0), r.steps_total)}/{r.steps_total}{r.status === "active" && r.current_step && <span className="crm-muted"> · {r.current_step.title || channelInfo[r.current_step.channel].label}</span>}</td>
                      <td>{r.status === "active" && r.next_due_at ? dateTime(r.next_due_at) : "—"}</td>
                      <td>{memberLabel(r.owner_id)}</td>
                      <td>{r.status === "active" ? <Pill tone="green">Em andamento</Pill> : <span title={r.finished_at ? relative(r.finished_at) : ""}>{stopReasons[r.stop_reason ?? ""] ?? r.stop_reason}</span>}</td>
                      <td>{r.status === "active" && access.write && <button type="button" className="crm-btn ghost xs" onClick={async () => { try { await api.stopEnrollment(r.id); notify("Cadência encerrada para este contato"); void loadRuns(); void load(); } catch (e) { notify(errorText(e)); } }}>Encerrar</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {editing && <CadenceEditor cadence={editing === "new" ? null : editing === "suggested" ? { ...suggested } : editing}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {enrollFor && <EnrollModal cadence={enrollFor} onClose={() => setEnrollFor(null)} onDone={() => { setEnrollFor(null); void load(); }} />}
      <Confirm open={!!archiving} title="Arquivar cadência?" danger confirmLabel="Arquivar"
        text="Quem já está nela continua com as tarefas abertas até concluir ou encerrar; ninguém novo entra."
        onClose={() => setArchiving(null)}
        onConfirm={async () => { const c = archiving; setArchiving(null); if (!c) return; try { await api.archiveCadence(c.id); notify("Cadência arquivada"); void load(); } catch (e) { notify(errorText(e)); } }} />
    </div>
  );
}

function CadenceEditor({ cadence, onClose, onSaved }: {
  cadence: (Partial<Cadence> & { name: string; steps: CadenceStep[] }) | Cadence | null; onClose: () => void; onSaved: () => void;
}) {
  const { tenantId, notify } = useCrm();
  const [name, setName] = useState(cadence?.name ?? "");
  const [description, setDescription] = useState(cadence?.description ?? "");
  const [stopReply, setStopReply] = useState(cadence?.stop_on_reply ?? true);
  const [stopDeal, setStopDeal] = useState(cadence?.stop_on_deal_close ?? true);
  const [steps, setSteps] = useState<CadenceStep[]>(cadence?.steps?.length ? cadence.steps.map((s) => ({ ...s })) : [{ position: 0, wait_days: 0, channel: "call", title: null, template: null }]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const set = (i: number, patch: Partial<CadenceStep>) => setSteps((l) => l.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => setSteps((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i: number) => setSteps((l) => { const s = l[i]; if (s.id) setRemoved((r) => [...r, s.id!]); return l.filter((_, j) => j !== i); });

  async function save() {
    if (!name.trim()) { notify("Dê um nome para a cadência"); return; }
    if (!steps.length) { notify("Adicione ao menos um passo"); return; }
    if (steps.some((s) => s.channel === "whatsapp" && !s.template?.trim())) { notify("Escreva o texto dos passos de WhatsApp"); return; }
    setBusy(true);
    try {
      await api.saveCadence(tenantId, { id: "id" in (cadence ?? {}) ? (cadence as Cadence).id : undefined, name: name.trim(), description: description.trim() || null, stop_on_reply: stopReply, stop_on_deal_close: stopDeal }, steps, removed);
      notify("Cadência salva");
      onSaved();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  let day = 0;
  return (
    <Modal open onClose={onClose} title={cadence && "id" in cadence ? "Editar cadência" : "Nova cadência"} width={720}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar cadência"}</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Farmácias — 1º contato" /></Field>
        <Field label="Descrição (opcional)" span={2}><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para quem é e qual o objetivo" /></Field>
        <label className="crm-check"><input type="checkbox" checked={stopReply} onChange={(e) => setStopReply(e.target.checked)} /> Parar quando o contato responder no WhatsApp</label>
        <label className="crm-check"><input type="checkbox" checked={stopDeal} onChange={(e) => setStopDeal(e.target.checked)} /> Parar quando a negociação for ganha ou perdida</label>
      </div>
      <h4 className="crm-subtitle">Passos</h4>
      <div className="crm-cad-editor">
        {steps.map((s, i) => {
          day += Number(s.wait_days) || 0;
          return (
            <div key={s.id ?? `n${i}`} className="crm-cad-edit-row">
              <div className="crm-cad-edit-head">
                <span className="crm-cad-day">Dia {day}</span>
                <select value={s.channel} onChange={(e) => set(i, { channel: e.target.value as CadenceChannel })} aria-label="Canal">
                  {(Object.keys(channelInfo) as CadenceChannel[]).map((c) => <option key={c} value={c}>{channelInfo[c].label}</option>)}
                </select>
                <label className="crm-inline">{i === 0 ? "começar após" : "esperar"} <input type="number" min={0} max={90} value={s.wait_days} onChange={(e) => set(i, { wait_days: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })} /> dia(s)</label>
                <input className="grow" value={s.title ?? ""} onChange={(e) => set(i, { title: e.target.value })} placeholder={`Título (ex.: ${channelInfo[s.channel].label} de apresentação)`} />
                <span className="crm-row">
                  <button type="button" className="crm-icon-btn xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ArrowUp size={13} /></button>
                  <button type="button" className="crm-icon-btn xs" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Descer"><ArrowDown size={13} /></button>
                  <button type="button" className="crm-icon-btn xs" onClick={() => remove(i)} aria-label="Remover passo"><X size={13} /></button>
                </span>
              </div>
              {(s.channel === "whatsapp" || s.channel === "email" || s.template) && (
                <textarea rows={2} value={s.template ?? ""} onChange={(e) => set(i, { template: e.target.value })}
                  placeholder={s.channel === "whatsapp" ? "Texto da mensagem — use {primeiro_nome}, {nome}, {empresa}, {cidade}" : "Roteiro / observação"} />
              )}
            </div>
          );
        })}
        <button type="button" className="crm-btn ghost sm self-start" onClick={() => setSteps((l) => [...l, { position: l.length, wait_days: 1, channel: l.length % 2 ? "call" : "whatsapp", title: null, template: null }])}><Plus size={14} /> Adicionar passo</button>
        <p className="crm-muted small">Com "esperar 0 dias" o passo vale para o mesmo dia; acima de 0, a tarefa aparece às 9h do dia previsto. Variáveis: {"{primeiro_nome}"}, {"{nome}"}, {"{empresa}"}, {"{cidade}"}.</p>
      </div>
    </Modal>
  );
}

export function EnrollModal({ cadence, contact, onClose, onDone }: {
  cadence?: Cadence | null; contact?: { id: string; name: string | null } | null; onClose: () => void; onDone: () => void;
}) {
  const { tenantId, notify } = useCrm();
  const [cadences, setCadences] = useState<Cadence[] | null>(cadence ? [cadence] : null);
  const [cadenceId, setCadenceId] = useState(cadence?.id ?? "");
  const [picked, setPicked] = useState<{ id: string; name: string | null; phone?: string | null }[]>(contact ? [contact] : []);
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<Awaited<ReturnType<typeof api.searchContacts>>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cadence) return;
    api.loadCadences(tenantId).then((l) => { const a = l.filter((c) => c.active); setCadences(a); if (a[0]) setCadenceId(a[0].id); }).catch(() => setCadences([]));
  }, [cadence, tenantId]);
  useEffect(() => {
    const t = setTimeout(() => { api.searchContacts(tenantId, term).then(setFound).catch(() => setFound([])); }, 200);
    return () => clearTimeout(t);
  }, [term, tenantId]);

  async function go() {
    if (!cadenceId || !picked.length) return;
    setBusy(true);
    try {
      const r = await api.enrollInCadence(cadenceId, picked.map((p) => p.id));
      notify(r.enrolled ? `${r.enrolled} contato(s) na cadência${r.skipped ? ` · ${r.skipped} já estavam` : ""}` : "Esses contatos já estão nesta cadência");
      onDone();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  const current = cadences?.find((c) => c.id === cadenceId);
  return (
    <Modal open onClose={onClose} title="Colocar em cadência" width={560}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" disabled={busy || !cadenceId || !picked.length} onClick={go}>{busy ? "Inscrevendo…" : `Inscrever ${picked.length || ""}`}</button></>}>
      {cadences !== null && cadences.length === 0 ? <p className="crm-muted">Nenhuma cadência ativa. Peça ao gestor para criar uma em CRM → Cadências.</p> : (
        <div className="crm-stack">
          {!cadence && (
            <Field label="Cadência">
              <select value={cadenceId} onChange={(e) => setCadenceId(e.target.value)}>{(cadences ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
          )}
          {current && <StepsLine steps={current.steps} />}
          {!contact && (
            <>
              <div className="crm-search">
                <Search size={16} />
                <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar contato por nome ou telefone" />
              </div>
              {found.length > 0 && (
                <div className="crm-pick-list">
                  {found.filter((f) => !picked.some((p) => p.id === f.id)).map((f) => (
                    <button type="button" key={f.id} onClick={() => { setPicked((l) => [...l, f]); setTerm(""); }}>
                      <Plus size={13} /> {f.name ?? "Sem nome"} <span className="crm-muted">{f.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="crm-row gap wrap">
            {picked.map((p) => (
              <span key={p.id} className="crm-chip on">{p.name ?? p.phone}{!contact && <button type="button" onClick={() => setPicked((l) => l.filter((x) => x.id !== p.id))} aria-label="Tirar"><X size={12} /></button>}</span>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Cadências do contato (página do contato) */
export function ContactCadences({ contactId, contactName }: { contactId: string; contactName: string | null }) {
  const { tenantId, access, notify, refreshKey } = useCrm();
  const [list, setList] = useState<CadenceEnrollment[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { api.loadEnrollments(tenantId, { contactId }).then(setList).catch(() => setList([])); }, [tenantId, contactId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const active = list.filter((e) => e.status === "active");
  return (
    <div className="crm-cad-contact">
      {active.map((e) => (
        <span key={e.id} className="crm-chip on" title={e.next_due_at ? `Próxima ação: ${dateTime(e.next_due_at)}` : ""}>
          <Repeat size={12} /> {e.cadence_name} · {Math.min(e.steps_done + 1, e.steps_total)}/{e.steps_total}
          {access.write && <button type="button" onClick={async () => { try { await api.stopEnrollment(e.id); notify("Cadência encerrada"); load(); } catch (err) { notify(errorText(err)); } }} aria-label="Encerrar cadência"><X size={12} /></button>}
        </span>
      ))}
      {access.write && <button type="button" className="crm-btn ghost xs" onClick={() => setOpen(true)}><Repeat size={13} /> Colocar em cadência</button>}
      {open && <EnrollModal contact={{ id: contactId, name: contactName }} onClose={() => setOpen(false)} onDone={() => { setOpen(false); load(); }} />}
    </div>
  );
}
