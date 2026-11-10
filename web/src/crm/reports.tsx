import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Info } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, emailName, errorText, num } from "./format";
import type { Deal, Kpi, KpiResponse } from "./types";
import { Empty, Segmented, Skeleton } from "./ui";
import { ChannelTable, OwnerTable } from "./home";

type Period = "month" | "last_month" | "90d" | "year";
function range(p: Period) {
  const now = new Date();
  if (p === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  if (p === "last_month") return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
  if (p === "year") return { from: new Date(now.getFullYear(), 0, 1), to: now };
  return { from: new Date(Date.now() - 90 * 86400000), to: now };
}

const groups: { title: string; purpose: string; keys: string[] }[] = [
  { title: "Marketing e aquisição", purpose: "De onde vêm os contatos e quanto custam.", keys: ["new_contacts", "qualified_contacts", "ad_spend", "cpl", "new_customers", "cac"] },
  { title: "Vendas", purpose: "Saúde do funil e capacidade de fechar.", keys: ["open_deals", "pipeline_value", "weighted_pipeline", "forecast_month", "won_deals", "lost_deals", "win_rate", "sales_cycle_days", "revenue", "orders", "avg_ticket", "pending_sales"] },
  { title: "Retenção e relacionamento", purpose: "Quanto da base continua comprando.", keys: ["customers", "repurchase_rate", "reactivated", "customer_churn", "revenue_churn", "grr", "nrr"] },
  { title: "Operação", purpose: "Disciplina da equipe e qualidade dos dados.", keys: ["first_response_minutes", "sla_24h", "tasks_done", "tasks_overdue", "tasks_today", "deals_without_next_action", "rotting_deals", "data_completeness", "automation_errors"] },
];

function fmt(k: Kpi) {
  if (!k.available || k.value === null) return null;
  const v = Number(k.value);
  switch (k.unit) {
    case "money": return brl(v);
    case "percent": return `${v.toFixed(1).replace(".", ",")}%`;
    case "days": return `${v.toFixed(1).replace(".", ",")} dias`;
    case "minutes": return v >= 120 ? `${(v / 60).toFixed(1).replace(".", ",")} h` : `${Math.round(v)} min`;
    default: return num(v);
  }
}

export function ReportsView() {
  const { tenantId, userId, access, members, pipelines, stages, refreshKey, notify } = useCrm();
  const [period, setPeriod] = useState<Period>("month");
  const [owner, setOwner] = useState(access.role === "sales" ? userId : "");
  const [data, setData] = useState<KpiResponse | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    const r = range(period);
    setData(null);
    api.kpis(tenantId, r.from, r.to, owner || null).then(setData).catch((e) => { notify(errorText(e)); });
  }, [tenantId, period, owner, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const m = data?.metrics;
  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <Segmented size="sm" value={period} onChange={setPeriod} options={[{ value: "month", label: "Este mês" }, { value: "last_month", label: "Mês passado" }, { value: "90d", label: "90 dias" }, { value: "year", label: "Ano" }]} />
          {access.role !== "sales" && (
            <select className="crm-select" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Toda a equipe</option>{members.map((x) => <option key={x.user_id} value={x.user_id}>{emailName(x.email)}</option>)}</select>
          )}
        </div>
        <p className="crm-muted small">Passe o mouse ou clique no ⓘ para ver fórmula e fonte. “Indisponível” significa falta de dado — nunca zero.</p>
      </div>
      {!m ? <Skeleton rows={4} height={90} /> : (
        <div className="crm-stack">
          {groups.map((g) => (
            <section key={g.title} className="crm-panel">
              <header><h3>{g.title}</h3><span className="crm-muted small">{g.purpose}</span></header>
              <div className="crm-kpis">
                {g.keys.filter((k) => m[k]).map((k) => {
                  const kpi = m[k];
                  const value = fmt(kpi);
                  return (
                    <div key={k} className={`crm-kpi${value === null ? " na" : ""}`} title={`${kpi.formula}\nFonte: ${kpi.source}`}>
                      <span className="label">{kpi.label}<button type="button" className="crm-icon-btn xs" onClick={() => setOpen(open === k ? null : k)} aria-label="Definição"><Info size={12} /></button></span>
                      <strong>{value ?? "Indisponível"}</strong>
                      {k === "pending_sales" && kpi.available && Number(kpi.extra ?? 0) > 0 && <small>{brl(Number(kpi.extra))} aguardando evidência</small>}
                      {k === "data_completeness" && kpi.extra ? <small>{completenessText(kpi.extra as Record<string, number>)}</small> : null}
                      {open === k && <div className="crm-kpi-def"><b>Fórmula:</b> {kpi.formula}<br /><b>Fonte:</b> {kpi.source}{!kpi.available && <><br /><b>Por que indisponível:</b> ainda não há dados suficientes para calcular com segurança.</>}</div>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          <div className="crm-grid-2">
            <section className="crm-panel"><header><h3>Contatos, vendas e receita por canal</h3></header><ChannelTable rows={(m.by_channel?.value as never[]) ?? []} /></section>
            <section className="crm-panel"><header><h3>Produtividade por responsável</h3></header><OwnerTable rows={(m.by_owner?.value as never[]) ?? []} /></section>
          </div>
          <StageConversion pipelines={pipelines} stages={stages} period={period} />
        </div>
      )}
    </div>
  );
}

function completenessText(x: Record<string, number>) {
  if (!x.contacts) return "";
  const p = (n: number) => `${Math.round((n / x.contacts) * 100)}%`;
  return `telefone/e-mail ${p(x.with_contact_info)} · origem ${p(x.with_source)} · responsável ${p(x.with_owner)}`;
}

function StageConversion({ pipelines, stages, period }: { pipelines: { id: string; name: string }[]; stages: { id: string; pipeline_id: string; name: string; position: number; kind: string }[]; period: Period }) {
  const { tenantId, notify } = useCrm();
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? "");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [hist, setHist] = useState<{ deal_id: string; to_stage_id: string }[] | null>(null);
  useEffect(() => {
    const r = range(period);
    setDeals(null);
    Promise.all([api.loadDeals(tenantId, { pipelineId, includeClosedDays: 3650 }), api.loadStageHistory(tenantId, new Date(r.from.getTime() - 365 * 86400000).toISOString())])
      .then(([d, h]) => { setDeals(d.filter((x) => new Date(x.created_at) >= r.from && new Date(x.created_at) < r.to)); setHist(h); })
      .catch((e) => { notify(errorText(e)); setDeals([]); setHist([]); });
  }, [tenantId, pipelineId, period, notify]);

  const rows = useMemo(() => {
    if (!deals || !hist) return null;
    const list = stages.filter((s) => s.pipeline_id === pipelineId).sort((a, b) => a.position - b.position);
    const open = list.filter((s) => s.kind === "open");
    const pos = new Map(list.map((s) => [s.id, s.position]));
    const reached = new Map<string, number>(); // deal -> maior posição alcançada (etapas abertas) ou infinito se ganhou
    for (const d of deals) {
      let max = pos.get(d.stage_id) ?? 0;
      if (d.status === "won") max = Infinity;
      for (const h of hist) if (h.deal_id === d.id) max = Math.max(max, pos.get(h.to_stage_id) ?? 0);
      reached.set(d.id, max);
    }
    const total = deals.length;
    const won = deals.filter((d) => d.status === "won").length;
    const out = open.map((s) => ({ name: s.name, n: [...reached.values()].filter((v) => v >= s.position).length }));
    out.push({ name: "Ganha", n: won });
    return { total, out };
  }, [deals, hist, stages, pipelineId]);

  return (
    <section className="crm-panel">
      <header><h3><BarChart3 size={16} /> Conversão por etapa (negociações criadas no período)</h3>
        {pipelines.length > 1 && <select className="crm-select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </header>
      {rows === null ? <Skeleton rows={3} /> : rows.total === 0 ? <Empty title="Nenhuma negociação criada no período" /> : (
        <div className="crm-funnel">
          {rows.out.map((r, i) => (
            <div key={r.name} className="crm-funnel-row">
              <span className="name">{r.name}</span>
              <span className="bar"><i style={{ width: `${Math.max(2, (r.n / rows.total) * 100)}%` }} /></span>
              <span className="num"><strong>{r.n}</strong><small>{Math.round((r.n / rows.total) * 100)}% do total{i > 0 && rows.out[i - 1].n ? ` · ${Math.round((r.n / rows.out[i - 1].n) * 100)}% da etapa anterior` : ""}</small></span>
            </div>
          ))}
          <p className="crm-muted small">Uma negociação conta em todas as etapas que alcançou (pelo histórico de movimentações). Fonte: crm_deal_stage_history + status atual.</p>
        </div>
      )}
    </section>
  );
}
