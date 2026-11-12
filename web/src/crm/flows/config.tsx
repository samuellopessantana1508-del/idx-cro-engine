// Painel lateral: configuração do bloco selecionado.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Copy, Info, Plus, RefreshCw, Trash2, X } from "lucide-react";
import * as api from "../api";
import { errorText } from "../format";
import { interpolate, menuOptions, type NodeType } from "../../../../supabase/functions/_shared/flow-core";
import type { Member, Stage, Pipeline, WaCampaign } from "../types";
import { blockOf, daysLabel, groupOf, RULE_FIELDS, TEXT_OPS, TRIGGER_KINDS, UNIT_OPTIONS, VARIABLES } from "./catalog";

export type ConfigCtx = {
  flowId: string;
  canConfigure: boolean;
  notify: (m: string) => void;
  stages: Stage[];
  pipelines: Pipeline[];
  members: Member[];
  memberLabel: (id: string | null | undefined) => string;
  tags: string[];
  campaigns: WaCampaign[];
};

type Props = {
  kind: NodeType;
  config: Record<string, any>;
  label: string;
  issues: string[];
  ctx: ConfigCtx;
  onChange: (config: Record<string, any>) => void;
  onLabel: (label: string) => void;
  onDelete?: () => void;
  onClose: () => void;
};

const SAMPLE = { name: "Maria Souza", phone: "5511987654321", company: "Farmácia Central", city: "Campinas" };

export function ConfigPanel({ kind, config: c, label, issues, ctx, onChange, onLabel, onDelete, onClose }: Props) {
  const def = blockOf(kind);
  const g = groupOf(def.group);
  const Icon = def.icon;
  const set = (patch: Record<string, any>) => onChange({ ...c, ...patch });

  return (
    <aside className="fz-panel">
      <header className="fz-panel-head" style={{ ["--blk" as any]: g.color, ["--blk-soft" as any]: g.soft }}>
        <span className="fz-node-icon"><Icon size={16} /></span>
        <div>
          <small>{kind === "trigger" ? "Gatilho" : g.label}</small>
          <strong>{def.label}</strong>
        </div>
        <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
      </header>
      <div className="fz-panel-body">
        {issues.length > 0 && (
          <div className="fz-issues">{issues.map((i) => <div key={i}><Info size={14} /> {i}</div>)}</div>
        )}
        <Form kind={kind} c={c} set={set} ctx={ctx} />
        {kind !== "trigger" && (
          <L label="Nome do bloco (opcional)" hint="Aparece no desenho e nos relatórios">
            <input className="crm-input" value={label} placeholder={def.label} onChange={(e) => onLabel(e.target.value)} maxLength={60} />
          </L>
        )}
      </div>
      {onDelete && (
        <footer className="fz-panel-foot">
          <button type="button" className="crm-btn ghost sm danger-text" onClick={onDelete}><Trash2 size={14} /> Remover bloco</button>
        </footer>
      )}
    </aside>
  );
}

function L({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="fz-field">
      <span className="fz-field-label">{label}</span>
      {children}
      {hint && <span className="fz-field-hint">{hint}</span>}
    </label>
  );
}

function VarText({ value, onChange, rows = 4, placeholder, vars = VARIABLES }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; vars?: { v: string; label: string }[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const el = ref.current;
    if (!el) { onChange((value ?? "") + v); return; }
    const s = el.selectionStart ?? value.length, e = el.selectionEnd ?? value.length;
    const next = (value ?? "").slice(0, s) + v + (value ?? "").slice(e);
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + v.length, s + v.length); });
  };
  return (
    <div className="fz-vartext">
      <textarea ref={ref} className="crm-input" rows={rows} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <div className="fz-chips">
        {vars.map((x) => <button key={x.v} type="button" className="fz-chip" onClick={() => insert(x.v)} title={x.label}>{x.v}</button>)}
        <button type="button" className="fz-chip ghost" onClick={() => insert("{Oi|Olá|Opa}")} title="Sorteia uma das opções a cada envio (evita mensagens idênticas)">{"{a|b}"} variação</button>
      </div>
    </div>
  );
}

function Bubble({ text, extra }: { text: string; extra?: ReactNode }) {
  const out = interpolate(text, { name: SAMPLE.name, phone: SAMPLE.phone, company: SAMPLE.company, city: SAMPLE.city }, { lastResponse: "quero saber o preço" }, () => 0);
  if (!out.trim() && !extra) return null;
  return (
    <div className="fz-preview">
      <span className="fz-preview-label">Prévia para {SAMPLE.name.split(" ")[0]}</span>
      <div className="fz-bubble">{out}{extra}</div>
    </div>
  );
}

function Duration({ amount, unit, onAmount, onUnit, min = 1 }: { amount: number; unit: string; onAmount: (n: number) => void; onUnit: (u: string) => void; min?: number }) {
  return (
    <div className="fz-duration">
      <input className="crm-input" type="number" min={min} max={999} value={amount ?? 1} onChange={(e) => onAmount(Math.max(min, Number(e.target.value) || min))} />
      <select className="crm-input" value={unit} onChange={(e) => onUnit(e.target.value)}>
        {UNIT_OPTIONS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
      </select>
    </div>
  );
}

function TagInput({ value, onChange, tags }: { value: string; onChange: (v: string) => void; tags: string[] }) {
  return (
    <>
      <input className="crm-input" list="fz-tags" value={value ?? ""} placeholder="ex.: interessado" onChange={(e) => onChange(e.target.value.slice(0, 40))} />
      <datalist id="fz-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
    </>
  );
}

function StageSelect({ value, onChange, ctx, openOnly = true }: { value: string | null; onChange: (v: string | null) => void; ctx: ConfigCtx; openOnly?: boolean }) {
  return (
    <select className="crm-input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Escolha a etapa…</option>
      {ctx.pipelines.filter((p) => !p.archived_at).map((p) => (
        <optgroup key={p.id} label={p.name}>
          {ctx.stages.filter((s) => s.pipeline_id === p.id && !(s as any).archived_at && (!openOnly || (s as any).kind === "open"))
            .sort((a, b) => a.position - b.position)
            .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function Hours({ c, set }: { c: Record<string, any>; set: (p: Record<string, any>) => void }) {
  const days: number[] = c.days ?? [1, 2, 3, 4, 5];
  return (
    <>
      <div className="fz-row2">
        <L label="Abre às"><input className="crm-input" type="time" value={c.start ?? "08:00"} onChange={(e) => set({ start: e.target.value })} /></L>
        <L label="Fecha às"><input className="crm-input" type="time" value={c.end ?? "18:00"} onChange={(e) => set({ end: e.target.value })} /></L>
      </div>
      <div className="fz-days">
        {["D", "S", "T", "Q", "Q", "S", "S"].map((d, i) => (
          <button key={i} type="button" className={days.includes(i) ? "is-on" : ""}
            onClick={() => set({ days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })}>{d}</button>
        ))}
        <span className="fz-field-hint">{daysLabel(days)}</span>
      </div>
    </>
  );
}

function Form({ kind, c, set, ctx }: { kind: NodeType; c: Record<string, any>; set: (p: Record<string, any>) => void; ctx: ConfigCtx }) {
  switch (kind) {
    case "trigger": {
      const k = c.kind ?? "message";
      return (
        <>
          <div className="fz-kinds">
            {TRIGGER_KINDS.map((t) => (
              <button key={t.id} type="button" className={`fz-kind${k === t.id ? " is-on" : ""}`} onClick={() => set({ kind: t.id })}>
                <strong>{t.label}</strong><span>{t.hint}</span>
              </button>
            ))}
          </div>
          {k === "keyword" && (
            <>
              <L label="Palavras-chave (uma por linha)" hint="Entende erro de digitação, acento e sinônimos comuns (ex.: “preço” também pega “quanto custa”).">
                <textarea className="crm-input" rows={4} value={c.keywords ?? ""} placeholder={"preço\norçamento\ncatálogo"} onChange={(e) => set({ keywords: e.target.value })} />
              </L>
              <L label="Como comparar">
                <select className="crm-input" value={c.matchMode ?? "smart"} onChange={(e) => set({ matchMode: e.target.value })}>
                  <option value="smart">Inteligente (recomendado)</option>
                  <option value="contains">Contém a palavra</option>
                  <option value="exact">Mensagem exatamente igual</option>
                </select>
              </L>
            </>
          )}
          {k === "tag" && <L label="Etiqueta"><TagInput value={c.tag} onChange={(v) => set({ tag: v })} tags={ctx.tags} /></L>}
          {k === "stage" && <L label="Etapa do funil"><StageSelect value={c.stage_id ?? null} onChange={(v) => set({ stage_id: v })} ctx={ctx} openOnly={false} /></L>}
          {k === "campaign" && (
            <L label="Disparo" hint="Vale para respostas até 30 dias depois do envio.">
              <select className="crm-input" value={c.campaign_id ?? ""} onChange={(e) => set({ campaign_id: e.target.value || null })}>
                <option value="">Qualquer disparo</option>
                {ctx.campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </L>
          )}
          {k === "webhook" && <WebhookInfo ctx={ctx} />}
          {k === "manual" && <p className="fz-note">Você escolhe os contatos na lista de automações (botão “Iniciar para contatos”). Saem espaçados para proteger o número.</p>}
          {["message", "first_message", "keyword"].includes(k) && (
            <>
              <label className="crm-check fz-check"><input type="checkbox" checked={!!c.onlyOutsideHours} onChange={(e) => set({ onlyOutsideHours: e.target.checked, hours: c.hours ?? { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] } })} /> Só fora do horário de atendimento</label>
              {c.onlyOutsideHours && <Hours c={c.hours ?? {}} set={(p) => set({ hours: { ...(c.hours ?? {}), ...p } })} />}
            </>
          )}
        </>
      );
    }
    case "send_text": {
      const variants: string[] = Array.isArray(c.variants) ? c.variants : [];
      return (
        <>
          <L label="Mensagem"><VarText value={c.text} onChange={(v) => set({ text: v })} rows={5} placeholder="Oi {primeiro_nome}, tudo bem?" /></L>
          {variants.map((v, i) => (
            <L key={i} label={`Versão alternativa ${i + 2}`}>
              <div className="fz-alt">
                <VarText value={v} onChange={(t) => set({ variants: variants.map((x, j) => (j === i ? t : x)) })} rows={3} />
                <button type="button" className="crm-icon-btn" onClick={() => set({ variants: variants.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            </L>
          ))}
          {variants.length < 4 && <button type="button" className="crm-btn ghost sm" onClick={() => set({ variants: [...variants, ""] })}><Plus size={14} /> Versão alternativa (sorteada)</button>}
          <Bubble text={c.text ?? ""} />
          <p className="fz-note">Use *negrito*, _itálico_ e emojis normalmente — aparecem igual no WhatsApp.</p>
        </>
      );
    }
    case "send_media":
      return (
        <>
          <div className="fz-seg">
            {[["image", "Imagem"], ["video", "Vídeo"], ["audio", "Áudio"], ["document", "Documento"]].map(([id, l]) => (
              <button key={id} type="button" className={(c.mediaType ?? "image") === id ? "is-on" : ""} onClick={() => set({ mediaType: id })}>{l}</button>
            ))}
          </div>
          <L label="Link do arquivo" hint="Endereço público (https). Ex.: link do Google Drive com “qualquer pessoa com o link”, ou do seu site.">
            <input className="crm-input" value={c.url ?? ""} placeholder="https://…" onChange={(e) => set({ url: e.target.value.trim() })} />
          </L>
          {c.mediaType === "document" && <L label="Nome do arquivo"><input className="crm-input" value={c.fileName ?? ""} placeholder="tabela-de-precos.pdf" onChange={(e) => set({ fileName: e.target.value })} /></L>}
          {c.mediaType !== "audio" && <L label="Legenda (opcional)"><VarText value={c.caption ?? ""} onChange={(v) => set({ caption: v })} rows={2} /></L>}
          {c.mediaType === "image" && /^https:\/\//.test(c.url ?? "") && <div className="fz-media-prev"><img src={c.url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /></div>}
          {c.mediaType === "audio" && <p className="fz-note">Arquivos .ogg chegam como áudio gravado (bolinha azul); .mp3/.m4a como arquivo de áudio.</p>}
        </>
      );
    case "send_menu": {
      const opts = menuOptions(c);
      const setOpts = (list: string[]) => set({ options: list.join("\n") });
      const raw: string[] = String(c.options ?? "").split("\n");
      return (
        <>
          <L label="Mensagem"><VarText value={c.text} onChange={(v) => set({ text: v })} rows={3} /></L>
          <span className="fz-field-label">Opções (cada uma vira um caminho)</span>
          <div className="fz-options">
            {raw.map((o, i) => (
              <div key={i} className="fz-option">
                <span className="fz-option-n">{i + 1}</span>
                <input className="crm-input" value={o} maxLength={60} placeholder={`Opção ${i + 1}`} onChange={(e) => setOpts(raw.map((x, j) => (j === i ? e.target.value : x)))} />
                <button type="button" className="crm-icon-btn" disabled={i === 0} onClick={() => { const r = [...raw]; [r[i - 1], r[i]] = [r[i], r[i - 1]]; setOpts(r); }}><ArrowUp size={13} /></button>
                <button type="button" className="crm-icon-btn" disabled={i === raw.length - 1} onClick={() => { const r = [...raw]; [r[i + 1], r[i]] = [r[i], r[i + 1]]; setOpts(r); }}><ArrowDown size={13} /></button>
                <button type="button" className="crm-icon-btn" disabled={raw.length <= 2} onClick={() => setOpts(raw.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
              </div>
            ))}
            {raw.length < 10 && <button type="button" className="crm-btn ghost sm" onClick={() => setOpts([...raw, ""])}><Plus size={14} /> Opção</button>}
          </div>
          <L label="Esperar a escolha por"><Duration amount={c.timeout ?? 24} unit={c.timeoutUnit ?? "hours"} onAmount={(n) => set({ timeout: n })} onUnit={(u) => set({ timeoutUnit: u })} /></L>
          <L label="Rodapé (opcional)" hint="Se vazio: “Responda com o número da opção.”"><input className="crm-input" value={c.footer ?? ""} onChange={(e) => set({ footer: e.target.value })} /></L>
          <Bubble text={`${c.text ?? ""}\n\n${opts.map((o, i) => `${["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][i]} ${o}`).join("\n")}\n\n${c.footer || "_Responda com o número da opção._"}`} />
          <p className="fz-note">O cliente pode responder o número (“2”) ou escrever a opção (“falar com atendente”). Os botões nativos do WhatsApp não aparecem mais para números comuns — por isso o menu é numerado.</p>
        </>
      );
    }
    case "ask":
      return (
        <>
          <L label="Pergunta"><VarText value={c.text} onChange={(v) => set({ text: v })} rows={3} placeholder="Qual o seu e-mail?" /></L>
          <L label="Guardar a resposta como" hint={<>Use depois em mensagens como <code>{`{var.${c.saveAs || "resposta"}}`}</code></>}>
            <input className="crm-input" value={c.saveAs ?? ""} placeholder="ex.: email" onChange={(e) => set({ saveAs: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30) })} />
          </L>
          <L label="Salvar também no contato">
            <select className="crm-input" value={c.saveTo ?? ""} onChange={(e) => set({ saveTo: e.target.value })}>
              <option value="">Não salvar</option>
              <option value="nome">Nome</option>
              <option value="email">E-mail</option>
              <option value="cidade">Cidade</option>
              {c.saveAs && <option value={c.saveAs}>Campo extra “{c.saveAs}”</option>}
            </select>
          </L>
          <L label="Esperar a resposta por"><Duration amount={c.timeout ?? 24} unit={c.timeoutUnit ?? "hours"} onAmount={(n) => set({ timeout: n })} onUnit={(u) => set({ timeoutUnit: u })} /></L>
          <Bubble text={c.text ?? ""} />
        </>
      );
    case "ai_reply":
      return (
        <>
          <L label="Instruções para a IA" hint="Descreva a empresa, produtos, horários, o tom e o que fazer quando não souber. A IA lê as últimas mensagens da conversa.">
            <textarea className="crm-input" rows={8} value={c.prompt ?? ""} placeholder="Somos a Farmácia X. Entregamos em Campinas em até 2h. Se pedirem preço, diga que um atendente envia a tabela…" onChange={(e) => set({ prompt: e.target.value })} />
          </L>
          <L label="Tamanho máximo da resposta (caracteres)"><input className="crm-input" type="number" min={100} max={1500} value={c.maxChars ?? 600} onChange={(e) => set({ maxChars: Number(e.target.value) || 600 })} /></L>
          <p className="fz-note">A IA nunca inventa preços ou condições fora das instruções e não promete desconto. A resposta fica salva em <code>{"{var.ai}"}</code>.</p>
        </>
      );
    case "wait":
      return (
        <L label="Esperar" hint="O contato fica parado aqui e segue sozinho depois do tempo.">
          <Duration amount={c.amount ?? 1} unit={c.unit ?? "minutes"} onAmount={(n) => set({ amount: n })} onUnit={(u) => set({ unit: u })} />
        </L>
      );
    case "wait_response":
      return (
        <>
          <L label="Esperar a resposta por"><Duration amount={c.timeout ?? 24} unit={c.timeoutUnit ?? "hours"} onAmount={(n) => set({ timeout: n })} onUnit={(u) => set({ timeoutUnit: u })} /></L>
          <p className="fz-note">Segue por <b>Respondeu</b> assim que chegar uma mensagem, ou por <b>Não respondeu</b> quando o prazo acabar. A resposta fica em <code>{"{resposta}"}</code>.</p>
        </>
      );
    case "business_hours":
      return (<><Hours c={c} set={set} /><p className="fz-note">Fora desse horário o contato espera aqui e segue na próxima abertura (fuso da empresa).</p></>);
    case "condition": {
      const rules: Record<string, any>[] = Array.isArray(c.rules) ? c.rules : [];
      const setRule = (i: number, p: Record<string, any>) => set({ rules: rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
      return (
        <>
          <div className="fz-seg">
            <button type="button" className={(c.match ?? "all") === "all" ? "is-on" : ""} onClick={() => set({ match: "all" })}>Todas as regras</button>
            <button type="button" className={c.match === "any" ? "is-on" : ""} onClick={() => set({ match: "any" })}>Qualquer regra</button>
          </div>
          {rules.map((r, i) => (
            <div key={i} className="fz-rule">
              <select className="crm-input" value={r.field ?? "last_message"} onChange={(e) => setRule(i, { field: e.target.value, op: ["responded"].includes(e.target.value) ? "not_empty" : ["has_tag", "business_hours"].includes(e.target.value) ? "equals" : "contains" })}>
                {RULE_FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              {r.field === "responded" && (
                <select className="crm-input" value={r.op ?? "not_empty"} onChange={(e) => setRule(i, { op: e.target.value })}>
                  <option value="not_empty">sim</option><option value="empty">não</option>
                </select>
              )}
              {(r.field === "has_tag" || r.field === "business_hours") && (
                <select className="crm-input" value={r.op ?? "equals"} onChange={(e) => setRule(i, { op: e.target.value })}>
                  <option value="equals">sim</option><option value="not_equals">não</option>
                </select>
              )}
              {r.field === "has_tag" && <TagInput value={r.value ?? ""} onChange={(v) => setRule(i, { value: v })} tags={ctx.tags} />}
              {(r.field === "contact_field" || r.field === "variable") && (
                <input className="crm-input" value={r.key ?? ""} placeholder={r.field === "variable" ? "nome da resposta salva" : "nome, email, cidade, empresa…"} onChange={(e) => setRule(i, { key: e.target.value })} />
              )}
              {["last_message", "contact_field", "variable"].includes(r.field ?? "last_message") && (
                <>
                  <select className="crm-input" value={r.op ?? "contains"} onChange={(e) => setRule(i, { op: e.target.value })}>
                    {TEXT_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  {!["empty", "not_empty"].includes(r.op) && <input className="crm-input" value={r.value ?? ""} placeholder={r.op === "keyword" ? "sim, quero, pode mandar" : "valor"} onChange={(e) => setRule(i, { value: e.target.value })} />}
                </>
              )}
              {rules.length > 1 && <button type="button" className="crm-icon-btn fz-rule-del" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })}><X size={13} /></button>}
            </div>
          ))}
          <button type="button" className="crm-btn ghost sm" onClick={() => set({ rules: [...rules, { field: "last_message", op: "contains", value: "" }] })}><Plus size={14} /> Regra</button>
          <p className="fz-note">“Parece com” entende erro de digitação e sinônimos — bom para “sim/quero/pode”.</p>
        </>
      );
    }
    case "split_ab":
      return (
        <>
          <L label={`Caminho A: ${c.percent ?? 50}% · Caminho B: ${100 - Number(c.percent ?? 50)}%`}>
            <input type="range" min={5} max={95} step={5} value={c.percent ?? 50} onChange={(e) => set({ percent: Number(e.target.value) })} />
          </L>
          <p className="fz-note">Compare duas mensagens e veja qual tem mais respostas nos números de cada bloco.</p>
        </>
      );
    case "tag":
      return (
        <>
          <div className="fz-seg">
            <button type="button" className={c.action !== "remove" ? "is-on" : ""} onClick={() => set({ action: "add" })}>Adicionar</button>
            <button type="button" className={c.action === "remove" ? "is-on" : ""} onClick={() => set({ action: "remove" })}>Remover</button>
          </div>
          <L label="Etiqueta" hint="Fica no contato do CRM — serve para filtrar públicos de disparo."><TagInput value={c.tag} onChange={(v) => set({ tag: v })} tags={ctx.tags} /></L>
        </>
      );
    case "crm_deal":
      return (
        <>
          <div className="fz-seg">
            <button type="button" className={c.action !== "move" ? "is-on" : ""} onClick={() => set({ action: "create" })}>Criar negociação</button>
            <button type="button" className={c.action === "move" ? "is-on" : ""} onClick={() => set({ action: "move" })}>Mover de etapa</button>
          </div>
          <L label={c.action === "move" ? "Mover para" : "Etapa (opcional)"} hint={c.action === "move" ? undefined : "Se vazio, entra na primeira etapa do funil padrão."}>
            <StageSelect value={c.stage_id ?? null} onChange={(v) => set({ stage_id: v })} ctx={ctx} />
          </L>
          {c.action !== "move" && (
            <>
              <L label="Título"><VarText value={c.title ?? ""} onChange={(v) => set({ title: v })} rows={1} /></L>
              <L label="Valor estimado (opcional)"><input className="crm-input" type="number" min={0} value={c.value ?? ""} onChange={(e) => set({ value: e.target.value === "" ? null : Number(e.target.value) })} /></L>
            </>
          )}
          <p className="fz-note">Se o contato já tiver uma negociação aberta, não cria outra. Automação nunca marca ganho ou perda — venda só com confirmação.</p>
        </>
      );
    case "task":
      return (
        <>
          <L label="Tarefa"><VarText value={c.title ?? ""} onChange={(v) => set({ title: v })} rows={2} /></L>
          <div className="fz-row2">
            <L label="Tipo">
              <select className="crm-input" value={c.taskType ?? "follow_up"} onChange={(e) => set({ taskType: e.target.value })}>
                {[["follow_up", "Follow-up"], ["call", "Ligação"], ["whatsapp", "WhatsApp"], ["proposal", "Proposta"], ["meeting", "Reunião"], ["visit", "Visita"], ["task", "Tarefa"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </L>
            <L label="Prazo (horas)"><input className="crm-input" type="number" min={0} max={720} value={c.dueInHours ?? 1} onChange={(e) => set({ dueInHours: Number(e.target.value) || 0 })} /></L>
          </div>
          <p className="fz-note">Vai para o responsável do contato (ou quem criou a automação).</p>
        </>
      );
    case "assign":
      return (
        <>
          <div className="fz-seg">
            <button type="button" className={c.strategy !== "user" ? "is-on" : ""} onClick={() => set({ strategy: "round_robin", user_id: null })}>Rodízio</button>
            <button type="button" className={c.strategy === "user" ? "is-on" : ""} onClick={() => set({ strategy: "user" })}>Pessoa fixa</button>
          </div>
          {c.strategy === "user" ? (
            <L label="Vendedor">
              <select className="crm-input" value={c.user_id ?? ""} onChange={(e) => set({ user_id: e.target.value || null })}>
                <option value="">Escolha…</option>
                {ctx.members.filter((m) => m.status === "active").map((m) => <option key={m.user_id} value={m.user_id}>{ctx.memberLabel(m.user_id)}</option>)}
              </select>
            </L>
          ) : <p className="fz-note">Vai para quem recebeu menos contatos nas últimas 24h (vendedores primeiro). A pessoa recebe um aviso.</p>}
        </>
      );
    case "notify":
      return (
        <>
          <L label="Aviso"><VarText value={c.message ?? ""} onChange={(v) => set({ message: v })} rows={2} /></L>
          <L label="Para">
            <select className="crm-input" value={c.to ?? ""} onChange={(e) => set({ to: e.target.value || null })}>
              <option value="">Responsável pelo contato</option>
              {ctx.members.filter((m) => m.status === "active").map((m) => <option key={m.user_id} value={m.user_id}>{ctx.memberLabel(m.user_id)}</option>)}
            </select>
          </L>
        </>
      );
    case "set_field":
      return (
        <>
          <L label="Campo">
            <input className="crm-input" list="fz-fields" value={c.field ?? ""} placeholder="email, cidade ou um campo seu" onChange={(e) => set({ field: e.target.value.slice(0, 40) })} />
            <datalist id="fz-fields"><option value="nome" /><option value="email" /><option value="cidade" /></datalist>
          </L>
          <L label="Valor"><VarText value={c.value ?? ""} onChange={(v) => set({ value: v })} rows={2} vars={[...VARIABLES, { v: "{var.ai}", label: "Resposta da IA" }]} /></L>
        </>
      );
    case "conversion":
      return (
        <>
          <L label="Nome do marco"><input className="crm-input" value={c.label ?? ""} placeholder="ex.: pediu orçamento" onChange={(e) => set({ label: e.target.value.slice(0, 60) })} /></L>
          <p className="fz-note">Fica registrado na linha do tempo do contato para medir a automação. <b>Não conta como venda.</b></p>
        </>
      );
    case "webhook":
      return (
        <>
          <L label="Endereço (https)"><input className="crm-input" value={c.url ?? ""} placeholder="https://seu-sistema.com/webhook" onChange={(e) => set({ url: e.target.value.trim() })} /></L>
          <div className="fz-seg">
            <button type="button" className={(c.method ?? "POST") === "POST" ? "is-on" : ""} onClick={() => set({ method: "POST" })}>POST</button>
            <button type="button" className={c.method === "GET" ? "is-on" : ""} onClick={() => set({ method: "GET" })}>GET</button>
          </div>
          <L label="Texto extra (opcional)"><VarText value={c.body ?? ""} onChange={(v) => set({ body: v })} rows={2} /></L>
          <p className="fz-note">Envia em JSON: telefone, contato (nome, e-mail, etiquetas), respostas salvas e o texto extra. A resposta do sistema fica em <code>{"{var.webhook.campo}"}</code>. Segue por <b>Sucesso</b> ou <b>Erro</b> (tempo máximo 10 s).</p>
        </>
      );
    case "handoff":
      return (
        <>
          <L label="Mensagem antes de passar (opcional)"><VarText value={c.message ?? ""} onChange={(v) => set({ message: v })} rows={2} /></L>
          <p className="fz-note">Os robôs param nesta conversa até alguém clicar em “Devolver ao robô” na caixa de entrada. O responsável recebe um aviso.</p>
        </>
      );
    case "optout":
      return <p className="fz-note">O contato entra na lista “Pediram SAIR” e nunca mais recebe disparos nem automações.</p>;
    case "end":
      return <p className="fz-note">Encerra a automação para este contato.</p>;
    default:
      return null;
  }
}

function WebhookInfo({ ctx }: { ctx: ConfigCtx }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ctx.canConfigure) return;
    api.flowHookSecret(ctx.flowId).then(setSecret).catch((e) => ctx.notify(errorText(e)));
  }, [ctx.flowId, ctx.canConfigure]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
  const url = secret ? `${base}/functions/v1/cro-flows/hook/${ctx.flowId}/${secret}` : "";
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); ctx.notify("Copiado."); } catch { /* sem permissão */ } };
  if (!ctx.canConfigure) return <p className="fz-note">Só gestores veem o endereço do webhook.</p>;
  const example = `{\n  "telefone": "11999990000",\n  "nome": "Maria Souza",\n  "produto": "Kit Verão"\n}`;
  return (
    <>
      <L label="Endereço (POST)" hint="Guarde em segredo: quem tiver o endereço pode iniciar a automação.">
        <div className="fz-hook">
          <input readOnly value={url || "Gerando…"} onFocus={(e) => e.target.select()} />
          <button type="button" className="crm-icon-btn" title="Copiar" disabled={!url} onClick={() => void copy(url)}><Copy size={14} /></button>
        </div>
      </L>
      <span className="fz-field-label">Exemplo do que enviar (JSON)</span>
      <pre className="fz-code">{example}</pre>
      <p className="fz-note">Precisa ter <code>telefone</code>. O nome vira contato no CRM e os outros campos ficam disponíveis nas mensagens como <code>{"{var.trigger.produto}"}</code>. Só funciona com a automação <b>ativa</b>; limite de 2.000 chamadas por dia. Quem pediu SAIR é ignorado.</p>
      <button type="button" className="crm-btn ghost sm self-start" disabled={busy} onClick={async () => {
        setBusy(true);
        try { setSecret(await api.flowHookSecret(ctx.flowId, true)); ctx.notify("Endereço trocado — o antigo parou de funcionar."); } catch (e) { ctx.notify(errorText(e)); } finally { setBusy(false); }
      }}><RefreshCw size={14} /> Trocar endereço</button>
    </>
  );
}
