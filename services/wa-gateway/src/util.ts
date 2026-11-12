// Funções puras (testadas em test/util.test.ts)

/** Dígitos E.164 sem "+", no mesmo padrão do banco (idx_private.normalize_phone). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/@(g\.us|lid|broadcast|newsletter)$/.test(raw)) return null;
  let d = raw.replace(/@.*$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/**
 * Variações a consultar no WhatsApp: celulares brasileiros podem estar
 * cadastrados com ou sem o 9º dígito. A primeira é a informada.
 */
export function phoneCandidates(e164: string): string[] {
  const out = [e164];
  if (e164.startsWith("55")) {
    const ddd = e164.slice(2, 4);
    const local = e164.slice(4);
    if (local.length === 9 && local.startsWith("9")) out.push("55" + ddd + local.slice(1));
    else if (local.length === 8 && /^[6-9]/.test(local)) out.push("55" + ddd + "9" + local);
  }
  return out;
}

export type ContentType =
  | "text" | "image" | "audio" | "video" | "document" | "location" | "contact" | "sticker" | "reaction" | "unknown";

export interface ParsedMessage {
  wa_message_id: string;
  wa_id: string;
  phone: string | null;
  from_me: boolean;
  push_name?: string;
  type: ContentType;
  body: string | null;
  mime?: string;
  quoted_id?: string;
  ts: string;
}

/** Desembrulha mensagens efêmeras / "ver uma vez" / editadas. */
function unwrap(m: any): any {
  let x = m;
  for (let i = 0; i < 5 && x; i++) {
    const inner =
      x.ephemeralMessage?.message ??
      x.viewOnceMessage?.message ??
      x.viewOnceMessageV2?.message ??
      x.viewOnceMessageV2Extension?.message ??
      x.documentWithCaptionMessage?.message ??
      x.editedMessage?.message;
    if (!inner) break;
    x = inner;
  }
  return x;
}

/**
 * Converte uma mensagem do Baileys no formato que o banco grava.
 * Retorna null para grupos, status, newsletters e mensagens de protocolo.
 */
export function parseMessage(msg: any): ParsedMessage | null {
  const key = msg?.key ?? {};
  const remote: string = key.remoteJid ?? "";
  if (!remote || !key.id) return null;
  if (/@(g\.us|broadcast|newsletter)$/.test(remote) || remote === "status@broadcast") return null;

  const m = unwrap(msg.message);
  if (!m) return null;
  if (m.protocolMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;

  // Conversas com ID oculto (@lid): o número real vem em remoteJidAlt / senderPn
  const alt: string | undefined = key.remoteJidAlt ?? key.senderPn ?? msg.senderPn;
  const phoneJid = remote.endsWith("@lid") ? alt : remote;
  const phone = normalizePhone(phoneJid ?? null);

  let type: ContentType = "unknown";
  let body: string | null = null;
  let mime: string | undefined;
  let ctx: any;

  if (m.conversation != null) { type = "text"; body = m.conversation; }
  else if (m.extendedTextMessage) { type = "text"; body = m.extendedTextMessage.text ?? null; ctx = m.extendedTextMessage.contextInfo; }
  else if (m.imageMessage) { type = "image"; body = m.imageMessage.caption ?? null; mime = m.imageMessage.mimetype; ctx = m.imageMessage.contextInfo; }
  else if (m.videoMessage) { type = "video"; body = m.videoMessage.caption ?? null; mime = m.videoMessage.mimetype; ctx = m.videoMessage.contextInfo; }
  else if (m.audioMessage) { type = "audio"; mime = m.audioMessage.mimetype; ctx = m.audioMessage.contextInfo; }
  else if (m.documentMessage) { type = "document"; body = m.documentMessage.caption ?? m.documentMessage.fileName ?? null; mime = m.documentMessage.mimetype; }
  else if (m.stickerMessage) { type = "sticker"; mime = m.stickerMessage.mimetype; }
  else if (m.locationMessage) { type = "location"; body = [m.locationMessage.name, m.locationMessage.address].filter(Boolean).join(" · ") || null; }
  else if (m.contactMessage || m.contactsArrayMessage) { type = "contact"; body = m.contactMessage?.displayName ?? null; }
  else if (m.reactionMessage) { type = "reaction"; body = m.reactionMessage.text ?? null; }
  else if (m.buttonsResponseMessage) { type = "text"; body = m.buttonsResponseMessage.selectedDisplayText ?? null; }
  else if (m.listResponseMessage) { type = "text"; body = m.listResponseMessage.title ?? null; }
  else if (m.templateButtonReplyMessage) { type = "text"; body = m.templateButtonReplyMessage.selectedDisplayText ?? null; }

  const tsRaw = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);
  const ts = new Date(tsRaw > 0 ? tsRaw * 1000 : Date.now()).toISOString();

  return {
    wa_message_id: String(key.id),
    wa_id: phone ?? remote.replace(/@.*$/, ""),
    phone,
    from_me: Boolean(key.fromMe),
    push_name: key.fromMe ? undefined : msg.pushName ?? undefined,
    type,
    body,
    mime,
    quoted_id: ctx?.stanzaId ?? undefined,
    ts,
  };
}

/** Status do Baileys → status do banco */
export function mapStatus(n: number | undefined): "sent" | "delivered" | "read" | "failed" | null {
  switch (n) {
    case 0: return "failed";  // ERROR
    case 2: return "sent";    // SERVER_ACK
    case 3: return "delivered";
    case 4: case 5: return "read"; // READ / PLAYED
    default: return null;
  }
}

/** Erros que valem nova tentativa (conexão), não falha definitiva. */
export function isTransient(err: unknown): boolean {
  const s = String((err as any)?.message ?? err ?? "").toLowerCase();
  return /connection (closed|lost|failure)|timed? ?out|not connected|socket|econn|stream errored|precondition/.test(s);
}

/** Atraso de reconexão com teto (nunca desiste). */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 3_000 * 2 ** Math.min(attempt, 5));
}

/** Tempo "digitando…" proporcional ao tamanho da mensagem (1,5 a 6 s). */
export function typingMs(text: string, rnd: () => number = Math.random): number {
  const base = Math.min(6000, 1500 + text.length * 25);
  return Math.round(base * (0.8 + rnd() * 0.4));
}
