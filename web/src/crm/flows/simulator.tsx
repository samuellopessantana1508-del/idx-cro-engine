// Simulador: roda o MESMO núcleo do servidor no navegador, sem enviar nada de verdade.
import { useEffect, useRef, useState } from "react";
import { FastForward, Play, RotateCcw, Send, TimerOff, X } from "lucide-react";
import {
  matchTrigger, startState, step, triggerOf, type ContactInfo, type FlowEffects, type Graph, type RunState,
} from "../../../../supabase/functions/_shared/flow-core";
import { TRIGGER_KINDS, UNITS } from "./catalog";

type Line =
  | { kind: "in" | "out"; text: string; media?: { type: string; url: string } }
  | { kind: "sys"; text: string; tone?: "ok" | "warn" | "muted" };

const waitLabel = (s: RunState) => {
  if (!s.wait) return "";
  const until = s.wait.until ? new Date(s.wait.until) : null;
  const when = until ? until.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  switch (s.wait.kind) {
    case "delay": return `Esperando até ${when}`;
    case "business_hours": return `Fora do horário — segue ${when}`;
    case "menu": return "Esperando a escolha do menu";
    case "ask": return "Esperando a resposta da pergunta";
    case "response": return "Esperando o cliente responder";
  }
};

export function Simulator({ graph, tz, onClose, onTrace }: {
  graph: Graph; tz: string; onClose: () => void; onTrace: (active: string | null, visited: string[], edges: string[]) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<RunState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState<ContactInfo>({ name: "Maria Souza", phone: "5511987654321", company: "Farmácia Central", city: "Campinas", tags: [] });
  const now = useRef(new Date());
  const visited = useRef<string[]>([]);
  const walked = useRef<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const trigger = triggerOf(graph);
  const tkind = trigger?.data.config?.kind ?? "message";
  const messageTrigger = ["message", "first_message", "keyword"].includes(tkind);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [lines]);
  useEffect(() => () => onTrace(null, [], []), []); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (...l: Line[]) => setLines((x) => [...x, ...l]);

  const effects = (): FlowEffects => ({
    async send(m) {
      if (m.kind === "text") push({ kind: "out", text: m.text });
      else push({ kind: "out", text: m.caption ?? "", media: { type: m.mediaType, url: m.url } });
    },
    async tag(a, t) {
      push({ kind: "sys", text: `🏷️ Etiqueta ${a === "add" ? "adicionada" : "removida"}: ${t}`, tone: "ok" });
      setContact((c) => ({ ...c, tags: a === "add" ? [...new Set([...(c.tags ?? []), t])] : (c.tags ?? []).filter((x) => x !== t) }));
    },
    async setField(f, v) { push({ kind: "sys", text: `✏️ Contato: ${f} = “${v}”`, tone: "ok" }); },
    async crmDeal(c) { push({ kind: "sys", text: c.action === "move" ? "📋 Negociação movida de etapa" : `📋 Negociação criada${c.title ? `: ${c.title}` : ""}`, tone: "ok" }); },
    async task(c) { push({ kind: "sys", text: `✅ Tarefa criada: ${c.title} (em ${c.due_in_hours}h)`, tone: "ok" }); },
    async assign(c) { push({ kind: "sys", text: c.strategy === "user" ? "👤 Contato atribuído ao vendedor escolhido" : "👤 Contato distribuído no rodízio", tone: "ok" }); },
    async notify(c) { push({ kind: "sys", text: `🔔 Aviso para a equipe: ${c.message}`, tone: "ok" }); },
    async conversion(l) { push({ kind: "sys", text: `🎯 Marco registrado: ${l} (não é venda)`, tone: "ok" }); },
    async webhook(c) { push({ kind: "sys", text: `🔗 Webhook enviado para ${c.url || "(sem endereço)"} — simulado como sucesso`, tone: "muted" }); return { ok: true, status: 200, data: {} }; },
    async ai(c) { return `🤖 [Na conversa real, a IA responde aqui seguindo suas instruções. Mensagem do cliente: “${c.message || "…"}”]`; },
    async handoff() { push({ kind: "sys", text: "🎧 Conversa passada para um atendente — robôs param aqui", tone: "warn" }); },
    async optout() { push({ kind: "sys", text: "⛔ Contato descadastrado (SAIR)", tone: "warn" }); },
    log(nodeId, event) {
      if (event === "enter") {
        const prev = visited.current[visited.current.length - 1];
        if (prev) {
          const e = graph.edges.find((x) => x.source === prev && x.target === nodeId);
          if (e) walked.current = [...walked.current, e.id];
        }
        visited.current = [...visited.current, nodeId];
      }
    },
  });

  const run = async (s: RunState, inputArg: { message?: string; timeout?: boolean } = {}) => {
    setBusy(true);
    try {
      const next = await step(graph, s, { now: now.current, tz, contact, effects: effects(), random: Math.random }, inputArg);
      setState(next);
      if (next.status === "completed") push({ kind: "sys", text: "🏁 Automação concluída", tone: "muted" });
      if (next.status === "failed") push({ kind: "sys", text: `⚠️ Parou: ${next.error}`, tone: "warn" });
      if (next.status === "cancelled") push({ kind: "sys", text: `Cancelada: ${next.error}`, tone: "warn" });
      if (next.status === "waiting") push({ kind: "sys", text: `⏳ ${waitLabel(next)}`, tone: "muted" });
      onTrace(next.status === "waiting" ? next.wait?.node ?? null : null, visited.current, walked.current);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setLines([]); setState(null); now.current = new Date(); visited.current = []; walked.current = [];
    setContact((c) => ({ ...c, tags: [] }));
    onTrace(null, [], []);
  };

  const start = async (text?: string) => {
    reset();
    if (!trigger) { push({ kind: "sys", text: "Adicione um gatilho para testar", tone: "warn" }); return; }
    if (text !== undefined) push({ kind: "in", text });
    if (messageTrigger) {
      const ok = matchTrigger(graph, { kind: "message", text: text ?? "", firstMessage: true }, now.current, tz);
      if (!ok) {
        const k = TRIGGER_KINDS.find((x) => x.id === tkind)?.label ?? "";
        push({ kind: "sys", text: `Essa mensagem não inicia a automação (gatilho: ${k}${tkind === "keyword" ? ` — ${String(trigger.data.config.keywords ?? "").split(/\n|,/).filter(Boolean).join(", ")}` : ""}${trigger.data.config.onlyOutsideHours ? ", só fora do horário" : ""}).`, tone: "warn" });
        return;
      }
    } else {
      push({ kind: "sys", text: `▶️ Início: ${TRIGGER_KINDS.find((x) => x.id === tkind)?.label}`, tone: "muted" });
    }
    await run(startState(graph, { text: text ?? "" }));
  };

  const send = async () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput("");
    if (!state || state.status !== "waiting") { await start(t); return; }
    push({ kind: "in", text: t });
    if (["menu", "ask", "response"].includes(state.wait?.kind ?? "")) await run(state, { message: t });
    else push({ kind: "sys", text: "O contato está numa espera de tempo — a mensagem não muda o caminho (use “Pular espera”).", tone: "muted" });
  };

  const skip = async () => {
    if (!state?.wait) return;
    if (state.wait.until) now.current = new Date(new Date(state.wait.until).getTime() + 1000);
    const isResp = ["menu", "ask", "response"].includes(state.wait.kind);
    push({ kind: "sys", text: isResp ? "⏱ Prazo acabou sem resposta" : "⏩ Espera pulada", tone: "muted" });
    await run(state, isResp ? { timeout: true } : {});
  };

  const waiting = state?.status === "waiting";
  const respWait = waiting && ["menu", "ask", "response"].includes(state?.wait?.kind ?? "");

  return (
    <aside className="fz-panel fz-sim">
      <header className="fz-sim-head">
        <div className="fz-sim-avatar">{(contact.name ?? "?").slice(0, 1)}</div>
        <div>
          <strong>Simulador</strong>
          <small>Nada é enviado de verdade</small>
        </div>
        <button type="button" className="crm-icon-btn" title="Recomeçar" onClick={reset}><RotateCcw size={15} /></button>
        <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
      </header>
      <div className="fz-sim-contact">
        <span>Testando como</span>
        <input value={contact.name ?? ""} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} />
        {(contact.tags ?? []).map((t) => <span key={t} className="fz-chip">{t}</span>)}
      </div>
      <div className="fz-chat">
        {lines.length === 0 && (
          <div className="fz-chat-empty">
            {messageTrigger
              ? <>Escreva uma mensagem como se fosse o cliente{tkind === "keyword" ? <> (ex.: <b>{String(trigger?.data.config.keywords ?? "").split(/\n|,/)[0] || "preço"}</b>)</> : ""}.</>
              : <><button type="button" className="crm-btn primary sm" onClick={() => void start()}><Play size={14} /> Iniciar teste</button></>}
          </div>
        )}
        {lines.map((l, i) => l.kind === "sys"
          ? <div key={i} className={`fz-sys ${l.tone ?? ""}`}>{l.text}</div>
          : (
            <div key={i} className={`fz-msg ${l.kind}`}>
              {l.media && (l.media.type === "image"
                ? <img src={l.media.url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                : <div className="fz-msg-file">📎 {({ video: "Vídeo", audio: "Áudio", document: "Documento" } as Record<string, string>)[l.media.type] ?? "Arquivo"}</div>)}
              {l.text && <span>{l.text}</span>}
            </div>
          ))}
        <div ref={endRef} />
      </div>
      {waiting && (
        <div className="fz-sim-actions">
          {!respWait && <button type="button" className="crm-btn ghost sm" onClick={() => void skip()} disabled={busy}><FastForward size={14} /> Pular espera</button>}
          {respWait && <button type="button" className="crm-btn ghost sm" onClick={() => void skip()} disabled={busy}><TimerOff size={14} /> Simular “não respondeu”{state?.wait?.until ? ` (${prazo(state)})` : ""}</button>}
        </div>
      )}
      <form className="fz-sim-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={input} placeholder={respWait ? "Responda como o cliente…" : messageTrigger ? "Mensagem do cliente…" : "Mensagem do cliente…"} onChange={(e) => setInput(e.target.value)} disabled={busy} />
        <button type="submit" className="fz-send" disabled={busy || !input.trim()} aria-label="Enviar"><Send size={16} /></button>
      </form>
    </aside>
  );
}

function prazo(s: RunState) {
  const ms = new Date(s.wait!.until!).getTime() - Date.now();
  if (ms <= 0) return "agora";
  const h = ms / 3600_000;
  return h >= 24 ? `${Math.round(h / 24)} ${UNITS.days}` : h >= 1 ? `${Math.round(h)}h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}
