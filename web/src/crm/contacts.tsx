import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownUp, ArrowLeft, Building2, Download, ExternalLink, GitMerge, Mail, MapPin, MessageCircle, Pencil, Phone, Plus, Search, ShieldCheck, Tag, Upload, Users, X,
} from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import {
  basisLabels, brl, channelLabel, dateTime, emailName, errorText, lifecycleLabels, phoneLabel, relative, segmentInfo, shortDate, waLink,
} from "./format";
import type { Company, Contact, CustomField, Deal, Lifecycle, Onboarding, RfvSegment, Sample } from "./types";
import { Avatar, Drawer, Empty, Field, Modal, Pill, Skeleton, Tabs } from "./ui";
import { AiPanel, OrdersPanel, TaskList, Timeline, WhatsAppThread } from "./records";
import { downloadCsv } from "./csv";
import { CompanyModal } from "./workspace";

const lifecycles: Lifecycle[] = ["lead", "mql", "sal", "sql", "opportunity", "customer", "inactive"];

// ---------------------------------------------------------------------------
// Lista de contatos
// ---------------------------------------------------------------------------
export function ContactsView() {
  const { tenantId, userId, access, members, refreshKey, notify, openContact, quickCreate, navigate, memberLabel } = useCrm();
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [owner, setOwner] = useState("");
  const [source, setSource] = useState("");
  const [segment, setSegment] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: string; asc: boolean }>({ key: "created_at", asc: false });
  const pageSize = 50;

  const load = useCallback(async () => {
    try {
      const r = await api.loadContacts(tenantId, { search: search.trim() || undefined, lifecycle: lifecycle || undefined, ownerId: owner || null, source: source || undefined, segment: segment || undefined, tag: tag || undefined, page, pageSize, sort: sort.key, asc: sort.asc });
      setRows(r.rows); setTotal(r.total);
    } catch (e) { notify(errorText(e)); setRows([]); }
  }, [tenantId, search, lifecycle, owner, source, segment, tag, page, sort, notify]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, refreshKey, search]);
  useEffect(() => { setPage(0); }, [search, lifecycle, owner, source, segment, tag]);

  const filtersOn = [lifecycle, owner, source, segment, tag].filter(Boolean).length;

  async function exportAll() {
    try {
      const all: Contact[] = [];
      for (let p = 0; p < 40; p++) {
        const r = await api.loadContacts(tenantId, { search: search.trim() || undefined, lifecycle: lifecycle || undefined, ownerId: owner || null, source: source || undefined, segment: segment || undefined, tag: tag || undefined, page: p, pageSize: 500 });
        all.push(...r.rows);
        if (r.rows.length < 500) break;
      }
      downloadCsv(`contatos-${new Date().toISOString().slice(0, 10)}.csv`, all.map((c) => ({
        nome: c.name ?? "", telefone: c.phone ?? "", email: c.email ?? "", empresa: c.company_name ?? "", cargo: c.job_title ?? "", cidade: c.city ?? "", uf: c.state ?? "",
        ciclo_de_vida: lifecycleLabels[c.lifecycle_stage], origem: c.source_channel ?? "", base_da_origem: basisLabels[c.acquisition_basis]?.label ?? "", campanha: c.utm_campaign ?? c.acquisition_campaign ?? "",
        responsavel: c.owner_email ?? "", tags: (c.tags ?? []).join("|"), lead_score: c.lead_score, segmento_rfv: c.rfv_segment ? segmentInfo[c.rfv_segment].label : "",
        compras: c.purchase_count ?? 0, receita_liquida: c.net_revenue ?? 0, ultima_compra: c.last_purchase_at ?? "", consentimento: c.marketing_consent, criado_em: c.created_at,
      })));
      notify(`${all.length} contato(s) exportado(s)`);
    } catch (e) { notify(errorText(e)); }
  }

  const th = (key: string, label: string, cls = "") => (
    <th className={cls}><button type="button" className="crm-th" onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : key === "name" }))}>{label}{sort.key === key && <ArrowDownUp size={12} />}</button></th>
  );

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <div className="crm-search">
            <Search size={16} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, telefone, e-mail ou empresa…" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label="Limpar"><X size={14} /></button>}
          </div>
          <select className="crm-select" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} aria-label="Ciclo de vida">
            <option value="">Todo o ciclo de vida</option>
            {lifecycles.map((l) => <option key={l} value={l}>{lifecycleLabels[l]}</option>)}
          </select>
          <select className="crm-select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsável">
            <option value="">Todos os responsáveis</option>
            <option value={userId}>Meus contatos</option>
            <option value="none">Sem responsável</option>
            {members.filter((m) => m.user_id !== userId).map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
          </select>
          <select className="crm-select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origem">
            <option value="">Todas as origens</option>
            {["meta_ads", "google_ads", "whatsapp", "smart_link", "instagram", "site", "form", "referral", "outbound", "import", "manual"].map((s) => <option key={s} value={s}>{channelLabel(s)}</option>)}
          </select>
          <select className="crm-select" value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Segmento RFV">
            <option value="">Todos os segmentos RFV</option>
            {(Object.keys(segmentInfo) as RfvSegment[]).map((s) => <option key={s} value={s}>{segmentInfo[s].label}</option>)}
          </select>
          {tag && <button type="button" className="crm-chip on" onClick={() => setTag("")}><Tag size={12} /> {tag} <X size={12} /></button>}
          {filtersOn > 0 && <button type="button" className="crm-link small" onClick={() => { setLifecycle(""); setOwner(""); setSource(""); setSegment(""); setTag(""); }}>Limpar filtros</button>}
        </div>
        <div className="crm-toolbar-right">
          {access.write && <button type="button" className="crm-btn ghost sm" onClick={() => navigate({ name: "import" })}><Upload size={15} /> Importar</button>}
          {access.export && <button type="button" className="crm-btn ghost sm" onClick={exportAll}><Download size={15} /> Exportar</button>}
          {access.write && <button type="button" className="crm-btn primary" onClick={() => quickCreate("contact")}><Plus size={16} /> Novo contato</button>}
        </div>
      </div>

      {rows === null ? <Skeleton rows={8} /> : rows.length === 0 ? (
        <Empty icon={<Users />} title={search || filtersOn ? "Nenhum contato encontrado" : "Nenhum contato ainda"}
          text={search || filtersOn ? "Ajuste a busca ou os filtros." : "Contatos chegam automaticamente pelo WhatsApp conectado e pelos Smart Links. Você também pode cadastrar ou importar uma planilha."}
          action={access.write && !search && !filtersOn ? <div className="crm-row gap"><button type="button" className="crm-btn primary" onClick={() => quickCreate("contact")}><Plus size={15} /> Cadastrar contato</button><button type="button" className="crm-btn ghost" onClick={() => navigate({ name: "import" })}><Upload size={15} /> Importar CSV</button></div> : undefined} />
      ) : (
        <>
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead><tr>
                {th("name", "Contato")}{th("company_name", "Empresa")}{th("lifecycle_stage", "Ciclo")}{th("source_channel", "Origem")}
                {th("owner_email", "Responsável")}{th("open_value", "Em negociação", "num")}{th("rfv_segment", "RFV")}{th("lead_score", "Score", "num")}{th("last_interaction_at", "Última interação")}
              </tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => openContact(c.id)}>
                    <td>
                      <span className="crm-row gap">
                        <Avatar name={c.name ?? c.phone} size={30} />
                        <span><strong>{c.name ?? <span className="crm-muted">Sem nome</span>}</strong><small>{[phoneLabel(c.phone), c.email].filter(Boolean).join(" · ")}</small></span>
                        {(c.unread_count ?? 0) > 0 && <span className="crm-unread" title="Mensagens não lidas"><MessageCircle size={12} />{c.unread_count}</span>}
                      </span>
                    </td>
                    <td>{c.company_name ?? <span className="crm-muted">—</span>}</td>
                    <td><Pill tone={c.lifecycle_stage === "customer" ? "green" : c.lifecycle_stage === "inactive" ? "muted" : "info"}>{lifecycleLabels[c.lifecycle_stage]}</Pill></td>
                    <td><span title={basisLabels[c.acquisition_basis]?.hint}>{c.source_channel ? channelLabel(c.source_channel) : <span className="crm-muted">—</span>}{c.source_channel && c.acquisition_basis !== "known" && <small className="crm-muted"> ({basisLabels[c.acquisition_basis]?.label.replace("Origem ", "")})</small>}</span></td>
                    <td>{c.owner_id ? memberLabel(c.owner_id) : <span className="crm-muted">—</span>}</td>
                    <td className="num">{c.open_deals ? <>{brl(c.open_value, true)}<small>{c.open_deals} aberta(s)</small></> : <span className="crm-muted">—</span>}</td>
                    <td>{c.rfv_segment ? <Pill tone={segmentInfo[c.rfv_segment].tone}>{segmentInfo[c.rfv_segment].label}</Pill> : <span className="crm-muted">—</span>}</td>
                    <td className="num">{c.lead_score || <span className="crm-muted">0</span>}</td>
                    <td>{c.last_interaction_at ? relative(c.last_interaction_at) : <span className="crm-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="crm-pager">
            <span className="crm-muted small">{total} contato(s) · página {page + 1} de {Math.max(1, Math.ceil(total / pageSize))}</span>
            <button type="button" className="crm-btn ghost sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button>
            <button type="button" className="crm-btn ghost sm" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((p) => p + 1)}>Próxima</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página do contato (central de informações do cliente)
// ---------------------------------------------------------------------------
type ContactTab = "timeline" | "deals" | "whatsapp" | "tasks" | "purchases" | "ai" | "relationship";

export function ContactPage({ contactId }: { contactId: string }) {
  const { tenantId, access, members, refreshKey, notify, refresh, navigate, quickCreate, openDeal, memberLabel } = useCrm();
  const [c, setC] = useState<Contact | null | undefined>(undefined);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [tab, setTab] = useState<ContactTab>("timeline");
  const [editing, setEditing] = useState(false);
  const [dups, setDups] = useState<Awaited<ReturnType<typeof api.findDuplicates>>>([]);
  const [merge, setMerge] = useState<{ id: string; name: string | null } | null>(null);
  const [tagInput, setTagInput] = useState("");

  const load = useCallback(async () => {
    try {
      const [contact, ds] = await Promise.all([api.getContact(contactId), api.loadContactDeals(contactId)]);
      setC(contact); setDeals(ds);
      if (contact && (contact.phone || contact.email)) api.findDuplicates(tenantId, contact.phone ?? undefined, contact.email ?? undefined, contact.id).then(setDups).catch(() => setDups([]));
    } catch (e) { notify(errorText(e)); setC(null); }
  }, [contactId, tenantId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function patch(p: Partial<Contact>, msg = "Contato atualizado") {
    if (!c) return;
    const before = c;
    setC({ ...c, ...p });
    try { await api.updateContact(c.id, p); notify(msg); void load(); }
    catch (e) { setC(before); notify(errorText(e)); }
  }

  if (c === undefined) return <div className="crm-page"><Skeleton rows={6} /></div>;
  if (c === null) return <div className="crm-page"><Empty title="Contato não encontrado" text="Ele pode ter sido mesclado, arquivado ou pertencer a outra empresa." action={<button type="button" className="crm-btn ghost" onClick={() => navigate({ name: "contacts" })}>Voltar para contatos</button>} /></div>;

  const open = deals.filter((d) => d.status === "open");
  const wa = waLink(c.whatsapp ?? c.phone);

  return (
    <div className="crm-page">
      <button type="button" className="crm-link back" onClick={() => navigate({ name: "contacts" })}><ArrowLeft size={14} /> Contatos</button>
      <header className="crm-record-head">
        <Avatar name={c.name ?? c.phone} size={56} />
        <div className="grow">
          <h2>{c.name ?? phoneLabel(c.phone) ?? "Sem nome"}</h2>
          <div className="crm-record-meta">
            {c.phone && <span><Phone size={13} /> {phoneLabel(c.phone)}</span>}
            {c.email && <a href={`mailto:${c.email}`}><Mail size={13} /> {c.email}</a>}
            {c.company_name && <span><Building2 size={13} /> {c.company_name}{c.job_title ? ` · ${c.job_title}` : ""}</span>}
            {(c.city || c.state) && <span><MapPin size={13} /> {[c.city, c.state].filter(Boolean).join(" / ")}</span>}
          </div>
          <div className="crm-row gap wrap">
            <select className="crm-inline-select pill" value={c.lifecycle_stage} disabled={!access.write} onChange={(e) => patch({ lifecycle_stage: e.target.value as Lifecycle, lifecycle_source: "manual" } as Partial<Contact>, "Ciclo de vida atualizado")} aria-label="Ciclo de vida">
              {lifecycles.map((l) => <option key={l} value={l}>{lifecycleLabels[l]}</option>)}
            </select>
            <select className="crm-inline-select pill" value={c.owner_id ?? ""} disabled={!access.write} onChange={(e) => patch({ owner_id: e.target.value || null }, "Responsável atualizado")} aria-label="Responsável">
              <option value="">Sem responsável</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{emailName(m.email)}</option>)}
            </select>
            {(c.tags ?? []).map((t) => (
              <span key={t} className="crm-tag">{t}{access.write && <button type="button" onClick={() => patch({ tags: c.tags.filter((x) => x !== t) }, "Tag removida")} aria-label={`Remover ${t}`}><X size={11} /></button>}</span>
            ))}
            {access.write && (
              <input className="crm-tag-input" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="+ tag"
                onKeyDown={(e) => { if (e.key === "Enter" && tagInput.trim()) { void patch({ tags: Array.from(new Set([...(c.tags ?? []), tagInput.trim()])) }, "Tag adicionada"); setTagInput(""); } }} />
            )}
            {c.do_not_contact && <Pill tone="red">Não contatar</Pill>}
          </div>
        </div>
        <div className="crm-record-actions">
          {wa && <a className="crm-btn ghost sm" href={wa} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Abrir WhatsApp</a>}
          {access.write && <button type="button" className="crm-btn ghost sm" onClick={() => quickCreate("task", { contact_id: c.id, owner_id: c.owner_id })}>Agendar atividade</button>}
          {access.write && <button type="button" className="crm-btn primary sm" onClick={() => quickCreate("deal", { contact: { id: c.id, name: c.name, phone: c.phone, company_id: c.company_id } })}><Plus size={14} /> Negociação</button>}
        </div>
      </header>

      {dups.length > 0 && access.delete && (
        <div className="crm-callout warn">
          <GitMerge size={16} /> Possível cadastro duplicado:
          {dups.map((d) => <button type="button" key={d.id} className="crm-link" onClick={() => setMerge({ id: d.id, name: d.name })}>{d.name ?? phoneLabel(d.phone)} ({d.match_reason === "phone" ? "mesmo telefone" : "mesmo e-mail"})</button>)}
        </div>
      )}

      <div className="crm-record">
        <aside className="crm-stack">
          <section className="crm-panel">
            <header><h3>Resumo</h3>{access.write && <button type="button" className="crm-icon-btn" onClick={() => setEditing(true)} aria-label="Editar"><Pencil size={15} /></button>}</header>
            <dl className="crm-dl">
              <dt>Em negociação</dt><dd>{open.length ? `${brl(open.reduce((s, d) => s + Number(d.value), 0))} · ${open.length} aberta(s)` : "—"}</dd>
              <dt>Compras válidas</dt><dd>{c.purchase_count ? `${c.purchase_count} · ${brl(c.net_revenue)}` : "Nenhuma"}</dd>
              <dt>Última compra</dt><dd>{c.last_purchase_at ? shortDate(c.last_purchase_at) : "—"}</dd>
              <dt>Lead score</dt><dd title={(c.lead_score_details ?? []).map((d) => `${d.label}: +${d.points}`).join("\n")}>{c.lead_score} pts{(c.lead_score_details ?? []).length ? <small> · {(c.lead_score_details ?? []).map((d) => d.label).join(", ")}</small> : null}</dd>
              <dt>Consentimento</dt><dd>{c.marketing_consent === "granted" ? <><ShieldCheck size={13} /> Autorizou comunicações</> : c.marketing_consent === "denied" ? "Não autorizou" : "Não informado"}</dd>
              <dt>Criado</dt><dd>{dateTime(c.created_at)}</dd>
            </dl>
          </section>

          <section className="crm-panel">
            <header><h3>Origem da aquisição</h3></header>
            <div className="crm-origin">
              <Pill tone={c.acquisition_basis === "known" ? "green" : c.acquisition_basis === "inferred" ? "purple" : "muted"} title={basisLabels[c.acquisition_basis]?.hint}>{basisLabels[c.acquisition_basis]?.label}</Pill>
              <dl className="crm-dl">
                <dt>Canal</dt><dd>{c.source_channel ? channelLabel(c.source_channel) : "—"}</dd>
                {c.source_detail && <><dt>Detalhe</dt><dd>{c.source_detail}</dd></>}
                {(c.utm_campaign || c.acquisition_campaign) && <><dt>Campanha</dt><dd>{c.utm_campaign ?? c.acquisition_campaign}</dd></>}
                {c.utm_source && <><dt>UTM source / medium</dt><dd>{c.utm_source}{c.utm_medium ? ` / ${c.utm_medium}` : ""}</dd></>}
                {c.utm_content && <><dt>Anúncio (utm_content)</dt><dd>{c.utm_content}</dd></>}
                {Object.keys(c.ad_ids ?? {}).length > 0 && <><dt>IDs de anúncio</dt><dd className="mono">{Object.entries(c.ad_ids).map(([k, v]) => `${k}: ${v}`).join(" · ")}</dd></>}
                {c.acquisition_at && <><dt>Data de aquisição</dt><dd>{shortDate(c.acquisition_at)}</dd></>}
              </dl>
            </div>
          </section>

          {c.rfv_segment && (
            <section className="crm-panel">
              <header><h3>Relacionamento (RFV)</h3></header>
              <Pill tone={segmentInfo[c.rfv_segment].tone}>{segmentInfo[c.rfv_segment].label}</Pill>
              <div className="crm-rfv-scores"><span>R<b>{c.r_score ?? "—"}</b></span><span>F<b>{c.f_score ?? "—"}</b></span><span>V<b>{c.m_score ?? "—"}</b></span></div>
              <p className="crm-muted small">{segmentInfo[c.rfv_segment].action}{c.expected_next_purchase_at ? ` · próxima compra estimada ${shortDate(c.expected_next_purchase_at)}` : ""}</p>
            </section>
          )}

          {c.notes && <section className="crm-panel"><header><h3>Observações</h3></header><p className="crm-pre">{c.notes}</p></section>}
          <CustomFieldsPanel contact={c} onSave={(custom) => patch({ custom }, "Campos atualizados")} />
        </aside>

        <div className="crm-panel flush">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: "timeline", label: "Histórico" },
            { value: "deals", label: "Negociações", count: deals.length },
            { value: "whatsapp", label: "WhatsApp", count: c.unread_count ?? 0 },
            { value: "tasks", label: "Atividades" },
            { value: "purchases", label: "Compras", count: c.purchase_count ?? 0 },
            { value: "ai", label: "Inteligência" },
            { value: "relationship", label: "Relacionamento" },
          ]} />
          <div className="crm-tab-body">
            {tab === "timeline" && <Timeline contactId={c.id} />}
            {tab === "deals" && (
              deals.length === 0 ? <Empty title="Nenhuma negociação" text="Crie uma negociação para acompanhar esta oportunidade no funil." action={access.write ? <button type="button" className="crm-btn primary sm" onClick={() => quickCreate("deal", { contact: { id: c.id, name: c.name, phone: c.phone, company_id: c.company_id } })}><Plus size={14} /> Nova negociação</button> : undefined} /> : (
                <ul className="crm-list">
                  {deals.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => openDeal(d.id)}>
                        <span className="grow"><strong>{d.title}</strong><small>{d.pipeline_name} · {d.stage_name} · {d.owner_id ? memberLabel(d.owner_id) : "sem responsável"}</small></span>
                        <span className="num"><strong>{brl(d.value)}</strong><Pill tone={d.status === "won" ? "green" : d.status === "lost" ? "muted" : "info"}>{d.status === "won" ? "Ganha" : d.status === "lost" ? "Perdida" : "Aberta"}</Pill></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
            {tab === "whatsapp" && <WhatsAppThread conversationId={c.conversation_id} />}
            {tab === "tasks" && <TaskList contactId={c.id} />}
            {tab === "purchases" && <div className="crm-stack"><OrdersPanel contactId={c.id} companyId={c.company_id} /><SamplesPanel contactId={c.id} /></div>}
            {tab === "ai" && <AiPanel contactId={c.id} />}
            {tab === "relationship" && <RelationshipPanel contact={c} />}
          </div>
        </div>
      </div>

      {editing && <ContactEditModal contact={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); refresh(); }} />}
      {merge && (
        <Modal open onClose={() => setMerge(null)} title="Mesclar contatos" width={480}
          footer={<><button type="button" className="crm-btn ghost" onClick={() => setMerge(null)}>Cancelar</button>
            <button type="button" className="crm-btn danger" onClick={async () => {
              try { await api.mergeContacts(c.id, merge.id); notify("Contatos mesclados. O duplicado foi arquivado com referência a este."); setMerge(null); setDups([]); void load(); refresh(); }
              catch (e) { notify(errorText(e)); }
            }}>Mesclar neste contato</button></>}>
          <p>Negociações, atividades, conversas, compras e histórico de <strong>{merge.name ?? "contato duplicado"}</strong> passarão para <strong>{c.name ?? "este contato"}</strong>.</p>
          <p className="crm-muted small">Nada é apagado: o duplicado fica arquivado e apontando para este cadastro. Só mescle se tiver certeza de que é a mesma pessoa.</p>
        </Modal>
      )}
    </div>
  );
}

function ContactEditModal({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const { tenantId, notify } = useCrm();
  const [f, setF] = useState({
    name: contact.name ?? "", phone: contact.phone ?? "", whatsapp: contact.whatsapp ?? "", email: contact.email ?? "", job_title: contact.job_title ?? "",
    city: contact.city ?? "", state: contact.state ?? "", company_id: contact.company_id ?? "", notes: contact.notes ?? "", marketing_consent: contact.marketing_consent,
    do_not_contact: contact.do_not_contact, disqualification_reason: contact.disqualification_reason ?? "", source_channel: contact.source_channel ?? "",
  });
  const [companies, setCompanies] = useState<Company[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.loadCompanies(tenantId).then(setCompanies).catch(() => setCompanies([])); }, [tenantId]);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      const sourceChanged = (f.source_channel || null) !== contact.source_channel;
      await api.updateContact(contact.id, {
        name: f.name.trim() || null, phone: f.phone.trim() || null, whatsapp: f.whatsapp.trim() || null, email: f.email.trim() || null, job_title: f.job_title.trim() || null,
        city: f.city.trim() || null, state: f.state.trim() || null, company_id: f.company_id || null, notes: f.notes.trim() || null,
        marketing_consent: f.marketing_consent, do_not_contact: f.do_not_contact, disqualification_reason: f.disqualification_reason.trim() || null,
        ...(sourceChanged ? { source_channel: f.source_channel || null, acquisition_basis: contact.acquisition_basis === "known" ? "known" : f.source_channel ? "declared" : "unknown" } : {}),
      } as Partial<Contact>);
      notify("Contato atualizado");
      onSaved();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Editar contato" width={640}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button></>}>
      <div className="crm-form-grid">
        <Field label="Nome" span={2}><input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Telefone"><input value={f.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /></Field>
        <Field label="WhatsApp (se diferente)"><input value={f.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} inputMode="tel" /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Empresa">
          <select value={f.company_id} onChange={(e) => set("company_id", e.target.value)}><option value="">—</option>{companies.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}</select>
        </Field>
        <Field label="Cargo"><input value={f.job_title} onChange={(e) => set("job_title", e.target.value)} /></Field>
        <Field label="Cidade"><input value={f.city} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="UF"><input value={f.state} maxLength={2} onChange={(e) => set("state", e.target.value.toUpperCase())} /></Field>
        <Field label="Origem" hint={contact.acquisition_basis === "known" ? "Origem comprovada por rastreamento; alterar não remove a evidência original." : "Informada manualmente = origem declarada."}>
          <select value={f.source_channel} onChange={(e) => set("source_channel", e.target.value)}>
            <option value="">Desconhecida</option>
            {["manual", "whatsapp", "meta_ads", "google_ads", "instagram", "site", "form", "landing_page", "referral", "outbound", "organic", "import", "smart_link"].map((s) => <option key={s} value={s}>{channelLabel(s)}</option>)}
          </select>
        </Field>
        <Field label="Consentimento de marketing">
          <select value={f.marketing_consent} onChange={(e) => set("marketing_consent", e.target.value)}>
            <option value="unknown">Não informado</option><option value="granted">Autorizou</option><option value="denied">Não autorizou</option>
          </select>
        </Field>
        <Field label="Motivo de desqualificação"><input value={f.disqualification_reason} onChange={(e) => set("disqualification_reason", e.target.value)} placeholder="Ex.: fora da região atendida" /></Field>
        <label className="crm-check span-2"><input type="checkbox" checked={f.do_not_contact} onChange={(e) => set("do_not_contact", e.target.checked)} /> Não contatar (pedido do cliente / LGPD)</label>
        <Field label="Observações" span={2}><textarea rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function CustomFieldsPanel({ contact, onSave }: { contact: Contact; onSave: (custom: Record<string, unknown>) => void }) {
  const { tenantId, access } = useCrm();
  const [fields, setFields] = useState<CustomField[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>(contact.custom ?? {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => { api.loadCustomFields(tenantId).then((f) => setFields(f.filter((x) => x.entity === "contact"))).catch(() => setFields([])); }, [tenantId]);
  useEffect(() => { setDraft(contact.custom ?? {}); setDirty(false); }, [contact.custom]);
  if (!fields.length) return null;
  const set = (k: string, v: unknown) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };
  return (
    <section className="crm-panel">
      <header><h3>Dados personalizados</h3>{dirty && access.write && <button type="button" className="crm-btn primary xs" onClick={() => onSave(draft)}>Salvar</button>}</header>
      <div className="crm-form-grid one">
        {fields.map((f) => (
          <Field key={f.id} label={f.label}>
            {f.field_type === "select" ? (
              <select value={String(draft[f.field_key] ?? "")} disabled={!access.write} onChange={(e) => set(f.field_key, e.target.value || null)}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
            ) : f.field_type === "boolean" ? (
              <select value={draft[f.field_key] === true ? "1" : draft[f.field_key] === false ? "0" : ""} disabled={!access.write} onChange={(e) => set(f.field_key, e.target.value === "" ? null : e.target.value === "1")}><option value="">—</option><option value="1">Sim</option><option value="0">Não</option></select>
            ) : (
              <input type={f.field_type === "number" ? "number" : f.field_type === "date" ? "date" : "text"} value={String(draft[f.field_key] ?? "")} disabled={!access.write}
                onChange={(e) => set(f.field_key, e.target.value === "" ? null : f.field_type === "number" ? Number(e.target.value) : e.target.value)} />
            )}
          </Field>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Amostras (experimentação — não contam como compra)
// ---------------------------------------------------------------------------
export function SamplesPanel({ contactId }: { contactId: string }) {
  const { tenantId, access, offers, refreshKey, notify, refresh } = useCrm();
  const [list, setList] = useState<Sample[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { api.loadSamples(tenantId, contactId).then(setList).catch(() => setList([])); }, [tenantId, contactId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  return (
    <section className="crm-stack tight">
      <div className="crm-row between"><h4 className="crm-subhead">Amostras e experimentação</h4>{access.write && <button type="button" className="crm-btn ghost xs" onClick={() => setAdding(true)}><Plus size={13} /> Registrar amostra</button>}</div>
      <p className="crm-muted small">Amostras grátis são eventos de marketing: não contam como compra nem entram no RFV.</p>
      {list === null ? <Skeleton rows={1} /> : list.length === 0 ? null : (
        <ul className="crm-list">
          {list.map((s) => (
            <li key={s.id}><div className="crm-list-static">
              <span className="grow"><strong>{s.product_name}</strong><small>{shortDate(s.delivered_at)}{s.campaign ? ` · ${s.campaign}` : ""}{s.feedback ? ` · “${s.feedback}”` : ""}</small></span>
              <span className="num">{s.first_purchase_after_at ? <><Pill tone="green">Comprou em {s.days_to_first_purchase} dias</Pill><small>{brl(s.revenue_after)}</small></> : <Pill tone="muted">Ainda sem compra</Pill>}</span>
            </div></li>
          ))}
        </ul>
      )}
      {adding && <SampleModal contactId={contactId} offers={offers} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); refresh(); notify("Amostra registrada"); }} />}
    </section>
  );
}

export function SampleModal({ contactId, offers, onClose, onSaved, contactSlot }: { contactId: string | null; offers: { id: string; name: string }[]; onClose: () => void; onSaved: () => void; contactSlot?: ReactNode }) {
  const { tenantId, notify } = useCrm();
  const [offerId, setOfferId] = useState("");
  const [product, setProduct] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [campaign, setCampaign] = useState("");
  const [channel, setChannel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [rating, setRating] = useState("");
  async function save() {
    if (!contactId) { notify("Escolha o contato."); return; }
    const name = product.trim() || offers.find((o) => o.id === offerId)?.name || "";
    if (!name) { notify("Informe o produto experimentado."); return; }
    try {
      await api.addSample({ tenant_id: tenantId, contact_id: contactId, offer_id: offerId || null, product_name: name, delivered_at: new Date(`${date}T12:00:00`).toISOString(), campaign: campaign || null, channel: channel || null, feedback: feedback || null, rating: rating ? Number(rating) : null });
      onSaved();
    } catch (e) { notify(errorText(e)); }
  }
  return (
    <Modal open onClose={onClose} title="Registrar amostra / experimentação" width={560}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save}>Registrar</button></>}>
      <div className="crm-form-grid">
        {contactSlot && <Field label="Contato" span={2}>{contactSlot}</Field>}
        <Field label="Produto do catálogo"><select value={offerId} onChange={(e) => setOfferId(e.target.value)}><option value="">—</option>{offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
        <Field label="ou descreva"><input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Ex.: Amostra 2ml — Oud" /></Field>
        <Field label="Data da entrega"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Campanha"><input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Ex.: Ação shopping novembro" /></Field>
        <Field label="Canal"><input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Loja, evento, envio…" /></Field>
        <Field label="Avaliação (1–5)"><input type="number" min={1} max={5} value={rating} onChange={(e) => setRating(e.target.value)} /></Field>
        <Field label="Feedback" span={2}><textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Relacionamento: RFV + onboarding / customer success
// ---------------------------------------------------------------------------
function RelationshipPanel({ contact }: { contact: Contact }) {
  const { tenantId, access, members, refreshKey, notify } = useCrm();
  const [history, setHistory] = useState<Record<string, unknown>[] | null>(null);
  const [onb, setOnb] = useState<Onboarding[] | null>(null);
  const load = useCallback(() => {
    api.contactRfvHistory(contact.id).then((h) => setHistory((h ?? []) as Record<string, unknown>[])).catch(() => setHistory([]));
    api.loadOnboardings(tenantId, contact.id).then(setOnb).catch(() => setOnb([]));
  }, [contact.id, tenantId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function startOnboarding() {
    try {
      await api.saveOnboarding({ tenant_id: tenantId, contact_id: contact.id, company_id: contact.company_id, owner_id: contact.owner_id, title: `Onboarding de ${contact.name ?? "cliente"}`, status: "in_progress",
        checklist: ["Boas-vindas e alinhamento do que foi prometido", "Confirmar entrega/ativação", "Registrar primeiro resultado percebido", "Pedir avaliação da experiência", "Estimular segunda compra"].map((l) => ({ id: crypto.randomUUID(), label: l, done: false })) } as never);
      notify("Onboarding iniciado"); load();
    } catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-stack">
      <h4 className="crm-subhead">Onboarding e sucesso do cliente</h4>
      {onb === null ? <Skeleton rows={1} /> : onb.length === 0 ? (
        <Empty title="Sem onboarding" text="Use o onboarding para registrar o que foi prometido, o handoff da venda e o primeiro resultado." action={access.write ? <button type="button" className="crm-btn ghost sm" onClick={startOnboarding}><Plus size={14} /> Iniciar onboarding</button> : undefined} />
      ) : onb.map((o) => <OnboardingCard key={o.id} item={o} members={members.map((m) => ({ id: m.user_id, label: emailName(m.email) }))} onChanged={load} />)}

      <h4 className="crm-subhead">Histórico de segmentos RFV</h4>
      {history === null ? <Skeleton rows={1} /> : history.length === 0 ? <p className="crm-muted small">Sem cálculos de RFV para este contato. O RFV considera apenas compras válidas.</p> : (
        <table className="crm-table compact">
          <thead><tr><th>Data</th><th>Segmento</th><th>R</th><th>F</th><th>V</th><th className="num">Compras</th><th className="num">Receita</th><th>Regra</th></tr></thead>
          <tbody>{history.map((h, i) => (
            <tr key={i}><td>{dateTime(String(h.computed_at))}</td><td>{segmentInfo[h.segment as RfvSegment]?.label ?? String(h.segment)}</td><td>{String(h.r_score ?? "—")}</td><td>{String(h.f_score ?? "—")}</td><td>{String(h.m_score ?? "—")}</td>
              <td className="num">{String(h.purchase_count ?? 0)}</td><td className="num">{brl(Number(h.net_revenue ?? 0))}</td><td className="crm-muted small">v{String(h.rule_version ?? "?")} · {String(h.method_used ?? "")}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

const onbStatus: Record<Onboarding["status"], string> = { not_started: "Não iniciado", in_progress: "Em andamento", active: "Ativo", at_risk: "Em risco", churned: "Cancelou", completed: "Concluído" };

export function OnboardingCard({ item, members, onChanged }: { item: Onboarding; members: { id: string; label: string }[]; onChanged: () => void }) {
  const { tenantId, access, notify } = useCrm();
  const [o, setO] = useState(item);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setO(item); setDirty(false); }, [item]);
  const set = <K extends keyof Onboarding>(k: K, v: Onboarding[K]) => { setO((x) => ({ ...x, [k]: v })); setDirty(true); };
  const done = o.checklist.filter((c) => c.done).length;
  const ttv = o.first_value_at ? Math.round((new Date(o.first_value_at).getTime() - new Date(o.started_at).getTime()) / 86400000) : null;

  async function save() {
    try {
      await api.saveOnboarding({ id: o.id, tenant_id: tenantId, status: o.status, promised: o.promised, handoff_notes: o.handoff_notes, success_plan: o.success_plan, checklist: o.checklist,
        activated_at: o.activated_at, first_value_at: o.first_value_at, first_value_note: o.first_value_note, renewal_date: o.renewal_date, nps: o.nps, csat: o.csat, health: o.health,
        risk_notes: o.risk_notes, expansion_notes: o.expansion_notes, owner_id: o.owner_id });
      notify("Onboarding salvo"); setDirty(false); onChanged();
    } catch (e) { notify(errorText(e)); }
  }

  return (
    <div className="crm-onb">
      <div className="crm-row between">
        <strong>{o.title}</strong>
        <span className="crm-row gap">
          <select className="crm-inline-select" value={o.status} disabled={!access.write} onChange={(e) => set("status", e.target.value as Onboarding["status"])}>{Object.entries(onbStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="crm-inline-select" value={o.health ?? ""} disabled={!access.write} onChange={(e) => set("health", (e.target.value || null) as Onboarding["health"])}><option value="">Saúde: —</option><option value="good">Saúde: boa</option><option value="attention">Saúde: atenção</option><option value="critical">Saúde: crítica</option></select>
        </span>
      </div>
      <div className="crm-progress"><i style={{ width: `${o.checklist.length ? (done / o.checklist.length) * 100 : 0}%` }} /></div>
      <ul className="crm-checklist">
        {o.checklist.map((c) => (
          <li key={c.id}><label><input type="checkbox" checked={c.done} disabled={!access.write} onChange={(e) => set("checklist", o.checklist.map((x) => x.id === c.id ? { ...x, done: e.target.checked, done_at: e.target.checked ? new Date().toISOString() : null } : x))} /> {c.label}</label></li>
        ))}
      </ul>
      <div className="crm-form-grid">
        <Field label="O que foi prometido na venda" span={2}><textarea rows={2} value={o.promised ?? ""} disabled={!access.write} onChange={(e) => set("promised", e.target.value || null)} /></Field>
        <Field label="Notas de handoff (vendas → atendimento)" span={2}><textarea rows={2} value={o.handoff_notes ?? ""} disabled={!access.write} onChange={(e) => set("handoff_notes", e.target.value || null)} /></Field>
        <Field label="Responsável pela conta"><select value={o.owner_id ?? ""} disabled={!access.write} onChange={(e) => set("owner_id", e.target.value || null)}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
        <Field label="Ativação"><input type="date" value={o.activated_at?.slice(0, 10) ?? ""} disabled={!access.write} onChange={(e) => set("activated_at", e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null)} /></Field>
        <Field label="Primeiro resultado (data)" hint={ttv !== null ? `Tempo até o primeiro valor: ${ttv} dia(s)` : undefined}><input type="date" value={o.first_value_at?.slice(0, 10) ?? ""} disabled={!access.write} onChange={(e) => set("first_value_at", e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null)} /></Field>
        <Field label="Primeiro resultado (descrição)"><input value={o.first_value_note ?? ""} disabled={!access.write} onChange={(e) => set("first_value_note", e.target.value || null)} /></Field>
        <Field label="Renovação"><input type="date" value={o.renewal_date ?? ""} disabled={!access.write} onChange={(e) => set("renewal_date", e.target.value || null)} /></Field>
        <Field label="NPS (0–10)"><input type="number" min={0} max={10} value={o.nps ?? ""} disabled={!access.write} onChange={(e) => set("nps", e.target.value === "" ? null : Number(e.target.value))} /></Field>
        <Field label="Riscos de cancelamento" span={2}><input value={o.risk_notes ?? ""} disabled={!access.write} onChange={(e) => set("risk_notes", e.target.value || null)} /></Field>
        <Field label="Oportunidades de expansão" span={2}><input value={o.expansion_notes ?? ""} disabled={!access.write} onChange={(e) => set("expansion_notes", e.target.value || null)} /></Field>
      </div>
      {dirty && access.write && <div className="crm-row end"><button type="button" className="crm-btn primary sm" onClick={save}>Salvar onboarding</button></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empresas-clientes
// ---------------------------------------------------------------------------
export function CompaniesView() {
  const { tenantId, access, refreshKey, notify, quickCreate, openContact, openDeal, memberLabel } = useCrm();
  const [rows, setRows] = useState<Company[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [editing, setEditing] = useState<Company | null>(null);
  const [records, setRecords] = useState<{ contacts: Contact[]; deals: Deal[] } | null>(null);

  const load = useCallback(() => { api.loadCompanies(tenantId, search.trim() || undefined).then(setRows).catch((e) => { notify(errorText(e)); setRows([]); }); }, [tenantId, search, notify]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load, refreshKey]);
  useEffect(() => { if (selected) { setRecords(null); api.loadCompanyRecords(selected.id).then(setRecords).catch(() => setRecords({ contacts: [], deals: [] })); } }, [selected]);

  const sizes: Record<string, string> = useMemo(() => ({ mei: "MEI", micro: "Micro", small: "Pequena", medium: "Média", large: "Grande" }), []);

  return (
    <div className="crm-page">
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <div className="crm-search"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar empresa…" /></div>
        </div>
        <div className="crm-toolbar-right">{access.write && <button type="button" className="crm-btn primary" onClick={() => quickCreate("company")}><Plus size={16} /> Nova empresa</button>}</div>
      </div>
      {rows === null ? <Skeleton rows={5} /> : rows.length === 0 ? (
        <Empty icon={<Building2 />} title="Nenhuma empresa cadastrada" text="Use empresas para vendas B2B: vincule vários contatos e negociações à mesma conta." />
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Empresa</th><th>Segmento</th><th>Porte</th><th>Cidade</th><th>Responsável</th><th>Criada</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} onClick={() => setSelected(c)}>
                <td><span className="crm-row gap"><Avatar name={c.name} size={28} /><span><strong>{c.name}</strong>{c.domain && <small>{c.domain}</small>}</span></span></td>
                <td>{c.segment ?? "—"}</td><td>{c.size ? sizes[c.size] ?? c.size : "—"}</td><td>{[c.city, c.state].filter(Boolean).join(" / ") || "—"}</td>
                <td>{c.owner_id ? memberLabel(c.owner_id) : "—"}</td><td>{shortDate(c.created_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {selected && (
        <Drawer open onClose={() => setSelected(null)} title={selected.name} subtitle={[selected.segment, selected.city].filter(Boolean).join(" · ")}
          actions={access.write ? <button type="button" className="crm-btn ghost sm" onClick={() => setEditing(selected)}><Pencil size={14} /> Editar</button> : undefined}>
          {records === null ? <Skeleton rows={3} /> : (
            <div className="crm-stack">
              {selected.domain && <a className="crm-link" href={selected.domain.startsWith("http") ? selected.domain : `https://${selected.domain}`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {selected.domain}</a>}
              {selected.notes && <p className="crm-pre">{selected.notes}</p>}
              <div className="crm-row between"><h4 className="crm-subhead">Contatos ({records.contacts.length})</h4>{access.write && <button type="button" className="crm-btn ghost xs" onClick={() => quickCreate("contact")}><Plus size={13} /> Contato</button>}</div>
              {records.contacts.length === 0 ? <p className="crm-muted small">Nenhum contato vinculado. Edite um contato e escolha esta empresa.</p> : (
                <ul className="crm-list">{records.contacts.map((c) => <li key={c.id}><button type="button" onClick={() => { setSelected(null); openContact(c.id); }}><span className="grow"><strong>{c.name ?? phoneLabel(c.phone)}</strong><small>{c.job_title ?? ""}</small></span><Pill>{lifecycleLabels[c.lifecycle_stage]}</Pill></button></li>)}</ul>
              )}
              <h4 className="crm-subhead">Negociações ({records.deals.length})</h4>
              {records.deals.length === 0 ? <p className="crm-muted small">Nenhuma negociação.</p> : (
                <ul className="crm-list">{records.deals.map((d) => <li key={d.id}><button type="button" onClick={() => { setSelected(null); openDeal(d.id); }}><span className="grow"><strong>{d.title}</strong><small>{d.stage_name}</small></span><span className="num">{brl(d.value)}</span></button></li>)}</ul>
              )}
            </div>
          )}
        </Drawer>
      )}
      {editing && <CompanyModal company={editing} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); setSelected(c); load(); }} />}
    </div>
  );
}
