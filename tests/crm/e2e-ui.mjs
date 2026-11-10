// Teste de interface do CRM, ponta a ponta, contra a stack LOCAL (nunca produção).
// Pré-requisitos: scripts/local-stack/reset-db.sh + /opt/stack/start.sh + tests/crm/seed-local.mjs
// e o painel rodando: (cd web && npx vite --host 127.0.0.1 --port 5173) com .env.local apontando para a stack local.
// Uso: node tests/crm/e2e-ui.mjs   (variáveis opcionais: APP_URL, CHROME_PATH, PGURL, SHOTS)
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/crm-e2e";
if (!/127\.0\.0\.1|localhost/.test(APP)) throw new Error("e2e-ui só roda contra ambiente local");
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const PASSWORD = "Teste@12345";
const stamp = Date.now().toString().slice(-6);
const NAME = `Cliente E2E ${stamp}`;
const PHONE_DIGITS = `1197${stamp.slice(0, 3)}${stamp.slice(3)}0`.slice(0, 11);
const PHONE_FMT = `(${PHONE_DIGITS.slice(0, 2)}) ${PHONE_DIGITS.slice(2, 7)}-${PHONE_DIGITS.slice(7)}`;
const DEAL = `Implante E2E ${stamp}`;

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(["ok", name, Date.now() - t]); console.log(`ok   - ${name}`); }
  catch (e) { results.push(["FAIL", name, Date.now() - t]); console.log(`FAIL - ${name}\n       ${String(e.message).split("\n")[0]}`); throw e; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const pageErrors = [];
async function newPage(viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}
async function login(page, email) {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /Entrar/ }).first().click();
  await page.locator(".sidebar").waitFor();
  await page.waitForTimeout(800);
}
const nav = (page, label) => page.locator(".sidebar").getByRole("button", { name: label, exact: true }).click();
const toast = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor({ timeout: 8000 });
const column = (page, stage) => page.locator(".crm-col").filter({ has: page.locator(".crm-col-head strong", { hasText: new RegExp(`^${stage}$`) }) });

let failed = false;
try {
  const page = await newPage();
  await step("login do administrador da empresa", () => login(page, "dono@clinica.local"));

  await step("criar contato pelo botão Novo contato (telefone normalizado com DDI)", async () => {
    await nav(page, "Contatos");
    await page.getByRole("button", { name: "Novo contato" }).click();
    const modal = page.locator(".crm-modal");
    await modal.locator("label", { hasText: /^Nome/ }).locator("input").fill(NAME);
    await modal.locator("label", { hasText: "Telefone / WhatsApp" }).locator("input").fill(PHONE_FMT);
    await modal.locator("label", { hasText: "E-mail" }).locator("input").fill(`e2e${stamp}@exemplo.com`);
    await modal.getByRole("button", { name: "Salvar", exact: true }).click();
    await toast(page, /Contato cadastrado/);
    const phone = sql(`select phone from crm_contacts where name = '${NAME}'`);
    assert.equal(phone, `55${PHONE_DIGITS}`);
  });

  await step("duplicidade: mesmo telefone em outro formato é sinalizado", async () => {
    await page.getByRole("button", { name: "Novo contato" }).click();
    const modal = page.locator(".crm-modal");
    await modal.locator("label", { hasText: "Telefone / WhatsApp" }).locator("input").fill(`+55 ${PHONE_DIGITS}`);
    await modal.locator("label", { hasText: "E-mail" }).locator("input").click();
    await modal.locator(".crm-callout.warn", { hasText: "Possível duplicado" }).waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  await step("recarregar a página mantém a tela e o contato", async () => {
    await page.reload();
    await page.locator(".crm-table").waitFor();
    assert.match(page.url(), /crm=contacts/);
    await page.locator(".crm-table tr", { hasText: NAME }).waitFor();
  });

  await step("criar negociação ligada ao contato (busca no seletor)", async () => {
    await nav(page, "Negociações");
    await page.getByRole("button", { name: "Nova negociação" }).click();
    const modal = page.locator(".crm-modal");
    await modal.locator(".crm-picker input").fill(NAME.slice(0, 14));
    await modal.locator(".crm-menu button", { hasText: NAME }).click();
    await modal.locator("label", { hasText: "Nome da negociação" }).locator("input").fill(DEAL);
    await modal.locator("label", { hasText: "Valor estimado" }).locator("input").fill("2.500,00");
    await modal.getByRole("button", { name: "Criar negociação" }).click();
    await toast(page, /Negociação criada/);
    await page.locator(".crm-drawer").waitFor();
    await page.keyboard.press("Escape");
    const row = sql(`select d.value || '|' || s.name || '|' || (d.contact_id is not null) from crm_deals d join crm_stages s on s.id = d.stage_id where d.title = '${DEAL}'`);
    assert.equal(row, "2500.00|Novo lead|true");
  });

  await step("arrastar o card para “Contato realizado” persiste no banco e no histórico", async () => {
    const card = column(page, "Novo lead").locator(".crm-card", { hasText: DEAL });
    await card.waitFor();
    await card.dragTo(column(page, "Contato realizado").locator(".crm-col-body"));
    await toast(page, /Movida para Contato realizado/);
    await page.waitForTimeout(400);
    assert.equal(sql(`select s.name from crm_deals d join crm_stages s on s.id = d.stage_id where d.title = '${DEAL}'`), "Contato realizado");
    assert.ok(Number(sql(`select count(*) from crm_deal_stage_history h join crm_deals d on d.id = h.deal_id where d.title = '${DEAL}'`)) >= 1);
  });

  await step("após recarregar, o card continua na nova etapa", async () => {
    await page.reload();
    await column(page, "Contato realizado").locator(".crm-card", { hasText: DEAL }).waitFor();
  });

  await step("agendar atividade pela negociação e concluí-la na Minha rotina", async () => {
    await column(page, "Contato realizado").locator(".crm-card", { hasText: DEAL }).click();
    const drawer = page.locator(".crm-drawer");
    await drawer.getByRole("button", { name: "Agendar atividade" }).click();
    const modal = page.locator(".crm-modal");
    await modal.getByRole("button", { name: "Ligação", exact: true }).click();
    await modal.locator("label", { hasText: "Título" }).locator("input").fill(`Ligar E2E ${stamp}`);
    await modal.getByRole("button", { name: "Salvar", exact: true }).click();
    await toast(page, /Tarefa criada/);
    await page.keyboard.press("Escape");
    await nav(page, "Minha rotina");
    const task = page.locator(".crm-task", { hasText: `Ligar E2E ${stamp}` });
    await task.waitFor();
    await task.locator(".crm-task-check").click();
    await toast(page, /Tarefa concluída/);
    await page.waitForTimeout(300);
    assert.equal(sql(`select status from crm_tasks where title = 'Ligar E2E ${stamp}'`), "done");
  });

  await step("ganhar a negociação registra venda com evidência (receita rastreável)", async () => {
    await nav(page, "Negociações");
    await column(page, "Contato realizado").locator(".crm-card", { hasText: DEAL }).click();
    await page.locator(".crm-stagebar-end button", { hasText: "Venda ganha" }).click();
    const modal = page.locator(".crm-modal");
    await modal.getByRole("button", { name: "Registrar venda" }).click();
    await toast(page, /Venda de R\$/);
    await page.waitForTimeout(400);
    assert.equal(sql(`select o.status || '|' || o.net_amount || '|' || o.evidence_type from crm_orders o join crm_deals d on d.id = o.deal_id where d.title = '${DEAL}'`), "paid|2500.00|payment");
    assert.equal(sql(`select status from crm_deals where title = '${DEAL}'`), "won");
    await page.keyboard.press("Escape");
  });

  await step("RFV recalculado inclui o novo cliente (somente venda válida)", async () => {
    await nav(page, "Clientes e RFV");
    await page.getByRole("button", { name: "Recalcular" }).click();
    await toast(page, /RFV recalculado/);
    await page.locator(".crm-tabs button", { hasText: "Clientes" }).first().click();
    await page.locator(".crm-table tr", { hasText: NAME }).waitFor();
    assert.equal(sql(`select r.segment from crm_rfv_scores r join crm_contacts c on c.id = r.contact_id where c.name = '${NAME}'`), "new");
  });

  await step("busca global (Ctrl+K) abre a página completa do contato", async () => {
    await page.keyboard.press("Control+k");
    await page.locator(".crm-palette input").fill(NAME);
    await page.locator(".crm-palette-results button", { hasText: NAME }).first().waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".crm-record-head h2", { hasText: NAME }).waitFor();
    await page.locator(".crm-tabs button", { hasText: "Negociações" }).click();
    await page.locator(".crm-list li", { hasText: DEAL }).waitFor();
    await page.locator(".crm-tabs button", { hasText: "Compras" }).click();
    await page.locator(".crm-order", { hasText: "R$ 2.500,00" }).waitFor();
    await page.screenshot({ path: `${SHOTS}/contato.png` });
  });

  await step("anotação no histórico persiste após recarregar", async () => {
    await page.locator(".crm-tabs button", { hasText: "Histórico" }).click();
    await page.locator(".crm-composer textarea").fill(`Cliente pediu retorno em 30 dias (${stamp})`);
    await page.locator(".crm-composer").getByRole("button", { name: "Salvar" }).click();
    await toast(page, /Registrado no histórico/);
    await page.reload();
    await page.locator(".crm-timeline li", { hasText: `retorno em 30 dias (${stamp})` }).waitFor();
  });

  await step("lista de negociações + exportação respeitam os dados reais", async () => {
    await nav(page, "Negociações");
    await page.locator(".crm-segmented button", { hasText: "Lista" }).click();
    await page.locator(".crm-table tr", { hasText: DEAL }).waitFor();
    await page.locator(".crm-segmented button", { hasText: "Funil" }).click();
  });

  await step("indicadores e visão comercial carregam com dados do banco", async () => {
    await nav(page, "Indicadores");
    await page.locator(".crm-kpi", { hasText: "Receita confirmada" }).waitFor();
    await nav(page, "Visão comercial");
    await page.locator(".crm-stat", { hasText: "Em negociação" }).waitFor();
    await page.screenshot({ path: `${SHOTS}/visao-comercial.png` });
  });

  await step("vendedor vê menu enxuto e não acessa configurações", async () => {
    const p2 = await newPage();
    await login(p2, "ana.vendas@clinica.local");
    await p2.locator(".sidebar").getByRole("button", { name: "Minha rotina", exact: true }).waitFor();
    assert.equal(await p2.locator(".sidebar").getByRole("button", { name: "Configurações do CRM", exact: true }).count(), 0);
    await p2.goto(`${APP}/?section=crm-app&crm=settings`);
    await p2.locator(".crm-empty", { hasText: "Acesso restrito" }).waitFor();
    await p2.close();
  });

  await step("isolamento: outra empresa não encontra o contato criado", async () => {
    const p3 = await newPage();
    await login(p3, "dona@perfumaria.local");
    await p3.goto(`${APP}/?section=crm-app&crm=contacts`);
    await p3.locator(".crm-search input").fill(NAME);
    await p3.locator(".crm-empty", { hasText: "Nenhum contato encontrado" }).waitFor();
    await p3.close();
  });

  await step("celular: funil e contato utilizáveis em 390px", async () => {
    const m = await newPage({ width: 390, height: 844 });
    await login(m, "dono@clinica.local");
    await m.goto(`${APP}/?section=crm-app&crm=deals`);
    await m.locator(".crm-card").first().waitFor();
    await m.screenshot({ path: `${SHOTS}/mobile-negociacoes.png` });
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 2, `página com rolagem horizontal de ${overflow}px`);
    await m.close();
  });

  await step("nenhum erro de JavaScript na página durante o teste", async () => {
    assert.deepEqual(pageErrors, []);
  });
} catch {
  failed = true;
} finally {
  await browser.close();
  const ok = results.filter((r) => r[0] === "ok").length;
  console.log(`\n# ${ok}/${results.length} etapas ok${failed ? " — FALHOU" : ""} · screenshots em ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}
