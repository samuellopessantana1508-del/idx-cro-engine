// Telas das duas conexões do WhatsApp (QR Code x API oficial). Stack LOCAL + vite 127.0.0.1:5173.
// Rode depois de tests/flows/wa-cloud.test.mjs (que deixa a API oficial da Perfumaria configurada).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/wa-cloud-ui";
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const B = sql(`select id from tenants where slug = 'perfumaria-aroma'`);
if (sql(`select count(*) from whatsapp_instances where tenant_id = '${B}' and provider = 'cloud_api' and status = 'connected'`) === "0") {
  console.log("Rode antes: node --test tests/flows/wa-cloud.test.mjs"); process.exit(1);
}
sql(`insert into wa_channel_settings (tenant_id, active_provider) values ('${B}', 'gateway') on conflict (tenant_id) do update set active_provider = 'gateway'`);
sql(`update whatsapp_instances set status = 'disconnected' where tenant_id = '${B}' and provider = 'gateway'`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0, passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("ok   -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 4).join("\n       ")); }
}
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("google-ads")) errors.push(`${r.status()} ${r.url().slice(0, 100)}`); });

await step("login da dona da Perfumaria", async () => {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill("dona@perfumaria.local");
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /Entrar/ }).first().click();
  await page.locator(".sidebar").waitFor();
});

await step("WhatsApp → Conexão mostra as duas opções; QR em uso", async () => {
  await page.goto(`${APP}/?section=whatsapp`);
  await page.getByRole("button", { name: /^Conexão$/ }).first().click();
  await page.locator(".wa-opt").first().waitFor();
  if ((await page.locator(".wa-opt").count()) !== 2) throw new Error("esperava 2 opções");
  await page.locator(".wa-opt.active", { hasText: "QR Code" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/01-opcoes.png` });
});

await step("API oficial: detalhes, webhook e modelos", async () => {
  await page.locator(".wa-opt", { hasText: "API oficial" }).click();
  await page.getByText("API oficial conectada").waitFor();
  await page.getByText("URL de retorno", { exact: true }).first().waitFor();
  await page.locator(".wa-tpl-list li", { hasText: "boas_vindas" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/02-oficial.png` });
});

await step("trocar para a API oficial (com confirmação)", async () => {
  await page.locator(".wa-opt", { hasText: "API oficial" }).getByRole("button", { name: "Usar esta conexão" }).click();
  await page.getByRole("button", { name: "Trocar conexão" }).click();
  await page.locator(".wa-opt.active", { hasText: "API oficial" }).waitFor();
  if (sql(`select active_provider from wa_channel_settings where tenant_id = '${B}'`) !== "cloud_api") throw new Error("não gravou");
  // QR não conectado: não dá para voltar
  const back = page.locator(".wa-opt", { hasText: "QR Code" }).getByRole("button", { name: "Usar esta conexão" });
  if (!(await back.isDisabled())) throw new Error("voltar para QR deveria estar bloqueado sem QR conectado");
});

await step("conversa fora da janela de 24 h pede modelo e envia", async () => {
  await page.getByRole("button", { name: /Conversas/ }).first().click();
  const items = page.locator(".wa-contact-item");
  await items.first().waitFor();
  const n = await items.count();
  let found = false;
  for (let i = 0; i < n && !found; i++) {
    await items.nth(i).click();
    await page.waitForTimeout(1500);
    found = (await page.locator(".wa-reply-tpl").count()) > 0;
  }
  if (!found) throw new Error("nenhuma conversa fora da janela");
  await page.locator(".wa-reply-tpl select").selectOption({ label: "boas_vindas (pt_BR)" });
  const inputs = page.locator(".wa-reply-tpl .wa-tpl-param input");
  await inputs.nth(0).fill("Lia"); await inputs.nth(1).fill("loja");
  await page.locator(".wa-reply-tpl .wa-bubble", { hasText: "Olá Lia! Temos novidades na loja." }).waitFor();
  const before = Number(sql(`select count(*) from wa_outbox where tenant_id = '${B}' and template is not null`));
  await page.getByRole("button", { name: "Enviar modelo" }).click();
  for (let i = 0; i < 20 && Number(sql(`select count(*) from wa_outbox where tenant_id = '${B}' and template is not null`)) === before; i++) await page.waitForTimeout(250);
  if (Number(sql(`select count(*) from wa_outbox where tenant_id = '${B}' and template is not null`)) !== before + 1) throw new Error("modelo não entrou na fila");
  await page.screenshot({ path: `${SHOTS}/03-janela.png` });
});

await step("novo disparo usa modelo aprovado", async () => {
  await page.goto(`${APP}/?section=crm-app&crm=dispatch`);
  await page.getByText("API oficial do WhatsApp ·").waitFor();
  await page.getByRole("button", { name: /Novo disparo/ }).first().click();
  await page.getByText("Modelo aprovado pela Meta", { exact: true }).waitFor();
  await page.locator(".crm-modal input").first().fill("Oficial UI");
  const save = page.getByRole("button", { name: "Criar e escolher público" });
  if (!(await save.isDisabled())) throw new Error("sem modelo não deveria salvar");
  await page.locator(".crm-modal select").first().selectOption({ label: "boas_vindas (pt_BR)" });
  const p = page.locator(".crm-modal .wa-tpl-param input");
  await p.nth(0).fill("{nome}"); await p.nth(1).fill("Perfumaria");
  await page.locator(".crm-modal .wa-bubble", { hasText: "Olá Drogaria São José! Temos novidades na Perfumaria." }).waitFor();
  await page.screenshot({ path: `${SHOTS}/04-disparo.png` });
  await save.click();
  await page.waitForTimeout(1200);
  const tpl = sql(`select template->>'name' || '|' || (template->'params')::text from wa_campaigns where tenant_id = '${B}' and name = 'Oficial UI' order by created_at desc limit 1`);
  if (tpl !== 'boas_vindas|["{nome}", "Perfumaria"]') throw new Error(`modelo do disparo: ${tpl}`);
});

await step("sem erros no console", async () => { if (errors.length) throw new Error(errors.slice(0, 5).join("\n")); });

sql(`update wa_channel_settings set active_provider = 'gateway' where tenant_id = '${B}'`);
await browser.close();
console.log(`\n${passed} ok, ${failed} falha(s) — telas em ${SHOTS}`);
process.exit(failed ? 1 : 0);
