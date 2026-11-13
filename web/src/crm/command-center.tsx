import "../styles/command-center.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Bot, CalendarClock, CheckCircle2, CircleDollarSign, Flame, KanbanSquare, MessageCircle, Send, Sparkles, Target, TrendingUp, Trophy, Users, Wifi, WifiOff,
} from "lucide-react";
import * as api from "./api";
import type { WaChannel } from "./api";
import { brl, dueState, errorText, num, phoneLabel, relative } from "./format";
import type { Contact, CrmView, Deal, FlowListItem, KpiResponse, Pipeline, Stage, Task, WaCampaign } from "./types";

// ---------------------------------------------------------------------------
// Dashboard IDX: a central de comando da empresa — dinheiro, funil, WhatsApp,
// disparos, automações e o que precisa de atenção agora, tudo com dado real.
// ---------------------------------------------------------------------------

type Period = "today" | "7d" | "month";
const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "month", label: "Este mês" },
];

function range(p: Period) {
  const now = new Date();
  if (p === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return { from: d, to: now, label: "hoje" }; }
  if (p === "7d") return { from: new Date(Date.now() - 7 * 86400000), to: now, label: "nos últimos 7 dias" };
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, label: "neste mês" };
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

type Data = {
  kpi: KpiResponse | null;
  pipelines: Pipeline[];
  stages: Stage[];
  deals: Deal[];
  tasks: Task[];
  awaiting: Contact[];
  campaigns: WaCampaign[];
  flows: FlowListItem[];
  channel: WaChannel | null;
};

export function CommandCenter({ tenantId, tenantName, onCrm, onWhatsApp, notify }: {
  tenantId: string;
  tenantName: string;
  onCrm: (view: CrmView) => void;
  onWhatsApp: () => void;
  notify?: (msg: string) => void;
}) {
  const [period, setPeriod] = useState<Period>("month");
  const [data, setData] = useState<Data | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = range(period);
    const tomorrow = new Date(); tomorrow.setHours(24, 0, 0, 0);
    const res = await Promise.allSettled([
      api.kpis(tenantId, r.from, r.to, null),
      api.loadPipelines(tenantId),
      api.loadOpenDeals(tenantId, null, 1000),
      api.loadTasks(tenantId, { status: "open", to: tomorrow.toISOString(), limit: 200 }),
      api.loadAwaitingReply(tenantId),
      api.waCampaigns(tenantId),
      api.flowList(tenantId),
      api.waChannel(tenantId),
    ]);
    const ok = <T,>(i: number, fallback: T): T => (res[i].status === "fulfilled" ? (res[i] as PromiseFulfilledResult<T>).value : fallback);
    const firstError = res.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (firstError && res[0].status === "rejected") notify?.(errorText(firstError.reason));
    const p = ok(1, { pipelines: [] as Pipeline[], stages: [] as Stage[] });
    setData({
      kpi: ok(0, null),
      pipelines: p.pipelines ?? [],
      stages: p.stages ?? [],
      deals: ok(2, [] as Deal[]),
      tasks: ok(3, [] as Task[]),
      awaiting: ok(4, [] as Contact[]),
      campaigns: ok(5, [] as WaCampaign[]),
      flows: ok(6, [] as FlowListItem[]),
      channel: ok(7, null),
    });
  }, [tenantId, period, notify]);

  useEffect(() => { setData(null); void load(); }, [load]);
  useEffect(() => { setPipelineId(null); }, [tenantId]);

  // funil: por padrão, o funil com mais negociações abertas
  const activePipeline = useMemo(() => {
    if (!data?.pipelines.length) return null;
    if (pipelineId) return data.pipelines.find((p) => p.id === pipelineId) ?? data.pipelines[0];
    const count = (id: string) => data.deals.filter((d) => d.pipeline_id === id).length;
    return [...data.pipelines].sort((a, b) => count(b.id) - count(a.id))[0];
  }, [data, pipelineId]);

  const funnel = useMemo(() => {
    if (!data || !activePipeline) return [];
    const stages = data.stages.filter((s) => s.pipeline_id === activePipeline.id && s.kind === "open").sort((a, b) => a.position - b.position);
    return stages.map((s) => {
      const ds = data.deals.filter((d) => d.stage_id === s.id);
      return { stage: s, count: ds.length, value: ds.reduce((t, d) => t + Number(d.value ?? 0), 0), rotting: ds.filter((d) => d.is_rotting).length };
    });
  }, [data, activePipeline]);

  const m = data?.kpi?.metrics;
  const val = (k: string) => (m?.[k]?.available ? Number(m[k].value) : null);
  const r = range(period);

  if (!data) return <CommandCenterSkeleton />;

  const overdue = data.tasks.filter((t) => dueState(t.due_at) === "overdue");
  const today = data.tasks.filter((t) => dueState(t.due_at) === "today");
  const agenda = [...overdue, ...today].slice(0, 6);
  const noNext = data.deals.filter((d) => !d.next_activity_at).length;
  const rotting = data.deals.filter((d) => d.is_rotting).length;
  const openValue = data.deals.reduce((t, d) => t + Number(d.value ?? 0), 0);
  const weighted = data.deals.reduce((t, d) => t + Number(d.weighted_value ?? 0), 0);
  const maxCount = Math.max(1, ...funnel.map((f) => f.count));

  const liveCampaigns = data.campaigns.filter((c) => c.status !== "canceled");
  const dispatched = data.campaigns.reduce((t, c) => t + c.sent, 0);
  const replied = data.campaigns.reduce((t, c) => t + c.replied, 0);
  const activeFlows = data.flows.filter((f) => f.status === "active");
  const flowRuns7d = data.flows.reduce((t, f) => t + Number(f.runs_7d ?? 0), 0);
  const flowSent7d = data.flows.reduce((t, f) => t + Number(f.sent_7d ?? 0), 0);

  const ch = data.channel;
  const official = ch?.active === "cloud_api";
  const connected = official ? ch?.cloud?.status === "connected" : ch?.gateway?.status === "connected";
  const chPhone = official ? ch?.cloud?.phone : ch?.gateway?.phone;

  const alerts: { tone: "red" | "amber" | "blue"; text: string; action: string; go: () => void }[] = [];
  if (!connected) alerts.push({ tone: "red", text: "WhatsApp desconectado — respostas, disparos e automações estão parados.", action: "Conectar", go: onWhatsApp });
  if (overdue.length) alerts.push({ tone: "red", text: `${overdue.length} tarefa(s) atrasada(s).`, action: "Ver tarefas", go: () => onCrm({ name: "tasks" }) });
  if (data.awaiting.length) alerts.push({ tone: "amber", text: `${data.awaiting.length} cliente(s) esperando resposta no WhatsApp.`, action: "Responder", go: onWhatsApp });
  if (rotting) alerts.push({ tone: "amber", text: `${rotting} negociação(ões) parada(s) há tempo demais na etapa.`, action: "Ver funil", go: () => onCrm({ name: "deals" }) });
  if (noNext) alerts.push({ tone: "blue", text: `${noNext} negociação(ões) sem próxima atividade marcada.`, action: "Ver funil", go: () => onCrm({ name: "deals" }) });
  const pausedCamp = data.campaigns.find((c) => c.status === "paused" && c.paused_reason);
  if (pausedCamp) alerts.push({ tone: "amber", text: `Disparo “${pausedCamp.name}” pausado: ${pausedCamp.paused_reason}`, action: "Abrir", go: () => onCrm({ name: "dispatch" }) });

  return (
    <div className="cc">
      <header className="cc-hero">
        <div>
          <p className="cc-eyebrow">{new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</p>
          <h2>{greeting()}! Este é o pulso da {tenantName}.</h2>
          <p className="cc-sub">
            {agenda.length ? `${agenda.length} atividade(s) para hoje${overdue.length ? `, ${overdue.length} atrasada(s)` : ""}` : "Nenhuma atividade pendente para hoje"}
            {" · "}{num(data.deals.length)} negociação(ões) em aberto
          </p>
        </div>
        <div className="cc-hero-right">
          <button type="button" className={`cc-channel ${connected ? "on" : "off"}`} onClick={onWhatsApp}>
            {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{connected ? (official ? "API oficial" : "WhatsApp (QR)") : "WhatsApp desconectado"}</span>
            {connected && chPhone && <em>{phoneLabel(chPhone)}</em>}
          </button>
          <div className="cc-period" role="tablist">
            {PERIODS.map((p) => (
              <button key={p.key} type="button" role="tab" aria-selected={period === p.key} className={period === p.key ? "on" : ""} onClick={() => setPeriod(p.key)}>{p.label}</button>
            ))}
          </div>
        </div>
      </header>

      <section className="cc-kpis">
        <Metric icon={<CircleDollarSign size={16} />} tone="green" label={`Receita ${r.label}`} value={brl(val("revenue") ?? 0)} hint={val("orders") ? `${num(val("orders"))} pedido(s) · ticket ${brl(val("avg_ticket"))}` : "Pedidos pagos no CRM"} />
        <Metric icon={<KanbanSquare size={16} />} tone="ink" label="Pipeline em aberto" value={brl(openValue, true)} hint={`${num(data.deals.length)} negociações · ponderado ${brl(weighted, true)}`} />
        <Metric icon={<Target size={16} />} tone="purple" label="Previsão do mês" value={brl(val("forecast_month") ?? 0, true)} hint="Fechamento esperado ponderado" />
        <Metric icon={<Trophy size={16} />} tone="amber" label={`Ganhos ${r.label}`} value={num(val("won_deals") ?? 0)} hint={val("win_rate") != null ? `Taxa de ganho ${num(val("win_rate"), 0)}%` : `${num(val("lost_deals") ?? 0)} perdida(s)`} />
        <Metric icon={<Users size={16} />} tone="blue" label={`Novos contatos ${r.label}`} value={num(val("new_contacts") ?? 0)} hint={`${num(val("qualified_contacts") ?? 0)} qualificado(s)`} />
        <Metric icon={<MessageCircle size={16} />} tone={data.awaiting.length ? "red" : "green"} label="Esperando resposta" value={num(data.awaiting.length)} hint={val("first_response_minutes") != null ? `1ª resposta em ${num(val("first_response_minutes"))} min` : "Conversas com mensagem não lida"} />
      </section>

      {alerts.length > 0 && (
        <section className="cc-alerts">
          {alerts.slice(0, 4).map((a, i) => (
            <button key={i} type="button" className={`cc-alert ${a.tone}`} onClick={a.go}>
              <AlertTriangle size={15} /><span>{a.text}</span><strong>{a.action} <ArrowRight size={13} /></strong>
            </button>
          ))}
        </section>
      )}

      <div className="cc-grid">
        <section className="cc-card cc-span-2">
          <CardHead icon={<TrendingUp size={16} />} title="Funil de vendas" sub={activePipeline ? `${activePipeline.name} · negociações em aberto por etapa` : "Nenhum funil criado"}
            right={data.pipelines.length > 1 ? (
              <select className="cc-select" value={activePipeline?.id ?? ""} onChange={(e) => setPipelineId(e.target.value)}>
                {data.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : null} />
          {funnel.length === 0 ? (
            <EmptyLine text="Crie as etapas do funil em Configurações do CRM." />
          ) : (
            <div className="cc-funnel">
              {funnel.map((f) => (
                <button key={f.stage.id} type="button" className="cc-funnel-row" onClick={() => onCrm({ name: "deals" })}>
                  <span className="cc-funnel-name">{f.stage.name}</span>
                  <span className="cc-funnel-bar"><i style={{ width: `${Math.max(f.count ? 4 : 0, (f.count / maxCount) * 100)}%`, background: f.stage.color ?? undefined }} /></span>
                  <span className="cc-funnel-num">{num(f.count)}</span>
                  <span className="cc-funnel-val">{f.value ? brl(f.value, true) : "—"}</span>
                  {f.rotting > 0 && <span className="cc-flag" title="Negociações paradas"><Flame size={12} /> {f.rotting}</span>}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="cc-card">
          <CardHead icon={<CalendarClock size={16} />} title="Agenda de hoje" sub={overdue.length ? `${overdue.length} atrasada(s)` : "Tarefas que vencem hoje"} onMore={() => onCrm({ name: "tasks" })} />
          {agenda.length === 0 ? <EmptyLine icon={<CheckCircle2 size={16} />} text="Tudo em dia por aqui." /> : (
            <ul className="cc-list">
              {agenda.map((t) => {
                const late = dueState(t.due_at) === "overdue";
                return (
                  <li key={t.id}>
                    <span className={`cc-dot ${late ? "red" : "blue"}`} />
                    <div><strong>{t.title}</strong><small>{t.contact?.name ?? t.deal?.title ?? "Sem contato"} · {late ? `venceu ${relative(t.due_at)}` : t.due_at ? new Date(t.due_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "hoje"}</small></div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="cc-card">
          <CardHead icon={<MessageCircle size={16} />} title="Esperando resposta" sub="Clientes que mandaram mensagem e não foram respondidos" onMore={onWhatsApp} />
          {data.awaiting.length === 0 ? <EmptyLine icon={<CheckCircle2 size={16} />} text="Ninguém esperando. Caixa de entrada zerada." /> : (
            <ul className="cc-list">
              {data.awaiting.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <span className="cc-avatar">{(c.name ?? "?").slice(0, 1).toUpperCase()}</span>
                  <div><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{relative(c.last_message_at)}</small></div>
                  <span className="cc-badge">{c.unread_count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cc-card">
          <CardHead icon={<Sparkles size={16} />} title="Saúde do funil" sub="O que trava as vendas agora" onMore={() => onCrm({ name: "deals" })} />
          <div className="cc-health">
            <HealthItem label="Sem próxima atividade" value={noNext} total={data.deals.length} tone="amber" />
            <HealthItem label="Paradas na etapa" value={rotting} total={data.deals.length} tone="red" />
            <HealthItem label="Vendas a confirmar" value={val("pending_sales") ?? 0} tone="blue" />
            <HealthItem label="Perdidas no período" value={val("lost_deals") ?? 0} tone="grey" />
          </div>
        </section>
        <section className="cc-card">
          <CardHead icon={<Bot size={16} />} title="Automações" sub={`${activeFlows.length} ativa(s) · ${num(flowRuns7d)} conversas e ${num(flowSent7d)} mensagens em 7 dias`} onMore={() => onCrm({ name: "flows" })} />
          {data.flows.length === 0 ? <EmptyLine text="Nenhuma automação criada ainda." /> : (
            <ul className="cc-list">
              {[...data.flows].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || Number(b.runs_7d) - Number(a.runs_7d)).slice(0, 5).map((f) => (
                <li key={f.id}>
                  <span className={`cc-dot ${f.status === "active" ? "green" : "grey"}`} />
                  <div><strong>{f.name}</strong><small>{f.status === "active" ? "Ativa" : f.status === "paused" ? "Pausada" : "Rascunho"} · {num(f.runs_7d)} em 7 dias{Number(f.runs_open) ? ` · ${num(f.runs_open)} em andamento` : ""}</small></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cc-card cc-span-3">
          <CardHead icon={<Send size={16} />} title="Disparos" sub={dispatched ? `${num(dispatched)} enviados · ${num(replied)} respostas (${num(dispatched ? (replied / dispatched) * 100 : 0)}%)` : "Mensagens em massa pelo WhatsApp"} onMore={() => onCrm({ name: "dispatch" })} />
          {liveCampaigns.length === 0 ? <EmptyLine text="Nenhum disparo criado ainda." /> : (
            <ul className="cc-list cc-camps cc-camps-grid">
              {liveCampaigns.slice(0, 6).map((c) => {
                const done = c.total ? Math.round(((c.sent + c.failed + c.invalid + c.opted_out + c.skipped) / c.total) * 100) : 0;
                return (
                  <li key={c.id}>
                    <div className="cc-camp">
                      <div className="cc-camp-top"><strong>{c.name}</strong><span className={`cc-status s-${c.status}`}>{campaignStatus(c.status)}</span></div>
                      <span className="cc-progress"><i style={{ width: `${done}%` }} /></span>
                      <small>{num(c.sent)} de {num(c.total)} enviados · {num(c.replied)} responderam</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

      </div>
    </div>
  );
}

function campaignStatus(s: string) {
  return ({ draft: "Rascunho", running: "Enviando", paused: "Pausado", completed: "Concluído", scheduled: "Agendado", canceled: "Cancelado" } as Record<string, string>)[s] ?? s;
}

function Metric({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string; hint: string; tone: string }) {
  return (
    <div className={`cc-metric t-${tone}`}>
      <span className="cc-metric-icon">{icon}</span>
      <span className="cc-metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function CardHead({ icon, title, sub, onMore, right }: { icon: React.ReactNode; title: string; sub?: string; onMore?: () => void; right?: React.ReactNode }) {
  return (
    <div className="cc-card-head">
      <span className="cc-card-icon">{icon}</span>
      <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
      {right}
      {onMore && <button type="button" className="cc-more" onClick={onMore}>Abrir <ArrowRight size={13} /></button>}
    </div>
  );
}

function HealthItem({ label, value, total, tone }: { label: string; value: number; total?: number; tone: string }) {
  return (
    <div className={`cc-health-item t-${tone}`}>
      <strong>{num(value)}</strong>
      <span>{label}</span>
      {total ? <small>{num(total ? (value / total) * 100 : 0)}% do funil</small> : null}
    </div>
  );
}

function EmptyLine({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return <div className="cc-empty">{icon}{text}</div>;
}

function CommandCenterSkeleton() {
  return (
    <div className="cc">
      <div className="cc-sk cc-sk-hero" />
      <div className="cc-kpis">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="cc-sk cc-sk-kpi" />)}</div>
      <div className="cc-grid">{Array.from({ length: 4 }).map((_, i) => <div key={i} className={`cc-sk cc-sk-card${i === 0 ? " cc-span-2" : ""}`} />)}</div>
    </div>
  );
}
