import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Gift, Package, Pencil, Plus, Search } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { brl, errorText, parseMoney, shortDate } from "./format";
import type { Offer, Sample } from "./types";
import { Empty, Field, Modal, Pill, Segmented, Skeleton, Stat, Tabs } from "./ui";
import { SampleModal } from "./contacts";
import { ContactPicker, type PickedContact } from "./workspace";

const intervals: Record<string, string> = { weekly: "Semanal", monthly: "Mensal", quarterly: "Trimestral", semiannual: "Semestral", yearly: "Anual" };

function slugify(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";
}

export function ProductsView() {
  const [tab, setTab] = useState<"catalog" | "samples">("catalog");
  return (
    <div className="crm-page">
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "catalog", label: "Catálogo" }, { value: "samples", label: "Amostras e experimentação" }]} />
      {tab === "catalog" ? <Catalog /> : <SamplesOverview />}
    </div>
  );
}

function Catalog() {
  const { tenantId, access, notify, reloadStructure } = useCrm();
  const [rows, setRows] = useState<Offer[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "product" | "service">("all");
  const [editing, setEditing] = useState<Partial<Offer> | null>(null);
  const load = useCallback(() => { api.loadOffers(tenantId, showArchived).then(setRows).catch((e) => { notify(errorText(e)); setRows([]); }); }, [tenantId, showArchived, notify]);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (rows ?? []).filter((o) => (kind === "all" || o.kind === kind) && (!search || `${o.name} ${o.category ?? ""} ${o.sku ?? ""}`.toLowerCase().includes(search.toLowerCase()))), [rows, kind, search]);

  async function archive(o: Offer) {
    try { await api.deleteOffer(o.id); notify("Item arquivado (o histórico de vendas é mantido)"); load(); void reloadStructure(); } catch (e) { notify(errorText(e)); }
  }

  return (
    <>
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <div className="crm-search"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, categoria ou SKU…" /></div>
          <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "all", label: "Todos" }, { value: "product", label: "Produtos" }, { value: "service", label: "Serviços" }]} />
          <label className="crm-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Mostrar arquivados</label>
        </div>
        <div className="crm-toolbar-right">{access.configure && <button type="button" className="crm-btn primary" onClick={() => setEditing({ kind: "product", status: "active" })}><Plus size={16} /> Novo item</button>}</div>
      </div>
      {rows === null ? <Skeleton rows={5} /> : shown.length === 0 ? (
        <Empty icon={<Package />} title="Catálogo vazio" text="Cadastre produtos e serviços para usá-los nas negociações, propostas e vendas. As ofertas dos Smart Links também aparecem aqui." />
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Item</th><th>Tipo</th><th>Categoria</th><th className="num">Preço</th><th className="num">Custo</th><th>Cobrança</th><th>Status</th><th /></tr></thead>
            <tbody>{shown.map((o) => (
              <tr key={o.id} className="static">
                <td><strong>{o.name}</strong>{(o.sku || o.description) && <small>{[o.sku, o.description].filter(Boolean).join(" · ")}</small>}</td>
                <td>{o.kind === "service" ? "Serviço" : "Produto"}</td>
                <td>{o.category ?? "—"}</td>
                <td className="num">{o.price !== null ? brl(o.price) : "—"}</td>
                <td className="num">{o.cost !== null ? brl(o.cost) : "—"}</td>
                <td>{o.is_recurring ? `Recorrente · ${intervals[o.billing_interval ?? ""] ?? "—"}` : "Avulsa"}</td>
                <td><Pill tone={o.status === "active" ? "green" : "muted"}>{o.status === "active" ? "Ativo" : o.status === "paused" ? "Pausado" : "Arquivado"}</Pill></td>
                <td className="actions">
                  {access.configure && <button type="button" className="crm-icon-btn" onClick={() => setEditing(o)} aria-label="Editar"><Pencil size={15} /></button>}
                  {access.configure && o.status !== "archived" && <button type="button" className="crm-icon-btn" onClick={() => archive(o)} aria-label="Arquivar"><Archive size={15} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <OfferModal offer={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); void reloadStructure(); }} />}
    </>
  );
}

function OfferModal({ offer, onClose, onSaved }: { offer: Partial<Offer>; onClose: () => void; onSaved: () => void }) {
  const { tenantId, notify } = useCrm();
  const [f, setF] = useState({
    name: offer.name ?? "", kind: offer.kind ?? "product", category: offer.category ?? "", price: offer.price != null ? String(offer.price).replace(".", ",") : "",
    cost: offer.cost != null ? String(offer.cost).replace(".", ",") : "", sku: offer.sku ?? "", description: offer.description ?? "", status: offer.status ?? "active",
    is_recurring: offer.is_recurring ?? false, billing_interval: offer.billing_interval ?? "monthly", commercial_terms: offer.commercial_terms ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    if (!f.name.trim()) { notify("Informe o nome."); return; }
    setBusy(true);
    try {
      await api.saveOffer({
        id: offer.id, tenant_id: tenantId, name: f.name.trim(), kind: f.kind as Offer["kind"], category: f.category.trim() || null,
        price: f.price.trim() ? parseMoney(f.price) : null, cost: f.cost.trim() ? parseMoney(f.cost) : null, sku: f.sku.trim() || null, description: f.description.trim() || null,
        status: f.status as Offer["status"], is_recurring: f.is_recurring, billing_interval: f.is_recurring ? f.billing_interval : null, commercial_terms: f.commercial_terms.trim() || null,
        ...(offer.id ? {} : { slug: `${slugify(f.name)}-${Math.random().toString(36).slice(2, 6)}` }),
      });
      notify(offer.id ? "Item atualizado" : "Item cadastrado");
      onSaved();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={offer.id ? "Editar item" : "Novo produto ou serviço"} width={600}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="product">Produto</option><option value="service">Serviço</option></select></Field>
        <Field label="Categoria"><input value={f.category} onChange={(e) => set("category", e.target.value)} /></Field>
        <Field label="Preço (R$)"><input inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} placeholder="0,00" /></Field>
        <Field label="Custo (R$)" hint="Opcional — permite calcular margem."><input inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></Field>
        <Field label="SKU / código"><input value={f.sku} onChange={(e) => set("sku", e.target.value)} /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set("status", e.target.value)}><option value="active">Ativo</option><option value="paused">Pausado</option><option value="archived">Arquivado</option></select></Field>
        <label className="crm-check span-2"><input type="checkbox" checked={f.is_recurring} onChange={(e) => set("is_recurring", e.target.checked)} /> Cobrança recorrente (assinatura, mensalidade, contrato)</label>
        {f.is_recurring && <Field label="Periodicidade"><select value={f.billing_interval} onChange={(e) => set("billing_interval", e.target.value)}>{Object.entries(intervals).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
        <Field label="Descrição" span={2}><textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
        <Field label="Condições comerciais" span={2}><textarea rows={2} value={f.commercial_terms} onChange={(e) => set("commercial_terms", e.target.value)} placeholder="Ex.: 10x sem juros; desconto à vista 5%" /></Field>
      </div>
    </Modal>
  );
}

function SamplesOverview() {
  const { tenantId, access, offers, refreshKey, notify, openContact } = useCrm();
  const [rows, setRows] = useState<Sample[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [contact, setContact] = useState<PickedContact>(null);
  const load = useCallback(() => { api.loadSamples(tenantId).then(setRows).catch((e) => { notify(errorText(e)); setRows([]); }); }, [tenantId, notify]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const stats = useMemo(() => {
    const list = rows ?? [];
    const contacts = new Set(list.map((s) => s.contact_id));
    const converted = new Set(list.filter((s) => s.first_purchase_after_at).map((s) => s.contact_id));
    const days = list.filter((s) => s.days_to_first_purchase != null).map((s) => Number(s.days_to_first_purchase));
    const byProduct = new Map<string, { n: number; conv: number; rev: number }>();
    for (const s of list) {
      const p = byProduct.get(s.product_name) ?? { n: 0, conv: 0, rev: 0 };
      p.n += 1; if (s.first_purchase_after_at) { p.conv += 1; p.rev += Number(s.revenue_after ?? 0); }
      byProduct.set(s.product_name, p);
    }
    return {
      delivered: list.length, contacts: contacts.size, converted: converted.size,
      rate: contacts.size ? (converted.size / contacts.size) * 100 : null,
      avgDays: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null,
      revenue: list.reduce((s, x) => s + Number(x.revenue_after ?? 0), 0),
      byProduct: [...byProduct.entries()].sort((a, b) => b[1].n - a[1].n),
    };
  }, [rows]);

  return (
    <>
      <div className="crm-toolbar">
        <p className="crm-muted small">Amostras são eventos de experimentação: <strong>não contam como compra</strong> e não afetam o RFV. A conversão considera a primeira compra válida após a amostra.</p>
        <div className="crm-toolbar-right">{access.write && <button type="button" className="crm-btn primary" onClick={() => setAdding(true)}><Gift size={16} /> Registrar amostra</button>}</div>
      </div>
      {rows === null ? <Skeleton rows={4} /> : rows.length === 0 ? (
        <Empty icon={<Gift />} title="Nenhuma amostra registrada" text="Registre amostras entregues para medir quantas viram a primeira compra e quanto geram de receita depois." />
      ) : (
        <>
          <div className="crm-stats">
            <Stat label="Amostras entregues" value={stats.delivered} sub={`${stats.contacts} pessoa(s)`} />
            <Stat label="Converteram em compra" value={stats.converted} sub={stats.rate !== null ? `${stats.rate.toFixed(1)}% das pessoas` : ""} tone="green" />
            <Stat label="Tempo até a 1ª compra" value={stats.avgDays !== null ? `${stats.avgDays.toFixed(0)} dias` : "—"} unavailable={stats.avgDays === null ? "Ainda sem conversões" : undefined} />
            <Stat label="Receita após experimentação" value={brl(stats.revenue)} />
          </div>
          <div className="crm-grid-2">
            <section className="crm-panel">
              <header><h3>Por produto experimentado</h3></header>
              <table className="crm-table compact">
                <thead><tr><th>Produto</th><th className="num">Amostras</th><th className="num">Conversões</th><th className="num">Receita</th></tr></thead>
                <tbody>{stats.byProduct.map(([name, p]) => <tr key={name} className="static"><td>{name}</td><td className="num">{p.n}</td><td className="num">{p.conv} ({p.n ? Math.round((p.conv / p.n) * 100) : 0}%)</td><td className="num">{brl(p.rev)}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="crm-panel">
              <header><h3>Últimas entregas</h3></header>
              <ul className="crm-list">
                {rows.slice(0, 15).map((s) => (
                  <li key={s.id}><button type="button" onClick={() => openContact(s.contact_id)}>
                    <span className="grow"><strong>{s.contact_name ?? "Contato"}</strong><small>{s.product_name} · {shortDate(s.delivered_at)}{s.campaign ? ` · ${s.campaign}` : ""}</small></span>
                    {s.first_purchase_after_at ? <Pill tone="green">Comprou</Pill> : <Pill tone="muted">Sem compra</Pill>}
                  </button></li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
      {adding && <SampleModal contactId={contact?.id ?? null} offers={offers} contactSlot={<ContactPicker value={contact} onChange={setContact} allowNew={false} />}
        onClose={() => { setAdding(false); setContact(null); }} onSaved={() => { setAdding(false); setContact(null); load(); notify("Amostra registrada"); }} />}
    </>
  );
}
