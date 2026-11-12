// =============================================================================
// Núcleo das automações (fluxos) do CRO — TypeScript puro, sem dependências.
// Usado no servidor (função cro-flows) e no navegador (simulador do editor),
// então o "Testar" mostra exatamente o que a automação real faz.
// =============================================================================

export type NodeType =
  | "trigger"
  | "send_text" | "send_media" | "send_menu" | "ask" | "ai_reply"
  | "wait" | "wait_response" | "business_hours"
  | "condition" | "split_ab"
  | "tag" | "crm_deal" | "task" | "assign" | "notify" | "conversion" | "webhook" | "set_field" | "handoff" | "optout"
  | "end";

export type FlowNode = { id: string; type: NodeType; position: { x: number; y: number }; data: { config: Record<string, any>; label?: string } };
export type FlowEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type Graph = { nodes: FlowNode[]; edges: FlowEdge[] };

export type TriggerKind = "message" | "first_message" | "keyword" | "tag" | "stage" | "manual" | "campaign";

export type WaitKind = "delay" | "response" | "menu" | "ask" | "business_hours";
export type RunState = {
  node: string | null;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  vars: Record<string, any>;
  wait?: { kind: WaitKind; node: string; until?: string | null };
  steps: number;
  error?: string | null;
};

export type ContactInfo = {
  name?: string | null; phone?: string | null; email?: string | null; company?: string | null; city?: string | null;
  tags?: string[]; fields?: Record<string, any>; optedOut?: boolean; inWindowHours?: number | null;
};

export type OutMsg =
  | { kind: "text"; text: string }
  | { kind: "media"; mediaType: "image" | "video" | "audio" | "document"; url: string; caption?: string; fileName?: string };

/** Efeitos colaterais — o servidor grava no banco; o simulador só registra. */
export interface FlowEffects {
  send(msg: OutMsg, nodeId: string): Promise<void>;
  tag(action: "add" | "remove", tag: string): Promise<void>;
  setField(field: string, value: string): Promise<void>;
  crmDeal(cfg: { action: "create" | "move"; stage_id?: string | null; title?: string; value?: number | null }): Promise<void>;
  task(cfg: { title: string; type: string; due_in_hours: number; description?: string }): Promise<void>;
  assign(cfg: { user_id?: string | null; strategy?: "round_robin" | "user" }): Promise<void>;
  notify(cfg: { message: string; to?: string | null }): Promise<void>;
  conversion(label: string): Promise<void>;
  webhook(cfg: { url: string; method: string; body: any }): Promise<{ ok: boolean; status: number; data?: any }>;
  ai(cfg: { prompt: string; message: string; history?: string }): Promise<string>;
  handoff(message?: string): Promise<void>;
  optout(): Promise<void>;
  log(nodeId: string, event: string, detail?: any): void;
}

export interface FlowContext {
  now: Date;
  tz: string;
  contact: ContactInfo;
  random?: () => number;
  effects: FlowEffects;
}

export const MAX_STEPS_PER_TICK = 60;

// -----------------------------------------------------------------------------
// Texto: normalização, palavras-chave (igual ao FlowZap original), variáveis
// -----------------------------------------------------------------------------
export function normalize(str: string): string {
  return String(str ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

export const SYNONYMS: Record<string, string[]> = {
  preco: ["valor", "custo", "quanto custa", "quanto e", "quanto fica", "investimento", "tabela"],
  oi: ["ola", "bom dia", "boa tarde", "boa noite", "eai", "e ai", "fala", "salve", "hey", "hi"],
  sim: ["quero", "aceito", "pode ser", "vamos", "bora", "claro", "com certeza", "positivo", "isso"],
  nao: ["nao quero", "sem interesse", "negativo", "nope", "nah", "dispenso", "passa"],
  ajuda: ["socorro", "help", "suporte", "atendimento", "me ajuda", "preciso de ajuda"],
  comprar: ["adquirir", "contratar", "fechar", "assinar", "pegar", "quero comprar"],
  obrigado: ["valeu", "vlw", "thanks", "brigado", "grato", "agradeco"],
  horario: ["hora", "funcionamento", "abre", "fecha", "expediente", "agenda"],
  endereco: ["localizacao", "onde fica", "local", "mapa", "como chegar"],
  cardapio: ["menu", "opcoes", "catalogo", "produtos", "servicos", "o que tem"],
  desconto: ["promocao", "oferta", "cupom", "barato", "mais barato"],
  entrega: ["delivery", "envio", "frete", "despacho", "remessa"],
  pagamento: ["pagar", "pix", "cartao", "boleto", "forma de pagamento", "como pago"],
  reserva: ["agendar", "agendamento", "marcar", "reservar", "horario disponivel"],
};

/** Palavra-chave tolerante: contém, erro de digitação (Levenshtein) e sinônimos. mode "exact" = mensagem igual. */
export function matchKeyword(message: string, keyword: string, mode: "smart" | "exact" | "contains" = "smart"): boolean {
  const msg = normalize(message);
  const kw = normalize(keyword);
  if (!kw) return false;
  if (mode === "exact") return msg === kw;
  if (msg.includes(kw)) return true;
  if (mode === "contains") return false;
  for (const word of msg.split(" ")) {
    if (word.length >= 3 && kw.length >= 3 && !kw.includes(" ")) {
      const max = kw.length <= 4 ? 1 : 2;
      if (levenshtein(word, kw) <= max) return true;
    }
  }
  for (const syn of SYNONYMS[kw] ?? []) if (msg.includes(normalize(syn))) return true;
  for (const [base, syns] of Object.entries(SYNONYMS)) {
    if (syns.some((s) => normalize(s) === kw) && (msg.includes(base) || syns.some((s) => msg.includes(normalize(s))))) return true;
  }
  return false;
}

/** Variáveis: {nome} {primeiro_nome} {telefone} {email} {empresa} {cidade} {resposta} {var.x} e {a|b|c} (sorteio). */
export function interpolate(text: string, contact: ContactInfo, vars: Record<string, any>, random: () => number = Math.random): string {
  let t = String(text ?? "");
  for (let guard = 0; guard < 50; guard++) {
    const m = t.match(/\{([^{}]*\|[^{}]*)\}/);
    if (!m) break;
    const opts = m[1].split("|");
    t = t.replace(m[0], opts[Math.floor(random() * opts.length)] ?? "");
  }
  const name = (contact.name ?? "").trim();
  const map: Record<string, string> = {
    nome: name, primeiro_nome: name.split(" ")[0] ?? "", telefone: contact.phone ?? "", email: contact.email ?? "",
    empresa: contact.company ?? "", cidade: contact.city ?? "", resposta: String(vars.lastResponse ?? ""),
  };
  // Variável vazia vira marcador: só some o espaço que ela deixaria ("Oi {nome}!" → "Oi!"),
  // sem mexer na pontuação escrita pelo usuário ("preços: ...").
  const EMPTY = "\u0000";
  const path = (obj: any, key: string) => key.split(".").reduce((o, p) => (o == null ? undefined : o[p] ?? o[p.toLowerCase()]), obj);
  t = t.replace(/\{(var\.)?([a-z0-9_]+(?:\.[a-z0-9_]+)*)\}/gi, (whole, isVar, key: string) => {
    const k = key.toLowerCase();
    let v: string | null = null;
    if (isVar) { const x = path(vars, key); v = x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x); }
    else if (key.includes(".")) return whole;
    else if (k in map) v = map[k];
    else if (contact.fields && k in contact.fields) v = String(contact.fields[k] ?? "");
    else if (k in vars) v = String(vars[k] ?? "");
    if (v === null) return whole;
    return v === "" ? EMPTY : v;
  });
  return t.replace(/ *\u0000 *(?=[,.!?])/g, "").replace(/ *\u0000 */g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

// -----------------------------------------------------------------------------
// Horário
// -----------------------------------------------------------------------------
function zoned(date: Date, tz: string) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date)) p[x.type] = x.value;
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday as "Sun"] ?? 1;
  return { day, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm: string, def: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : def;
};

export function inBusinessHours(now: Date, tz: string, cfg: Record<string, any> = {}): boolean {
  const days: number[] = Array.isArray(cfg.days) && cfg.days.length ? cfg.days.map(Number) : [1, 2, 3, 4, 5];
  const start = toMin(cfg.start, 9 * 60), end = toMin(cfg.end, 18 * 60);
  const z = zoned(now, tz);
  return days.includes(z.day) && z.minutes >= start && z.minutes < end;
}

/** Próximo momento dentro do horário comercial (procura de 15 em 15 minutos, até 8 dias). */
export function nextBusinessTime(now: Date, tz: string, cfg: Record<string, any> = {}): Date {
  if (inBusinessHours(now, tz, cfg)) return now;
  const t = new Date(Math.ceil(now.getTime() / 900000) * 900000);
  for (let i = 0; i < 8 * 96; i++, t.setTime(t.getTime() + 900000)) {
    if (inBusinessHours(t, tz, cfg)) return new Date(t);
  }
  return new Date(now.getTime() + 24 * 3600000);
}

export function delayMs(amount: number, unit: string): number {
  const a = Math.max(0, Number(amount) || 0);
  const u = unit === "seconds" ? 1000 : unit === "hours" ? 3600000 : unit === "days" ? 86400000 : 60000;
  return a * u;
}

// -----------------------------------------------------------------------------
// Gatilhos
// -----------------------------------------------------------------------------
export type FlowEvent =
  | { kind: "message"; text: string; firstMessage: boolean; outsideHours?: boolean }
  | { kind: "tag"; tag: string }
  | { kind: "stage"; stageId: string }
  | { kind: "manual" }
  | { kind: "campaign"; campaignId: string };

export function triggerOf(graph: Graph): FlowNode | undefined {
  return graph.nodes.find((n) => n.type === "trigger");
}

export function matchTrigger(graph: Graph, ev: FlowEvent, now?: Date, tz = "America/Sao_Paulo"): boolean {
  const t = triggerOf(graph);
  if (!t) return false;
  const c = t.data.config ?? {};
  const kind: TriggerKind = c.kind ?? "message";
  if (c.onlyOutsideHours && now && inBusinessHours(now, tz, c.hours ?? {})) return false;
  switch (kind) {
    case "message": return ev.kind === "message";
    case "first_message": return ev.kind === "message" && ev.firstMessage;
    case "keyword": {
      if (ev.kind !== "message") return false;
      const kws: string[] = (Array.isArray(c.keywords) ? c.keywords : String(c.keywords ?? "").split(/[\n,]/)).map((s: string) => s.trim()).filter(Boolean);
      return kws.some((k) => matchKeyword(ev.text, k, c.matchMode ?? "smart"));
    }
    case "tag": return ev.kind === "tag" && normalize(ev.tag) === normalize(c.tag ?? "");
    case "stage": return ev.kind === "stage" && !!c.stage_id && ev.stageId === c.stage_id;
    case "campaign": return ev.kind === "campaign" && (!c.campaign_id || ev.campaignId === c.campaign_id);
    case "manual": return ev.kind === "manual";
    default: return false;
  }
}

// -----------------------------------------------------------------------------
// Validação (avisos no editor)
// -----------------------------------------------------------------------------
export type Issue = { nodeId?: string; level: "error" | "warning"; message: string };

export const OUTPUTS: Partial<Record<NodeType, (cfg: Record<string, any>) => { id: string; label: string }[]>> = {
  condition: () => [{ id: "yes", label: "Sim" }, { id: "no", label: "Não" }],
  split_ab: (c) => [{ id: "a", label: `A ${c.percent ?? 50}%` }, { id: "b", label: `B ${100 - (Number(c.percent ?? 50))}%` }],
  wait_response: () => [{ id: "replied", label: "Respondeu" }, { id: "timeout", label: "Não respondeu" }],
  ask: () => [{ id: "answered", label: "Respondeu" }, { id: "timeout", label: "Não respondeu" }],
  webhook: () => [{ id: "ok", label: "Sucesso" }, { id: "error", label: "Erro" }],
  send_menu: (c) => [
    ...menuOptions(c).map((o, i) => ({ id: `opt${i}`, label: `${i + 1}. ${o}` })),
    { id: "other", label: "Outra resposta" },
    { id: "timeout", label: "Não respondeu" },
  ],
};
export function outputsOf(node: FlowNode): { id: string; label: string }[] {
  if (node.type === "end" || node.type === "handoff" || node.type === "optout") return [];
  return OUTPUTS[node.type]?.(node.data.config ?? {}) ?? [{ id: "next", label: "" }];
}
export function menuOptions(c: Record<string, any>): string[] {
  return (Array.isArray(c.options) ? c.options : String(c.options ?? "").split("\n")).map((s: string) => String(s).trim()).filter(Boolean).slice(0, 10);
}

export function validateGraph(g: Graph): Issue[] {
  const issues: Issue[] = [];
  const triggers = g.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) issues.push({ level: "error", message: triggers.length ? "Use só um gatilho por automação" : "Adicione um gatilho (o que inicia a automação)" });
  const reachable = new Set<string>();
  const stack = triggers.map((t) => t.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of g.edges) if (e.source === id) stack.push(e.target);
  }
  for (const n of g.nodes) {
    const c = n.data.config ?? {};
    if (!reachable.has(n.id)) issues.push({ nodeId: n.id, level: "warning", message: "Bloco solto: não está ligado ao gatilho" });
    if (n.type === "trigger" && c.kind === "keyword" && !String(c.keywords ?? "").trim() && !(Array.isArray(c.keywords) && c.keywords.length)) issues.push({ nodeId: n.id, level: "error", message: "Informe as palavras-chave" });
    if (n.type === "trigger" && c.kind === "tag" && !String(c.tag ?? "").trim()) issues.push({ nodeId: n.id, level: "error", message: "Escolha a etiqueta" });
    if (n.type === "trigger" && c.kind === "stage" && !c.stage_id) issues.push({ nodeId: n.id, level: "error", message: "Escolha a etapa do funil" });
    if ((n.type === "send_text" || n.type === "ask") && !String(c.text ?? "").trim()) issues.push({ nodeId: n.id, level: "error", message: "Escreva a mensagem" });
    if (n.type === "send_menu" && (!String(c.text ?? "").trim() || menuOptions(c).length < 2)) issues.push({ nodeId: n.id, level: "error", message: "Menu precisa de texto e ao menos 2 opções" });
    if (n.type === "send_media" && !/^https?:\/\//.test(String(c.url ?? ""))) issues.push({ nodeId: n.id, level: "error", message: "Informe o arquivo (link https)" });
    if (n.type === "webhook" && !/^https:\/\//.test(String(c.url ?? ""))) issues.push({ nodeId: n.id, level: "error", message: "Webhook precisa de um endereço https" });
    if (n.type === "tag" && !String(c.tag ?? "").trim()) issues.push({ nodeId: n.id, level: "error", message: "Escolha a etiqueta" });
    if (n.type === "ai_reply" && !String(c.prompt ?? "").trim()) issues.push({ nodeId: n.id, level: "error", message: "Explique para a IA como responder" });
    if (n.type === "trigger" && !g.edges.some((e) => e.source === n.id)) issues.push({ nodeId: n.id, level: "error", message: "Ligue o gatilho ao primeiro passo" });
  }
  // laço sem espera trava o motor: exige um bloco de espera em qualquer ciclo
  const waits = new Set<NodeType>(["wait", "wait_response", "ask", "send_menu", "business_hours"]);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>(), done = new Set<string>();
  const dfs = (id: string, path: string[]): boolean => {
    if (visiting.has(id)) {
      const cyc = path.slice(path.indexOf(id));
      if (!cyc.some((x) => waits.has(byId.get(x)?.type as NodeType))) { issues.push({ nodeId: id, level: "error", message: "Volta em círculo sem nenhuma espera — adicione “Esperar” ou “Aguardar resposta” no caminho" }); return true; }
      return false;
    }
    if (done.has(id)) return false;
    visiting.add(id);
    for (const e of g.edges) if (e.source === id && dfs(e.target, [...path, id])) { visiting.delete(id); return true; }
    visiting.delete(id); done.add(id);
    return false;
  };
  for (const t of triggers) dfs(t.id, []);
  return issues;
}

// -----------------------------------------------------------------------------
// Execução
// -----------------------------------------------------------------------------
function nextFrom(g: Graph, nodeId: string, handle = "next"): string | null {
  const outs = g.edges.filter((e) => e.source === nodeId);
  const e = outs.find((x) => (x.sourceHandle ?? "next") === handle) ?? (handle === "next" ? outs[0] : undefined);
  return e?.target ?? null;
}

export function startState(graph: Graph, triggerData: Record<string, any> = {}): RunState {
  const t = triggerOf(graph);
  return { node: t?.id ?? null, status: t ? "running" : "failed", vars: { trigger: triggerData, lastResponse: triggerData.text ?? "" }, steps: 0, error: t ? null : "Sem gatilho" };
}

function evalRule(rule: Record<string, any>, ctx: FlowContext, vars: Record<string, any>): boolean {
  const op = rule.op ?? "equals";
  const field = rule.field ?? "responded";
  const val = String(rule.value ?? "");
  const textOp = (subject: string) => {
    const s = normalize(subject), v = normalize(val);
    switch (op) {
      case "equals": return s === v;
      case "not_equals": return s !== v;
      case "contains": return s.includes(v);
      case "not_contains": return !s.includes(v);
      case "starts_with": return s.startsWith(v);
      case "not_empty": return s.length > 0;
      case "empty": return s.length === 0;
      case "gt": return Number(subject) > Number(val);
      case "lt": return Number(subject) < Number(val);
      case "keyword": return val.split(/[\n,]/).some((k) => matchKeyword(subject, k.trim()));
      default: return false;
    }
  };
  switch (field) {
    case "responded": return !!String(vars.lastResponse ?? "").trim() === (op !== "empty");
    case "has_tag": return (ctx.contact.tags ?? []).some((t) => normalize(t) === normalize(val)) === (op !== "not_equals");
    case "business_hours": return inBusinessHours(ctx.now, ctx.tz, rule.hours ?? {}) === (op !== "not_equals");
    case "last_message": return textOp(String(vars.lastResponse ?? ""));
    case "variable": return textOp(String(vars[rule.key ?? ""] ?? ""));
    case "contact_field": {
      const k = String(rule.key ?? "");
      const v = ({ nome: ctx.contact.name, email: ctx.contact.email, cidade: ctx.contact.city, empresa: ctx.contact.company, telefone: ctx.contact.phone } as Record<string, any>)[k] ?? ctx.contact.fields?.[k] ?? "";
      return textOp(String(v ?? ""));
    }
    case "ab": return String(vars.abSplit ?? "") === val;
    default: return false;
  }
}

/**
 * Avança a execução até precisar esperar (tempo/resposta) ou terminar.
 * `input.message`: resposta do contato quando a execução estava aguardando uma.
 * `input.timeout`: o prazo de espera venceu.
 */
export async function step(graph: Graph, state: RunState, ctx: FlowContext, input: { message?: string; timeout?: boolean } = {}): Promise<RunState> {
  const s: RunState = { ...state, vars: { ...state.vars } };
  const rnd = ctx.random ?? Math.random;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const fx = ctx.effects;
  const goto = (id: string | null) => { s.node = id; if (!id) { s.status = "completed"; } };

  if (ctx.contact.optedOut) { s.status = "cancelled"; s.error = "Contato pediu SAIR"; return s; }

  // retomada de uma espera
  if (s.status === "waiting" && s.wait) {
    const w = s.wait;
    const node = byId.get(w.node);
    s.wait = undefined;
    s.status = "running";
    if (!node) { s.status = "failed"; s.error = "Bloco removido da automação"; return s; }
    if (input.message !== undefined) s.vars.lastResponse = input.message;
    switch (w.kind) {
      case "delay":
      case "business_hours":
        goto(nextFrom(graph, node.id));
        break;
      case "response":
        goto(nextFrom(graph, node.id, input.timeout ? "timeout" : "replied"));
        break;
      case "ask": {
        if (input.timeout) { goto(nextFrom(graph, node.id, "timeout")); break; }
        const c = node.data.config ?? {};
        const answer = String(input.message ?? "").trim();
        const key = String(c.saveAs ?? "").trim().toLowerCase();
        if (key) s.vars[key] = answer;
        if (c.saveTo) await fx.setField(String(c.saveTo), answer);
        fx.log(node.id, "answered", { answer: answer.slice(0, 200) });
        goto(nextFrom(graph, node.id, "answered"));
        break;
      }
      case "menu": {
        if (input.timeout) { goto(nextFrom(graph, node.id, "timeout")); break; }
        const opts = menuOptions(node.data.config ?? {});
        const ans = normalize(String(input.message ?? ""));
        const num = Number((ans.match(/^\d+/) ?? [])[0]);
        let idx = Number.isInteger(num) && num >= 1 && num <= opts.length ? num - 1 : -1;
        if (idx < 0) idx = opts.findIndex((o) => normalize(o) === ans || (ans.length >= 3 && normalize(o).includes(ans)) || matchKeyword(ans, o, "contains"));
        s.vars.lastChoice = idx >= 0 ? opts[idx] : "";
        fx.log(node.id, "choice", { option: idx >= 0 ? idx + 1 : null });
        goto(nextFrom(graph, node.id, idx >= 0 ? `opt${idx}` : "other"));
        break;
      }
    }
  }

  while (s.status === "running" && s.node) {
    if (s.steps >= 500) { s.status = "failed"; s.error = "Automação passou de 500 passos"; break; }
    if ((s.vars.__tick ?? 0) >= MAX_STEPS_PER_TICK) { s.status = "failed"; s.error = "Muitos passos seguidos sem espera"; break; }
    s.steps++; s.vars.__tick = (s.vars.__tick ?? 0) + 1;
    const node = byId.get(s.node);
    if (!node) { s.status = "failed"; s.error = "Bloco não encontrado"; break; }
    const c = node.data.config ?? {};
    const text = (t: string) => interpolate(t, ctx.contact, s.vars, rnd);
    fx.log(node.id, "enter");
    try {
      switch (node.type) {
        case "trigger":
          goto(nextFrom(graph, node.id));
          break;
        case "send_text": {
          const variants: string[] = [c.text, ...(Array.isArray(c.variants) ? c.variants : [])].map((x) => String(x ?? "").trim()).filter(Boolean);
          const pick = variants[Math.floor(rnd() * variants.length)] ?? "";
          if (pick) await fx.send({ kind: "text", text: text(pick) }, node.id);
          goto(nextFrom(graph, node.id));
          break;
        }
        case "send_media":
          await fx.send({ kind: "media", mediaType: c.mediaType ?? "image", url: String(c.url ?? ""), caption: c.caption ? text(c.caption) : undefined, fileName: c.fileName || undefined }, node.id);
          goto(nextFrom(graph, node.id));
          break;
        case "send_menu": {
          const opts = menuOptions(c);
          const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
          const body = `${text(c.text ?? "")}\n\n${opts.map((o, i) => `${emoji[i]} ${o}`).join("\n")}${c.footer ? `\n\n${text(c.footer)}` : "\n\n_Responda com o número da opção._"}`;
          await fx.send({ kind: "text", text: body }, node.id);
          s.status = "waiting";
          s.wait = { kind: "menu", node: node.id, until: new Date(ctx.now.getTime() + delayMs(c.timeout ?? 24, c.timeoutUnit ?? "hours")).toISOString() };
          break;
        }
        case "ask":
          await fx.send({ kind: "text", text: text(c.text ?? "") }, node.id);
          s.status = "waiting";
          s.wait = { kind: "ask", node: node.id, until: new Date(ctx.now.getTime() + delayMs(c.timeout ?? 24, c.timeoutUnit ?? "hours")).toISOString() };
          break;
        case "ai_reply": {
          const reply = (await fx.ai({ prompt: text(c.prompt ?? ""), message: String(s.vars.lastResponse ?? "") })).trim();
          if (reply) await fx.send({ kind: "text", text: reply.slice(0, Number(c.maxChars) || 1200) }, node.id);
          s.vars.ai = reply;
          goto(nextFrom(graph, node.id));
          break;
        }
        case "wait":
          s.status = "waiting";
          s.wait = { kind: "delay", node: node.id, until: new Date(ctx.now.getTime() + delayMs(c.amount ?? 1, c.unit ?? "minutes")).toISOString() };
          break;
        case "wait_response":
          s.vars.lastResponse = "";
          s.status = "waiting";
          s.wait = { kind: "response", node: node.id, until: new Date(ctx.now.getTime() + delayMs(c.timeout ?? 24, c.timeoutUnit ?? "hours")).toISOString() };
          break;
        case "business_hours": {
          const at = nextBusinessTime(ctx.now, ctx.tz, c);
          if (at.getTime() <= ctx.now.getTime()) { goto(nextFrom(graph, node.id)); break; }
          s.status = "waiting";
          s.wait = { kind: "business_hours", node: node.id, until: at.toISOString() };
          break;
        }
        case "condition": {
          const rules: Record<string, any>[] = Array.isArray(c.rules) && c.rules.length ? c.rules : [{ field: c.field ?? "responded", op: c.op, value: c.value, key: c.key }];
          const results = rules.map((r) => evalRule(r, ctx, s.vars));
          const ok = (c.match ?? "all") === "any" ? results.some(Boolean) : results.every(Boolean);
          fx.log(node.id, ok ? "yes" : "no");
          goto(nextFrom(graph, node.id, ok ? "yes" : "no"));
          break;
        }
        case "split_ab": {
          const isA = rnd() * 100 < Number(c.percent ?? 50);
          s.vars.abSplit = isA ? "A" : "B";
          fx.log(node.id, isA ? "a" : "b");
          goto(nextFrom(graph, node.id, isA ? "a" : "b"));
          break;
        }
        case "tag":
          await fx.tag(c.action === "remove" ? "remove" : "add", String(c.tag ?? "").trim());
          if (c.action === "remove") ctx.contact.tags = (ctx.contact.tags ?? []).filter((t) => normalize(t) !== normalize(c.tag));
          else ctx.contact.tags = [...new Set([...(ctx.contact.tags ?? []), String(c.tag).trim()])];
          goto(nextFrom(graph, node.id));
          break;
        case "set_field":
          await fx.setField(String(c.field ?? ""), text(c.value ?? ""));
          if (c.field) ctx.contact.fields = { ...(ctx.contact.fields ?? {}), [c.field]: text(c.value ?? "") };
          goto(nextFrom(graph, node.id));
          break;
        case "crm_deal":
          await fx.crmDeal({ action: c.action === "move" ? "move" : "create", stage_id: c.stage_id ?? null, title: c.title ? text(c.title) : undefined, value: c.value != null && c.value !== "" ? Number(c.value) : null });
          goto(nextFrom(graph, node.id));
          break;
        case "task":
          await fx.task({ title: text(c.title || "Falar com {nome}"), type: c.taskType ?? "follow_up", due_in_hours: Number(c.dueInHours ?? 1), description: c.description ? text(c.description) : undefined });
          goto(nextFrom(graph, node.id));
          break;
        case "assign":
          await fx.assign({ user_id: c.user_id ?? null, strategy: c.strategy ?? (c.user_id ? "user" : "round_robin") });
          goto(nextFrom(graph, node.id));
          break;
        case "notify":
          await fx.notify({ message: text(c.message || "{nome} precisa de atenção"), to: c.to ?? null });
          goto(nextFrom(graph, node.id));
          break;
        case "conversion":
          await fx.conversion(String(c.label || "conversao"));
          goto(nextFrom(graph, node.id));
          break;
        case "webhook": {
          const body = { contato: { nome: ctx.contact.name, telefone: ctx.contact.phone, email: ctx.contact.email, etiquetas: ctx.contact.tags }, variaveis: Object.fromEntries(Object.entries(s.vars).filter(([k]) => !k.startsWith("__"))), extra: c.body ? text(c.body) : undefined };
          const r = await fx.webhook({ url: String(c.url ?? ""), method: c.method ?? "POST", body });
          s.vars.webhook_status = r.status;
          if (r.data !== undefined) s.vars.webhook = r.data;
          goto(nextFrom(graph, node.id, r.ok ? "ok" : "error"));
          break;
        }
        case "handoff":
          await fx.handoff(c.message ? text(c.message) : undefined);
          s.status = "completed"; s.node = null;
          break;
        case "optout":
          await fx.optout();
          s.status = "completed"; s.node = null;
          break;
        case "end":
          s.status = "completed"; s.node = null;
          break;
        default:
          goto(nextFrom(graph, node.id));
      }
    } catch (e) {
      s.status = "failed";
      s.error = `${node.data.label ?? node.type}: ${(e as Error).message}`;
      fx.log(node.id, "error", { message: (e as Error).message });
    }
  }
  delete s.vars.__tick;
  return s;
}
