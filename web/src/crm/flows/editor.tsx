// Editor visual de automações (estilo n8n/Kommo com o visual do FlowZap).
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, CircleDot, FlaskConical, History, Loader2, Pause, Play, Search, Settings2, Smartphone, X,
} from "lucide-react";
import { outputsOf, validateGraph, type FlowNode, type Graph, type NodeType } from "../../../../supabase/functions/_shared/flow-core";
import * as api from "../api";
import { useCrm } from "../context";
import { dateTime, errorText, phoneLabel, relative } from "../format";
import type { FlowRow, FlowRunItem, FlowStats, WaCampaign } from "../types";
import { Drawer, Empty, Modal, Pill } from "../ui";
import { BLOCKS, blockOf, GROUPS, groupOf, type BlockDef } from "./catalog";
import { ConfigPanel, type ConfigCtx } from "./config";
import { BlockNode, DeletableEdge, type BlockData } from "./nodes";
import { Simulator } from "./simulator";

const nodeTypes = { block: BlockNode };
const edgeTypes = { del: DeletableEdge };
const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#94a3b8" };
type RFNode = Node<BlockData>;

function toRF(g: Graph): { nodes: RFNode[]; edges: Edge[] } {
  return {
    nodes: (g.nodes ?? []).map((n) => ({
      id: n.id, type: "block", position: n.position ?? { x: 0, y: 0 }, deletable: n.type !== "trigger",
      data: { kind: n.type, config: n.data?.config ?? {}, label: n.data?.label ?? "" },
    })),
    edges: (g.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "next", type: "del", markerEnd: MARKER })),
  };
}
function fromRF(nodes: RFNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: { config: n.data.config, ...(n.data.label ? { label: n.data.label } : {}) },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle && e.sourceHandle !== "next" ? e.sourceHandle : null })),
  };
}
const uid = (t: string) => `${t}_${Math.random().toString(36).slice(2, 8)}`;

export function FlowEditor({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  return (
    <ReactFlowProvider>
      <EditorInner flowId={flowId} onBack={onBack} />
    </ReactFlowProvider>
  );
}

function EditorInner({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const crm = useCrm();
  const rf = useReactFlow();
  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "config" | "sim" | "settings">("none");
  const [save, setSave] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [stats, setStats] = useState<FlowStats | null>(null);
  const [trace, setTrace] = useState<{ active: string | null; visited: string[]; edges: string[] }>({ active: null, visited: [], edges: [] });
  const [quick, setQuick] = useState<{ nodeId: string; handle: string; x: number; y: number } | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<WaCampaign[]>([]);
  const loaded = useRef(false);
  const lastSaved = useRef<string>("");
  const saveTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canEdit = crm.access.configure;

  // carregar
  useEffect(() => {
    let alive = true;
    api.flowGet(flowId).then((f) => {
      if (!alive) return;
      if (!f) { setLoadError("Automação não encontrada."); return; }
      setFlow(f);
      setName(f.name);
      const g = toRF(f.graph as Graph);
      setNodes(g.nodes);
      setEdges(g.edges);
      lastSaved.current = JSON.stringify(fromRF(g.nodes, g.edges)) + "|" + f.name;
      setTimeout(() => { placeView(); loaded.current = true; }, 80);
    }).catch((e) => setLoadError(errorText(e)));
    api.flowTagSuggestions(crm.tenantId).then(setTags).catch(() => {});
    api.waCampaigns(crm.tenantId).then(setCampaigns).catch(() => {});
    return () => { alive = false; };
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // enquadra o desenho: legível (zoom ≥ 0,75) e começando pelo gatilho, à esquerda
  const placeView = useCallback(() => {
    const ns = rf.getNodes();
    const box = wrapRef.current?.getBoundingClientRect();
    if (!ns.length || !box) return;
    const x0 = Math.min(...ns.map((n) => n.position.x)), y0 = Math.min(...ns.map((n) => n.position.y));
    const x1 = Math.max(...ns.map((n) => n.position.x + (n.measured?.width ?? 252)));
    const y1 = Math.max(...ns.map((n) => n.position.y + (n.measured?.height ?? 110)));
    const bw = x1 - x0, bh = y1 - y0;
    const zoom = Math.min(1, Math.max(0.75, Math.min((box.width - 120) / bw, (box.height - 100) / bh)));
    const x = bw * zoom < box.width - 120 ? (box.width - bw * zoom) / 2 - x0 * zoom : 56 - x0 * zoom;
    const y = bh * zoom < box.height - 100 ? (box.height - bh * zoom) / 2 - y0 * zoom : 48 - y0 * zoom;
    rf.setViewport({ x, y, zoom });
  }, [rf]);

  const loadStats = useCallback(() => { api.flowStats(flowId).then(setStats).catch(() => {}); }, [flowId]);
  useEffect(() => {
    loadStats();
    const t = window.setInterval(loadStats, 20_000);
    return () => window.clearInterval(t);
  }, [loadStats]);

  const graph = useMemo(() => fromRF(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => validateGraph(graph), [graph]);
  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i.message]);
    return m;
  }, [issues]);
  const errors = issues.filter((i) => i.level === "error");

  // salvar automaticamente
  const doSave = useCallback(async (g: Graph, n: string) => {
    if (!flow || !canEdit) return;
    setSave("saving");
    try {
      const f = await api.flowSave(crm.tenantId, flow.id, { name: n.trim() || "Automação sem nome", graph: g });
      setFlow((old) => (old ? { ...old, version: f.version, updated_at: f.updated_at, trigger_kind: f.trigger_kind } : old));
      setSave("saved"); setSaveErr(null);
    } catch (e) {
      setSave("error"); setSaveErr(errorText(e));
    }
  }, [flow, canEdit, crm.tenantId]);
  const graphKey = useMemo(() => JSON.stringify(graph) + "|" + name, [graph, name]);
  useEffect(() => {
    if (!loaded.current || !flow || !lastSaved.current) return;
    if (graphKey === lastSaved.current) return;
    setSave("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { lastSaved.current = graphKey; void doSave(graph, name); }, 900);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [graphKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = async () => {
    if (save === "dirty") { if (saveTimer.current) window.clearTimeout(saveTimer.current); lastSaved.current = graphKey; await doSave(graph, name); }
  };

  // edição
  const onNodesChange = useCallback((ch: NodeChange<RFNode>[]) => {
    const allowed = canEdit ? ch : ch.filter((c) => c.type === "select" || c.type === "dimensions");
    onNodesChangeBase(allowed);
    for (const c of allowed) if (c.type === "remove" && c.id === selected) { setSelected(null); setPanel("none"); }
  }, [onNodesChangeBase, selected, canEdit]);
  const onEdgesChange = useCallback((ch: EdgeChange<Edge>[]) => onEdgesChangeBase(canEdit ? ch : ch.filter((c) => c.type === "select")), [onEdgesChangeBase, canEdit]);

  const onConnect = useCallback((c: Connection) => {
    if (!canEdit || !c.source || !c.target || c.source === c.target) return;
    const handle = c.sourceHandle ?? "next";
    setEdges((eds) => addEdge({ ...c, sourceHandle: handle, id: `e-${c.source}-${handle}-${c.target}`, type: "del", markerEnd: MARKER },
      eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? "next") === handle))));
  }, [setEdges, canEdit]);
  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const t = nodes.find((n) => n.id === c.target);
    return !!t && t.data.kind !== "trigger";
  }, [nodes]);

  const updateNode = (id: string, patch: Partial<BlockData>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));

  const addBlock = useCallback((b: BlockDef, pos?: { x: number; y: number }, from?: { nodeId: string; handle: string }) => {
    if (!canEdit) return;
    if (b.type === "trigger" && nodes.some((n) => n.data.kind === "trigger")) { crm.notify("A automação já tem um gatilho."); return; }
    let position = pos;
    if (!position && from) {
      const src = nodes.find((n) => n.id === from.nodeId);
      const asNode: FlowNode = { id: from.nodeId, type: src!.data.kind, position: src!.position, data: { config: src!.data.config } };
      const outs = outputsOf(asNode);
      const idx = Math.max(0, outs.findIndex((o) => o.id === from.handle));
      const spread = outs.length > 1 ? (idx - (outs.length - 1) / 2) * 150 : 0;
      position = { x: (src?.position.x ?? 0) + 330, y: (src?.position.y ?? 0) + spread };
    }
    if (!position) {
      const r = wrapRef.current?.getBoundingClientRect();
      position = rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 120, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 - 40 });
    }
    const id = uid(b.type);
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), {
      id, type: "block", position, selected: true, deletable: b.type !== "trigger",
      data: { kind: b.type, config: structuredClone(b.defaults), label: "" },
    }]);
    if (from) {
      setEdges((eds) => [...eds.filter((e) => !(e.source === from.nodeId && (e.sourceHandle ?? "next") === from.handle)),
        { id: `e-${from.nodeId}-${from.handle}-${id}`, source: from.nodeId, sourceHandle: from.handle, target: id, type: "del", markerEnd: MARKER }]);
    }
    setSelected(id);
    setPanel("config");
  }, [canEdit, nodes, rf, setNodes, setEdges, crm]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const t = e.dataTransfer.getData("application/x-flow-block") as NodeType;
    const b = BLOCKS.find((x) => x.type === t);
    if (!b) return;
    addBlock(b, rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 30 }));
  };

  const onAddAfter = useCallback((nodeId: string, handle: string, anchor: DOMRect) => {
    setQuick({ nodeId, handle, x: Math.min(anchor.right + 8, window.innerWidth - 300), y: Math.min(anchor.top - 20, window.innerHeight - 440) });
  }, []);

  // nós decorados (avisos, números, simulador, "+")
  const summaryCtx = useMemo(() => ({
    stageName: (id: string) => crm.stages.find((s) => s.id === id)?.name,
    userName: (id: string) => crm.memberLabel(id),
    campaignName: (id: string) => campaigns.find((c) => c.id === id)?.name,
  }), [crm.stages, crm, campaigns]);
  const shownNodes = useMemo(() => nodes.map((n) => {
    const outs = outputsOf({ id: n.id, type: n.data.kind, position: n.position, data: { config: n.data.config } });
    const used = new Set(edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle ?? "next"));
    return {
      ...n,
      data: {
        ...n.data,
        issues: issuesByNode.get(n.id),
        stats: { enter: stats?.nodes?.[n.id]?.enter, waiting: stats?.waiting?.[n.id] },
        sim: trace.active === n.id ? "active" as const : trace.visited.includes(n.id) ? "visited" as const : undefined,
        freeOutputs: canEdit ? outs.map((o) => o.id).filter((h) => !used.has(h)) : [],
        summaryCtx,
        onAddAfter,
      },
    };
  }), [nodes, edges, issuesByNode, stats, trace, canEdit, summaryCtx, onAddAfter]);
  const shownEdges = useMemo(() => edges.map((e) => (trace.edges.includes(e.id) ? { ...e, data: { sim: true }, animated: true } : e)), [edges, trace]);

  const sel = nodes.find((n) => n.id === selected) ?? null;
  const cfgCtx: ConfigCtx = { flowId, canConfigure: crm.access.configure, notify: crm.notify, stages: crm.stages, pipelines: crm.pipelines, members: crm.members, memberLabel: crm.memberLabel, tags, campaigns };

  const setStatus = async (status: "active" | "paused") => {
    if (!flow) return;
    if (status === "active" && errors.length) { setIssuesOpen(true); return; }
    setBusy(true);
    try {
      await flush();
      const f = await api.flowSetStatus(flow.id, status);
      setFlow((o) => (o ? { ...o, status: f.status } : o));
      crm.notify(status === "active" ? "Automação ativada — já vale para as próximas mensagens." : "Automação pausada. Quem está no meio fica parado até reativar.");
    } catch (e) {
      crm.notify(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="fz-editor-error"><Empty title="Não foi possível abrir" text={loadError} action={<button type="button" className="crm-btn" onClick={onBack}>Voltar</button>} /></div>;
  if (!flow) return <div className="fz-editor-loading"><Loader2 className="spin" size={22} /> Abrindo automação…</div>;

  const status = flow.status;
  return (
    <div className="fz-editor">
      <div className="fz-top">
        <button type="button" className="crm-icon-btn" onClick={async () => { await flush(); onBack(); }} aria-label="Voltar"><ArrowLeft size={18} /></button>
        <input className="fz-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} disabled={!canEdit} aria-label="Nome da automação" />
        <span className={`fz-status fz-status-${status}`}><CircleDot size={11} /> {status === "active" ? "Ativa" : status === "paused" ? "Pausada" : "Rascunho"}</span>
        <span className={`fz-save fz-save-${save}`} title={saveErr ?? ""}>
          {save === "saving" ? <><Loader2 size={13} className="spin" /> Salvando…</> : save === "dirty" ? "Editando…" : save === "error" ? <><AlertTriangle size={13} /> Erro ao salvar</> : save === "saved" ? <><Check size={13} /> Salvo</> : ""}
        </span>
        <div className="fz-top-right">
          {issues.length > 0 && (
            <button type="button" className={`fz-issue-btn${errors.length ? " is-err" : ""}`} onClick={() => setIssuesOpen(true)}>
              <AlertTriangle size={14} /> {errors.length ? `${errors.length} para corrigir` : `${issues.length} aviso${issues.length > 1 ? "s" : ""}`}
            </button>
          )}
          <button type="button" className={`crm-btn ghost sm${panel === "settings" ? " is-active" : ""}`} onClick={() => setPanel(panel === "settings" ? "none" : "settings")} title="Configurações e números da automação" aria-label="Configurações"><Settings2 size={15} /></button>
          <button type="button" className="crm-btn ghost sm" onClick={() => setRunsOpen(true)}><History size={15} /> Execuções{stats?.runs.open ? ` · ${stats.runs.open}` : ""}</button>
          <button type="button" className={`crm-btn ghost sm${panel === "sim" ? " is-active" : ""}`} onClick={() => { setPanel(panel === "sim" ? (selected ? "config" : "none") : "sim"); }}><FlaskConical size={15} /> Simular</button>
          <button type="button" className="crm-btn ghost sm" onClick={() => setTestOpen(true)} disabled={!crm.access.write}><Smartphone size={15} /> Testar</button>
          {canEdit && (status === "active"
            ? <button type="button" className="crm-btn sm" onClick={() => void setStatus("paused")} disabled={busy}><Pause size={15} /> Pausar</button>
            : <button type="button" className="crm-btn primary sm" onClick={() => void setStatus("active")} disabled={busy}><Play size={15} /> Ativar</button>)}
        </div>
      </div>

      <div className={`fz-body${canEdit ? "" : " no-palette"}${panel === "none" || (panel === "config" && !sel) ? " no-panel" : ""}`}>
        {canEdit && <Palette onAdd={(b) => addBlock(b)} hasTrigger={nodes.some((n) => n.data.kind === "trigger")} />}
        <div className="fz-canvas" ref={wrapRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
          <ReactFlow
            nodes={shownNodes}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, n) => { setSelected(n.id); if (panel !== "sim") setPanel("config"); setQuick(null); }}
            onPaneClick={() => { setSelected(null); if (panel === "config") setPanel("none"); setQuick(null); }}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
            minZoom={0.2}
            maxZoom={1.6}
            defaultEdgeOptions={{ type: "del", markerEnd: MARKER }}
            connectionLineStyle={{ stroke: "#64748b", strokeWidth: 2, strokeDasharray: "6 4" }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#cbd5e1" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" className="fz-minimap"
              nodeColor={(n) => groupOf(blockOf((n.data as BlockData).kind).group).color} nodeBorderRadius={6} maskColor="rgba(241,245,249,.7)" />
          </ReactFlow>
          {nodes.length <= 1 && canEdit && (
            <div className="fz-hint-start">
              Clique no <b>+</b> do gatilho ou arraste um bloco da esquerda para montar o caminho.
            </div>
          )}
        </div>
        {panel === "sim" ? (
          <Simulator graph={graph} tz={(crm.settings as any)?.timezone || "America/Sao_Paulo"} onClose={() => setPanel(selected ? "config" : "none")}
            onTrace={(active, visited, ed) => setTrace({ active, visited, edges: ed })} />
        ) : panel === "config" && sel ? (
          <ConfigPanel
            key={sel.id}
            kind={sel.data.kind}
            config={sel.data.config}
            label={sel.data.label ?? ""}
            issues={issuesByNode.get(sel.id) ?? []}
            ctx={cfgCtx}
            onChange={(config) => canEdit && updateNode(sel.id, { config })}
            onLabel={(label) => canEdit && updateNode(sel.id, { label })}
            onDelete={canEdit && sel.data.kind !== "trigger" ? () => { void rf.deleteElements({ nodes: [{ id: sel.id }] }); setSelected(null); setPanel("none"); } : undefined}
            onClose={() => { setSelected(null); setPanel("none"); }}
          />
        ) : panel === "settings" ? (
          <FlowSettings flow={flow} stats={stats} canEdit={canEdit} onClose={() => setPanel("none")} onSaved={(f) => setFlow((o) => (o ? { ...o, ...f } : o))} name={name} graph={graph} />
        ) : null}
      </div>

      {quick && (
        <QuickAdd x={quick.x} y={quick.y} onClose={() => setQuick(null)}
          onPick={(b) => { addBlock(b, undefined, { nodeId: quick.nodeId, handle: quick.handle }); setQuick(null); }} />
      )}
      <Modal open={issuesOpen} onClose={() => setIssuesOpen(false)} title={errors.length ? "Antes de ativar, corrija:" : "Avisos"}
        footer={<button type="button" className="crm-btn primary" onClick={() => setIssuesOpen(false)}>Entendi</button>}>
        <ul className="fz-issue-list">
          {issues.map((i, k) => {
            const n = nodes.find((x) => x.id === i.nodeId);
            return (
              <li key={k} className={i.level}>
                <AlertTriangle size={14} />
                <span>{n ? <button type="button" className="crm-link" onClick={() => { setIssuesOpen(false); setSelected(n.id); setPanel("config"); rf.fitView({ nodes: [{ id: n.id }], maxZoom: 1.1, duration: 400 }); }}>{n.data.label || blockOf(n.data.kind).label}</button> : null}{n ? ": " : ""}{i.message}</span>
              </li>
            );
          })}
        </ul>
      </Modal>
      {runsOpen && <RunsDrawer flowId={flow.id} nodes={nodes} onClose={() => { setRunsOpen(false); loadStats(); }} />}
      {testOpen && <TestModal flow={flow} onClose={() => setTestOpen(false)} beforeStart={flush} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Palette({ onAdd, hasTrigger }: { onAdd: (b: BlockDef) => void; hasTrigger: boolean }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const list = BLOCKS.filter((b) => (b.type !== "trigger" || !hasTrigger) && (!q || `${b.label} ${b.hint}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <aside className="fz-palette">
      <div className="fz-palette-search"><Search size={14} /><input placeholder="Buscar bloco" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="fz-palette-list">
        {GROUPS.map((g) => {
          const items = list.filter((b) => b.group === g.id);
          if (!items.length) return null;
          const isClosed = closed[g.id] && !q;
          return (
            <div key={g.id} className="fz-pgroup">
              <button type="button" className="fz-pgroup-head" onClick={() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))}>
                <span className="fz-dot" style={{ background: g.color }} /> {g.label}
                <ChevronDown size={14} className={isClosed ? "rot" : ""} />
              </button>
              {!isClosed && items.map((b) => {
                const Icon = b.icon;
                return (
                  <button key={b.type} type="button" className="fz-pitem" draggable title={b.hint}
                    style={{ ["--blk" as any]: g.color, ["--blk-soft" as any]: g.soft }}
                    onDragStart={(e) => { e.dataTransfer.setData("application/x-flow-block", b.type); e.dataTransfer.effectAllowed = "move"; }}
                    onClick={() => onAdd(b)}>
                    <span className="fz-node-icon sm"><Icon size={14} /></span>
                    <span className="fz-pitem-text"><strong>{b.label}</strong><small>{b.hint}</small></span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function QuickAdd({ x, y, onPick, onClose }: { x: number; y: number; onPick: (b: BlockDef) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);
  const list = BLOCKS.filter((b) => b.type !== "trigger" && (!q || `${b.label} ${b.hint}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="fz-quick" ref={ref} style={{ left: Math.max(8, x), top: Math.max(8, y) }}>
      <div className="fz-palette-search"><Search size={14} /><input autoFocus placeholder="Próximo passo…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && list[0]) onPick(list[0]); }} /></div>
      <div className="fz-quick-list">
        {GROUPS.filter((g) => g.id !== "trigger").map((g) => {
          const items = list.filter((b) => b.group === g.id);
          if (!items.length) return null;
          return (
            <div key={g.id}>
              <div className="fz-quick-g">{g.label}</div>
              {items.map((b) => {
                const Icon = b.icon;
                return (
                  <button key={b.type} type="button" className="fz-quick-item" onClick={() => onPick(b)} style={{ ["--blk" as any]: g.color, ["--blk-soft" as any]: g.soft }}>
                    <span className="fz-node-icon sm"><Icon size={13} /></span> {b.label}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function FlowSettings({ flow, stats, canEdit, onSaved, onClose, name, graph }: { flow: FlowRow; stats: FlowStats | null; canEdit: boolean; onSaved: (f: Partial<FlowRow>) => void; onClose: () => void; name: string; graph: Graph }) {
  const crm = useCrm();
  const [reentry, setReentry] = useState(flow.reentry);
  const [cooldown, setCooldown] = useState(flow.cooldown_hours);
  const [priority, setPriority] = useState(flow.priority);
  const [desc, setDesc] = useState(flow.description ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = reentry !== flow.reentry || cooldown !== flow.cooldown_hours || priority !== flow.priority || desc !== (flow.description ?? "");
  const saveIt = async () => {
    setSaving(true);
    try {
      const f = await api.flowSave(crm.tenantId, flow.id, { name: name.trim() || flow.name, graph, description: desc, reentry, cooldown_hours: cooldown, priority });
      onSaved({ reentry: f.reentry, cooldown_hours: f.cooldown_hours, priority: f.priority, description: f.description });
      crm.notify("Configurações salvas.");
    } catch (e) { crm.notify(errorText(e)); } finally { setSaving(false); }
  };
  return (
    <aside className="fz-panel">
      <header className="fz-panel-head plain"><Settings2 size={16} /><div><small>Automação</small><strong>Configurações</strong></div>
        <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button></header>
      <div className="fz-panel-body">
        {stats && (
          <div className="fz-kpis">
            <div><strong>{stats.runs.total}</strong><span>contatos</span></div>
            <div><strong>{stats.runs.open}</strong><span>em andamento</span></div>
            <div><strong>{stats.runs.completed}</strong><span>concluídos</span></div>
            <div className={stats.runs.failed ? "is-bad" : ""}><strong>{stats.runs.failed}</strong><span>com erro</span></div>
          </div>
        )}
        <label className="fz-field"><span className="fz-field-label">Descrição</span>
          <textarea className="crm-input" rows={2} value={desc} disabled={!canEdit} placeholder="Para que serve esta automação" onChange={(e) => setDesc(e.target.value)} />
        </label>
        <span className="fz-field-label">O mesmo contato pode entrar de novo?</span>
        <div className="fz-radio">
          {[["once", "Só uma vez", "Nunca repete para o mesmo número"], ["cooldown", "Depois de um intervalo", "Evita mandar a mesma coisa várias vezes"], ["always", "Sempre", "Toda vez que o gatilho acontecer"]].map(([id, l, h]) => (
            <label key={id} className={reentry === id ? "is-on" : ""}>
              <input type="radio" name="reentry" checked={reentry === id} disabled={!canEdit} onChange={() => setReentry(id as FlowRow["reentry"])} />
              <span><strong>{l}</strong><small>{h}</small></span>
            </label>
          ))}
        </div>
        {reentry === "cooldown" && (
          <label className="fz-field"><span className="fz-field-label">Intervalo mínimo (horas)</span>
            <input className="crm-input" type="number" min={1} max={8760} value={cooldown} disabled={!canEdit} onChange={(e) => setCooldown(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        )}
        <label className="fz-field"><span className="fz-field-label">Prioridade</span>
          <input className="crm-input" type="number" min={-10} max={10} value={priority} disabled={!canEdit} onChange={(e) => setPriority(Number(e.target.value) || 0)} />
          <span className="fz-field-hint">Se duas automações servirem para a mesma mensagem, só a de maior prioridade responde (empate: palavra-chave ganha).</span>
        </label>
        {canEdit && <button type="button" className="crm-btn primary sm" disabled={!dirty || saving} onClick={() => void saveIt()}>{saving ? "Salvando…" : "Salvar configurações"}</button>}
        <div className="fz-help">
          <strong>Como funciona</strong>
          <ul>
            <li>Ligue os blocos da esquerda para a direita. Cada saída (ex.: “Respondeu”/“Não respondeu”) pode ir para um caminho.</li>
            <li>As mensagens saem pela conexão de WhatsApp do CRO, com “digitando…” e na mesma fila da caixa de entrada.</li>
            <li>Quem pediu SAIR nunca recebe. Se um atendente assumir a conversa, o robô para.</li>
            <li>Use <b>Simular</b> para testar sem enviar nada, e <b>Testar no WhatsApp</b> para receber no seu número.</li>
          </ul>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
const runStatus: Record<FlowRunItem["status"], { label: string; tone: string }> = {
  running: { label: "Rodando", tone: "blue" },
  waiting: { label: "Aguardando", tone: "amber" },
  completed: { label: "Concluída", tone: "green" },
  cancelled: { label: "Cancelada", tone: "muted" },
  failed: { label: "Erro", tone: "red" },
};

function RunsDrawer({ flowId, nodes, onClose }: { flowId: string; nodes: RFNode[]; onClose: () => void }) {
  const crm = useCrm();
  const [runs, setRuns] = useState<FlowRunItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { api.flowRuns(flowId, 100).then(setRuns).catch((e) => crm.notify(errorText(e))); }, [flowId, crm]);
  useEffect(() => { load(); }, [load]);
  const label = (id: string | null) => {
    const n = nodes.find((x) => x.id === id);
    return n ? n.data.label || blockOf(n.data.kind).label : id ? "Bloco removido" : "Início";
  };
  const evLabel: Record<string, string> = { start: "Começou", enter: "", sent: "mensagem enviada", replied: "cliente respondeu", timeout: "prazo acabou", failed: "erro", answered: "respondeu", choice: "escolheu", yes: "sim", no: "não", a: "caminho A", b: "caminho B", send_failed: "falha no envio", deal_exists: "já tinha negociação" };
  return (
    <Drawer open onClose={onClose} title="Execuções" subtitle="Últimos contatos que passaram por esta automação" width={520}>
      {runs === null ? <p className="crm-muted">Carregando…</p> : runs.length === 0 ? (
        <Empty title="Ninguém passou por aqui ainda" text="Quando a automação rodar, cada contato aparece aqui com o caminho que fez." />
      ) : (
        <div className="fz-runs">
          {runs.map((r) => (
            <div key={r.id} className="fz-run">
              <button type="button" className="fz-run-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div>
                  <strong>{r.name || phoneLabel(r.phone)}</strong>
                  <small>{r.name ? `${phoneLabel(r.phone)} · ` : ""}{relative(r.started_at)}{r.is_test ? " · teste" : ""}</small>
                </div>
                <Pill tone={runStatus[r.status].tone}>{runStatus[r.status].label}</Pill>
              </button>
              {r.status === "waiting" && <div className="fz-run-note">Em “{label(r.current_node)}”{r.resume_at ? ` · segue ${relative(r.resume_at)}` : ""}</div>}
              {r.last_error && r.status !== "completed" && <div className="fz-run-note bad">{r.last_error}</div>}
              {open === r.id && (
                <ol className="fz-path">
                  {r.path.filter((p) => p.event !== "sent").map((p, i) => (
                    <li key={i}><span>{dateTime(p.at)}</span> {p.event === "enter" ? label(p.node) : <><b>{label(p.node)}</b> — {evLabel[p.event] ?? p.event}{p.detail?.option ? ` ${p.detail.option}` : ""}{p.detail?.text ? `: “${p.detail.text}”` : ""}{p.detail?.error ? `: ${p.detail.error}` : ""}</>}</li>
                  ))}
                </ol>
              )}
              {open === r.id && (r.status === "waiting" || r.status === "running") && crm.access.write && (
                <button type="button" className="crm-btn ghost sm danger-text" onClick={async () => { try { await api.flowCancelRun(r.id); load(); } catch (e) { crm.notify(errorText(e)); } }}>Tirar da automação</button>
              )}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

function TestModal({ flow, onClose, beforeStart }: { flow: FlowRow; onClose: () => void; beforeStart: () => Promise<void> }) {
  const crm = useCrm();
  const [phone, setPhone] = useState(() => localStorage.getItem("idx:flow-test-phone") ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await beforeStart();
      await api.flowStart(flow.id, { phones: [phone], test: true });
      localStorage.setItem("idx:flow-test-phone", phone);
      setDone(true);
    } catch (e) { crm.notify(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Testar no WhatsApp"
      footer={done ? <button type="button" className="crm-btn primary" onClick={onClose}>Fechar</button> : <>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={() => void start()}>{busy ? "Iniciando…" : "Enviar teste"}</button>
      </>}>
      {done ? (
        <p>Teste iniciado! Em alguns segundos a primeira mensagem chega no <b>{phoneLabel(phone)}</b>. Responda pelo celular para seguir o caminho — dá para acompanhar em <b>Execuções</b>.</p>
      ) : (
        <>
          <p className="crm-muted">A automação roda de verdade para um número só (o seu), mesmo em rascunho, pela conexão de WhatsApp do CRO. O gatilho é ignorado: começa do primeiro bloco.</p>
          <label className="fz-field"><span className="fz-field-label">Seu WhatsApp</span>
            <input className="crm-input" value={phone} placeholder="(11) 99999-9999" onChange={(e) => setPhone(e.target.value)} autoFocus />
          </label>
        </>
      )}
    </Modal>
  );
}
