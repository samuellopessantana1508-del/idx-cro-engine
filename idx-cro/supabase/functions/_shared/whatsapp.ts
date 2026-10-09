import { sendAndLogCapi, sessionCustomData, sessionUserData } from "./capi.ts";

type SupabaseLike = {
  from: (table: string) => any;
};

export const ENTERED_TAG = "entrou no whatsapp";

// Mesmo alfabeto do shortRef() do go: 4 + "-" + 4, sem caracteres ambíguos.
const REF_PATTERN = /\b([a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4})\b/i;

// Sinais de fechamento em pt-BR. Só servem para decidir QUANDO vale chamar a
// IA na hora; a decisão de venda é sempre da análise da conversa inteira.
const SALE_SIGNAL_PATTERN =
  /(pix|comprovante|paguei|pago|pagamento|transferi|fechad|fechar|fecho|vou querer|pode (mandar|enviar|separar|fazer|agendar)|compr|pedido|boleto|cart[aã]o|parcel|matr[ií]cula|contrat|agendad|confirmad|entrega|r\$\s?\d)/i;

// Quanto tempo depois de abrir o WhatsApp a primeira mensagem ainda pode ser
// ligada ao clique quando a pessoa apagou a ref do texto.
const TIME_WINDOW_MINUTES = 10;

export type ParsedMessage = {
  externalId: string;
  remoteJid: string;
  phone: string | null;
  fromMe: boolean;
  pushName: string | null;
  messageType: string;
  body: string;
  sentAt: string;
};

export type WhatsappIntegration = {
  tenant_id: string;
  api_url: string;
  instance_name: string;
  api_key: string;
  webhook_secret: string;
  enabled: boolean;
  integration_status: string;
  ai_enabled: boolean;
  ai_auto_confirm: boolean;
  ai_min_confidence: number;
};

function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function unwrapMessage(message: Record<string, any> | null | undefined): Record<string, any> {
  let current = message ?? {};
  for (let i = 0; i < 3; i++) {
    const inner = current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

function messageText(message: Record<string, any>): { type: string; body: string } | null {
  if (typeof message.conversation === "string") return { type: "text", body: message.conversation };
  if (message.extendedTextMessage?.text) return { type: "text", body: message.extendedTextMessage.text };
  if (message.imageMessage) return { type: "image", body: `[imagem] ${message.imageMessage.caption ?? ""}`.trim() };
  if (message.videoMessage) return { type: "video", body: `[vídeo] ${message.videoMessage.caption ?? ""}`.trim() };
  if (message.documentMessage) {
    const doc = message.documentMessage;
    return { type: "document", body: `[documento] ${doc.fileName ?? ""} ${doc.caption ?? ""}`.trim() };
  }
  if (message.audioMessage) return { type: "audio", body: "[áudio sem transcrição]" };
  if (message.stickerMessage) return { type: "sticker", body: "[figurinha]" };
  if (message.locationMessage) return { type: "location", body: "[localização]" };
  if (message.contactMessage) return { type: "contact", body: `[contato] ${message.contactMessage.displayName ?? ""}`.trim() };
  if (message.buttonsResponseMessage) return { type: "button", body: message.buttonsResponseMessage.selectedDisplayText ?? "" };
  if (message.templateButtonReplyMessage) return { type: "button", body: message.templateButtonReplyMessage.selectedDisplayText ?? "" };
  if (message.listResponseMessage) return { type: "list", body: message.listResponseMessage.title ?? "" };
  // reactionMessage, protocolMessage (apagar/editar), etc. não entram na conversa.
  return null;
}

function phoneFromJid(jid: string | null | undefined): string | null {
  const value = String(jid ?? "");
  if (!value.endsWith("@s.whatsapp.net") && !value.endsWith("@c.us")) return null;
  const phone = digits(value.split("@")[0]);
  return phone || null;
}

// Converte um item de "messages.upsert" da Evolution API (v1 ou v2).
export function parseEvolutionMessage(item: Record<string, any>): ParsedMessage | null {
  const key = item?.key ?? {};
  const remoteJid = String(key.remoteJid ?? "");
  if (!remoteJid || !key.id) return null;
  if (/@(g\.us|broadcast|newsletter)$/.test(remoteJid) || remoteJid === "status@broadcast") return null;

  const content = messageText(unwrapMessage(item.message));
  if (!content) return null;

  // Contas com privacidade nova chegam como "@lid": o número real vem em campos alternativos.
  const phone = phoneFromJid(remoteJid) ??
    phoneFromJid(key.remoteJidAlt) ??
    phoneFromJid(key.senderPn) ??
    phoneFromJid(item.senderPn) ??
    null;

  const ts = Number(item.messageTimestamp ?? 0);
  const sentAt = ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();

  return {
    externalId: String(key.id),
    remoteJid,
    phone,
    fromMe: Boolean(key.fromMe),
    pushName: key.fromMe ? null : (item.pushName ? String(item.pushName) : null),
    messageType: content.type,
    body: content.body.slice(0, 4000),
    sentAt,
  };
}

export function looksLikeSaleSignal(text: string): boolean {
  return SALE_SIGNAL_PATTERN.test(text);
}

async function findOrCreateConversation(
  supa: SupabaseLike,
  tenantId: string,
  msg: ParsedMessage,
): Promise<Record<string, any> | null> {
  const select = "*";
  const { data: existing } = await supa
    .from("whatsapp_conversations")
    .select(select)
    .eq("tenant_id", tenantId)
    .eq("remote_jid", msg.remoteJid)
    .maybeSingle();
  if (existing) return existing;

  await supa.from("whatsapp_conversations").upsert({
    tenant_id: tenantId,
    remote_jid: msg.remoteJid,
    phone: msg.phone,
    contact_name: msg.pushName,
    first_message_at: msg.sentAt,
  }, { onConflict: "tenant_id,remote_jid", ignoreDuplicates: true });

  const { data } = await supa
    .from("whatsapp_conversations")
    .select(select)
    .eq("tenant_id", tenantId)
    .eq("remote_jid", msg.remoteJid)
    .maybeSingle();
  return data ?? null;
}

const SESSION_SELECT = "*, offer:offers(*), smart_link:smart_links(*)";

async function resolveOriginal(supa: SupabaseLike, session: Record<string, any> | null): Promise<Record<string, any> | null> {
  if (!session?.duplicate_of) return session;
  const { data } = await supa.from("tracking_sessions").select(SESSION_SELECT).eq("id", session.duplicate_of).maybeSingle();
  return data ?? session;
}

async function findSessionForMessage(
  supa: SupabaseLike,
  tenantId: string,
  msg: ParsedMessage,
): Promise<{ session: Record<string, any>; method: "ref" | "phone" | "time_window" } | null> {
  const refMatch = msg.body.match(REF_PATTERN);
  if (refMatch) {
    const { data } = await supa
      .from("tracking_sessions")
      .select(SESSION_SELECT)
      .eq("tenant_id", tenantId)
      .eq("ref", refMatch[1].toLowerCase())
      .maybeSingle();
    const session = await resolveOriginal(supa, data ?? null);
    if (session) return { session, method: "ref" };
  }

  if (msg.phone) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supa
      .from("tracking_sessions")
      .select(SESSION_SELECT)
      .eq("tenant_id", tenantId)
      // Telefone salvo à mão pode estar sem o 55.
      .in("customer_phone", [msg.phone, msg.phone.replace(/^55/, "")])
      .not("lead_status", "in", "(sold,lost)")
      .is("duplicate_of", null)
      .gte("clicked_at", since)
      .order("clicked_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return { session: data[0], method: "phone" };
  }

  // Sem ref no texto: só liga ao clique se existir exatamente UM clique que
  // abriu o WhatsApp nos últimos minutos e ainda não virou conversa.
  const windowStart = new Date(new Date(msg.sentAt).getTime() - TIME_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data: candidates } = await supa
    .from("tracking_sessions")
    .select(SESSION_SELECT)
    .eq("tenant_id", tenantId)
    .is("duplicate_of", null)
    .is("whatsapp_conversation_id", null)
    .is("lead_confirmed_at", null)
    .gte("whatsapp_opened_at", windowStart)
    .lte("whatsapp_opened_at", msg.sentAt)
    .limit(2);
  if (candidates?.length === 1) return { session: candidates[0], method: "time_window" };

  return null;
}

async function sendWhatsappLead(supa: SupabaseLike, session: Record<string, any>): Promise<void> {
  const value = Number(session.offer?.price ?? 0);
  const payload = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    // Mesmo event_id do go/confirm: se os dois enviarem, o Meta deduplica.
    event_id: `lead_${session.id}`,
    event_source_url: session.request_url ?? undefined,
    action_source: "website",
    user_data: await sessionUserData(session),
    custom_data: sessionCustomData(session, value),
  };
  const capi = await sendAndLogCapi(supa, session, payload);
  if (capi.ok) {
    await supa.from("tracking_sessions").update({ capi_lead_ok: true }).eq("id", session.id);
  }
}

// Liga a conversa ao clique e transforma o clique em lead real.
async function linkConversation(
  supa: SupabaseLike,
  conversation: Record<string, any>,
  session: Record<string, any>,
  method: string,
  msg: ParsedMessage,
): Promise<void> {
  if (session.whatsapp_conversation_id && session.whatsapp_conversation_id !== conversation.id) return;

  const tags: string[] = Array.isArray(session.tags) ? session.tags.map(String) : [];
  const update: Record<string, unknown> = {
    whatsapp_conversation_id: conversation.id,
    customer_phone: session.customer_phone || msg.phone || null,
    customer_name: session.customer_name || msg.pushName || null,
    tags: tags.includes(ENTERED_TAG) ? tags : [...tags, ENTERED_TAG].slice(0, 12),
  };
  const newlyConfirmed = !session.lead_confirmed_at;
  if (newlyConfirmed) {
    update.lead_confirmed_at = msg.sentAt;
    update.lead_source = "whatsapp_message";
  }

  await supa.from("tracking_sessions").update(update).eq("id", session.id);
  await supa.from("whatsapp_conversations").update({
    tracking_session_id: session.id,
    match_method: method,
  }).eq("id", conversation.id);

  await supa.from("crm_activities").insert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    activity_type: "whatsapp",
    body: "Primeira mensagem recebida no WhatsApp",
    metadata: { match_method: method, conversation_id: conversation.id },
  });

  if (newlyConfirmed && !session.capi_lead_ok) {
    await sendWhatsappLead(supa, { ...session, ...update });
  }
}

export type ProcessResult = {
  conversationId: string;
  inbound: boolean;
  saleSignal: boolean;
} | null;

export async function processIncomingMessage(
  supa: SupabaseLike,
  tenantId: string,
  msg: ParsedMessage,
): Promise<ProcessResult> {
  const conversation = await findOrCreateConversation(supa, tenantId, msg);
  if (!conversation) return null;

  const { data: inserted } = await supa
    .from("whatsapp_messages")
    .upsert({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      external_id: msg.externalId,
      from_me: msg.fromMe,
      message_type: msg.messageType,
      body: msg.body,
      sent_at: msg.sentAt,
    }, { onConflict: "tenant_id,external_id", ignoreDuplicates: true })
    .select("id");
  // Evolution reenviou a mesma mensagem: já processada.
  if (!inserted?.length) return null;

  const conversationUpdate: Record<string, unknown> = {
    message_count: Number(conversation.message_count ?? 0) + 1,
    needs_analysis: true,
  };
  if (!conversation.last_message_at || msg.sentAt > conversation.last_message_at) conversationUpdate.last_message_at = msg.sentAt;
  if (!conversation.first_message_at) conversationUpdate.first_message_at = msg.sentAt;
  if (!msg.fromMe) {
    if (!conversation.first_inbound_at) conversationUpdate.first_inbound_at = msg.sentAt;
    if (msg.pushName && !conversation.contact_name) conversationUpdate.contact_name = msg.pushName;
    if (msg.phone && !conversation.phone) conversationUpdate.phone = msg.phone;
  }
  await supa.from("whatsapp_conversations").update(conversationUpdate).eq("id", conversation.id);

  if (!msg.fromMe && !conversation.tracking_session_id) {
    const match = await findSessionForMessage(supa, tenantId, msg);
    if (match) await linkConversation(supa, conversation, match.session, match.method, msg);
  }

  return {
    conversationId: conversation.id,
    inbound: !msg.fromMe,
    saleSignal: looksLikeSaleSignal(msg.body),
  };
}

export function webhookUrl(secret: string): string {
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  return `${base}/functions/v1/whatsapp-webhook?secret=${encodeURIComponent(secret)}`;
}

function evolutionBase(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, "");
}

export async function evolutionRequest(
  integration: Pick<WhatsappIntegration, "api_url" | "api_key">,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const response = await fetch(`${evolutionBase(integration.api_url)}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", apikey: integration.api_key, ...(init.headers ?? {}) },
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err) } };
  }
}

export async function configureEvolutionWebhook(integration: WhatsappIntegration) {
  const instance = encodeURIComponent(integration.instance_name);
  return await evolutionRequest(integration, `/webhook/set/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl(integration.webhook_secret),
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
      },
    }),
  });
}

export async function evolutionConnectionState(integration: WhatsappIntegration): Promise<string | null> {
  const instance = encodeURIComponent(integration.instance_name);
  const res = await evolutionRequest(integration, `/instance/connectionState/${instance}`, { method: "GET" });
  if (!res.ok) return null;
  return String(res.data?.instance?.state ?? res.data?.state ?? "") || null;
}
