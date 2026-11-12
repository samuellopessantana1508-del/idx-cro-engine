import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, CheckCheck, Clock, Headphones, Pencil, Plus, RotateCcw, Send, Trash2, UserRound, Zap } from "lucide-react";
import * as api from "./api";
import { errorText } from "./format";
import type { Member, WaGatewayInstance } from "./types";
import { Modal } from "./ui";
import { CloudWindowNote, TemplateSendBox } from "./wa-channel";

type Pending = { id: string; body: string; status: string; error: string | null };

/**
 * Caixa de resposta da conversa do WhatsApp. Envia pelo motor único do CRO
 * (mesma conexão dos disparos). A mensagem aparece na conversa assim que o
 * WhatsApp confirma; enquanto isso fica como "enviando".
 */
export function WaReplyBox({ tenantId, conversationId, notify, onOpenConnection, onDelivered }: {
  tenantId: string; conversationId: string; notify: (m: string) => void; onOpenConnection: () => void; onDelivered?: () => void;
}) {
  const [inst, setInst] = useState<WaGatewayInstance | null | undefined>(undefined);
  const [channel, setChannel] = useState<api.WaChannel | null | undefined>(undefined);
  const [win, setWin] = useState<{ provider: string; open: boolean; last_inbound_at: string | null } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.waInstance(tenantId).then((i) => { if (alive) setInst(i); }).catch(() => { if (alive) setInst(null); });
      api.waChannel(tenantId).then((c) => { if (alive) setChannel(c); }).catch(() => { if (alive) setChannel(null); });
    };
    void load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [tenantId]);

  useEffect(() => { setPending([]); setText(""); }, [conversationId]);

  // API oficial: janela de 24 h desde a última mensagem do cliente
  useEffect(() => {
    if (channel?.active !== "cloud_api") { setWin(null); return; }
    let alive = true;
    const load = () => api.waConversationWindow(conversationId).then((w) => { if (alive) setWin(w); }).catch(() => {});
    void load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [conversationId, channel?.active]);

  // acompanha os envios desta conversa até sair
  useEffect(() => {
    if (!pending.some((p) => p.status === "queued" || p.status === "sending")) return;
    const t = setInterval(async () => {
      try {
        const rows = await api.waOutbox(tenantId, 20);
        const justSent = pending.some((p) => rows.find((x) => x.id === p.id)?.status === "sent");
        setPending((cur) => cur
          .map((p) => { const r = rows.find((x) => x.id === p.id); return r ? { ...p, status: r.status, error: r.error } : p; })
          .filter((p) => p.status !== "sent"));
        if (justSent) onDelivered?.();
      } catch { /* tenta de novo */ }
    }, 2000);
    return () => clearInterval(t);
  }, [pending, tenantId, onDelivered]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const id = await api.waSend(tenantId, body, { conversationId });
      setPending((p) => [...p, { id, body, status: "queued", error: null }]);
      setText("");
      ref.current?.focus();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  if (inst === undefined || channel === undefined) return null;
  const official = channel?.active === "cloud_api";
  if (official ? !channel?.cloud : !inst) {
    return (
      <div className="wa-readonly-bar">
        Para responder por aqui, conecte o WhatsApp do CRO.{" "}
        <button type="button" className="crm-link" onClick={onOpenConnection}>Ver conexão</button>
      </div>
    );
  }
  const connected = official ? channel?.cloud?.status === "connected" : inst?.status === "connected";
  const closedWindow = official && win !== null && !win.open;
  return (
    <>
      {pending.length > 0 && (
        <div className="wa-reply-note">
          {pending.map((p) => (
            <div key={p.id}>
              {p.status === "failed"
                ? <span className="tone-red"><AlertTriangle size={12} /> Não enviada: {p.error ?? "erro"} — “{p.body.slice(0, 40)}”</span>
                : <span><Clock size={12} /> Enviando “{p.body.slice(0, 40)}{p.body.length > 40 ? "…" : ""}”</span>}
            </div>
          ))}
        </div>
      )}
      <ConversationBar tenantId={tenantId} conversationId={conversationId} notify={notify} />
      {!connected && <div className="wa-reply-note"><AlertTriangle size={12} /> WhatsApp desconectado — a mensagem fica na fila e sai quando reconectar.</div>}
      {closedWindow ? (
        <div className="wa-reply-tpl">
          <CloudWindowNote lastInboundAt={win!.last_inbound_at} />
          <TemplateSendBox tenantId={tenantId} target={{ conversationId }} notify={notify} onSent={() => onDelivered?.()} />
        </div>
      ) : (
      <div className="wa-reply">
        <QuickReplies tenantId={tenantId} text={text} notify={notify} onPick={(b) => { setText(b); ref.current?.focus(); }} />
        <textarea ref={ref} rows={1} value={text} placeholder="Escreva uma resposta…" maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="button" className="crm-btn primary" disabled={busy || !text.trim()} onClick={send} title="Enviar (Enter)"><Send size={16} /></button>
      </div>
      )}
    </>
  );
}

const WAIT_TEXT: Record<string, string> = { response: "aguardando resposta", menu: "aguardando escolha do menu", ask: "aguardando resposta da pergunta", delay: "esperando", business_hours: "esperando o horário" };
const memberName = (m: Member) => (m.email ?? "").split("@")[0] || "usuário";

/** Responsável, concluir conversa e robô x atendente (automações). */
function ConversationBar({ tenantId, conversationId, notify }: { tenantId: string; conversationId: string; notify: (m: string) => void }) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.conversationBotState>> | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.loadMembers(tenantId).then((m) => setMembers(m.filter((x) => x.status === "active"))).catch(() => {}); }, [tenantId]);
  useEffect(() => {
    let alive = true;
    setSt(null);
    const load = () => api.conversationBotState(conversationId).then((x) => { if (alive) setSt(x); }).catch(() => {});
    void load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [conversationId]);
  if (!st) return null;
  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    try { await fn(); setSt(await api.conversationBotState(conversationId)); notify(msg); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  };
  const r = st.runs[0];
  return (
    <div className="wa-conv-bar">
      <div className="wa-conv-team">
        <UserRound size={14} />
        <select value={st.assignedTo ?? ""} disabled={busy} aria-label="Responsável pela conversa"
          onChange={(e) => void run(() => api.conversationAssign(conversationId, e.target.value || null), e.target.value ? "Conversa transferida." : "Conversa sem responsável.")}>
          <option value="">Sem responsável</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>)}
        </select>
        <button type="button" className="crm-btn ghost xs" disabled={busy}
          onClick={() => void run(() => api.conversationClose(conversationId, !st.closed), st.closed ? "Conversa reaberta." : "Conversa concluída — volta sozinha se o cliente escrever.")}>
          {st.closed ? <><RotateCcw size={12} /> Reabrir</> : <><CheckCheck size={12} /> Concluir</>}
        </button>
      </div>
      {st.mode === "human" ? (
        <div className="wa-bot-bar human">
          <Headphones size={14} /> <span>Atendimento humano — automações pausadas nesta conversa.</span>
          <button type="button" className="crm-btn ghost xs" disabled={busy} onClick={() => void run(() => api.conversationBot(conversationId, "bot"), "Conversa devolvida ao robô.")}>Devolver ao robô</button>
        </div>
      ) : r ? (
        <div className="wa-bot-bar">
          <Bot size={14} /> <span>Em automação: <b>{r.wa_flows?.name ?? "automação"}</b>{r.wait_kind ? ` · ${WAIT_TEXT[r.wait_kind] ?? ""}` : ""}{r.is_test ? " (teste)" : ""}</span>
          <button type="button" className="crm-btn ghost xs" disabled={busy} onClick={() => void run(() => api.conversationBot(conversationId, "human"), "Você assumiu a conversa — as automações param aqui.")}>Assumir conversa</button>
        </div>
      ) : null}
    </div>
  );
}

/** Respostas rápidas: botão ⚡ ou digite “/” no começo da mensagem. */
function QuickReplies({ tenantId, text, onPick, notify }: { tenantId: string; text: string; onPick: (body: string) => void; notify: (m: string) => void }) {
  const [list, setList] = useState<api.QuickReply[] | null>(null);
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [edit, setEdit] = useState<{ id: string | null; title: string; body: string } | null>(null);
  const load = () => api.quickReplies(tenantId).then(setList).catch(() => setList([]));
  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  const slash = text.startsWith("/") ? text.slice(1).toLowerCase() : null;
  const show = open || (slash !== null && !!list?.length);
  const items = (list ?? []).filter((q) => !slash || q.title.toLowerCase().includes(slash) || q.body.toLowerCase().includes(slash));
  return (
    <>
      <button type="button" className="crm-icon-btn wa-qr-btn" title="Respostas rápidas (ou digite /)" onClick={() => setOpen((o) => !o)}><Zap size={16} /></button>
      {show && (
        <div className="wa-qr-pop" onMouseLeave={() => setOpen(false)}>
          <div className="wa-qr-head"><b>Respostas rápidas</b><button type="button" className="crm-link" onClick={() => { setManage(true); setOpen(false); }}>Gerenciar</button></div>
          {items.length === 0 ? <p className="crm-muted small">{list?.length ? "Nada encontrado." : "Nenhuma ainda — clique em Gerenciar para criar."}</p>
            : items.slice(0, 8).map((q) => (
              <button key={q.id} type="button" className="wa-qr-item" onClick={() => { onPick(q.body); setOpen(false); }}>
                <strong>/{q.title}</strong><span>{q.body}</span>
              </button>
            ))}
        </div>
      )}
      {manage && (
        <Modal open onClose={() => { setManage(false); setEdit(null); }} title="Respostas rápidas" width={560}
          footer={edit ? <>
            <button type="button" className="crm-btn ghost" onClick={() => setEdit(null)}>Cancelar</button>
            <button type="button" className="crm-btn primary" disabled={!edit.title.trim() || !edit.body.trim()} onClick={async () => {
              try { await api.quickReplySave(tenantId, edit.id, edit.title, edit.body); setEdit(null); void load(); } catch (e) { notify(errorText(e)); }
            }}>Salvar</button>
          </> : <button type="button" className="crm-btn primary" onClick={() => setEdit({ id: null, title: "", body: "" })}><Plus size={15} /> Nova resposta</button>}>
          {edit ? (
            <div className="crm-stack tight">
              <label className="fz-field"><span className="fz-field-label">Atalho</span><input value={edit.title} maxLength={60} placeholder="horario" onChange={(e) => setEdit({ ...edit, title: e.target.value.replace(/^\//, "") })} /></label>
              <label className="fz-field"><span className="fz-field-label">Mensagem</span><textarea rows={5} value={edit.body} maxLength={4000} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
            </div>
          ) : (list ?? []).length === 0 ? <p className="crm-muted">Crie textos que a equipe usa sempre (horário, endereço, formas de pagamento…). Na conversa, digite <b>/</b> para usar.</p> : (
            <div className="wa-qr-manage">
              {(list ?? []).map((q) => (
                <div key={q.id}>
                  <div><strong>/{q.title}</strong><span className="crm-muted small">{q.body}</span></div>
                  <button type="button" className="crm-icon-btn" title="Editar" onClick={() => setEdit({ id: q.id, title: q.title, body: q.body })}><Pencil size={14} /></button>
                  <button type="button" className="crm-icon-btn" title="Excluir" onClick={async () => { try { await api.quickReplyDelete(q.id); void load(); } catch (e) { notify(errorText(e)); } }}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
