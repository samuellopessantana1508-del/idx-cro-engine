// Extratores de clientes como no FlowZap original: busca rápida no Maps, colar texto e grupos do WhatsApp.
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardPaste, Loader2, MapPin, RefreshCw, ShieldAlert, Tag, Users, Zap } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { errorText, phoneLabel } from "./format";
import type { LeadSource, LeadSourceRunResult, WaCampaign } from "./types";
import { Modal } from "./ui";

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Variações da busca (como no original): o mesmo ramo em várias regiões da cidade, até 3 páginas cada. */
export function quickLocations(cidade: string) {
  const c = cidade.trim();
  return [c, `centro de ${c}`, `zona sul de ${c}`, `zona norte de ${c}`, `zona leste de ${c}`, `zona oeste de ${c}`, `região de ${c}`];
}

// --------------------------------------------------------------------------
// 1) Busca rápida no Google Maps
// --------------------------------------------------------------------------
export function QuickMapsSearch({ hasKey, sources, campaigns, onDone }: { hasKey: boolean; sources: LeadSource[]; campaigns: WaCampaign[]; onDone: () => void }) {
  const crm = useCrm();
  const [ramo, setRamo] = useState("");
  const [cidade, setCidade] = useState("");
  const [qty, setQty] = useState(120);
  const [tag, setTag] = useState("");
  const [tagTouched, setTagTouched] = useState(false);
  const [chains, setChains] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ r: LeadSourceRunResult; list: string; tagged: api.TagImportResult | null } | null>(null);
  const autoTag = ramo && cidade ? slug(`${ramo} ${cidade}`) : "";
  const finalTag = tagTouched ? tag : autoTag;
  const list = ramo && cidade ? `${ramo.trim()} — ${cidade.trim()}` : "";

  const go = async () => {
    setBusy(true);
    try {
      const name = `Busca rápida: ${ramo.trim()} em ${cidade.trim()}`;
      const existing = sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
      const id = await api.saveLeadSource(crm.tenantId, existing?.id ?? null, {
        name, query: ramo.trim(), locations: quickLocations(cidade), list_name: list, auto: false, interval_hours: 24, run_hour: 7,
        locations_per_run: 7, max_new_per_run: qty, exclude_chains: chains, min_rating: null, campaign_id: campaign || null, pages_per_location: 3,
      });
      const since = new Date(Date.now() - 5000).toISOString();
      const r = await api.mapsRunSource(id);
      let tagged: api.TagImportResult | null = null;
      if (finalTag && r.inserted > 0) tagged = await api.mapsSourceToContacts(id, since, finalTag);
      setRes({ r, list, tagged });
      onDone();
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <section className="crm-card ext-card">
      <header className="ext-head">
        <span className="ext-icon maps"><Zap size={18} /></span>
        <div>
          <strong>Busca rápida</strong>
          <span className="crm-muted small">Diga o ramo e a cidade: o CRO procura em várias regiões da cidade e traz até 120 clientes com telefone de uma vez.</span>
        </div>
      </header>
      <div className="ext-grid">
        <label className="ext-field"><span>Ramo</span><input value={ramo} placeholder="farmácia, academia, pet shop…" onChange={(e) => setRamo(e.target.value)} /></label>
        <label className="ext-field"><span>Cidade</span><input value={cidade} placeholder="Campinas SP" onChange={(e) => setCidade(e.target.value)} /></label>
        <label className="ext-field"><span>Quantidade</span>
          <select value={qty} onChange={(e) => setQty(Number(e.target.value))}>
            {[30, 60, 120].map((n) => <option key={n} value={n}>até {n}</option>)}
          </select>
        </label>
        <label className="ext-field"><span><Tag size={12} /> Etiqueta no CRM</span><input value={finalTag} placeholder="opcional" onChange={(e) => { setTagTouched(true); setTag(slug(e.target.value) || e.target.value.toLowerCase()); }} /></label>
        <label className="ext-field"><span>Colocar num disparo</span>
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">Não — só discador e CRM</option>
            {campaigns.filter((c) => ["draft", "running", "paused"].includes(c.status)).map((c) => <option key={c.id} value={c.id}>{c.name}{c.auto_feed ? "" : " (ative “alimentar automaticamente”)"}</option>)}
          </select>
        </label>
        <label className="crm-check ext-check"><input type="checkbox" checked={chains} onChange={(e) => setChains(e.target.checked)} /> Ignorar redes e franquias</label>
      </div>
      <div className="ext-foot">
        <span className="crm-muted small">Vai para o discador na lista <b>{list || "…"}</b>{finalTag ? <> e para Contatos com a etiqueta <b>{finalTag}</b></> : null}. Usa até 21 buscas da sua cota do Google.</span>
        <button type="button" className="crm-btn primary" disabled={!hasKey || busy || !ramo.trim() || !cidade.trim() || !crm.access.write} onClick={() => void go()}
          title={!hasKey ? "Conecte o Google Maps primeiro" : undefined}>
          {busy ? <><Loader2 size={15} className="spin" /> Buscando… (até 1 min)</> : <><MapPin size={15} /> Buscar até {qty} clientes</>}
        </button>
      </div>
      {res && (
        <Modal open onClose={() => setRes(null)} title="Busca rápida concluída" width={500}
          footer={<>
            <button type="button" className="crm-btn ghost" onClick={() => setRes(null)}>Fechar</button>
            {res.r.inserted > 0 && <button type="button" className="crm-btn primary" onClick={() => { setRes(null); crm.navigate({ name: "dialer" }); }}>Abrir no discador</button>}
          </>}>
          <div className="wa-result">
            {res.r.error ? <AlertTriangle size={28} className="tone-red" /> : <CheckCircle2 size={28} className="tone-green" />}
            {res.r.error && <p className="tone-red">{res.r.error}</p>}
            <p><b>{res.r.inserted}</b> cliente(s) novo(s) na lista “{res.list}”{res.r.to_campaign ? <> · <b>{res.r.to_campaign}</b> no disparo</> : null}</p>
            {res.tagged && <p>{res.tagged.created} novo(s) contato(s) no CRM e {res.tagged.existing} já existente(s) com a etiqueta <b>{res.tagged.tag}</b></p>}
            <ul className="crm-muted small">
              <li>{res.r.found} lugares encontrados em {res.r.api_calls} busca(s)</li>
              {res.r.duplicates > 0 && <li>{res.r.duplicates} já estavam no discador</li>}
              {res.r.no_phone > 0 && <li>{res.r.no_phone} sem telefone</li>}
              {res.r.chains > 0 && <li>{res.r.chains} redes/franquias ignoradas</li>}
              {res.r.opted_out > 0 && <li>{res.r.opted_out} tinham pedido SAIR</li>}
            </ul>
          </div>
        </Modal>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------
// 2) Colar texto (lista, planilha, site, PDF copiado…)
// --------------------------------------------------------------------------
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/g;
export function extractPhones(text: string): { phone: string; name: string | null }[] {
  const out = new Map<string, { phone: string; name: string | null }>();
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.match(PHONE_RE) ?? []) {
      let d = m.replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      if (d.length === 10 || d.length === 11) d = `55${d}`;
      if (d.length < 12 || d.length > 13 || !d.startsWith("55")) continue;
      // nome: o que sobrar na linha sem o telefone (ex.: "Farmácia Vida - (19) 99999-0000")
      const rest = line.replace(m, "").replace(/[;|,\t]+/g, " ").replace(/\s[-–:]\s?$/, "").replace(/\s{2,}/g, " ").trim().replace(/^[-–:]\s*|[-–:]$/g, "").trim();
      if (!out.has(d)) out.set(d, { phone: d, name: rest && rest.length <= 80 && /[a-zà-ú]/i.test(rest) && !/\d{4}/.test(rest) ? rest : null });
    }
  }
  return [...out.values()];
}

export function PasteExtractor() {
  const crm = useCrm();
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ contacts: api.TagImportResult; dial: { inserted: number } | null } | null>(null);
  const found = useMemo(() => extractPhones(text), [text]);
  const go = async () => {
    setBusy(true);
    try {
      const contacts = await api.contactsTagImport(crm.tenantId, found, tag.trim() || null, "texto colado");
      const dial = list.trim() ? await api.dialImport(crm.tenantId, list.trim(), found.map((f) => ({ nome: f.name ?? "", telefone: f.phone })), "texto") : null;
      setRes({ contacts, dial });
      setText("");
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="crm-card ext-card">
      <header className="ext-head">
        <span className="ext-icon paste"><ClipboardPaste size={18} /></span>
        <div>
          <strong>Colar números</strong>
          <span className="crm-muted small">Cole qualquer texto — lista, planilha, página de site, conversa. O CRO acha os telefones (e o nome na mesma linha, quando houver).</span>
        </div>
      </header>
      <textarea className="ext-paste" rows={7} value={text} placeholder={"Farmácia Vida - (19) 99999-1234\nDrogaria Central 19 98888-4321\n…"} onChange={(e) => { setText(e.target.value); setRes(null); }} />
      {found.length > 0 && (
        <div className="ext-found">
          <b>{found.length}</b> telefone(s) encontrado(s):
          <span className="ext-chips">{found.slice(0, 8).map((f) => <span key={f.phone} className="fz-chip">{f.name ? `${f.name} · ` : ""}{phoneLabel(f.phone)}</span>)}{found.length > 8 && <span className="crm-muted small">+{found.length - 8}</span>}</span>
        </div>
      )}
      <div className="ext-grid two">
        <label className="ext-field"><span><Tag size={12} /> Etiqueta no CRM</span><input value={tag} placeholder="ex.: lista-feira-2026" onChange={(e) => setTag(e.target.value.slice(0, 40))} /></label>
        <label className="ext-field"><span>Também no discador (lista)</span><input value={list} placeholder="opcional" onChange={(e) => setList(e.target.value.slice(0, 80))} /></label>
      </div>
      <div className="ext-foot">
        {res ? <span className="tone-green small"><CheckCircle2 size={14} /> {res.contacts.created} novo(s) e {res.contacts.existing} já existente(s) no CRM{res.contacts.optout ? ` · ${res.contacts.optout} tinham pedido SAIR` : ""}{res.dial ? ` · ${res.dial.inserted} no discador` : ""}</span>
          : <span className="crm-muted small">Quem pediu SAIR fica de fora. Números repetidos são ignorados.</span>}
        <button type="button" className="crm-btn primary" disabled={busy || !found.length || !crm.access.write} onClick={() => void go()}>
          {busy ? "Importando…" : `Importar ${found.length || ""} contato(s)`}
        </button>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------
// 3) Grupos do WhatsApp
// --------------------------------------------------------------------------
type Group = { jid: string; subject: string; size: number };
type Members = { subject: string; total: number; hidden: number; members: { phone: string; name: string | null; admin: boolean }[] };

async function waitJob(id: string, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = await api.waGroupJob(id);
    if (j?.status === "done") return j.result;
    if (j?.status === "error") throw new Error(j.error ?? "Falha no WhatsApp");
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("O WhatsApp demorou para responder. Confira se o número está conectado e tente de novo.");
}

export function GroupsExtractor() {
  const crm = useCrm();
  const [ack, setAck] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Group | null>(null);
  const [members, setMembers] = useState<Members | null>(null);
  const [tag, setTag] = useState("");
  const [list, setList] = useState("");
  const [onlyNonAdmin, setOnlyNonAdmin] = useState(false);
  const [res, setRes] = useState<api.TagImportResult | null>(null);
  const [q, setQ] = useState("");

  const loadGroups = async () => {
    setBusy("list");
    try {
      const id = await api.waGroupsRequest(crm.tenantId, "list");
      const r = await waitJob(id);
      setGroups(r.groups ?? []);
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(null); }
  };
  const pick = async (g: Group) => {
    setSel(g); setMembers(null); setRes(null); setTag(slug(`grupo ${g.subject}`)); setBusy("members");
    try {
      const id = await api.waGroupsRequest(crm.tenantId, "members", g.jid);
      setMembers(await waitJob(id));
    } catch (e) { crm.notify(errorText(e)); setSel(null); } finally { setBusy(null); }
  };
  const rows = (members?.members ?? []).filter((m) => !onlyNonAdmin || !m.admin);
  const doImport = async () => {
    setBusy("import");
    try {
      const r = await api.contactsTagImport(crm.tenantId, rows, tag.trim() || null, `grupo do WhatsApp: ${members?.subject ?? ""}`);
      if (list.trim()) await api.dialImport(crm.tenantId, list.trim(), rows.map((m) => ({ nome: m.name ?? "", telefone: m.phone })), "whatsapp_group");
      setRes(r);
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(null); }
  };

  if (!crm.access.configure) return <section className="crm-card ext-card"><p className="crm-muted">Só gestores podem extrair contatos de grupos.</p></section>;
  const shown = (groups ?? []).filter((g) => !q || g.subject.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="crm-card ext-card">
      <header className="ext-head">
        <span className="ext-icon groups"><Users size={18} /></span>
        <div>
          <strong>Grupos do WhatsApp</strong>
          <span className="crm-muted small">Importa os participantes dos grupos em que o número do CRO está.</span>
        </div>
      </header>
      <div className="ext-risk">
        <ShieldAlert size={18} />
        <div>
          <b>Use com cuidado — risco de bloqueio do número.</b>
          <ul>
            <li>Mandar mensagem em massa para quem não te conhece é o principal motivo de banimento no WhatsApp. Prefira grupos onde as pessoas esperam seu contato.</li>
            <li>Pela LGPD, use os contatos só com finalidade legítima e respeite quem pedir para sair (o CRO já bloqueia quem responder SAIR).</li>
            <li>Comece com poucos envios por dia nos disparos (o limite padrão de 200/dia e o intervalo de 25–60 s continuam valendo).</li>
          </ul>
          <label className="crm-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Entendi os riscos</label>
        </div>
      </div>
      {ack && !groups && (
        <button type="button" className="crm-btn primary self-start" disabled={busy === "list"} onClick={() => void loadGroups()}>
          {busy === "list" ? <><Loader2 size={15} className="spin" /> Lendo seus grupos…</> : <><Users size={15} /> Carregar meus grupos</>}
        </button>
      )}
      {ack && groups && (
        <div className="ext-groups">
          <div className="ext-groups-list">
            <div className="ext-groups-top">
              <input value={q} placeholder={`Buscar entre ${groups.length} grupos`} onChange={(e) => setQ(e.target.value)} />
              <button type="button" className="crm-icon-btn" title="Recarregar" onClick={() => void loadGroups()}><RefreshCw size={15} /></button>
            </div>
            {shown.length === 0 && <p className="crm-muted small">Nenhum grupo encontrado.</p>}
            {shown.map((g) => (
              <button key={g.jid} type="button" className={`ext-group${sel?.jid === g.jid ? " is-on" : ""}`} onClick={() => void pick(g)} disabled={!!busy}>
                <span className="ext-group-av">{g.subject.slice(0, 1).toUpperCase()}</span>
                <span className="ext-group-name">{g.subject}</span>
                <span className="crm-muted small">{g.size}</span>
              </button>
            ))}
          </div>
          <div className="ext-groups-detail">
            {!sel ? <p className="crm-muted small">Escolha um grupo para ver os participantes.</p>
              : busy === "members" || !members ? <p className="crm-muted small"><Loader2 size={14} className="spin" /> Lendo participantes de “{sel.subject}”…</p>
              : (
                <>
                  <strong>{members.subject}</strong>
                  <p className="crm-muted small">{members.members.length} com número visível{members.hidden ? ` · ${members.hidden} escondem o número (ficam de fora)` : ""}</p>
                  <label className="crm-check small"><input type="checkbox" checked={onlyNonAdmin} onChange={(e) => setOnlyNonAdmin(e.target.checked)} /> Deixar de fora os administradores do grupo</label>
                  <div className="ext-member-list">
                    {rows.slice(0, 60).map((m) => <div key={m.phone}><span>{m.name || "—"}{m.admin ? " · admin" : ""}</span><span className="crm-muted">{phoneLabel(m.phone)}</span></div>)}
                    {rows.length > 60 && <div className="crm-muted small">+{rows.length - 60}</div>}
                  </div>
                  <div className="ext-grid two">
                    <label className="ext-field"><span><Tag size={12} /> Etiqueta no CRM</span><input value={tag} onChange={(e) => setTag(e.target.value.slice(0, 40))} /></label>
                    <label className="ext-field"><span>Também no discador (lista)</span><input value={list} placeholder="opcional" onChange={(e) => setList(e.target.value.slice(0, 80))} /></label>
                  </div>
                  {res ? <p className="tone-green small"><CheckCircle2 size={14} /> {res.created} novo(s) e {res.existing} já existente(s) com a etiqueta <b>{res.tag}</b>{res.optout ? ` · ${res.optout} tinham pedido SAIR` : ""}</p>
                    : <button type="button" className="crm-btn primary self-start" disabled={!rows.length || busy === "import"} onClick={() => void doImport()}>{busy === "import" ? "Importando…" : `Importar ${rows.length} contato(s)`}</button>}
                </>
              )}
          </div>
        </div>
      )}
    </section>
  );
}
