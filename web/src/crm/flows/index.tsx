// Automações de WhatsApp: lista, modelos prontos e editor.
import { useCallback, useEffect, useState } from "react";
import { Archive, Copy, MessageCircle, MoreHorizontal, Pencil, Play, Plus, Send, Users, Workflow, Zap } from "lucide-react";
import * as api from "../api";
import { useCrm } from "../context";
import { useWaInstance } from "../dispatch";
import { errorText, relative } from "../format";
import type { FlowListItem } from "../types";
import { Confirm, Modal, Skeleton } from "../ui";
import { summary } from "./catalog";
import { FlowEditor } from "./editor";
import { TEMPLATES, type Template } from "./templates";
import "../../styles/flows.css";

const readFlowParam = () => new URLSearchParams(window.location.search).get("flow");
const writeFlowParam = (id: string | null) => {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("flow", id); else url.searchParams.delete("flow");
  window.history.replaceState(null, "", url.toString());
};

export function FlowsView() {
  const [openId, setOpenId] = useState<string | null>(readFlowParam);
  const open = (id: string | null) => { writeFlowParam(id); setOpenId(id); };
  useEffect(() => () => writeFlowParam(null), []);
  if (openId) return <FlowEditor key={openId} flowId={openId} onBack={() => open(null)} />;
  return <FlowList onOpen={open} />;
}

function FlowList({ onOpen }: { onOpen: (id: string) => void }) {
  const crm = useCrm();
  const { inst } = useWaInstance();
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [pick, setPick] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [archive, setArchive] = useState<FlowListItem | null>(null);
  const [startFor, setStartFor] = useState<FlowListItem | null>(null);
  const load = useCallback(() => { api.flowList(crm.tenantId).then(setFlows).catch((e) => { crm.notify(errorText(e)); setFlows([]); }); }, [crm]);
  useEffect(() => { load(); }, [load, crm.refreshKey]);

  const create = async (t: Template) => {
    try {
      const f = await api.flowSave(crm.tenantId, null, {
        name: t.id === "blank" ? "Nova automação" : t.name, graph: t.graph(), description: t.id === "blank" ? null : t.description,
        reentry: t.reentry, cooldown_hours: t.cooldown,
      });
      setPick(false);
      onOpen(f.id);
    } catch (e) { crm.notify(errorText(e)); }
  };
  const toggle = async (f: FlowListItem) => {
    try {
      if (f.status !== "active") {
        // abre o editor para validar antes de ativar a primeira vez
        if (f.status === "draft") { onOpen(f.id); return; }
        await api.flowSetStatus(f.id, "active");
        crm.notify("Automação ativada.");
      } else {
        await api.flowSetStatus(f.id, "paused");
        crm.notify("Automação pausada.");
      }
      load();
    } catch (e) { crm.notify(errorText(e)); }
  };

  const connected = inst?.status === "connected";
  return (
    <div className="crm-page fz-list-page">
      <div className="fz-list-head">
        <div>
          <h2>Automações de WhatsApp</h2>
          <p className="crm-muted">Robôs que respondem, qualificam, fazem follow-up e passam para a equipe — pelo mesmo número da caixa de entrada e dos disparos.</p>
        </div>
        {crm.access.configure && <button type="button" className="crm-btn primary" onClick={() => setPick(true)}><Plus size={16} /> Nova automação</button>}
      </div>

      {inst !== undefined && !connected && (
        <div className="wa-warn fz-conn-warn">
          <MessageCircle size={16} />
          <span>O WhatsApp do CRO não está conectado. As automações só respondem com a conexão ativa — <button type="button" className="crm-link" onClick={() => crm.navigate({ name: "dispatch" })}>conectar em Disparos</button>.</span>
        </div>
      )}

      {flows === null ? <Skeleton rows={3} height={92} /> : flows.length === 0 ? (
        <div className="fz-empty">
          <div className="fz-empty-art"><Workflow size={30} /></div>
          <h3>Monte seu primeiro robô de atendimento</h3>
          <p>Comece por um modelo pronto — boas-vindas, fora do horário, resposta de disparo, qualificação, follow-up ou IA — e ajuste no desenho.</p>
          {crm.access.configure ? <button type="button" className="crm-btn primary" onClick={() => setPick(true)}><Plus size={16} /> Escolher um modelo</button>
            : <p className="crm-muted small">Peça a um gestor para criar a primeira automação.</p>}
        </div>
      ) : (
        <div className="fz-cards">
          {flows.map((f) => {
            return (
              <div key={f.id} className={`fz-card fz-card-${f.status}`}>
                <button type="button" className="fz-card-main" onClick={() => onOpen(f.id)}>
                  <div className="fz-card-top">
                    <span className={`fz-status fz-status-${f.status}`}>{f.status === "active" ? "Ativa" : f.status === "paused" ? "Pausada" : "Rascunho"}</span>
                    <span className="crm-muted small">editada {relative(f.updated_at)}</span>
                  </div>
                  <strong className="fz-card-name">{f.name}</strong>
                  <span className="fz-card-trigger"><Zap size={13} /> {f.trigger_kind ? summary("trigger", { ...f.trigger_config, kind: f.trigger_kind }) : "Sem gatilho"}</span>
                  <div className="fz-card-stats">
                    <span><b>{f.runs_7d}</b> contatos em 7 dias</span>
                    <span><b>{f.sent_7d}</b> mensagens</span>
                    <span><b>{f.runs_open}</b> em andamento</span>
                  </div>
                </button>
                <div className="fz-card-actions">
                  {crm.access.configure && (
                    <label className="fz-switch" title={f.status === "active" ? "Pausar" : "Ativar"}>
                      <input type="checkbox" checked={f.status === "active"} onChange={() => void toggle(f)} />
                      <span />
                    </label>
                  )}
                  {f.trigger_kind === "manual" && f.status === "active" && crm.access.write && (
                    <button type="button" className="crm-btn ghost sm" onClick={() => setStartFor(f)}><Send size={14} /> Iniciar para contatos</button>
                  )}
                  <div className="crm-dropdown">
                    <button type="button" className="crm-icon-btn" onClick={() => setMenu(menu === f.id ? null : f.id)} aria-label="Mais"><MoreHorizontal size={16} /></button>
                    {menu === f.id && (
                      <div className="crm-menu right" onMouseLeave={() => setMenu(null)}>
                        <button type="button" onClick={() => onOpen(f.id)}><Pencil size={14} /> Editar</button>
                        {crm.access.configure && <button type="button" onClick={async () => { setMenu(null); try { const d = await api.flowDuplicate(f.id); load(); onOpen(d.id); } catch (e) { crm.notify(errorText(e)); } }}><Copy size={14} /> Duplicar</button>}
                        {crm.access.configure && <button type="button" onClick={() => { setMenu(null); setArchive(f); }}><Archive size={14} /> Arquivar</button>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={pick} onClose={() => setPick(false)} title="Nova automação" width={760}>
        <div className="fz-templates">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="fz-template" onClick={() => void create(t)}>
              <span className="fz-template-emoji">{t.emoji}</span>
              <strong>{t.name}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
      </Modal>
      <Confirm open={!!archive} title="Arquivar automação?" danger confirmLabel="Arquivar"
        text={`“${archive?.name}” para de responder e quem está no meio sai da automação. O histórico continua salvo.`}
        onClose={() => setArchive(null)}
        onConfirm={async () => { if (!archive) return; try { await api.flowSetStatus(archive.id, "archived"); load(); } catch (e) { crm.notify(errorText(e)); } setArchive(null); }} />
      {startFor && <StartModal flow={startFor} onClose={() => { setStartFor(null); load(); }} />}
    </div>
  );
}

function StartModal({ flow, onClose }: { flow: FlowListItem; onClose: () => void }) {
  const crm = useCrm();
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [phones, setPhones] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ queued: number; skipped_optout: number; spread_minutes: number } | null>(null);
  useEffect(() => { api.flowTagSuggestions(crm.tenantId).then(setTags).catch(() => {}); }, [crm.tenantId]);
  useEffect(() => {
    if (!tag) { setCount(null); return; }
    api.loadContacts(crm.tenantId, { tag, pageSize: 1 }).then((r) => setCount(r.total)).catch(() => setCount(null));
  }, [tag, crm.tenantId]);
  const typed = phones.split(/[\n,;]+/).map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 10);
  const start = async () => {
    setBusy(true);
    try {
      let ids: string[] = [];
      if (tag) ids = (await api.loadContacts(crm.tenantId, { tag, pageSize: 200 })).rows.filter((c) => c.phone).map((c) => c.id);
      setRes(await api.flowStart(flow.id, { contactIds: ids, phones: typed }));
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(false); }
  };
  const total = (tag ? Math.min(count ?? 0, 200) : 0) + typed.length;
  return (
    <Modal open onClose={onClose} title={`Iniciar “${flow.name}”`}
      footer={res ? <button type="button" className="crm-btn primary" onClick={onClose}>Fechar</button> : <>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || total === 0} onClick={() => void start()}><Play size={15} /> {busy ? "Iniciando…" : `Iniciar para ${total}`}</button>
      </>}>
      {res ? (
        <p><b>{res.queued}</b> contato(s) entraram na automação{res.skipped_optout ? ` (${res.skipped_optout} ficaram de fora por terem pedido SAIR)` : ""}. Para proteger o número, eles começam espaçados — todos em cerca de {Math.max(1, res.spread_minutes)} min.</p>
      ) : (
        <>
          <label className="fz-field"><span className="fz-field-label"><Users size={13} /> Contatos com a etiqueta</span>
            <select className="crm-input" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Nenhuma</option>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {tag && count !== null && <span className="fz-field-hint">{count} contato(s){count > 200 ? " — no máximo 200 por vez" : ""}</span>}
          </label>
          <label className="fz-field"><span className="fz-field-label">E/ou números (um por linha)</span>
            <textarea className="crm-input" rows={4} value={phones} placeholder={"11999990000\n21988887777"} onChange={(e) => setPhones(e.target.value)} />
          </label>
          <p className="fz-note">Quem pediu SAIR fica de fora automaticamente. Para listas grandes, use <b>Disparos</b> e uma automação com gatilho “Respondeu um disparo”.</p>
        </>
      )}
    </Modal>
  );
}

