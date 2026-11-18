// Importar leads/negociações de outros CRMs (RD Station CRM e Marketing, Pipedrive, HubSpot, Kommo, planilhas).
// Lê CSV ou Excel, reconhece as colunas de cada CRM, mostra a prévia e importa em lotes.
// Toda negociação importada cria (ou reaproveita) o contato — fica também em Contatos.
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { downloadCsv, parseCsv } from "./csv";
import { errorText } from "./format";
import { Field, Modal, Segmented } from "./ui";

type Entity = "contacts" | "deals";
type Origin = "rd_crm" | "rd_mkt" | "pipedrive" | "hubspot" | "kommo" | "other";

export const ORIGINS: Record<Origin, { label: string; how: string; entity: Entity }> = {
  rd_crm: { label: "RD Station CRM", entity: "deals", how: "No RD Station CRM: Negociações → filtre o que quiser → botão “Exportar” (CSV ou Excel). O arquivo chega no seu e-mail." },
  rd_mkt: { label: "RD Station Marketing", entity: "contacts", how: "No RD Station Marketing: Contatos → Base de Leads → selecione a segmentação → “Exportar” (CSV). O arquivo chega no seu e-mail." },
  pipedrive: { label: "Pipedrive", entity: "deals", how: "No Pipedrive: Negócios → … → “Exportar resultados do filtro” (CSV ou Excel)." },
  hubspot: { label: "HubSpot", entity: "deals", how: "No HubSpot: CRM → Negócios → “Exportar” (CSV ou XLSX), incluindo as associações de contato." },
  kommo: { label: "Kommo", entity: "deals", how: "No Kommo: Leads → … → “Exportar” (Excel ou CSV)." },
  other: { label: "Outro CRM ou planilha", entity: "deals", how: "Qualquer CSV ou Excel com uma linha de títulos (nome, telefone, e-mail, valor, etapa…)." },
};

// campos que a importação entende
const FIELDS: Record<Entity, { v: string; l: string }[]> = {
  deals: [
    { v: "title", l: "Nome da negociação" }, { v: "value", l: "Valor" }, { v: "stage", l: "Etapa" }, { v: "pipeline", l: "Funil (de origem)" },
    { v: "deal_status", l: "Situação (aberta/vendida/perdida)" }, { v: "lost_reason", l: "Motivo da perda" },
    { v: "expected_close_date", l: "Previsão de fechamento" }, { v: "created_at", l: "Data de criação (origem)" },
    { v: "name", l: "Nome do contato" }, { v: "phone", l: "Telefone do contato" }, { v: "email", l: "E-mail do contato" },
    { v: "company", l: "Empresa" }, { v: "job_title", l: "Cargo" }, { v: "city", l: "Cidade" }, { v: "state", l: "UF" },
    { v: "source", l: "Origem / fonte" }, { v: "tags", l: "Tags" }, { v: "owner_email", l: "E-mail do responsável" },
    { v: "owner_name", l: "Responsável (nome, vai para a anotação)" }, { v: "external_id", l: "ID na origem (evita duplicar)" }, { v: "notes", l: "Anotações" },
  ],
  contacts: [
    { v: "name", l: "Nome" }, { v: "phone", l: "Telefone" }, { v: "email", l: "E-mail" }, { v: "company", l: "Empresa" }, { v: "job_title", l: "Cargo" },
    { v: "city", l: "Cidade" }, { v: "state", l: "UF" }, { v: "source", l: "Origem" }, { v: "utm_source", l: "UTM source" }, { v: "utm_medium", l: "UTM medium" },
    { v: "utm_campaign", l: "UTM campaign" }, { v: "tags", l: "Tags" }, { v: "owner_email", l: "E-mail do responsável" },
    { v: "owner_name", l: "Responsável (nome, vai para a anotação)" }, { v: "created_at", l: "Data de criação (origem)" }, { v: "notes", l: "Anotações" },
  ],
};

// nomes de coluna dos CRMs (sem acento, minúsculas). A 1ª regra que casar vence.
const ALIASES: [string, string[]][] = [
  ["external_id", ["id", "id da negociacao", "negocio - id", "record id", "deal id", "id do lead", "id da oportunidade", "identificador"]],
  ["title", ["nome da negociacao", "negociacao", "negocio - titulo", "titulo", "deal name", "nome do lead", "oportunidade", "nome do negocio"]],
  ["value", ["valor unico", "valor", "valor total", "negocio - valor", "amount", "venda", "orcamento", "valor da negociacao", "receita"]],
  ["pipeline", ["funil de vendas", "funil", "pipeline", "negocio - funil", "deal pipeline"]],
  ["stage", ["etapa", "etapa do funil", "etapa do lead", "negocio - etapa", "deal stage", "fase", "estagio"]],
  ["deal_status", ["estado", "status", "situacao", "negocio - status", "status da negociacao", "status do lead"]],
  ["lost_reason", ["motivo de perda", "motivo da perda", "negocio - motivo da perda", "closed lost reason", "motivo de perda (lead)"]],
  ["expected_close_date", ["previsao de fechamento", "data prevista de fechamento", "negocio - data prevista de fechamento", "close date", "data de fechamento", "fechamento previsto"]],
  ["created_at", ["data de criacao", "criado em", "negocio - criado em", "create date", "data da primeira conversao", "data de cadastro"]],
  ["owner_email", ["email do responsavel", "e-mail do responsavel", "owner email"]],
  ["owner_name", ["responsavel", "usuario responsavel", "negocio - proprietario", "deal owner", "proprietario", "dono", "vendedor"]],
  ["company", ["empresa", "organizacao - nome", "organizacao", "company", "company name", "razao social", "empresa do contato"]],
  ["name", ["nome", "contatos", "contato", "nome do contato", "pessoa - nome", "contato principal", "first name", "nome completo", "full name"]],
  ["email", ["email", "e-mail", "email do contato", "pessoa - e-mail", "pessoa - email", "email comercial", "email pessoal"]],
  ["phone", ["telefone", "celular", "telefone do contato", "pessoa - telefone", "telefone comercial", "telefone celular", "phone number", "mobile phone", "whatsapp", "phone"]],
  ["job_title", ["cargo", "job title", "pessoa - cargo", "funcao"]],
  ["city", ["cidade", "city"]],
  ["state", ["estado/uf", "uf", "state/region", "estado (uf)"]],
  ["tags", ["tags", "etiquetas", "marcadores", "tags do lead"]],
  ["source", ["fonte", "origem", "origem da primeira conversao", "original source", "canal", "negocio - origem"]],
  ["utm_source", ["utm_source", "utm source"]], ["utm_medium", ["utm_medium", "utm medium"]], ["utm_campaign", ["utm_campaign", "campanha", "utm campaign"]],
  ["notes", ["anotacao", "anotacoes", "observacoes", "observacao", "notas", "notes", "descricao", "description"]],
];
// nomes que mudam de sentido conforme o CRM de origem
const ORIGIN_ALIASES: Partial<Record<Origin, Record<string, string>>> = {
  rd_crm: { nome: "title", "nome da negociacao": "title", contatos: "name", "contato": "name", estado: "deal_status" },
  kommo: { "nome do lead": "title", "contato principal": "name", venda: "value" },
  pipedrive: { titulo: "title", "pessoa - nome": "name" },
};
const norm = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
function guess(header: string, entity: Entity, used: Set<string>, origin: Origin): string {
  const h = norm(header);
  const allowed = new Set(FIELDS[entity].map((f) => f.v));
  const special = ORIGIN_ALIASES[origin]?.[h];
  if (special && entity === "deals" && allowed.has(special) && !used.has(special)) return special;
  for (const [field, list] of ALIASES) {
    if (!allowed.has(field) || used.has(field)) continue;
    if (list.includes(h)) return field;
  }
  // "Estado" no RD Marketing é a UF; no RD CRM é a situação da negociação
  if (h === "estado" && entity === "contacts" && !used.has("state")) return "state";
  return "";
}
function autoMap(headers: string[], entity: Entity, origin: Origin) {
  const used = new Set<string>();
  // primeiro os nomes específicos do CRM, depois os genéricos
  const first = headers.map((h) => { const n = norm(h); const sp = ORIGIN_ALIASES[origin]?.[n]; return entity === "deals" && sp && !used.has(sp) ? (used.add(sp), sp) : ""; });
  return headers.map((h, i) => { if (first[i]) return first[i]; const f = guess(h, entity, used, origin); if (f) used.add(f); return f; });
}

async function readFile(f: File): Promise<{ headers: string[]; rows: string[][] }> {
  if (/\.xlsx$/i.test(f.name)) {
    const { readSheet } = await import("read-excel-file/browser");
    const data = await readSheet(f);
    const cell = (v: unknown) => v instanceof Date
      ? `${String(v.getUTCDate()).padStart(2, "0")}/${String(v.getUTCMonth() + 1).padStart(2, "0")}/${v.getUTCFullYear()}`
      : v == null ? "" : String(v).trim();
    const rows = data.map((r) => r.map(cell)).filter((r) => r.some(Boolean));
    return { headers: rows[0] ?? [], rows: rows.slice(1) };
  }
  if (/\.xls$/i.test(f.name)) throw new Error("Arquivo .xls antigo: abra no Excel e salve como .xlsx ou CSV.");
  return parseCsv(await f.text());
}

export function CrmImportModal({ defaultEntity = "deals", onClose, onDone }: { defaultEntity?: Entity; onClose: () => void; onDone: () => void }) {
  const { tenantId, notify, navigate } = useCrm();
  const [origin, setOrigin] = useState<Origin>("rd_crm");
  const [entity, setEntity] = useState<Entity>(defaultEntity);
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<string[]>([]);
  const [closed, setClosed] = useState<"skip" | "import_status" | "import_open">("skip");
  const [onDup, setOnDup] = useState<"skip" | "update">("update");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: number; contacts: number; report: { row: number; status: string; message: string }[] } | null>(null);

  const records = useMemo(() => {
    if (!file) return [] as Record<string, string>[];
    return file.rows.map((r) => {
      const o: Record<string, string> = {};
      map.forEach((f, i) => { const v = (r[i] ?? "").trim(); if (f && v) o[f] = o[f] ? `${o[f]}${f === "notes" ? "\n" : " "}${v}` : v; });
      return o;
    }).filter((o) => Object.keys(o).length > 0);
  }, [file, map]);
  const closedCount = useMemo(() => records.filter((r) => /(vendid|ganh|won|perdid|lost|cancel)/i.test(r.deal_status ?? "")).length, [records]);
  const warnings = useMemo(() => {
    const w: string[] = [];
    if (!records.length) return w;
    const noId = records.filter((r) => !r.phone && !r.email && !r.name && !r.title).length;
    if (noId) w.push(`${noId} linha(s) sem nome, telefone ou e-mail serão recusadas.`);
    if (!map.includes("phone") && !map.includes("email")) w.push("Nenhuma coluna de telefone ou e-mail mapeada — os contatos ficam sem forma de contato.");
    if (entity === "deals" && !map.includes("title") && !map.includes("name")) w.push("Mapeie “Nome da negociação” ou “Nome do contato”.");
    return w;
  }, [records, map, entity]);

  async function onFile(f?: File) {
    if (!f) return;
    try {
      const parsed = await readFile(f);
      if (!parsed.headers.length || !parsed.rows.length) { notify("Arquivo vazio ou sem linha de títulos."); return; }
      setFile({ name: f.name, ...parsed });
      setMap(autoMap(parsed.headers, entity, origin));
      setResult(null);
    } catch (e) { notify(errorText(e)); }
  }

  async function run() {
    const total = { created: 0, updated: 0, skipped: 0, errors: 0, contacts: 0, report: [] as { row: number; status: string; message: string }[] };
    const chunk = 1000;
    try {
      for (let i = 0; i < records.length; i += chunk) {
        setBusy(`Importando ${Math.min(i + chunk, records.length)} de ${records.length}…`);
        const r = await api.importRows(tenantId, entity, records.slice(i, i + chunk), {
          on_duplicate: onDup, origin: ORIGINS[origin].label, unknown_stage: "first", closed_deals: closed,
        }, file?.name ?? "importacao.csv") as Awaited<ReturnType<typeof api.importRows>> & { contacts_created?: number };
        total.created += r.created; total.updated += r.updated; total.skipped += r.skipped; total.errors += r.errors;
        total.contacts += r.contacts_created ?? 0;
        total.report.push(...r.report.map((x) => ({ ...x, row: x.row + i })));
      }
      setResult(total);
      notify(`Importação concluída: ${total.created} ${entity === "deals" ? "negociação(ões)" : "contato(s)"} criado(s)`);
      onDone();
    } catch (e) { notify(errorText(e)); } finally { setBusy(null); }
  }

  const fields = FIELDS[entity];
  const shown = Array.from(new Set(map.filter(Boolean)));
  return (
    <Modal open onClose={onClose} title="Importar de outro CRM" width={860}
      footer={result ? <>
        <button type="button" className="crm-btn ghost" onClick={() => { setResult(null); setFile(null); }}>Importar outro arquivo</button>
        <button type="button" className="crm-btn primary" onClick={() => { onClose(); navigate({ name: entity === "deals" ? "deals" : "contacts" }); }}>Ver {entity === "deals" ? "negociações" : "contatos"}</button>
      </> : <>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={!!busy || !records.length} onClick={run}>{busy ?? `Importar ${records.length} ${entity === "deals" ? "negociação(ões)" : "contato(s)"}`}</button>
      </>}>
      {result ? (
        <div className="crm-import-result">
          <p><CheckCircle2 size={18} className="tone-green" /> <b>{result.created}</b> {entity === "deals" ? "negociação(ões) criada(s)" : "contato(s) criado(s)"}
            {entity === "deals" && <> · <b>{result.contacts}</b> contato(s) novo(s) em Contatos</>}
            {result.updated > 0 && <> · <b>{result.updated}</b> atualizado(s)</>} · <b>{result.skipped}</b> ignorado(s) · <b className={result.errors ? "danger-text" : ""}>{result.errors}</b> erro(s)</p>
          {result.report.length > 0 && <>
            <button type="button" className="crm-btn ghost sm" onClick={() => downloadCsv("relatorio-importacao.csv", result.report.map((r) => ({ linha: r.row, situacao: r.status, mensagem: r.message })))}><Download size={14} /> Baixar relatório</button>
            <ul className="crm-report">{result.report.slice(0, 20).map((r) => <li key={`${r.row}-${r.message}`} className={r.status}>Linha {r.row}: {r.message}</li>)}</ul>
          </>}
          <p className="crm-muted small">Nada foi enviado aos contatos: importar não dispara automações, cadências nem WhatsApp.</p>
        </div>
      ) : <>
        <div className="crm-form-grid">
          <Field label="De onde vêm os dados">
            <select value={origin} onChange={(e) => { const o = e.target.value as Origin; setOrigin(o); const ent = ORIGINS[o].entity; setEntity(ent); if (file) setMap(autoMap(file.headers, ent, o)); }}>
              {(Object.keys(ORIGINS) as Origin[]).map((o) => <option key={o} value={o}>{ORIGINS[o].label}</option>)}
            </select>
          </Field>
          <Field label="O arquivo tem">
            <Segmented value={entity} onChange={(v) => { setEntity(v); if (file) setMap(autoMap(file.headers, v, origin)); }}
              options={[{ value: "deals", label: "Negociações" }, { value: "contacts", label: "Só contatos / leads" }]} />
          </Field>
        </div>
        <p className="crm-muted small">{ORIGINS[origin].how}</p>

        {!file ? (
          <label className="crm-dropzone">
            <FileSpreadsheet size={28} />
            <strong>Escolha o arquivo exportado (.csv ou .xlsx)</strong>
            <span>{entity === "deals" ? "Cada negociação entra no funil e o contato dela fica em Contatos." : "Os leads entram em Contatos."}</span>
            <input type="file" accept=".csv,.txt,.xlsx,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        ) : (
          <div className="crm-stack">
            <div className="crm-row between"><span><strong>{file.name}</strong> · {file.rows.length} linha(s)</span><button type="button" className="crm-link" onClick={() => { setFile(null); setResult(null); }}>Trocar arquivo</button></div>
            <h4 className="crm-subhead">1. Colunas (reconhecidas automaticamente — confira)</h4>
            <div className="crm-mapping">
              {file.headers.map((h, i) => (
                <div key={i} className="crm-map-row">
                  <span><strong>{h || `Coluna ${i + 1}`}</strong><small>{file.rows.slice(0, 2).map((r) => r[i]).filter(Boolean).join(" · ").slice(0, 80)}</small></span>
                  <select value={map[i] ?? ""} onChange={(e) => setMap((m) => m.map((x, j) => (j === i ? e.target.value : x)))}>
                    <option value="">Não importar</option>
                    {fields.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <h4 className="crm-subhead">2. Prévia ({records.length})</h4>
            <div className="crm-table-wrap small">
              <table className="crm-table compact">
                <thead><tr>{shown.map((f) => <th key={f}>{fields.find((x) => x.v === f)?.l ?? f}</th>)}</tr></thead>
                <tbody>{records.slice(0, 5).map((r, i) => <tr key={i} className="static">{shown.map((f) => <td key={f}>{(r[f] ?? "").slice(0, 60)}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {warnings.length > 0 && <div className="crm-callout warn"><AlertTriangle size={15} /><span>{warnings.join(" ")}</span></div>}
            <h4 className="crm-subhead">3. Opções</h4>
            {entity === "deals" && <>
              <Field label={`Negociações vendidas ou perdidas na origem${closedCount ? ` (${closedCount} no arquivo)` : ""}`}>
                <Segmented size="sm" value={closed} onChange={setClosed} options={[
                  { value: "skip", label: "Não importar" }, { value: "import_status", label: "Importar como ganhas/perdidas" }, { value: "import_open", label: "Importar como abertas" },
                ]} />
              </Field>
              <p className="crm-muted small">Etapa que não existe no seu funil vai para a primeira etapa; o nome da etapa, o funil e o responsável de origem ficam anotados no histórico.</p>
            </>}
            <Field label="Contato que já existe (mesmo telefone ou e-mail)">
              <Segmented size="sm" value={onDup} onChange={setOnDup} options={[{ value: "update", label: "Completar os dados" }, { value: "skip", label: "Não mexer" }]} />
            </Field>
            <p className="crm-muted small">Importar não dispara automações, cadências nem mensagens de WhatsApp. Reimportar o mesmo arquivo não duplica negociações (quando há a coluna de ID).</p>
          </div>
        )}
      </>}
    </Modal>
  );
}
