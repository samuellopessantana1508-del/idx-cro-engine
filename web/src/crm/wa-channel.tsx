// Conexão do WhatsApp: a empresa escolhe entre QR Code (motor do CRO) e a API oficial da Meta.
// Usado em WhatsApp → Conexão e (resumido) em Disparos.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, Clipboard, ExternalLink, FileText, KeyRound, QrCode, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import * as api from "./api";
import type { WaChannel, WaTemplate, WaTemplateChoice } from "./api";
import { errorText, phoneLabel, relative } from "./format";
import { Confirm, Field, Pill, Skeleton } from "./ui";
import { ConnectionPanel } from "./dispatch";

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || "https://tykeycwworjtfpssjevw.supabase.co");

export function useWaChannel(tenantId: string) {
  const [channel, setChannel] = useState<WaChannel | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setChannel(await api.waChannel(tenantId)); } catch { setChannel(null); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);
  return { channel, setChannel, reload: load };
}

function copy(text: string, notify: (m: string) => void, what: string) {
  void navigator.clipboard?.writeText(text).then(() => notify(`${what} copiado`)).catch(() => notify("Não foi possível copiar"));
}

/** Tela completa: as duas opções lado a lado, a escolha e a configuração de cada uma. */
export function WaChannelPanel({ tenantId, canConfigure, notify }: { tenantId: string; canConfigure: boolean; notify: (m: string) => void }) {
  const { channel, setChannel, reload } = useWaChannel(tenantId);
  const [view, setView] = useState<"gateway" | "cloud_api" | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<"gateway" | "cloud_api" | null>(null);

  useEffect(() => { if (channel && !view) setView(channel.active); }, [channel, view]);
  // o QR Code muda de estado sozinho (leitura do QR): atualiza o resumo de tempos em tempos
  useEffect(() => { const t = setInterval(() => void reload(), 15000); return () => clearInterval(t); }, [reload]);

  if (channel === undefined) return <Skeleton rows={2} height={90} />;
  if (channel === null) return <p className="crm-muted">Não foi possível carregar a conexão do WhatsApp.</p>;

  const qrOk = channel.gateway?.status === "connected";
  const cloudOk = channel.cloud?.status === "connected";

  async function use(p: "gateway" | "cloud_api") {
    setBusy(true);
    try {
      setChannel(await api.waChannelSet(tenantId, p));
      notify(p === "cloud_api" ? "Agora o CRO envia pela API oficial do WhatsApp" : "Agora o CRO envia pelo QR Code");
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); setConfirmSwitch(null); }
  }

  const Option = ({ p, title, icon, status, ready, pros, cons }: {
    p: "gateway" | "cloud_api"; title: string; icon: JSX.Element; status: string; ready: boolean; pros: string[]; cons: string[];
  }) => {
    const active = channel.active === p;
    return (
      <div className={`wa-opt ${active ? "active" : ""} ${view === p ? "open" : ""}`} role="button" tabIndex={0}
        onClick={() => setView(p)} onKeyDown={(e) => { if (e.key === "Enter") setView(p); }}>
        <div className="wa-opt-head">
          <span className="wa-opt-icon">{icon}</span>
          <strong>{title}</strong>
          {active ? <Pill tone="green">Em uso</Pill> : <Pill tone={ready ? "blue" : "muted"}>{status}</Pill>}
        </div>
        <ul className="wa-opt-list">
          {pros.map((x) => <li key={x} className="pro">{x}</li>)}
          {cons.map((x) => <li key={x} className="con">{x}</li>)}
        </ul>
        {canConfigure && !active && (
          <button type="button" className="crm-btn sm" disabled={busy || !ready}
            title={ready ? "" : p === "cloud_api" ? "Configure e teste a API oficial primeiro" : "Conecte o QR Code primeiro"}
            onClick={(e) => { e.stopPropagation(); setConfirmSwitch(p); }}>
            Usar esta conexão
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="wa-channel">
      <div className="wa-opts">
        <Option p="gateway" title="QR Code (WhatsApp do celular)" icon={<QrCode size={18} />}
          status={qrOk ? "Conectado" : "Não conectado"} ready={qrOk}
          pros={["Conecta em 1 minuto, sem aprovação", "Lê grupos e extrai contatos", "Sem custo por mensagem"]}
          cons={["Não é oficial: disparos em massa podem bloquear o número"]} />
        <Option p="cloud_api" title="API oficial da Meta" icon={<BadgeCheck size={18} />}
          status={cloudOk ? "Pronta para usar" : channel.cloud ? "Com erro" : "Não configurada"} ready={cloudOk}
          pros={["Oficial: sem risco de bloqueio por uso do QR", "Vários atendentes e grande volume", "Status de entrega e leitura da Meta"]}
          cons={["Fora de 24 h da última mensagem do cliente, só modelos aprovados", "A Meta cobra por conversa iniciada"]} />
      </div>

      {view === "gateway" && (
        <div className="wa-opt-body">
          <ConnectionPanel tenantId={tenantId} canConfigure={canConfigure} notify={notify} />
          {channel.active === "cloud_api" && <p className="crm-muted small">O QR Code continua recebendo mensagens na caixa de entrada, mas os envios estão saindo pela API oficial.</p>}
        </div>
      )}
      {view === "cloud_api" && (
        <div className="wa-opt-body">
          <CloudSetup tenantId={tenantId} channel={channel} canConfigure={canConfigure} notify={notify}
            onChannel={(c) => setChannel(c)} />
        </div>
      )}

      <Confirm open={!!confirmSwitch} onClose={() => setConfirmSwitch(null)} confirmLabel="Trocar conexão"
        title={confirmSwitch === "cloud_api" ? "Enviar pela API oficial da Meta?" : "Enviar pelo QR Code?"}
        text={confirmSwitch === "cloud_api"
          ? "Respostas, disparos, automações e cadências passam a sair pela API oficial. Disparos precisam de um modelo aprovado e mensagens fora da janela de 24 horas também. O que está na fila passa para a nova conexão."
          : "Respostas, disparos, automações e cadências passam a sair pelo número conectado no QR Code. O que está na fila passa para a nova conexão."}
        onConfirm={() => confirmSwitch && use(confirmSwitch)} />
    </div>
  );
}

function CloudSetup({ tenantId, channel, canConfigure, notify, onChannel }: {
  tenantId: string; channel: WaChannel; canConfigure: boolean; notify: (m: string) => void; onChannel: (c: WaChannel) => void;
}) {
  const c = channel.cloud;
  const [pnid, setPnid] = useState(c?.phone_number_id ?? "");
  const [waba, setWaba] = useState(c?.waba_id ?? "");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(!c);
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);

  const loadTemplates = useCallback(async () => {
    if (!c) { setTemplates([]); return; }
    try { setTemplates(await api.waTemplates(tenantId)); } catch { setTemplates([]); }
  }, [tenantId, c?.id, c?.templates]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  async function run(kind: string, f: () => Promise<{ ok: boolean; error?: string; warning?: string | null; channel: WaChannel }>) {
    setBusy(kind); setWarning(null);
    try {
      const r = await f();
      onChannel(r.channel);
      if (r.ok) {
        notify(kind === "save" ? "API oficial conectada" : "Conexão com a Meta funcionando");
        setWarning(r.warning ?? null); setToken(""); setSecret(""); setEditing(false);
      } else notify(r.error ?? "A Meta recusou a conexão");
    } catch (e) { notify(errorText(e)); } finally { setBusy(null); }
  }

  async function sync() {
    setBusy("sync");
    try {
      const r = await api.waCloudSyncTemplates(tenantId);
      notify(`${r.approved} modelo(s) aprovado(s) de ${r.total}`);
      onChannel(await api.waChannel(tenantId));
      await loadTemplates();
    } catch (e) { notify(errorText(e)); } finally { setBusy(null); }
  }

  const webhookUrl = c ? `${SUPABASE_URL}/functions/v1/wa-cloud/webhook/${c.id}` : null;
  const ok = c?.status === "connected";

  return (
    <section className="crm-card wa-cloud">
      <div className="wa-conn-head">
        <div className="wa-conn-icon">{ok ? <BadgeCheck size={20} /> : <KeyRound size={20} />}</div>
        <div className="wa-conn-text">
          <strong>{ok ? `API oficial conectada · ${phoneLabel(c!.phone)}` : c ? "API oficial com problema" : "Configurar a API oficial do WhatsApp"}</strong>
          <span className="crm-muted">
            {ok ? [c!.verified_name, c!.quality ? `qualidade ${({ GREEN: "alta", YELLOW: "média", RED: "baixa" } as Record<string, string>)[c!.quality] ?? c!.quality}` : null,
                   c!.webhook_seen_at ? `última notícia da Meta ${relative(c!.webhook_seen_at)}` : "aguardando a primeira mensagem pelo webhook"].filter(Boolean).join(" · ")
              : "Use o número cadastrado na plataforma do WhatsApp Business da Meta (Cloud API)."}
          </span>
          {c?.last_error && !ok && <span className="wa-conn-err"><AlertTriangle size={13} /> {c.last_error}</span>}
          {warning && <span className="wa-conn-err"><AlertTriangle size={13} /> {warning}</span>}
        </div>
        {canConfigure && c && !editing && (
          <div className="wa-conn-actions">
            <button type="button" className="crm-btn ghost" disabled={!!busy} onClick={() => run("test", () => api.waCloudTest(tenantId))}>
              <RefreshCw size={15} className={busy === "test" ? "spin" : ""} /> Testar
            </button>
            <button type="button" className="crm-btn ghost" onClick={() => setEditing(true)}>Alterar dados</button>
            <button type="button" className="crm-btn ghost danger-text" onClick={() => setConfirmRemove(true)}><Trash2 size={15} /> Remover</button>
          </div>
        )}
      </div>

      {canConfigure && editing && (
        <form className="wa-cloud-form" onSubmit={(e) => { e.preventDefault(); void run("save", () => api.waCloudSave(tenantId, { phone_number_id: pnid, waba_id: waba, access_token: token || undefined, app_secret: secret || undefined })); }}>
          <div className="crm-form-grid">
            <Field label="ID do número (Phone Number ID)" hint="WhatsApp → Configuração da API, no app da Meta">
              <input value={pnid} onChange={(e) => setPnid(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Ex.: 105954558954427" required />
            </Field>
            <Field label="ID da conta do WhatsApp Business (WABA ID)" hint="usado para buscar os modelos aprovados">
              <input value={waba} onChange={(e) => setWaba(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Ex.: 102290129340398" required />
            </Field>
            <Field label="Token de acesso permanente" hint={c?.token_hint ? `deixe em branco para manter o atual (…${c.token_hint})` : "token de usuário do sistema com whatsapp_business_messaging"} span={2}>
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c ? "••••••••" : "Cole aqui o token (EAAG…)"} required={!c} />
            </Field>
            <Field label="Chave secreta do app (opcional, recomendado)" hint={c?.has_app_secret ? "já cadastrada — deixe em branco para manter" : "confere que as mensagens vieram mesmo da Meta"} span={2}>
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="App secret do app da Meta" />
            </Field>
          </div>
          <div className="wa-cloud-actions">
            {c && <button type="button" className="crm-btn ghost" onClick={() => setEditing(false)}>Cancelar</button>}
            <button type="submit" className="crm-btn primary" disabled={!!busy || !pnid || !waba || (!c && !token)}>
              <ShieldCheck size={15} /> {busy === "save" ? "Conectando…" : "Salvar e testar"}
            </button>
          </div>
          <p className="crm-muted small"><ShieldCheck size={12} /> O token e a chave secreta ficam criptografados no servidor e nunca voltam para o navegador.</p>
        </form>
      )}
      {!canConfigure && !c && <p className="crm-muted small">Peça a um gestor para configurar a API oficial.</p>}

      {c && webhookUrl && canConfigure && (
        <div className="wa-cloud-hook">
          <h4 className="wa-sub">Webhook (para receber mensagens)</h4>
          <ol className="wa-steps">
            <li>No app da Meta, abra <b>WhatsApp → Configuração</b> e clique em <b>Editar</b> no Webhook.</li>
            <li>Cole a URL de retorno e o token de verificação abaixo e clique em <b>Verificar e salvar</b>.</li>
            <li>Em <b>Campos do webhook</b>, assine <b>messages</b>.</li>
          </ol>
          <div className="wa-copy"><span>URL de retorno</span><code>{webhookUrl}</code>
            <button type="button" className="crm-icon-btn" title="Copiar" onClick={() => copy(webhookUrl, notify, "Endereço")}><Clipboard size={14} /></button></div>
          {c.verify_token && <div className="wa-copy"><span>Token de verificação</span><code>{c.verify_token}</code>
            <button type="button" className="crm-icon-btn" title="Copiar" onClick={() => copy(c.verify_token!, notify, "Token")}><Clipboard size={14} /></button></div>}
          <a className="crm-link small" href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Abrir os apps da Meta <ExternalLink size={12} /></a>
        </div>
      )}

      {c && (
        <div className="wa-cloud-tpl">
          <div className="wa-cloud-tpl-head">
            <h4 className="wa-sub"><FileText size={15} /> Modelos aprovados ({templates?.length ?? c.templates})</h4>
            <button type="button" className="crm-btn ghost sm" disabled={!!busy} onClick={sync}><RefreshCw size={14} className={busy === "sync" ? "spin" : ""} /> Atualizar da Meta</button>
          </div>
          <p className="crm-muted small">Modelos são criados e aprovados no Gerenciador do WhatsApp da Meta. Eles são obrigatórios para disparos e para falar com quem não mandou mensagem nas últimas 24 horas.</p>
          {templates === null ? <Skeleton rows={2} height={30} /> : templates.length === 0
            ? <p className="crm-muted small">Nenhum modelo aprovado ainda.</p>
            : <ul className="wa-tpl-list">{templates.map((t) => (
                <li key={t.id}><b>{t.name}</b> <span className="crm-muted small">{t.language} · {t.category ?? ""}{t.param_count ? ` · ${t.param_count} variável(is)` : ""}</span>
                  {!api.sendableTemplate(t) && <Pill tone="amber" title="Modelos com imagem/vídeo/documento no cabeçalho ainda não são enviados pelo CRO">com mídia</Pill>}
                  <div className="wa-bubble small">{t.body_text}</div></li>))}</ul>}
        </div>
      )}

      <Confirm open={confirmRemove} onClose={() => setConfirmRemove(false)} danger confirmLabel="Remover"
        title="Remover a API oficial?" text="O token é apagado e o CRO volta a enviar pelo QR Code. O histórico das conversas continua na caixa de entrada."
        onConfirm={async () => { setConfirmRemove(false); try { const r = await api.waCloudRemove(tenantId); onChannel(r.channel); setEditing(true); notify("API oficial removida"); } catch (e) { notify(errorText(e)); } }} />
    </section>
  );
}

/** Resumo para a tela de Disparos: mostra a conexão em uso. */
export function WaChannelSummary({ tenantId, canConfigure, notify, onOpenConnection }: {
  tenantId: string; canConfigure: boolean; notify: (m: string) => void; onOpenConnection?: () => void;
}) {
  const { channel } = useWaChannel(tenantId);
  if (channel === undefined) return <section className="crm-card wa-conn"><Skeleton rows={1} /></section>;
  if (!channel || channel.active === "gateway") return <ConnectionPanel tenantId={tenantId} canConfigure={canConfigure} notify={notify} />;
  const ok = channel.cloud?.status === "connected";
  return (
    <section className={`crm-card wa-conn ${ok ? "ok" : ""}`}>
      <div className="wa-conn-head">
        <div className="wa-conn-icon"><BadgeCheck size={20} /></div>
        <div className="wa-conn-text">
          <strong>{ok ? `API oficial do WhatsApp · ${phoneLabel(channel.cloud?.phone ?? null)}` : "API oficial com problema"}</strong>
          <span className="crm-muted">{ok ? "Disparos usam um modelo aprovado pela Meta. Respostas dentro de 24 h saem como texto normal." : channel.cloud?.last_error ?? "Teste a conexão em WhatsApp → Conexão."}</span>
        </div>
        {onOpenConnection && <div className="wa-conn-actions"><button type="button" className="crm-btn ghost" onClick={onOpenConnection}>Ver conexão</button></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Modelos: escolher e preencher as variáveis
// ---------------------------------------------------------------------------
export function fillTemplate(body: string | null, params: string[]) {
  return String(body ?? "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`);
}

export function TemplateFields({ templates, value, onChange, vars, sample }: {
  templates: WaTemplate[]; value: WaTemplateChoice | null; onChange: (v: WaTemplateChoice | null) => void;
  vars?: string[]; sample?: (p: string) => string;
}) {
  const usable = useMemo(() => templates.filter(api.sendableTemplate), [templates]);
  const current = usable.find((t) => t.name === value?.name && t.language === value?.language) ?? null;
  const params = value?.params ?? [];
  function pick(key: string) {
    const t = usable.find((x) => `${x.name}|${x.language}` === key);
    onChange(t ? { name: t.name, language: t.language, params: Array.from({ length: t.param_count }, (_, i) => params[i] ?? "") } : null);
  }
  if (usable.length === 0) return <p className="wa-warn"><AlertTriangle size={14} /> Nenhum modelo aprovado. Crie um no Gerenciador do WhatsApp da Meta e clique em “Atualizar da Meta” em WhatsApp → Conexão.</p>;
  return (
    <div className="wa-tpl-fields">
      <Field label="Modelo aprovado pela Meta" span={2}>
        <select value={current ? `${current.name}|${current.language}` : ""} onChange={(e) => pick(e.target.value)}>
          <option value="">Escolha um modelo…</option>
          {usable.map((t) => <option key={t.id} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>)}
        </select>
      </Field>
      {current && params.map((p, i) => (
        <Field key={i} label={`Variável {{${i + 1}}}`}>
          <div className="wa-tpl-param">
            <input value={p} onChange={(e) => onChange({ ...value!, params: params.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={vars?.length ? `Ex.: ${vars[0]}` : "Texto"} />
            {vars && <div className="wa-vars">{vars.map((v) => <button key={v} type="button" onClick={() => onChange({ ...value!, params: params.map((x, j) => (j === i ? x + v : x)) })}>{v}</button>)}</div>}
          </div>
        </Field>
      ))}
      {current && <div className="wa-bubble" title="Prévia">{fillTemplate(current.body_text, params.map((p) => (sample ? sample(p) : p)))}</div>}
    </div>
  );
}

/** Envio de um modelo para uma conversa/telefone (fora da janela de 24 h). */
export function TemplateSendBox({ tenantId, target, notify, onSent }: {
  tenantId: string; target: { phone?: string | null; conversationId?: string | null }; notify: (m: string) => void; onSent?: () => void;
}) {
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [value, setValue] = useState<WaTemplateChoice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.waTemplates(tenantId).then(setTemplates).catch(() => setTemplates([])); }, [tenantId]);
  if (templates === null) return <Skeleton rows={1} height={36} />;
  const ready = !!value && value.params.every((p) => p.trim());
  async function send() {
    if (!value) return;
    setBusy(true);
    try { await api.waSendTemplate(tenantId, value, target); notify("Modelo enviado para a fila"); setValue(null); onSent?.(); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="wa-tpl-send">
      <TemplateFields templates={templates} value={value} onChange={setValue} />
      {templates.some(api.sendableTemplate) && (
        <button type="button" className="crm-btn primary sm" disabled={!ready || busy} onClick={send}><Send size={14} /> Enviar modelo</button>
      )}
    </div>
  );
}

export function CloudWindowNote({ lastInboundAt }: { lastInboundAt: string | null }) {
  return (
    <p className="wa-warn"><AlertTriangle size={14} />
      {lastInboundAt ? ` A última mensagem do cliente foi ${relative(lastInboundAt)}. ` : " Este contato ainda não mandou mensagem. "}
      Pela API oficial, fora da janela de 24 horas só é possível enviar um modelo aprovado.
    </p>
  );
}
