// Bloco do desenho (nó) e ligação com botão de apagar — visual próprio, estilo FlowZap.
import { memo, useState, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, useReactFlow, type EdgeProps, type NodeProps } from "@xyflow/react";
import { AlertCircle, Plus, Timer, Users, X } from "lucide-react";
import { outputsOf, type FlowNode, type NodeType } from "../../../../supabase/functions/_shared/flow-core";
import { blockOf, groupOf, summary, type SummaryCtx } from "./catalog";

export type BlockData = {
  kind: NodeType;
  config: Record<string, any>;
  label?: string;
  // dados só da tela
  issues?: string[];
  stats?: { enter?: number; waiting?: number };
  sim?: "active" | "visited";
  freeOutputs?: string[];
  summaryCtx?: SummaryCtx;
  onAddAfter?: (nodeId: string, handle: string, anchor: DOMRect) => void;
  [k: string]: unknown;
};

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")} mil` : String(n));

function BlockNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as BlockData;
  const def = blockOf(d.kind);
  const g = groupOf(def.group);
  const Icon = def.icon;
  const asNode: FlowNode = { id, type: d.kind, position: { x: 0, y: 0 }, data: { config: d.config } };
  const outs = outputsOf(asNode);
  const multi = outs.length > 1 || (outs.length === 1 && outs[0].id !== "next");
  const text = summary(d.kind, d.config, d.summaryCtx);
  const hasIssue = !!d.issues?.length;
  const style = { "--blk": g.color, "--blk-soft": g.soft } as CSSProperties;
  const plus = (handle: string) =>
    d.onAddAfter && d.freeOutputs?.includes(handle) ? (
      <button type="button" className="fz-plus nodrag" title="Adicionar o próximo passo"
        onClick={(e) => { e.stopPropagation(); d.onAddAfter!(id, handle, (e.currentTarget as HTMLElement).getBoundingClientRect()); }}>
        <Plus size={12} strokeWidth={2.6} />
      </button>
    ) : null;

  return (
    <div className={`fz-node${selected ? " is-selected" : ""}${hasIssue ? " has-issue" : ""}${d.sim ? ` sim-${d.sim}` : ""}${d.kind === "trigger" ? " is-trigger" : ""}`} style={style}>
      {d.kind !== "trigger" && <Handle type="target" position={Position.Left} className="fz-handle fz-in" />}
      <div className="fz-node-head">
        <span className="fz-node-icon"><Icon size={15} strokeWidth={2.2} /></span>
        <div className="fz-node-title">
          <small>{d.kind === "trigger" ? "Quando" : g.label}</small>
          <strong>{d.label || def.label}</strong>
        </div>
        {hasIssue && <span className="fz-node-alert" title={d.issues!.join("\n")}><AlertCircle size={15} /></span>}
      </div>
      <div className="fz-node-body">{text}</div>
      {(d.stats?.enter || d.stats?.waiting) ? (
        <div className="fz-node-stats">
          {!!d.stats?.enter && <span title="Contatos que passaram por aqui"><Users size={11} /> {fmt(d.stats.enter)}</span>}
          {!!d.stats?.waiting && <span className="is-wait" title="Contatos esperando neste bloco agora"><Timer size={11} /> {fmt(d.stats.waiting)} aguardando</span>}
        </div>
      ) : null}
      {multi ? (
        <div className="fz-outs">
          {outs.map((o) => (
            <div key={o.id} className={`fz-out fz-out-${o.id.replace(/\d+$/, "")}`}>
              <span>{o.label}</span>
              <Handle type="source" position={Position.Right} id={o.id} className="fz-handle fz-out-handle" />
              {plus(o.id)}
            </div>
          ))}
        </div>
      ) : outs.length === 1 ? (
        <>
          <Handle type="source" position={Position.Right} id="next" className="fz-handle fz-single" />
          <div className="fz-single-plus">{plus("next")}</div>
        </>
      ) : null}
    </div>
  );
}
export const BlockNode = memo(BlockNodeImpl);

export function DeletableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props;
  const { deleteElements } = useReactFlow();
  const [hover, setHover] = useState(false);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const sim = (data as { sim?: boolean } | undefined)?.sim;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`fz-edge${selected ? " is-selected" : ""}${sim ? " is-sim" : ""}`} />
      <path d={path} fill="none" stroke="transparent" strokeWidth={18} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      <EdgeLabelRenderer>
        <button type="button" className={`fz-edge-del nodrag nopan${hover || selected ? " is-on" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          onClick={() => void deleteElements({ edges: [{ id }] })} title="Remover ligação">
          <X size={11} strokeWidth={2.6} />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
