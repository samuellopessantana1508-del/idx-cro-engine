// Tela "Saúde do sistema" (depois de tests/crm/cro-cron.test.mjs ter rodado ao menos uma vez).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let failed = 0; const errors = [];
try {
  for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(APP);
    await page.locator('input[type="email"]').first().fill("dono@clinica.local");
    await page.locator('input[type="password"]').fill("Teste@12345");
    await page.getByRole("button", { name: /Entrar/ }).first().click();
    await page.locator(".sidebar, .mobile-tabbar, nav").first().waitFor();
    await page.goto(`${APP}/?section=crm-app&crm=settings&tab=health`);
    try {
      await page.getByText("Motor do CRO (VPS)").waitFor({ timeout: 15000 });
      await page.getByText(/Automações do CRM/).waitFor();
      await page.getByText(/Meta \(Facebook\/Instagram\)/).waitFor();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 2) throw new Error(`estouro de ${over}px`);
      await page.screenshot({ path: `/tmp/health-${name}.png`, fullPage: true });
      console.log("ok   -", name);
    } catch (e) { failed++; console.log("FAIL -", name, e.message.split("\n")[0]); }
    await ctx.close();
  }
} finally { await browser.close(); }
if (errors.length) { console.log(errors); failed++; }
console.log(failed ? `${failed} falha(s)` : "TUDO OK");
process.exit(failed ? 1 : 0);
