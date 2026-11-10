import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDownUp, CalendarClock, ChevronDown, Clock, Download, Filter, Flame, KanbanSquare, List, MessageCircle, Plus, Search, Trophy, X,
} from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, channelLabel, dueState, emailName, errorText, evidenceLabels, parseMoney, priorityLabels, relative, shortDate, taskTypeLabels } from "./format";
import type { Deal, Stage } from "./types";
import { Avatar, Empty, Field, Modal, Pill, Segmented, Skeleton } from "./ui";
import { downloadCsv } from "./csv";

// ---------------------------------------------------------------------------
// Mudança de etapa (usada no Kanban, na lista e no painel da negociação)
// ---------------------------------------------------------------------------
export function useStageMover(onChanged: (d: Deal) => void) {
  const { stages, notify } = useCrm();
  const [pending, setPending] = useState<{ deal: Deal; stage: Stage } | null>(null);

  const syncLegacy = useCallback(async (deal: Deal, stage: Stage) => {
    if (!deal.tracking_session_id || !stage.legacy_status || stage.legacy_status === "sold" || stage.legacy_status === "new") return;
    try {
      await api.callLegacyCrm({ action: "update_stage", session_id: deal.tracking_session_id, status: stage.legacy_status });
    } catch (e) {
      notify(`Etapa salva. O evento de conversão do IDX não foi sincronizado: ${errorText(e)}`);
    }
  }, [notify]);

  const move = useCallback(async (deal: Deal, stageId: string, extra: Partial<Deal> = {}) => {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage || (stage.id === deal.stage_id && !Object.keys(extra).length)) return;
    if (stage.kind === "won" && deal.status !== "won" && !("__confirmed" in extra)) { setPending({ deal, stage }); return; }
    if (stage.kind === "lost" && deal.status !== "lost" && !("loss_reason_id" in extra)) { setPending({ deal, stage }); return; }
    const { __confirmed: _c, ...patch } = extra as Partial<Deal> & { __confirmed?: boolean };
    void _c;
    try {
      const updated = await api.updateDeal(deal.id, { stage_id: stageId, ...patch });
      onChanged({ ...deal, ...updated, stage_name: stage.name, stage_kind: stage.kind, stage_color: stage.color, days_in_stage: 0 });
      notify(stage.kind === "won" ? `🎉 ${deal.title} ganha!` : `Movida para ${stage.name}`);
      void syncLegacy(deal, stage);
    } catch (e) {
      notify(errorText(e));
      onChanged(deal); // reverte o otimista
    }
  }, [stages, notify, onChanged, syncLegacy]);

  const dialogs = pending ? (
    pending.stage.kind === "won"
      ? <WinDialog deal={pending.deal} stage={pending.stage} onClose={() => { onChanged(pending.deal); setPending(null); }} onDone={(d) => { onChanged(d); setPending(null); }} />
      : <LossDialog deal={pending.deal} stage={pending.stage} onClose={() => { onChanged(pending.deal); setPending(null); }}
          onConfirm={async (reasonId, note) => { const p = pending; setPending(null); await move(p.deal, p.stage.id, { loss_reason_id: reasonId, loss_note: note || null }); }} />
  ) : null;

  return { move, dialogs };
}

function WinDialog({ deal, stage, onClose, onDone }: { deal: Deal; stage: Stage; onClose: () => void; onDone: (d: Deal) => void }) {
  const { tenantId, access, notify } = useCrm();
  const [mode, setMode] = useState<"sale" | "later">(access.finance ? "sale" : "later");
  const [value, setValue] = useState(String(deal.value || ""));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [evidence, setEvidence] = useState("payment");
  const [method, setMethod] = useState("");
  const [installments, setInstallments] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const amount = parseMoney(value);
      if (mode === "sale" && amount <= 0) { notify("Informe o valor da venda."); setBusy(false); return; }
      const updated = await api.updateDeal(deal.id, { stage_id: stage.id, value: mode === "sale" ? amount : deal.value });
      if (mode === "sale") {
        const orderDate = new Date(`${date}T12:00:00`).toISOString();
        if (deal.tracking_session_id) {
          // fluxo auditado do IDX: Purchase CAPI com event_id determinístico (sem duplicar)
          await api.callLegacyCrm({ action: "update_stage", session_id: deal.tracking_session_id, status: "sold", revenue: amount, note: note || undefined });
          const orders = await api.loadOrders({ tenantId, dealId: deal.id, limit: 5 });
          const mirror = orders.find((o) => o.source === "legacy_tracking");
          if (mirror) {
            await api.updateOrder(mirror.id, {
              evidence_type: evidence, evidence_note: note || null, payment_method: method || null, installments: Number(installments) || 1,
              order_date: orderDate, status: evidence === "payment" ? "paid" : "confirmed",
            });
          }
        } else {
          await api.createOrder({
            tenant_id: tenantId, deal_id: deal.id, contact_id: deal.contact_id, company_id: deal.company_id, owner_id: deal.owner_id,
            order_date: orderDate, status: evidence === "payment" ? "paid" : "confirmed", gross_amount: amount,
            evidence_type: evidence, evidence_note: note || null, payment_method: method || null,
            installments: Number(installments) || 1, source: "deal", source_ref: deal.id,
          });
        }
      }
      notify(mode === "sale" ? `Venda de ${brl(amount)} registrada` : "Negociação marcada como ganha — registre a venda quando houver evidência.");
      onDone({ ...deal, ...updated, stage_name: stage.name, stage_kind: "won", days_in_stage: 0 });
    } catch (e) {
      notify(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={<><Trophy size={18} /> Ganhar “{deal.title}”</>} width={540}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" onClick={submit} disabled={busy}>{busy ? "Salvando…" : mode === "sale" ? "Registrar venda" : "Marcar como ganha"}</button>
      </>}>
      <Segmented value={mode} onChange={setMode} options={[
        { value: "sale", label: "Registrar venda agora" },
        { value: "later", label: "Ganha, venda ainda sem evidência" },
      ]} />
      {mode === "sale" ? (
        <div className="crm-form-grid">
          <Field label="Valor da venda (R$)"><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" /></Field>
          <Field label="Data da venda"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Evidência da venda" hint="Somente vendas com evidência entram na receita e no RFV.">
            <select value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              {["payment", "contract", "invoice", "pos", "manual_confirmation"].map((k) => <option key={k} value={k}>{evidenceLabels[k]}</option>)}
            </select>
          </Field>
          <Field label="Forma de pagamento"><input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Pix, cartão, boleto…" /></Field>
          <Field label="Parcelas" hint="Parcelas contam como uma única compra."><input type="number" min={1} max={120} value={installments} onChange={(e) => setInstallments(e.target.value)} /></Field>
          <Field label="Observação" span={2}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: comprovante Pix enviado pelo WhatsApp" /></Field>
          {deal.tracking_session_id && <p className="crm-note span-2">Este lead veio de um Smart Link. A venda segue o fluxo oficial do IDX e o evento Purchase é enviado ao Meta (quando configurado) sem duplicidade.</p>}
        </div>
      ) : (
        <p className="crm-note">{access.finance ? "A negociação fica como ganha, mas não entra na receita até uma venda ser registrada com evidência. Ela aparecerá em “Ganhas sem venda registrada”." : "Seu perfil não registra vendas. A negociação fica como ganha e um gestor pode registrar a venda depois."}</p>
      )}
    </Modal>
  );
}

function LossDialog({ deal, stage, onClose, onConfirm }: { deal: Deal; stage: Stage; onClose: () => void; onConfirm: (reasonId: string, note: string) => void }) {
  const { lossReasons } = useCrm();
  const preferred = stage.legacy_status === "bad" ? lossReasons.find((r) => /ruim/i.test(r.name))?.id : "";
  const [reason, setReason] = useState(preferred ?? "");
  const [note, setNote] = useState("");
  return (
    <Modal open onClose={onClose} title={`Mover para “${stage.name}”`} width={460}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn danger" disabled={!reason} onClick={() => onConfirm(reason, note)}>Confirmar perda</button>
      </>}>
      <div className="crm-form-grid one">
        <Field label="Motivo da perda">
          <div className="crm-chip-choices">
            {lossReasons.map((r) => (
              <button type="button" key={r.id} className={reason === r.id ? "on" : ""} onClick={() => setReason(r.id)}>{r.name}</button>
            ))}
          </div>
        </Field>
        <Field label="Detalhes (opcional)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`O que aconteceu com ${deal.contact_name ?? "o cliente"}?`} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tela de negociações
// ---------------------------------------------------------------------------
type Sort = { key: keyof Deal; asc: boolean };

export function DealsView() {
  const { tenantId, pipelines, stages, settings, members, userId, access, refreshKey, openDeal, quickCreate, notify, memberLabel } = useCrm();
  const [pipelineId, setPipelineId] = useState(settings?.default_pipeline_id ?? pipelines[0]?.id ?? "");
  const [mode, setMode] = useState<"board" | "list">(() => (localStorage.getItem("crm.deals.mode") as "board" | "list") || "board");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState<string>(access.role === "sales" ? userId : "");
  const [source, setSource] = useState("");
  const [quick, setQuick] = useState<"all" | "rotting" | "no_next" | "closing" | "hot">("all");
  const [showClosed, setShowClosed] = useState(true);
  const [sort, setSort] = useState<Sort>({ key: "updated_at", asc: false });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { try { localStorage.setItem("crm.deals.mode", mode); } catch { /* sem storage */ } }, [mode]);

  const load = useCallback(async () => {
    if (!pipelineId) return;
    try {
      setDeals(await api.loadDeals(tenantId, { pipelineId, ownerId: owner || null, search: search.trim() || undefined, source: source || undefined }));
    } catch (e) {
      notify(errorText(e));
      setDeals([]);
    }
  }, [tenantId, pipelineId, owner, search, source, notify]);

  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, refreshKey, search]);

  const onChanged = useCallback((d: Deal) => setDeals((list) => (list ?? []).map((x) => (x.id === d.id ? { ...x, ...d } : x))), []);
  const { move, dialogs } = useStageMover(onChanged);

  const pipelineStages = useMemo(() => stages.filter((s) => s.pipeline_id === pipelineId).sort((a, b) => a.position - b.position), [stages, pipelineId]);
  const in14 = Date.now() + 14 * 86400000;
  const visible = useMemo(() => (deals ?? []).filter((d) => {
    if (!showClosed && d.status !== "open") return false;
    if (quick === "rotting") return d.is_rotting;
    if (quick === "no_next") return d.status === "open" && !d.next_activity_at;
    if (quick === "closing") return d.status === "open" && d.expected_close_date && new Date(d.expected_close_date).getTime() <= in14;
    if (quick === "hot") return d.status === "open" && ((d.effective_probability ?? 0) >= 60 || d.priority === "urgent" || d.priority === "high");
    return true;
  }), [deals, quick, showClosed, in14]);

  const open = (deals ?? []).filter((d) => d.status === "open");
  const totals = {
    count: open.length,
    value: open.reduce((s, d) => s + Number(d.value), 0),
    weighted: open.reduce((s, d) => s + Number(d.weighted_value ?? 0), 0),
    rotting: open.filter((d) => d.is_rotting).length,
    noNext: open.filter((d) => !d.next_activity_at).length,
  };
  const sources = Array.from(new Set((deals ?? []).map((d) => d.source_channel).filter(Boolean))) as string[];

  function onDrop(stageId: string) {
    const d = (deals ?? []).find((x) => x.id === dragId);
    setDragId(null); setOverStage(null);
    if (!d || d.stage_id === stageId) return;
    const st = stages.find((s) => s.id === stageId);
    // otimista
    setDeals((list) => (list ?? []).map((x) => (x.id === d.id ? { ...x, stage_id: stageId, stage_name: st?.name, days_in_stage: 0 } : x)));
    void move(d, stageId);
  }

  const sorted = useMemo(() => [...visible].sort((a, b) => {
    const va = a[sort.key] as unknown as string | number | null;
    const vb = b[sort.key] as unknown as string | number | null;
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (va > vb ? 1 : -1) * (sort.asc ? 1 : -1);
  }), [visible, sort]);

  function exportCsv() {
    downloadCsv(`negociacoes-${new Date().toISOString().slice(0, 10)}.csv`, sorted.map((d) => ({
      negociacao: d.title, contato: d.contact_name ?? "", telefone: d.contact_phone ?? "", empresa: d.company_name ?? "", etapa: d.stage_name ?? "",
      status: d.status, valor: d.value, probabilidade: d.effective_probability ?? "", responsavel: d.owner_email ?? "",
      fechamento_previsto: d.expected_close_date ?? "", origem: d.source_channel ?? "", base_atribuicao: d.attribution_basis,
      utm_campaign: d.utm_campaign ?? "", criada_em: d.created_at, proxima_atividade: d.next_activity_at ?? "",
    })));
  }

  const th = (key: keyof Deal, label: string) => (
    <th><button type="button" className="crm-th" onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>{label}{sort.key === key && <ArrowDownUp size={12} />}</button></th>
  );

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          {pipelines.length > 1 && (
            <select className="crm-select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Funil">
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <div className="crm-search">
            <Search size={16} />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar negociação, contato, telefone…" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label="Limpar"><X size={14} /></button>}
          </div>
          <select className="crm-select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsável">
            <option value="">Todos os responsáveis</option>
            <option value={userId}>Minhas negociações</option>
            <option value="none">Sem responsável</option>
            {members.filter((m) => m.user_id !== userId).map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
          </select>
          {sources.length > 0 && (
            <select className="crm-select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origem">
              <option value="">Todas as origens</option>
              {sources.map((s) => <option key={s} value={s}>{channelLabel(s)}</option>)}
            </select>
          )}
        </div>
        <div className="crm-toolbar-right">
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "board", label: <><KanbanSquare size={15} /> Funil</> }, { value: "list", label: <><List size={15} /> Lista</> }]} />
          {access.export && <button type="button" className="crm-btn ghost sm" onClick={exportCsv}><Download size={15} /> Exportar</button>}
          {access.write && <button type="button" className="crm-btn primary" onClick={() => quickCreate("deal", { pipeline_id: pipelineId })}><Plus size={16} /> Nova negociação</button>}
        </div>
      </div>

      <div className="crm-summary">
        <div><span>Abertas</span><strong>{totals.count}</strong></div>
        <div><span>Em negociação</span><strong>{brl(totals.value, true)}</strong></div>
        <div title="Σ valor × probabilidade da etapa"><span>Ponderado</span><strong>{brl(totals.weighted, true)}</strong></div>
        <div className="chips">
          <Filter size={14} />
          {([
            ["all", "Todas"], ["hot", "Quentes"], ["closing", "Fecham em 14 dias"], ["no_next", `Sem próxima ação (${totals.noNext})`], ["rotting", `Paradas (${totals.rotting})`],
          ] as const).map(([k, l]) => (
            <button key={k} type="button" className={`crm-chip${quick === k ? " on" : ""}${k === "rotting" && totals.rotting ? " warn" : ""}`} onClick={() => setQuick(k)}>{l}</button>
          ))}
          <label className="crm-check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Ganhas/perdidas recentes</label>
        </div>
      </div>

      {deals === null ? <Skeleton rows={6} height={64} /> : mode === "board" ? (
        <div className="crm-board" onDragEnd={() => { setDragId(null); setOverStage(null); }}>
          {pipelineStages.filter((s) => showClosed || s.kind === "open").map((st) => {
            const cards = visible.filter((d) => d.stage_id === st.id);
            const sum = cards.reduce((s, d) => s + Number(d.value), 0);
            return (
              <section key={st.id} className={`crm-col kind-${st.kind}${overStage === st.id ? " over" : ""}`}
                onDragOver={(e) => { if (dragId && access.write) { e.preventDefault(); setOverStage(st.id); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null); }}
                onDrop={(e) => { e.preventDefault(); onDrop(st.id); }}>
                <header className="crm-col-head" title={st.entry_criteria ?? ""}>
                  <span className="dot" style={{ background: st.color ?? "#94a3b8" }} />
                  <strong>{st.name}</strong>
                  <em>{cards.length}</em>
                  <span className="sum">{brl(sum, true)}</span>
                  {st.kind === "open" && <span className="prob">{st.probability}%</span>}
                </header>
                <div className="crm-col-body">
                  {cards.map((d) => (
                    <DealCard key={d.id} deal={d} dragging={dragId === d.id} draggable={access.write}
                      onDragStart={() => setDragId(d.id)} onOpen={() => openDeal(d.id)} memberLabel={memberLabel} />
                  ))}
                  {cards.length === 0 && <div className="crm-col-empty">{dragId ? "Solte aqui" : st.kind === "open" ? "Nenhuma negociação" : "—"}</div>}
                  {access.write && st.kind === "open" && (
                    <button type="button" className="crm-col-add" onClick={() => quickCreate("deal", { pipeline_id: pipelineId, stage_id: st.id })}><Plus size={14} /> Adicionar</button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : sorted.length === 0 ? (
        <Empty icon={<KanbanSquare />} title="Nenhuma negociação encontrada" text="Ajuste os filtros ou crie uma nova negociação." />
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr>
              {th("title", "Negociação")}{th("contact_name", "Contato")}{th("stage_position", "Etapa")}{th("value", "Valor")}
              {th("owner_email", "Responsável")}{th("next_activity_at", "Próxima atividade")}{th("expected_close_date", "Fechamento")}
              {th("source_channel", "Origem")}{th("days_in_stage", "Na etapa")}
            </tr></thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={d.id} onClick={() => openDeal(d.id)} className={d.is_rotting ? "rotting" : ""}>
                  <td><strong>{d.title}</strong>{d.company_name && <small>{d.company_name}</small>}</td>
                  <td>{d.contact_name ?? <span className="crm-muted">—</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select className="crm-inline-select" value={d.stage_id} disabled={!access.write} onChange={(e) => { const sid = e.target.value; setDeals((l) => (l ?? []).map((x) => x.id === d.id ? { ...x, stage_id: sid } : x)); void move(d, sid); }}>
                      {pipelineStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td className="num">{brl(d.value)}</td>
                  <td>{d.owner_id ? memberLabel(d.owner_id) : <span className="crm-muted">—</span>}</td>
                  <td><NextActivity deal={d} /></td>
                  <td>{shortDate(d.expected_close_date)}</td>
                  <td>{d.source_channel ? channelLabel(d.source_channel) : <span className="crm-muted">—</span>}</td>
                  <td>{d.days_in_stage ?? 0} d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function NextActivity({ deal }: { deal: Deal }) {
  if (deal.status !== "open") return <span className="crm-muted">—</span>;
  if (!deal.next_activity_at) return <span className="crm-next none"><AlertTriangle size={13} /> Sem próxima ação</span>;
  const st = dueState(deal.next_activity_at);
  return (
    <span className={`crm-next ${st}`}>
      <CalendarClock size={13} />
      {deal.next_task_type ? `${taskTypeLabels[deal.next_task_type as keyof typeof taskTypeLabels] ?? ""} · ` : ""}{relative(deal.next_activity_at)}
    </span>
  );
}

export function DealCard({ deal, onOpen, onDragStart, dragging, draggable, memberLabel }: {
  deal: Deal; onOpen: () => void; onDragStart?: () => void; dragging?: boolean; draggable?: boolean; memberLabel: (id: string | null | undefined) => string;
}) {
  const closeSoon = deal.status === "open" && deal.expected_close_date && new Date(deal.expected_close_date).getTime() < Date.now() + 7 * 86400000;
  return (
    <article className={`crm-card${dragging ? " dragging" : ""}${deal.is_rotting ? " rotting" : ""} prio-${deal.priority} status-${deal.status}`}
      draggable={draggable} onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", deal.id); onDragStart?.(); }}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }} tabIndex={0} role="button" aria-label={`Abrir ${deal.title}`}>
      <div className="crm-card-top">
        <strong className="crm-card-title">{deal.title}</strong>
        {(deal.priority === "urgent" || deal.priority === "high") && <span className={`crm-prio ${deal.priority}`} title={`Prioridade ${priorityLabels[deal.priority]}`}><Flame size={13} /></span>}
      </div>
      {(deal.contact_name || deal.company_name) && (
        <div className="crm-card-contact">{deal.contact_name}{deal.contact_name && deal.company_name ? " · " : ""}{deal.company_name}</div>
      )}
      <div className="crm-card-mid">
        <span className="crm-card-value">{brl(deal.value)}</span>
        {deal.source_channel && <Pill tone={deal.attribution_basis === "known" ? "info" : "muted"} title={deal.attribution_basis === "known" ? "Origem comprovada por rastreamento" : "Origem não comprovada"}>{channelLabel(deal.source_channel)}</Pill>}
        {deal.is_click_only && <Pill tone="muted" title="Clique no Smart Link sem contato identificado ainda">Só clique</Pill>}
        {deal.pending_orders ? <Pill tone="amber" title="Venda declarada aguardando confirmação">Venda pendente</Pill> : null}
      </div>
      <div className="crm-card-foot">
        <NextActivity deal={deal} />
        <span className="crm-card-meta">
          {(deal.unread_count ?? 0) > 0 && <span className="crm-unread" title="Mensagens não lidas no WhatsApp"><MessageCircle size={12} />{deal.unread_count}</span>}
          {closeSoon && <span className="crm-close-soon" title="Fechamento previsto">{shortDate(deal.expected_close_date)}</span>}
          <span title="Tempo na etapa" className={deal.is_rotting ? "warn" : ""}><Clock size={12} />{deal.days_in_stage ?? 0}d</span>
          <Avatar name={deal.owner_id ? memberLabel(deal.owner_id) : null} size={22} tone={deal.owner_id ? undefined : "#f1f5f9"} />
        </span>
      </div>
    </article>
  );
}

export function StagePicker({ deal, onMove }: { deal: Deal; onMove: (stageId: string) => void }) {
  const { stages, access } = useCrm();
  const list = stages.filter((s) => s.pipeline_id === deal.pipeline_id).sort((a, b) => a.position - b.position);
  const idx = list.findIndex((s) => s.id === deal.stage_id);
  return (
    <div className="crm-stagebar" role="group" aria-label="Etapa">
      {list.filter((s) => s.kind === "open").map((s) => {
        const pos = list.findIndex((x) => x.id === s.id);
        return (
          <button key={s.id} type="button" disabled={!access.write} className={`${s.id === deal.stage_id ? "current" : ""}${deal.status === "open" && pos < idx ? " done" : ""}`}
            onClick={() => onMove(s.id)} title={s.entry_criteria ?? s.name}>
            <span>{s.name}</span>
          </button>
        );
      })}
      <span className="crm-stagebar-end">
        {list.filter((s) => s.kind !== "open").map((s) => (
          <button key={s.id} type="button" disabled={!access.write} className={`end ${s.kind}${s.id === deal.stage_id ? " current" : ""}`} onClick={() => onMove(s.id)}>
            {s.kind === "won" ? <Trophy size={14} /> : <X size={14} />} {s.name}
          </button>
        ))}
      </span>
      <ChevronDown size={0} />
    </div>
  );
}

export { emailName };
