// Calcula as posições dos blocos da automação de farmácias e grava em POSICOES dentro de farmacias.mjs.
// Desenho em árvore, da esquerda para a direita: o caminho principal (o mais longo) corre na linha de cima,
// começando pelo gatilho no canto, e cada desvio desce logo abaixo de onde sai. Uso: node scripts/idx/layout-farmacias.mjs
import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("./farmacias.mjs", import.meta.url);
const { farmaciasGraph } = await import(file.href + "?t=" + Date.now());
const g = farmaciasGraph({ campaignId: "x", stages: {} });

const W = 252, COL = W + 110, GAP = 36;
const height = (n) => {
  const c = n.data.config ?? {};
  if (n.type === "send_menu") return 150 + 30 * String(c.options ?? "").split("\n").filter(Boolean).length;
  if (n.type === "condition" || n.type === "ask" || n.type === "send_text") return 120;
  return 96;
};
const byId = new Map(g.nodes.map((n) => [n.id, n]));
const out = new Map(g.nodes.map((n) => [n.id, []]));
for (const e of g.edges) out.get(e.source).push(e.target);

// 1) tira as setas de volta (laços) e calcula a coluna = maior caminho desde o gatilho
const back = new Set(), seen = new Set(), stack = new Set();
const dfs = (id) => { seen.add(id); stack.add(id); for (const t of out.get(id)) { if (stack.has(t)) back.add(`${id}>${t}`); else if (!seen.has(t)) dfs(t); } stack.delete(id); };
dfs("t");
const fwd = (id) => out.get(id).filter((t) => !back.has(`${id}>${t}`));
const rank = new Map([["t", 0]]);
const order = []; const vis = new Set();
const topo = (id) => { if (vis.has(id)) return; vis.add(id); for (const t of fwd(id)) topo(t); order.push(id); };
topo("t"); order.reverse();
for (const id of order) for (const t of fwd(id)) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
// profundidade de cada bloco (para o caminho mais longo ir primeiro, na linha de cima)
const depth = new Map();
for (const id of [...order].reverse()) depth.set(id, 1 + Math.max(0, ...fwd(id).map((t) => depth.get(t) ?? 0)));

// 2) o caminho mais longo corre numa linha; cada desvio é encaixado logo abaixo, na primeira altura livre
//    das colunas que ele ocupa (empacotamento por "horizonte"), para as setas ficarem curtas
const placed = new Map(); const bottom = new Map();
const reachMax = new Map();
for (const id of [...order].reverse()) reachMax.set(id, Math.max(rank.get(id), ...fwd(id).map((t) => reachMax.get(t) ?? 0)));
const free = (c0, c1) => { let y = 0; for (let c = c0; c <= c1; c++) y = Math.max(y, bottom.get(c) ?? 0); return y; };
const chainFrom = (start, y) => {
  const chain = []; let id = start;
  while (id && !placed.has(id)) {
    placed.set(id, { x: rank.get(id) * COL, y });
    chain.push(id);
    const c = rank.get(id);
    bottom.set(c, Math.max(bottom.get(c) ?? 0, y + height(byId.get(id)) + GAP));
    id = fwd(id).filter((t) => !placed.has(t)).sort((a, b) => depth.get(b) - depth.get(a))[0];
  }
  for (const n of chain) {
    for (const k of fwd(n).filter((t) => !placed.has(t)).sort((a, b) => depth.get(b) - depth.get(a))) {
      if (placed.has(k)) continue;
      chainFrom(k, Math.max(placed.get(n).y, free(rank.get(k), reachMax.get(k))));
    }
  }
};
chainFrom("t", 0);
let cursor = Math.max(0, ...bottom.values());
for (const n of g.nodes) if (!placed.has(n.id)) { placed.set(n.id, { x: 0, y: cursor }); cursor += height(n) + GAP; }

// 3) evita sobreposição dentro da mesma coluna (pai alto ao lado de filhos baixos)
const cols = new Map();
for (const [id, p] of placed) { if (!cols.has(p.x)) cols.set(p.x, []); cols.get(p.x).push(id); }
for (const ids of cols.values()) {
  ids.sort((a, b) => placed.get(a).y - placed.get(b).y);
  let bottom = -Infinity;
  for (const id of ids) { const p = placed.get(id); if (p.y < bottom) p.y = bottom; bottom = p.y + height(byId.get(id)) + GAP; }
}
const pos = {};
for (const [id, p] of placed) pos[id] = { x: p.x + 40, y: p.y + 40 };
const src = readFileSync(file, "utf8");
writeFileSync(file, src.replace(/const POSICOES = \{[\s\S]*?\};\n\/\/ \/POSICOES/, `const POSICOES = ${JSON.stringify(pos)};\n// /POSICOES`));
console.log("blocos:", g.nodes.length, "colunas:", cols.size, "largura:", Math.max(...Object.values(pos).map((p) => p.x)), "altura:", Math.max(...Object.values(pos).map((p) => p.y)));
