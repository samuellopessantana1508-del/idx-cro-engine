// Extensão do WhatsApp Web, carregada num Chrome de verdade, sobre uma página
// que imita o cabeçalho de conversa do WhatsApp (stack LOCAL).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
const phone = `55319${String(70000000 + TAG).padStart(8, "0")}`;
sql(`insert into crm_contacts(tenant_id, name, phone) values ('${A}', 'Drogaria Extensão ${TAG}', '${phone}')`);

const extDir = mkdtempSync(join(tmpdir(), "idx-ext-"));
execFileSync("node", [join(HERE, "../../scripts/build-extension.mjs"), "--dir", extDir, "--out", join(extDir, "x.zip"), "--test-match", "http://127.0.0.1:5199/*"], { stdio: "inherit" });
const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(readFileSync(join(HERE, "wa-mock.html"))); });
await new Promise((r) => server.listen(5199, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "idx-prof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, viewport: { width: 1400, height: 900 },
  args: ["--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log("ok   -", name); } catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n")[0]); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("tempo esgotado"); await pause(250); } }

try {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:5199/?chat=${encodeURIComponent("+55 31 9" + phone.slice(5, 9) + "-" + phone.slice(9))}`);
  const panel = page.locator("#idx-crm-host");

  await step("painel aparece e pede login", async () => {
    await panel.locator("text=Entrar no CRM").waitFor({ timeout: 15000 });
    const shrunk = await page.evaluate(() => getComputedStyle(document.getElementById("app")).width);
    if (!shrunk.endsWith("px") || Number.parseFloat(shrunk) > 1400 - 300) throw new Error(`WhatsApp não abriu espaço para o painel: ${shrunk}`);
  });

  await step("login com o usuário do CRM e acha o cliente pelo telefone do cabeçalho", async () => {
    await panel.locator('input[type="email"]').fill("dono@clinica.local");
    await panel.locator('input[type="password"]').fill("Teste@12345");
    await panel.locator("button", { hasText: "Entrar" }).click();
    const picker = panel.locator("select").first();
    await until(async () => (await panel.locator(`text=Drogaria Extensão ${TAG}`).count()) || (await picker.count()));
    if (!(await panel.locator(`text=Drogaria Extensão ${TAG}`).count())) {
      await picker.selectOption({ label: "Clínica Sorriso" });
    }
    await panel.locator("h3", { hasText: `Drogaria Extensão ${TAG}` }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: "/tmp/ext-painel.png" });
  });

  await step("registrar com IA (ou regras) cria negociação e retorno após confirmar", async () => {
    await panel.locator("textarea").fill("quer proposta de 900 reais, retornar amanhã às 11h");
    await panel.locator("button", { hasText: "Registrar com IA" }).click();
    await panel.locator("button", { hasText: "Confirmar e salvar" }).click({ timeout: 15000 });
    await panel.locator("text=Registrado no CRM").waitFor();
    const r = sql(`select d.value || '|' || to_char(t.due_at at time zone 'America/Sao_Paulo','HH24:MI') from crm_contacts c join crm_deals d on d.contact_id = c.id join crm_tasks t on t.contact_id = c.id where c.phone = '${phone}' and t.status = 'open' order by t.created_at desc limit 1`);
    if (r !== "900.00|11:00") throw new Error(`gravado: ${r}`);
  });

  await step("retorno rápido 'em 3 dias' vira tarefa às 9h", async () => {
    await panel.locator("button", { hasText: "em 3 dias" }).click();
    await panel.locator("text=Retorno agendado").waitFor();
    const n = sql(`select count(*) from crm_tasks t join crm_contacts c on c.id = t.contact_id where c.phone = '${phone}' and to_char(t.due_at at time zone 'America/Sao_Paulo','HH24:MI') = '09:00' and (t.due_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date + 3`);
    if (n !== "1") throw new Error(`tarefas: ${n}`);
  });

  await step("trocar de conversa para alguém fora do CRM e cadastrar em 1 clique", async () => {
    await page.evaluate((n) => window.openChat(n), `Farmácia Nova ${TAG}`);
    await panel.locator("text=Cliente não encontrado").waitFor({ timeout: 8000 });
    await panel.locator('input[placeholder="Telefone com DDD"]').fill(`31 3${String(TAG).padStart(3, "0").slice(-3)}2-4455`);
    await panel.locator("button", { hasText: "Cadastrar no CRM" }).click();
    await panel.locator("text=Cliente cadastrado").waitFor();
    if (sql(`select count(*) from crm_contacts where name = 'Farmácia Nova ${TAG}' and tenant_id = '${A}'`) !== "1") throw new Error("não cadastrou");
  });

  await step("a extensão não guarda chave de administrador", async () => {
    const cfg = readFileSync(join(extDir, "config.js"), "utf8");
    const service = JSON.parse(readFileSync("/opt/stack/gw/keys.json", "utf8")).service;
    if (cfg.includes(service)) throw new Error("service role dentro da extensão!");
  });

  if (errors.length) { failed++; console.log("FAIL - erros na página:", errors); }
} finally {
  await ctx.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n# ${failed} falha(s)` : "\n# extensão OK");
process.exit(failed ? 1 : 0);
