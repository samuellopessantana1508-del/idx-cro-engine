// Tela: na conversa do WhatsApp, enviar PDF (📎) e gravar áudio (🎤) — microfone simulado do Chrome.
// Pré-requisito: stack local + seed + tests/crm/wa-inbox-media.test.mjs (cria a conversa "Gabriela").
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const APP = process.env.APP ?? "http://127.0.0.1:5173";
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const waitSql = async (q, ok, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = sql(q); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 300)); } return v; };
const fail = (m) => { console.error("FALHOU:", m); process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ["microphone"] });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(APP);
await page.locator('input[type="email"]').first().fill("dono@clinica.local");
await page.locator('input[type="password"]').fill("Teste@12345");
await page.getByRole("button", { name: /Entrar/ }).first().click();
await page.locator(".sidebar").waitFor();
await page.goto(`${APP}/?section=whatsapp`);
await page.getByText("Gabriela", { exact: false }).first().click();
await page.getByPlaceholder("Escreva uma resposta…").waitFor();
const before = Number(sql(`select count(*) from wa_outbox where source = 'manual' and media_url is not null`));

// 1) PDF com legenda
writeFileSync("/tmp/apresentacao-teste.pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
await page.getByPlaceholder("Escreva uma resposta…").fill("Segue a apresentação");
await page.locator('input[aria-label="Arquivo para enviar"]').setInputFiles({ name: "Apresentação Agro.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
const pdf = await waitSql(`select concat_ws('|', media_type, file_name, body) from wa_outbox where source = 'manual' and media_type = 'document' and file_name = 'Apresentação Agro.pdf' order by created_at desc limit 1`, (v) => !!v);
if (pdf !== "document|Apresentação Agro.pdf|Segue a apresentação") fail(`PDF na fila: ${pdf}`);
if (await page.getByPlaceholder("Escreva uma resposta…").inputValue() !== "") fail("a legenda deveria ter sido limpa");

// 2) áudio gravado (sem texto, o botão vira microfone)
await page.screenshot({ path: "/tmp/cc/after-pdf.png" });
await page.getByTitle("Gravar áudio").waitFor();
await page.getByTitle("Gravar áudio").click();
await page.getByText(/Gravando 0:0/).waitFor();
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/cc/rec.png" });
await page.getByTitle("Parar e enviar").click();
const aud = await waitSql(`select concat_ws('|', media_type, coalesce(nullif(body, ''), '-'), media_url) from wa_outbox where source = 'manual' and media_type = 'audio' and file_name like 'audio-%' order by created_at desc limit 1`, (v) => !!v);
if (!/^audio\|-\|http.*\.ogg$/.test(aud)) fail(`áudio na fila: ${aud}`);
const url = aud.split("|")[2];
const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync("/tmp/audio-ui.ogg", bytes);
const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", "/tmp/audio-ui.ogg"], { encoding: "utf8" }));
if (info.streams[0]?.codec_name !== "opus" || !(Number(info.format.duration) > 1.5)) fail(`áudio inválido: ${JSON.stringify(info.format)}`);

// 3) descartar não envia
await page.getByTitle("Gravar áudio").click();
await page.getByText(/Gravando/).waitFor();
await page.waitForTimeout(800);
await page.getByTitle("Descartar áudio").click();
await page.waitForTimeout(1500);
const after = Number(sql(`select count(*) from wa_outbox where source = 'manual' and media_url is not null`));
if (after !== before + 2) fail(`esperava 2 arquivos novos na fila, vieram ${after - before}`);
await page.screenshot({ path: "/tmp/cc/inbox-media.png" });
if (errors.length) fail(`erros na página: ${errors.join(" | ")}`);
console.log(process.exitCode ? "UI: FALHOU" : `UI: OK (pdf + áudio ${Number(info.format.duration).toFixed(1)} s opus + descartar)`);
await browser.close();
