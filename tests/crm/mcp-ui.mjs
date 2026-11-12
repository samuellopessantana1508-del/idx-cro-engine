// Interface do conector MCP: criar token, copiar instruções, usar com o SDK oficial e ver o registro.
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
const SDK = process.env.MCP_SDK ?? "/tmp/mcpsdk/node_modules";
const { Client } = await import(`${SDK}/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${SDK}/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`);
const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const SHOTS = "/tmp/mcp-ui"; mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = []; let failed = 0, passed = 0;
let page;
async function step(name, fn) { try { await fn(); passed++; console.log("ok   -", name); } catch (e) { failed++; await page?.screenshot?.({ path: `${SHOTS}/fail-${passed + failed}.png` }).catch(() => {}); console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 3).join("\n       ")); } }
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill("ana.vendas@clinica.local");
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /Entrar/ }).first().click();
  await page.locator(".sidebar").waitFor();
  await page.locator(".nav-group-label", { hasText: /Meu dia/i }).waitFor();
  await page.waitForTimeout(800);
  let url;
  await step("vendedor cria token 'consultar e agir' e recebe as instruções", async () => {
    await page.locator(".sidebar").getByRole("button", { name: "Claude e IA (MCP)" }).first().click();
    await page.getByText("Use o CRO dentro do Claude").waitFor();
    await page.getByRole("button", { name: "Conectar ao Claude" }).click();
    const m = page.locator(".crm-modal");
    await m.getByText("Consultar e agir").click();
    await m.getByRole("button", { name: "Criar token" }).click();
    await page.getByText("Token criado — copie agora").waitFor();
    url = (await page.locator(".mcp-copy code").first().innerText()).trim();
    if (!/\/functions\/v1\/cro-mcp\/cro_[a-f0-9]{64}$/.test(url)) throw new Error("endereço inesperado: " + url);
    await page.locator(".mcp-copy").first().getByRole("button", { name: /Copiar/ }).click();
    await page.locator(".mcp-copy").first().getByText("Copiado").waitFor();
    await page.screenshot({ path: `${SHOTS}/1-token.png` });
    const ov = await page.locator(".crm-modal-body").evaluate((el) => el.scrollWidth - el.clientWidth);
    if (ov > 2) throw new Error(`janela rola para o lado (${ov}px)`);
    await page.getByRole("button", { name: "Já copiei" }).click();
    await page.locator("tbody tr").filter({ hasText: "Leitura e ações" }).first().waitFor();
  });
  await step("Claude (SDK oficial) conecta com o endereço e usa o CRO; a tela mostra a ação", async () => {
    const c = new Client({ name: "claude-teste", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url.replace(/^https?:\/\/[^/]+/, "http://127.0.0.1:54321"))));
    const r = await c.callTool({ name: "resumo_comercial", arguments: {} });
    if (r.isError) throw new Error(r.content[0].text);
    await c.close();
    await page.reload();
    await page.getByText("Últimas ações da IA").waitFor();
    await page.locator("tbody tr").filter({ hasText: "resumo_comercial" }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/2-uso.png` });
  });
  await step("revogar corta o acesso na hora", async () => {
    const row = page.locator("tbody tr").filter({ hasText: "Leitura e ações" }).first();
    await row.getByTitle("Revogar").click();
    await page.locator(".crm-modal").getByRole("button", { name: "Revogar" }).click();
    await page.locator(".toast").filter({ hasText: "Token revogado" }).first().waitFor();
    const res = await fetch(url.replace(/^https?:\/\/[^/]+/, "http://127.0.0.1:54321"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    if (res.status !== 401) throw new Error("esperava 401, veio " + res.status);
  });
} finally { await browser.close(); }
if (errors.length) { console.log("Erros de página:", errors); failed++; }
console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
