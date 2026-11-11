import { useCallback, useEffect, useState } from "react";
import { Flag, Pencil, Plus, Trash2, Trophy } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, emailName, errorText, num, shortDate } from "./format";
import type { Goal, GoalMetric, GoalProgress } from "./types";
import { Confirm, Empty, Field, Modal, Pill, Skeleton } from "./ui";

export const metricInfo: Record<GoalMetric, { label: string; unit: string; money?: boolean; hint: string }> = {
  won_value: { label: "Receita ganha", unit: "R$", money: true, hint: "Soma das negociações marcadas como ganhas no período." },
  won_count: { label: "Vendas fechadas", unit: "vendas", hint: "Quantidade de negociações ganhas no período." },
  meetings: { label: "Reuniões marcadas", unit: "reuniões", hint: "Reuniões do discador e atividades do tipo reunião criadas no período." },
  calls: { label: "Ligações feitas", unit: "ligações", hint: "Números tocados no discador e tarefas de ligação concluídas." },
  deals_created: { label: "Negociações abertas", unit: "negociações", hint: "Novas negociações criadas no período." },
};
const periodLabel = { week: "Semana", month: "Mês", quarter: "Trimestre" } as const;

const fmt = (m: GoalMetric, v: number) => (metricInfo[m].money ? brl(v, true) : num(v));

function pace(g: GoalProgress): { label: string; tone: string } {
  if (g.pct >= 100) return { label: "Meta batida!", tone: "green" };
  if (g.elapsed_pct <= 3) return { label: "Começando", tone: "muted" };
  const ratio = g.pct / g.elapsed_pct;
  if (ratio >= 1) return { label: "No ritmo", tone: "green" };
  if (ratio >= 0.75) return { label: "Um pouco abaixo", tone: "orange" };
  return { label: "Abaixo do ritmo", tone: "red" };
}

export function GoalCard({ g, compact, onEdit, onArchive }: { g: GoalProgress; compact?: boolean; onEdit?: () => void; onArchive?: () => void }) {
  const { memberLabel } = useCrm();
  const p = pace(g);
  const remaining = Math.max(0, g.target - g.actual);
  const daysLeft = Math.max(0, Math.ceil((new Date(g.period_end + "T23:59:59").getTime() - Date.now()) / 86400000));
  return (
    <section className={`crm-panel crm-goal${compact ? " compact" : ""}`}>
      <header>
        <div>
          <h3>{g.name}</h3>
          <small className="crm-muted">{metricInfo[g.metric].label} · {periodLabel[g.period]} {shortDate(g.period_start)}–{shortDate(g.period_end)}{g.scope === "user" ? ` · ${memberLabel(g.user_id)}` : " · Empresa"}</small>
        </div>
        <Pill tone={p.tone}>{p.label}</Pill>
        {(onEdit || onArchive) && (
          <span className="crm-row">
            {onEdit && <button type="button" className="crm-icon-btn xs" onClick={onEdit} aria-label="Editar meta"><Pencil size={13} /></button>}
            {onArchive && <button type="button" className="crm-icon-btn xs" onClick={onArchive} aria-label="Arquivar meta"><Trash2 size={13} /></button>}
          </span>
        )}
      </header>
      <div className="crm-goal-nums">
        <strong>{fmt(g.metric, g.actual)}</strong>
        <span>de {fmt(g.metric, g.target)}</span>
        <em>{num(g.pct, g.pct < 10 ? 1 : 0)}%</em>
      </div>
      <div className="crm-goal-bar" role="progressbar" aria-valuenow={Math.min(100, g.pct)} aria-valuemin={0} aria-valuemax={100}>
        <span className={`fill tone-${p.tone}`} style={{ width: `${Math.min(100, g.pct)}%` }} />
        <span className="pace" style={{ left: `${Math.min(100, g.elapsed_pct)}%` }} title={`Esperado até hoje: ${num(g.elapsed_pct)}%`} />
      </div>
      <p className="crm-muted small">
        {g.pct >= 100 ? "Parabéns — siga acumulando." : `Faltam ${fmt(g.metric, remaining)} em ${daysLeft} dia(s)${daysLeft > 0 ? ` · ~${fmt(g.metric, Math.ceil(remaining / daysLeft))} por dia` : ""}.`}
      </p>
      {!compact && g.scope === "company" && g.by_user.length > 0 && (
        <ol className="crm-goal-rank">
          {g.by_user.slice(0, 6).map((u, i) => (
            <li key={u.user_id ?? `none-${i}`}><span>{i === 0 && <Trophy size={12} />} {memberLabel(u.user_id)}</span><b>{fmt(g.metric, Number(u.actual))}</b></li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function GoalsView() {
  const { tenantId, access, refreshKey, notify } = useCrm();
  const [goals, setGoals] = useState<GoalProgress[] | null>(null);
  const [editing, setEditing] = useState<GoalProgress | "new" | null>(null);
  const [archiving, setArchiving] = useState<GoalProgress | null>(null);
  const load = useCallback(async () => {
    try { setGoals(await api.loadGoalsProgress(tenantId)); } catch (e) { notify(errorText(e)); setGoals([]); }
  }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left"><p className="crm-muted small">A barra mostra o realizado; o tracinho mostra onde você deveria estar hoje para bater a meta no fim do período.</p></div>
        <div className="crm-toolbar-right">{access.configure && <button type="button" className="crm-btn primary" onClick={() => setEditing("new")}><Plus size={16} /> Nova meta</button>}</div>
      </div>
      {goals === null ? <Skeleton rows={3} height={140} /> : goals.length === 0 ? (
        <Empty icon={<Flag />} title="Nenhuma meta definida" text="Defina metas de ligações, reuniões, vendas ou receita — para a empresa toda ou para cada vendedor."
          action={access.configure ? <button type="button" className="crm-btn primary" onClick={() => setEditing("new")}>Criar primeira meta</button> : undefined} />
      ) : (
        <div className="crm-goal-grid">
          {goals.map((g) => <GoalCard key={g.id} g={g} onEdit={access.configure ? () => setEditing(g) : undefined} onArchive={access.configure ? () => setArchiving(g) : undefined} />)}
        </div>
      )}
      {editing && <GoalModal goal={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      <Confirm open={!!archiving} title="Arquivar meta?" danger confirmLabel="Arquivar" text="Ela sai do painel. Os números (ligações, vendas) continuam registrados."
        onClose={() => setArchiving(null)}
        onConfirm={async () => { const g = archiving; setArchiving(null); if (!g) return; try { await api.archiveGoal(g.id); notify("Meta arquivada"); void load(); } catch (e) { notify(errorText(e)); } }} />
    </div>
  );
}

function GoalModal({ goal, onClose, onSaved }: { goal: GoalProgress | null; onClose: () => void; onSaved: () => void }) {
  const { tenantId, members, pipelines, notify } = useCrm();
  const [metric, setMetric] = useState<GoalMetric>(goal?.metric ?? "calls");
  const [scope, setScope] = useState<Goal["scope"]>(goal?.scope ?? "company");
  const [userId, setUserId] = useState(goal?.user_id ?? members[0]?.user_id ?? "");
  const [period, setPeriod] = useState<Goal["period"]>(goal?.period ?? "month");
  const [target, setTarget] = useState(goal ? String(goal.target) : "");
  const [pipelineId, setPipelineId] = useState(goal?.pipeline_id ?? "");
  const [name, setName] = useState(goal?.name ?? "");
  const [busy, setBusy] = useState(false);
  const auto = `${metricInfo[metric].label} por ${periodLabel[period].toLowerCase()}${scope === "user" ? ` — ${emailName(members.find((m) => m.user_id === userId)?.email)}` : ""}`;

  async function save() {
    const t = Number(String(target).replace(/\./g, "").replace(",", "."));
    if (!(t > 0)) { notify("Informe o valor da meta"); return; }
    if (scope === "user" && !userId) { notify("Escolha o vendedor"); return; }
    setBusy(true);
    try {
      await api.saveGoal({ id: goal?.id, tenant_id: tenantId, name: name.trim() || auto, metric, scope, user_id: scope === "user" ? userId : null, period, target: t, pipeline_id: pipelineId || null });
      notify("Meta salva");
      onSaved();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={goal ? "Editar meta" : "Nova meta"} width={540}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar meta"}</button></>}>
      <div className="crm-form-grid">
        <Field label="O que medir" span={2} hint={metricInfo[metric].hint}>
          <select value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
            {(Object.keys(metricInfo) as GoalMetric[]).map((m) => <option key={m} value={m}>{metricInfo[m].label}</option>)}
          </select>
        </Field>
        <Field label="De quem">
          <select value={scope} onChange={(e) => setScope(e.target.value as Goal["scope"])}><option value="company">Empresa toda</option><option value="user">Um vendedor</option></select>
        </Field>
        {scope === "user" ? (
          <Field label="Vendedor">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>{members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}</select>
          </Field>
        ) : <span />}
        <Field label="Período">
          <select value={period} onChange={(e) => setPeriod(e.target.value as Goal["period"])}><option value="week">Semanal</option><option value="month">Mensal</option><option value="quarter">Trimestral</option></select>
        </Field>
        <Field label={`Meta (${metricInfo[metric].unit})`}>
          <input autoFocus inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={metricInfo[metric].money ? "Ex.: 30000" : "Ex.: 400"} />
        </Field>
        {(metric === "won_value" || metric === "won_count" || metric === "deals_created") && pipelines.length > 1 && (
          <Field label="Funil" span={2}>
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}><option value="">Todos os funis</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
        )}
        <Field label="Nome (opcional)" span={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder={auto} /></Field>
      </div>
    </Modal>
  );
}

/** Resumo das metas para a Visão comercial */
export function GoalsMini() {
  const { tenantId, refreshKey, navigate, userId, access } = useCrm();
  const [goals, setGoals] = useState<GoalProgress[] | null>(null);
  useEffect(() => { api.loadGoalsProgress(tenantId).then(setGoals).catch(() => setGoals([])); }, [tenantId, refreshKey]);
  if (!goals || goals.length === 0) return null;
  const mine = access.role === "sales" ? goals.filter((g) => g.scope === "company" || g.user_id === userId) : goals;
  return (
    <section className="crm-goal-mini">
      <header><h3><Flag size={15} /> Metas</h3><button type="button" className="crm-link" onClick={() => navigate({ name: "goals" })}>Ver todas</button></header>
      <div className="crm-goal-grid compact">{mine.slice(0, 4).map((g) => <GoalCard key={g.id} g={g} compact />)}</div>
    </section>
  );
}
