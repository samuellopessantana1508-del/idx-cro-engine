import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, CalendarCheck2, CalendarClock, CheckCircle2, CircleDollarSign, Flame, HeartPulse, KanbanSquare, MessageCircle, Sunrise, Target, Trophy,
} from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, channelLabel, dueState, errorText, phoneLabel, relative, segmentInfo, shortDate } from "./format";
import type { Contact, Deal, KpiResponse, RfvCustomer, Task } from "./types";
import { Avatar, Empty, Pill, Segmented, Skeleton, Stat } from "./ui";
import { TaskRow } from "./records";

type Period = "month" | "30d" | "quarter";
function periodRange(p: Period): { from: Date; to: Date; label: string } {
  const now = new Date();
  if (p === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, label: "neste mês" };
  if (p === "quarter") return { from: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), to: now, label: "neste trimestre" };
  return { from: new Date(Date.now() - 30 * 86400000), to: now, label: "nos últimos 30 dias" };
}

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// ---------------------------------------------------------------------------
// Visão comercial (dashboard): responde "o que precisa de atenção agora"
// ---------------------------------------------------------------------------
export function HomeView() {
  const { tenantId, userId, access, refreshKey, notify, navigate, openDeal, openContact, memberLabel } = useCrm();
  const [scope, setScope] = useState<"mine" | "team">(access.role === "sales" ? "mine" : "team");
  const [period, setPeriod] = useState<Period>("month");
  const [kpi, setKpi] = useState<KpiResponse | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [awaiting, setAwaiting] = useState<Contact[] | null>(null);
  const [risk, setRisk] = useState<RfvCustomer[] | null>(null);
  const owner = scope === "mine" ? userId : null;
  const range = periodRange(period);

  const load = useCallback(async () => {
    const r = periodRange(period);
    const tomorrow = startOfDay(new Date(Date.now() + 86400000)).toISOString();
    const results = await Promise.allSettled([
      api.kpis(tenantId, r.from, r.to, owner),
      api.loadOpenDeals(tenantId, owner, 400),
      api.loadTasks(tenantId, { ownerId: owner, status: "open", to: tomorrow, limit: 100 }),
      api.loadAwaitingReply(tenantId),
      api.loadRfvCustomers(tenantId, undefined, owner),
    ]);
    const [k, d, t, a, rf] = results;
    if (k.status === "fulfilled") setKpi(k.value); else { setKpi(null); notify(errorText(k.reason)); }
    setDeals(d.status === "fulfilled" ? d.value : []);
    setTasks(t.status === "fulfilled" ? t.value : []);
    setAwaiting(a.status === "fulfilled" ? a.value.filter((c) => !owner || c.owner_id === owner || !c.owner_id) : []);
    setRisk(rf.status === "fulfilled" ? rf.value.filter((c) => c.segment === "high_value_at_risk" || c.segment === "at_risk").slice(0, 6) : []);
  }, [tenantId, owner, period, notify]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const m = kpi?.metrics;
  const in14 = Date.now() + 14 * 86400000;
  const closing = useMemo(() => (deals ?? [])
    .filter((d) => (d.expected_close_date && new Date(d.expected_close_date).getTime() <= in14) || (d.effective_probability ?? 0) >= 60)
    .sort((a, b) => Number(b.weighted_value ?? 0) - Number(a.weighted_value ?? 0)).slice(0, 6), [deals, in14]);
  const noNext = (deals ?? []).filter((d) => !d.next_activity_at);
  const rotting = (deals ?? []).filter((d) => d.is_rotting);
  const overdue = (tasks ?? []).filter((t) => dueState(t.due_at) === "overdue");
  const today = (tasks ?? []).filter((t) => dueState(t.due_at) === "today");

  const val = (key: string) => (m?.[key]?.available ? Number(m[key].value) : null);

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <div className="crm-hello">
            <h2>{greeting()}</h2>
            <p>{overdue.length + today.length > 0 ? `Você tem ${overdue.length + today.length} atividade(s) para hoje${overdue.length ? `, ${overdue.length} atrasada(s)` : ""}.` : "Nenhuma atividade pendente para hoje."}</p>
          </div>
        </div>
        <div className="crm-toolbar-right">
          {access.role !== "sales" && <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: "mine", label: "Minha carteira" }, { value: "team", label: "Equipe" }]} />}
          <Segmented size="sm" value={period} onChange={setPeriod} options={[{ value: "month", label: "Mês" }, { value: "30d", label: "30 dias" }, { value: "quarter", label: "Trimestre" }]} />
        </div>
      </div>

      {!m ? <Skeleton rows={1} height={96} /> : (
        <div className="crm-stats">
          <Stat label="Em negociação" value={brl(val("pipeline_value"), true)} sub={`${val("open_deals") ?? 0} abertas · ponderado ${brl(val("weighted_pipeline"), true)}`} onClick={() => navigate({ name: "deals" })} hint={m.pipeline_value?.formula} />
          <Stat label={`Vendas ${range.label}`} tone="green" value={brl(val("revenue"), true)} sub={`${val("orders") ?? 0} venda(s) com evidência${(val("pending_sales") ?? 0) > 0 ? ` · ${val("pending_sales")} pendente(s)` : ""}`} hint={m.revenue?.formula} />
          <Stat label="Negociações ganhas" value={val("won_deals") ?? 0} sub={m.win_rate?.available ? `Win rate ${Number(m.win_rate.value).toFixed(0)}% · ${val("lost_deals") ?? 0} perdida(s)` : "Win rate: sem negociações encerradas no período"} hint={m.win_rate?.formula} />
          <Stat label="Previsão do mês" value={brl(val("forecast_month"), true)} sub="Σ valor × probabilidade (fechamento no mês)" hint={m.forecast_month?.formula} />
          <Stat label="Atividades atrasadas" tone={overdue.length ? "red" : undefined} value={overdue.length} sub={`${today.length} para hoje`} onClick={() => navigate({ name: "routine" })} />
          <Stat label="Sem próxima ação" tone={noNext.length ? "amber" : undefined} value={noNext.length} sub={`${rotting.length} parada(s) além do prazo da etapa`} onClick={() => navigate({ name: "deals" })} />
        </div>
      )}

      <div className="crm-grid-2">
        <section className="crm-panel">
          <header><h3><Sunrise size={17} /> O que fazer agora</h3><button type="button" className="crm-link" onClick={() => navigate({ name: "routine" })}>Minha rotina <ArrowRight size={13} /></button></header>
          {tasks === null ? <Skeleton rows={3} /> : overdue.length + today.length === 0 ? (
            <Empty icon={<CalendarCheck2 />} title="Tudo em dia" text="Não há atividades atrasadas nem para hoje." />
          ) : (
            <div className="crm-stack tight">{[...overdue, ...today].slice(0, 7).map((t) => <TaskRow key={t.id} task={t} onChanged={load} />)}</div>
          )}
        </section>

        <section className="crm-panel">
          <header><h3><Target size={17} /> Perto de fechar</h3><span className="crm-muted small">fechamento em 14 dias ou probabilidade ≥ 60%</span></header>
          {deals === null ? <Skeleton rows={3} /> : closing.length === 0 ? (
            <Empty icon={<KanbanSquare />} title="Nenhuma negociação perto de fechar" text="Defina data prevista de fechamento nas negociações para ver a previsão aqui." />
          ) : (
            <ul className="crm-list">
              {closing.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => openDeal(d.id)}>
                    <span className="grow"><strong>{d.title}</strong><small>{d.stage_name} · {d.contact_name ?? "sem contato"}{d.expected_close_date ? ` · fecha ${shortDate(d.expected_close_date)}` : ""}</small></span>
                    <span className="num"><strong>{brl(d.value)}</strong><small>{d.effective_probability ?? 0}%</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-panel">
          <header><h3><MessageCircle size={17} /> Contatos aguardando resposta</h3><span className="crm-muted small">mensagens não lidas no WhatsApp</span></header>
          {awaiting === null ? <Skeleton rows={3} /> : awaiting.length === 0 ? (
            <Empty icon={<MessageCircle />} title="Ninguém esperando" text="Quando um contato mandar mensagem e ela não for lida, ele aparece aqui." />
          ) : (
            <ul className="crm-list">
              {awaiting.slice(0, 7).map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => openContact(c.id)}>
                    <Avatar name={c.name ?? c.phone} size={28} />
                    <span className="grow"><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{relative(c.last_message_at)} · {c.owner_id ? memberLabel(c.owner_id) : "sem responsável"}</small></span>
                    <Pill tone="green">{c.unread_count} nova(s)</Pill>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-panel">
          <header><h3><HeartPulse size={17} /> Clientes em risco</h3><button type="button" className="crm-link" onClick={() => navigate({ name: "rfv" })}>RFV <ArrowRight size={13} /></button></header>
          {risk === null ? <Skeleton rows={3} /> : risk.length === 0 ? (
            <Empty icon={<HeartPulse />} title="Nenhum cliente em risco" text="O RFV usa apenas vendas válidas. Sem histórico de compras suficiente, nenhum cliente é classificado." />
          ) : (
            <ul className="crm-list">
              {risk.map((c) => (
                <li key={c.contact_id}>
                  <button type="button" onClick={() => openContact(c.contact_id)}>
                    <span className="grow"><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{c.days_since_last} dias sem comprar · {c.purchase_count} compra(s)</small></span>
                    <span className="num"><Pill tone={segmentInfo[c.segment].tone}>{segmentInfo[c.segment].label}</Pill><small>{brl(c.net_revenue, true)}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {m && (
        <div className="crm-grid-2">
          <section className="crm-panel">
            <header><h3><CircleDollarSign size={17} /> Origem dos resultados {range.label}</h3><span className="crm-muted small">somente origem registrada; nunca inferida</span></header>
            <ChannelTable rows={(m.by_channel?.value as { channel: string; leads: number; won: number; revenue: number }[]) ?? []} />
          </section>
          <section className="crm-panel">
            <header><h3><Trophy size={17} /> Desempenho por responsável</h3></header>
            <OwnerTable rows={(m.by_owner?.value as { owner_id: string; email: string; open_deals: number; won_deals: number; won_value: number; tasks_done: number; tasks_overdue: number }[]) ?? []} />
          </section>
        </div>
      )}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function ChannelTable({ rows }: { rows: { channel: string; leads: number; won: number; revenue: number }[] }) {
  if (!rows.length) return <Empty title="Sem contatos no período" />;
  const max = Math.max(...rows.map((r) => r.leads), 1);
  return (
    <table className="crm-table compact">
      <thead><tr><th>Canal</th><th className="num">Contatos</th><th className="num">Ganhas</th><th className="num">Conversão</th><th className="num">Receita</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.channel}>
            <td><span className="crm-barlabel"><i style={{ width: `${Math.round((r.leads / max) * 100)}%` }} />{r.channel === "desconhecido" ? "Origem não comprovada" : channelLabel(r.channel)}</span></td>
            <td className="num">{r.leads}</td><td className="num">{r.won}</td>
            <td className="num">{r.leads ? `${Math.round((r.won / r.leads) * 100)}%` : "—"}</td>
            <td className="num">{brl(r.revenue, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OwnerTable({ rows }: { rows: { owner_id: string; email: string; open_deals: number; won_deals: number; won_value: number; tasks_done: number; tasks_overdue: number }[] }) {
  const shown = rows.filter((r) => r.open_deals || r.won_deals || r.tasks_done || r.tasks_overdue);
  if (!shown.length) return <Empty title="Sem atividade da equipe no período" />;
  return (
    <table className="crm-table compact">
      <thead><tr><th>Responsável</th><th className="num">Abertas</th><th className="num">Ganhas</th><th className="num">Valor ganho</th><th className="num">Ativ. feitas</th><th className="num">Atrasadas</th></tr></thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.owner_id}>
            <td><span className="crm-row gap"><Avatar name={r.email} size={22} />{r.email?.split("@")[0]}</span></td>
            <td className="num">{r.open_deals}</td><td className="num">{r.won_deals}</td><td className="num">{brl(r.won_value, true)}</td>
            <td className="num">{r.tasks_done}</td><td className={`num${r.tasks_overdue ? " danger-text" : ""}`}>{r.tasks_overdue}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Minha rotina: tela simples para o vendedor
// ---------------------------------------------------------------------------
export function RoutineView() {
  const { tenantId, userId, access, refreshKey, notify, openDeal, openContact, quickCreate, memberLabel } = useCrm();
  const [who, setWho] = useState<string>(userId);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [awaiting, setAwaiting] = useState<Contact[] | null>(null);
  const { members } = useCrm();

  const load = useCallback(async () => {
    const weekAhead = startOfDay(new Date(Date.now() + 8 * 86400000)).toISOString();
    const [t, d, a] = await Promise.allSettled([
      api.loadTasks(tenantId, { ownerId: who || null, status: "open", to: weekAhead, limit: 300 }),
      api.loadOpenDeals(tenantId, who || null, 300),
      api.loadAwaitingReply(tenantId),
    ]);
    if (t.status === "rejected") notify(errorText(t.reason));
    setTasks(t.status === "fulfilled" ? t.value : []);
    setDeals(d.status === "fulfilled" ? d.value : []);
    setAwaiting(a.status === "fulfilled" ? a.value.filter((c) => !who || c.owner_id === who || !c.owner_id) : []);
  }, [tenantId, who, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const groups = useMemo(() => {
    const g = { overdue: [] as Task[], today: [] as Task[], next: [] as Task[] };
    for (const t of tasks ?? []) {
      const s = dueState(t.due_at);
      if (s === "overdue") g.overdue.push(t); else if (s === "today") g.today.push(t); else g.next.push(t);
    }
    return g;
  }, [tasks]);
  const noNext = (deals ?? []).filter((d) => !d.next_activity_at);

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <div className="crm-hello">
            <h2>{greeting()}{who === userId ? "" : `, visão de ${memberLabel(who)}`}</h2>
            <p>{new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</p>
          </div>
        </div>
        <div className="crm-toolbar-right">
          {access.role !== "sales" && (
            <select className="crm-select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Rotina de">
              <option value={userId}>Minha rotina</option>
              <option value="">Toda a equipe</option>
              {members.filter((m) => m.user_id !== userId).map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m.user_id)}</option>)}
            </select>
          )}
          {access.write && <button type="button" className="crm-btn primary" onClick={() => quickCreate("task", { owner_id: who || userId })}><CalendarClock size={16} /> Nova atividade</button>}
        </div>
      </div>

      <div className="crm-routine">
        <div className="crm-stack">
          <RoutineGroup title="Atrasadas" tone="red" icon={<AlertTriangle size={16} />} tasks={groups.overdue} loading={tasks === null} onChanged={load} emptyText="Nada atrasado. 👏" />
          <RoutineGroup title="Hoje" tone="ink" icon={<CalendarCheck2 size={16} />} tasks={groups.today} loading={tasks === null} onChanged={load} emptyText="Nenhuma atividade para hoje." />
          <RoutineGroup title="Próximos 7 dias" tone="muted" icon={<CalendarClock size={16} />} tasks={groups.next} loading={tasks === null} onChanged={load} emptyText="Agenda livre nos próximos dias." />
        </div>
        <aside className="crm-stack">
          <section className="crm-panel">
            <header><h3><Flame size={16} /> Negociações sem próximo passo</h3><em className="crm-count">{noNext.length}</em></header>
            {deals === null ? <Skeleton rows={2} /> : noNext.length === 0 ? <p className="crm-muted small">Todas as negociações abertas têm uma atividade agendada.</p> : (
              <ul className="crm-list">
                {noNext.slice(0, 10).map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => openDeal(d.id)}>
                      <span className="grow"><strong>{d.title}</strong><small>{d.stage_name} · {d.days_in_stage}d na etapa{d.is_rotting ? " · parada" : ""}</small></span>
                      <span className="num">{brl(d.value, true)}</span>
                    </button>
                    {access.write && <button type="button" className="crm-btn ghost xs" onClick={() => quickCreate("task", { deal_id: d.id, contact_id: d.contact_id, owner_id: d.owner_id ?? userId, title: `Próximo passo: ${d.title}` })}>Agendar</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="crm-panel">
            <header><h3><MessageCircle size={16} /> Aguardando retorno</h3><em className="crm-count">{awaiting?.length ?? 0}</em></header>
            {awaiting === null ? <Skeleton rows={2} /> : awaiting.length === 0 ? <p className="crm-muted small">Nenhum contato com mensagem não lida.</p> : (
              <ul className="crm-list">
                {awaiting.slice(0, 10).map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => openContact(c.id)}>
                      <span className="grow"><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{relative(c.last_message_at)}</small></span>
                      <Pill tone="green">{c.unread_count}</Pill>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="crm-note"><CheckCircle2 size={14} /> Dica: clique no círculo para concluir; “Reagendar” move a atividade em um clique.</p>
        </aside>
      </div>
    </div>
  );
}

function RoutineGroup({ title, tone, icon, tasks, loading, onChanged, emptyText }: {
  title: string; tone: string; icon: React.ReactNode; tasks: Task[]; loading: boolean; onChanged: () => void; emptyText: string;
}) {
  return (
    <section className={`crm-panel routine tone-${tone}`}>
      <header><h3>{icon} {title}</h3><em className="crm-count">{tasks.length}</em></header>
      {loading ? <Skeleton rows={2} /> : tasks.length === 0 ? <p className="crm-muted small">{emptyText}</p> : (
        <div className="crm-stack tight">{tasks.map((t) => <TaskRow key={t.id} task={t} onChanged={onChanged} />)}</div>
      )}
    </section>
  );
}
