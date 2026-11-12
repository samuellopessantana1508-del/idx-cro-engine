import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Mic, MoreVertical, Phone, PhoneCall, RotateCcw, Search, Upload, X } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { downloadCsv, parseCsv } from "./csv";
import { dateTime, errorText, fromLocalInput, phoneLabel, relative } from "./format";
import type { DialLead, DialOutcome, DialOverview } from "./types";
import { Empty, Field, Modal, Skeleton } from "./ui";

const PAGE = 60;

const outcomes: { v: DialOutcome; label: string; tone: string }[] = [
  { v: "meeting", label: "Reunião", tone: "green" },
  { v: "callback", label: "Retornar", tone: "blue" },
  { v: "talked", label: "Conversou", tone: "ink" },
  { v: "no_answer", label: "Não atendeu", tone: "muted" },
  { v: "not_interested", label: "Sem interesse", tone: "muted" },
  { v: "invalid", label: "Nº errado", tone: "red" },
];
const outcomeLabel = Object.fromEntries(outcomes.map((o) => [o.v, o.label])) as Record<DialOutcome, string>;

export function DialerView() {
  const { tenantId, access, refreshKey, notify, openContact, openAssistant } = useCrm();
  const [ov, setOv] = useState<DialOverview | null>(null);
  const [list, setList] = useState<string | null>(() => { try { return localStorage.getItem("crm.dial.list"); } catch { return null; } });
  const [tab, setTab] = useState<"pending" | "called">("pending");
  const [uf, setUf] = useState<string>(() => { try { return localStorage.getItem("crm.dial.uf") ?? ""; } catch { return ""; } });
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<DialLead[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [noteFor, setNoteFor] = useState<{ lead: DialLead; outcome: DialOutcome } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { try { if (list) localStorage.setItem("crm.dial.list", list); localStorage.setItem("crm.dial.uf", uf); } catch { /* sem storage */ } }, [list, uf]);

  const loadOverview = useCallback(() => {
    api.dialOverview(tenantId, list).then((o) => {
      setOv(o);
      // começa pela lista que ainda tem números para ligar (não por uma lista vazia)
      const best = o.lists.find((l) => l.pending > 0) ?? o.lists[0];
      if (!list && best) setList(best.name);
      if (list && best && !o.lists.some((l) => l.name === list)) setList(best.name);
    }).catch((e) => notify(errorText(e)));
  }, [tenantId, list, notify]);
  useEffect(() => { loadOverview(); }, [loadOverview, refreshKey]);

  const loadPage = useCallback(async (p: number) => {
    const data = await api.loadDialLeads(tenantId, { list, status: tab, uf: uf || undefined, search, page: p, pageSize: PAGE });
    setHasMore(data.length === PAGE);
    setRows((old) => (p === 0 ? data : [...(old ?? []), ...data.filter((d) => !(old ?? []).some((o) => o.id === d.id))]));
    setPage(p);
  }, [tenantId, list, tab, uf, search]);

  useEffect(() => {
    setRows(null);
    const t = setTimeout(() => { loadPage(0).catch((e) => { notify(errorText(e)); setRows([]); }); }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadPage, search, refreshKey, notify]);

  // rolagem infinita
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingMore && rows) {
        setLoadingMore(true);
        loadPage(page + 1).catch((e) => notify(errorText(e))).finally(() => setLoadingMore(false));
      }
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, rows, page, loadPage, notify]);

  const patchRow = (r: DialLead) => setRows((l) => (l ?? []).map((x) => (x.id === r.id ? { ...x, ...r } : x)));

  function onCall(lead: DialLead) {
    // não bloqueia a ligação: o link tel: abre o discador do celular e a marcação vai em paralelo
    patchRow({ ...lead, status: "called", called_at: new Date().toISOString(), call_count: lead.call_count + 1 });
    setOv((o) => (o ? { ...o, pending: Math.max(0, o.pending - (lead.status === "pending" ? 1 : 0)), called_today: o.called_today + 1 } : o));
    api.dialMarkCalled(lead.id).then(patchRow).catch((e) => { patchRow(lead); notify(`Não foi possível marcar: ${errorText(e)}`); });
  }

  async function setOutcome(lead: DialLead, outcome: DialOutcome | null, notes?: string, dueAt?: string | null, objection?: string | null) {
    const before = lead;
    patchRow({ ...lead, outcome });
    try {
      const r = await api.dialSetOutcome(lead.id, outcome, notes, dueAt, objection);
      patchRow(r);
      if (outcome === "meeting") notify(`Reunião registrada${dueAt ? ` para ${dateTime(dueAt)}` : ""} · contato e negociação criados no CRM`);
      else if (outcome === "callback") notify(`Retorno agendado para ${dueAt ? dateTime(dueAt) : "amanhã às 9h"}`);
      loadOverview();
    } catch (e) { patchRow(before); notify(errorText(e)); }
  }

  async function undo(lead: DialLead) {
    try { const r = await api.dialReset(lead.id); patchRow(r); loadOverview(); } catch (e) { notify(errorText(e)); }
  }

  async function exportCsv() {
    setMenu(false);
    try {
      const all = await api.dialExport(tenantId, { list, uf: uf || undefined });
      downloadCsv(`${(list ?? "discador").toLowerCase().replace(/\W+/g, "-")}${uf ? `-${uf}` : ""}.csv`, all.map((r) => ({
        nome: r.name, telefone: r.phone, telefone2: r.phone2 ?? "", cidade: r.city ?? "", uf: r.uf ?? "", bairro: r.district ?? "", cnpj: r.cnpj ?? "",
        status: r.status === "called" ? "ligado" : "pendente", resultado: r.outcome ? outcomeLabel[r.outcome] : "", ligacoes: r.call_count, ultima_ligacao: r.called_at ?? "", observacao: r.notes ?? "",
      })));
      notify(`${all.length} número(s) exportado(s)`);
    } catch (e) { notify(errorText(e)); }
  }

  const ufs = ov?.ufs ?? [];
  const noLists = ov && ov.lists.length === 0;

  return (
    <div className="crm-page dial">
      <div className="dial-head">
        <div className="dial-stats">
          <span><b>{ov ? ov.pending.toLocaleString("pt-BR") : "—"}</b>para ligar</span>
          <span><b>{ov ? ov.called_today : "—"}</b>hoje</span>
          <span className="green"><b>{ov ? ov.meetings : "—"}</b>reuniões</span>
        </div>
        <div className="dial-filters">
          {(ov?.lists.length ?? 0) > 1 && (
            <select className="crm-select" value={list ?? ""} onChange={(e) => setList(e.target.value)} aria-label="Lista">
              {ov!.lists.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.pending})</option>)}
            </select>
          )}
          <select className="crm-select" value={uf} onChange={(e) => setUf(e.target.value)} aria-label="Estado">
            <option value="">Todo o Brasil</option>
            {ufs.map((u) => <option key={u.uf} value={u.uf}>{u.uf} · {u.pending} para ligar</option>)}
          </select>
          <div className="crm-search">
            <Search size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cidade, bairro ou nome" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label="Limpar"><X size={14} /></button>}
          </div>
          {access.write && (
            <div className="crm-dropdown">
              <button type="button" className="crm-icon-btn" onClick={() => setMenu((m) => !m)} aria-label="Mais opções"><MoreVertical size={18} /></button>
              {menu && (
                <div className="crm-menu right" onMouseLeave={() => setMenu(false)}>
                  <button type="button" onClick={() => { setMenu(false); setImporting(true); }}><Upload size={15} /> Importar números (CSV)</button>
                  {access.export && <button type="button" onClick={exportCsv}><Download size={15} /> Exportar esta lista</button>}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="dial-tabs">
          <button type="button" className={tab === "pending" ? "on" : ""} onClick={() => setTab("pending")}>Para ligar</button>
          <button type="button" className={tab === "called" ? "on" : ""} onClick={() => setTab("called")}>Já liguei{ov ? ` (${ov.called})` : ""}</button>
        </div>
      </div>

      {noLists ? (
        <Empty icon={<PhoneCall />} title="Nenhuma lista de números ainda"
          text="Importe um CSV com nome, telefone, cidade e UF. Cada número vira um botão azul: toque para ligar e ele já fica marcado."
          action={access.write ? <button type="button" className="crm-btn primary" onClick={() => setImporting(true)}><Upload size={15} /> Importar números</button> : undefined} />
      ) : rows === null ? <Skeleton rows={8} height={64} /> : rows.length === 0 ? (
        <Empty icon={<Check />} title={tab === "pending" ? "Nenhum número para ligar aqui" : "Nenhuma ligação ainda"} text={tab === "pending" ? "Troque o estado ou limpe a busca." : "Toque em um número azul na aba “Para ligar”."} />
      ) : (
        <ul className="dial-list">
          {rows.map((r) => {
            const done = r.status === "called";
            return (
              <li key={r.id} className={`dial-row${done ? " done" : ""}${r.outcome ? ` out-${r.outcome}` : ""}`}>
                <div className="dial-info">
                  <strong>{r.name}</strong>
                  <small>{[r.city, r.uf].filter(Boolean).join(" – ")}{r.district ? ` · ${r.district}` : ""}</small>
                  {done && <small className="dial-done-label"><Check size={12} /> Ligado {r.called_at ? relative(r.called_at) : ""}{r.call_count > 1 ? ` · ${r.call_count}x` : ""}{r.outcome ? ` · ${outcomeLabel[r.outcome]}` : ""}{r.objection ? ` · “${r.objection}”` : ""}</small>}
                </div>
                <a className="dial-call" href={`tel:+${r.phone}`} onClick={() => onCall(r)}>
                  <Phone size={17} /> {phoneLabel(r.phone)}
                </a>
                {done && (
                  <div className="dial-outcomes">
                    {outcomes.map((o) => (
                      <button type="button" key={o.v} className={`dial-chip tone-${o.tone}${r.outcome === o.v ? " on" : ""}`}
                        onClick={() => (o.v === "meeting" || o.v === "callback" || o.v === "talked") && r.outcome !== o.v ? setNoteFor({ lead: r, outcome: o.v }) : setOutcome(r, r.outcome === o.v ? null : o.v)}>
                        {o.label}
                      </button>
                    ))}
                    {access.write && <button type="button" className="dial-chip tone-voice" onClick={() => openAssistant({ dialLead: { id: r.id, name: r.name, phone: r.phone, contact_id: r.contact_id } },
                      (res) => { patchRow({ ...r, outcome: res.plan.dial_outcome ?? r.outcome, contact_id: res.contact_id ?? r.contact_id, objection: res.plan.objection ?? r.objection }); loadOverview(); })}>
                      <Mic size={13} /> Contar como foi</button>}
                    {r.contact_id && <button type="button" className="dial-chip tone-ink" onClick={() => openContact(r.contact_id!)}>Abrir no CRM</button>}
                    <button type="button" className="dial-chip ghost" onClick={() => undo(r)} title="Voltar para “Para ligar”"><RotateCcw size={12} /> Desfazer</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={sentinel} className="dial-sentinel">{loadingMore ? "Carregando mais…" : hasMore && rows?.length ? "" : rows?.length ? "Fim da lista" : ""}</div>

      {importing && <DialImportModal defaultList={list ?? "Farmácias"} onClose={() => setImporting(false)} onDone={(name) => { setImporting(false); setList(name); loadOverview(); loadPage(0).catch(() => undefined); }} />}
      {noteFor && <OutcomeNoteModal lead={noteFor.lead} outcome={noteFor.outcome} onClose={() => setNoteFor(null)} onSave={(notes, due, objection) => { const n = noteFor; setNoteFor(null); void setOutcome(n.lead, n.outcome, notes, due, objection); }} />}
    </div>
  );
}

function OutcomeNoteModal({ lead, outcome, onClose, onSave }: { lead: DialLead; outcome: DialOutcome; onClose: () => void; onSave: (notes: string, dueAt: string | null, objection: string | null) => void }) {
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState("");
  const [objection, setObjection] = useState("");
  const what = outcome === "meeting" ? "Cria contato e negociação no CRM (e a reunião na agenda, se informar o horário)." : outcome === "callback" ? "Cria contato e uma tarefa de retorno (amanhã às 9h, se não informar)." : "Cria o contato no CRM com o histórico da ligação.";
  const save = () => onSave(notes, fromLocalInput(when), objection.trim() || null);
  return (
    <Modal open onClose={onClose} title={`${outcomeLabel[outcome]} — ${lead.name}`} width={460}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button><button type="button" className="crm-btn primary" onClick={save}>Salvar</button></>}>
      <p className="crm-muted small">{what}</p>
      {(outcome === "meeting" || outcome === "callback") && (
        <Field label={outcome === "meeting" ? "Data e hora da reunião" : "Quando retornar"}><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      )}
      <Field label="Observação (opcional)"><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: falar com o dono" autoFocus
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); }} /></Field>
      <Field label="Objeção (opcional)"><input value={objection} onChange={(e) => setObjection(e.target.value)} placeholder="Ex.: achou caro, já tem fornecedor" /></Field>
    </Modal>
  );
}

const headerMap: [RegExp, string][] = [
  [/^(nome|name|raz[aã]o|fantasia|empresa|farm[aá]cia|estabelecimento)/i, "nome"],
  [/^(telefone ?2|phone ?2|fone ?2|tel ?2|celular)/i, "telefone2"],
  [/^(telefone|phone|fone|tel|whats|n[uú]mero)/i, "telefone"],
  [/^(cidade|munic[ií]pio|city)/i, "cidade"],
  [/^(uf|estado|state)$/i, "uf"],
  [/^(bairro|district)/i, "bairro"],
  [/^cnpj/i, "cnpj"],
];

function DialImportModal({ defaultList, onClose, onDone }: { defaultList: string; onClose: () => void; onDone: (list: string) => void }) {
  const { tenantId, notify } = useCrm();
  const [listName, setListName] = useState(defaultList);
  const [file, setFile] = useState<{ name: string; rows: Record<string, string>[]; mapped: string[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; inserted: number; duplicates: number; invalid: number } | null>(null);

  async function onFile(f?: File) {
    if (!f) return;
    const parsed = parseCsv(await f.text());
    const keys = parsed.headers.map((h) => headerMap.find(([re]) => re.test(h.trim()))?.[1] ?? "");
    if (!keys.includes("telefone")) { notify("Não encontrei a coluna de telefone. Use um cabeçalho como “telefone”."); return; }
    const rows = parsed.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]).filter(([k]) => k))) as Record<string, string>[];
    setFile({ name: f.name, rows, mapped: parsed.headers.map((h, i) => `${h} → ${keys[i] || "ignorada"}`) });
  }

  async function run() {
    if (!file) return;
    const total = file.rows.length;
    const acc = { done: 0, total, inserted: 0, duplicates: 0, invalid: 0 };
    setProgress({ ...acc });
    try {
      for (let i = 0; i < total; i += 2000) {
        const r = await api.dialImport(tenantId, listName.trim() || "Farmácias", file.rows.slice(i, i + 2000));
        acc.done = Math.min(total, i + 2000); acc.inserted += r.inserted; acc.duplicates += r.duplicates; acc.invalid += r.invalid;
        setProgress({ ...acc });
      }
      notify(`${acc.inserted.toLocaleString("pt-BR")} número(s) importado(s)`);
      onDone(listName.trim() || "Farmácias");
    } catch (e) { notify(errorText(e)); }
  }

  const pct = useMemo(() => (progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0), [progress]);
  return (
    <Modal open onClose={onClose} title="Importar números" width={520}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Fechar</button><button type="button" className="crm-btn primary" onClick={run} disabled={!file || !!progress}>Importar {file ? file.rows.length.toLocaleString("pt-BR") : ""}</button></>}>
      <Field label="Nome da lista"><input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Farmácias" /></Field>
      {!file ? (
        <label className="crm-dropzone">
          <Upload size={26} />
          <strong>Escolha o arquivo .csv</strong>
          <span>Colunas: nome, telefone, cidade, uf (bairro e cnpj opcionais). Números repetidos são ignorados.</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      ) : (
        <div className="crm-stack tight">
          <p><strong>{file.name}</strong> · {file.rows.length.toLocaleString("pt-BR")} linha(s)</p>
          <p className="crm-muted small">{file.mapped.join(" · ")}</p>
        </div>
      )}
      {progress && (
        <div className="crm-stack tight">
          <div className="crm-progress"><i style={{ width: `${pct}%` }} /></div>
          <p className="crm-muted small">{pct}% · {progress.inserted.toLocaleString("pt-BR")} novos · {progress.duplicates.toLocaleString("pt-BR")} repetidos · {progress.invalid} sem telefone válido</p>
        </div>
      )}
    </Modal>
  );
}
