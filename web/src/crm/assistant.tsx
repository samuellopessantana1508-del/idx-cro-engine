import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, Sparkles, UserCheck, Wand2 } from "lucide-react";
import * as api from "./api";
import { useCrm } from "./context";
import { errorText, fromLocalInput, phoneLabel, taskTypeLabels, toLocalInput } from "./format";
import type { AssistantPlan, AssistantResult, DialOutcome, TaskType } from "./types";
import { Field, Modal, Pill } from "./ui";

// ---------------------------------------------------------------------------
// Ditado pelo navegador (Chrome/Android/Edge/Safari): grátis, sem enviar áudio
// para servidores nossos. Onde não houver, o microfone do teclado funciona.
// ---------------------------------------------------------------------------
type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
};
function getRecognition(): (new () => SR) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useDictation(onText: (finalText: string) => void) {
  const Rec = useMemo(getRecognition, []);
  const rec = useRef<SR | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cb = useRef(onText);
  cb.current = onText;

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const start = useCallback(() => {
    if (!Rec) return;
    setError(null);
    const r = new Rec();
    r.lang = "pt-BR"; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Permita o uso do microfone para ditar." : e.error === "no-speech" ? null : `Microfone: ${e.error}`);
    r.onend = () => { setListening(false); setInterim(""); rec.current = null; };
    rec.current = r;
    try { r.start(); setListening(true); } catch { setListening(false); }
  }, [Rec]);
  useEffect(() => () => rec.current?.abort(), []);
  return { supported: !!Rec, listening, interim, error, start, stop };
}

const outcomeOptions: { v: DialOutcome; label: string }[] = [
  { v: "meeting", label: "Reunião" }, { v: "callback", label: "Retornar" }, { v: "talked", label: "Conversou" },
  { v: "no_answer", label: "Não atendeu" }, { v: "not_interested", label: "Sem interesse" }, { v: "invalid", label: "Nº errado" },
];

export type AssistantContext = { dialLead?: { id: string; name: string; phone: string; contact_id?: string | null }; contactId?: string; contactName?: string | null };

export function AssistantModal({ context, onClose, onApplied }: {
  context?: AssistantContext; onClose: () => void; onApplied?: (r: { plan: AssistantPlan; contact_id: string | null; deal_id: string | null; task_id: string | null }) => void;
}) {
  const { tenantId, stages, settings, pipelines, notify, openContact, refresh } = useCrm();
  const [text, setText] = useState("");
  const [usedVoice, setUsedVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [plan, setPlan] = useState<AssistantPlan | null>(null);
  const [useMatch, setUseMatch] = useState(true);
  const dict = useDictation((t) => { setUsedVoice(true); setText((old) => (old ? `${old.trimEnd()} ${t}` : t)); });

  const pipelineId = settings?.default_pipeline_id ?? pipelines[0]?.id;
  const openStages = stages.filter((s) => s.pipeline_id === pipelineId && s.kind === "open").sort((a, b) => a.position - b.position);
  const isDial = !!context?.dialLead;

  async function interpret() {
    const t = text.trim();
    if (!t) { notify("Fale ou escreva como foi"); return; }
    if (dict.listening) dict.stop();
    setBusy(true);
    try {
      const r = await api.askAssistant(tenantId, t, usedVoice ? "voice" : "text", { dial_lead_id: context?.dialLead?.id, contact_id: context?.contactId });
      setResult(r); setPlan(r.plan); setUseMatch(!!r.match);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  async function save() {
    if (!plan) return;
    const p: AssistantPlan = { ...plan, contact_id: useMatch ? plan.contact_id : null };
    if (!isDial && !p.contact_id && !p.contact.name && !p.contact.phone && !p.contact.company) { notify("Informe ao menos o nome ou o telefone do cliente"); return; }
    setBusy(true);
    try {
      const r = await api.applyAssistant(tenantId, p);
      notify("Registrado no CRM ✓");
      refresh();
      onApplied?.({ plan: p, ...r });
      onClose();
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }

  const setP = (patch: Partial<AssistantPlan>) => setPlan((x) => (x ? { ...x, ...patch } : x));
  const title = isDial ? `Como foi a ligação? — ${context!.dialLead!.name}` : context?.contactName ? `Registrar — ${context.contactName}` : "Registrar por voz ou texto";

  if (!plan) {
    return (
      <Modal open onClose={onClose} title={title} width={560}
        footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="crm-btn primary" disabled={busy || !text.trim()} onClick={interpret}><Wand2 size={15} /> {busy ? "Entendendo…" : "Entender"}</button></>}>
        <div className="crm-assist">
          {dict.supported ? (
            <button type="button" className={`crm-assist-mic${dict.listening ? " on" : ""}`} onClick={dict.listening ? dict.stop : dict.start}>
              {dict.listening ? <MicOff size={28} /> : <Mic size={28} />}
              <span>{dict.listening ? "Toque para parar" : "Toque e fale"}</span>
            </button>
          ) : <p className="crm-muted small">Use o microfone do teclado do celular para ditar, ou escreva.</p>}
          {dict.error && <p className="crm-error small">{dict.error}</p>}
          <textarea rows={4} value={text + (dict.interim ? ` ${dict.interim}` : "")} onChange={(e) => setText(e.target.value)} readOnly={dict.listening}
            placeholder={isDial ? "Ex.: Falei com a Marta, achou caro, pediu para ligar sexta às 14h." : "Ex.: Liguei para o Carlos da Drogaria Nova, 31 98765-4321, quer proposta de 800 reais, retornar amanhã às 10h."} />
          <p className="crm-muted small">Diga com quem falou, o que ficou combinado, valor e quando retomar. Você confere tudo antes de salvar.</p>
        </div>
      </Modal>
    );
  }

  const m = result?.match;
  return (
    <Modal open onClose={onClose} title="Confira antes de salvar" width={600}
      footer={<><button type="button" className="crm-btn ghost" onClick={() => setPlan(null)}>Voltar</button>
        <button type="button" className="crm-btn primary" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar no CRM"}</button></>}>
      <div className="crm-assist-review">
        <div className="crm-row gap wrap">
          <Pill tone={result?.engine === "ai" ? "purple" : "muted"}><Sparkles size={11} /> {result?.engine === "ai" ? "Entendido pela IA" : "Entendido automaticamente (IA indisponível)"}</Pill>
          {plan.summary && <span className="crm-muted small">{plan.summary}</span>}
        </div>
        {result?.warnings.map((w) => <p key={w} className="crm-warn small">{w}</p>)}

        {isDial && (
          <div className="crm-assist-block">
            <h4>Resultado da ligação</h4>
            <div className="crm-row gap wrap">
              {outcomeOptions.map((o) => (
                <button type="button" key={o.v} className={`crm-chip${plan.dial_outcome === o.v ? " on" : ""}`}
                  onClick={() => setP({ dial_outcome: o.v, task: o.v === "callback" ? { ...(plan.task ?? { title: "Retornar ligação", due_local: null, due_at: null }), type: "call" } : o.v === "meeting" ? { ...(plan.task ?? { title: "Reunião", due_local: null, due_at: null }), type: "meeting" } : plan.task })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="crm-assist-block">
          <h4>Cliente</h4>
          {m && (
            <label className="crm-check">
              <input type="checkbox" checked={useMatch} onChange={(e) => setUseMatch(e.target.checked)} />
              <UserCheck size={14} /> Já cadastrado: <b>{m.name ?? "Sem nome"}</b> {m.phone && <span className="crm-muted">{phoneLabel(m.phone)}</span>}
              {m.company && <span className="crm-muted">· {m.company.name}</span>}
            </label>
          )}
          {m && useMatch && m.deals.filter((d) => d.status === "open").length > 0 && (
            <p className="crm-muted small">Negociação aberta: {m.deals.filter((d) => d.status === "open").map((d) => `${d.title} (${d.stage_name})`).join(", ")} — será atualizada, não duplicada.</p>
          )}
          {(!m || !useMatch) && !isDial && (
            <div className="crm-form-grid">
              <Field label="Nome"><input value={plan.contact.name ?? ""} onChange={(e) => setP({ contact: { ...plan.contact, name: e.target.value } })} /></Field>
              <Field label="Telefone"><input inputMode="tel" value={plan.contact.phone ?? ""} onChange={(e) => setP({ contact: { ...plan.contact, phone: e.target.value } })} /></Field>
              <Field label="Empresa" span={2}><input value={plan.contact.company ?? ""} onChange={(e) => setP({ contact: { ...plan.contact, company: e.target.value } })} /></Field>
            </div>
          )}
          {isDial && !m && <p className="crm-muted small">{["meeting", "callback", "talked"].includes(plan.dial_outcome ?? "") ? `Vai criar o contato “${context!.dialLead!.name}” no CRM.` : "Sem contato no CRM (só registra a ligação)."}</p>}
        </div>

        <div className="crm-assist-block">
          <label className="crm-check"><input type="checkbox" checked={plan.deal.action === "create"} onChange={(e) => setP({ deal: { ...plan.deal, action: e.target.checked ? "create" : "none" } })} /> <h4>Negociação</h4></label>
          {plan.deal.action === "create" && (
            <div className="crm-form-grid">
              <Field label="Título" span={2}><input value={plan.deal.title ?? ""} onChange={(e) => setP({ deal: { ...plan.deal, title: e.target.value } })} placeholder="Ex.: Proposta — Drogaria Nova" /></Field>
              <Field label="Valor (R$)"><input inputMode="decimal" value={plan.deal.value ?? ""} onChange={(e) => setP({ deal: { ...plan.deal, value: e.target.value ? Number(e.target.value.replace(/\./g, "").replace(",", ".")) || 0 : null } })} /></Field>
              <Field label="Etapa">
                <select value={plan.deal.stage_id ?? ""} onChange={(e) => setP({ deal: { ...plan.deal, stage_id: e.target.value || null } })}>
                  <option value="">{isDial && plan.dial_outcome === "meeting" ? "Automática (Qualificação)" : "Primeira etapa"}</option>
                  {openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <p className="crm-muted small span-2">Venda ganha ou perdida você marca no funil — o assistente nunca fecha venda sozinho.</p>
            </div>
          )}
        </div>

        <div className="crm-assist-block">
          <label className="crm-check"><input type="checkbox" checked={!!plan.task}
            onChange={(e) => setP({ task: e.target.checked ? { type: "follow_up", title: "Próximo passo", due_local: null, due_at: null } : null })} /> <h4>Próximo passo</h4></label>
          {plan.task && (
            <div className="crm-form-grid">
              <Field label="Tipo">
                <select value={plan.task.type} onChange={(e) => setP({ task: { ...plan.task!, type: e.target.value as TaskType } })}>
                  {(["call", "meeting", "whatsapp", "proposal", "follow_up", "visit"] as TaskType[]).map((t) => <option key={t} value={t}>{taskTypeLabels[t]}</option>)}
                </select>
              </Field>
              <Field label="Quando">
                <input type="datetime-local" value={toLocalInput(plan.task.due_at)} onChange={(e) => setP({ task: { ...plan.task!, due_at: fromLocalInput(e.target.value), due_local: e.target.value } })} />
              </Field>
              <Field label="Título" span={2}><input value={plan.task.title} onChange={(e) => setP({ task: { ...plan.task!, title: e.target.value } })} /></Field>
            </div>
          )}
        </div>

        <div className="crm-form-grid">
          <Field label="Objeção (se houve)" span={2}><input value={plan.objection ?? ""} onChange={(e) => setP({ objection: e.target.value || null })} placeholder="Ex.: achou caro, já tem fornecedor" /></Field>
          <Field label="Anotação no histórico" span={2}><textarea rows={2} value={plan.note ?? ""} onChange={(e) => setP({ note: e.target.value })} /></Field>
        </div>
        {m && useMatch && <button type="button" className="crm-link small" onClick={() => { onClose(); openContact(m.id); }}>Abrir o contato</button>}
      </div>
    </Modal>
  );
}
