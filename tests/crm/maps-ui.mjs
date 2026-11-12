// Interface: busca de clientes no Google Maps (Places SIMULADO em 127.0.0.1:11998) → discador → disparo.
// Stack com ENCRYPTION_KEY e PLACES_API_URL=http://127.0.0.1:11998; vite em 127.0.0.1:5173.
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/maps-ui";
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
sql(`delete from maps_usage where tenant_id = '${A}'`);
sql(`update lead_sources set active = false, auto = false where tenant_id = '${A}'`);

const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}");
    const loc = body.textQuery.split(" em ")[1] ?? body.textQuery;
    const places = Array.from({ length: 6 }, (_, i) => ({
      id: `ui-${TAG}-${loc}-${i}`, displayName: { text: i === 5 ? "Drogaria São Paulo" : `Farmácia ${loc.split(",")[0]} ${i + 1}` },
      formattedAddress: `Av. ${i}, ${loc}`, nationalPhoneNumber: `(11) 9${String(6000 + (TAG % 3000) + loc.length * 10 + i).slice(-4)}-${String(1000 + i)}`,
      rating: 4.1 + i / 10, userRatingCount: 20 + i, businessStatus: "OPERATIONAL", googleMapsUri: "https://maps.google.com",
      addressComponents: [{ longText: loc.split(",")[0], types: ["sublocality_level_1"] }, { longText: "São Paulo", types: ["administrative_area_level_2"] }, { longText: "São Paulo", shortText: "SP", types: ["administrative_area_level_1"] }],
    }));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ places }));
  });
});
await new Promise((r) => mock.listen(11998, "127.0.0.1", r));

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

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "dono@clinica.local");
  // disparo que vai receber os clientes
  await page.goto(`${APP}/?section=crm-app&crm=dispatch`);
  await page.locator(".crm-page").first().waitFor();

  await step("aba Buscar clientes: conectar Google Maps com a chave", async () => {
    await page.getByRole("button", { name: "Buscar clientes", exact: true }).click();
    await page.locator(".maps-key").waitFor();
    await page.locator(".maps-key").getByRole("button", { name: /Conectar Google Maps|Configurar/ }).click();
    const m = page.locator(".crm-modal");
    await m.getByPlaceholder("AIza…").fill(`AIzaUI${TAG}abcdefghijklmnopqrstuvwxyz`);
    await m.getByRole("button", { name: "Salvar" }).click();
    await toast(page, /Google Maps configurado/);
    await page.getByText(/Google Maps conectado · chave …/).waitFor();
    await page.getByText(/0 de 900 buscas usadas/).waitFor();
  });

  await step("nova busca: testar mostra a posição, nota e telefone; salvar alimentando um disparo", async () => {
    sql(`insert into wa_campaigns(tenant_id, name, messages, created_by) select '${A}', 'Disparo Maps ${TAG}', '{"Oi {empresa}! Vi a nota {nota} de vocês no Google."}', id from auth.users where email = 'dono@clinica.local'`);
    await page.reload();
    await page.getByRole("button", { name: "Buscar clientes", exact: true }).click();
    await page.getByRole("button", { name: "Nova busca" }).click();
    const m = page.locator(".crm-modal");
    await m.locator("textarea").fill(`Moema ${TAG}, São Paulo SP\nTatuapé ${TAG}, São Paulo SP`);
    await m.locator("input[list='maps-lists']").fill(`Maps UI ${TAG}`);
    await m.locator("select").first().selectOption({ label: `Disparo Maps ${TAG}` });
    await m.getByRole("button", { name: /Testar em/ }).click();
    await m.locator(".maps-preview tbody tr").first().waitFor();
    await m.locator(".maps-preview").getByText("1º").first().waitFor();
    await m.locator(".maps-preview").getByText(/4,1 \(20\)/).waitFor();
    await page.screenshot({ path: `${SHOTS}/1-nova-busca.png` });
    await m.getByRole("button", { name: "Salvar" }).click();
    await toast(page, /Busca automática criada/);
    const card = page.locator(".wa-camp").filter({ hasText: "farmácia" }).first();
    await card.getByText(/Todo dia às 7h/).waitFor();
    await card.getByText(`Disparo Maps ${TAG}`).waitFor();
  });

  await step("buscar agora: resultado com novos, redes ignoradas e envio ao disparo", async () => {
    const card = page.locator(".wa-camp").filter({ hasText: `Maps UI ${TAG}` }).first();
    await card.getByRole("button", { name: "Buscar agora" }).click();
    const m = page.locator(".crm-modal");
    await m.getByText(/cliente\(s\) novo\(s\)/).waitFor({ timeout: 30000 });
    const txt = await m.innerText();
    if (!/\b10\b cliente\(s\) novo\(s\)/.test(txt)) throw new Error("esperava 10 novos: " + txt);
    if (!/10 no disparo/.test(txt)) throw new Error("esperava 10 no disparo: " + txt);
    if (!/2 redes\/franquias ignoradas/.test(txt)) throw new Error("esperava 2 redes: " + txt);
    await page.screenshot({ path: `${SHOTS}/2-resultado.png` });
    await m.getByRole("button", { name: "Abrir no discador" }).click();
    await page.locator(".crm-page").first().waitFor();
  });

  await step("disparo ganhou o selo de alimentação automática e 10 contatos", async () => {
    await page.goto(`${APP}/?section=crm-app&crm=dispatch`);
    const card = page.locator(".wa-camp").filter({ hasText: `Disparo Maps ${TAG}` });
    await card.getByText("Alimentação automática").waitFor();
    await card.getByText(/0 de 10 enviados/).waitFor();
    await page.screenshot({ path: `${SHOTS}/3-disparo.png` });
  });

  await step("busca automática = extrator do FlowZap: ramo + cidade → contatos com etiqueta e discador", async () => {
    await page.goto(`${APP}/?section=crm-app&crm=dispatch&tab=maps`);
    const card = page.locator(".ext-card").filter({ hasText: "Busca automática" });
    await card.locator("input").nth(0).fill("farmácia");
    await card.locator("input").nth(1).fill(`Campinas ${TAG}`);
    await card.getByRole("button", { name: /Buscar automaticamente/ }).click();
    await card.locator(".ext-result").waitFor({ timeout: 90000 });
    await page.screenshot({ path: `${SHOTS}/5-busca-automatica.png` });
    const tag = `farmácia-campinas-${TAG}`;
    const n = Number(sql(`select count(*) from crm_contacts where tenant_id = '${A}' and '${tag}' = any(tags)`));
    const d = Number(sql(`select count(*) from crm_dial_leads where tenant_id = '${A}' and list_name = 'farmácia — Campinas ${TAG}'`));
    if (n < 5 || d < 5) throw new Error(`contatos com etiqueta ${n}, discador ${d}`);
  });

  await step("colar números: acha telefones e nomes no texto e importa com etiqueta", async () => {
    await page.getByRole("tab", { name: "Colar números" }).click();
    const t = `Farmácia Vida - (19) 9${String(7000 + (TAG % 2000)).slice(-4)}-1111\nDrogaria Central 19 9${String(7000 + (TAG % 2000)).slice(-4)}-2222\nlixo 123\n(19) 9${String(7000 + (TAG % 2000)).slice(-4)}-1111`;
    await page.locator(".ext-paste").fill(t);
    await page.locator(".ext-found").getByText("2").first().waitFor();
    await page.locator(".ext-found").getByText(/Farmácia Vida/).waitFor();
    await page.locator(".ext-card").getByRole("textbox").nth(1).fill(`colados-${TAG}`);
    await page.getByRole("button", { name: /Importar 2 contato/ }).click();
    await page.getByText(/novo\(s\) e 0 já existente/).waitFor();
    if (sql(`select string_agg(name, ',' order by name) from crm_contacts where tenant_id = '${A}' and 'colados-${TAG}' = any(tags)`) !== "Drogaria Central,Farmácia Vida") throw new Error("nomes não vieram");
    await page.screenshot({ path: `${SHOTS}/6-colar.png` });
  });

  await step("grupos do WhatsApp: aviso de risco antes de qualquer coisa", async () => {
    await page.getByRole("tab", { name: "Grupos do WhatsApp" }).click();
    await page.getByText("Use com cuidado — risco de bloqueio do número.").waitFor();
    if (await page.getByRole("button", { name: /Carregar meus grupos/ }).count()) throw new Error("botão apareceu sem aceitar o aviso");
    await page.getByText("Entendi os riscos").click();
    await page.getByRole("button", { name: /Carregar meus grupos/ }).waitFor();
    await page.screenshot({ path: `${SHOTS}/7-grupos.png` });
    await page.getByRole("tab", { name: "Google Maps" }).click();
  });

  await step("vendedor vê as buscas mas não troca a chave", async () => {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await c2.newPage();
    await login(p2, "ana.vendas@clinica.local");
    await p2.goto(`${APP}/?section=crm-app&crm=dispatch&tab=maps`);
    await p2.locator(".maps-key").waitFor();
    if (await p2.locator(".maps-key").getByRole("button").count()) throw new Error("vendedor não deveria configurar a chave");
    await p2.getByRole("button", { name: "Buscar agora" }).first().waitFor();
    await c2.close();
  });

  await step("celular: aba de busca sem estourar a largura", async () => {
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const mp = await mob.newPage();
    await login(mp, "dono@clinica.local");
    await mp.goto(`${APP}/?section=crm-app&crm=dispatch&tab=maps`);
    await mp.locator(".maps-key").waitFor();
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await mp.screenshot({ path: `${SHOTS}/4-mobile.png`, fullPage: true });
    if (over > 2) throw new Error(`estouro horizontal de ${over}px`);
    await mob.close();
  });
} finally {
  await browser.close();
  mock.close();
}
if (errors.length) { console.log("Erros de página:", errors); failed++; }
console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
