// Empacota a extensão "IDX CRM no WhatsApp Web" em um .zip para download no painel.
// Usa só dados públicos (endereço do Supabase + chave publishable/anon). Recusa
// chave de administrador (service role / secret).
//
// Uso: node scripts/build-extension.mjs [--out arquivo.zip] [--dir pasta] [--test-match URL]
//   variáveis: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_PUBLIC_APP_URL (ou web/.env.local)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension", "whatsapp-crm");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));

function env() {
  const out = { ...process.env };
  const file = join(ROOT, "web", ".env.local");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const E = env();
const url = (E.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const key = E.VITE_SUPABASE_ANON_KEY ?? "";
const app = (E.VITE_PUBLIC_APP_URL ?? "https://cro.sanmarfidelize.com").replace(/\/$/, "");
if (!url || !key) {
  console.warn("build-extension: VITE_SUPABASE_URL/ANON_KEY ausentes — extensão não gerada");
  process.exit(0);
}
// nunca empacotar chave administrativa
if (/^sb_secret_/.test(key)) throw new Error("build-extension: recusada chave secreta (sb_secret_)");
if (key.split(".").length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
    if (payload.role && payload.role !== "anon") throw new Error(`build-extension: chave com papel "${payload.role}" recusada`);
  } catch (e) { if (String(e.message).includes("recusada")) throw e; }
}

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const origin = new URL(url).origin;
manifest.host_permissions = [`${origin}/*`];
if (args["test-match"]) manifest.content_scripts[0].matches.push(args["test-match"]);

const files = {
  "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2)),
  "config.js": Buffer.from(readFileSync(join(SRC, "config.template.js"), "utf8")
    .replace("__SUPABASE_URL__", url).replace("__SUPABASE_ANON_KEY__", key).replace("__APP_URL__", app)),
  "background.js": readFileSync(join(SRC, "background.js")),
  "content.js": readFileSync(join(SRC, "content.js")),
  "icon16.png": readFileSync(join(SRC, "icon16.png")),
  "icon48.png": readFileSync(join(SRC, "icon48.png")),
  "icon128.png": readFileSync(join(SRC, "icon128.png")),
};

if (args.dir) {
  mkdirSync(args.dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(args.dir, name), data);
  console.log(`extensão (pasta) em ${args.dir}`);
}

// ---- zip (método "stored", sem compressão) ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  const folder = "idx-crm-whatsapp/";
  for (const [rawName, data] of entries) {
    const name = Buffer.from(folder + rawName);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const out = args.out ?? join(ROOT, "web", "public", "extensao", "idx-crm-whatsapp.zip");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(Object.entries(files)));
console.log(`extensão empacotada: ${out} (${manifest.version})`);
