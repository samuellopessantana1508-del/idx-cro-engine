import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, List, ListTodo, Plus } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { dueState, emailName, errorText, taskTypeLabels, timeOnly } from "./format";
import type { Task, TaskType } from "./types";
import { Empty, Segmented, Skeleton } from "./ui";
import { TaskModal, TaskRow } from "./records";

function dayKey(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

export function TasksView() {
  const { tenantId, userId, access, members, refreshKey, notify, quickCreate } = useCrm();
  const [mode, setMode] = useState<"list" | "calendar">(() => (localStorage.getItem("crm.tasks.mode") as "list" | "calendar") || "list");
  const [owner, setOwner] = useState<string>(access.role === "sales" ? userId : "");
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const [type, setType] = useState("");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [editing, setEditing] = useState<Task | null>(null);

  useEffect(() => { try { localStorage.setItem("crm.tasks.mode", mode); } catch { /* sem storage */ } }, [mode]);

  const load = useCallback(async () => {
    try {
      if (mode === "calendar") {
        const from = new Date(month); from.setDate(from.getDate() - 7);
        const to = new Date(month); to.setMonth(to.getMonth() + 1); to.setDate(to.getDate() + 7);
        setTasks(await api.loadTasks(tenantId, { ownerId: owner || null, status, type: type || undefined, from: from.toISOString(), to: to.toISOString(), limit: 1000 }));
      } else {
        setTasks(await api.loadTasks(tenantId, { ownerId: owner || null, status, type: type || undefined, limit: 600 }));
      }
    } catch (e) { notify(errorText(e)); setTasks([]); }
  }, [tenantId, owner, status, type, mode, month, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const groups = useMemo(() => {
    const now = new Date();
    const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
    const endTomorrow = new Date(endToday.getTime() + 86400000);
    const endWeek = new Date(endToday.getTime() + 7 * 86400000);
    const g: { key: string; title: string; items: Task[] }[] = [
      { key: "overdue", title: "Atrasadas", items: [] }, { key: "today", title: "Hoje", items: [] }, { key: "tomorrow", title: "Amanhã", items: [] },
      { key: "week", title: "Próximos 7 dias", items: [] }, { key: "later", title: "Mais adiante", items: [] }, { key: "none", title: "Sem data", items: [] }, { key: "done", title: "Concluídas", items: [] },
    ];
    const by = Object.fromEntries(g.map((x) => [x.key, x]));
    for (const t of tasks ?? []) {
      if (t.status !== "open") { by.done.items.push(t); continue; }
      if (!t.due_at) { by.none.items.push(t); continue; }
      const d = new Date(t.due_at);
      if (dueState(t.due_at) === "overdue") by.overdue.items.push(t);
      else if (d <= endToday) by.today.items.push(t);
      else if (d <= endTomorrow) by.tomorrow.items.push(t);
      else if (d <= endWeek) by.week.items.push(t);
      else by.later.items.push(t);
    }
    by.done.items.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return g.filter((x) => x.items.length);
  }, [tasks]);

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <select className="crm-select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsável">
            <option value="">Toda a equipe</option>
            <option value={userId}>Minhas atividades</option>
            {members.filter((m) => m.user_id !== userId).map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
          </select>
          <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: "open", label: "Pendentes" }, { value: "done", label: "Concluídas" }, { value: "all", label: "Todas" }]} />
          <select className="crm-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            {(Object.keys(taskTypeLabels) as TaskType[]).map((t) => <option key={t} value={t}>{taskTypeLabels[t]}</option>)}
          </select>
        </div>
        <div className="crm-toolbar-right">
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "list", label: <><List size={15} /> Lista</> }, { value: "calendar", label: <><CalendarDays size={15} /> Calendário</> }]} />
          {access.write && <button type="button" className="crm-btn primary" onClick={() => quickCreate("task", { owner_id: owner || userId })}><Plus size={16} /> Nova atividade</button>}
        </div>
      </div>

      {tasks === null ? <Skeleton rows={6} /> : mode === "list" ? (
        groups.length === 0 ? (
          <Empty icon={<ListTodo />} title={status === "open" ? "Nenhuma atividade pendente" : "Nenhuma atividade"} text="Ligações, reuniões, follow-ups e propostas agendadas aparecem aqui, ligadas aos contatos e negociações." />
        ) : (
          <div className="crm-stack">
            {groups.map((g) => (
              <section key={g.key} className={`crm-panel routine tone-${g.key === "overdue" ? "red" : g.key === "today" ? "ink" : "muted"}`}>
                <header><h3>{g.title}</h3><em className="crm-count">{g.items.length}</em></header>
                <div className="crm-stack tight">{g.items.map((t) => <TaskRow key={t.id} task={t} onChanged={load} />)}</div>
              </section>
            ))}
          </div>
        )
      ) : (
        <Calendar month={month} setMonth={setMonth} tasks={tasks} onOpen={(t) => setEditing(t)}
          onCreate={(d) => { if (!access.write) return; const at = new Date(d); at.setHours(9, 0, 0, 0); quickCreate("task", { owner_id: owner || userId, due_at: at.toISOString() }); }} />
      )}
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function Calendar({ month, setMonth, tasks, onOpen, onCreate }: { month: Date; setMonth: (d: Date) => void; tasks: Task[]; onOpen: (t: Task) => void; onCreate: (d: Date) => void }) {
  const days = useMemo(() => {
    const first = new Date(month);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // semana começa na segunda
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) { if (!t.due_at) continue; const k = dayKey(new Date(t.due_at)); m.set(k, [...(m.get(k) ?? []), t]); }
    return m;
  }, [tasks]);
  const todayKey = dayKey(new Date());
  const shift = (n: number) => { const d = new Date(month); d.setMonth(d.getMonth() + n); setMonth(d); };

  return (
    <div className="crm-calendar">
      <div className="crm-cal-head">
        <button type="button" className="crm-icon-btn" onClick={() => shift(-1)} aria-label="Mês anterior"><ChevronLeft size={18} /></button>
        <h3>{month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</h3>
        <button type="button" className="crm-icon-btn" onClick={() => shift(1)} aria-label="Próximo mês"><ChevronRight size={18} /></button>
        <button type="button" className="crm-btn ghost xs" onClick={() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonth(d); }}>Hoje</button>
      </div>
      <div className="crm-cal-grid">
        {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => <div key={d} className="crm-cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = dayKey(d);
          const list = (byDay.get(k) ?? []).sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
          return (
            <div key={k} className={`crm-cal-day${d.getMonth() !== month.getMonth() ? " out" : ""}${k === todayKey ? " today" : ""}`} onDoubleClick={() => onCreate(d)}>
              <span className="crm-cal-num">{d.getDate()}</span>
              {list.slice(0, 4).map((t) => (
                <button type="button" key={t.id} className={`crm-cal-ev ${t.status === "done" ? "done" : dueState(t.due_at)} prio-${t.priority}`} onClick={() => onOpen(t)} title={`${taskTypeLabels[t.task_type]} · ${t.title}`}>
                  <b>{timeOnly(t.due_at)}</b> {t.title}
                </button>
              ))}
              {list.length > 4 && <small className="crm-muted">+{list.length - 4} mais</small>}
            </div>
          );
        })}
      </div>
      <p className="crm-muted small">Dê dois cliques em um dia para agendar uma atividade.</p>
    </div>
  );
}
