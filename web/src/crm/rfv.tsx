import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, HeartPulse, Megaphone, RefreshCw, Settings2, Sparkles, Users } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, dateTime, emailName, errorText, num, pct, phoneLabel, relative, segmentInfo, segmentOrder, shortDate } from "./format";
import type { CampaignResult, Onboarding, RfvCustomer, RfvDashboard, RfvSegment, RfvSettings } from "./types";
import { Bar, Empty, Field, Modal, Pill, Skeleton, Stat, Tabs } from "./ui";
import { OnboardingCard } from "./contacts";

type Tab = "overview" | "risk" | "customers" | "campaigns" | "success" | "settings";

export function RfvView() {
  const { tenantId, access, refreshKey, notify } = useCrm();
  const [tab, setTab] = useState<Tab>("overview");
  const [dash, setDash] = useState<RfvDashboard | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.rfvDashboard(tenantId).then(setDash).catch((e) => { notify(errorText(e)); }); }, [tenantId, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function recompute(silent = false) {
    setBusy(true);
    try { const r = await api.computeRfv(tenantId) as { customers?: number } | null; if (!silent) notify(`RFV recalculado${r?.customers !== undefined ? ` para ${r.customers} cliente(s)` : ""}`); load(); }
    catch (e) { notify(errorText(e)); }
    setBusy(false);
  }
  // recalcula automaticamente quando as regras ou compras mudaram e ninguém recalculou ainda
  useEffect(() => { if (dash?.settings?.dirty && access.write && !busy) void recompute(true); }, [dash?.settings?.dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: "overview", label: "Painel" }, { value: "risk", label: "Prioridade de contato" }, { value: "customers", label: "Clientes" },
          { value: "campaigns", label: "Reativação e campanhas" }, { value: "success", label: "Onboarding e CS" }, { value: "settings", label: "Regras" },
        ]} />
        <div className="crm-toolbar-right">
          {dash?.settings?.last_computed_at && <span className="crm-muted small">Calculado {relative(dash.settings.last_computed_at)} · regra v{dash.settings.rule_version}</span>}
          {access.write && <button type="button" className="crm-btn ghost sm" onClick={() => recompute()} disabled={busy}><RefreshCw size={14} className={busy ? "spin" : ""} /> Recalcular</button>}
        </div>
      </div>
      {!dash ? <Skeleton rows={5} height={80} /> : (
        <>
          {tab === "overview" && <Overview dash={dash} onSegment={() => setTab("customers")} />}
          {tab === "risk" && <RiskList />}
          {tab === "customers" && <CustomerList />}
          {tab === "campaigns" && <Campaigns />}
          {tab === "success" && <SuccessBoard />}
          {tab === "settings" && <RulesPanel settings={dash.settings} onSaved={() => recompute()} />}
        </>
      )}
    </div>
  );
}

function Overview({ dash, onSegment }: { dash: RfvDashboard; onSegment: (s: RfvSegment) => void }) {
  if (!dash.customers) {
    return (
      <Empty icon={<HeartPulse />} title="Ainda não há clientes com compras válidas"
        text={`O RFV usa somente vendas confirmadas com evidência (canceladas, grátis e estornadas não contam). ${dash.no_purchase ? `${dash.no_purchase} contato(s) ainda não compraram.` : ""} Registre vendas nas negociações ou nos contatos para começar.`} />
    );
  }
  const segs = segmentOrder.map((s) => dash.segments.find((x) => x.segment === s) ?? { segment: s, customers: 0, revenue: 0, avg_ticket: null, avg_frequency: null });
  const maxC = Math.max(...segs.map((s) => s.customers), 1);
  const totalRev = segs.reduce((a, s) => a + Number(s.revenue), 0) || 1;
  const cell = (r: number, f: number) => dash.matrix.find((m) => m.r === r && m.f === f);
  const maxCell = Math.max(...dash.matrix.map((m) => m.customers), 1);
  const reactivated = dash.migrations.filter((m) => ["hibernating", "lost", "at_risk", "high_value_at_risk"].includes(m.from) && ["champions", "loyal", "potential", "new"].includes(m.to)).reduce((a, m) => a + m.customers, 0);

  return (
    <div className="crm-stack">
      <div className="crm-stats">
        <Stat label="Clientes analisados" value={num(dash.customers)} sub={`${num(dash.no_purchase)} contato(s) sem compra`} />
        <Stat label="Receita líquida" value={brl(dash.revenue, true)} sub={`Ticket médio ${brl(dash.avg_ticket)}`} />
        <Stat label="Frequência média" value={dash.avg_frequency !== null ? `${Number(dash.avg_frequency).toFixed(1)} compras` : "—"} sub={dash.avg_interval_days !== null ? `Intervalo médio ${Math.round(Number(dash.avg_interval_days))} dias` : "Intervalo: precisa de 2+ compras"} />
        <Stat label="Taxa de recompra" value={pct(dash.repurchase_rate)} sub="clientes com 2+ compras válidas" unavailable={dash.repurchase_rate === null ? "Sem dados suficientes" : undefined} />
        <Stat label="Clientes em risco" tone="red" value={pct(dash.at_risk_pct)} sub="em risco + alto valor em risco" unavailable={dash.at_risk_pct === null ? "—" : undefined} />
        <Stat label="Receita no top 20%" value={pct(dash.top20_revenue_share)} sub="concentração em clientes de alto valor" unavailable={dash.top20_revenue_share === null ? "Base pequena" : undefined} />
      </div>

      <div className="crm-grid-2">
        <section className="crm-panel">
          <header><h3>Clientes por segmento</h3><span className="crm-muted small">clique para ver a lista</span></header>
          <div className="crm-seglist">
            {segs.map((s) => (
              <button type="button" key={s.segment} className="crm-segrow" onClick={() => onSegment(s.segment)} title={segmentInfo[s.segment].description}>
                <span className={`crm-segdot tone-${segmentInfo[s.segment].tone}`} />
                <span className="name"><strong>{segmentInfo[s.segment].label}</strong><small>{segmentInfo[s.segment].action}</small></span>
                <Bar value={s.customers} max={maxC} tone={segmentInfo[s.segment].tone} />
                <span className="num"><strong>{s.customers}</strong><small>{Math.round((Number(s.revenue) / totalRev) * 100)}% receita</small></span>
              </button>
            ))}
          </div>
        </section>
        <section className="crm-panel">
          <header><h3>Matriz Recência × Frequência</h3><span className="crm-muted small">cor = nº de clientes; 5 = melhor</span></header>
          <div className="crm-matrix">
            <span className="axis y">Recência →</span>
            {[5, 4, 3, 2, 1].map((r) => (
              <div className="row" key={r}>
                <em>R{r}</em>
                {[1, 2, 3, 4, 5].map((f) => {
                  const c = cell(r, f);
                  const a = c ? 0.12 + 0.88 * (c.customers / maxCell) : 0;
                  return <span key={f} className="cell" style={{ background: c ? `rgba(17,17,17,${a.toFixed(2)})` : undefined, color: a > 0.5 ? "#fff" : undefined }} title={c ? `${c.customers} cliente(s) · ${brl(c.revenue)}` : "Nenhum cliente"}>{c?.customers ?? ""}</span>;
                })}
              </div>
            ))}
            <div className="row foot"><em /> {[1, 2, 3, 4, 5].map((f) => <span key={f}>F{f}</span>)}</div>
            <span className="axis x">Frequência →</span>
          </div>
        </section>
      </div>

      <div className="crm-grid-2">
        <section className="crm-panel">
          <header><h3>Migrações entre segmentos</h3><span className="crm-muted small">últimos 90 dias · {reactivated} reativado(s)</span></header>
          {dash.migrations.length === 0 ? <p className="crm-muted small">Nenhuma mudança de segmento registrada ainda. O histórico é guardado a cada recálculo.</p> : (
            <table className="crm-table compact"><thead><tr><th>De</th><th>Para</th><th className="num">Clientes</th></tr></thead>
              <tbody>{dash.migrations.slice(0, 12).map((m, i) => <tr key={i} className="static"><td>{segmentInfo[m.from]?.label ?? m.from}</td><td>{segmentInfo[m.to]?.label ?? m.to}</td><td className="num">{m.customers}</td></tr>)}</tbody></table>
          )}
        </section>
        <section className="crm-panel">
          <header><h3>Receita e ticket por segmento</h3></header>
          <table className="crm-table compact"><thead><tr><th>Segmento</th><th className="num">Receita</th><th className="num">Ticket</th><th className="num">Compras/cliente</th></tr></thead>
            <tbody>{segs.filter((s) => s.customers).map((s) => <tr key={s.segment} className="static"><td>{segmentInfo[s.segment].label}</td><td className="num">{brl(s.revenue, true)}</td><td className="num">{brl(s.avg_ticket)}</td><td className="num">{s.avg_frequency !== null ? Number(s.avg_frequency).toFixed(1) : "—"}</td></tr>)}</tbody></table>
        </section>
      </div>
    </div>
  );
}

function RiskList() {
  const { tenantId, userId, access, members, refreshKey, notify, openContact, refresh } = useCrm();
  const [owner, setOwner] = useState(access.role === "sales" ? userId : "");
  const [rows, setRows] = useState<RfvCustomer[] | null>(null);
  const load = useCallback(() => {
    api.loadRfvCustomers(tenantId, undefined, owner || null)
      .then((r) => setRows(r.filter((c) => ["high_value_at_risk", "at_risk", "hibernating"].includes(c.segment))))
      .catch((e) => { notify(errorText(e)); setRows([]); });
  }, [tenantId, owner, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function task(c: RfvCustomer) {
    try {
      await api.saveTask({ tenant_id: tenantId, task_type: "call", title: `${c.segment === "high_value_at_risk" ? "Diagnóstico de relacionamento" : "Reativação"}: ${c.name ?? phoneLabel(c.phone)}`, contact_id: c.contact_id, owner_id: c.owner_id ?? userId, priority: c.segment === "high_value_at_risk" ? "urgent" : "high", due_at: new Date(Date.now() + 86400000).toISOString() });
      notify("Tarefa criada"); refresh();
    } catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-stack">
      <div className="crm-row between">
        <p className="crm-muted small">Ordem de prioridade: alto valor em risco → em risco → hibernando; dentro de cada grupo, maior receita e maior atraso no ciclo primeiro.</p>
        {access.role !== "sales" && (
          <select className="crm-select" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Todos os responsáveis</option><option value={userId}>Minha carteira</option>{members.filter((m) => m.user_id !== userId).map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}</select>
        )}
      </div>
      {rows === null ? <Skeleton rows={5} /> : rows.length === 0 ? <Empty icon={<HeartPulse />} title="Nenhum cliente em risco" text="Ótimo sinal — ou ainda não há histórico de compras suficiente." /> : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>#</th><th>Cliente</th><th>Segmento</th><th className="num">Receita</th><th className="num">Compras</th><th className="num">Sem comprar</th><th>Recompra esperada</th><th>Contato</th><th /></tr></thead>
            <tbody>{rows.map((c, i) => (
              <tr key={c.contact_id} onClick={() => openContact(c.contact_id)}>
                <td className="crm-muted">{i + 1}</td>
                <td><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{phoneLabel(c.phone)}</small></td>
                <td><Pill tone={segmentInfo[c.segment].tone}>{segmentInfo[c.segment].label}</Pill></td>
                <td className="num">{brl(c.net_revenue)}</td>
                <td className="num">{c.purchase_count}</td>
                <td className="num">{c.days_since_last} d</td>
                <td>{c.expected_next_purchase_at ? <>{shortDate(c.expected_next_purchase_at)}{(c.overdue_days ?? 0) > 0 && <small className="danger-text">{c.overdue_days} d de atraso</small>}</> : <span className="crm-muted">—</span>}</td>
                <td>{c.do_not_contact ? <Pill tone="red">Não contatar</Pill> : c.marketing_consent === "denied" ? <Pill tone="muted">Sem consentimento</Pill> : <Pill tone="muted">OK</Pill>}</td>
                <td onClick={(e) => e.stopPropagation()}>{access.write && !c.do_not_contact && <button type="button" className="crm-btn ghost xs" onClick={() => task(c)}><CalendarClock size={13} /> Criar tarefa</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CustomerList() {
  const { tenantId, refreshKey, notify, openContact, memberLabel } = useCrm();
  const [segment, setSegment] = useState<string>("");
  const [rows, setRows] = useState<RfvCustomer[] | null>(null);
  useEffect(() => { setRows(null); api.loadRfvCustomers(tenantId, segment || undefined).then(setRows).catch((e) => { notify(errorText(e)); setRows([]); }); }, [tenantId, segment, refreshKey, notify]);
  return (
    <div className="crm-stack">
      <div className="crm-chips">
        <button type="button" className={`crm-chip${!segment ? " on" : ""}`} onClick={() => setSegment("")}>Todos</button>
        {segmentOrder.map((s) => <button type="button" key={s} className={`crm-chip${segment === s ? " on" : ""}`} onClick={() => setSegment(s)}>{segmentInfo[s].label}</button>)}
      </div>
      {segment && <p className="crm-callout info"><Sparkles size={15} /> <span><strong>{segmentInfo[segment as RfvSegment].label}:</strong> {segmentInfo[segment as RfvSegment].description} Ação recomendada: {segmentInfo[segment as RfvSegment].action}.</span></p>}
      {rows === null ? <Skeleton rows={6} /> : rows.length === 0 ? <Empty icon={<Users />} title="Nenhum cliente neste segmento" /> : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Cliente</th><th>Segmento</th><th>R · F · V</th><th className="num">Compras</th><th className="num">Receita</th><th className="num">Ticket</th><th>Última compra</th><th>Responsável</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.contact_id} onClick={() => openContact(c.contact_id)}>
                <td><strong>{c.name ?? phoneLabel(c.phone)}</strong></td>
                <td><Pill tone={segmentInfo[c.segment].tone}>{segmentInfo[c.segment].label}</Pill>{c.previous_segment && c.previous_segment !== c.segment && <small>antes: {segmentInfo[c.previous_segment]?.label}</small>}</td>
                <td className="mono">{c.r_score ?? "–"} · {c.f_score ?? "–"} · {c.m_score ?? "–"}</td>
                <td className="num">{c.purchase_count}</td><td className="num">{brl(c.net_revenue)}</td><td className="num">{brl(c.avg_ticket)}</td>
                <td>{shortDate(c.last_purchase_at)}<small>{c.days_since_last} dias</small></td>
                <td>{c.owner_id ? memberLabel(c.owner_id) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Campaigns() {
  const { tenantId, access, refreshKey, notify } = useCrm();
  const [data, setData] = useState<{ results: CampaignResult[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => { api.loadCampaigns(tenantId).then((d) => setData({ results: d.results })).catch((e) => { notify(errorText(e)); setData({ results: [] }); }); }, [tenantId, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const kinds: Record<string, string> = { reactivation: "Reativação", retention: "Retenção", upsell: "Venda complementar", referral: "Indicação", sampling: "Amostras", acquisition: "Aquisição" };
  return (
    <div className="crm-stack">
      <div className="crm-row between">
        <p className="crm-muted small">Uma campanha registra <strong>quem</strong> foi trabalhado e mede quem voltou a comprar dentro da janela de atribuição. O CRM não envia mensagens automaticamente — o contato é feito pela equipe.</p>
        {access.write && <button type="button" className="crm-btn primary" onClick={() => setCreating(true)}><Megaphone size={16} /> Nova campanha</button>}
      </div>
      {data === null ? <Skeleton rows={3} /> : data.results.length === 0 ? <Empty icon={<Megaphone />} title="Nenhuma campanha ainda" text="Crie uma campanha a partir de um segmento RFV (ex.: hibernando) para acompanhar reativações e receita recuperada." /> : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Campanha</th><th>Tipo</th><th className="num">Clientes</th><th className="num">Responderam</th><th className="num">Compraram</th><th className="num">Reativados</th><th className="num">Receita</th><th className="num">Receita recuperada</th></tr></thead>
            <tbody>{data.results.map((r) => (
              <tr key={r.campaign_id} className="static">
                <td><strong>{r.name}</strong><small>{r.status === "active" ? "Ativa" : r.status}</small></td><td>{kinds[r.kind] ?? r.kind}</td>
                <td className="num">{r.members}</td><td className="num">{r.responded}</td><td className="num">{r.converted}{r.members ? <small>{Math.round((r.converted / r.members) * 100)}%</small> : null}</td>
                <td className="num">{r.reactivated}</td><td className="num">{brl(r.revenue)}</td><td className="num">{brl(r.revenue_recovered)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {creating && <CampaignModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CampaignModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { tenantId, notify } = useCrm();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("reactivation");
  const [segments, setSegments] = useState<RfvSegment[]>(["hibernating"]);
  const [respectConsent, setRespectConsent] = useState(true);
  const [preview, setPreview] = useState<RfvCustomer[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    Promise.all(segments.map((s) => api.loadRfvCustomers(tenantId, s))).then((l) => setPreview(l.flat())).catch(() => setPreview([]));
  }, [segments, tenantId]);
  const eligible = useMemo(() => (preview ?? []).filter((c) => !c.do_not_contact && (!respectConsent || c.marketing_consent !== "denied")), [preview, respectConsent]);

  async function save() {
    if (!name.trim()) { notify("Dê um nome à campanha."); return; }
    if (!eligible.length) { notify("Nenhum cliente elegível nos segmentos escolhidos."); return; }
    setBusy(true);
    try {
      await api.createCampaignWithMembers(tenantId, name.trim(), kind, eligible.map((c) => ({ contact_id: c.contact_id, segment: c.segment })));
      notify(`Campanha criada com ${eligible.length} cliente(s)`); onSaved();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Nova campanha por segmento" width={600}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>Criar com {eligible.length} cliente(s)</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Reativação — novembro" /></Field>
        <Field label="Tipo"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="reactivation">Reativação</option><option value="retention">Retenção</option><option value="upsell">Venda complementar</option><option value="referral">Indicação</option></select></Field>
        <Field label="Segmentos" span={2}>
          <div className="crm-chip-choices">
            {segmentOrder.map((s) => <button type="button" key={s} className={segments.includes(s) ? "on" : ""} onClick={() => setSegments((l) => l.includes(s) ? l.filter((x) => x !== s) : [...l, s])}>{segmentInfo[s].label}</button>)}
          </div>
        </Field>
        <label className="crm-check span-2"><input type="checkbox" checked={respectConsent} onChange={(e) => setRespectConsent(e.target.checked)} /> Excluir quem não autorizou comunicações de marketing (LGPD)</label>
        <p className="crm-muted small span-2">{preview === null ? "Calculando…" : `${preview.length} cliente(s) nos segmentos · ${eligible.length} elegível(is) · contatos marcados como “não contatar” são sempre excluídos.`}</p>
      </div>
    </Modal>
  );
}

function SuccessBoard() {
  const { tenantId, members, refreshKey, notify, openContact } = useCrm();
  const [rows, setRows] = useState<Onboarding[] | null>(null);
  const [status, setStatus] = useState<string>("open");
  const load = useCallback(() => { api.loadOnboardings(tenantId).then(setRows).catch((e) => { notify(errorText(e)); setRows([]); }); }, [tenantId, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const shown = (rows ?? []).filter((o) => status === "all" || (status === "open" ? !["completed", "churned"].includes(o.status) : o.status === status));
  const ml = members.map((m) => ({ id: m.user_id, label: emailName(m.email) }));
  return (
    <div className="crm-stack">
      <div className="crm-chips">
        {[["open", "Em acompanhamento"], ["at_risk", "Em risco"], ["completed", "Concluídos"], ["churned", "Cancelaram"], ["all", "Todos"]].map(([k, l]) => <button type="button" key={k} className={`crm-chip${status === k ? " on" : ""}`} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      {rows === null ? <Skeleton rows={3} /> : shown.length === 0 ? <Empty icon={<Users />} title="Nenhum onboarding" text="Onboardings são criados na página do contato ou automaticamente na primeira compra (automação “Novo cliente: onboarding”)." /> : (
        <div className="crm-grid-2">{shown.map((o) => (
          <div key={o.id} className="crm-panel">
            {o.contact_id && <button type="button" className="crm-link small" onClick={() => openContact(o.contact_id!)}>Abrir contato</button>}
            <OnboardingCard item={o} members={ml} onChanged={load} />
          </div>
        ))}</div>
      )}
    </div>
  );
}

const presets: { key: string; label: string; hint: string }[] = [
  { key: "general", label: "Geral", hint: "Ciclo intermediário" },
  { key: "pharmacy", label: "Farmácia", hint: "Recompra frequente (30–120 dias)" },
  { key: "perfumery", label: "Perfumaria / cosméticos", hint: "Ciclo de 45–240 dias" },
  { key: "clinic", label: "Clínica / saúde", hint: "Retornos de 3 a 12 meses" },
  { key: "events", label: "Buffet / eventos", hint: "Cada evento é uma compra; ciclo anual" },
  { key: "recurring_services", label: "Serviço recorrente", hint: "Cada cobrança válida conta" },
  { key: "b2b_agency", label: "Agência / B2B", hint: "Contratos e ciclos mensais" },
];

function RulesPanel({ settings, onSaved }: { settings: RfvSettings; onSaved: () => void }) {
  const { tenantId, access, notify } = useCrm();
  const [s, setS] = useState(settings);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setS(settings); setDirty(false); }, [settings]);
  const can = access.configure;
  const arr = (k: "r_thresholds" | "f_thresholds" | "m_thresholds", i: number, v: string) => { const next = [...s[k]]; next[i] = Number(v.replace(",", ".")) || 0; setS({ ...s, [k]: next }); setDirty(true); };

  async function applyPreset(key: string) {
    try { await api.applyRfvPreset(tenantId, key); notify("Modelo aplicado — recalculando"); onSaved(); } catch (e) { notify(errorText(e)); }
  }
  async function save() {
    const asc = (a: number[]) => a.every((v, i) => i === 0 || v > a[i - 1]);
    if (!asc(s.r_thresholds) || !asc(s.f_thresholds) || !asc(s.m_thresholds)) { notify("Cada faixa precisa ser maior que a anterior."); return; }
    try {
      await api.saveRfvSettings(tenantId, { method: s.method, r_thresholds: s.r_thresholds, f_thresholds: s.f_thresholds, m_thresholds: s.m_thresholds, window_days: s.window_days, lost_after_days: s.lost_after_days, count_recurring_cycles: s.count_recurring_cycles, min_customers_quintile: s.min_customers_quintile, preset: "custom" });
      notify("Regras salvas — nova versão da regra registrada"); setDirty(false); onSaved();
    } catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-stack">
      {!can && <p className="crm-callout info"><AlertTriangle size={15} /> Somente administradores e gestores alteram as regras do RFV.</p>}
      <section className="crm-panel">
        <header><h3><Settings2 size={16} /> Modelo por tipo de negócio</h3><span className="crm-muted small">atual: {presets.find((p) => p.key === s.preset)?.label ?? "Personalizado"}</span></header>
        <div className="crm-presets">
          {presets.map((p) => <button type="button" key={p.key} disabled={!can} className={s.preset === p.key ? "on" : ""} onClick={() => applyPreset(p.key)}><strong>{p.label}</strong><small>{p.hint}</small></button>)}
        </div>
      </section>
      <section className="crm-panel">
        <header><h3>Faixas de pontuação</h3>{dirty && can && <button type="button" className="crm-btn primary sm" onClick={save}>Salvar regras</button>}</header>
        <div className="crm-form-grid">
          <Field label="Método" hint={`Quintis usam a distribuição da própria base (mínimo ${s.min_customers_quintile} clientes). Abaixo disso, faixas manuais.`}>
            <select value={s.method} disabled={!can} onChange={(e) => { setS({ ...s, method: e.target.value as RfvSettings["method"] }); setDirty(true); }}>
              <option value="auto">Automático (quintis se houver base suficiente)</option><option value="quintile">Sempre quintis</option><option value="manual">Sempre faixas manuais</option>
            </select>
          </Field>
          <Field label="Considerar perdido após (dias)"><input type="number" value={s.lost_after_days} disabled={!can} onChange={(e) => { setS({ ...s, lost_after_days: Number(e.target.value) }); setDirty(true); }} /></Field>
          <Field label="Janela de análise (dias)" hint="Vazio = todo o histórico."><input type="number" value={s.window_days ?? ""} disabled={!can} onChange={(e) => { setS({ ...s, window_days: e.target.value ? Number(e.target.value) : null }); setDirty(true); }} /></Field>
          <label className="crm-check"><input type="checkbox" checked={s.count_recurring_cycles} disabled={!can} onChange={(e) => { setS({ ...s, count_recurring_cycles: e.target.checked }); setDirty(true); }} /> Cada ciclo de cobrança recorrente conta como uma compra</label>
        </div>
        <table className="crm-table compact thresholds">
          <thead><tr><th>Dimensão</th><th>Nota 5</th><th>Nota 4</th><th>Nota 3</th><th>Nota 2</th><th>Nota 1</th></tr></thead>
          <tbody>
            <tr className="static"><td>Recência (dias desde a última compra)</td>{[0, 1, 2, 3].map((i) => <td key={i}>≤ <input value={s.r_thresholds[i]} disabled={!can} onChange={(e) => arr("r_thresholds", i, e.target.value)} /></td>)}<td>&gt; {s.r_thresholds[3]}</td></tr>
            <tr className="static"><td>Frequência (compras válidas)</td>{[3, 2, 1, 0].map((i) => <td key={i}>≥ <input value={s.f_thresholds[i]} disabled={!can} onChange={(e) => arr("f_thresholds", i, e.target.value)} /></td>)}<td>&lt; {s.f_thresholds[0]}</td></tr>
            <tr className="static"><td>Valor (receita líquida, R$)</td>{[3, 2, 1, 0].map((i) => <td key={i}>≥ <input value={s.m_thresholds[i]} disabled={!can} onChange={(e) => arr("m_thresholds", i, e.target.value)} /></td>)}<td>&lt; {s.m_thresholds[0]}</td></tr>
          </tbody>
        </table>
      </section>
      <section className="crm-panel">
        <header><h3>Regras de contabilização (fixas)</h3></header>
        <ul className="crm-bullets">
          <li>Somente vendas <strong>confirmadas ou pagas</strong>, com evidência, entram no RFV. Vendas marcadas pela IA sem revisão ficam pendentes.</li>
          <li>Pedidos cancelados e estornados integralmente não contam. Devoluções parciais reduzem o valor.</li>
          <li>Compras grátis (amostras, brindes) não aumentam frequência nem valor.</li>
          <li>Parcelas de uma compra são uma única compra.</li>
          <li>Clientes sem compra válida ficam em “Sem histórico de compra” — nunca recebem nota inventada.</li>
          <li>Cada alteração de regra gera nova versão; o histórico de cada cliente registra a versão usada. Último cálculo: {settings.last_computed_at ? dateTime(settings.last_computed_at) : "nunca"}.</li>
        </ul>
      </section>
    </div>
  );
}
