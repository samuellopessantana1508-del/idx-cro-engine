import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import type { Db } from "./db.js";
import { backoffMs, isTransient, mapStatus, normalizePhone, parseMessage, phoneCandidates, typingMs } from "./util.js";

export interface SocketLike {
  ev: { on(event: string, cb: (arg: any) => void): void };
  user?: { id?: string } | null;
  onWhatsApp(...jids: string[]): Promise<Array<{ exists: boolean; jid: string }> | undefined>;
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key: { id?: string | null } } | undefined>;
  sendPresenceUpdate?(type: string, jid?: string): Promise<void>;
  presenceSubscribe?(jid: string): Promise<void>;
  logout?(): Promise<void>;
  end(err?: Error): void;
}

/** Cria o socket (Baileys de verdade em produção; falso nos testes). */
export type SocketFactory = (authDir: string, log: Logger) => Promise<{ sock: SocketLike; saveCreds: () => Promise<void> }>;

export interface Logger { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type OutItem = {
  id: string; phone: string; body: string; source: string;
  media_url?: string | null; media_type?: "image" | "video" | "audio" | "document" | null; file_name?: string | null;
};

const MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", zip: "application/zip", mp3: "audio/mpeg", ogg: "audio/ogg; codecs=opus", m4a: "audio/mp4",
};

/** Conteúdo no formato do WhatsApp (texto ou mídia por link; o WhatsApp baixa o arquivo). */
export function messageContent(item: OutItem): Record<string, unknown> {
  const caption = item.body?.trim() ? item.body : undefined;
  if (!item.media_url || !item.media_type) return { text: item.body };
  const url = { url: item.media_url };
  const name = item.file_name || decodeURIComponent(item.media_url.split("?")[0].split("/").pop() || "arquivo");
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (item.media_type) {
    case "image": return { image: url, caption };
    case "video": return { video: url, caption };
    case "audio": return { audio: url, mimetype: MIME[ext] ?? "audio/mp4", ptt: ext === "ogg" };
    default: return { document: url, fileName: name, mimetype: MIME[ext] ?? "application/octet-stream", caption };
  }
}

/**
 * Uma conexão de WhatsApp (um número). Mantém a conexão viva (reconecta sempre,
 * com espera crescente), publica o QR, grava entrada/saída no banco e envia a
 * fila (uma mensagem por vez; o banco decide o intervalo e os limites).
 */
export class Session {
  private sock: SocketLike | null = null;
  private open = false;
  private stopped = false;
  private attempt = 0;
  private sending = false;
  private sendTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  phone: string | null = null;

  constructor(
    readonly id: string,
    private db: Db,
    private factory: SocketFactory,
    private sessionsDir: string,
    private log: Logger,
    private opts: { pollMs: number; typing: boolean; onInbound?: () => void } = { pollMs: 3000, typing: true },
  ) {}

  get authDir() { return path.join(this.sessionsDir, this.id); }
  get isOpen() { return this.open; }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    try {
      const { sock, saveCreds } = await this.factory(this.authDir, this.log);
      this.sock = sock;
      sock.ev.on("creds.update", () => { saveCreds().catch((e) => this.log.error("[%s] saveCreds", this.id, e)); });
      sock.ev.on("connection.update", (u) => this.onConnection(sock, u));
      sock.ev.on("messages.upsert", (m) => this.onMessages(m));
      sock.ev.on("messages.update", (u) => this.onStatus(u));
    } catch (e) {
      this.log.error("[%s] falha ao iniciar conexão: %s", this.id, String((e as Error)?.message ?? e));
      this.scheduleReconnect();
    }
  }

  private async onConnection(sock: SocketLike, u: any) {
    if (sock !== this.sock || this.stopped) return;
    const { connection, lastDisconnect, qr } = u ?? {};
    if (qr) {
      // o WhatsApp troca o QR a cada ~20 s; a tela mostra sempre o mais recente
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      await this.db.updateInstance(this.id, "connecting", { qr: dataUrl }).catch((e) => this.log.error("[%s] qr", this.id, e.message));
    }
    if (connection === "open") {
      this.open = true;
      this.attempt = 0;
      this.phone = normalizePhone(sock.user?.id ?? null);
      this.log.info("[%s] conectado", this.id);
      await this.db.updateInstance(this.id, "connected", { phone: this.phone }).catch((e) => this.log.error("[%s] status", this.id, e.message));
      const n = await this.db.recover(this.id).catch(() => 0);
      if (n) this.log.warn("[%s] %d envio(s) interrompido(s) marcados como falha", this.id, n);
      this.kickSender(500);
    }
    if (connection === "close") {
      this.open = false;
      const code: number | undefined = lastDisconnect?.error?.output?.statusCode;
      this.log.warn("[%s] conexão fechada (código %s)", this.id, code ?? "?");
      if (code === 401) {
        // saiu pelo celular: precisa de novo QR
        await this.clearAuth();
        await this.db.updateInstance(this.id, "disconnected", { error: "Sessão encerrada no celular. Conecte de novo pelo QR." }).catch(() => {});
        if (!this.stopped) this.scheduleReconnect(2000);
        return;
      }
      if (code === 403) {
        await this.db.updateInstance(this.id, "banned", { error: "O WhatsApp bloqueou este número." }).catch(() => {});
        this.stopped = true;
        return;
      }
      // 515 (reinício após ler o QR) e quedas de rede: reconecta já/sem desistir
      this.scheduleReconnect(code === 515 ? 500 : undefined);
    }
  }

  private scheduleReconnect(ms?: number) {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const wait = ms ?? backoffMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, wait);
  }

  private async onMessages(m: any) {
    if (!m?.messages || (m.type !== "notify" && m.type !== "append")) return;
    for (const raw of m.messages) {
      const p = parseMessage(raw);
      if (!p) continue;
      const ok = await this.db.ingest(this.id, p).then(() => true, (e) => { this.log.error("[%s] ingest: %s", this.id, e.message); return false; });
      // mensagem recebida: avisa as automações para responderem já
      if (ok && !(p as { from_me?: boolean }).from_me) this.opts.onInbound?.();
    }
  }

  private async onStatus(updates: any[]) {
    for (const u of updates ?? []) {
      const s = mapStatus(u?.update?.status);
      const id = u?.key?.id;
      if (s && id && u.key.fromMe !== false) {
        await this.db.status(this.id, id, s).catch((e) => this.log.error("[%s] status: %s", this.id, e.message));
      }
    }
  }

  /** Agenda a próxima verificação da fila. */
  kickSender(ms = this.opts.pollMs) {
    if (this.stopped) return;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => { this.sendTimer = null; void this.sendLoop(); }, ms);
  }

  private async sendLoop() {
    if (this.sending || this.stopped) return;
    if (!this.open || !this.sock) return this.kickSender();
    this.sending = true;
    let sentOne = false;
    try {
      const item = await this.db.claim(this.id);
      if (item) {
        sentOne = true;
        await this.sendOne(this.sock, item);
      }
    } catch (e) {
      this.log.error("[%s] fila: %s", this.id, (e as Error).message);
    } finally {
      this.sending = false;
      // mensagem enviada: tenta a próxima logo (manuais saem em sequência; campanhas o banco segura)
      this.kickSender(sentOne ? 250 : undefined);
    }
  }

  private async resolveJid(sock: SocketLike, phone: string): Promise<string | null> {
    for (const cand of phoneCandidates(phone)) {
      const r = await sock.onWhatsApp(cand);
      const hit = r?.find((x) => x.exists);
      if (hit) return hit.jid;
    }
    return null;
  }

  private async sendOne(sock: SocketLike, item: OutItem) {
    let jid: string | null = null;
    try {
      jid = await this.resolveJid(sock, item.phone);
      if (!jid) {
        await this.db.result(item.id, { ok: false, invalid: true, error: "Este número não tem WhatsApp" });
        return;
      }
      if (this.opts.typing && sock.sendPresenceUpdate) {
        await sock.presenceSubscribe?.(jid).catch(() => {});
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await sleep(typingMs(item.body || "arquivo"));
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});
      }
      const res = await sock.sendMessage(jid, messageContent(item));
      await this.db.result(item.id, { ok: true, waMessageId: res?.key?.id ?? undefined, jid });
      this.log.info("[%s] enviado (%s)", this.id, item.source);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.log.warn("[%s] falha ao enviar (%s): %s", this.id, item.source, msg);
      await this.db.result(item.id, { ok: false, error: msg, retry: isTransient(e), jid: jid ?? undefined })
        .catch((err) => this.log.error("[%s] result: %s", this.id, err.message));
    }
  }

  async stop(opts: { logout?: boolean } = {}) {
    this.stopped = true;
    this.open = false;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const s = this.sock;
    this.sock = null;
    if (s) {
      if (opts.logout) await s.logout?.().catch(() => {});
      try { s.end(undefined); } catch { /* já fechado */ }
    }
    if (opts.logout) await this.clearAuth();
    await this.db.updateInstance(this.id, "disconnected").catch(() => {});
  }

  private async clearAuth() {
    await fs.rm(this.authDir, { recursive: true, force: true }).catch(() => {});
  }
}
