// Disparos de e-mail na aba Disparos: só e-mail (para 1 pessoa ou uma lista) ou junto com um
// disparo de WhatsApp. O e-mail é uma mensagem única explicando a oferta — sem automação.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileUp, Mail, MessageCircle, Pause, Pencil, Play, Search, ShieldCheck, Trash2, Upload, Users, XCircle } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { parseCsv } from "./csv";
import { dateTime, errorText, relative } from "./format";
import { Bar, Confirm, Empty, Field, Modal, Pill, Skeleton, Tabs } from "./ui";

export type DispatchChannel = "whatsapp" | "email" | "both";

const VARS = ["{nome}", "{primeiro_nome}", "{empresa}", "{cidade}"];
const SAMPLE = { nome: "Maria Souza", primeiro_nome: "Maria", empresa: "Escola Exemplo", cidade: "Rio Verde" };
const DEFAULT_SUBJECT = "{nome}, uma proposta para a {empresa}";
const DEFAULT_BODY = "Olá, {primeiro_nome}! Tudo bem?\n\nSou da equipe e queria te apresentar rapidamente como podemos ajudar a {empresa}.\n\nPreparei um material com os detalhes — é só clicar no botão abaixo.\n\nSe fizer sentido, é só responder este e-mail que eu te retorno.";

export const emailStatusInfo: Record<api.EmailCampaignStatus, { label: string; tone: string }> = {
  draft: { label: "Rascunho", tone: "muted" },
  running: { label: "Enviando", tone: "green" },
  paused: { label: "Pausado", tone: "amber" },
  completed: { label: "Concluído", tone: "blue" },
  canceled: { label: "Cancelado", tone: "muted" },
};
const recipientInfo: Record<api.EmailRecipientStatus, { label: string; tone: string }> = {
  pending: { label: "Na fila", tone: "muted" },
  sending: { label: "Enviando", tone: "blue" },
  sent: { label: "Enviado", tone: "green" },
  failed: { label: "Falhou", tone: "red" },
  invalid: { label: "E-mail inválido", tone: "amber" },
  opted_out: { label: "Descadastrado", tone: "amber" },
};

function fill(text: string) {
  let t = text.replace(/\{([^{}|]*\|[^{}]*)\}/g, (_, opts: string) => opts.split("|")[0]);
  for (const [k, v] of Object.entries(SAMPLE)) t = t.split(`{${k}}`).join(v);
  return t;
}

// ---------------------------------------------------------------------------
// Escolha do canal ao criar
// ---------------------------------------------------------------------------
export function ChannelChooser({ onPick, onClose }: { onPick: (c: DispatchChannel) => void; onClose: () => void }) {
  const opts: { v: DispatchChannel; icon: JSX.Element; title: string; text: string }[] = [
    { v: "whatsapp", icon: <MessageCircle size={22} />, title: "WhatsApp", text: "Mensagem com automação e follow-ups, como já funciona hoje." },
    { v: "email", icon: <Mail size={22} />, title: "E-mail", text: "Um e-mail explicando a oferta, para uma pessoa ou uma lista. Sem automação." },
    { v: "both", icon: <><MessageCircle size={20} /><Mail size={20} /></>, title: "WhatsApp + E-mail", text: "O WhatsApp segue a automação e, junto, os mesmos contatos recebem o e-mail (quem tiver e-mail)." },
  ];
  return (
    <Modal open onClose={onClose} title="Novo disparo" width={640}>
      <div className="em-channels">
        {opts.map((o) => (
          <button key={o.v} type="button" className="em-channel" onClick={() => onPick(o.v)}>
            <span className="em-channel-icon">{o.icon}</span>
            <b>{o.title}</b>
            <span className="crm-muted small">{o.text}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Editor do e-mail
// ---------------------------------------------------------------------------
export function EmailEditor({ campaign, waCampaignId, onClose, onSaved }: {
  campaign: api.EmailCampaign | null; waCampaignId?: string | null; onClose: () => void; onSaved: (id: string, isNew: boolean) => void;
}) {
  const { tenantId, tenantName, notify } = useCrm();
  const [name, setName] = useState(campaign?.name ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? DEFAULT_SUBJECT);
  const [body, setBody] = useState(campaign?.body ?? DEFAULT_BODY);
  const [replyTo, setReplyTo] = useState(campaign?.reply_to ?? "");
  const [btnLabel, setBtnLabel] = useState(campaign?.button_label ?? "");
  const [btnUrl, setBtnUrl] = useState(campaign?.button_url ?? "");
  const [perMin, setPerMin] = useState(campaign?.per_minute ?? 20);
  const [daily, setDaily] = useState(campaign?.daily_limit ?? 500);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const linked = campaign?.wa_campaign_id ?? waCampaignId ?? null;

  useEffect(() => {
    if (campaign || replyTo) return;
    api.currentUserEmail().then((e) => { if (e) setReplyTo((v) => v || e); }).catch(() => {});
  }, [campaign]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadPdf(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    try {
      const up = await api.uploadFlowMedia(tenantId, f);
      setBtnUrl(up.url);
      if (!btnLabel.trim()) setBtnLabel(up.media_type === "document" ? "Ver apresentação (PDF)" : "Ver material");
      notify("Arquivo enviado — o e-mail leva o botão para ele");
    } catch (e) { notify(errorText(e)); } finally { setUploading(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const id = await api.emailSaveCampaign(tenantId, campaign?.id ?? null, {
        name: name.trim() || subject.trim().slice(0, 80), subject, body, reply_to: replyTo.trim() || null,
        button_label: btnUrl.trim() ? btnLabel.trim() || "Saiba mais" : null, button_url: btnUrl.trim() || null,
        per_minute: perMin, daily_limit: daily, wa_campaign_id: linked,
      });
      notify(campaign ? "E-mail atualizado" : linked ? "E-mail ligado ao disparo de WhatsApp" : "Disparo de e-mail criado — agora escolha quem vai receber");
      onSaved(id, !campaign);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  const urlBad = !!btnUrl.trim() && !/^https:\/\//i.test(btnUrl.trim());
  return (
    <Modal open onClose={onClose} title={campaign ? "Editar e-mail" : linked ? "E-mail junto com o WhatsApp" : "Novo disparo de e-mail"} width={760}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>{linked && !campaign ? "Pular e-mail" : "Cancelar"}</button>
        <button type="button" className="crm-btn primary" disabled={busy || uploading || !subject.trim() || !body.trim() || urlBad} onClick={save}>
          {campaign ? "Salvar" : linked ? "Salvar e-mail" : "Criar e escolher quem recebe"}
        </button>
      </>}>
      {linked && <p className="crm-muted small"><MessageCircle size={13} /> Os mesmos contatos do disparo de WhatsApp recebem este e-mail (quem tiver e-mail no cadastro ou na planilha). O WhatsApp continua com a automação; o e-mail é enviado uma vez, sem follow-up.</p>}
      <div className="crm-form-grid">
        {!linked && <Field label="Nome do disparo (só para você)" span={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Escolas — apresentação por e-mail" /></Field>}
        <Field label="Assunto" span={2}><input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></Field>
        <div className="wa-msg-edit" style={{ gridColumn: "1 / -1" }}>
          <div className="wa-msg-head">
            <b>Texto do e-mail</b>
            <div className="wa-vars">{VARS.map((v) => <button key={v} type="button" onClick={() => setBody((b) => `${b}${v}`)}>{v}</button>)}</div>
          </div>
          <textarea rows={9} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <Field label="Botão do e-mail (opcional)" hint="Ex.: link da apresentação, do site ou do WhatsApp">
          <input value={btnLabel} maxLength={60} onChange={(e) => setBtnLabel(e.target.value)} placeholder="Ver apresentação" />
        </Field>
        <Field label="Link do botão" hint={urlBad ? "precisa começar com https://" : "ou envie um PDF abaixo"}>
          <input value={btnUrl} onChange={(e) => setBtnUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <label className="crm-btn ghost sm" style={{ justifySelf: "start" }}>
          <FileUp size={14} /> {uploading ? "Enviando…" : "Enviar PDF/arquivo para o botão"}
          <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.mp4,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void uploadPdf(f); }} />
        </label>
        <Field label="Respostas vão para" hint="quem responder o e-mail escreve para este endereço">
          <input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="voce@empresa.com" />
        </Field>
      </div>

      <h4 className="wa-sub"><Mail size={15} /> Prévia</h4>
      <div className="em-preview">
        <div className="em-preview-head"><b>{tenantName}</b> <span className="crm-muted small">· {replyTo || "sem e-mail para respostas"}</span></div>
        <div className="em-preview-subject">{fill(subject) || "(sem assunto)"}</div>
        <div className="em-preview-body">{fill(body).split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
        {btnUrl.trim() && !urlBad && <span className="em-preview-btn">{btnLabel || "Saiba mais"}</span>}
        <p className="em-preview-foot">Você recebeu este e-mail de {tenantName}. Não quer mais receber? <u>Descadastrar</u></p>
      </div>

      <h4 className="wa-sub"><ShieldCheck size={15} /> Ritmo de envio</h4>
      <div className="crm-form-grid">
        <Field label="E-mails por minuto" hint="1 a 120"><input type="number" min={1} max={120} value={perMin} onChange={(e) => setPerMin(Math.min(120, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        <Field label="Limite por dia" hint="1 a 5000"><input type="number" min={1} max={5000} value={daily} onChange={(e) => setDaily(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))} /></Field>
      </div>
      <p className="crm-muted small">Todo e-mail leva o link “Descadastrar”. Quem se descadastra não recebe mais e-mails de disparo desta empresa.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Público do e-mail
// ---------------------------------------------------------------------------
export function EmailAudienceModal({ campaign, onClose, onDone }: { campaign: { id: string; wa_campaign_id: string | null }; onClose: () => void; onDone: () => void }) {
  const { tenantId, notify } = useCrm();
  const [src, setSrc] = useState<"rows" | "tag" | "wa">(campaign.wa_campaign_id ? "wa" : "rows");
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[] | null>(null);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<api.EmailAddResult | null>(null);

  useEffect(() => { api.flowTagSuggestions(tenantId).then((t) => { setTags(t); if (t[0]) setTag(t[0]); }).catch(() => setTags([])); }, [tenantId]);

  // "nome;email" por linha, só o e-mail, ou um CSV com coluna email
  const rows = useMemo(() => {
    const t = text.trim();
    if (!t) return [] as Record<string, string>[];
    const first = t.split(/\r?\n/)[0];
    if (/email|e-mail/i.test(first) && /[;,\t]/.test(first)) {
      const parsed = parseCsv(t);
      const h = parsed.headers.map((x) => x.trim().toLowerCase().replace("e-mail", "email"));
      return parsed.rows.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])) as Record<string, string>).filter((r) => r.email);
    }
    return t.split(/\r?\n/).map((line) => {
      const parts = line.split(/[;,\t]/).map((x) => x.trim()).filter(Boolean);
      const email = parts.find((p) => p.includes("@")) ?? "";
      const nome = parts.find((p) => !p.includes("@")) ?? "";
      return email ? { email, ...(nome ? { nome } : {}) } : null;
    }).filter(Boolean) as Record<string, string>[];
  }, [text]);

  async function add() {
    setBusy(true);
    try {
      let r: api.EmailAddResult;
      if (src === "wa") r = await api.emailAddRecipients(campaign.id, { source: "wa_campaign" });
      else if (src === "tag") {
        const ids: string[] = [];
        for (let page = 0; page < 5; page++) {
          const res = await api.loadContacts(tenantId, { tag, pageSize: 1000, page });
          ids.push(...res.rows.filter((c) => (c as { email?: string | null }).email).map((c) => c.id));
          if (res.rows.length < 1000) break;
        }
        r = await api.emailAddRecipients(campaign.id, { source: "contacts", contactIds: ids });
      } else r = await api.emailAddRecipients(campaign.id, { source: "rows", rows });
      setResult(r);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  const tabs = [
    ...(campaign.wa_campaign_id ? [{ value: "wa" as const, label: "Mesmos do WhatsApp" }] : []),
    { value: "rows" as const, label: "Digitar / colar e-mails" },
    { value: "tag" as const, label: "Contatos com etiqueta" },
  ];
  return (
    <Modal open onClose={result ? onDone : onClose} title="Quem vai receber o e-mail" width={620}
      footer={result ? <button type="button" className="crm-btn primary" onClick={onDone}>Pronto</button> : <>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || (src === "rows" ? rows.length === 0 : src === "tag" ? !tag : false)} onClick={add}>
          {busy ? "Adicionando…" : src === "rows" ? `Adicionar ${rows.length} e-mail(s)` : src === "wa" ? "Puxar contatos do WhatsApp" : "Adicionar contatos com e-mail"}
        </button>
      </>}>
      {result ? (
        <div className="wa-result">
          <CheckCircle2 size={28} className="tone-green" />
          <p><b>{result.added}</b> e-mail(s) adicionados · total: <b>{result.total}</b></p>
          <ul className="crm-muted small">
            {result.duplicates > 0 && <li>{result.duplicates} repetido(s) ignorado(s)</li>}
            {result.invalid_email > 0 && <li>{result.invalid_email} e-mail(s) inválido(s) ignorado(s)</li>}
            {result.opted_out > 0 && <li>{result.opted_out} já tinham se descadastrado — não vão receber</li>}
          </ul>
        </div>
      ) : <>
        <Tabs value={src} onChange={setSrc} tabs={tabs} />
        {src === "wa" ? (
          <p className="crm-muted">Entram os contatos do disparo de WhatsApp que têm e-mail (no cadastro do contato ou na coluna <code>email</code> da planilha). Ao iniciar o disparo, quem for adicionado ao WhatsApp depois também entra.</p>
        ) : src === "tag" ? (
          tags === null ? <Skeleton rows={2} /> : tags.length === 0 ? <p className="crm-muted">Nenhum contato com etiqueta ainda.</p> : (
            <Field label="Etiqueta">
              <select value={tag} onChange={(e) => setTag(e.target.value)}>{tags.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            </Field>
          )
        ) : (
          <div className="wa-paste">
            <p className="crm-muted small">Um por linha: só o e-mail, ou <code>nome;email</code>. Também aceita um CSV com as colunas <code>nome;email;empresa;cidade</code> — colunas extras viram variáveis. Para uma pessoa só, digite um e-mail.</p>
            <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={"maria@escola.com.br\nJoão Silva;joao@agro.com.br"} />
            <label className="crm-btn ghost sm"><Upload size={14} /> Escolher arquivo CSV<input type="file" accept=".csv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} /></label>
            {rows.length > 0 && <p className="crm-muted small">{rows.length} e-mail(s) reconhecido(s). Ex.: {rows[0].nome || rows[0].name || "—"} · {rows[0].email}</p>}
          </div>
        )}
      </>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cartão do disparo de e-mail (só e-mail) e faixa do e-mail junto com WhatsApp
// ---------------------------------------------------------------------------
function Stats({ c }: { c: api.EmailCampaign }) {
  const base = Math.max(1, c.total - c.opted_out - c.invalid);
  return <>
    <Bar value={c.sent} max={base} tone="green" />
    <div className="wa-camp-stats">
      <span><b>{c.sent}</b> de {c.total - c.opted_out - c.invalid} enviados</span>
      {c.invalid > 0 && <span><b>{c.invalid}</b> e-mail inválido</span>}
      {c.failed > 0 && <span className="tone-red"><b>{c.failed}</b> falharam</span>}
      {c.opted_out > 0 && <span><b>{c.opted_out}</b> descadastrados</span>}
    </div>
  </>;
}

export function EmailCampaignCard({ c, onAction, onEdit, onAudience, onDetail, canWrite }: {
  c: api.EmailCampaign; canWrite: boolean; onAction: (a: "start" | "pause" | "resume" | "cancel" | "archive") => void;
  onEdit: () => void; onAudience: () => void; onDetail: () => void;
}) {
  const [confirm, setConfirm] = useState<"start" | "cancel" | null>(null);
  return (
    <article className="crm-card wa-camp">
      <header>
        <button type="button" className="wa-camp-title" onClick={onDetail}>
          <Mail size={15} /> <strong>{c.name}</strong>
          <Pill tone={emailStatusInfo[c.status].tone}>{emailStatusInfo[c.status].label}</Pill>
          <Pill tone="blue">E-mail</Pill>
        </button>
        <div className="wa-camp-actions">
          {canWrite && (c.status === "draft" || c.status === "paused") && <>
            <button type="button" className="crm-btn ghost sm" onClick={onEdit}><Pencil size={14} /> Editar</button>
            <button type="button" className="crm-btn ghost sm" onClick={onAudience}><Users size={14} /> Público</button>
          </>}
          {canWrite && c.status === "draft" && <button type="button" className="crm-btn primary sm" disabled={c.pending === 0} title={c.pending === 0 ? "Adicione quem vai receber" : undefined} onClick={() => setConfirm("start")}><Play size={14} /> Iniciar</button>}
          {canWrite && c.status === "running" && <button type="button" className="crm-btn ghost sm" onClick={() => onAction("pause")}><Pause size={14} /> Pausar</button>}
          {canWrite && c.status === "paused" && <button type="button" className="crm-btn primary sm" onClick={() => onAction("resume")}><Play size={14} /> Retomar</button>}
          {canWrite && (c.status === "running" || c.status === "paused") && <button type="button" className="crm-icon-btn" title="Cancelar disparo" onClick={() => setConfirm("cancel")}><XCircle size={16} /></button>}
          {canWrite && c.status === "draft" && <button type="button" className="crm-icon-btn" title="Excluir rascunho" onClick={() => onAction("archive")}><Trash2 size={16} /></button>}
        </div>
      </header>
      <p className="wa-camp-msg"><b>{fill(c.subject)}</b> — {fill(c.body).slice(0, 160)}{c.body.length > 160 ? "…" : ""}</p>
      {c.total > 0 ? <Stats c={c} /> : <p className="crm-muted small">Sem público. {canWrite && <button type="button" className="crm-link" onClick={onAudience}>Adicionar e-mails</button>}</p>}
      <footer className="crm-muted small">
        <ShieldCheck size={13} /> até {c.per_minute}/min · {c.daily_limit}/dia · com link de descadastro
        {c.status === "completed" && c.completed_at && <> · terminou {relative(c.completed_at)}</>}
      </footer>
      <Confirm open={confirm === "start"} onClose={() => setConfirm(null)} confirmLabel="Enviar e-mails"
        title={`Enviar “${c.name}”?`} text={`Serão ${c.pending} e-mail(s), até ${c.per_minute} por minuto. Você pode pausar a qualquer momento.`}
        onConfirm={() => onAction("start")} />
      <Confirm open={confirm === "cancel"} onClose={() => setConfirm(null)} danger confirmLabel="Cancelar disparo"
        title="Cancelar este disparo de e-mail?" text="Quem ainda não recebeu não vai receber." onConfirm={() => onAction("cancel")} />
    </article>
  );
}

/** Faixa dentro do cartão do WhatsApp quando há e-mail junto. */
export function LinkedEmailStrip({ c, canWrite, onEdit, onDetail }: { c: api.EmailCampaign; canWrite: boolean; onEdit: () => void; onDetail: () => void }) {
  return (
    <div className="em-strip">
      <button type="button" className="em-strip-title" onClick={onDetail}><Mail size={14} /> E-mail junto: <b>{fill(c.subject)}</b></button>
      <Pill tone={emailStatusInfo[c.status].tone}>{emailStatusInfo[c.status].label}</Pill>
      <span className="crm-muted small">{c.total ? `${c.sent} de ${c.total - c.opted_out - c.invalid} enviados` : "contatos entram ao iniciar"}</span>
      {canWrite && (c.status === "draft" || c.status === "paused") && <button type="button" className="crm-btn ghost xs" onClick={onEdit}><Pencil size={12} /> Editar e-mail</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe: quem recebeu
// ---------------------------------------------------------------------------
export function EmailCampaignDetail({ campaign, onClose }: { campaign: api.EmailCampaign; onClose: () => void }) {
  const { notify, openContact } = useCrm();
  const [filter, setFilter] = useState<api.EmailRecipientStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: api.EmailRecipient[]; count: number } | null>(null);
  const pageSize = 50;
  const load = useCallback(async () => {
    try { setData(await api.emailRecipients(campaign.id, { status: filter, search, page, pageSize })); } catch (e) { notify(errorText(e)); }
  }, [campaign.id, filter, search, page, notify]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Modal open onClose={onClose} title={campaign.name} width={760}>
      <p className="crm-muted small">Assunto: <b>{fill(campaign.subject)}</b>{campaign.reply_to ? ` · respostas para ${campaign.reply_to}` : ""}</p>
      <div className="crm-toolbar">
        <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(0); }} tabs={[
          { value: "all", label: "Todos", count: campaign.total }, { value: "sent", label: "Enviados", count: campaign.sent },
          { value: "pending", label: "Na fila", count: campaign.pending }, { value: "failed", label: "Falharam", count: campaign.failed },
          { value: "invalid", label: "Inválidos", count: campaign.invalid }, { value: "opted_out", label: "Descadastrados", count: campaign.opted_out },
        ]} />
        <div className="crm-search"><Search size={14} /><input value={search} placeholder="Buscar e-mail ou nome" onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></div>
      </div>
      {!data ? <Skeleton rows={4} /> : data.rows.length === 0 ? <Empty icon={<Mail size={20} />} title="Ninguém aqui" text="Nenhum destinatário neste filtro." /> : (
        <table className="crm-table">
          <thead><tr><th>E-mail</th><th>Nome</th><th>Situação</th><th>Enviado</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.crm_contact_id ? <button type="button" className="crm-link" onClick={() => openContact(r.crm_contact_id!)}>{r.email}</button> : r.email}</td>
                <td>{r.name ?? "—"}</td>
                <td><Pill tone={recipientInfo[r.status].tone}>{recipientInfo[r.status].label}</Pill>{r.error && <div className="crm-muted small">{r.error}</div>}</td>
                <td>{r.sent_at ? dateTime(r.sent_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.count > pageSize && (
        <div className="crm-row between">
          <button type="button" className="crm-btn ghost sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anteriores</button>
          <span className="crm-muted small">{page * pageSize + 1}–{Math.min(data.count, (page + 1) * pageSize)} de {data.count}</span>
          <button type="button" className="crm-btn ghost sm" disabled={(page + 1) * pageSize >= data.count} onClick={() => setPage(page + 1)}>Próximos</button>
        </div>
      )}
    </Modal>
  );
}

