// Convite por e-mail de ponta a ponta na tela: o dono convida, a pessoa abre o link do e-mail,
// cria a senha e depois entra com ela. Stack LOCAL com Resend simulado (porta 11995) + vite.
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const SHOTS = process.env.SHOTS ?? "/tmp/access-ui";
mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now() % 1000000;
const NEW = `convidado${TAG}@exemplo.com`;
const mails = [];
const resend = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { mails.push(JSON.parse(b)); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: `e${mails.length}` })); });
});
await new Promise((r) => resend.listen(11995, "127.0.0.1", r));
sql(`delete from auth_email_requests`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0, passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("ok   -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n      ", e.message.split("\n").slice(0, 4).join("\n       ")); }
}
const wait = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error("tempo esgotado"); };
const linkOf = (m) => m.text.match(/(https?:\/\/\S+verify\S+)/)?.[1];

const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx1.newPage();
page.on("pageerror", (e) => errors.push(e.message));

await step("dono convida um vendedor pela tela de Usuários", async () => {
  await page.goto(APP);
  await page.locator('input[type="email"]').first().fill("dono@clinica.local");
  await page.locator('input[type="password"]').fill("Teste@12345");
  await page.getByRole("button", { name: /^Entrar$/ }).click();
  await page.locator(".sidebar").waitFor();
  await page.goto(`${APP}/?section=users`);
  await page.getByPlaceholder("vendedor@empresa.com").fill(NEW);
  await page.getByRole("button", { name: "Enviar acesso", exact: true }).click();
  await page.locator(".toast", { hasText: /enviado por email/ }).waitFor();
  await wait(() => mails.some((m) => m.to[0] === NEW));
  await page.locator(".user-row", { hasText: NEW }).getByText(/Email de acesso enviado/).waitFor();
  await page.screenshot({ path: `${SHOTS}/01-convite.png`, fullPage: true });
});

await step("reenviar acesso pela lista", async () => {
  const n = mails.length;
  await page.locator(".user-row", { hasText: NEW }).getByRole("button", { name: "Reenviar acesso" }).click();
  await page.locator(".toast", { hasText: /reenviado/ }).waitFor();
  await wait(() => mails.length === n + 1);
});

const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const guest = await ctx2.newPage();
guest.on("pageerror", (e) => errors.push(e.message));
const PASS = `Senha-${TAG}!`;

await step("convidado abre o link do e-mail e cria a senha", async () => {
  const m = mails.filter((x) => x.to[0] === NEW).at(-1);
  await guest.goto(linkOf(m));
  await guest.getByRole("heading", { name: "Crie a sua senha" }).waitFor({ timeout: 15000 });
  await guest.screenshot({ path: `${SHOTS}/02-criar-senha.png` });
  const inputs = guest.locator(".set-password-modal input");
  await inputs.nth(0).fill("curta"); await inputs.nth(1).fill("curta");
  await guest.getByRole("button", { name: "Salvar senha" }).click();
  await guest.getByText("Use pelo menos 8 caracteres.").waitFor();
  await inputs.nth(0).fill(PASS); await inputs.nth(1).fill(PASS);
  await guest.getByRole("button", { name: "Salvar senha" }).click();
  await guest.locator(".toast", { hasText: "Senha criada" }).waitFor();
  if (await guest.locator(".set-password-modal").count()) throw new Error("modal não fechou");
});

await step("convidado sai e entra com a senha nova; não pede senha de novo", async () => {
  await guest.goto(APP);
  await guest.evaluate(() => localStorage.clear());
  await guest.reload();
  await guest.locator('input[type="email"]').first().fill(NEW);
  await guest.locator('input[type="password"]').fill(PASS);
  await guest.getByRole("button", { name: /^Entrar$/ }).click();
  await guest.locator(".sidebar").waitFor();
  await guest.waitForTimeout(800);
  if (await guest.locator(".set-password-modal").count()) throw new Error("pediu senha de novo");
});

await step("tela de login: 'Esqueci minha senha' manda o e-mail e o link abre a criação de senha", async () => {
  const p = await (await browser.newContext()).newPage();
  await p.goto(APP);
  await p.locator('input[type="email"]').first().fill(NEW);
  const n = mails.length;
  await p.getByRole("button", { name: "Esqueci minha senha" }).click();
  await p.getByText(/Link para criar a nova senha/).waitFor();
  await wait(() => mails.length === n + 1);
  await p.goto(linkOf(mails.at(-1)));
  await p.getByRole("heading", { name: "Crie a sua senha" }).waitFor({ timeout: 15000 });
  await p.screenshot({ path: `${SHOTS}/03-nova-senha.png` });
});

await step("sem erros no console", async () => { if (errors.length) throw new Error(errors.slice(0, 5).join("\n")); });

await browser.close();
resend.close();
console.log(`\n${passed} ok, ${failed} falha(s) — telas em ${SHOTS}`);
process.exit(failed ? 1 : 0);
