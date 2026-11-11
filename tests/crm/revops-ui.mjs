// Interface: cadências, metas, assistente por voz/texto e discador (stack LOCAL + vite em 127.0.0.1:5173).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/revops";
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0, passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("ok   -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 3).join("\n       ")); }
}
async function login(page, email) {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /Entrar/ }).first().click();
  await page.locator(".sidebar").waitFor();
  await page.waitForTimeout(600);
}
const toast = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor({ timeout: 10000 });
const go = (page, crm) => page.goto(`${APP}/?section=crm-app&crm=${crm}`).then(() => page.locator(".crm-page").first().waitFor());

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "dono@clinica.local");

  // contato para a cadência
  const contactPhone = `55119${String(80000000 + TAG).padStart(8, "0")}`;
  sql(`insert into crm_contacts(tenant_id, name, phone) values ('${A}', 'Bianca Teste ${TAG}', '${contactPhone}')`);

  await step("cadência sugerida: criar e ver os 4 passos", async () => {
    // banco local de teste: começa sem cadências para exercitar a sugestão
    sql(`update crm_cadences set archived_at = now(), active = false where tenant_id = '${A}' and archived_at is null`);
    await go(page, "cadences");
    await page.locator(".crm-cad-card, .crm-empty").first().waitFor();
    const sug = page.getByRole("button", { name: "Começar com a sugerida" });
    if (await sug.count()) await sug.click(); else await page.getByRole("button", { name: /Nova cadência/ }).click();
    const name = page.locator(".crm-modal input").first();
    await name.fill(`Prospecção ${TAG}`);
    if (!(await page.locator(".crm-cad-edit-row").count() >= 4)) throw new Error("passos sugeridos não carregaram");
    await page.getByRole("button", { name: "Salvar cadência" }).click();
    await toast(page, /Cadência salva/);
    const card = page.locator(".crm-cad-card").filter({ hasText: `Prospecção ${TAG}` });
    await card.waitFor();
    if ((await card.locator(".crm-cad-step").count()) !== 4) throw new Error("card sem 4 passos");
  });

  await step("inscrever contato pela busca", async () => {
    const card = page.locator(".crm-cad-card").filter({ hasText: `Prospecção ${TAG}` });
    await card.getByRole("button", { name: /Inscrever contatos/ }).click();
    await page.locator(".crm-modal .crm-search input").fill(`Bianca Teste ${TAG}`);
    await page.locator(".crm-pick-list button").first().click();
    await page.locator(".crm-modal").getByRole("button", { name: /^Inscrever/ }).click();
    await toast(page, /1 contato\(s\) na cadência/);
  });

  await step("tarefa da cadência: botão Ligar; concluir gera WhatsApp com texto pronto", async () => {
    await go(page, "tasks");
    const row = page.locator(".crm-task").filter({ hasText: `Bianca Teste ${TAG}` }).first();
    await row.waitFor();
    const tel = await row.locator("a.crm-btn.call").getAttribute("href");
    if (tel !== `tel:+${contactPhone}`) throw new Error(`link de ligação errado: ${tel}`);
    await row.locator(".crm-task-check").click();
    await toast(page, /Tarefa concluída/);
    await page.waitForTimeout(800);
    await page.reload(); await page.locator(".crm-page").first().waitFor();
    const wa = page.locator(".crm-task").filter({ hasText: `Bianca Teste ${TAG}` }).filter({ has: page.locator("a.crm-btn.wa") }).first();
    await wa.waitFor({ timeout: 8000 });
    const href = await wa.locator("a.crm-btn.wa").getAttribute("href");
    if (!href.startsWith(`https://wa.me/${contactPhone}?text=`) || !decodeURIComponent(href).includes("Oi Bianca")) throw new Error(`link do WhatsApp: ${href}`);
    if (!(await wa.locator(".crm-task-template").textContent()).includes("Oi Bianca")) throw new Error("texto pronto não aparece");
  });
  await page.screenshot({ path: `${SHOTS}/tarefas-cadencia.png` });

  await step("cadência aparece no contato, com opção de encerrar", async () => {
    const id = sql(`select id from crm_contacts where phone = '${contactPhone}'`);
    await page.goto(`${APP}/?section=crm-app&crm=contact&contact=${id}`);
    await page.locator(".crm-cad-contact .crm-chip", { hasText: `Prospecção ${TAG}` }).waitFor();
  });

  await step("metas: criar meta de ligações e ver na Visão comercial", async () => {
    await go(page, "goals");
    await page.getByRole("button", { name: /Nova meta|Criar primeira meta/ }).first().click();
    await page.locator(".crm-modal select").first().selectOption("calls");
    await page.locator('.crm-modal input[inputmode="decimal"]').fill("200");
    await page.locator(".crm-modal input").last().fill(`Ligações do mês ${TAG}`);
    await page.getByRole("button", { name: "Salvar meta" }).click();
    await toast(page, /Meta salva/);
    await page.locator(".crm-goal", { hasText: `Ligações do mês ${TAG}` }).waitFor();
    await page.screenshot({ path: `${SHOTS}/metas.png` });
    await go(page, "home");
    await page.locator(".crm-goal-mini .crm-goal").first().waitFor();
  });

  await step("assistente por texto: entende, mostra para conferir e grava", async () => {
    await page.getByRole("button", { name: /^Registrar$/ }).first().click();
    await page.locator(".crm-assist textarea").fill(`Falei com o Rafael da Drogaria Sol ${TAG}, telefone 31 98888-${String(TAG).padStart(4, "0").slice(-4)}, quer proposta de 1.200 reais, ligar amanhã às 10h`);
    await page.getByRole("button", { name: /Entender/ }).click();
    await page.getByText("Confira antes de salvar").waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/assistente-revisao.png` });
    const value = await page.locator('.crm-assist-block input[inputmode="decimal"]').inputValue();
    if (value !== "1200") throw new Error(`valor entendido: ${value}`);
    await page.getByRole("button", { name: "Salvar no CRM" }).click();
    await toast(page, /Registrado no CRM/);
    const row = sql(`select ct.name || '|' || co.name || '|' || d.value from crm_contacts ct join crm_companies co on co.id = ct.company_id join crm_deals d on d.contact_id = ct.id where co.name = 'Drogaria Sol ${TAG}'`);
    if (row !== `Rafael|Drogaria Sol ${TAG}|1200.00`) throw new Error(`gravado: ${row}`);
    const due = sql(`select to_char(t.due_at at time zone 'America/Sao_Paulo', 'HH24:MI') from crm_tasks t join crm_contacts ct on ct.id = t.contact_id join crm_companies co on co.id = ct.company_id where co.name = 'Drogaria Sol ${TAG}'`);
    if (due !== "10:00") throw new Error(`tarefa às ${due}`);
  });

  // ----- celular: discador com "Contar como foi" -----
  const LIST = `UI voz ${TAG}`;
  sql(`insert into crm_dial_leads(tenant_id, list_name, name, phone, city, uf, status, called_at, call_count) values ('${A}', '${LIST}', 'Farmácia Voz ${TAG}', '5531${String(30000000 + TAG).padStart(8, "0")}', 'Betim', 'MG', 'called', now(), 1)`);
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const mp = await m.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await step("celular: 'Contar como foi' no discador registra retorno com horário", async () => {
    await login(mp, "dono@clinica.local");
    await mp.evaluate((l) => localStorage.setItem("crm.dial.list", l), LIST);
    await go(mp, "dialer");
    await mp.locator(".dial-tabs button", { hasText: "Já liguei" }).click();
    const row = mp.locator(".dial-row", { hasText: `Farmácia Voz ${TAG}` });
    await row.waitFor();
    await row.getByRole("button", { name: /Contar como foi/ }).click();
    await mp.locator(".crm-assist-mic, .crm-assist textarea").first().waitFor();
    await mp.screenshot({ path: `${SHOTS}/celular-voz.png` });
    await mp.locator(".crm-assist textarea").fill("falei com a gerente, achou caro, pediu para ligar sexta às 15h");
    await mp.getByRole("button", { name: /Entender/ }).click();
    await mp.getByText("Confira antes de salvar").waitFor({ timeout: 15000 });
    const on = await mp.locator(".crm-assist-block .crm-chip.on").first().textContent();
    if (on.trim() !== "Retornar") throw new Error(`resultado sugerido: ${on}`);
    await mp.screenshot({ path: `${SHOTS}/celular-voz-revisao.png` });
    await mp.getByRole("button", { name: "Salvar no CRM" }).click();
    await toast(mp, /Registrado no CRM/);
    await row.locator(".dial-done-label", { hasText: "Retornar" }).waitFor();
    const r = sql(`select l.outcome || '|' || l.objection || '|' || extract(isodow from t.due_at at time zone 'America/Sao_Paulo') || '|' || to_char(t.due_at at time zone 'America/Sao_Paulo','HH24:MI')
                   from crm_dial_leads l join crm_tasks t on t.contact_id = l.contact_id where l.list_name = '${LIST}'`);
    if (r !== "callback|Preço / orçamento|5|15:00") throw new Error(`gravado: ${r}`);
  });
  await step("celular: telas de cadências e metas usáveis em 390px", async () => {
    await go(mp, "cadences");
    await mp.locator(".crm-cad-card").first().waitFor();
    await mp.screenshot({ path: `${SHOTS}/celular-cadencias.png`, fullPage: true });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) throw new Error(`rolagem horizontal de ${overflow}px`);
    await go(mp, "goals");
    await mp.locator(".crm-goal").first().waitFor();
    await mp.screenshot({ path: `${SHOTS}/celular-metas.png`, fullPage: true });
  });

  await step("vendedor: não cria cadência nem meta, mas inscreve e registra", async () => {
    const s = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const sp = await s.newPage();
    await login(sp, "ana.vendas@clinica.local");
    await go(sp, "cadences");
    await sp.locator(".crm-cad-card").first().waitFor();
    if (await sp.getByRole("button", { name: /Nova cadência/ }).count()) throw new Error("vendedor vê Nova cadência");
    if (!(await sp.getByRole("button", { name: /Inscrever contatos/ }).count())) throw new Error("vendedor não consegue inscrever");
    await go(sp, "goals");
    await sp.locator(".crm-goal").first().waitFor();
    if (await sp.getByRole("button", { name: /Nova meta/ }).count()) throw new Error("vendedor vê Nova meta");
    if (!(await sp.getByRole("button", { name: /^Registrar$/ }).count())) throw new Error("vendedor sem botão Registrar");
    await s.close();
  });

  if (errors.length) { failed++; console.log("FAIL - erros de JavaScript:", errors.slice(0, 5)); }
} finally {
  await browser.close();
}
console.log(`\n# ${passed} ok, ${failed} falha(s) · screenshots em ${SHOTS}`);
process.exit(failed ? 1 : 0);
