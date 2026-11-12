import fs from "node:fs";
import { Db } from "./db.js";
import { Session, type Logger, type SocketFactory } from "./session.js";

/**
 * Supervisor: a cada poucos segundos compara o que o CRO pediu (desired_status)
 * com as conexões abertas e liga/desliga sessões. Uma sessão por número.
 */
export class Gateway {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private db: Db,
    private factory: SocketFactory,
    private sessionsDir: string,
    private log: Logger,
    private opts = { syncMs: 5000, pollMs: 3000, typing: true },
  ) {}

  session(id: string) { return this.sessions.get(id); }

  async sync() {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await this.db.instances();
      const wanted = new Set<string>();
      for (const inst of list) {
        if (inst.desired_status === "connected") {
          wanted.add(inst.id);
          if (!this.sessions.has(inst.id)) {
            const s = new Session(inst.id, this.db, this.factory, this.sessionsDir, this.log,
              { pollMs: this.opts.pollMs, typing: this.opts.typing });
            this.sessions.set(inst.id, s);
            this.log.info("[gateway] iniciando conexão %s", inst.id);
            await s.start();
          }
        } else if (this.sessions.has(inst.id)) {
          const s = this.sessions.get(inst.id)!;
          this.sessions.delete(inst.id);
          this.log.info("[gateway] %s conexão %s", inst.desired_status === "logout" ? "saindo da" : "pausando", inst.id);
          await s.stop({ logout: inst.desired_status === "logout" });
        } else if (inst.desired_status === "logout") {
          // sem sessão aberta: só apaga as credenciais salvas
          fs.rmSync(`${this.sessionsDir}/${inst.id}`, { recursive: true, force: true });
          await this.db.updateInstance(inst.id, "disconnected").catch(() => {});
        }
      }
      // conexão apagada no CRO
      for (const [id, s] of this.sessions) {
        if (!list.some((i) => i.id === id)) { this.sessions.delete(id); await s.stop(); }
      }
    } catch (e) {
      this.log.error("[gateway] sync: %s", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  start() {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.opts.syncMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) await s.stop();
    this.sessions.clear();
  }
}

/** Baileys de verdade */
export const baileysFactory: SocketFactory = async (authDir, _log) => {
  const baileys: any = await import("@whiskeysockets/baileys");
  const pino = (await import("pino")).default;
  const makeWASocket = baileys.default?.default ?? baileys.default ?? baileys.makeWASocket;
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
  let version: number[] | undefined;
  try { version = (await baileys.fetchLatestBaileysVersion()).version; } catch { /* usa a embutida */ }
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "warn" }),
    browser: baileys.Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,      // não aparece "online" o tempo todo
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  return { sock, saveCreds };
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (isMain) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) { console.error(`Variável ${k} ausente`); process.exit(1); }
    return v;
  };
  const url = need("SUPABASE_URL");
  const anon = need("SUPABASE_ANON_KEY");
  const token = need("GATEWAY_TOKEN");
  const dir = process.env.SESSIONS_DIR || "/data/sessions";
  fs.mkdirSync(dir, { recursive: true });
  const log: Logger = {
    info: (...a) => console.log(new Date().toISOString(), ...a),
    warn: (...a) => console.warn(new Date().toISOString(), ...a),
    error: (...a) => console.error(new Date().toISOString(), ...a),
  };
  const gw = new Gateway(new Db(url, anon, token), baileysFactory, dir, log);
  gw.start();
  log.info("[gateway] motor de WhatsApp do IDX iniciado");
  const shutdown = async () => { log.info("[gateway] encerrando…"); await gw.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("unhandledRejection", (e) => log.error("[gateway] unhandledRejection", e));
}
