// Calcula as posições dos blocos da automação de farmácias (da esquerda para a direita, sem setas cruzando o fluxo)
// e grava em POSICOES dentro de farmacias.mjs. Uso: node scripts/idx/layout-farmacias.mjs <pasta com @dagrejs/dagre>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.argv[2] ? `${process.argv[2]}/` : import.meta.url);
const dagre = require("@dagrejs/dagre");
const file = new URL("./farmacias.mjs", import.meta.url);
const { farmaciasGraph } = await import(file.href + "?t=" + Date.now());
const g = farmaciasGraph({ campaignId: "x", stages: {} });

const height = (n) => {
  const c = n.data.config ?? {};
  if (n.type === "send_menu") return 150 + 30 * String(c.options ?? "").split("\n").filter(Boolean).length;
  if (n.type === "condition") return 120;
  if (n.type === "ask" || n.type === "send_text") return 120;
  return 96;
};
const d = new dagre.graphlib.Graph({ multigraph: true });
d.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 110, edgesep: 20, marginx: 40, marginy: 40, ranker: "network-simplex" });
d.setDefaultEdgeLabel(() => ({}));
for (const n of g.nodes) d.setNode(n.id, { width: 252, height: height(n) });
for (const e of g.edges) d.setEdge(e.source, e.target, {}, e.id);
dagre.layout(d);
const pos = {};
for (const n of g.nodes) { const p = d.node(n.id); pos[n.id] = { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) }; }
// o editor abre no canto (0,0): o gatilho fica lá, à esquerda e no topo da tela
const t0 = pos.t;
for (const id of Object.keys(pos)) pos[id] = { x: pos[id].x - t0.x + 40, y: pos[id].y - t0.y + 120 };
const src = readFileSync(file, "utf8");
const out = src.replace(/const POSICOES = \{[\s\S]*?\};\n\/\/ \/POSICOES/, `const POSICOES = ${JSON.stringify(pos)};\n// /POSICOES`);
writeFileSync(file, out);
console.log("blocos:", g.nodes.length, "largura:", Math.max(...Object.values(pos).map((p) => p.x)), "altura:", Math.max(...Object.values(pos).map((p) => p.y)));
