// Interface: Disparos, conexão por QR, resposta na caixa de entrada e "Enviar pelo CRO" (stack LOCAL + vite 127.0.0.1:5173).
// O motor de WhatsApp é simulado chamando as funções wa_gw_* com um token de teste.
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/dispatch-ui";
const ANON = process.env.ANON_KEY;
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 100000;
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
const TOKEN = randomBytes(32).toString("hex");
sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'ui ${TAG}')`);
const gw = createClient("http://127.0.0.1:54321", ANON, { auth: { persistSession: false } });
const G = async (fn, args) => { const r = await gw.rpc(fn, { p_token: TOKEN, ...args }); if (r.error) throw new Error(r.error.message); return r.data; };

// estado limpo da conexão do CRO nesta empresa
sql(`update wa_campaigns set status = 'canceled' where tenant_id = '${A}' and status in ('running', 'paused')`);
sql(`update wa_outbox set status = 'canceled' where tenant_id = '${A}' and status = 'queued'`);
sql(`update whatsapp_instances set desired_status = 'disconnected', status = 'disconnected', qr_code_data = null where tenant_id = '${A}' and provider = 'gateway'`);

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

let inst;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "dono@clinica.local");

  await step("menu Disparos e conexão por QR", async () => {
    await page.locator(".sidebar").getByRole("button", { name: "Disparos" }).first().click();
    await page.locator(".wa-conn").waitFor();
    await page.locator(".wa-conn").getByRole("button", { name: /Conectar/ }).click();
    await page.getByText(/Preparando o QR Code|Leia o QR Code/).first().waitFor();
    inst = sql(`select id from whatsapp_instances where tenant_id = '${A}' and provider = 'gateway' order by created_at limit 1`);
    // "motor" publica o QR (PNG 1x1 válido)
    await G("wa_gw_instance_update", { p_instance: inst, p_status: "connecting", p_qr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });
    await page.locator(".wa-qr img").waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/1-qr.png` });
    await G("wa_gw_instance_update", { p_instance: inst, p_status: "connected", p_phone: "5511900000001" });
    await page.getByText(/WhatsApp conectado/).waitFor({ timeout: 8000 });
  });

  await step("criar disparo com variações, prévia e proteções", async () => {
    await page.getByRole("button", { name: /Novo disparo|Criar o primeiro/ }).first().click();
    const m = page.locator(".crm-modal");
    await m.getByPlaceholder(/Farmácias SP/).fill(`Farmácias UI ${TAG}`);
    const ta = m.locator(".wa-msg-edit textarea").first();
    await ta.fill("");
    await m.locator(".wa-vars button", { hasText: "{primeiro_nome}" }).first().click();
    await page.waitForFunction(() => document.querySelector(".wa-msg-edit textarea")?.value === "{primeiro_nome}");
    await ta.fill("Oi {primeiro_nome}, tudo bem? Vi a {empresa} em {cidade}.");
    await m.locator(".wa-bubble").first().getByText(/Oi Drogaria, tudo bem\? Vi a Drogaria São José em Campinas\./).waitFor();
    await m.locator(".wa-bubble").first().getByText(/responda SAIR/).waitFor();
    await m.getByRole("button", { name: /Adicionar variação/ }).click();
    await m.locator(".wa-msg-edit textarea").nth(1).fill("{Olá|Bom dia} {primeiro_nome}! Posso te mostrar uma ideia para a {empresa}?");
    // configuração arriscada mostra alerta
    const sair = m.getByRole("checkbox", { name: /Incluir “Se não quiser/ });
    await sair.uncheck();
    await m.locator(".wa-warn").waitFor();
    await sair.check();
    await page.screenshot({ path: `${SHOTS}/2-editor.png` });
    await m.getByRole("button", { name: /Criar e escolher público/ }).click();
    await page.locator(".crm-modal").getByText("Quem vai receber").waitFor();
  });

  await step("público: colar lista (com repetido e inválido) e ver o resumo", async () => {
    const m = page.locator(".crm-modal");
    await m.getByRole("button", { name: "Colar / importar CSV" }).click();
    const p1 = `(11) 9${String(7000 + (TAG % 1000)).padStart(4, "0")}-${String(TAG % 10000).padStart(4, "0")}`;
    await m.locator(".wa-paste textarea").fill(`Drogaria Central;${p1};São Paulo\nFarmácia Bem Estar;19 99999-${String(TAG % 10000).padStart(4, "0")};Campinas\nRepetida;${p1};São Paulo\nSem número;123;Santos`);
    await m.getByText(/4 linha\(s\) reconhecida/).waitFor();
    await m.getByRole("button", { name: /Adicionar 4 contato/ }).click();
    await m.locator(".wa-result").getByText(/2/).first().waitFor();
    await m.getByText(/1 repetido/).waitFor();
    await m.getByText(/1 sem telefone válido/).waitFor();
    await page.screenshot({ path: `${SHOTS}/3-publico.png` });
    await m.getByRole("button", { name: "Pronto" }).click();
    await page.locator(".wa-camp").filter({ hasText: `Farmácias UI ${TAG}` }).getByText(/Rascunho/).waitFor();
  });

  await step("iniciar pede confirmação com o resumo das proteções e passa a 'Enviando'", async () => {
    const card = page.locator(".wa-camp").filter({ hasText: `Farmácias UI ${TAG}` });
    await card.getByRole("button", { name: "Iniciar" }).click();
    await page.locator(".crm-modal").getByText(/Serão 2 mensagens. Uma por vez, a cada 25–60 segundos, até 200 por dia, das 8h às 20h/).waitFor();
    await page.locator(".crm-modal").getByRole("button", { name: "Iniciar disparo" }).click();
    await toast(page, /Disparo iniciado/);
    await card.locator(".crm-pill", { hasText: "Enviando" }).waitFor();
  });

  await step("motor envia → progresso e resposta aparecem; detalhe filtra quem respondeu", async () => {
    const camp = sql(`select id from wa_campaigns where name = 'Farmácias UI ${TAG}'`);
    sql(`update wa_campaigns set start_hour = 0, end_hour = 24, next_send_at = now() where id = '${camp}'`);
    const msg = await G("wa_gw_claim", { p_instance: inst });
    if (!msg || msg.source !== "campaign") throw new Error("motor não recebeu a mensagem da campanha");
    await G("wa_gw_result", { p_outbox_id: msg.id, p_ok: true, p_wa_message_id: `UI${TAG}A`, p_jid: `${msg.phone}@s.whatsapp.net` });
    await G("wa_gw_ingest", { p_instance: inst, p_msg: { from_me: false, wa_id: msg.phone, phone: msg.phone, push_name: "Cliente UI", body: "Quero saber mais", wa_message_id: `UI${TAG}R` } });
    await page.reload();
    const card = page.locator(".wa-camp").filter({ hasText: `Farmácias UI ${TAG}` });
    await card.getByText(/1 de 2 enviados/).waitFor();
    await card.getByText(/1 responderam \(100%\)/).waitFor();
    await card.locator(".wa-camp-title").click();
    const m = page.locator(".crm-modal");
    await m.locator("tbody tr").first().getByText("Enviado").waitFor();
    await page.screenshot({ path: `${SHOTS}/4-detalhe.png` });
    await m.getByRole("button", { name: "Fechar" }).click();
  });

  await step("pausar e cancelar", async () => {
    const card = page.locator(".wa-camp").filter({ hasText: `Farmácias UI ${TAG}` });
    await card.getByRole("button", { name: "Pausar" }).click();
    await toast(page, /Disparo pausado/);
    await card.getByRole("button", { name: "Retomar" }).waitFor();
    await card.getByTitle("Cancelar disparo").click();
    await page.locator(".crm-modal").getByRole("button", { name: "Cancelar disparo" }).click();
    await card.getByText("Cancelado").waitFor();
  });

  await step("caixa de entrada do WhatsApp: responder pela própria conversa", async () => {
    await page.goto(`${APP}/?section=whatsapp`);
    await page.locator(".wa-contact-item").filter({ hasText: "Cliente UI" }).first().click();
    await page.locator(".wa-thread-messages").getByText("Quero saber mais").waitFor();
    await page.locator(".wa-reply textarea").fill("Claro! Te mando agora.");
    await page.locator(".wa-reply textarea").press("Enter");
    await page.getByText(/Enviando “Claro! Te mando agora/).waitFor();
    const m = await G("wa_gw_claim", { p_instance: inst });
    if (m?.body !== "Claro! Te mando agora.") throw new Error("resposta não chegou na fila: " + JSON.stringify(m));
    await G("wa_gw_result", { p_outbox_id: m.id, p_ok: true, p_wa_message_id: `UI${TAG}M`, p_jid: `${m.phone}@s.whatsapp.net` });
    await page.locator(".wa-thread-messages").getByText("Claro! Te mando agora.").waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/5-inbox.png` });
  });

  await step("SAIR pelo WhatsApp aparece em 'Pediram SAIR'", async () => {
    const p = `55119${String(50000000 + TAG).slice(-8)}`;
    await G("wa_gw_ingest", { p_instance: inst, p_msg: { from_me: false, wa_id: p, phone: p, body: "SAIR", wa_message_id: `UI${TAG}S` } });
    await go(page, "dispatch");
    await page.getByRole("button", { name: /Pediram SAIR/ }).click();
    await page.getByText(/Respondeu “SAIR”/).first().waitFor();
  });

  await step("tarefa de WhatsApp da cadência: 'Enviar pelo CRO' com o texto pronto", async () => {
    const ct = sql(`insert into crm_contacts(tenant_id, name, phone) values ('${A}', 'Joana UI ${TAG}', '55119${String(40000000 + TAG).slice(-8)}') returning id`).split("\n")[0];
    sql(`insert into crm_tasks(tenant_id, title, task_type, contact_id, due_at, description, status)
         values ('${A}', 'WhatsApp Joana ${TAG}', 'whatsapp', '${ct}', now(), 'Oi Joana, tudo bem? Podemos conversar?', 'open')`);
    await go(page, "tasks");
    const row = page.locator(".crm-task").filter({ hasText: `WhatsApp Joana ${TAG}` }).first();
    await row.getByRole("button", { name: /Enviar pelo CRO/ }).click();
    const m = page.locator(".crm-modal");
    await m.locator("textarea").waitFor();
    if ((await m.locator("textarea").inputValue()) !== "Oi Joana, tudo bem? Podemos conversar?") throw new Error("texto não veio pronto");
    await m.getByRole("button", { name: /Enviar pelo CRO/ }).click();
    await toast(page, /fila/);
  });

  await step("celular: tela de disparos sem estourar a largura", async () => {
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const mp = await mob.newPage();
    mp.on("pageerror", (e) => errors.push(e.message));
    await login(mp, "dono@clinica.local");
    await go(mp, "dispatch");
    await mp.locator(".wa-camp").first().waitFor();
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await mp.screenshot({ path: `${SHOTS}/6-mobile.png`, fullPage: true });
    if (over > 2) throw new Error(`estouro horizontal de ${over}px`);
    await mob.close();
  });

  await step("vendedor (sem configurar) não vê botão de conectar", async () => {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await c2.newPage();
    await login(p2, "ana.vendas@clinica.local");
    await go(p2, "dispatch");
    await p2.locator(".wa-conn").waitFor();
    if (await p2.locator(".wa-conn").getByRole("button", { name: /Trocar número|Pausar|Conectar/ }).count()) throw new Error("vendedor não deveria gerenciar a conexão");
    await c2.close();
  });
} finally {
  await browser.close();
}
if (errors.length) { console.log("Erros de página:", errors); failed++; }
console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
