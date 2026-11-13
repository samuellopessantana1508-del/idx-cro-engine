// Tela: "Conectar WhatsApp Oficial" com o popup da Meta simulado (SDK falso + Graph API simulada na 11996).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/wa-embedded-ui";
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const WABA = `31${TAG}`, PNID = `41${TAG}`, TOKEN = `EAAB-ui-${TAG}`;
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
sql(`delete from whatsapp_instances where tenant_id = '${A}' and provider = 'cloud_api'`);

const graph = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/v[\d.]+\//, "/");
    const reply = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    if (p === "/oauth/access_token") return url.searchParams.get("code") === "codigo-ui" ? reply(200, { access_token: TOKEN }) : reply(400, { error: { code: 100, message: "bad code" } });
    if (p === "/debug_token") return reply(200, { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }] } });
    if (p === `/${WABA}/phone_numbers`) return reply(200, { data: [{ id: PNID }] });
    if (p === `/${PNID}/register`) return reply(200, { success: true });
    if (p === `/${PNID}`) return reply(200, { display_phone_number: "+55 11 3333-4444", verified_name: "Douratto Buffet", quality_rating: "GREEN" });
    if (p === `/${WABA}/subscribed_apps`) return reply(200, { success: true });
    if (p === `/${WABA}/message_templates`) return reply(200, { data: [] });
    reply(404, { error: { code: 100, message: p } });
  });
});
await new Promise((r) => graph.listen(11996, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0, passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("ok   -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 4).join("\n       ")); }
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
// SDK do Facebook falso: o popup "conclui" e devolve o código
await ctx.addInitScript(() => {
  window.__fbCalls = [];
  window.FB = {
    init: (o) => window.__fbCalls.push(["init", o]),
    login: (cb, o) => { window.__fbCalls.push(["login", o]); setTimeout(() => cb({ authResponse: window.__fbCancel ? null : { code: "codigo-ui" }, status: "connected" }), 300); },
  };
});
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));

await step("login e abrir WhatsApp → Conexão → API oficial", async () => {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill("dono@clinica.local");
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /^Entrar$/ }).click();
  await page.locator(".sidebar").waitFor();
  await page.goto(`${APP}/?section=whatsapp`);
  await page.getByRole("button", { name: /^Conexão$/ }).first().click();
  await page.locator(".wa-opt", { hasText: "API oficial" }).click();
  await page.getByRole("button", { name: "Conectar WhatsApp Oficial" }).waitFor();
  await page.getByText("Escolha o Business Manager do cliente").waitFor();
  await page.screenshot({ path: `${SHOTS}/01-antes.png` });
});

await step("fechar a janela da Meta sem concluir avisa e não conecta", async () => {
  await page.evaluate(() => { window.__fbCancel = true; });
  await page.getByRole("button", { name: "Conectar WhatsApp Oficial" }).click();
  await page.locator(".toast", { hasText: "fechada antes de concluir" }).waitFor();
  await page.evaluate(() => { window.__fbCancel = false; });
});

await step("concluir na Meta conecta o número e mostra o resultado", async () => {
  await page.getByRole("button", { name: "Conectar WhatsApp Oficial" }).click();
  await page.locator(".toast", { hasText: "WhatsApp oficial conectado" }).waitFor({ timeout: 15000 });
  await page.getByText(/API oficial conectada/).waitFor();
  await page.getByText(/Conectado pelo Facebook/).waitFor();
  await page.getByText(/Recebimento de mensagens ligado automaticamente/).waitFor();
  const opts = await page.evaluate(() => window.__fbCalls.find((c) => c[0] === "login")[1]);
  if (opts.config_id !== "987654321" || opts.response_type !== "code" || opts.extras?.sessionInfoVersion !== "3") throw new Error(JSON.stringify(opts));
  if (sql(`select source from wa_cloud_credentials c join whatsapp_instances i on i.id = c.instance_id where i.tenant_id = '${A}'`) !== "embedded") throw new Error("não gravou");
  await page.screenshot({ path: `${SHOTS}/02-conectado.png` });
});

await step("sem erros no console", async () => { if (errors.length) throw new Error(errors.slice(0, 5).join("\n")); });

await browser.close();
graph.close();
console.log(`\n${passed} ok, ${failed} falha(s) — telas em ${SHOTS}`);
process.exit(failed ? 1 : 0);
