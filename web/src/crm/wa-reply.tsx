import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, Send } from "lucide-react";
import * as api from "./api";
import { errorText } from "./format";
import type { WaGatewayInstance } from "./types";

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
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.waInstance(tenantId).then((i) => { if (alive) setInst(i); }).catch(() => { if (alive) setInst(null); });
    void load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [tenantId]);

  useEffect(() => { setPending([]); setText(""); }, [conversationId]);

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

  if (inst === undefined) return null;
  if (!inst) {
    return (
      <div className="wa-readonly-bar">
        Para responder por aqui, conecte o WhatsApp do CRO.{" "}
        <button type="button" className="crm-link" onClick={onOpenConnection}>Conectar em Disparos</button>
      </div>
    );
  }
  const connected = inst.status === "connected";
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
      {!connected && <div className="wa-reply-note"><AlertTriangle size={12} /> WhatsApp desconectado — a mensagem fica na fila e sai quando reconectar.</div>}
      <div className="wa-reply">
        <textarea ref={ref} rows={1} value={text} placeholder="Escreva uma resposta…" maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="button" className="crm-btn primary" disabled={busy || !text.trim()} onClick={send} title="Enviar (Enter)"><Send size={16} /></button>
      </div>
    </>
  );
}
