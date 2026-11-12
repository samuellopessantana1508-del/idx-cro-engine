// Interface do editor de automações (stack LOCAL + vite 127.0.0.1:5173).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/flows-ui";
const ANON = process.env.ANON_KEY;
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
sql(`update wa_flows set status = 'archived' where tenant_id = '${A}' and status <> 'archived'`);
// conexão do CRO pedida (o motor é simulado; para ativar basta existir)
const adm = createClient("http://127.0.0.1:54321", ANON, { auth: { persistSession: false } });
await adm.auth.signInWithPassword({ email: "dono@clinica.local", password: "Teste@12345" });
await adm.rpc("wa_gateway_connect", { p_tenant_id: A, p_action: "connect" });
sql(`update whatsapp_instances set status = 'connected' where tenant_id = '${A}' and provider = 'gateway'`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0, passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("ok   -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 4).join("\n       ")); }
}
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|WebSocket/.test(m.text())) errors.push(m.text()); });
await page.goto(APP);
await page.locator('input[type="email"]').first().fill("dono@clinica.local");
await page.locator('input[type="password"]').fill("Teste@12345");
await page.getByRole("button", { name: /Entrar/ }).first().click();
await page.locator(".sidebar").waitFor();
await page.goto(`${APP}/?section=crm-app&crm=flows`);

await step("lista vazia convida a escolher um modelo; menu lateral tem Automações", async () => {
  await page.getByText("Monte seu primeiro robô de atendimento").waitFor();
  await page.locator(".sidebar").getByText("Automações WhatsApp").waitFor();
  await page.screenshot({ path: `${SHOTS}/1-vazia.png` });
});

await step("modelo 'Boas-vindas com menu' abre o editor com o desenho pronto", async () => {
  await page.getByRole("button", { name: /Escolher um modelo/ }).click();
  await page.locator(".fz-template").filter({ hasText: "Boas-vindas com menu" }).click();
  await page.locator(".fz-editor").waitFor();
  await page.locator(".fz-node").nth(8).waitFor();
  const n = await page.locator(".fz-node").count();
  if (n !== 9) throw new Error(`esperava 9 blocos, veio ${n}`);
  await page.locator(".fz-node").filter({ hasText: "Menu de opções" }).getByText("3. Falar com um atendente").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/2-editor.png` });
});

await step("editar mensagem no painel: prévia do WhatsApp e salvamento automático", async () => {
  await page.locator(".fz-node").filter({ hasText: "Olá" }).first().click();
  const ta = page.locator(".fz-panel textarea").first();
  await ta.fill("Oi {primeiro_nome}! Bem-vindo à Clínica Sorriso 😁");
  await page.locator(".fz-bubble").filter({ hasText: "Oi Maria! Bem-vindo à Clínica Sorriso" }).waitFor();
  await page.locator(".fz-save-saved").waitFor({ timeout: 8000 });
  const saved = sql(`select graph::text like '%Bem-vindo à Clínica Sorriso%' from wa_flows where tenant_id = '${A}' and status = 'draft' order by created_at desc limit 1`);
  if (saved !== "t") throw new Error("não salvou no banco");
  await page.screenshot({ path: `${SHOTS}/3-painel.png` });
});

await step("'+' de uma saída livre adiciona e liga o próximo bloco", async () => {
  const before = await page.locator(".react-flow__edge").count();
  const node = page.locator(".fz-node").filter({ hasText: "Etiqueta" }).filter({ hasText: "interesse-precos" });
  await node.locator(".fz-plus").click();
  await page.locator(".fz-quick").waitFor();
  await page.locator(".fz-quick input").fill("tarefa");
  await page.locator(".fz-quick-item").filter({ hasText: "Criar tarefa" }).click();
  await page.locator(".fz-panel").getByText("Criar tarefa").first().waitFor();
  const after = await page.locator(".react-flow__edge").count();
  if (after !== before + 1) throw new Error(`ligações ${before} → ${after}`);
  await page.screenshot({ path: `${SHOTS}/4-adicionar.png` });
});

await step("simulador percorre o fluxo: primeira mensagem → menu → opção 2 passa para atendente", async () => {
  await page.getByRole("button", { name: /Simular/ }).click();
  await page.locator(".fz-sim").waitFor();
  await page.locator(".fz-sim-input input").fill("oi, bom dia");
  await page.locator(".fz-sim-input button").click();
  await page.locator(".fz-msg.out").filter({ hasText: "Bem-vindo à Clínica Sorriso" }).waitFor();
  await page.locator(".fz-msg.out").filter({ hasText: "1️⃣ Ver produtos e preços" }).waitFor();
  await page.locator(".fz-node.sim-active").waitFor();
  await page.screenshot({ path: `${SHOTS}/5-simulador-menu.png` });
  await page.locator(".fz-sim-input input").fill("2");
  await page.locator(".fz-sim-input button").click();
  await page.locator(".fz-sys").filter({ hasText: "Negociação criada" }).waitFor();
  await page.locator(".fz-sys").filter({ hasText: "Tarefa criada" }).waitFor();
  await page.locator(".fz-sys").filter({ hasText: "Automação concluída" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/6-simulador-fim.png` });
});

await step("simulador: sem resposta no prazo segue pelo caminho certo", async () => {
  await page.locator(".fz-sim-head").getByTitle("Recomeçar").click();
  await page.locator(".fz-sim-input input").fill("olá");
  await page.locator(".fz-sim-input button").click();
  await page.locator(".fz-sim-actions button").filter({ hasText: "não respondeu" }).click();
  await page.locator(".fz-sys").filter({ hasText: "Etiqueta adicionada: sem-resposta" }).waitFor();
  await page.getByRole("button", { name: /Simular/ }).click();
});

await step("ativar: avisa o que corrigir; depois de corrigir, ativa", async () => {
  // bloco novo com mensagem vazia → erro
  await page.locator(".fz-pitem").filter({ hasText: "Mensagem" }).first().click();
  await page.getByRole("button", { name: /^Ativar$/ }).click();
  await page.getByText("Antes de ativar, corrija:").waitFor();
  await page.screenshot({ path: `${SHOTS}/7-corrigir.png` });
  await page.getByRole("button", { name: "Entendi" }).click();
  await page.locator(".fz-panel textarea").first().fill("Mensagem extra");
  // bloco solto é só aviso; ativa
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: /^Ativar$/ }).click();
  await page.locator(".fz-top .fz-status-active").waitFor();
  const st = sql(`select status from wa_flows where tenant_id = '${A}' and status <> 'archived' order by created_at desc limit 1`);
  if (st !== "active") throw new Error(st);
});

await step("lista mostra a automação ativa com gatilho e números", async () => {
  await page.locator(".fz-top button[aria-label='Voltar']").click();
  await page.locator(".fz-card").first().waitFor();
  await page.locator(".fz-card").getByText("Primeira mensagem").waitFor();
  await page.locator(".fz-card .fz-status-active").waitFor();
  await page.screenshot({ path: `${SHOTS}/8-lista.png` });
});

await step("modelos: todos abrem sem avisos de erro", async () => {
  for (const name of ["Fora do horário", "Resposta de disparo", "Qualificação de orçamento", "Recuperar lead frio", "Atendimento com IA"]) {
    await page.getByRole("button", { name: /Nova automação/ }).click();
    await page.locator(".fz-template").filter({ hasText: name }).click();
    await page.locator(".fz-editor .fz-node").first().waitFor();
    await page.waitForTimeout(400);
    if (await page.locator(".fz-issue-btn.is-err").count()) throw new Error(`${name}: tem erros de validação`);
    if (name === "Qualificação de orçamento") await page.screenshot({ path: `${SHOTS}/9-qualificacao.png` });
    await page.locator(".fz-top button[aria-label='Voltar']").click();
    await page.locator(".fz-card").first().waitFor();
  }
});

await step("caixa de entrada: robô na conversa → atendente assume → devolve ao robô", async () => {
  const TOKEN = randomBytes(32).toString("hex");
  sql(`insert into wa_gateway_tokens(token_hash, label) values ('${createHash("sha256").update(TOKEN).digest("hex")}', 'flows-ui')`);
  const inst = sql(`select id from whatsapp_instances where tenant_id = '${A}' and provider = 'gateway'`);
  const p = `55119${String(Date.now()).slice(-8)}`;
  const r = await adm.rpc("wa_gw_ingest", { p_token: TOKEN, p_instance: inst, p_msg: { from_me: false, wa_id: p, phone: p, push_name: "Paciente Robô", body: "oi", wa_message_id: `FUI${Date.now()}` } });
  if (r.error) throw new Error(r.error.message);
  const t = await fetch("http://127.0.0.1:54321/functions/v1/cro-flows", { method: "POST", headers: { "x-gateway-token": TOKEN } });
  if (!t.ok) throw new Error(await t.text());
  await page.goto(`${APP}/?section=whatsapp`);
  await page.locator(".wa-contact-item").filter({ hasText: "Paciente Robô" }).first().click();
  await page.locator(".wa-bot-bar").getByText(/Em automação/).waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/10-inbox-robo.png` });
  await page.locator(".wa-bot-bar").getByRole("button", { name: "Assumir conversa" }).click();
  await page.locator(".wa-bot-bar.human").waitFor();
  if (sql(`select count(*) from wa_flow_runs where phone = '${p}' and status in ('running','waiting')`) !== "0") throw new Error("execução não foi encerrada");
  await page.locator(".wa-bot-bar").getByRole("button", { name: "Devolver ao robô" }).click();
  await page.locator(".wa-bot-bar").waitFor({ state: "detached" });
  globalThis.__phone = p;
});

await step("atendimento em equipe: responsável, concluir e filtro de concluídas", async () => {
  const sellerId = sql(`select id from auth.users where email = 'ana.vendas@clinica.local'`);
  await page.locator(".wa-conv-team select").selectOption(sellerId);
  await page.locator(".toast").filter({ hasText: "Conversa transferida" }).first().waitFor();
  await page.locator(".wa-conv-team").getByRole("button", { name: /Concluir/ }).click();
  await page.locator(".wa-conv-team").getByRole("button", { name: /Reabrir/ }).waitFor();
  if (sql(`select status from whatsapp_conversations c join whatsapp_contacts wc on wc.id = c.contact_id where wc.phone = '${globalThis.__phone}'`) !== "archived") throw new Error("não concluiu");
  await page.reload();
  await page.locator(".wa-inbox-filters").getByRole("tab", { name: /Concluídas/ }).click();
  await page.locator(".wa-contact-item").filter({ hasText: "Paciente Robô" }).first().waitFor();
  await page.screenshot({ path: `${SHOTS}/11-inbox-equipe.png` });
});

await step("respostas rápidas: criar e usar com '/'", async () => {
  await page.locator(".wa-contact-item").filter({ hasText: "Paciente Robô" }).first().click();
  await page.locator(".wa-qr-btn").click();
  await page.locator(".wa-qr-pop").getByRole("button", { name: "Gerenciar" }).click();
  await page.getByRole("button", { name: /Nova resposta/ }).click();
  await page.locator(".crm-modal input").fill("endereco");
  await page.locator(".crm-modal textarea").fill("Rua das Flores, 100 — Centro");
  await page.locator(".crm-modal").getByRole("button", { name: "Salvar" }).click();
  await page.locator(".wa-qr-manage").getByText("/endereco").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".crm-modal").waitFor({ state: "detached" }).catch(async () => { await page.locator(".crm-modal button[aria-label='Fechar']").click(); });
  await page.locator(".wa-reply textarea").fill("/ende");
  await page.locator(".wa-qr-item").filter({ hasText: "/endereco" }).click();
  if ((await page.locator(".wa-reply textarea").inputValue()) !== "Rua das Flores, 100 — Centro") throw new Error("não inseriu");
  await page.screenshot({ path: `${SHOTS}/12-respostas-rapidas.png` });
  sql(`delete from wa_quick_replies where title = 'endereco'`);
});

await step("gatilho webhook mostra o endereço para copiar", async () => {
  await page.goto(`${APP}/?section=crm-app&crm=flows`);
  await page.getByRole("button", { name: /Nova automação/ }).click();
  await page.locator(".fz-template").filter({ hasText: "Em branco" }).click();
  await page.locator(".fz-node").first().click();
  await page.locator(".fz-kind").filter({ hasText: "Webhook" }).click();
  await page.locator(".fz-hook input").waitFor();
  await page.waitForFunction(() => /\/functions\/v1\/cro-flows\/hook\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(document.querySelector(".fz-hook input")?.value ?? ""));
  await page.screenshot({ path: `${SHOTS}/13-webhook.png` });
});

await step("sem erros no console", async () => { if (errors.length) throw new Error(errors.slice(0, 5).join("\n")); });

await browser.close();
console.log(`\n${passed} ok, ${failed} falha(s) — telas em ${SHOTS}`);
process.exit(failed ? 1 : 0);
