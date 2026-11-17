// Tela: Disparos → Novo disparo → E-mail (colar e-mails, iniciar, enviado) e WhatsApp + E-mail (faixa do e-mail no cartão).
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import http from "node:http";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const fail = (m) => { console.error("FALHOU:", m); process.exitCode = 1; };
const TAG = Date.now() % 100000;
const mails = [];
const resend = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { mails.push(JSON.parse(b)); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: `e${mails.length}` })); }); });
await new Promise((r) => resend.listen(11995, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(APP);
await page.locator('input[type="email"]').first().fill("dono@clinica.local");
await page.locator('input[type="password"]').fill("Teste@12345");
await page.getByRole("button", { name: /Entrar/ }).first().click();
await page.locator(".sidebar").waitFor();
await page.goto(`${APP}/?section=crm-app&crm=dispatch`);

// 1) só e-mail
await page.getByRole("button", { name: /Novo disparo/ }).first().click();
await page.locator(".em-channel", { hasText: /^.*E-mailUm e-mail/ }).click();
await page.getByPlaceholder("Ex.: Escolas — apresentação por e-mail").fill(`Teste e-mail ${TAG}`);
await page.getByPlaceholder("https://…").fill("https://exemplo.com/apresentacao.pdf");
await page.screenshot({ path: "/tmp/cc/email-editor.png", fullPage: true });
await page.getByRole("button", { name: "Criar e escolher quem recebe" }).click();
await page.getByPlaceholder(/maria@escola/).fill(`ana${TAG}@exemplo.com\nBruno;bruno${TAG}@exemplo.com`);
await page.getByRole("button", { name: "Adicionar 2 e-mail(s)" }).click();
await page.getByText("e-mail(s) adicionados").waitFor();
await page.getByRole("button", { name: "Pronto" }).click();
const card = page.locator(".wa-camp", { hasText: `Teste e-mail ${TAG}` });
await card.getByRole("button", { name: "Iniciar" }).click();
await page.getByRole("button", { name: "Enviar e-mails" }).click();
for (let i = 0; i < 30 && mails.filter((m) => m.to[0].includes(String(TAG))).length < 2; i++) await page.waitForTimeout(500);
const mine = mails.filter((m) => m.to[0].includes(String(TAG)));
if (mine.length !== 2) fail(`esperava 2 e-mails, vieram ${mine.length}`);
if (!mine.every((m) => /disparos@/.test(m.from) && m.reply_to === "dono@clinica.local")) fail(`remetente/resposta: ${JSON.stringify(mine.map((m) => [m.from, m.reply_to]))}`);
const bruno = mine.find((m) => m.to[0].startsWith("bruno"));
if (!/Olá, Bruno!/.test(bruno?.text ?? "")) fail("variável {primeiro_nome} não preenchida");
await page.waitForTimeout(9000);   // a tela atualiza sozinha enquanto envia
await card.getByText(/2 de 2 enviados/).waitFor({ timeout: 10000 }).catch(() => fail("cartão não mostra 2 de 2"));
await page.screenshot({ path: "/tmp/cc/email-card.png" });

// 2) WhatsApp + E-mail
await page.getByRole("button", { name: /Novo disparo/ }).first().click();
await page.locator(".em-channel", { hasText: "WhatsApp + E-mail" }).click();
await page.getByPlaceholder("Ex.: Farmácias SP").fill(`Junto ${TAG}`);
await page.getByRole("button", { name: /Criar e escolher público/ }).click();
await page.getByRole("button", { name: "Salvar e-mail" }).click();
await page.getByText("Quem vai receber").waitFor();
await page.getByRole("button", { name: "Colar / importar CSV" }).click();
await page.locator(".wa-paste textarea").fill(`nome;telefone;email\nEscola A;(64) 99999-${String(TAG).padStart(4, "0").slice(-4)};escola${TAG}@exemplo.com`);
await page.getByRole("button", { name: /Adicionar 1 contato/ }).click();
await page.getByRole("button", { name: "Pronto" }).click();
const wcard = page.locator(".wa-camp", { hasText: `Junto ${TAG}` });
await wcard.locator(".em-strip").waitFor();
await page.screenshot({ path: "/tmp/cc/email-both.png" });
const linked = sql(`select count(*) from email_campaigns e join wa_campaigns w on w.id = e.wa_campaign_id where w.name = 'Junto ${TAG}'`);
if (linked !== "1") fail("e-mail não ficou ligado ao WhatsApp");
if (errors.length) fail(`erros na página: ${errors.join(" | ")}`);
console.log(process.exitCode ? "UI: FALHOU" : "UI: OK (só e-mail enviado + WhatsApp com e-mail junto)");
await browser.close(); resend.close();
