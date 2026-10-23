// Análise comercial de conversas ancorada nas mensagens reais.
//
// Modelos pequenos (ex.: qwen2.5:1.5b via Ollama) copiam exemplos do prompt e
// inventam nomes, produtos, preços e objeções. Este módulo:
//   1. monta um prompt SEM exemplos de dados (nada para copiar);
//   2. valida cada campo devolvido pela IA contra o texto das mensagens;
//   3. classifica a etapa comercial por regras sobre as mensagens do cliente;
//   4. escreve o resumo a partir dos fatos validados — nunca do texto livre da IA.
//
// Sem dependências de Deno: é importado pelas Edge Functions e pelos testes (Node).

export type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound" | string;
  body: string | null;
  content_type?: string | null;
  timestamp?: string | null;
};

export type AnalysisContext = {
  tenantName?: string | null;
  businessSegment?: string | null;
  // Nome registrado no WhatsApp (push_name) ou no CRM. Nunca vem da IA.
  contactName?: string | null;
  messages: ConversationMessage[];
};

export type Stage =
  | "none"
  | "interest"
  | "high_intent"
  | "negotiation"
  | "declared_purchase"
  | "confirmed_sale"
  | "abandonment";

export type GroundedSignal = {
  type: Exclude<Stage, "none">;
  confidence: number;
  evidence: string;
  source_msg_ids: string[];
  product: string | null;
};

export type GroundedAnalysis = {
  contact_info: {
    name: { value: string | null; confidence: number; source_msg_ids: string[] };
    email: { value: string | null; confidence: number; source_msg_ids: string[] };
    phone: { value: string | null; confidence: number; source_msg_ids: string[] };
    address: { value: string | null; confidence: number; source_msg_ids: string[] };
  };
  commercial: {
    products_of_interest: { name: string }[];
    product_identified: boolean;
    objections: { text: string }[];
    preferences: Record<string, string>;
    budget_mentioned: string | null;
    urgency: string | null;
  };
  sale_signals: GroundedSignal[];
  stage: Stage;
  summary: string;
  intent: string | null;
  sentiment: "positive" | "neutral" | "negative";
  purchase_probability: number;
  commercial_notes: string | null;
  // Categorias que a IA devolveu e foram descartadas por não existirem na conversa
  // (só a categoria: o texto inventado não é guardado).
  discarded: string[];
};

const STAGE_RANK: Record<Stage, number> = {
  none: 0,
  abandonment: 1,
  interest: 2,
  high_intent: 3,
  negotiation: 4,
  declared_purchase: 5,
  confirmed_sale: 6,
};

export const STAGE_LABEL: Record<Stage, string | null> = {
  none: null,
  interest: "Interesse inicial",
  high_intent: "Intenção forte de compra",
  negotiation: "Negociando condições",
  declared_purchase: "Cliente afirma ter comprado (aguardando confirmação)",
  confirmed_sale: "Venda confirmada pela empresa",
  abandonment: "Desistiu ou adiou a compra",
};

// Probabilidade fixa por etapa: evita "90% de chance" para quem só disse "oi".
const STAGE_PROBABILITY: Record<Stage, number> = {
  none: 0.05,
  abandonment: 0.1,
  interest: 0.3,
  high_intent: 0.5,
  negotiation: 0.65,
  declared_purchase: 0.85,
  confirmed_sale: 1,
};

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

export function normalize(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set(
  ("a o as os um uma uns umas de da do das dos em no na nos nas por para pra pro com sem e ou que se ao aos " +
    "eu voce voces ele ela eles elas nos me te lhe meu minha seu sua isso esse essa este esta aqui ali la " +
    "muito mais menos ja ainda nao sim tambem so mas quando onde como qual quais quem foi ser estar esta estou " +
    "tem ter tenho quer quero queria gostaria pode poderia vou vai sobre ate apos entre todo toda todos todas").split(" "),
);

function contentTokens(text: string): string[] {
  return normalize(text).split(" ").filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// Tokens compartilhados por prefixo de 5 letras (plural, gênero, conjugação).
function stem(token: string): string {
  return token.slice(0, 5);
}

function corpusStems(texts: string[]): Set<string> {
  const stems = new Set<string>();
  for (const text of texts) for (const token of contentTokens(text)) stems.add(stem(token));
  return stems;
}

// Fração dos termos relevantes de `text` que aparecem na conversa.
export function groundedRatio(text: string, corpus: Set<string>): number {
  const tokens = contentTokens(text);
  if (!tokens.length) return 0;
  return tokens.filter((t) => corpus.has(stem(t))).length / tokens.length;
}

function messageBodies(messages: ConversationMessage[], direction?: string): string[] {
  return messages
    .filter((m) => (direction ? m.direction === direction : true))
    .map((m) => String(m.body ?? ""))
    .filter((b) => b.trim().length > 0);
}

// Trecho citado pela IA precisa existir em alguma mensagem (comparação normalizada).
function findEvidence(evidence: string, messages: ConversationMessage[]): ConversationMessage | null {
  const needle = normalize(evidence);
  if (needle.length < 2) return null;
  return messages.find((m) => normalize(m.body).includes(needle)) ?? null;
}

// ---------------------------------------------------------------------------
// Regras de etapa comercial sobre as mensagens do CLIENTE
// ---------------------------------------------------------------------------

const CUES: Record<Exclude<Stage, "none" | "confirmed_sale">, RegExp[]> = {
  abandonment: [
    /\bvou pensar\b/, /\bdesist/, /\bnao (tenho|quero) mais\b/, /\bsem interesse\b/, /\bagora nao\b/,
    /\bfica pra (depois|outra)\b/, /\bnao vou (querer|comprar|fechar)\b/,
  ],
  interest: [
    /\binteress/, /\bquanto (custa|e|fica|sai)\b/, /\b(qual|quais) (o|os|a|as)? ?(valor|valores|preco|precos)\b/,
    /\bvalor\b/, /\bpreco\b/, /\bvoces (tem|fazem|vendem|atendem|trabalham)\b/, /\btem (disponivel|estoque)\b/,
    /\bgostaria de (saber|informac)/, /\binformac/, /\bcomo funciona\b/, /\bqueria saber\b/, /\borcamento\b/,
    // Perguntas diretas comuns a qualquer segmento: "Tem ração?", "Vocês vendem...?", "Fazem exame?"
    /^(oi |ola |bom dia |boa tarde |boa noite )*(voces |vcs )?(tem|teria|vende|vendem|faz|fazem|aceita|aceitam|atende|atendem|trabalha|trabalham)\b/,
    /\b(disponivel|disponibilidade|horario|agenda) (para|pra|de|hoje|amanha)\b/,
  ],
  high_intent: [
    /\bquero (comprar|contratar|fechar|levar|agendar|marcar|pedir|encomendar)\b/, /\bvou (comprar|levar|querer|fechar)\b/,
    /\bpode (mandar|enviar|separar|reservar|agendar|marcar)\b/, /\bcomo (faco|eu faco) (pra|para) (comprar|pagar|pedir)\b/,
    /\bquero (esse|essa|este|esta|o|a)\b/, /\bpreciso (urgente|hoje|com urgencia)\b/, /\bfecha(do|r)? hoje\b/,
  ],
  negotiation: [
    /\bdesconto\b/, /\bparcel/, /\ba vista\b/, /\bfaz (por|mais barato)\b/, /\bmelhor (preco|valor)\b/,
    /\baceita (pix|cartao|boleto)\b/, /\bfrete\b/, /\bprazo de entrega\b/, /\bse eu fechar\b/,
  ],
  declared_purchase: [
    /\b(ja )?paguei\b/, /\bcomprei\b/, /\bfiz o (pix|pagamento|pedido)\b/, /\btransferi\b/, /\bfechei\b/,
    /\bsegue (o )?comprovante\b/, /\bpagamento (feito|realizado|efetuado)\b/,
  ],
};

// Confirmação de venda precisa vir da EMPRESA.
const COMPANY_CONFIRMATION = [
  /\bpagamento (confirmado|recebido|aprovado)\b/, /\brecebemos (o |seu )?(pagamento|pix|comprovante)\b/,
  /\bpedido (confirmado|n|numero|no)\b/, /\bcompra (confirmada|aprovada)\b/, /\bpix (recebido|confirmado|caiu)\b/,
];

const OBJECTION_CUES = [
  /\bcaro\b/, /\bmuito alto\b/, /\bnao (tenho|tenho como|consigo) (pagar|dinheiro)\b/, /\bsem dinheiro\b/,
  /\bdemora/, /\blonge\b/, /\bnao gostei\b/, /\bpreocup/, /\bduvida\b/, /\bnao confio\b/, /\bmais barato\b/,
];

function stageFromRules(messages: ConversationMessage[]): { stage: Stage; evidence: ConversationMessage | null } {
  let best = "none" as Stage;
  let evidence = null as ConversationMessage | null;
  let abandonmentAt = -1;
  let lastPositiveAt = -1;

  messages.forEach((msg, index) => {
    if (msg.direction !== "inbound") return;
    const text = normalize(msg.body);
    if (!text) return;
    for (const stage of ["declared_purchase", "negotiation", "high_intent", "interest"] as const) {
      if (CUES[stage].some((re) => re.test(text))) {
        lastPositiveAt = index;
        if (STAGE_RANK[stage] > STAGE_RANK[best]) {
          best = stage;
          evidence = msg;
        }
        break;
      }
    }
    if (CUES.abandonment.some((re) => re.test(text))) abandonmentAt = index;
  });

  // Desistência depois do último sinal positivo (e antes de qualquer compra declarada).
  if (abandonmentAt > lastPositiveAt && best !== "declared_purchase") {
    return { stage: "abandonment", evidence: messages[abandonmentAt] };
  }

  // Venda confirmada só com confirmação da empresa depois de uma compra declarada/negociação.
  if (STAGE_RANK[best] >= STAGE_RANK.high_intent) {
    const confirmation = messages.find(
      (m) => m.direction === "outbound" && COMPANY_CONFIRMATION.some((re) => re.test(normalize(m.body))),
    );
    if (confirmation) return { stage: "confirmed_sale", evidence: confirmation };
  }
  return { stage: best, evidence };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `Você analisa conversas de WhatsApp de um negócio local brasileiro. O negócio pode ser de qualquer segmento (farmácia, clínica, veterinária, loja, oficina, escola, salão etc.).

Responda SOMENTE com um objeto JSON. Use apenas fatos escritos nas mensagens desta conversa.

Proibido:
- inventar ou trocar o nome do cliente;
- inventar produto, serviço, preço, valor, objeção, pagamento, compra ou venda;
- supor o segmento do negócio além do informado;
- usar conhecimento de outras conversas.

Quando o cliente não disser o produto ou serviço, deixe "produtos" vazio.
Quando não houver objeção escrita pelo cliente, deixe "objecoes" vazio.
Cada item de "produtos", "objecoes" e "sinais" precisa de um trecho copiado literalmente de uma mensagem.

Etapas possíveis em "sinais.tipo":
"interest" (pede informação ou diz ter interesse),
"high_intent" (diz que quer comprar/contratar/agendar),
"negotiation" (negocia preço, desconto, parcelamento, prazo, frete),
"declared_purchase" (o cliente diz que já pagou ou comprou),
"confirmed_sale" (a EMPRESA confirma o pagamento ou o pedido),
"abandonment" (o cliente desiste ou adia).`;

export function buildUserPrompt(ctx: AnalysisContext): string {
  const lines = ctx.messages
    .filter((m) => String(m.body ?? "").trim())
    .map((m) => {
      const who = m.direction === "inbound" ? "CLIENTE" : "EMPRESA";
      const kind = m.content_type && m.content_type !== "text" ? `[${m.content_type}] ` : "";
      return `${who} (id ${m.id.substring(0, 8)}): ${kind}${String(m.body).trim()}`;
    })
    .join("\n");

  const header = [
    ctx.tenantName ? `Empresa: ${ctx.tenantName}` : null,
    ctx.businessSegment ? `Segmento informado pela empresa: ${ctx.businessSegment}` : "Segmento: não informado",
    ctx.contactName ? `Nome do cliente no WhatsApp: ${ctx.contactName}` : "Nome do cliente: não informado",
  ].filter(Boolean).join("\n");

  return `${header}

Mensagens (esta conversa, em ordem):
${lines}

Formato da resposta:
{"nome_cliente": null, "produtos": [], "objecoes": [], "orcamento": null, "email": null, "telefone": null, "endereco": null, "sinais": [], "sentimento": "neutral"}

- "produtos": lista de {"nome": ..., "trecho": ...}
- "objecoes": lista de {"texto": ..., "trecho": ...}
- "sinais": lista de {"tipo": ..., "trecho": ..., "produto": null}
- "sentimento": "positive", "neutral" ou "negative"
- Campos sem informação ficam null ou [].`;
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export function parseModelJson(raw: string): Record<string, unknown> | null {
  let text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? { nome: item, texto: item, trecho: item } : item))
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (obj[key] != null && obj[key] !== "") return obj[key];
  return null;
}

function str(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "object") return null;
  const text = String(value).trim();
  return text && !/^(null|string|n\/a|nenhum|nenhuma|nao informado|nao identificado|desconhecido)$/i.test(normalize(text))
    ? text
    : null;
}

const SIGNAL_ALIASES: Record<string, Exclude<Stage, "none">> = {
  interest: "interest", interesse: "interest",
  high_intent: "high_intent", commitment: "high_intent", intencao: "high_intent",
  negotiation: "negotiation", negociacao: "negotiation",
  declared_purchase: "declared_purchase", post_sale: "declared_purchase",
  confirmed_sale: "confirmed_sale", venda_confirmada: "confirmed_sale",
  abandonment: "abandonment", abandono: "abandonment",
};

function cap(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

function buildSummary(name: string, stage: Stage, products: string[], objections: string[], buyVerb: boolean): string {
  const product = products.length ? joinList(products) : null;
  let first: string;
  switch (stage) {
    case "interest":
    case "high_intent":
      first = product
        ? `${name} demonstrou interesse em ${buyVerb || stage === "high_intent" ? "comprar " : ""}${product}.`
        : `${name} demonstrou interesse${buyVerb || stage === "high_intent" ? " em comprar" : ""}, mas ainda não informou qual produto ou serviço deseja.`;
      break;
    case "negotiation":
      first = `${name} está negociando condições de compra${product ? ` de ${product}` : ""}.${product ? "" : " O produto ou serviço ainda não foi identificado."}`;
      break;
    case "declared_purchase":
      first = `${name} afirmou ter realizado a compra${product ? ` de ${product}` : ""}, mas o pagamento ainda não foi confirmado pela empresa.`;
      break;
    case "confirmed_sale":
      first = `A empresa confirmou a venda${product ? ` de ${product}` : ""} para ${name}.`;
      break;
    case "abandonment":
      first = `${name} indicou que não pretende seguir com a compra agora.`;
      break;
    default:
      first = `${name} ainda não demonstrou interesse de compra nesta conversa.`;
  }
  const second = objections.length ? `Objeções identificadas: ${joinList(objections)}.` : "Nenhuma objeção foi identificada.";
  return `${first} ${second}`;
}

// Valida a resposta da IA contra a conversa. `raw` pode ser null (IA falhou):
// a análise sai só das regras, sem nada inventado.
export function groundAnalysis(raw: Record<string, unknown> | null, ctx: AnalysisContext): GroundedAnalysis {
  const messages = ctx.messages.filter((m) => String(m.body ?? "").trim());
  const inbound = messages.filter((m) => m.direction === "inbound");
  const allCorpus = corpusStems(messageBodies(messages));
  const inboundCorpus = corpusStems(messageBodies(messages, "inbound"));
  const allNormalized = normalize(messageBodies(messages).join(" \n "));
  const model = raw ?? {};
  const discarded: string[] = [];

  // Nome: o registrado no WhatsApp/CRM. Da IA, só se estiver escrito na conversa.
  const modelName = str(pick(model, "nome_cliente", "name", "nome"));
  const modelNameGrounded = modelName && allNormalized.includes(normalize(modelName)) ? modelName : null;
  if (modelName && !modelNameGrounded) discarded.push("nome");
  const knownName = str(ctx.contactName);
  const displayName = knownName ?? modelNameGrounded ?? "O cliente";
  const nameMsg = modelNameGrounded ? messages.find((m) => normalize(m.body).includes(normalize(modelNameGrounded))) : null;

  // Produtos: precisam aparecer na conversa.
  const products: string[] = [];
  for (const item of asArray(pick(model, "produtos", "products_of_interest", "products"))) {
    const name = str(pick(item, "nome", "name", "produto"));
    if (!name) continue;
    if (groundedRatio(name, allCorpus) >= 0.6 && !products.some((p) => normalize(p) === normalize(name))) products.push(name);
    else discarded.push("produto");
  }

  // Objeções: escritas pelo CLIENTE e com cara de objeção.
  const objections: string[] = [];
  for (const item of asArray(pick(model, "objecoes", "objections"))) {
    const text = str(pick(item, "texto", "text", "objecao"));
    if (!text) continue;
    const quote = str(pick(item, "trecho", "evidence")) ?? text;
    const source = findEvidence(quote, inbound);
    const grounded = source && groundedRatio(text, inboundCorpus) >= 0.6 && OBJECTION_CUES.some((re) => re.test(normalize(source.body)));
    if (grounded) objections.push(text);
    else discarded.push("objecao");
  }

  // Orçamento/valor: o número precisa estar escrito na conversa.
  const budgetRaw = str(pick(model, "orcamento", "budget_mentioned", "budget"));
  const budgetDigits = budgetRaw ? budgetRaw.replace(/\D/g, "") : "";
  const budget = budgetRaw && budgetDigits && allNormalized.replace(/\D/g, " ").split(" ").includes(budgetDigits) ? budgetRaw : null;
  if (budgetRaw && !budget) discarded.push("orcamento");

  const groundedContact = (key: string) => {
    const value = str(pick(model, key));
    if (!value) return { value: null, confidence: 0, source_msg_ids: [] as string[] };
    const source = findEvidence(value, inbound);
    if (!source) {
      discarded.push(key);
      return { value: null, confidence: 0, source_msg_ids: [] as string[] };
    }
    return { value, confidence: 0.9, source_msg_ids: [source.id] };
  };

  // Etapa: regras sobre as mensagens + sinais da IA que têm evidência real.
  const rules = stageFromRules(messages);
  const signals: GroundedSignal[] = [];
  for (const item of asArray(pick(model, "sinais", "sale_signals"))) {
    const type = SIGNAL_ALIASES[normalize(String(pick(item, "tipo", "type") ?? "")).replace(/\s+/g, "_")];
    const quote = str(pick(item, "trecho", "evidence"));
    if (!type || !quote) continue;
    const source = findEvidence(quote, messages);
    if (!source) {
      discarded.push(`sinal:${type}`);
      continue;
    }
    // A IA não pode declarar etapa acima do que as mensagens sustentam.
    const allowed =
      type === "confirmed_sale" ? rules.stage === "confirmed_sale" :
      type === "declared_purchase" ? STAGE_RANK[rules.stage] >= STAGE_RANK.declared_purchase :
      type === "abandonment" ? rules.stage === "abandonment" :
      source.direction === "inbound" && STAGE_RANK[type] <= Math.max(STAGE_RANK[rules.stage], STAGE_RANK.interest) &&
        (rules.stage !== "none" || type === "interest");
    if (!allowed) {
      discarded.push(`sinal_sem_base:${type}`);
      continue;
    }
    const product = str(pick(item, "produto", "product"));
    signals.push({
      type,
      confidence: type === "confirmed_sale" ? 0.95 : type === "declared_purchase" ? 0.8 : 0.7,
      evidence: String(source.body).trim().slice(0, 300),
      source_msg_ids: [source.id],
      product: product && products.some((p) => normalize(p) === normalize(product)) ? product : null,
    });
  }

  let stage = rules.stage;
  // Desistência recente prevalece: sinais antigos de interesse não a sobrescrevem.
  if (stage !== "abandonment") {
    for (const signal of signals) if (STAGE_RANK[signal.type] > STAGE_RANK[stage]) stage = signal.type;
  }

  // Garante um sinal com evidência para a etapa detectada pelas regras.
  if (stage !== "none" && rules.evidence && !signals.some((s) => s.type === stage)) {
    signals.push({
      type: stage as Exclude<Stage, "none">,
      confidence: stage === "confirmed_sale" ? 0.95 : stage === "declared_purchase" ? 0.8 : 0.7,
      evidence: String(rules.evidence.body).trim().slice(0, 300),
      source_msg_ids: [rules.evidence.id],
      product: null,
    });
  }

  const buyVerb = inbound.some((m) => /\b(compr|contrat|adquir|pedir|encomend)/.test(normalize(m.body)));
  const sentimentRaw = String(pick(model, "sentimento", "sentiment") ?? "neutral");
  const sentiment = (["positive", "neutral", "negative"] as const).includes(sentimentRaw as never)
    ? (sentimentRaw as "positive" | "neutral" | "negative")
    : "neutral";

  let probability = STAGE_PROBABILITY[stage];
  if (stage === "high_intent" && products.length) probability = 0.6;

  return {
    contact_info: {
      name: modelNameGrounded
        ? { value: modelNameGrounded, confidence: 0.9, source_msg_ids: nameMsg ? [nameMsg.id] : [] }
        : { value: null, confidence: 0, source_msg_ids: [] },
      email: groundedContact("email"),
      phone: groundedContact("telefone"),
      address: groundedContact("endereco"),
    },
    commercial: {
      products_of_interest: products.map((name) => ({ name })),
      product_identified: products.length > 0,
      objections: objections.map((text) => ({ text })),
      preferences: {},
      budget_mentioned: budget,
      urgency: null,
    },
    sale_signals: signals,
    stage,
    summary: buildSummary(displayName, stage, products, objections, buyVerb),
    intent: STAGE_LABEL[stage],
    sentiment,
    purchase_probability: cap(probability),
    commercial_notes: products.length || stage === "none" ? null : "Produto ou serviço ainda não identificado.",
    discarded,
  };
}

// Itens de uma análise antiga que não existem nas mensagens (para reprocessar).
export function isAnalysisContaminated(
  stored: { summary?: string | null; extracted_name?: string | null; products_of_interest?: string[] | null; objections?: string[] | null },
  ctx: AnalysisContext,
): boolean {
  const messages = ctx.messages.filter((m) => String(m.body ?? "").trim());
  const corpus = corpusStems([...messageBodies(messages), ctx.contactName ?? "", ctx.tenantName ?? ""]);
  const all = normalize(messageBodies(messages).join(" "));
  if (stored.extracted_name && !all.includes(normalize(stored.extracted_name))) return true;
  for (const product of stored.products_of_interest ?? []) if (groundedRatio(product, corpus) < 0.6) return true;
  for (const objection of stored.objections ?? []) if (groundedRatio(objection, corpus) < 0.6) return true;
  return false;
}
