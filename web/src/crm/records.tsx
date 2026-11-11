import { useCallback, useEffect, useState } from "react";
import {
  Bot, CalendarClock, Check, CheckCircle2, CircleDollarSign, ClipboardList, Gift, MessageCircle, MessageSquare, Phone, Plus, Repeat, RotateCcw,
  Sparkles, StickyNote, Trophy, Undo2, Users, XCircle, Zap,
} from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import {
  brl, dateTime, dueState, errorText, evidenceLabels, fromLocalInput, orderStatusLabels, parseMoney, priorityLabels, relative, taskTypeLabels, toLocalInput,
} from "./format";
import type { Order, Priority, Task, TaskType, TimelineItem } from "./types";
import { Empty, Field, Modal, Pill, Segmented, Skeleton } from "./ui";

// ---------------------------------------------------------------------------
// Linha do tempo + anotação rápida
// ---------------------------------------------------------------------------
const kindIcon: Record<string, JSX.Element> = {
  note: <StickyNote size={14} />, call_log: <Phone size={14} />, meeting_log: <Users size={14} />, whatsapp: <MessageCircle size={14} />,
  deal_created: <Plus size={14} />, stage_change: <RotateCcw size={14} />, deal_won: <Trophy size={14} />, deal_lost: <XCircle size={14} />,
  deal_reopened: <Undo2 size={14} />, task_done: <CheckCircle2 size={14} />, order: <CircleDollarSign size={14} />, refund: <Undo2 size={14} />,
  sample: <Gift size={14} />, ai_insight: <Sparkles size={14} />, automation: <Zap size={14} />, rfv: <Sparkles size={14} />,
};

export function Timeline({ contactId, dealId, compact }: { contactId?: string; dealId?: string; compact?: boolean }) {
  const { tenantId, userId, access, refreshKey, notify, memberLabel } = useCrm();
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [kind, setKind] = useState<"note" | "call_log" | "meeting_log">("note");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "notes" | "sales" | "system">("all");

  const load = useCallback(async () => {
    try { setItems(await api.loadTimeline({ contactId, dealId })); } catch (e) { notify(errorText(e)); setItems([]); }
  }, [contactId, dealId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function save() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const titles = { note: "Anotação", call_log: "Ligação registrada", meeting_log: "Reunião registrada" };
      await api.addNote({ tenant_id: tenantId, contact_id: contactId ?? null, deal_id: dealId ?? null, kind, title: titles[kind], body: text.trim(), actor_id: userId });
      setText("");
      await load();
      notify("Registrado no histórico");
    } catch (e) { notify(errorText(e)); }
    setBusy(false);
  }

  const shown = (items ?? []).filter((i) => filter === "all"
    || (filter === "notes" && ["note", "call_log", "meeting_log", "whatsapp", "email_log"].includes(i.kind))
    || (filter === "sales" && ["order", "refund", "deal_won", "deal_lost", "sample"].includes(i.kind))
    || (filter === "system" && ["stage_change", "deal_created", "automation", "rfv", "lifecycle", "system", "task_done", "deal_reopened", "merge"].includes(i.kind)));

  return (
    <div className="crm-timeline-wrap">
      {access.write && (
        <div className="crm-composer">
          <Segmented size="sm" value={kind} onChange={setKind} options={[
            { value: "note", label: <><StickyNote size={14} /> Anotação</> },
            { value: "call_log", label: <><Phone size={14} /> Ligação</> },
            { value: "meeting_log", label: <><Users size={14} /> Reunião</> },
          ]} />
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "note" ? "Escreva uma anotação…" : kind === "call_log" ? "Como foi a ligação? Próximos passos…" : "Resumo da reunião…"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); }} />
          <div className="crm-composer-foot">
            <small>Ctrl + Enter para salvar</small>
            <button type="button" className="crm-btn primary sm" onClick={save} disabled={busy || !text.trim()}>Salvar</button>
          </div>
        </div>
      )}
      {!compact && (
        <Segmented size="sm" value={filter} onChange={setFilter} options={[
          { value: "all", label: "Tudo" }, { value: "notes", label: "Interações" }, { value: "sales", label: "Vendas" }, { value: "system", label: "Movimentações" },
        ]} />
      )}
      {items === null ? <Skeleton rows={3} /> : shown.length === 0 ? <Empty title="Nada por aqui ainda" text="Anotações, ligações, mudanças de etapa e vendas aparecem aqui." /> : (
        <ol className="crm-timeline">
          {shown.map((i) => (
            <li key={`${i.origin}-${i.id}`} className={`k-${i.kind}`}>
              <span className="crm-tl-icon">{kindIcon[i.kind] ?? <ClipboardList size={14} />}</span>
              <div className="crm-tl-body">
                <div className="crm-tl-head">
                  <strong>{i.title}</strong>
                  <time title={dateTime(i.occurred_at)}>{relative(i.occurred_at)}</time>
                </div>
                {i.body && <p>{i.body}</p>}
                <small>{i.actor_id ? memberLabel(i.actor_id) : i.origin === "legacy" ? "IDX (fluxo de atendimento)" : "Sistema"}</small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------
export function rescheduleOptions(): { label: string; at: () => Date }[] {
  return [
    { label: "+1 hora", at: () => new Date(Date.now() + 3600000) },
    { label: "Amanhã 9h", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { label: "Em 3 dias", at: () => { const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); return d; } },
    { label: "Próxima semana", at: () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; } },
  ];
}

export function TaskRow({ task, onChanged, showLinks = true }: { task: Task; onChanged: () => void; showLinks?: boolean }) {
  const { access, notify, memberLabel, openDeal, openContact } = useCrm();
  const [menu, setMenu] = useState(false);
  const [done, setDone] = useState(task.status === "done");
  const [edit, setEdit] = useState(false);
  const st = task.status === "open" ? dueState(task.due_at) : "none";

  async function complete() {
    setDone(true);
    try { await api.saveTask({ id: task.id, tenant_id: task.tenant_id, status: "done" }); notify("Tarefa concluída ✓"); onChanged(); }
    catch (e) { setDone(false); notify(errorText(e)); }
  }
  async function reopen() {
    try { await api.saveTask({ id: task.id, tenant_id: task.tenant_id, status: "open" }); setDone(false); onChanged(); } catch (e) { notify(errorText(e)); }
  }
  async function reschedule(at: Date) {
    setMenu(false);
    try { await api.saveTask({ id: task.id, tenant_id: task.tenant_id, due_at: at.toISOString() }); notify(`Reagendada para ${dateTime(at.toISOString())}`); onChanged(); }
    catch (e) { notify(errorText(e)); }
  }

  return (
    <div className={`crm-task ${done ? "done" : ""} due-${st} prio-${task.priority}`}>
      <button type="button" className="crm-task-check" disabled={!access.write} onClick={done ? reopen : complete} aria-label={done ? "Reabrir" : "Concluir"}>
        {done ? <Check size={14} /> : null}
      </button>
      <div className="crm-task-main" onClick={() => access.write && setEdit(true)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setEdit(true); }}>
        <div className="crm-task-title">
          <Pill tone="muted">{taskTypeLabels[task.task_type]}</Pill>
          <strong>{task.title}</strong>
          {task.priority !== "normal" && task.priority !== "low" && <Pill tone={task.priority === "urgent" ? "red" : "orange"}>{priorityLabels[task.priority]}</Pill>}
          {task.automation_rule_id && <Pill tone="purple" title="Criada por automação"><Zap size={11} /></Pill>}
          {task.cadence_enrollment_id && <Pill tone="blue" title="Passo de uma cadência"><Repeat size={11} /></Pill>}
        </div>
        {task.task_type === "whatsapp" && task.description && <p className="crm-task-template">{task.description}</p>}
        <div className="crm-task-meta">
          {task.due_at && <span className={`due ${st}`}><CalendarClock size={12} /> {st === "overdue" ? `Atrasada · ${relative(task.due_at)}` : dateTime(task.due_at)}</span>}
          {showLinks && task.contact && <button type="button" className="crm-link" onClick={(e) => { e.stopPropagation(); if (task.contact_id) openContact(task.contact_id); }}>{task.contact.name ?? task.contact.phone}</button>}
          {showLinks && task.deal && <button type="button" className="crm-link" onClick={(e) => { e.stopPropagation(); if (task.deal_id) openDeal(task.deal_id); }}>{task.deal.title}</button>}
          {task.owner_id && <span>{memberLabel(task.owner_id)}</span>}
          {task.outcome && <span className="outcome">“{task.outcome}”</span>}
        </div>
      </div>
      {!done && access.write && (
        <div className="crm-task-actions">
          {task.task_type === "whatsapp" && task.contact?.phone && (
            <a className="crm-btn wa xs" target="_blank" rel="noreferrer" title="Abre o WhatsApp com o texto pronto — você confere e envia"
              href={`https://wa.me/${task.contact.phone.replace(/\D/g, "")}${task.description ? `?text=${encodeURIComponent(task.description)}` : ""}`}><MessageCircle size={13} /> Abrir WhatsApp</a>
          )}
          {(task.task_type === "call" || task.task_type === "callback") && task.contact?.phone && (
            <a className="crm-btn call xs" href={`tel:+${task.contact.phone.replace(/\D/g, "")}`}><Phone size={13} /> Ligar</a>
          )}
          <button type="button" className="crm-btn ghost xs" onClick={() => setMenu((m) => !m)}>Reagendar</button>
          {menu && (
            <div className="crm-menu" onMouseLeave={() => setMenu(false)}>
              {rescheduleOptions().map((o) => <button type="button" key={o.label} onClick={() => reschedule(o.at())}>{o.label}</button>)}
            </div>
          )}
        </div>
      )}
      {edit && <TaskModal task={task} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); }} />}
    </div>
  );
}

export function TaskModal({ task, defaults, onClose, onSaved }: {
  task?: Task; defaults?: Partial<Task>; onClose: () => void; onSaved: (t: Task) => void;
}) {
  const { tenantId, userId, members, notify, access } = useCrm();
  const base = task ?? ({ ...defaults } as Partial<Task>);
  const [type, setType] = useState<TaskType>(base.task_type ?? "follow_up");
  const [title, setTitle] = useState(base.title ?? "");
  const [due, setDue] = useState(toLocalInput(base.due_at ?? (() => { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); return d.toISOString(); })()));
  const [owner, setOwner] = useState(base.owner_id ?? userId);
  const [priority, setPriority] = useState<Priority>(base.priority ?? "normal");
  const [desc, setDesc] = useState(base.description ?? "");
  const [outcome, setOutcome] = useState(base.outcome ?? "");
  const [busy, setBusy] = useState(false);

  const autoTitle = (t: TaskType) => ({ call: "Ligar", meeting: "Reunião", follow_up: "Follow-up", callback: "Retornar contato", task: "", proposal: "Enviar proposta", email: "Enviar e-mail", whatsapp: "Mandar mensagem", visit: "Visita", other: "" }[t]);

  async function save(markDone = false) {
    const finalTitle = title.trim() || autoTitle(type);
    if (!finalTitle) { notify("Dê um título para a tarefa."); return; }
    setBusy(true);
    try {
      const saved = await api.saveTask({
        id: task?.id, tenant_id: tenantId, task_type: type, title: finalTitle, description: desc || null, due_at: fromLocalInput(due),
        owner_id: owner || null, priority, contact_id: base.contact_id ?? null, deal_id: base.deal_id ?? null, company_id: base.company_id ?? null,
        ...(markDone ? { status: "done" as const, outcome: outcome || null } : outcome ? { outcome } : {}),
      });
      notify(task ? "Tarefa atualizada" : markDone ? "Atividade registrada" : "Tarefa criada");
      onSaved(saved);
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  async function remove() {
    if (!task) return;
    try { await api.deleteTask(task.id); notify("Tarefa excluída"); onSaved(task); } catch (e) { notify(errorText(e)); }
  }

  return (
    <Modal open onClose={onClose} title={task ? "Editar tarefa" : "Nova tarefa"} width={540}
      footer={<>
        {task && access.delete && <button type="button" className="crm-btn ghost danger-text" onClick={remove}>Excluir</button>}
        <span className="grow" />
        {!task && <button type="button" className="crm-btn ghost" onClick={() => save(true)} disabled={busy} title="Registra uma atividade já realizada">Já fiz</button>}
        <button type="button" className="crm-btn primary" onClick={() => save(false)} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
      </>}>
      <div className="crm-type-picker">
        {(["call", "whatsapp", "meeting", "follow_up", "proposal", "email", "visit", "task"] as TaskType[]).map((t) => (
          <button type="button" key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>{taskTypeLabels[t]}</button>
        ))}
      </div>
      <div className="crm-form-grid">
        <Field label="Título" span={2}><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle(type) || "O que precisa ser feito?"} /></Field>
        <Field label="Quando"><input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Responsável">
          <select value={owner ?? ""} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Sem responsável</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}
          </select>
        </Field>
        <Field label="Prioridade">
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["low", "normal", "high", "urgent"] as Priority[]).map((p) => <option key={p} value={p}>{priorityLabels[p]}</option>)}
          </select>
        </Field>
        <Field label="Resultado (opcional)"><input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Ex.: agendou avaliação" /></Field>
        <Field label="Descrição" span={2}><textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function TaskList({ contactId, dealId }: { contactId?: string; dealId?: string }) {
  const { tenantId, access, refreshKey, notify, refresh } = useCrm();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try { setTasks(await api.loadTasks(tenantId, { contactId, dealId, status: "all", limit: 100 })); } catch (e) { notify(errorText(e)); setTasks([]); }
  }, [tenantId, contactId, dealId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const open = (tasks ?? []).filter((t) => t.status === "open");
  const done = (tasks ?? []).filter((t) => t.status === "done").slice(0, 10);
  return (
    <div className="crm-stack">
      {access.write && <button type="button" className="crm-btn ghost sm self-start" onClick={() => setCreating(true)}><Plus size={14} /> Agendar atividade</button>}
      {tasks === null ? <Skeleton rows={2} /> : open.length === 0 ? (
        <div className="crm-callout warn"><CalendarClock size={16} /> Nenhuma próxima ação agendada. Toda negociação aberta deve ter um próximo passo.</div>
      ) : open.map((t) => <TaskRow key={t.id} task={t} onChanged={() => { void load(); refresh(); }} showLinks={false} />)}
      {done.length > 0 && <><h4 className="crm-subhead">Concluídas</h4>{done.map((t) => <TaskRow key={t.id} task={t} onChanged={load} showLinks={false} />)}</>}
      {creating && <TaskModal defaults={{ contact_id: contactId ?? null, deal_id: dealId ?? null }} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); refresh(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendas / pedidos
// ---------------------------------------------------------------------------
export function OrdersPanel({ contactId, dealId, companyId }: { contactId?: string | null; dealId?: string; companyId?: string | null }) {
  const { tenantId, access, refreshKey, notify, refresh, offers } = useCrm();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [refund, setRefund] = useState<Order | null>(null);
  const load = useCallback(async () => {
    try { setOrders(await api.loadOrders({ tenantId, contactId: dealId ? undefined : contactId ?? undefined, dealId })); } catch (e) { notify(errorText(e)); setOrders([]); }
  }, [tenantId, contactId, dealId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const valid = (orders ?? []).filter((o) => ["confirmed", "paid", "partially_refunded"].includes(o.status) && !o.is_free && o.net_amount > 0);
  const total = valid.reduce((s, o) => s + Number(o.net_amount), 0);

  async function confirmPending(o: Order) {
    try { await api.updateOrder(o.id, { status: "confirmed", evidence_type: o.evidence_type === "ai_auto_unreviewed" ? "ai_signal_reviewed" : o.evidence_type }); notify("Venda confirmada"); void load(); refresh(); }
    catch (e) { notify(errorText(e)); }
  }
  async function cancel(o: Order) {
    try { await api.updateOrder(o.id, { status: "cancelled", cancel_reason: "Cancelado no CRM" }); notify("Pedido cancelado"); void load(); refresh(); }
    catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-stack">
      <div className="crm-row between">
        <div className="crm-mini-stats">
          <span><em>Compras válidas</em><strong>{valid.length}</strong></span>
          <span><em>Receita líquida</em><strong>{brl(total)}</strong></span>
          <span><em>Ticket médio</em><strong>{valid.length ? brl(total / valid.length) : "—"}</strong></span>
        </div>
        {access.finance && (contactId || dealId) && <button type="button" className="crm-btn primary sm" onClick={() => setCreating(true)}><Plus size={14} /> Registrar venda</button>}
      </div>
      {orders === null ? <Skeleton rows={2} /> : orders.length === 0 ? <Empty icon={<CircleDollarSign />} title="Nenhuma venda registrada" text="Vendas confirmadas com evidência alimentam a receita e o RFV." /> : (
        <div className="crm-orders">
          {orders.map((o) => (
            <div key={o.id} className={`crm-order st-${o.status}`}>
              <div>
                <strong>{brl(o.net_amount || o.gross_amount)}</strong>
                {o.refunded_amount > 0 && <small> (devolvido {brl(o.refunded_amount)})</small>}
                <div className="crm-muted small">{dateTime(o.order_date)} · {evidenceLabels[o.evidence_type] ?? o.evidence_type}{o.installments > 1 ? ` · ${o.installments}x` : ""}{o.order_kind === "recurring_cycle" ? " · recorrente" : ""}</div>
              </div>
              <div className="crm-row gap">
                <Pill tone={o.status === "pending" ? "amber" : o.status === "cancelled" || o.status === "refunded" ? "muted" : "green"}>{orderStatusLabels[o.status]}</Pill>
                {access.finance && o.status === "pending" && <button type="button" className="crm-btn ghost xs" onClick={() => confirmPending(o)}>Confirmar evidência</button>}
                {access.finance && ["confirmed", "paid", "partially_refunded"].includes(o.status) && <button type="button" className="crm-btn ghost xs" onClick={() => setRefund(o)}>Devolução</button>}
                {access.finance && ["pending", "confirmed"].includes(o.status) && <button type="button" className="crm-btn ghost xs danger-text" onClick={() => cancel(o)}>Cancelar</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <OrderModal contactId={contactId ?? null} dealId={dealId ?? null} companyId={companyId ?? null} offers={offers} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); refresh(); }} />}
      {refund && <RefundModal order={refund} onClose={() => setRefund(null)} onSaved={() => { setRefund(null); void load(); refresh(); }} />}
    </div>
  );
}

function OrderModal({ contactId, dealId, companyId, offers, onClose, onSaved }: {
  contactId: string | null; dealId: string | null; companyId: string | null; offers: { id: string; name: string; price: number | null; is_recurring: boolean }[]; onClose: () => void; onSaved: () => void;
}) {
  const { tenantId, notify } = useCrm();
  const [items, setItems] = useState<{ offer_id: string | null; name: string; quantity: number; unit_price: number; discount: number }[]>([]);
  const [manualValue, setManualValue] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [evidence, setEvidence] = useState("payment");
  const [kind, setKind] = useState<"one_time" | "recurring_cycle">("one_time");
  const [installments, setInstallments] = useState("1");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const itemsTotal = items.reduce((s, i) => s + Math.max(i.quantity * i.unit_price - i.discount, 0), 0);
  const total = items.length ? itemsTotal : parseMoney(manualValue);

  async function save() {
    if (total <= 0) { notify("Informe o valor ou adicione produtos."); return; }
    setBusy(true);
    try {
      await api.createOrder({
        tenant_id: tenantId, contact_id: contactId, deal_id: dealId, company_id: companyId, order_date: new Date(`${date}T12:00:00`).toISOString(),
        status: evidence === "payment" ? "paid" : "confirmed", gross_amount: Math.round(total * 100) / 100, evidence_type: evidence, evidence_note: note || null,
        installments: Number(installments) || 1, payment_method: method || null, order_kind: kind, source: "manual", items,
      });
      notify(`Venda de ${brl(total)} registrada`);
      onSaved();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Registrar venda" width={600}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>Registrar {total > 0 ? brl(total) : ""}</button></>}>
      <div className="crm-form-grid">
        <Field label="Adicionar produto/serviço" span={2}>
          <select value="" onChange={(e) => {
            const o = offers.find((x) => x.id === e.target.value);
            if (o) { setItems((l) => [...l, { offer_id: o.id, name: o.name, quantity: 1, unit_price: Number(o.price ?? 0), discount: 0 }]); if (o.is_recurring) setKind("recurring_cycle"); }
          }}>
            <option value="">Selecione do catálogo…</option>
            {offers.map((o) => <option key={o.id} value={o.id}>{o.name}{o.price ? ` — ${brl(o.price)}` : ""}</option>)}
          </select>
        </Field>
        {items.length > 0 && (
          <div className="crm-items span-2">
            {items.map((it, idx) => (
              <div key={idx} className="crm-item-row">
                <span>{it.name}</span>
                <input type="number" min={1} value={it.quantity} onChange={(e) => setItems((l) => l.map((x, i) => i === idx ? { ...x, quantity: Number(e.target.value) || 1 } : x))} aria-label="Quantidade" />
                <input inputMode="decimal" value={it.unit_price} onChange={(e) => setItems((l) => l.map((x, i) => i === idx ? { ...x, unit_price: parseMoney(e.target.value) } : x))} aria-label="Preço" />
                <input inputMode="decimal" value={it.discount} onChange={(e) => setItems((l) => l.map((x, i) => i === idx ? { ...x, discount: parseMoney(e.target.value) } : x))} aria-label="Desconto" />
                <button type="button" className="crm-icon-btn" onClick={() => setItems((l) => l.filter((_, i) => i !== idx))} aria-label="Remover"><XCircle size={15} /></button>
              </div>
            ))}
            <div className="crm-item-total">Total: <strong>{brl(itemsTotal)}</strong></div>
          </div>
        )}
        {!items.length && <Field label="Valor (R$)"><input inputMode="decimal" value={manualValue} onChange={(e) => setManualValue(e.target.value)} placeholder="0,00" /></Field>}
        <Field label="Data"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Evidência" hint="Sem evidência, não registre como venda.">
          <select value={evidence} onChange={(e) => setEvidence(e.target.value)}>
            {["payment", "contract", "invoice", "pos", "manual_confirmation"].map((k) => <option key={k} value={k}>{evidenceLabels[k]}</option>)}
          </select>
        </Field>
        <Field label="Tipo">
          <select value={kind} onChange={(e) => setKind(e.target.value as "one_time" | "recurring_cycle")}>
            <option value="one_time">Compra avulsa</option>
            <option value="recurring_cycle">Ciclo de cobrança recorrente</option>
          </select>
        </Field>
        <Field label="Parcelas" hint="Parcelas = 1 compra"><input type="number" min={1} max={120} value={installments} onChange={(e) => setInstallments(e.target.value)} /></Field>
        <Field label="Forma de pagamento"><input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Pix, cartão…" /></Field>
        <Field label="Observação" span={2}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nº do pedido, comprovante…" /></Field>
      </div>
    </Modal>
  );
}

function RefundModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const { notify } = useCrm();
  const [amount, setAmount] = useState(String(order.net_amount));
  const [kind, setKind] = useState<"refund" | "chargeback">("refund");
  const [note, setNote] = useState("");
  async function save() {
    const v = parseMoney(amount);
    if (v <= 0 || v > order.net_amount) { notify("Valor de devolução inválido."); return; }
    try { await api.addPayment({ tenant_id: order.tenant_id, order_id: order.id, kind, amount: v, notes: note || null }); notify("Devolução registrada — receita e RFV ajustados"); onSaved(); }
    catch (e) { notify(errorText(e)); }
  }
  return (
    <Modal open onClose={onClose} title="Registrar devolução / estorno" width={440}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn danger" onClick={save}>Registrar</button></>}>
      <div className="crm-form-grid">
        <Field label="Valor devolvido"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Tipo"><select value={kind} onChange={(e) => setKind(e.target.value as "refund" | "chargeback")}><option value="refund">Devolução / reembolso</option><option value="chargeback">Chargeback</option></select></Field>
        <Field label="Motivo" span={2}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp (somente leitura) e Inteligência (IA)
// ---------------------------------------------------------------------------
export function WhatsAppThread({ conversationId }: { conversationId: string | null | undefined }) {
  const { notify } = useCrm();
  const [msgs, setMsgs] = useState<{ id: string; direction: string; body: string | null; content_type: string; timestamp: string }[] | null>(null);
  useEffect(() => {
    if (!conversationId) { setMsgs([]); return; }
    api.loadConversationMessages(conversationId).then(setMsgs).catch((e) => { notify(errorText(e)); setMsgs([]); });
  }, [conversationId, notify]);
  if (!conversationId) return <Empty icon={<MessageCircle />} title="Sem conversa vinculada" text="Quando este contato falar com a empresa pelo WhatsApp conectado, a conversa aparece aqui automaticamente." />;
  if (msgs === null) return <Skeleton rows={3} />;
  return (
    <div className="crm-wa">
      <p className="crm-note"><MessageSquare size={14} /> Leitura da conversa. O CRM não envia mensagens automaticamente.</p>
      <div className="crm-wa-thread">
        {msgs.map((m) => (
          <div key={m.id} className={`crm-wa-msg ${m.direction}`}>
            <span>{m.body ?? `[${m.content_type}]`}</span>
            <time>{dateTime(m.timestamp)}</time>
          </div>
        ))}
        {msgs.length === 0 && <Empty title="Conversa sem mensagens de texto" />}
      </div>
    </div>
  );
}

export function AiPanel({ contactId }: { contactId: string }) {
  const { notify } = useCrm();
  const [data, setData] = useState<{ insights: Record<string, unknown>[]; signals: Record<string, unknown>[] } | null>(null);
  useEffect(() => { api.loadContactAi(contactId).then(setData).catch((e) => { notify(errorText(e)); setData({ insights: [], signals: [] }); }); }, [contactId, notify]);
  if (!data) return <Skeleton rows={2} />;
  if (!data.insights.length && !data.signals.length) return <Empty icon={<Bot />} title="Sem análise da IA" text="A análise aparece depois que a IA processa as conversas de WhatsApp deste contato." />;
  const signalLabel: Record<string, string> = { interest: "Interesse", high_intent: "Alta intenção", negotiation: "Negociação", declared_purchase: "Compra declarada", confirmed_sale: "Venda indicada pela IA", abandonment: "Abandono", commitment: "Compromisso", post_sale: "Pós-venda" };
  return (
    <div className="crm-stack">
      <div className="crm-callout info"><Sparkles size={16} /> Informações <strong>inferidas pela IA</strong> a partir das conversas. Use como apoio — não comprovam venda nem pagamento.</div>
      {data.insights.map((i) => (
        <div key={String(i.conversation_id)} className="crm-ai-card">
          <div className="crm-row between"><strong>Resumo da conversa</strong><small className="crm-muted">{String(i.model_used ?? "IA")} · {relative(String(i.updated_at))}</small></div>
          {Boolean(i.summary) && <p>{String(i.summary)}</p>}
          <div className="crm-ai-grid">
            {Boolean(i.intent) && <span><em>Intenção</em>{String(i.intent)}</span>}
            {i.purchase_probability !== null && i.purchase_probability !== undefined && <span><em>Prob. de compra (estimada)</em>{Math.round(Number(i.purchase_probability) * 100)}%</span>}
            {Array.isArray(i.products_of_interest) && (i.products_of_interest as string[]).length > 0 && <span><em>Interesses</em>{(i.products_of_interest as string[]).join(", ")}</span>}
            {Array.isArray(i.objections) && (i.objections as string[]).length > 0 && <span><em>Objeções</em>{(i.objections as string[]).join(", ")}</span>}
            {Boolean(i.commercial_notes) && <span className="full"><em>Notas para o vendedor</em>{String(i.commercial_notes)}</span>}
          </div>
        </div>
      ))}
      {data.signals.length > 0 && (
        <div className="crm-stack tight">
          <h4 className="crm-subhead">Sinais comerciais detectados</h4>
          {data.signals.map((s) => (
            <div key={String(s.id)} className="crm-signal">
              <Pill tone={s.signal_type === "confirmed_sale" ? "amber" : "info"}>{signalLabel[String(s.signal_type)] ?? String(s.signal_type)}</Pill>
              <span className="grow">{String(s.evidence_text ?? "")}</span>
              <small className="crm-muted">{Math.round(Number(s.confidence ?? 0) * 100)}% · {String(s.status)}{s.auto_confirmed ? " · auto (sem revisão)" : ""}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
