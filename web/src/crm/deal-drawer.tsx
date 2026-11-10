import { useCallback, useEffect, useState } from "react";
import { Archive, Building2, ExternalLink, FileText, Mail, MessageCircle, Phone, Plus, Send, Trash2, User, XCircle } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { basisLabels, brl, channelLabel, dateTime, emailName, errorText, parseMoney, phoneLabel, priorityLabels, shortDate, waLink } from "./format";
import type { Deal, DealItem, Priority, Quote } from "./types";
import { Confirm, Drawer, Empty, Field, Pill, Skeleton, Tabs } from "./ui";
import { StagePicker, useStageMover } from "./deals";
import { OrdersPanel, TaskList, Timeline, WhatsAppThread } from "./records";

type Tab = "activity" | "timeline" | "products" | "sales" | "whatsapp";

export function DealDrawer({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const { tenantId, access, members, notify, refresh, openContact, refreshKey, memberLabel, lossReasons } = useCrm();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api.getDeal(dealId);
      setDeal(d);
      setTitle(d?.title ?? "");
    } catch (e) { notify(errorText(e)); }
  }, [dealId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const { move, dialogs } = useStageMover((d) => { setDeal((x) => (x ? { ...x, ...d } : x)); refresh(); void load(); });

  async function patch(p: Partial<Deal>, msg = "Salvo") {
    if (!deal) return;
    try { const u = await api.updateDeal(deal.id, p); setDeal({ ...deal, ...u }); notify(msg); refresh(); } catch (e) { notify(errorText(e)); }
  }

  if (!deal) {
    return <Drawer open onClose={onClose} title="Carregando…"><Skeleton rows={6} /></Drawer>;
  }

  const basis = basisLabels[deal.attribution_basis] ?? basisLabels.unknown;
  const loss = lossReasons.find((r) => r.id === deal.loss_reason_id);

  return (
    <Drawer open onClose={onClose} width={720}
      title={access.write
        ? <input className="crm-title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== deal.title && patch({ title: title.trim() }, "Título atualizado")} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label="Título da negociação" />
        : deal.title}
      subtitle={<>
        <Pill tone={deal.status === "won" ? "green" : deal.status === "lost" ? "red" : "info"}>{deal.status === "won" ? "Ganha" : deal.status === "lost" ? "Perdida" : deal.stage_name}</Pill>
        <span>{deal.pipeline_name}</span>
        <span>· criada {shortDate(deal.created_at)}</span>
        {deal.days_in_stage !== undefined && deal.status === "open" && <span className={deal.is_rotting ? "warn" : ""}>· {deal.days_in_stage} dias na etapa</span>}
      </>}
      actions={access.delete ? <>
        {!deal.archived_at && <button type="button" className="crm-icon-btn" title="Arquivar" onClick={() => patch({ archived_at: new Date().toISOString() } as Partial<Deal>, "Negociação arquivada").then(onClose)}><Archive size={17} /></button>}
        <button type="button" className="crm-icon-btn" title="Excluir" onClick={() => setConfirmDelete(true)}><Trash2 size={17} /></button>
      </> : null}>
      <StagePicker deal={deal} onMove={(sid) => move(deal, sid)} />
      {deal.status === "lost" && (loss || deal.loss_note) && <div className="crm-callout danger"><XCircle size={16} /> Perdida: <strong>{loss?.name}</strong> {deal.loss_note && `— ${deal.loss_note}`}</div>}
      {deal.status === "won" && !deal.valid_orders && <div className="crm-callout warn">Ganha sem venda registrada. Registre a venda com evidência na aba <button type="button" className="crm-link" onClick={() => setTab("sales")}>Vendas</button> para entrar na receita.</div>}

      <div className="crm-deal-grid">
        <Field label="Valor (R$)">
          <input inputMode="decimal" defaultValue={deal.value ? String(deal.value).replace(".", ",") : ""} disabled={!access.write}
            onBlur={(e) => { const v = parseMoney(e.target.value); if (v !== Number(deal.value)) void patch({ value: v }, "Valor atualizado"); }} />
        </Field>
        <Field label="Responsável">
          <select value={deal.owner_id ?? ""} disabled={!access.write} onChange={(e) => patch({ owner_id: e.target.value || null }, "Responsável atualizado")}>
            <option value="">Sem responsável</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
          </select>
        </Field>
        <Field label="Fechamento previsto">
          <input type="date" value={deal.expected_close_date ?? ""} disabled={!access.write} onChange={(e) => patch({ expected_close_date: e.target.value || null }, "Data atualizada")} />
        </Field>
        <Field label="Prioridade">
          <select value={deal.priority} disabled={!access.write} onChange={(e) => patch({ priority: e.target.value as Priority }, "Prioridade atualizada")}>
            {(["low", "normal", "high", "urgent"] as Priority[]).map((p) => <option key={p} value={p}>{priorityLabels[p]}</option>)}
          </select>
        </Field>
        <Field label={`Probabilidade (etapa: ${deal.stage_probability ?? 0}%)`}>
          <input type="number" min={0} max={100} placeholder={`${deal.stage_probability ?? 0}`} defaultValue={deal.probability ?? ""} disabled={!access.write}
            onBlur={(e) => { const v = e.target.value === "" ? null : Math.min(100, Math.max(0, Number(e.target.value))); if (v !== deal.probability) void patch({ probability: v }, "Probabilidade atualizada"); }} />
        </Field>
        <div className="crm-field"><span>Ponderado</span><strong className="crm-big">{brl(deal.weighted_value)}</strong></div>
      </div>

      <div className="crm-two">
        <section className="crm-box">
          <h4><User size={15} /> Contato</h4>
          {deal.contact_id ? (
            <div className="crm-contact-mini">
              <button type="button" className="crm-link strong" onClick={() => openContact(deal.contact_id!)}>{deal.contact_name ?? phoneLabel(deal.contact_phone) ?? "Contato"}</button>
              {deal.company_name && <span><Building2 size={13} /> {deal.company_name}</span>}
              {deal.contact_phone && (
                <span className="crm-row gap">
                  <a href={`tel:+${deal.contact_phone}`}><Phone size={13} /> {phoneLabel(deal.contact_phone)}</a>
                  {!deal.do_not_contact && <a href={waLink(deal.contact_phone)!} target="_blank" rel="noreferrer" className="crm-wa-link"><MessageCircle size={13} /> WhatsApp</a>}
                </span>
              )}
              {deal.contact_email && <a href={`mailto:${deal.contact_email}`}><Mail size={13} /> {deal.contact_email}</a>}
              {deal.do_not_contact && <Pill tone="red">Não contatar</Pill>}
            </div>
          ) : <LinkContact deal={deal} onLinked={load} />}
        </section>
        <section className="crm-box">
          <h4>Origem da aquisição</h4>
          <div className="crm-source">
            <strong>{channelLabel(deal.source_channel)}</strong>
            <Pill tone={deal.attribution_basis === "known" ? "green" : deal.attribution_basis === "unknown" ? "muted" : "amber"} title={basis.hint}>{basis.label}</Pill>
            {deal.utm_campaign && <span>Campanha: <b>{deal.utm_campaign}</b></span>}
            {(deal.utm_source || deal.utm_medium) && <span>{[deal.utm_source, deal.utm_medium].filter(Boolean).join(" / ")}</span>}
            {deal.utm_content && <span>Anúncio/conteúdo: {deal.utm_content}</span>}
            {deal.ad_ids?.ref && <span className="crm-muted small">Ref. Smart Link: {deal.ad_ids.ref}</span>}
            {!deal.source_channel && <span className="crm-muted small">Sem evidência de origem. Não atribuímos campanha sem dados.</span>}
          </div>
        </section>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "activity", label: "Próximas ações" },
        { value: "timeline", label: "Histórico" },
        { value: "products", label: "Produtos e propostas" },
        { value: "sales", label: "Vendas", count: deal.valid_orders || undefined },
        { value: "whatsapp", label: "WhatsApp", count: deal.unread_count || undefined },
      ]} />
      <div className="crm-tab-body">
        {tab === "activity" && <TaskList dealId={deal.id} />}
        {tab === "timeline" && <Timeline dealId={deal.id} contactId={undefined} />}
        {tab === "products" && <DealProducts deal={deal} onValue={(v) => patch({ value: v }, "Valor atualizado pelos produtos")} />}
        {tab === "sales" && <OrdersPanel dealId={deal.id} contactId={deal.contact_id} companyId={deal.company_id} />}
        {tab === "whatsapp" && <WhatsAppThread conversationId={deal.conversation_id} />}
      </div>
      <p className="crm-muted small">Responsável: {memberLabel(deal.owner_id)} · Atualizada {dateTime(deal.updated_at)}</p>

      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} danger title="Excluir negociação?"
        text="A negociação e suas tarefas serão excluídas. Vendas registradas permanecem no histórico do contato. Prefira arquivar se tiver dúvida."
        confirmLabel="Excluir" onConfirm={async () => { try { await api.deleteDeal(deal.id); notify("Negociação excluída"); refresh(); onClose(); } catch (e) { notify(errorText(e)); } }} />
      {dialogs}
      <span hidden>{tenantId}</span>
    </Drawer>
  );
}

function LinkContact({ deal, onLinked }: { deal: Deal; onLinked: () => void }) {
  const { tenantId, notify, quickCreate } = useCrm();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ id: string; name: string | null; phone: string | null }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(() => api.globalSearch(tenantId, q).then((r) => setRes(r.contacts)).catch(() => setRes([])), 250);
    return () => clearTimeout(t);
  }, [q, tenantId]);
  return (
    <div className="crm-stack tight">
      <span className="crm-muted small">Nenhum contato vinculado{deal.is_click_only ? " (clique no Smart Link sem identificação)" : ""}.</span>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar contato para vincular…" />
      {res.map((c) => (
        <button key={c.id} type="button" className="crm-result" onClick={async () => { try { await api.updateDeal(deal.id, { contact_id: c.id }); notify("Contato vinculado"); onLinked(); } catch (e) { notify(errorText(e)); } }}>
          {c.name ?? phoneLabel(c.phone)} <small>{phoneLabel(c.phone)}</small>
        </button>
      ))}
      <button type="button" className="crm-btn ghost xs self-start" onClick={() => quickCreate("contact", { link_deal_id: deal.id })}><Plus size={13} /> Criar contato</button>
    </div>
  );
}

function DealProducts({ deal, onValue }: { deal: Deal; onValue: (v: number) => void }) {
  const { tenantId, offers, access, notify } = useCrm();
  const [items, setItems] = useState<DealItem[] | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [validUntil, setValidUntil] = useState(() => new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10));
  const [terms, setTerms] = useState("");
  const load = useCallback(async () => {
    try { const [i, q] = await Promise.all([api.loadDealItems(deal.id), api.loadQuotes(deal.id)]); setItems(i); setQuotes(q); } catch (e) { notify(errorText(e)); setItems([]); }
  }, [deal.id, notify]);
  useEffect(() => { void load(); }, [load]);
  const total = (items ?? []).reduce((s, i) => s + Number(i.total), 0);

  async function add(offerId: string) {
    const o = offers.find((x) => x.id === offerId);
    if (!o) return;
    try { await api.addDealItem({ tenant_id: tenantId, deal_id: deal.id, offer_id: o.id, name: o.name, quantity: 1, unit_price: Number(o.price ?? 0), discount: 0 }); await load(); } catch (e) { notify(errorText(e)); }
  }

  async function makeQuote() {
    if (!items?.length) { notify("Adicione produtos antes de gerar a proposta."); return; }
    try { await api.createQuote(tenantId, deal.id, items, validUntil, terms); notify("Proposta criada"); await load(); } catch (e) { notify(errorText(e)); }
  }

  async function setQuoteStatus(q: Quote, status: Quote["status"]) {
    try {
      await api.updateQuote(q.id, { status, ...(status === "sent" ? { sent_at: new Date().toISOString() } : { decided_at: new Date().toISOString() }) });
      notify(status === "sent" ? "Proposta marcada como enviada" : status === "accepted" ? "Proposta aceita" : "Proposta atualizada");
      await load();
    } catch (e) { notify(errorText(e)); }
  }

  if (items === null) return <Skeleton rows={2} />;
  return (
    <div className="crm-stack">
      {access.write && (
        <select value="" onChange={(e) => add(e.target.value)} aria-label="Adicionar produto">
          <option value="">+ Adicionar produto ou serviço do catálogo…</option>
          {offers.filter((o) => o.status === "active").map((o) => <option key={o.id} value={o.id}>{o.name}{o.price ? ` — ${brl(o.price)}` : ""}</option>)}
        </select>
      )}
      {items.length === 0 ? <Empty title="Sem produtos" text="Associe itens do catálogo para montar orçamento e proposta." /> : (
        <div className="crm-items">
          {items.map((i) => (
            <div key={i.id} className="crm-item-row view">
              <span>{i.name}</span><span>{i.quantity}×</span><span>{brl(i.unit_price)}</span>{i.discount > 0 ? <span>−{brl(i.discount)}</span> : <span />}
              <strong>{brl(i.total)}</strong>
              {access.write && <button type="button" className="crm-icon-btn" onClick={async () => { await api.removeDealItem(i.id); await load(); }} aria-label="Remover"><XCircle size={15} /></button>}
            </div>
          ))}
          <div className="crm-item-total">
            Total: <strong>{brl(total)}</strong>
            {access.write && total !== Number(deal.value) && <button type="button" className="crm-btn ghost xs" onClick={() => onValue(total)}>Usar como valor da negociação</button>}
          </div>
        </div>
      )}
      <h4 className="crm-subhead"><FileText size={14} /> Propostas</h4>
      {access.write && items.length > 0 && (
        <div className="crm-row gap wrap">
          <Field label="Validade"><input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
          <Field label="Condições"><input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Pagamento em até 3x…" /></Field>
          <button type="button" className="crm-btn primary sm self-end" onClick={makeQuote}><Plus size={14} /> Gerar proposta</button>
        </div>
      )}
      {quotes.map((q) => (
        <div key={q.id} className="crm-quote">
          <div><strong>Proposta #{q.number}</strong> · {brl(q.total)} <small className="crm-muted">· válida até {shortDate(q.valid_until)}</small></div>
          <div className="crm-row gap">
            <Pill tone={q.status === "accepted" ? "green" : q.status === "rejected" ? "red" : q.status === "sent" ? "info" : "muted"}>
              {{ draft: "Rascunho", sent: "Enviada", accepted: "Aceita", rejected: "Recusada", expired: "Expirada" }[q.status]}
            </Pill>
            {access.write && q.status === "draft" && <button type="button" className="crm-btn ghost xs" onClick={() => setQuoteStatus(q, "sent")}><Send size={12} /> Marcar enviada</button>}
            {access.write && q.status === "sent" && <>
              <button type="button" className="crm-btn ghost xs" onClick={() => setQuoteStatus(q, "accepted")}>Aceita</button>
              <button type="button" className="crm-btn ghost xs" onClick={() => setQuoteStatus(q, "rejected")}>Recusada</button>
            </>}
            <button type="button" className="crm-btn ghost xs" onClick={() => printQuote(q, deal)}><ExternalLink size={12} /> Ver/Imprimir</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function printQuote(q: Quote, deal: Deal) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  const rows = q.items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${i.quantity}</td><td>${brl(i.unit_price)}</td><td>${i.discount ? brl(i.discount) : "-"}</td><td>${brl(i.total)}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Proposta #${q.number}</title>
  <style>body{font-family:Inter,system-ui,sans-serif;padding:40px;color:#111}h1{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{border-bottom:1px solid #e5e7eb;padding:10px;text-align:left}th{font-size:12px;text-transform:uppercase;color:#64748b}.t{text-align:right;font-size:20px}</style></head>
  <body><h1>Proposta #${q.number}</h1><p>${escapeHtml(deal.contact_name ?? "")} ${deal.company_name ? "· " + escapeHtml(deal.company_name) : ""}</p>
  <p>Emitida em ${shortDate(q.created_at)} · válida até ${shortDate(q.valid_until)}</p>
  <table><thead><tr><th>Item</th><th>Qtd</th><th>Preço</th><th>Desconto</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="t">Total: <b>${brl(q.total)}</b></p>${q.terms ? `<p>${escapeHtml(q.terms)}</p>` : ""}<script>window.print()</script></body></html>`);
  w.document.close();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
