import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download, FileSpreadsheet, Lock, Play, Plus, Trash2, Upload, XCircle, Zap,
} from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, channelLabel, channelLabels, dateTime, emailName, errorText, lifecycleLabels, relative, roleLabels, segmentInfo, segmentOrder, taskTypeLabels } from "./format";
import type { AutomationRule, AutomationRun, CustomField, Pipeline, RfvSegment, ScoringRule, Stage, TaskType } from "./types";
import { Empty, Field, Modal, Pill, Segmented, Skeleton, Tabs } from "./ui";
import { downloadCsv, guessField, parseCsv } from "./csv";

function NoPermission({ text }: { text: string }) {
  return <Empty icon={<Lock />} title="Acesso restrito" text={text} />;
}

// ---------------------------------------------------------------------------
// Automações
// ---------------------------------------------------------------------------
const triggerLabels: Record<string, string> = {
  deal_created: "Nova negociação criada",
  deal_stage_changed: "Negociação mudou de etapa",
  deal_won: "Negociação ganha",
  deal_lost: "Negociação perdida",
  deal_stale: "Negociação sem atividade (passou do prazo da etapa)",
  contact_created: "Novo contato",
  first_purchase: "Primeira compra válida (novo cliente)",
  repeat_purchase: "Recompra",
  rfv_segment_changed: "Cliente mudou de segmento RFV",
  task_overdue: "Tarefa atrasada",
};

function describeAction(a: Record<string, unknown>, memberLabel: (id: string) => string) {
  const who = (spec: unknown) => !spec || spec === "record_owner" ? "o responsável" : String(spec).startsWith("user:") ? memberLabel(String(spec).slice(5)) : "o administrador";
  switch (a.type) {
    case "create_task": return `Criar tarefa “${a.title ?? "Acompanhar"}” (${taskTypeLabels[(a.task_type as TaskType) ?? "follow_up"] ?? a.task_type}) para ${who(a.assign_to)} em ${a.due_in_hours ?? 24}h`;
    case "notify": return `Notificar ${who(a.to)}: “${a.title ?? ""}”`;
    case "add_tag": return `Adicionar a tag “${a.tag}”`;
    case "assign_owner": return a.strategy === "round_robin" ? "Distribuir entre vendedores (quem tem menos negociações abertas)" : `Atribuir a ${who(a.user)}`;
    case "create_onboarding": return "Criar checklist de onboarding";
    case "add_to_campaign": return "Adicionar a campanha";
    default: return String(a.type);
  }
}

export function AutomationsView() {
  const { tenantId, access, stages, memberLabel, notify } = useCrm();
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(() => { api.loadAutomations(tenantId).then((r) => { setRules(r.rules); setRuns(r.runs); }).catch((e) => { notify(errorText(e)); setRules([]); }); }, [tenantId, notify]);
  useEffect(() => { load(); }, [load]);

  async function toggle(r: AutomationRule) {
    try { await api.saveAutomation({ id: r.id, tenant_id: tenantId, enabled: !r.enabled }); notify(r.enabled ? "Automação pausada" : "Automação ativada"); load(); } catch (e) { notify(errorText(e)); }
  }
  async function runNow() {
    setRunning(true);
    const res = await api.runScheduled(tenantId);
    if (res && "error" in res && res.error) notify(errorText(res.error)); else notify("Verificações executadas (negociações paradas, tarefas atrasadas e RFV)");
    setRunning(false); load();
  }

  if (!access.read) return null;
  const ruleName = (id: string) => rules?.find((r) => r.id === id)?.name ?? "Regra";

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <p className="crm-muted small">Automações executam apenas <strong>ações internas</strong> (tarefas, alertas, tags, distribuição, onboarding). Nenhuma mensagem é enviada ao cliente automaticamente.</p>
        <div className="crm-toolbar-right">
          {access.write && <button type="button" className="crm-btn ghost sm" onClick={runNow} disabled={running}><Play size={14} /> Rodar verificações agora</button>}
          {access.configure && <button type="button" className="crm-btn primary" onClick={() => setEditing({ trigger_event: "deal_created", conditions: {}, actions: [{ type: "create_task", task_type: "follow_up", title: "Acompanhar {nome}", due_in_hours: 24, priority: "normal", assign_to: "record_owner" }], enabled: true })}><Plus size={16} /> Nova automação</button>}
        </div>
      </div>
      {rules === null ? <Skeleton rows={4} /> : (
        <div className="crm-stack">
          {rules.length === 0 && <Empty icon={<Zap />} title="Nenhuma automação" text="Crie regras de gatilho → condição → ação." />}
          {rules.map((r) => (
            <article key={r.id} className={`crm-rule${r.enabled ? " on" : ""}`}>
              <div className="crm-rule-main">
                <div className="crm-row gap"><Zap size={16} /><strong>{r.name}</strong>{r.template_key && <Pill tone="muted">modelo</Pill>}{r.error_count > 0 && <Pill tone="red">{r.error_count} erro(s)</Pill>}</div>
                {r.description && <p className="crm-muted small">{r.description}</p>}
                <div className="crm-rule-flow">
                  <span><em>Quando</em>{triggerLabels[r.trigger_event] ?? r.trigger_event}</span>
                  {Object.keys(r.conditions ?? {}).length > 0 && <span><em>Se</em>{describeConditions(r.conditions, stages)}</span>}
                  <span><em>Então</em>{(r.actions ?? []).map((a, i) => <div key={i}>{describeAction(a, memberLabel)}</div>)}</span>
                </div>
                <small className="crm-muted">{r.run_count} execução(ões){r.last_run_at ? ` · última ${relative(r.last_run_at)}` : ""}</small>
              </div>
              <div className="crm-rule-side">
                <label className="crm-switch" title={access.configure ? "" : "Somente administradores e gestores"}>
                  <input type="checkbox" checked={r.enabled} disabled={!access.configure} onChange={() => toggle(r)} /><span />
                </label>
                {access.configure && <button type="button" className="crm-btn ghost xs" onClick={() => setEditing(r)}>Editar</button>}
              </div>
            </article>
          ))}
          <section className="crm-panel">
            <header><h3>Histórico de execução</h3><span className="crm-muted small">últimas 100</span></header>
            {runs.length === 0 ? <p className="crm-muted small">Nenhuma execução registrada ainda.</p> : (
              <table className="crm-table compact">
                <thead><tr><th>Quando</th><th>Regra</th><th>Evento</th><th>Resultado</th><th>Detalhe</th></tr></thead>
                <tbody>{runs.map((x) => (
                  <tr key={x.id} className="static">
                    <td>{dateTime(x.created_at)}</td><td>{ruleName(x.rule_id)}</td><td>{triggerLabels[x.event] ?? x.event}</td>
                    <td>{x.status === "success" ? <Pill tone="green"><CheckCircle2 size={11} /> Executada</Pill> : x.status === "error" ? <Pill tone="red"><XCircle size={11} /> Erro</Pill> : <Pill tone="muted">Ignorada</Pill>}</td>
                    <td className="crm-muted small">{x.message ?? ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function describeConditions(c: Record<string, unknown>, stages: Stage[]) {
  const parts: string[] = [];
  if (Array.isArray(c.segments)) parts.push(`segmento ${(c.segments as RfvSegment[]).map((s) => segmentInfo[s]?.label ?? s).join(" ou ")}`);
  if (c.to_stage_id) parts.push(`etapa “${stages.find((s) => s.id === c.to_stage_id)?.name ?? "?"}”`);
  if (c.source_channel) parts.push(`origem ${channelLabel(String(c.source_channel))}`);
  if (c.min_value) parts.push(`valor ≥ ${brl(Number(c.min_value))}`);
  return parts.join(" e ");
}

function RuleModal({ rule, onClose, onSaved }: { rule: Partial<AutomationRule>; onClose: () => void; onSaved: () => void }) {
  const { tenantId, stages, members, notify } = useCrm();
  const [name, setName] = useState(rule.name ?? "");
  const [trigger, setTrigger] = useState(rule.trigger_event ?? "deal_created");
  const [cond, setCond] = useState<Record<string, unknown>>(rule.conditions ?? {});
  const [actions, setActions] = useState<Record<string, unknown>[]>(rule.actions ?? []);
  const [enabled, setEnabled] = useState(rule.enabled ?? true);
  const isDeal = trigger.startsWith("deal_");
  const setA = (i: number, k: string, v: unknown) => setActions((l) => l.map((a, j) => j === i ? { ...a, [k]: v } : a));
  const assignOptions = [{ v: "record_owner", l: "Responsável pelo registro" }, { v: "admin", l: "Administrador / gestor" }, ...members.map((m) => ({ v: `user:${m.user_id}`, l: emailName(m.email) }))];

  async function save() {
    if (!name.trim()) { notify("Dê um nome à automação."); return; }
    if (!actions.length) { notify("Adicione ao menos uma ação."); return; }
    const clean = Object.fromEntries(Object.entries(cond).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
    try {
      await api.saveAutomation({ id: rule.id, tenant_id: tenantId, name: name.trim(), trigger_event: trigger, conditions: clean, actions, enabled });
      notify("Automação salva"); onSaved();
    } catch (e) { notify(errorText(e)); }
  }

  return (
    <Modal open onClose={onClose} title={rule.id ? "Editar automação" : "Nova automação"} width={680}
      footer={<><label className="crm-check grow"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Ativa</label><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save}>Salvar</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Lead de anúncio → tarefa em 1 hora" /></Field>
        <Field label="Quando (gatilho)" span={2}>
          <select value={trigger} onChange={(e) => { setTrigger(e.target.value); setCond({}); }}>{Object.entries(triggerLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        {trigger === "deal_stage_changed" && (
          <Field label="Somente para a etapa"><select value={String(cond.to_stage_id ?? "")} onChange={(e) => setCond({ ...cond, to_stage_id: e.target.value })}><option value="">Qualquer etapa</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        )}
        {(isDeal || trigger === "contact_created") && (
          <Field label="Somente da origem"><select value={String(cond.source_channel ?? "")} onChange={(e) => setCond({ ...cond, source_channel: e.target.value })}><option value="">Qualquer origem</option>{Object.entries(channelLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        )}
        {isDeal && <Field label="Valor mínimo (R$)"><input inputMode="decimal" value={String(cond.min_value ?? "")} onChange={(e) => setCond({ ...cond, min_value: e.target.value ? Number(e.target.value) : "" })} /></Field>}
        {trigger === "rfv_segment_changed" && (
          <Field label="Quando entrar em" span={2}>
            <div className="crm-chip-choices">{segmentOrder.map((s) => {
              const list = (cond.segments as string[] | undefined) ?? [];
              return <button type="button" key={s} className={list.includes(s) ? "on" : ""} onClick={() => setCond({ ...cond, segments: list.includes(s) ? list.filter((x) => x !== s) : [...list, s] })}>{segmentInfo[s].label}</button>;
            })}</div>
          </Field>
        )}
      </div>
      <h4 className="crm-subhead">Então (ações internas)</h4>
      <div className="crm-stack tight">
        {actions.map((a, i) => (
          <div key={i} className="crm-action-row">
            <select value={String(a.type)} onChange={(e) => setActions((l) => l.map((x, j) => j === i ? { type: e.target.value } : x))}>
              <option value="create_task">Criar tarefa</option><option value="notify">Notificar alguém</option><option value="add_tag">Adicionar tag</option>
              {isDeal && <option value="assign_owner">Definir responsável</option>}<option value="create_onboarding">Criar onboarding</option>
            </select>
            {a.type === "create_task" && <>
              <input value={String(a.title ?? "")} onChange={(e) => setA(i, "title", e.target.value)} placeholder="Título ({nome} = nome do registro)" />
              <select value={String(a.task_type ?? "follow_up")} onChange={(e) => setA(i, "task_type", e.target.value)}>{(Object.keys(taskTypeLabels) as TaskType[]).map((t) => <option key={t} value={t}>{taskTypeLabels[t]}</option>)}</select>
              <input type="number" min={0} value={Number(a.due_in_hours ?? 24)} onChange={(e) => setA(i, "due_in_hours", Number(e.target.value))} title="Prazo em horas" />
              <select value={String(a.priority ?? "normal")} onChange={(e) => setA(i, "priority", e.target.value)}><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select>
              <select value={String(a.assign_to ?? "record_owner")} onChange={(e) => setA(i, "assign_to", e.target.value)}>{assignOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
            </>}
            {a.type === "notify" && <>
              <input value={String(a.title ?? "")} onChange={(e) => setA(i, "title", e.target.value)} placeholder="Título do alerta" />
              <select value={String(a.severity ?? "info")} onChange={(e) => setA(i, "severity", e.target.value)}><option value="info">Informativo</option><option value="warning">Atenção</option><option value="critical">Crítico</option></select>
              <select value={String(a.to ?? "record_owner")} onChange={(e) => setA(i, "to", e.target.value)}>{assignOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
            </>}
            {a.type === "add_tag" && <input value={String(a.tag ?? "")} onChange={(e) => setA(i, "tag", e.target.value)} placeholder="tag" />}
            {a.type === "assign_owner" && (
              <select value={a.strategy === "round_robin" ? "round_robin" : String(a.user ?? "")} onChange={(e) => setActions((l) => l.map((x, j) => j === i ? (e.target.value === "round_robin" ? { type: "assign_owner", strategy: "round_robin" } : { type: "assign_owner", user: e.target.value }) : x))}>
                <option value="round_robin">Rodízio entre vendedores</option>{members.map((m) => <option key={m.user_id} value={`user:${m.user_id}`}>{emailName(m.email)}</option>)}
              </select>
            )}
            <button type="button" className="crm-icon-btn" onClick={() => setActions((l) => l.filter((_, j) => j !== i))} aria-label="Remover ação"><Trash2 size={15} /></button>
          </div>
        ))}
        <button type="button" className="crm-btn ghost xs self-start" onClick={() => setActions((l) => [...l, { type: "create_task", task_type: "follow_up", title: "Acompanhar {nome}", due_in_hours: 24, assign_to: "record_owner" }])}><Plus size={13} /> Adicionar ação</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
type STab = "pipelines" | "loss" | "team" | "general" | "qualification" | "fields";

export function SettingsView() {
  const { access } = useCrm();
  const [tab, setTab] = useState<STab>("pipelines");
  if (!access.configure) return <div className="crm-page"><NoPermission text="Somente administradores da empresa e gestores alteram as configurações do CRM." /></div>;
  return (
    <div className="crm-page">
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "pipelines", label: "Funis e etapas" }, { value: "loss", label: "Motivos de perda" }, { value: "team", label: "Equipe e permissões" },
        { value: "general", label: "Geral" }, { value: "qualification", label: "Qualificação (ICP e score)" }, { value: "fields", label: "Campos personalizados" },
      ]} />
      {tab === "pipelines" && <PipelinesSettings />}
      {tab === "loss" && <LossReasonsSettings />}
      {tab === "team" && <TeamSettings />}
      {tab === "general" && <GeneralSettings />}
      {tab === "qualification" && <QualificationSettings />}
      {tab === "fields" && <FieldsSettings />}
    </div>
  );
}

function PipelinesSettings() {
  const { tenantId, pipelines, stages, settings, notify, reloadStructure } = useCrm();
  const [pid, setPid] = useState(settings?.default_pipeline_id ?? pipelines[0]?.id ?? "");
  const [newPipeline, setNewPipeline] = useState<string | null>(null);
  const list = stages.filter((s) => s.pipeline_id === pid).sort((a, b) => a.position - b.position);
  const pipeline = pipelines.find((p) => p.id === pid);

  async function savePipeline(p: Partial<Pipeline>) { try { await api.savePipeline({ ...p, tenant_id: tenantId }); await reloadStructure(); notify("Funil salvo"); } catch (e) { notify(errorText(e)); } }
  async function createPipeline() {
    if (!newPipeline?.trim()) return;
    try {
      const p = await api.savePipeline({ tenant_id: tenantId, name: newPipeline.trim(), position: pipelines.length });
      const base: Partial<Stage>[] = [
        { name: "Novo lead", probability: 10, kind: "open", legacy_status: "new" }, { name: "Contato realizado", probability: 20, kind: "open", legacy_status: "contacted" },
        { name: "Qualificação", probability: 40, kind: "open", legacy_status: "qualified" }, { name: "Proposta enviada", probability: 60, kind: "open" },
        { name: "Negociação", probability: 80, kind: "open" }, { name: "Venda ganha", probability: 100, kind: "won", legacy_status: "sold" }, { name: "Venda perdida", probability: 0, kind: "lost", legacy_status: "lost" },
      ];
      for (const [i, s] of base.entries()) await api.saveStage({ ...s, tenant_id: tenantId, pipeline_id: p.id, position: i });
      setNewPipeline(null); await reloadStructure(); setPid(p.id); notify("Funil criado com etapas sugeridas — ajuste à vontade");
    } catch (e) { notify(errorText(e)); }
  }
  async function move(i: number, dir: -1 | 1) {
    const ids = list.map((s) => s.id);
    const j = i + dir; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.reorderStages(pid, ids); await reloadStructure(); } catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-stack">
      <div className="crm-row gap wrap">
        {pipelines.map((p) => <button type="button" key={p.id} className={`crm-chip${p.id === pid ? " on" : ""}`} onClick={() => setPid(p.id)}>{p.name}{settings?.default_pipeline_id === p.id ? " · padrão" : ""}</button>)}
        {newPipeline === null ? <button type="button" className="crm-btn ghost xs" onClick={() => setNewPipeline("")}><Plus size={13} /> Novo funil</button> : (
          <span className="crm-row gap"><input className="crm-input" autoFocus value={newPipeline} onChange={(e) => setNewPipeline(e.target.value)} placeholder="Nome do funil" onKeyDown={(e) => e.key === "Enter" && createPipeline()} /><button type="button" className="crm-btn primary xs" onClick={createPipeline}>Criar</button><button type="button" className="crm-btn ghost xs" onClick={() => setNewPipeline(null)}>Cancelar</button></span>
        )}
      </div>
      {pipeline && (
        <section className="crm-panel">
          <header>
            <input className="crm-title-input" defaultValue={pipeline.name} key={pipeline.id} onBlur={(e) => e.target.value.trim() && e.target.value !== pipeline.name && savePipeline({ id: pipeline.id, name: e.target.value.trim() })} aria-label="Nome do funil" />
            {settings?.default_pipeline_id !== pipeline.id && <button type="button" className="crm-btn ghost xs" onClick={async () => { try { await api.saveSettings(tenantId, { default_pipeline_id: pipeline.id }); await reloadStructure(); notify("Funil padrão alterado"); } catch (e) { notify(errorText(e)); } }}>Tornar padrão</button>}
          </header>
          <p className="crm-muted small">Probabilidade alimenta o valor ponderado e a previsão. “Prazo” marca a negociação como parada quando fica mais dias que isso na etapa sem atividade. A etapa “Equivale a” mantém o histórico antigo do IDX (Novo, Contato, Qualificado, Ruim, Perdido, Venda) consistente.</p>
          <div className="crm-stage-editor">
            <div className="head"><span /><span>Etapa</span><span>Tipo</span><span>Prob. %</span><span>Prazo (dias)</span><span>Equivale a (IDX)</span><span>Critério de entrada</span><span /></div>
            {list.map((s, i) => <StageRow key={s.id} stage={s} index={i} count={list.length} onMove={move} />)}
            <button type="button" className="crm-btn ghost xs self-start" onClick={async () => {
              try { await api.saveStage({ tenant_id: tenantId, pipeline_id: pid, name: "Nova etapa", probability: 50, kind: "open", position: list.filter((x) => x.kind === "open").length }); await reloadStructure(); } catch (e) { notify(errorText(e)); }
            }}><Plus size={13} /> Adicionar etapa</button>
          </div>
        </section>
      )}
    </div>
  );
}

const legacyOptions: Record<string, string> = { "": "—", new: "Novo", contacted: "Contato", qualified: "Qualificado/Remarketing", bad: "Ruim", lost: "Perdido", sold: "Venda" };

function StageRow({ stage, index, count, onMove }: { stage: Stage; index: number; count: number; onMove: (i: number, d: -1 | 1) => void }) {
  const { tenantId, notify, reloadStructure } = useCrm();
  const [s, setS] = useState(stage);
  useEffect(() => setS(stage), [stage]);
  const dirty = JSON.stringify(s) !== JSON.stringify(stage);
  async function save() {
    try {
      await api.saveStage({ id: s.id, tenant_id: tenantId, name: s.name, kind: s.kind, probability: s.kind === "won" ? 100 : s.kind === "lost" ? 0 : s.probability, rotting_days: s.rotting_days, legacy_status: s.legacy_status || null, entry_criteria: s.entry_criteria, color: s.color });
      await reloadStructure(); notify("Etapa salva");
    } catch (e) { notify(errorText(e)); }
  }
  async function archive() {
    try { await api.saveStage({ id: s.id, tenant_id: tenantId, archived_at: new Date().toISOString() }); await reloadStructure(); notify("Etapa arquivada"); }
    catch (e) { notify(errorText(e).includes("negocia") ? errorText(e) : `Não foi possível arquivar: ${errorText(e)}`); }
  }
  return (
    <div className={`row${dirty ? " dirty" : ""}`}>
      <span className="move">
        <button type="button" className="crm-icon-btn xs" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label="Subir"><ArrowUp size={13} /></button>
        <button type="button" className="crm-icon-btn xs" disabled={index === count - 1} onClick={() => onMove(index, 1)} aria-label="Descer"><ArrowDown size={13} /></button>
      </span>
      <span className="crm-row gap"><input type="color" value={s.color ?? "#94a3b8"} onChange={(e) => setS({ ...s, color: e.target.value })} aria-label="Cor" /><input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></span>
      <select value={s.kind} onChange={(e) => setS({ ...s, kind: e.target.value as Stage["kind"] })}><option value="open">Em andamento</option><option value="won">Ganha</option><option value="lost">Perdida</option></select>
      <input type="number" min={0} max={100} value={s.probability} disabled={s.kind !== "open"} onChange={(e) => setS({ ...s, probability: Number(e.target.value) })} />
      <input type="number" min={0} value={s.rotting_days ?? ""} disabled={s.kind !== "open"} onChange={(e) => setS({ ...s, rotting_days: e.target.value ? Number(e.target.value) : null })} placeholder="padrão" />
      <select value={s.legacy_status ?? ""} onChange={(e) => setS({ ...s, legacy_status: e.target.value || null })}>{Object.entries(legacyOptions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input value={s.entry_criteria ?? ""} onChange={(e) => setS({ ...s, entry_criteria: e.target.value || null })} placeholder="Ex.: necessidade e orçamento confirmados" />
      <span className="crm-row gap">
        {dirty && <button type="button" className="crm-btn primary xs" onClick={save}>Salvar</button>}
        <button type="button" className="crm-icon-btn" onClick={archive} aria-label="Arquivar etapa" title="Arquivar (só é permitido sem negociações na etapa)"><Trash2 size={14} /></button>
      </span>
    </div>
  );
}

function LossReasonsSettings() {
  const { tenantId, lossReasons, notify, reloadStructure } = useCrm();
  const [name, setName] = useState("");
  async function add() {
    if (!name.trim()) return;
    try { await api.saveLossReason({ tenant_id: tenantId, name: name.trim(), position: lossReasons.length }); setName(""); await reloadStructure(); notify("Motivo adicionado"); } catch (e) { notify(errorText(e)); }
  }
  return (
    <section className="crm-panel">
      <header><h3>Motivos de perda</h3><span className="crm-muted small">obrigatórios ao marcar uma negociação como perdida</span></header>
      <ul className="crm-list">
        {lossReasons.map((r) => (
          <li key={r.id}><div className="crm-list-static"><span className="grow">{r.name}</span>
            <button type="button" className="crm-icon-btn" onClick={async () => { try { await api.saveLossReason({ tenant_id: tenantId, id: r.id, name: r.name, archived_at: new Date().toISOString() }); await reloadStructure(); notify("Motivo arquivado"); } catch (e) { notify(errorText(e)); } }} aria-label="Arquivar"><Trash2 size={14} /></button>
          </div></li>
        ))}
      </ul>
      <div className="crm-row gap"><input className="crm-input grow" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Ex.: Preço acima do orçamento" /><button type="button" className="crm-btn primary sm" onClick={add}>Adicionar</button></div>
    </section>
  );
}

function TeamSettings() {
  const { tenantId, userId, members, notify, reloadStructure } = useCrm();
  const effective = (m: { role: string; crm_role: string | null }) => m.role === "owner" || m.role === "admin" ? "admin" : m.role === "viewer" ? "viewer" : m.crm_role ?? "sales";
  const perms: Record<string, string> = {
    admin: "Tudo, inclusive configurações, exclusões e auditoria", manager: "Toda a equipe, vendas, receita, configurações do funil",
    sales: "Contatos e negociações; vê só as próprias se a visibilidade for “própria”", marketing: "Contatos, origens e campanhas; não registra vendas",
    service: "Atendimento e atividades", success: "Clientes, onboarding e vendas pós-venda", viewer: "Somente leitura",
  };
  return (
    <section className="crm-panel">
      <header><h3>Equipe e permissões</h3><span className="crm-muted small">aplicadas no banco (RLS), não apenas na tela</span></header>
      <table className="crm-table compact">
        <thead><tr><th>Usuário</th><th>Acesso no IDX</th><th>Papel no CRM</th><th>O que pode fazer</th></tr></thead>
        <tbody>{members.map((m) => {
          const eff = effective(m);
          const locked = m.role === "owner" || m.role === "admin" || m.role === "viewer";
          return (
            <tr key={m.user_id} className="static">
              <td><strong>{emailName(m.email)}</strong><small>{m.email}{m.user_id === userId ? " (você)" : ""}</small></td>
              <td>{m.role === "owner" ? "Dono" : m.role === "admin" ? "Administrador" : m.role === "viewer" ? "Leitura" : "Operador"}</td>
              <td>
                {locked ? <Pill tone="muted">{roleLabels[eff]}</Pill> : (
                  <select className="crm-inline-select" value={m.crm_role ?? "sales"} onChange={async (e) => { try { await api.updateMemberCrmRole(tenantId, m.user_id, e.target.value === "sales" ? null : e.target.value); await reloadStructure(); notify("Papel atualizado"); } catch (er) { notify(errorText(er)); } }}>
                    {["sales", "manager", "marketing", "service", "success"].map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
                  </select>
                )}
              </td>
              <td className="crm-muted small">{perms[eff]}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <p className="crm-muted small">Convites, remoção e acesso de dono/administrador são gerenciados em <strong>Usuários</strong> no menu principal do IDX.</p>
    </section>
  );
}

function GeneralSettings() {
  const { tenantId, settings, pipelines, notify, reloadStructure } = useCrm();
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  if (!s) return <Skeleton rows={2} />;
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  async function save() {
    if (!s) return;
    try { await api.saveSettings(tenantId, { seller_visibility: s.seller_visibility, stale_deal_days: s.stale_deal_days, auto_deal_from_whatsapp: s.auto_deal_from_whatsapp, auto_deal_from_clicks: s.auto_deal_from_clicks, default_pipeline_id: s.default_pipeline_id }); await reloadStructure(); notify("Configurações salvas"); }
    catch (e) { notify(errorText(e)); }
  }
  return (
    <section className="crm-panel">
      <header><h3>Geral</h3>{dirty && <button type="button" className="crm-btn primary sm" onClick={save}>Salvar</button>}</header>
      <div className="crm-form-grid">
        <Field label="Vendedores enxergam" hint="Aplicado pelo banco de dados.">
          <select value={s.seller_visibility} onChange={(e) => setS({ ...s, seller_visibility: e.target.value as "all" | "own" })}><option value="all">Todas as negociações da empresa</option><option value="own">Somente as próprias (e sem responsável)</option></select>
        </Field>
        <Field label="Negociação parada após (dias sem atividade)" hint="Usado quando a etapa não define prazo próprio."><input type="number" min={1} value={s.stale_deal_days} onChange={(e) => setS({ ...s, stale_deal_days: Number(e.target.value) })} /></Field>
        <Field label="Funil padrão"><select value={s.default_pipeline_id ?? ""} onChange={(e) => setS({ ...s, default_pipeline_id: e.target.value })}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <span />
        <label className="crm-check span-2"><input type="checkbox" checked={s.auto_deal_from_whatsapp} onChange={(e) => setS({ ...s, auto_deal_from_whatsapp: e.target.checked })} /> Criar negociação automaticamente quando um novo contato falar pelo WhatsApp conectado</label>
        <label className="crm-check span-2"><input type="checkbox" checked={s.auto_deal_from_clicks} onChange={(e) => setS({ ...s, auto_deal_from_clicks: e.target.checked })} /> Criar negociação a partir de cliques nos Smart Links (origem comprovada pelo rastreamento)</label>
      </div>
    </section>
  );
}

const scoringFields: { v: string; l: string }[] = [
  { v: "phone", l: "Telefone" }, { v: "email", l: "E-mail" }, { v: "company_id", l: "Empresa vinculada" }, { v: "job_title", l: "Cargo" }, { v: "city", l: "Cidade" }, { v: "state", l: "UF" },
  { v: "source_channel", l: "Origem" }, { v: "acquisition_basis", l: "Base da origem" }, { v: "tags", l: "Tags" },
  { v: "qualification.budget", l: "Qualificação: orçamento" }, { v: "qualification.need", l: "Qualificação: necessidade" }, { v: "qualification.urgency", l: "Qualificação: urgência" },
  { v: "qualification.segment", l: "Qualificação: segmento" }, { v: "qualification.size", l: "Qualificação: porte" }, { v: "qualification.region", l: "Qualificação: região" },
];

function QualificationSettings() {
  const { tenantId, settings, notify, reloadStructure } = useCrm();
  const [icp, setIcp] = useState<Record<string, string>>((settings?.icp ?? {}) as Record<string, string>);
  const [threshold, setThreshold] = useState(settings?.scoring?.mql_threshold ?? 40);
  const [rules, setRules] = useState<ScoringRule[]>(settings?.scoring?.rules ?? []);
  const [defs, setDefs] = useState<Record<string, string>>(settings?.lifecycle_definitions ?? {});
  async function save() {
    try {
      await api.saveSettings(tenantId, { icp, scoring: { mql_threshold: threshold, rules }, lifecycle_definitions: defs });
      const r = await api.recomputeScores(tenantId) as number | null;
      await reloadStructure(); notify(`Qualificação salva${typeof r === "number" ? ` · score recalculado para ${r} contato(s)` : ""}`);
    } catch (e) { notify(errorText(e)); }
  }
  const setR = (i: number, k: keyof ScoringRule, v: unknown) => setRules((l) => l.map((r, j) => j === i ? { ...r, [k]: v } : r));
  return (
    <div className="crm-stack">
      <section className="crm-panel">
        <header><h3>Perfil de Cliente Ideal (ICP)</h3><button type="button" className="crm-btn primary sm" onClick={save}>Salvar e recalcular scores</button></header>
        <div className="crm-form-grid">
          {[["segments", "Segmentos ideais"], ["sizes", "Porte"], ["regions", "Regiões atendidas"], ["budget", "Orçamento mínimo"], ["needs", "Necessidades / dores"], ["disqualifiers", "Critérios de desqualificação"]].map(([k, l]) => (
            <Field key={k} label={l}><input value={icp[k] ?? ""} onChange={(e) => setIcp({ ...icp, [k]: e.target.value })} /></Field>
          ))}
        </div>
      </section>
      <section className="crm-panel">
        <header><h3>Lead scoring</h3><span className="crm-muted small">prioriza potenciais compradores — independente do RFV e da saúde do cliente</span></header>
        <Field label={`Pontuação mínima para virar MQL automaticamente (atual: ${threshold})`}><input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></Field>
        <div className="crm-stack tight">
          {rules.map((r, i) => (
            <div key={i} className="crm-action-row">
              <input value={r.label} onChange={(e) => setR(i, "label", e.target.value)} placeholder="Descrição" />
              <select value={r.field} onChange={(e) => setR(i, "field", e.target.value)}>{scoringFields.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
              <select value={r.op} onChange={(e) => setR(i, "op", e.target.value)}><option value="exists">está preenchido</option><option value="eq">é igual a</option><option value="in">é um de (vírgula)</option><option value="contains">contém</option><option value="gte">≥</option></select>
              {r.op !== "exists" && <input value={Array.isArray(r.value) ? r.value.join(", ") : String(r.value ?? "")} onChange={(e) => setR(i, "value", r.op === "in" ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : r.op === "gte" ? Number(e.target.value) : e.target.value)} placeholder="valor" />}
              <input type="number" value={r.points} onChange={(e) => setR(i, "points", Number(e.target.value))} title="Pontos" />
              <button type="button" className="crm-icon-btn" onClick={() => setRules((l) => l.filter((_, j) => j !== i))} aria-label="Remover"><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="crm-btn ghost xs self-start" onClick={() => setRules((l) => [...l, { label: "", field: "email", op: "exists", points: 10 }])}><Plus size={13} /> Adicionar critério</button>
        </div>
      </section>
      <section className="crm-panel">
        <header><h3>Definições do ciclo de vida</h3><span className="crm-muted small">critérios claros para MQL, SAL e SQL</span></header>
        <div className="crm-form-grid">
          {(["lead", "mql", "sal", "sql", "opportunity", "customer"] as const).map((k) => (
            <Field key={k} label={lifecycleLabels[k]}><input value={defs[k] ?? ""} onChange={(e) => setDefs({ ...defs, [k]: e.target.value })} /></Field>
          ))}
        </div>
      </section>
    </div>
  );
}

function FieldsSettings() {
  const { tenantId, notify } = useCrm();
  const [list, setList] = useState<CustomField[] | null>(null);
  const [draft, setDraft] = useState({ entity: "contact", label: "", field_type: "text", options: "" });
  const load = useCallback(() => { api.loadCustomFields(tenantId).then(setList).catch(() => setList([])); }, [tenantId]);
  useEffect(() => { load(); }, [load]);
  async function add() {
    if (!draft.label.trim()) return;
    const key = draft.label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    try {
      await api.saveCustomField({ tenant_id: tenantId, entity: draft.entity as CustomField["entity"], label: draft.label.trim(), field_key: key, field_type: draft.field_type, options: draft.field_type === "select" ? draft.options.split(",").map((x) => x.trim()).filter(Boolean) : [], position: list?.length ?? 0 });
      setDraft({ ...draft, label: "", options: "" }); load(); notify("Campo criado");
    } catch (e) { notify(errorText(e)); }
  }
  const types: Record<string, string> = { text: "Texto", number: "Número", money: "Valor (R$)", date: "Data", select: "Lista de opções", boolean: "Sim/Não" };
  return (
    <section className="crm-panel">
      <header><h3>Campos personalizados</h3><span className="crm-muted small">ex.: “Tipo de evento” para buffet, “Procedimento” para clínica</span></header>
      {list === null ? <Skeleton rows={2} /> : list.length === 0 ? <p className="crm-muted small">Nenhum campo personalizado.</p> : (
        <table className="crm-table compact"><thead><tr><th>Campo</th><th>Onde</th><th>Tipo</th><th>Opções</th><th /></tr></thead>
          <tbody>{list.map((f) => <tr key={f.id} className="static"><td>{f.label}<small className="mono">{f.field_key}</small></td><td>{f.entity === "contact" ? "Contato" : f.entity === "deal" ? "Negociação" : "Empresa"}</td><td>{types[f.field_type] ?? f.field_type}</td><td>{f.options.join(", ")}</td>
            <td><button type="button" className="crm-icon-btn" onClick={async () => { try { await api.deleteCustomField(f.id); load(); } catch (e) { notify(errorText(e)); } }} aria-label="Excluir"><Trash2 size={14} /></button></td></tr>)}</tbody></table>
      )}
      <div className="crm-action-row">
        <select value={draft.entity} onChange={(e) => setDraft({ ...draft, entity: e.target.value })}><option value="contact">Contato</option><option value="deal">Negociação</option><option value="company">Empresa</option></select>
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Nome do campo" />
        <select value={draft.field_type} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {draft.field_type === "select" && <input value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Opções separadas por vírgula" />}
        <button type="button" className="crm-btn primary sm" onClick={add}>Criar campo</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Importação CSV
// ---------------------------------------------------------------------------
const importFields: Record<"contacts" | "deals", { v: string; l: string }[]> = {
  contacts: [
    { v: "name", l: "Nome" }, { v: "phone", l: "Telefone" }, { v: "email", l: "E-mail" }, { v: "company", l: "Empresa" }, { v: "job_title", l: "Cargo" },
    { v: "city", l: "Cidade" }, { v: "state", l: "UF" }, { v: "source", l: "Origem" }, { v: "utm_source", l: "UTM source" }, { v: "utm_medium", l: "UTM medium" },
    { v: "utm_campaign", l: "UTM campaign" }, { v: "tags", l: "Tags (separadas por |)" }, { v: "owner_email", l: "E-mail do responsável" }, { v: "notes", l: "Observações" },
  ],
  deals: [
    { v: "title", l: "Nome da negociação" }, { v: "value", l: "Valor" }, { v: "stage", l: "Etapa (nome)" }, { v: "expected_close_date", l: "Fechamento previsto" },
    { v: "name", l: "Nome do contato" }, { v: "phone", l: "Telefone do contato" }, { v: "email", l: "E-mail do contato" }, { v: "company", l: "Empresa" },
    { v: "source", l: "Origem" }, { v: "owner_email", l: "E-mail do responsável" }, { v: "notes", l: "Observações" },
  ],
};

export function ImportView() {
  const { tenantId, access, notify, refresh, navigate } = useCrm();
  const [entity, setEntity] = useState<"contacts" | "deals">("contacts");
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<string[]>([]);
  const [onDup, setOnDup] = useState<"skip" | "update">("skip");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.importRows>> | null>(null);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const loadHistory = useCallback(() => { api.loadImports(tenantId).then((h) => setHistory((h ?? []) as Record<string, unknown>[])).catch(() => setHistory([])); }, [tenantId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const records = useMemo(() => {
    if (!file) return [];
    return file.rows.map((r) => {
      const o: Record<string, string> = {};
      map.forEach((f, i) => { if (f && r[i] !== undefined && r[i] !== "") o[f] = o[f] ? `${o[f]} ${r[i]}` : r[i]; });
      return o;
    }).filter((o) => Object.keys(o).length > 0);
  }, [file, map]);
  const warnings = useMemo(() => {
    if (!records.length) return [];
    const w: string[] = [];
    const noId = records.filter((r) => !r.phone && !r.email && !r.name).length;
    if (noId) w.push(`${noId} linha(s) sem nome, telefone ou e-mail serão rejeitadas.`);
    const badEmail = records.filter((r) => r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)).length;
    if (badEmail) w.push(`${badEmail} e-mail(s) com formato inválido serão ignorados.`);
    const shortPhone = records.filter((r) => r.phone && r.phone.replace(/\D/g, "").length < 10).length;
    if (shortPhone) w.push(`${shortPhone} telefone(s) sem DDD — revise antes de importar.`);
    if (entity === "deals" && !map.includes("title") && !map.includes("name")) w.push("Mapeie “Nome da negociação” ou “Nome do contato”.");
    return w;
  }, [records, entity, map]);

  if (!access.write) return <div className="crm-page"><NoPermission text="Seu perfil não permite importar dados." /></div>;

  async function onFile(f: File | undefined) {
    if (!f) return;
    const text = await f.text();
    const parsed = parseCsv(text);
    if (!parsed.headers.length) { notify("Arquivo vazio ou inválido."); return; }
    setFile({ name: f.name, ...parsed });
    setMap(parsed.headers.map((h) => guessField(h)));
    setResult(null);
  }

  async function run() {
    if (!records.length) return;
    setBusy(true);
    try {
      const r = await api.importRows(tenantId, entity, records, { on_duplicate: onDup }, file?.name ?? "importacao.csv");
      setResult(r); refresh(); loadHistory();
      notify(`Importação concluída: ${r.created} criado(s), ${r.updated} atualizado(s), ${r.skipped} ignorado(s), ${r.errors} erro(s)`);
    } catch (e) { notify(errorText(e)); }
    setBusy(false);
  }

  return (
    <div className="crm-page">
      <div className="crm-grid-2 wide-left">
        <section className="crm-panel">
          <header><h3><Upload size={16} /> Importar planilha (CSV)</h3></header>
          <Segmented value={entity} onChange={(v) => { setEntity(v); if (file) setMap(file.headers.map((h) => guessField(h))); }} options={[{ value: "contacts", label: "Contatos" }, { value: "deals", label: "Negociações" }]} />
          {!file ? (
            <label className="crm-dropzone">
              <FileSpreadsheet size={28} />
              <strong>Escolha um arquivo .csv</strong>
              <span>Exportado do Excel, Google Planilhas ou de outro CRM. Separador vírgula ou ponto e vírgula.</span>
              <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          ) : (
            <div className="crm-stack">
              <div className="crm-row between"><span><strong>{file.name}</strong> · {file.rows.length} linha(s)</span><button type="button" className="crm-link" onClick={() => { setFile(null); setResult(null); }}>Trocar arquivo</button></div>
              <h4 className="crm-subhead">1. Mapeie as colunas</h4>
              <div className="crm-mapping">
                {file.headers.map((h, i) => (
                  <div key={i} className="crm-map-row">
                    <span><strong>{h}</strong><small>{file.rows.slice(0, 2).map((r) => r[i]).filter(Boolean).join(" · ")}</small></span>
                    <select value={map[i] ?? ""} onChange={(e) => setMap((m) => m.map((x, j) => j === i ? e.target.value : x))}>
                      <option value="">Não importar</option>
                      {importFields[entity].map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <h4 className="crm-subhead">2. Pré-visualização ({records.length} registro(s))</h4>
              <div className="crm-table-wrap small">
                <table className="crm-table compact">
                  <thead><tr>{Array.from(new Set(map.filter(Boolean))).map((f) => <th key={f}>{importFields[entity].find((x) => x.v === f)?.l ?? f}</th>)}</tr></thead>
                  <tbody>{records.slice(0, 5).map((r, i) => <tr key={i} className="static">{Array.from(new Set(map.filter(Boolean))).map((f) => <td key={f}>{r[f] ?? ""}</td>)}</tr>)}</tbody>
                </table>
              </div>
              {warnings.length > 0 && <div className="crm-callout warn"><AlertTriangle size={15} /><span>{warnings.join(" ")}</span></div>}
              <h4 className="crm-subhead">3. Duplicados</h4>
              <Segmented size="sm" value={onDup} onChange={setOnDup} options={[{ value: "skip", label: "Ignorar quem já existe" }, { value: "update", label: "Completar dados de quem já existe" }]} />
              <p className="crm-muted small">Duplicados são detectados pelo telefone normalizado (com DDI/DDD) e pelo e-mail. Nunca mesclamos pessoas automaticamente.</p>
              <button type="button" className="crm-btn primary" onClick={run} disabled={busy || !records.length}>{busy ? "Importando…" : `Importar ${records.length} registro(s)`}</button>
            </div>
          )}
          {result && (
            <div className="crm-import-result">
              <div className="crm-mini-stats">
                <span><em>Criados</em><strong>{result.created}</strong></span><span><em>Atualizados</em><strong>{result.updated}</strong></span>
                <span><em>Ignorados</em><strong>{result.skipped}</strong></span><span><em>Erros</em><strong className={result.errors ? "danger-text" : ""}>{result.errors}</strong></span>
              </div>
              {result.report.filter((r) => r.status !== "created").length > 0 && (
                <>
                  <button type="button" className="crm-btn ghost sm self-start" onClick={() => downloadCsv("relatorio-importacao.csv", result.report.map((r) => ({ linha: r.row, status: r.status, mensagem: r.message })))}><Download size={14} /> Baixar relatório</button>
                  <ul className="crm-report">{result.report.filter((r) => r.status !== "created").slice(0, 30).map((r) => <li key={r.row} className={r.status}>Linha {r.row}: {r.message}</li>)}</ul>
                </>
              )}
              <button type="button" className="crm-link" onClick={() => navigate({ name: entity === "contacts" ? "contacts" : "deals" })}>Ver {entity === "contacts" ? "contatos" : "negociações"} →</button>
            </div>
          )}
        </section>
        <aside className="crm-stack">
          <section className="crm-panel">
            <header><h3>Histórico de importações</h3></header>
            {history.length === 0 ? <p className="crm-muted small">Nenhuma importação ainda.</p> : (
              <ul className="crm-list">{history.map((h) => (
                <li key={String(h.id)}><div className="crm-list-static"><span className="grow"><strong>{String(h.file_name ?? "arquivo")}</strong><small>{h.entity === "deals" ? "Negociações" : "Contatos"} · {dateTime(String(h.created_at))}</small></span>
                  <small className="num">{String(h.created_rows)} novos · {String(h.updated_rows)} atual. · {String(h.error_rows)} erros</small></div></li>
              ))}</ul>
            )}
          </section>
          <section className="crm-panel">
            <header><h3>Exportar</h3></header>
            <p className="crm-muted small">Use o botão <strong>Exportar</strong> nas telas de Contatos e Negociações — a exportação respeita os filtros aplicados e as permissões do seu perfil.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
