import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Clock, LogOut, MessageCircle, Pause, Pencil, Play, Plus, QrCode, RefreshCw, Search, Send, ShieldCheck,
  Repeat, Smartphone, Trash2, Upload, Users, X, XCircle,
} from "lucide-react";
import * as api from "./api";
import { CrmContext, useCrm } from "./context";
import { parseCsv } from "./csv";
import { dateTime, errorText, phoneLabel, relative, timeOnly } from "./format";
import type { WaAddResult, WaCampaign, WaCampaignStatus, WaGatewayInstance, WaRecipient, WaRecipientStatus } from "./types";
import { Bar, Confirm, Empty, Field, Modal, Pill, Skeleton, Tabs } from "./ui";
import { MapsSearchView } from "./maps-search";
import { TemplateFields, TemplateSendBox, WaChannelSummary, useWaChannel } from "./wa-channel";

const statusInfo: Record<WaCampaignStatus, { label: string; tone: string }> = {
  draft: { label: "Rascunho", tone: "muted" },
  running: { label: "Enviando", tone: "green" },
  paused: { label: "Pausado", tone: "amber" },
  completed: { label: "Concluído", tone: "blue" },
  canceled: { label: "Cancelado", tone: "muted" },
};

const recipientInfo: Record<WaRecipientStatus, { label: string; tone: string }> = {
  pending: { label: "Na fila", tone: "muted" },
  queued: { label: "Enviando", tone: "blue" },
  sent: { label: "Enviado", tone: "green" },
  failed: { label: "Falhou", tone: "red" },
  invalid: { label: "Sem WhatsApp", tone: "amber" },
  opted_out: { label: "Pediu SAIR", tone: "amber" },
  skipped: { label: "Não enviado", tone: "muted" },
};

const VARS = ["{nome}", "{primeiro_nome}", "{empresa}", "{cidade}"];
const DEFAULT_MSG = "{Olá|Oi|Bom dia}, tudo bem? Aqui é da IDX. Vi a {empresa} em {cidade} e queria te mostrar como estamos ajudando farmácias a vender mais pelo WhatsApp. Posso te explicar em 2 minutos?";

/** Prévia: escolhe a 1ª opção de cada {a|b} e preenche variáveis de exemplo */
function preview(text: string, sample: Record<string, string>, footer: boolean) {
  let t = text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g: string) => g.split("|")[0]);
  const first = (sample.nome ?? "").split(" ")[0];
  t = t.split("{nome}").join(sample.nome ?? "").split("{primeiro_nome}").join(first)
    .split("{empresa}").join(sample.empresa ?? sample.nome ?? "").split("{cidade}").join(sample.cidade ?? "");
  t = t.replace(/ +([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  if (footer && !/\bsair\b/i.test(t)) t += "\n\nSe não quiser receber mais mensagens, responda SAIR.";
  return t;
}

function nextSendLabel(c: WaCampaign) {
  if (c.status !== "running") return null;
  if (c.auto_feed && c.pending === 0) return "Esperando novos clientes da busca automática";
  if (c.sent_today >= c.daily_limit) return `Limite de hoje atingido (${c.daily_limit}) — volta amanhã às ${c.start_hour}h`;
  if (!c.next_send_at) return "Começando…";
  const at = new Date(c.next_send_at);
  if (at.getTime() - Date.now() > 10 * 60_000) return `Fora do horário — retoma ${relative(c.next_send_at)} (${dateTime(c.next_send_at)})`;
  return at.getTime() <= Date.now() ? "Enviando agora" : `Próxima mensagem às ${timeOnly(c.next_send_at)}`;
}

// ---------------------------------------------------------------------------
// Conexão (QR)
// ---------------------------------------------------------------------------
export function useWaInstance(tenantIdArg?: string) {
  const ctx = useContext(CrmContext);
  const tenantId = tenantIdArg ?? ctx?.tenantId ?? "";
  const [inst, setInst] = useState<WaGatewayInstance | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setInst(await api.waInstance(tenantId)); } catch { setInst(null); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);
  // atualiza mais rápido enquanto o QR está na tela
  useEffect(() => {
    const ms = inst && inst.desired_status === "connected" && inst.status !== "connected" ? 2500 : 20000;
    const t = setInterval(() => void load(), ms);
    return () => clearInterval(t);
  }, [inst, load]);
  return { inst, reload: load, setInst };
}

export function ConnectionCard({ compact }: { compact?: boolean }) {
  const { tenantId, access, notify } = useCrm();
  return <ConnectionPanel tenantId={tenantId} canConfigure={access.configure} notify={notify} compact={compact} />;
}

/** A conexão única do WhatsApp (QR do próprio CRO). Usada em Disparos e na tela WhatsApp. */
export function ConnectionPanel({ tenantId, canConfigure, notify, compact }: { tenantId: string; canConfigure: boolean; notify: (m: string) => void; compact?: boolean }) {
  const access = { configure: canConfigure };
  const { inst, reload, setInst } = useWaInstance(tenantId);
  const [busy, setBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  async function act(a: "connect" | "disconnect" | "logout") {
    setBusy(true);
    try { setInst(await api.waConnect(tenantId, a)); if (a === "connect") notify("Gerando QR Code…"); }
    catch (e) { notify(errorText(e)); }
    finally { setBusy(false); void reload(); }
  }

  if (inst === undefined) return <div className="crm-card"><Skeleton rows={1} /></div>;
  const connected = inst?.status === "connected";
  const waiting = inst && inst.desired_status === "connected" && !connected && inst.status !== "banned";
  const lastError = (inst?.metadata as { last_error?: string } | null)?.last_error;

  return (
    <section className={`crm-card wa-conn ${connected ? "ok" : ""} ${compact ? "compact" : ""}`}>
      <div className="wa-conn-head">
        <div className="wa-conn-icon">{connected ? <Smartphone size={20} /> : <QrCode size={20} />}</div>
        <div className="wa-conn-text">
          <strong>
            {connected ? `WhatsApp conectado · ${phoneLabel(inst!.phone_number)}`
              : inst?.status === "banned" ? "O WhatsApp bloqueou este número"
              : waiting ? "Leia o QR Code com o WhatsApp do celular"
              : "WhatsApp desconectado"}
          </strong>
          <span className="crm-muted">
            {connected ? "Conexão única: caixa de entrada, respostas, disparos, automações, cadências e a leitura de vendas pela IA."
              : waiting ? "WhatsApp → Aparelhos conectados → Conectar um aparelho. O QR muda a cada 20 segundos."
              : "Conecte o número da empresa para enviar e receber mensagens pelo CRO."}
          </span>
          {lastError && !connected && <span className="wa-conn-err"><AlertTriangle size={13} /> {lastError}</span>}
        </div>
        {access.configure && (
          <div className="wa-conn-actions">
            {!connected && !waiting && <button type="button" className="crm-btn primary" disabled={busy} onClick={() => act("connect")}><QrCode size={15} /> Conectar</button>}
            {waiting && <button type="button" className="crm-btn ghost" disabled={busy} onClick={() => act("disconnect")}>Cancelar</button>}
            {connected && <button type="button" className="crm-btn ghost" disabled={busy} onClick={() => act("disconnect")} title="Para de enviar e receber até conectar de novo"><Pause size={15} /> Pausar</button>}
            {(connected || inst?.status === "banned") && <button type="button" className="crm-btn ghost danger-text" disabled={busy} onClick={() => setConfirmLogout(true)}><LogOut size={15} /> Trocar número</button>}
          </div>
        )}
      </div>
      {waiting && (
        <div className="wa-qr">
          {inst?.qr_code_data
            ? <img src={inst.qr_code_data} alt="QR Code para conectar o WhatsApp" width={240} height={240} />
            : <div className="wa-qr-wait"><RefreshCw size={18} className="spin" /> Preparando o QR Code… (até 30 s)</div>}
        </div>
      )}
      {!access.configure && !connected && <p className="crm-muted small">Peça a um gestor para conectar o WhatsApp.</p>}
      <Confirm open={confirmLogout} onClose={() => setConfirmLogout(false)} danger confirmLabel="Desconectar número"
        title="Trocar o número conectado?" text="A sessão será encerrada e será preciso ler o QR Code de novo. O histórico de conversas continua no CRO."
        onConfirm={() => act("logout")} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tela principal
// ---------------------------------------------------------------------------
export function DispatchView() {
  const { tenantId, access, refreshKey, notify } = useCrm();
  const [tab, setTab] = useState<"campaigns" | "maps" | "optouts">(() => (new URLSearchParams(window.location.search).get("tab") === "maps" ? "maps" : "campaigns"));
  const [items, setItems] = useState<WaCampaign[] | null>(null);
  const [editing, setEditing] = useState<WaCampaign | "new" | null>(null);
  const [audienceFor, setAudienceFor] = useState<WaCampaign | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [starting, setStarting] = useState<WaCampaign | null>(null);
  const [canceling, setCanceling] = useState<WaCampaign | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.waCampaigns(tenantId)); } catch (e) { notify(errorText(e)); setItems([]); }
  }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const anyRunning = items?.some((c) => c.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  async function act(c: WaCampaign, a: "start" | "pause" | "resume" | "cancel" | "archive") {
    try {
      await api.waCampaignAction(c.id, a);
      if (a === "start" || a === "resume") api.kickCloud(tenantId);
      notify({ start: "Disparo iniciado", resume: "Disparo retomado", pause: "Disparo pausado", cancel: "Disparo cancelado", archive: "Rascunho excluído" }[a]);
      void load();
    } catch (e) { notify(errorText(e)); }
  }

  const current = items?.find((c) => c.id === detail) ?? null;

  return (
    <div className="crm-page">
      <WaChannelSummary tenantId={tenantId} canConfigure={access.configure} notify={notify} />
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: "campaigns", label: "Disparos", count: items?.length },
            { value: "maps", label: "Buscar clientes" },
            { value: "optouts", label: "Pediram SAIR" },
          ]} />
        </div>
        {tab === "campaigns" && access.write && (
          <button type="button" className="crm-btn primary" onClick={() => setEditing("new")}><Plus size={16} /> Novo disparo</button>
        )}
      </div>

      {tab === "maps" ? <MapsSearchView campaigns={items ?? []} onCampaignsChanged={() => void load()} /> : tab === "optouts" ? <OptoutsList /> : !items ? <Skeleton rows={3} height={110} /> : items.length === 0 ? (
        <Empty icon={<Send size={22} />} title="Nenhum disparo ainda"
          text="Envie uma mensagem para uma lista (ex.: as farmácias do discador). O CRO envia um por vez, com intervalo aleatório, só em horário comercial e respeita quem pedir SAIR."
          action={access.write ? <button type="button" className="crm-btn primary" onClick={() => setEditing("new")}><Plus size={16} /> Criar o primeiro</button> : undefined} />
      ) : (
        <div className="wa-camp-list">
          {items.map((c) => (
            <article key={c.id} className="crm-card wa-camp">
              <header>
                <button type="button" className="wa-camp-title" onClick={() => setDetail(c.id)}>
                  <strong>{c.name}</strong>
                  <Pill tone={statusInfo[c.status].tone}>{statusInfo[c.status].label}</Pill>
                  {c.auto_feed && <Pill tone="blue" title="Recebe sozinho os novos clientes da busca no Google Maps">Alimentação automática</Pill>}
                </button>
                <div className="wa-camp-actions">
                  {access.write && c.status === "draft" && <>
                    <button type="button" className="crm-btn ghost sm" onClick={() => setEditing(c)}><Pencil size={14} /> Editar</button>
                    <button type="button" className="crm-btn ghost sm" onClick={() => setAudienceFor(c)}><Users size={14} /> Público</button>
                    <button type="button" className="crm-btn primary sm" disabled={c.pending === 0 && !c.auto_feed} title={c.pending === 0 && !c.auto_feed ? "Adicione contatos primeiro" : undefined} onClick={() => setStarting(c)}><Play size={14} /> Iniciar</button>
                  </>}
                  {access.write && c.status === "running" && <button type="button" className="crm-btn ghost sm" onClick={() => act(c, "pause")}><Pause size={14} /> Pausar</button>}
                  {access.write && c.status === "paused" && <>
                    <button type="button" className="crm-btn ghost sm" onClick={() => setEditing(c)}><Pencil size={14} /> Editar</button>
                    <button type="button" className="crm-btn ghost sm" onClick={() => setAudienceFor(c)}><Users size={14} /> Público</button>
                    <button type="button" className="crm-btn primary sm" onClick={() => act(c, "resume")}><Play size={14} /> Retomar</button>
                  </>}
                  {access.write && (c.status === "running" || c.status === "paused") && <button type="button" className="crm-icon-btn" title="Cancelar disparo" onClick={() => setCanceling(c)}><XCircle size={16} /></button>}
                  {access.write && c.status === "draft" && <button type="button" className="crm-icon-btn" title="Excluir rascunho" onClick={() => act(c, "archive")}><Trash2 size={16} /></button>}
                </div>
              </header>
              <p className="wa-camp-msg">{preview(c.messages[0] ?? "", { nome: "Drogaria Exemplo", empresa: "Drogaria Exemplo", cidade: "Campinas" }, false)}</p>
              {c.total > 0 ? <>
                <Bar value={c.sent} max={Math.max(1, c.total - c.opted_out - c.skipped)} tone="green" />
                <div className="wa-camp-stats">
                  <span><b>{c.sent}</b> de {c.total - c.opted_out - c.skipped} enviados</span>
                  <span className="tone-green"><b>{c.replied}</b> responderam{c.sent ? ` (${Math.round((c.replied / c.sent) * 100)}%)` : ""}</span>
                  {c.invalid > 0 && <span><b>{c.invalid}</b> sem WhatsApp</span>}
                  {c.failed > 0 && <span className="tone-red"><b>{c.failed}</b> falharam</span>}
                  {c.opted_out > 0 && <span><b>{c.opted_out}</b> pediram SAIR</span>}
                </div>
              </> : <p className="crm-muted small">{c.auto_feed ? "Os contatos chegam pela busca automática no Google Maps." : "Sem público."} {access.write && <button type="button" className="crm-link" onClick={() => setAudienceFor(c)}>Adicionar contatos</button>}</p>}
              <footer className="crm-muted small">
                <ShieldCheck size={13} /> {c.min_delay_sec}–{c.max_delay_sec}s entre mensagens · até {c.daily_limit}/dia · {c.start_hour}h às {c.end_hour}h
                {c.status === "running" && <> · <Clock size={13} /> {nextSendLabel(c)}</>}
                {c.status === "paused" && c.paused_reason && <> · {c.paused_reason}</>}
                {c.status === "completed" && c.completed_at && <> · terminou {relative(c.completed_at)}</>}
              </footer>
            </article>
          ))}
        </div>
      )}

      {editing && <CampaignEditor campaign={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={(id, isNew) => { setEditing(null); void load().then(() => { if (isNew) setAudienceFor({ id } as WaCampaign); }); }} />}
      {audienceFor && <AudienceModal campaignId={audienceFor.id} onClose={() => setAudienceFor(null)} onDone={() => { setAudienceFor(null); void load(); }} />}
      {current && <CampaignDetail campaign={current} onClose={() => setDetail(null)} />}
      <Confirm open={!!starting} onClose={() => setStarting(null)} confirmLabel="Iniciar disparo"
        title={`Iniciar “${starting?.name ?? ""}”?`}
        text={starting ? `${starting.auto_feed ? `Agora: ${starting.pending} mensagem(ns), e depois cada cliente novo da busca automática. ` : `Serão ${starting.pending} mensagens. `}Uma por vez, a cada ${starting.min_delay_sec}–${starting.max_delay_sec} segundos, até ${starting.daily_limit} por dia, das ${starting.start_hour}h às ${starting.end_hour}h. Quem pedir SAIR não recebe mais. Você pode pausar a qualquer momento.` : ""}
        onConfirm={() => starting && act(starting, "start")} />
      <Confirm open={!!canceling} onClose={() => setCanceling(null)} danger confirmLabel="Cancelar disparo"
        title="Cancelar este disparo?" text="Quem ainda não recebeu não vai receber. O que já foi enviado fica no histórico."
        onConfirm={() => canceling && act(canceling, "cancel")} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function CampaignEditor({ campaign, onClose, onSaved }: { campaign: WaCampaign | null; onClose: () => void; onSaved: (id: string, isNew: boolean) => void }) {
  const { tenantId, notify } = useCrm();
  const [name, setName] = useState(campaign?.name ?? "");
  const [msgs, setMsgs] = useState<string[]>(campaign?.messages?.length ? campaign.messages : [DEFAULT_MSG]);
  const [minD, setMinD] = useState(campaign?.min_delay_sec ?? 25);
  const [maxD, setMaxD] = useState(campaign?.max_delay_sec ?? 60);
  const [limit, setLimit] = useState(campaign?.daily_limit ?? 200);
  const [startH, setStartH] = useState(campaign?.start_hour ?? 8);
  const [endH, setEndH] = useState(campaign?.end_hour ?? 20);
  const [footer, setFooter] = useState(campaign?.opt_out_footer ?? true);
  const [autoFeed, setAutoFeed] = useState(campaign?.auto_feed ?? false);
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  // API oficial: o disparo usa um modelo aprovado pela Meta
  const [official, setOfficial] = useState(false);
  const [templates, setTemplates] = useState<api.WaTemplate[]>([]);
  const [tpl, setTpl] = useState<api.WaTemplateChoice | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ch = await api.waChannel(tenantId);
        if (!alive || ch.active !== "cloud_api") return;
        setOfficial(true);
        setTemplates(await api.waTemplates(tenantId));
        if (campaign?.id) {
          const t = await api.waCampaignTemplate(campaign.id);
          if (alive && t) setTpl({ name: t.name, language: t.language, params: t.params ?? [] });
        }
      } catch { /* sem API oficial */ }
    })();
    return () => { alive = false; };
  }, [tenantId, campaign?.id]);
  // follow-ups para quem não respondeu
  const [fus, setFus] = useState<api.WaFollowup[]>([]);
  const [fusLoaded, setFusLoaded] = useState(!campaign?.id);
  useEffect(() => {
    if (!campaign?.id) return;
    let alive = true;
    api.waCampaignFollowups(campaign.id).then((f) => { if (alive) { setFus(f); setFusLoaded(true); } }).catch(() => setFusLoaded(true));
    return () => { alive = false; };
  }, [campaign?.id]);
  const fusReady = fus.every((f) => f.after_hours > 0 && (official ? !!f.template && f.template.params.every((p) => p.trim()) : !!f.text?.trim()))
    && fus.every((f, i) => i === 0 || f.after_hours > fus[i - 1].after_hours);
  const tplBody = templates.find((t) => t.name === tpl?.name && t.language === tpl?.language)?.body_text ?? "";
  const tplReady = !!tpl && tpl.params.every((p) => p.trim());

  function insertVar(i: number, v: string) {
    const el = refs.current[i];
    const cur = msgs[i];
    const pos = el?.selectionStart ?? cur.length;
    const next = cur.slice(0, pos) + v + cur.slice(el?.selectionEnd ?? pos);
    setMsgs(msgs.map((m, j) => (j === i ? next : m)));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos + v.length, pos + v.length); });
  }

  async function save() {
    setBusy(true);
    try {
      const id = await api.waSaveCampaign(tenantId, campaign?.id ?? null, {
        name, messages: official ? [tplBody || `Modelo ${tpl?.name}`] : msgs, min_delay_sec: minD, max_delay_sec: Math.max(minD, maxD), daily_limit: limit,
        start_hour: startH, end_hour: endH, opt_out_footer: official ? false : footer,
      });
      if (official) await api.waCampaignSetTemplate(id, tpl);
      if (fusLoaded) await api.waCampaignSetFollowups(id, fus.map((f) => ({
        after_hours: f.after_hours, label: f.label ?? null,
        text: official ? null : (f.text ?? "").trim() || null,
        template: official && f.template ? { name: f.template.name, language: f.template.language, params: f.template.params } : null,
      })));
      if (autoFeed !== (campaign?.auto_feed ?? false)) await api.waSetAutoFeed(id, autoFeed);
      notify(campaign ? "Disparo atualizado" : "Disparo criado — agora escolha quem vai receber");
      onSaved(id, !campaign);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  const risky = minD < 20 || limit > 300 || !footer;
  return (
    <Modal open onClose={onClose} title={campaign ? "Editar disparo" : "Novo disparo"} width={720}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || !name.trim() || !fusReady || (official ? !tplReady : !msgs.some((m) => m.trim()))} onClick={save}>{campaign ? "Salvar" : "Criar e escolher público"}</button>
      </>}>
      <div className="crm-form-grid">
        <Field label="Nome do disparo" span={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Farmácias SP — apresentação" /></Field>
      </div>
      {official ? (
        <div className="wa-msgs">
          <p className="crm-muted small"><ShieldCheck size={13} /> A empresa usa a <b>API oficial do WhatsApp</b>: o disparo envia um modelo aprovado pela Meta. Preencha as variáveis com os dados de cada contato.</p>
          <div className="crm-form-grid">
            <TemplateFields templates={templates} value={tpl} onChange={setTpl} vars={VARS}
              sample={(p) => preview(p, { nome: "Drogaria São José", empresa: "Drogaria São José", cidade: "Campinas" }, false)} />
          </div>
        </div>
      ) : (
      <div className="wa-msgs">
        {msgs.map((m, i) => (
          <div key={i} className="wa-msg-edit">
            <div className="wa-msg-head">
              <b>{msgs.length > 1 ? `Variação ${i + 1}` : "Mensagem"}</b>
              <div className="wa-vars">{VARS.map((v) => <button key={v} type="button" onClick={() => insertVar(i, v)}>{v}</button>)}</div>
              {msgs.length > 1 && <button type="button" className="crm-icon-btn" title="Remover variação" onClick={() => setMsgs(msgs.filter((_, j) => j !== i))}><X size={14} /></button>}
            </div>
            <textarea ref={(el) => { refs.current[i] = el; }} rows={4} maxLength={3500} value={m} onChange={(e) => setMsgs(msgs.map((x, j) => (j === i ? e.target.value : x)))} />
            <div className="wa-bubble" title="Prévia">{preview(m, { nome: "Drogaria São José", empresa: "Drogaria São José", cidade: "Campinas" }, footer)}</div>
          </div>
        ))}
        {msgs.length < 5 && <button type="button" className="crm-btn ghost sm" onClick={() => setMsgs([...msgs, ""])}><Plus size={14} /> Adicionar variação</button>}
        <p className="crm-muted small">Cada contato recebe uma variação sorteada. Use <code>{"{Olá|Oi|Bom dia}"}</code> para alternar palavras — mensagens diferentes entre si reduzem o risco de bloqueio.</p>
      </div>
      )}

      <FollowupsEditor value={fus} onChange={setFus} official={official} templates={templates} />

      <h4 className="wa-sub"><ShieldCheck size={15} /> Proteção do número</h4>
      <div className="crm-form-grid">
        <Field label="Intervalo mínimo (s)" hint="mínimo 15"><input type="number" min={15} max={600} value={minD} onChange={(e) => setMinD(Math.max(15, Number(e.target.value) || 15))} /></Field>
        <Field label="Intervalo máximo (s)"><input type="number" min={minD} max={900} value={maxD} onChange={(e) => setMaxD(Number(e.target.value) || minD)} /></Field>
        <Field label="Limite por dia (este número)" hint="máximo 500"><input type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        <Field label="Horário de envio">
          <div className="wa-hours">
            <select value={startH} onChange={(e) => setStartH(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}h</option>)}</select>
            <span>às</span>
            <select value={endH} onChange={(e) => setEndH(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => h + 1).filter((h) => h > startH).map((h) => <option key={h} value={h}>{h}h</option>)}</select>
          </div>
        </Field>
        {!official && <label className="crm-check" style={{ gridColumn: "1 / -1" }}>
          <input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} />
          Incluir “Se não quiser receber mais mensagens, responda SAIR.” (recomendado)
        </label>}
        <label className="crm-check" style={{ gridColumn: "1 / -1" }}>
          <input type="checkbox" checked={autoFeed} onChange={(e) => setAutoFeed(e.target.checked)} />
          Alimentação automática: continuar ligado recebendo os novos clientes da busca no Google Maps
        </label>
      </div>
      {risky && !official && <p className="wa-warn"><AlertTriangle size={14} /> Configuração mais agressiva aumenta a chance de o WhatsApp bloquear o número. O padrão (25–60 s, 200/dia, com SAIR) é o mais seguro.</p>}
    </Modal>
  );
}

const FU_WHEN: { h: number; label: string }[] = [
  { h: 1, label: "1 hora depois" }, { h: 2, label: "2 horas depois" }, { h: 4, label: "4 horas depois (D0)" }, { h: 8, label: "8 horas depois" },
  { h: 24, label: "1 dia depois (D1)" }, { h: 48, label: "2 dias depois (D2)" }, { h: 72, label: "3 dias depois (D3)" }, { h: 96, label: "4 dias depois (D4)" },
  { h: 120, label: "5 dias depois (D5)" }, { h: 168, label: "7 dias depois (D7)" }, { h: 240, label: "10 dias depois" }, { h: 336, label: "14 dias depois" },
];
const FU_DEFAULT: api.WaFollowup[] = [
  { after_hours: 4, label: "D0 +4h", text: "{Oi|Olá}, {nome}! Conseguiu ver minha mensagem? Se quiser, te passo mais detalhes. 😊" },
  { after_hours: 24, label: "D1", text: "{Oi|Olá}, {nome}! Passando para saber se posso te ajudar com alguma informação." },
  { after_hours: 72, label: "D3", text: "{Oi|Olá}, {nome}! Ainda está em tempo — quer que eu te envie as opções?" },
  { after_hours: 120, label: "D5", text: "{Oi|Olá}, {nome}! Só para não deixar passar: posso te ajudar com algo?" },
  { after_hours: 168, label: "D7", text: "{Oi|Olá}, {nome}! Como não tivemos retorno, este é meu último contato por aqui. Muito obrigado pela atenção — fico à disposição sempre que precisar. 🙏" },
];

function FollowupsEditor({ value, onChange, official, templates }: { value: api.WaFollowup[]; onChange: (v: api.WaFollowup[]) => void; official: boolean; templates: api.WaTemplate[] }) {
  const set = (i: number, patch: Partial<api.WaFollowup>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => {
    const last = value[value.length - 1]?.after_hours ?? 0;
    const next = FU_WHEN.find((w) => w.h > last)?.h ?? last + 24;
    onChange([...value, { after_hours: next, text: "", template: null }]);
  };
  const outOfOrder = value.some((f, i) => i > 0 && f.after_hours <= value[i - 1].after_hours);
  return (
    <div className="wa-fu">
      <h4 className="wa-sub"><Repeat size={15} /> Follow-up se não responder</h4>
      <p className="crm-muted small">
        Quem não responder ao disparo recebe estas mensagens, contadas a partir do envio. A sequência <b>para sozinha</b> quando a pessoa responde ou pede SAIR, e respeita o horário de envio do disparo.
        {official && " Na API oficial cada follow-up precisa de um modelo aprovado pela Meta."}
      </p>
      {value.map((f, i) => (
        <div key={i} className="wa-fu-step">
          <div className="wa-fu-head">
            <b>{i + 1}º follow-up{i === value.length - 1 && value.length > 1 ? " · despedida" : ""}</b>
            <select value={f.after_hours} onChange={(e) => set(i, { after_hours: Number(e.target.value) })}>
              {[...FU_WHEN, ...(FU_WHEN.some((w) => w.h === f.after_hours) ? [] : [{ h: f.after_hours, label: `${f.after_hours} horas depois` }])]
                .map((w) => <option key={w.h} value={w.h}>{w.label}</option>)}
            </select>
            <button type="button" className="crm-icon-btn" title="Remover follow-up" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={14} /></button>
          </div>
          {official ? (
            <div className="crm-form-grid">
              <TemplateFields templates={templates} value={f.template ?? null} onChange={(t) => set(i, { template: t })} vars={VARS}
                sample={(p) => preview(p, { nome: "Drogaria São José", empresa: "Drogaria São José", cidade: "Campinas" }, false)} />
            </div>
          ) : (
            <textarea rows={3} maxLength={3500} value={f.text ?? ""} placeholder="Mensagem do follow-up — use {nome}" onChange={(e) => set(i, { text: e.target.value })} />
          )}
        </div>
      ))}
      <div className="wa-fu-actions">
        {value.length < 10 && <button type="button" className="crm-btn ghost sm" onClick={add}><Plus size={14} /> Adicionar follow-up</button>}
        {value.length === 0 && !official && <button type="button" className="crm-btn ghost sm" onClick={() => onChange(FU_DEFAULT)}>Usar sequência padrão (D0+4h, D1, D3, D5, D7)</button>}
      </div>
      {outOfOrder && <p className="wa-warn"><AlertTriangle size={14} /> Coloque os follow-ups em ordem de prazo (o 2º depois do 1º, e assim por diante).</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------
function AudienceModal({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: () => void }) {
  const { tenantId, notify } = useCrm();
  const [src, setSrc] = useState<"dial_list" | "tag" | "rows">("dial_list");
  const [tags, setTags] = useState<string[] | null>(null);
  const [tag, setTag] = useState("");
  const [tagCount, setTagCount] = useState<number | null>(null);
  const [lists, setLists] = useState<{ name: string; total: number; pending: number }[] | null>(null);
  const [list, setList] = useState("");
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WaAddResult | null>(null);

  useEffect(() => {
    api.waDialLists(tenantId).then((l) => { setLists(l); if (l[0]) setList(l[0].name); }).catch(() => setLists([]));
    api.flowTagSuggestions(tenantId).then((t) => { setTags(t); if (t[0]) setTag(t[0]); }).catch(() => setTags([]));
  }, [tenantId]);
  useEffect(() => {
    if (!tag) { setTagCount(null); return; }
    api.loadContacts(tenantId, { tag, pageSize: 1 }).then((r) => setTagCount(r.total)).catch(() => setTagCount(null));
  }, [tag, tenantId]);

  const rows = useMemo(() => {
    if (!text.trim()) return [];
    const first = text.split(/\r?\n/)[0];
    const sep = first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
    const hasHeader = /nome|name|telefone|phone|whats|celular/i.test(first);
    const parsed = parseCsv(hasHeader ? text : `nome${sep}telefone${sep}cidade\n${text}`);
    const h = parsed.headers.map((x) => x.trim().toLowerCase());
    return parsed.rows
      .map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])) as Record<string, string>)
      .filter((r) => Object.values(r).some(Boolean));
  }, [text]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setText(await f.text());
  }

  async function add() {
    setBusy(true);
    try {
      let r: WaAddResult;
      if (src === "dial_list") {
        r = await api.waAddRecipients(campaignId, { source: "dial_list", listName: list, filters: { uf: uf || undefined, city: city || undefined, only_pending: onlyPending, skip_not_interested: true } });
      } else if (src === "tag") {
        const ids: string[] = [];
        for (let page = 0; page < 5; page++) {
          const res = await api.loadContacts(tenantId, { tag, pageSize: 1000, page });
          ids.push(...res.rows.filter((c) => c.phone).map((c) => c.id));
          if (res.rows.length < 1000) break;
        }
        r = await api.waAddRecipients(campaignId, { source: "contacts", contactIds: ids });
      } else {
        r = await api.waAddRecipients(campaignId, { source: "rows", rows });
      }
      setResult(r);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={result ? onDone : onClose} title="Quem vai receber" width={620}
      footer={result
        ? <button type="button" className="crm-btn primary" onClick={onDone}>Pronto</button>
        : <>
          <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="crm-btn primary" disabled={busy || (src === "dial_list" ? !list : src === "tag" ? !tag || !tagCount : rows.length === 0)} onClick={add}>
            {busy ? "Adicionando…" : src === "rows" ? `Adicionar ${rows.length} contato(s)` : src === "tag" ? `Adicionar ${Math.min(tagCount ?? 0, 5000)} contato(s)` : "Adicionar lista"}
          </button>
        </>}>
      {result ? (
        <div className="wa-result">
          <CheckCircle2 size={28} className="tone-green" />
          <p><b>{result.added}</b> contato(s) adicionados · total no disparo: <b>{result.total}</b></p>
          <ul className="crm-muted small">
            {result.duplicates > 0 && <li>{result.duplicates} repetido(s) ignorado(s)</li>}
            {result.invalid_phone > 0 && <li>{result.invalid_phone} sem telefone válido</li>}
            {result.opted_out > 0 && <li>{result.opted_out} já tinham pedido SAIR — não vão receber</li>}
          </ul>
          <p className="crm-muted small">Números que não tiverem WhatsApp são detectados na hora do envio e marcados como “Sem WhatsApp”.</p>
        </div>
      ) : <>
        <Tabs value={src} onChange={setSrc} tabs={[{ value: "dial_list", label: "Lista do discador" }, { value: "tag", label: "Contatos com etiqueta" }, { value: "rows", label: "Colar / importar CSV" }]} />
        {src === "tag" ? (
          tags === null ? <Skeleton rows={2} /> : tags.length === 0 ? <p className="crm-muted">Nenhum contato com etiqueta ainda. Etiquetas vêm das buscas, da importação e das automações.</p> : (
            <div className="crm-form-grid">
              <Field label="Etiqueta" span={2}>
                <select value={tag} onChange={(e) => setTag(e.target.value)}>
                  {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <p className="crm-muted small" style={{ gridColumn: "1 / -1" }}>{tagCount === null ? "…" : `${tagCount} contato(s) com essa etiqueta`}{(tagCount ?? 0) > 5000 ? " — entram os 5000 mais recentes" : ""}. Variáveis: {"{nome}"}, {"{empresa}"}, {"{cidade}"}.</p>
            </div>
          )
        ) : src === "dial_list" ? (
          lists === null ? <Skeleton rows={2} /> : lists.length === 0 ? <p className="crm-muted">Nenhuma lista no discador.</p> : (
            <div className="crm-form-grid">
              <Field label="Lista" span={2}>
                <select value={list} onChange={(e) => setList(e.target.value)}>
                  {lists.map((l) => <option key={l.name} value={l.name}>{l.name} · {l.total} números</option>)}
                </select>
              </Field>
              <Field label="UF (opcional)"><input value={uf} maxLength={2} onChange={(e) => setUf(e.target.value.toUpperCase())} placeholder="SP" /></Field>
              <Field label="Cidade (opcional)"><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Campinas" /></Field>
              <label className="crm-check" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Só quem ainda não recebeu ligação</label>
              <p className="crm-muted small" style={{ gridColumn: "1 / -1" }}>Quem foi marcado como “sem interesse” ou “número inválido” no discador fica de fora automaticamente.</p>
            </div>
          )
        ) : (
          <div className="wa-paste">
            <p className="crm-muted small">Uma pessoa por linha: <code>nome;telefone;cidade</code> (ou um CSV com essas colunas). Colunas extras viram variáveis, ex.: <code>{"{produto}"}</code>.</p>
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Drogaria Central;(11) 98888-7777;São Paulo\nFarmácia Bem Estar;19 99999-1111;Campinas"} />
            <label className="crm-btn ghost sm"><Upload size={14} /> Escolher arquivo CSV<input type="file" accept=".csv,.txt" hidden onChange={(e) => onFile(e.target.files?.[0])} /></label>
            {rows.length > 0 && <p className="crm-muted small">{rows.length} linha(s) reconhecida(s). Ex.: {rows[0].nome || rows[0].name || "—"} · {rows[0].telefone || rows[0].phone || rows[0].whatsapp || "sem telefone"}</p>}
          </div>
        )}
      </>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detalhe (quem recebeu / respondeu)
// ---------------------------------------------------------------------------
function CampaignDetail({ campaign, onClose }: { campaign: WaCampaign; onClose: () => void }) {
  const { notify, openContact, access } = useCrm();
  const [filter, setFilter] = useState<WaRecipientStatus | "replied" | "all">(campaign.replied > 0 ? "replied" : "all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: WaRecipient[]; count: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const pageSize = 50;

  const load = useCallback(async () => {
    try { setData(await api.waRecipients(campaign.id, { status: filter, search, page, pageSize })); }
    catch (e) { notify(errorText(e)); setData({ rows: [], count: 0 }); }
  }, [campaign.id, filter, search, page, notify]);
  useEffect(() => { const t = setTimeout(() => void load(), search ? 300 : 0); return () => clearTimeout(t); }, [load, search, campaign.sent]);

  const canClear = access.write && (campaign.status === "draft" || campaign.status === "paused");

  return (
    <Modal open onClose={onClose} title={<>{campaign.name} <Pill tone={statusInfo[campaign.status].tone}>{statusInfo[campaign.status].label}</Pill></>} width={860}>
      <div className="wa-detail-stats">
        <div><b>{campaign.total}</b><span>no público</span></div>
        <div><b>{campaign.sent}</b><span>enviados</span></div>
        <div className="tone-green"><b>{campaign.replied}</b><span>responderam</span></div>
        <div><b>{campaign.invalid}</b><span>sem WhatsApp</span></div>
        <div><b>{campaign.opted_out}</b><span>pediram SAIR</span></div>
        <div><b>{campaign.failed}</b><span>falharam</span></div>
      </div>
      <div className="crm-toolbar">
        <div className="crm-toolbar-left">
          <select value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(0); }}>
            <option value="all">Todos</option>
            <option value="replied">Responderam</option>
            {(Object.keys(recipientInfo) as WaRecipientStatus[]).map((s) => <option key={s} value={s}>{recipientInfo[s].label}</option>)}
          </select>
          <div className="crm-search"><Search size={15} /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Nome ou telefone" /></div>
        </div>
        {canClear && <button type="button" className="crm-btn ghost sm" onClick={() => setClearing(true)}><Trash2 size={14} /> Limpar quem ainda não recebeu</button>}
      </div>
      {!data ? <Skeleton rows={6} /> : data.rows.length === 0 ? <Empty title="Ninguém aqui" text="Mude o filtro para ver outros contatos." /> : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Contato</th><th>Telefone</th><th>Situação</th><th>Enviado</th><th>Respondeu</th><th></th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name ?? "—"}{r.vars?.cidade && <span className="crm-muted small"> · {r.vars.cidade}</span>}</td>
                  <td>{phoneLabel(r.phone)}</td>
                  <td><Pill tone={recipientInfo[r.status].tone} title={r.error ?? undefined}>{recipientInfo[r.status].label}</Pill></td>
                  <td>{r.sent_at ? dateTime(r.sent_at) : "—"}</td>
                  <td>{r.replied_at ? <span className="tone-green">{relative(r.replied_at)}</span> : "—"}</td>
                  <td>{r.crm_contact_id && <button type="button" className="crm-link" onClick={() => { onClose(); openContact(r.crm_contact_id!); }}>Abrir contato</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.count > pageSize && (
        <div className="crm-pager">
          <button type="button" className="crm-btn ghost sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>{page * pageSize + 1}–{Math.min(data.count, (page + 1) * pageSize)} de {data.count}</span>
          <button type="button" className="crm-btn ghost sm" disabled={(page + 1) * pageSize >= data.count} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
      <p className="crm-muted small"><MessageCircle size={13} /> As respostas aparecem na Caixa de entrada do WhatsApp, e quem disparou recebe um aviso no sino.</p>
      <Confirm open={clearing} onClose={() => setClearing(false)} danger confirmLabel="Limpar"
        title="Tirar do disparo quem ainda não recebeu?" text="Os contatos que já receberam continuam no histórico."
        onConfirm={async () => { try { await api.waClearRecipients(campaign.id); notify("Público limpo"); void load(); } catch (e) { notify(errorText(e)); } }} />
    </Modal>
  );
}

function OptoutsList() {
  const { tenantId, access, notify } = useCrm();
  const [rows, setRows] = useState<{ phone: string; source: string; body: string | null; created_at: string }[] | null>(null);
  const [phone, setPhone] = useState("");
  const load = useCallback(async () => { try { setRows(await api.waOptouts(tenantId)); } catch (e) { notify(errorText(e)); setRows([]); } }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load]);
  async function add() {
    try { await api.waSetOptout(tenantId, phone, true); setPhone(""); notify("Número bloqueado para disparos"); void load(); } catch (e) { notify(errorText(e)); }
  }
  async function remove(p: string) {
    try { await api.waSetOptout(tenantId, p, false); notify("Número liberado"); void load(); } catch (e) { notify(errorText(e)); }
  }
  return (
    <div className="crm-card">
      <p className="crm-muted small">Quem responde <b>SAIR</b>, <b>PARAR</b> ou <b>STOP</b> entra aqui automaticamente e não recebe mais nenhum disparo nem mensagem pelo CRO.</p>
      {access.write && (
        <div className="wa-optout-add">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Bloquear um número manualmente" />
          <button type="button" className="crm-btn ghost sm" disabled={!phone.trim()} onClick={add}>Bloquear</button>
        </div>
      )}
      {!rows ? <Skeleton rows={3} /> : rows.length === 0 ? <p className="crm-muted">Ninguém pediu para sair até agora.</p> : (
        <table className="crm-table">
          <thead><tr><th>Telefone</th><th>Como</th><th>Quando</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.phone}>
                <td>{phoneLabel(r.phone)}</td>
                <td>{r.source === "keyword" ? `Respondeu “${r.body ?? "SAIR"}”` : "Bloqueado manualmente"}</td>
                <td>{relative(r.created_at)}</td>
                <td>{access.configure && <button type="button" className="crm-link" onClick={() => remove(r.phone)} title="Só libere se o próprio contato pediu">Liberar</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enviar uma mensagem avulsa pelo CRO (tarefa, contato)
// ---------------------------------------------------------------------------
export function SendWhatsAppModal({ phone, name, initial, onClose, onSent }: {
  phone: string; name?: string | null; initial?: string; onClose: () => void; onSent?: () => void;
}) {
  const { tenantId, notify } = useCrm();
  const { inst } = useWaInstance();
  const { channel } = useWaChannel(tenantId);
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const official = channel?.active === "cloud_api";
  const [mode, setMode] = useState<"text" | "template">("text");
  const connected = official ? channel?.cloud?.status === "connected" : inst?.status === "connected";
  const hasConnection = official ? !!channel?.cloud : !!inst;
  async function send() {
    setBusy(true);
    try {
      await api.waSend(tenantId, text, { phone });
      notify(connected ? "Mensagem enviada para a fila — sai em segundos" : "Mensagem na fila — sai quando o WhatsApp conectar");
      onSent?.(); onClose();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`WhatsApp para ${name || phoneLabel(phone)}`} width={560}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        {mode === "text" && <button type="button" className="crm-btn primary" disabled={busy || !text.trim() || !hasConnection} onClick={send}><Send size={15} /> Enviar pelo CRO</button>}
      </>}>
      {channel !== undefined && !hasConnection && <p className="wa-warn"><AlertTriangle size={14} /> Nenhum WhatsApp conectado. Um gestor precisa conectar em WhatsApp → Conexão.</p>}
      {hasConnection && !connected && <p className="wa-warn"><AlertTriangle size={14} /> WhatsApp desconectado agora: a mensagem fica na fila até reconectar.</p>}
      {official && (
        <div className="wa-mode">
          <button type="button" className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>Texto (cliente falou nas últimas 24 h)</button>
          <button type="button" className={mode === "template" ? "on" : ""} onClick={() => setMode("template")}>Modelo aprovado</button>
        </div>
      )}
      {mode === "text" ? (
        <>
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} autoFocus />
          <p className="crm-muted small">{official ? "Pela API oficial, texto livre só chega se o cliente mandou mensagem nas últimas 24 horas. Para iniciar a conversa, use um modelo." : "Enviado pelo número conectado ao CRO e salvo na conversa."}</p>
        </>
      ) : (
        <div className="crm-form-grid"><TemplateSendBox tenantId={tenantId} target={{ phone }} notify={notify} onSent={() => { onSent?.(); onClose(); }} /></div>
      )}
    </Modal>
  );
}
