// Teste de interface: etapas do funil editáveis no próprio Kanban + contraste no modo escuro.
// Pré-requisitos iguais ao e2e-ui.mjs (stack local + seed + vite em 127.0.0.1:5173).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { failed = true; console.log("FAIL", name, "-", e.message.split("\n")[0]); } };
const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const NEW = `Visita ${Date.now() % 100000}`;
const tenant = sql("select id from public.tenants where name ilike '%clínica%' or name ilike '%clinica%' limit 1");

try {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill("dono@clinica.local");
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /Entrar/ }).first().click();
  await page.locator(".sidebar").waitFor();
  await page.goto(`${APP}/?section=crm-app&crm=deals`);
  await page.locator(".crm-board").waitFor();
  await page.locator(".crm-col-head").first().waitFor();

  await step("nomes das etapas claros sobre a coluna escura", async () => {
    const r = await page.locator(".crm-col").first().evaluate((col) => ({
      bg: getComputedStyle(col).backgroundColor,
      name: getComputedStyle(col.querySelector(".crm-col-head strong")).color,
      sum: getComputedStyle(col.querySelector(".crm-col-head .sum")).color,
    }));
    if (lum(r.bg) > 0.3) throw new Error(`coluna não está escura: ${r.bg}`);
    if (lum(r.name) < 0.85 || lum(r.sum) < 0.85) throw new Error(`texto sem contraste: ${JSON.stringify(r)}`);
  });
  await page.screenshot({ path: `${SHOTS}/stages-dark.png` });

  await step("renomear etapa clicando no nome", async () => {
    const first = page.locator(".crm-col-name").first();
    const old = (await first.textContent()).trim();
    await first.click();
    const input = page.locator(".crm-col-rename input").first();
    await input.fill("Primeiro contato");
    await input.press("Enter");
    await page.locator(".crm-col-head strong", { hasText: /^Primeiro contato$/ }).waitFor({ timeout: 8000 });
    const db = sql(`select count(*) from public.crm_stages where tenant_id='${tenant}' and name='Primeiro contato' and archived_at is null`);
    if (db !== "1") throw new Error(`banco não salvou (${db}); antigo=${old}`);
  });

  await step("Esc cancela a edição sem salvar", async () => {
    await page.locator(".crm-col-name").first().click();
    const input = page.locator(".crm-col-rename input").first();
    await input.fill("Não deveria salvar");
    await input.press("Escape");
    await page.locator(".crm-col-head strong", { hasText: /^Primeiro contato$/ }).waitFor();
    if (sql(`select count(*) from public.crm_stages where name='Não deveria salvar'`) !== "0") throw new Error("salvou ao cancelar");
  });

  await step("criar nova etapa (antes de ganha/perdida)", async () => {
    await page.getByRole("button", { name: /Nova etapa/ }).click();
    await page.locator(".crm-col-new input").fill(NEW);
    await page.locator(".crm-col-new").getByRole("button", { name: "Criar" }).click();
    await page.locator(".crm-col-head strong", { hasText: new RegExp(`^${NEW}$`) }).waitFor({ timeout: 8000 });
    const order = sql(`select string_agg(kind, ',' order by position) from public.crm_stages s where pipeline_id=(select pipeline_id from public.crm_stages where name='${NEW}' and tenant_id='${tenant}') and archived_at is null`);
    const kinds = order.split(",");
    const lastOpen = kinds.lastIndexOf("open");
    if (kinds.slice(0, lastOpen + 1).some((k) => k !== "open")) throw new Error(`ordem errada: ${order}`);
    const vis = sql(`select position from public.crm_stages where name='${NEW}' and tenant_id='${tenant}' and archived_at is null`);
    if (Number(vis) !== lastOpen) throw new Error(`nova etapa não ficou como última em andamento: pos ${vis}, ordem ${order}`);
  });

  await step("mudar cor e apagar etapa vazia pelo menu", async () => {
    const col = page.locator(".crm-col").filter({ has: page.locator(".crm-col-head strong", { hasText: new RegExp(`^${NEW}$`) }) });
    await col.getByRole("button", { name: "Opções da etapa" }).click();
    await col.locator(".crm-col-pop .colors button").nth(3).click();
    await page.waitForTimeout(800);
    if (sql(`select color from public.crm_stages where name='${NEW}' and tenant_id='${tenant}' and archived_at is null`) !== "#f59e0b") throw new Error("cor não salva");
    await col.getByRole("button", { name: "Opções da etapa" }).click();
    await col.getByRole("button", { name: /Apagar etapa/ }).click();
    await page.locator(".crm-col-head strong", { hasText: new RegExp(`^${NEW}$`) }).waitFor({ state: "detached", timeout: 8000 });
    if (sql(`select count(*) from public.crm_stages where name='${NEW}' and archived_at is null`) !== "0") throw new Error("não arquivou");
  });

  await step("vendedor não vê edição de etapas", async () => {
    const p2 = await ctx.newPage();
    await ctx.clearCookies();
    await p2.evaluate(() => localStorage.clear()).catch(() => {});
    await p2.goto(APP);
    await p2.evaluate(() => localStorage.clear());
    await p2.reload();
    await p2.locator('input[type="email"]').first().fill("ana.vendas@clinica.local");
    await p2.locator('input[type="password"]').fill("Teste@12345");
    await p2.getByRole("button", { name: /Entrar/ }).first().click();
    await p2.locator(".sidebar").waitFor();
    await p2.goto(`${APP}/?section=crm-app&crm=deals`);
    await p2.locator(".crm-col-head").first().waitFor();
    if (await p2.locator(".crm-col-name, .crm-col-new").count()) throw new Error("vendedor consegue editar etapas");
  });

  if (errors.length) { failed = true; console.log("Erros de página:", errors); }
} finally {
  await browser.close();
}
console.log(failed ? "FALHOU" : "TUDO OK");
process.exit(failed ? 1 : 0);
