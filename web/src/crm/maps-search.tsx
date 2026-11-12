import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, KeyRound, MapPin, Pencil, Play, Plus, RefreshCw, Search, Star, Trash2, Zap } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { dateTime, errorText, phoneLabel, relative } from "./format";
import type { LeadSource, LeadSourceRunResult, MapsPlace, MapsStatus, WaCampaign } from "./types";
import { Bar, Confirm, Empty, Field, Modal, Pill, Skeleton } from "./ui";

const intervals = [
  { v: 24, label: "Todo dia" }, { v: 48, label: "A cada 2 dias" }, { v: 72, label: "A cada 3 dias" }, { v: 168, label: "Toda semana" },
];

function scheduleLabel(s: LeadSource) {
  if (!s.auto) return "Só quando clicar em “Buscar agora”";
  const every = intervals.find((i) => i.v === s.interval_hours)?.label ?? `A cada ${s.interval_hours} h`;
  return `${every} às ${s.run_hour}h${s.next_run_at ? ` · próxima ${relative(s.next_run_at)}` : ""}`;
}

export function MapsSearchView({ campaigns, onCampaignsChanged }: { campaigns: WaCampaign[]; onCampaignsChanged: () => void }) {
  const { tenantId, access, notify, refreshKey } = useCrm();
  const [status, setStatus] = useState<MapsStatus | null>(null);
  const [sources, setSources] = useState<LeadSource[] | null>(null);
  const [editing, setEditing] = useState<LeadSource | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ source: LeadSource; r: LeadSourceRunResult } | null>(null);
  const [removing, setRemoving] = useState<LeadSource | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [st, src] = await Promise.all([api.mapsStatus(tenantId), api.leadSources(tenantId)]);
      setStatus(st); setSources(src);
    } catch (e) { notify(errorText(e)); setSources([]); }
  }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function run(s: LeadSource) {
    setRunning(s.id);
    try {
      const r = await api.mapsRunSource(s.id);
      setResult({ source: s, r });
      if (r.to_campaign) onCampaignsChanged();
    } catch (e) { notify(errorText(e)); }
    finally { setRunning(null); void load(); }
  }

  const campName = (id: string | null) => campaigns.find((c) => c.id === id)?.name;
  const usagePct = status ? status.calls_this_month / Math.max(1, status.monthly_call_limit) : 0;

  return (
    <div className="maps-view">
      <section className={`crm-card maps-key ${status?.has_key ? "ok" : ""}`}>
        <div className="wa-conn-head">
          <div className="wa-conn-icon"><MapPin size={20} /></div>
          <div className="wa-conn-text">
            <strong>{status?.has_key ? `Google Maps conectado · chave …${status.key_hint}` : "Conecte o Google Maps para buscar clientes automaticamente"}</strong>
            {status && (
              <span className="crm-muted">
                {status.calls_this_month} de {status.monthly_call_limit} buscas usadas este mês (cada busca traz até 20 lugares)
              </span>
            )}
            {status && <Bar value={status.calls_this_month} max={status.monthly_call_limit} tone={usagePct > 0.9 ? "red" : usagePct > 0.7 ? "amber" : "green"} />}
          </div>
          {access.configure && <button type="button" className={`crm-btn ${status?.has_key ? "ghost" : "primary"}`} onClick={() => setKeyOpen(true)}><KeyRound size={15} /> {status?.has_key ? "Configurar" : "Conectar Google Maps"}</button>}
        </div>
      </section>

      <div className="crm-toolbar">
        <div className="crm-toolbar-left"><p className="crm-muted small" style={{ margin: 0 }}>Os clientes encontrados vão para o <b>Discador</b> (com posição no Google, nota e avaliações) e, se você quiser, direto para um <b>disparo</b>.</p></div>
        {access.write && <button type="button" className="crm-btn primary" disabled={!status?.has_key} title={!status?.has_key ? "Conecte o Google Maps primeiro" : undefined} onClick={() => setEditing("new")}><Plus size={16} /> Nova busca</button>}
      </div>

      {!sources ? <Skeleton rows={2} height={100} /> : sources.length === 0 ? (
        <Empty icon={<Search size={22} />} title="Nenhuma busca salva"
          text="Ex.: “farmácia” em uma lista de bairros. Todo dia o CRO busca nos próximos bairros, traz só clientes novos com telefone e pode alimentar um disparo sozinho." />
      ) : (
        <div className="wa-camp-list">
          {sources.map((s) => {
            const lr = s.last_result;
            const isRunning = running === s.id || (!!s.running_since && Date.now() - new Date(s.running_since).getTime() < 600_000);
            return (
              <article key={s.id} className="crm-card wa-camp">
                <header>
                  <div className="wa-camp-title" style={{ cursor: "default" }}>
                    <strong>{s.name}</strong>
                    {s.auto ? <Pill tone="green"><Zap size={11} /> Automática</Pill> : <Pill>Manual</Pill>}
                  </div>
                  <div className="wa-camp-actions">
                    {access.write && <button type="button" className="crm-btn primary sm" disabled={isRunning || !status?.has_key} onClick={() => run(s)}>
                      {isRunning ? <><RefreshCw size={14} className="spin" /> Buscando…</> : <><Play size={14} /> Buscar agora</>}
                    </button>}
                    {access.write && <button type="button" className="crm-btn ghost sm" onClick={() => setEditing(s)}><Pencil size={14} /> Editar</button>}
                    {access.write && <button type="button" className="crm-icon-btn" title="Excluir busca" onClick={() => setRemoving(s)}><Trash2 size={16} /></button>}
                  </div>
                </header>
                <p className="wa-camp-msg">
                  “{s.query}” em {s.locations.length} local(is) · {s.locations_per_run} por vez (próximo: {s.locations[s.location_cursor % Math.max(1, s.locations.length)]}) → lista <b>{s.list_name}</b>
                  {s.campaign_id && <> → disparo <b>{campName(s.campaign_id) ?? "—"}</b></>}
                </p>
                <footer className="crm-muted small">
                  <CalendarClock size={13} /> {scheduleLabel(s)}
                  {lr && s.last_run_at && <> · última: {relative(s.last_run_at)} — {lr.error ? <span className="tone-red">{lr.error}</span> : <><b>{lr.inserted}</b> novos de {lr.found} encontrados{lr.to_campaign ? `, ${lr.to_campaign} no disparo` : ""}</>}</>}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {keyOpen && <KeyModal status={status} onClose={() => setKeyOpen(false)} onSaved={() => { setKeyOpen(false); void load(); }} />}
      {editing && <SourceEditor source={editing === "new" ? null : editing} campaigns={campaigns}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); onCampaignsChanged(); }} />}
      {result && <RunResult source={result.source} r={result.r} onClose={() => setResult(null)} />}
      <Confirm open={!!removing} onClose={() => setRemoving(null)} danger confirmLabel="Excluir busca"
        title="Excluir esta busca?" text="Os clientes que ela já trouxe continuam no discador e nos disparos."
        onConfirm={async () => { try { await api.deleteLeadSource(removing!.id); notify("Busca excluída"); void load(); } catch (e) { notify(errorText(e)); } }} />
    </div>
  );
}

function KeyModal({ status, onClose, onSaved }: { status: MapsStatus | null; onClose: () => void; onSaved: () => void }) {
  const { tenantId, notify } = useCrm();
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(status?.monthly_call_limit ?? 900);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      if (key.trim()) await api.mapsSetKey(tenantId, key.trim());
      if (limit !== status?.monthly_call_limit) await api.mapsSetLimit(tenantId, limit);
      notify("Google Maps configurado"); onSaved();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api.mapsRemoveKey(tenantId); notify("Chave removida"); onSaved(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Conectar Google Maps" width={600}
      footer={<>
        {status?.has_key && <button type="button" className="crm-btn ghost danger-text" disabled={busy} onClick={remove} style={{ marginRight: "auto" }}>Remover chave</button>}
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || (!key.trim() && limit === status?.monthly_call_limit)} onClick={save}>Salvar</button>
      </>}>
      <ol className="maps-steps">
        <li>Abra o <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noreferrer">Google Cloud → Places API (New) <ExternalLink size={12} /></a> e clique em <b>Ativar</b> (o projeto precisa ter faturamento ativo; há uma cota gratuita todo mês).</li>
        <li>Em <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Credenciais <ExternalLink size={12} /></a> → <b>Criar credenciais → Chave de API</b>. Recomendado: restrinja a chave à “Places API (New)”.</li>
        <li>Cole a chave abaixo. Ela fica guardada criptografada e nunca aparece de novo na tela.</li>
      </ol>
      <div className="crm-form-grid">
        <Field label={status?.has_key ? `Nova chave (atual termina em …${status.key_hint})` : "Chave de API do Google"} span={2}>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Limite de buscas por mês" hint="cada busca = até 20 lugares; protege contra cobrança inesperada">
          <input type="number" min={0} max={100000} value={limit} onChange={(e) => setLimit(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
      </div>
    </Modal>
  );
}

function SourceEditor({ source, campaigns, onClose, onSaved }: { source: LeadSource | null; campaigns: WaCampaign[]; onClose: () => void; onSaved: () => void }) {
  const { tenantId, notify } = useCrm();
  const [name, setName] = useState(source?.name ?? "");
  const [query, setQuery] = useState(source?.query ?? "farmácia");
  const [locs, setLocs] = useState((source?.locations ?? []).join("\n"));
  const [list, setList] = useState(source?.list_name ?? "Farmácias (Google Maps)");
  const [lists, setLists] = useState<string[]>([]);
  const [perRun, setPerRun] = useState(source?.locations_per_run ?? 5);
  const [pages, setPages] = useState(source?.pages_per_location ?? 3);
  const [maxNew, setMaxNew] = useState(source?.max_new_per_run ?? 60);
  const [noChains, setNoChains] = useState(source?.exclude_chains ?? true);
  const [minRating, setMinRating] = useState<string>(source?.min_rating != null ? String(source.min_rating) : "");
  const [auto, setAuto] = useState(source?.auto ?? true);
  const [interval, setInterval_] = useState(source?.interval_hours ?? 24);
  const [hour, setHour] = useState(source?.run_hour ?? 7);
  const [campaignId, setCampaignId] = useState<string>(source?.campaign_id ?? "");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ places: MapsPlace[]; closed: number; loc: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => { api.waDialLists(tenantId).then((l) => setLists(l.map((x) => x.name))).catch(() => {}); }, [tenantId]);

  const locations = locs.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const openCampaigns = campaigns.filter((c) => c.status === "draft" || c.status === "running" || c.status === "paused");
  const callsPerRun = Math.min(perRun, Math.max(1, locations.length)) * pages;

  async function doPreview() {
    if (!locations[0]) return notify("Informe pelo menos um local");
    setPreviewing(true);
    try { const r = await api.mapsPreview(tenantId, query, locations[0]); setPreview({ ...r, loc: locations[0] }); }
    catch (e) { notify(errorText(e)); } finally { setPreviewing(false); }
  }

  async function save() {
    setBusy(true);
    try {
      await api.saveLeadSource(tenantId, source?.id ?? null, {
        name, query, locations, list_name: list, auto, interval_hours: interval, run_hour: hour, locations_per_run: perRun,
        max_new_per_run: maxNew, exclude_chains: noChains, min_rating: minRating ? Number(minRating) : null,
        campaign_id: campaignId || null, pages_per_location: pages,
      });
      if (campaignId) {
        const c = campaigns.find((x) => x.id === campaignId);
        if (c && !c.auto_feed) await api.waSetAutoFeed(campaignId, true);
      }
      notify(source ? "Busca atualizada" : auto ? "Busca automática criada" : "Busca criada");
      onSaved();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={source ? "Editar busca" : "Nova busca no Google Maps"} width={760}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || !query.trim() || !locations.length || !list.trim()} onClick={save}>Salvar</button>
      </>}>
      <div className="crm-form-grid">
        <Field label="O que buscar"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="farmácia, drogaria, clínica odontológica…" /></Field>
        <Field label="Nome da busca"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${query || "farmácia"} — Grande SP`} /></Field>
        <Field label={`Cidades ou bairros (um por linha) · ${locations.length}`} span={2} hint="Ex.: “Moema, São Paulo SP”. Cada execução usa os próximos da lista, então todo dia entram clientes novos.">
          <textarea rows={6} value={locs} onChange={(e) => setLocs(e.target.value)} placeholder={"Moema, São Paulo SP\nTatuapé, São Paulo SP\nCampinas SP\nSanto André SP"} />
        </Field>
        <Field label="Lista do discador onde entram">
          <input list="maps-lists" value={list} onChange={(e) => setList(e.target.value)} />
          <datalist id="maps-lists">{lists.map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
        <Field label="Enviar também para o disparo" hint="O disparo fica ligado esperando novos clientes (alimentação automática).">
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Não — só o discador</option>
            {openCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.auto_feed ? " (automático)" : ""}</option>)}
          </select>
        </Field>
      </div>

      <h4 className="wa-sub"><Zap size={15} /> Automático</h4>
      <div className="crm-form-grid">
        <label className="crm-check" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Buscar sozinho, sem eu precisar clicar</label>
        {auto && <>
          <Field label="Frequência"><select value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>{intervals.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}</select></Field>
          <Field label="Horário"><select value={hour} onChange={(e) => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}h</option>)}</select></Field>
        </>}
        <Field label="Locais por execução"><input type="number" min={1} max={50} value={perRun} onChange={(e) => setPerRun(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        <Field label="Páginas por local" hint="1 página = até 20 resultados (máx. 3)"><select value={pages} onChange={(e) => setPages(Number(e.target.value))}>{[1, 2, 3].map((p) => <option key={p} value={p}>{p} ({p * 20} resultados)</option>)}</select></Field>
        <Field label="Máximo de clientes novos por execução"><input type="number" min={1} max={1000} value={maxNew} onChange={(e) => setMaxNew(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        <Field label="Nota mínima no Google"><select value={minRating} onChange={(e) => setMinRating(e.target.value)}><option value="">Qualquer nota</option>{["3.5", "4.0", "4.3", "4.5"].map((r) => <option key={r} value={r}>{r.replace(".", ",")}+</option>)}</select></Field>
        <label className="crm-check" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={noChains} onChange={(e) => setNoChains(e.target.checked)} /> Ignorar redes e franquias (Drogasil, Raia, Pague Menos, Pacheco, Panvel…)</label>
      </div>
      <p className="crm-muted small">Custo por execução: até <b>{callsPerRun}</b> busca(s) no Google. Clientes que já estão no discador, que pediram SAIR, sem telefone ou fechados não entram.</p>

      <div className="maps-preview-bar">
        <button type="button" className="crm-btn ghost sm" disabled={previewing || !locations[0] || !query.trim()} onClick={doPreview}>
          {previewing ? <RefreshCw size={14} className="spin" /> : <Search size={14} />} Testar em “{locations[0] ?? "…"}” (1 busca)
        </button>
      </div>
      {preview && (
        <div className="crm-table-wrap maps-preview">
          <table className="crm-table">
            <thead><tr><th>Nº</th><th>Nome</th><th>Telefone</th><th>Nota</th><th>Bairro / cidade</th><th></th></tr></thead>
            <tbody>
              {preview.places.map((p) => (
                <tr key={p.place_id} className={p.already ? "muted" : ""}>
                  <td>{p.rank}º</td>
                  <td>{p.maps_url ? <a href={p.maps_url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</td>
                  <td>{p.phone ? phoneLabel(p.phone.replace(/\D/g, "").length <= 11 ? "55" + p.phone.replace(/\D/g, "") : p.phone.replace(/\D/g, "")) : <span className="crm-muted">sem telefone</span>}</td>
                  <td>{p.rating != null ? <><Star size={12} /> {p.rating.toFixed(1).replace(".", ",")} ({p.reviews ?? 0})</> : "—"}</td>
                  <td>{[p.district, p.city].filter(Boolean).join(" · ")}</td>
                  <td>{p.already && <Pill>já no discador</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="crm-muted small">{preview.places.length} lugares abertos{preview.closed ? ` · ${preview.closed} fechado(s) ignorado(s)` : ""}. A prévia não grava nada.</p>
        </div>
      )}
    </Modal>
  );
}

function RunResult({ source, r, onClose }: { source: LeadSource; r: LeadSourceRunResult; onClose: () => void }) {
  const { navigate } = useCrm();
  return (
    <Modal open onClose={onClose} title={`Resultado: ${source.name}`} width={520}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Fechar</button>
        {r.inserted > 0 && <button type="button" className="crm-btn primary" onClick={() => { onClose(); navigate({ name: "dialer" }); }}>Abrir no discador</button>}
      </>}>
      <div className="wa-result">
        {r.error ? <AlertTriangle size={28} className="tone-red" /> : <CheckCircle2 size={28} className="tone-green" />}
        {r.error && <p className="tone-red">{r.error}</p>}
        <p><b>{r.inserted}</b> cliente(s) novo(s) na lista “{source.list_name}”{r.to_campaign ? <> e <b>{r.to_campaign}</b> no disparo</> : null}</p>
        <ul className="crm-muted small">
          <li>{r.found} lugares encontrados em {r.api_calls} busca(s)</li>
          {r.duplicates > 0 && <li>{r.duplicates} já estavam no discador</li>}
          {r.no_phone > 0 && <li>{r.no_phone} sem telefone</li>}
          {r.chains > 0 && <li>{r.chains} redes/franquias ignoradas</li>}
          {r.low_rating > 0 && <li>{r.low_rating} abaixo da nota mínima</li>}
          {r.opted_out > 0 && <li>{r.opted_out} tinham pedido SAIR</li>}
        </ul>
        <p className="crm-muted small">Rodou em {dateTime(new Date().toISOString())}.</p>
      </div>
    </Modal>
  );
}
