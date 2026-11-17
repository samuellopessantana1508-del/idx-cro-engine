// Gravação real do Chrome (MediaRecorder WebM/Opus) → OGG/Opus válido para o WhatsApp (validado pelo ffprobe/ffmpeg).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../../web/node_modules/playwright/index.mjs";
import { webmOpusToOgg, opusPacketSamples } from "../../web/src/crm/webm-to-ogg.ts";

async function recordWebm(seconds, stereo = false) {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const p = await b.newPage();
  const b64 = await p.evaluate(async ({ seconds, stereo }) => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination(); dest.channelCount = stereo ? 2 : 1;
    osc.connect(dest); osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(250); // em pedaços, como na tela (gera clusters de tamanho desconhecido)
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ""; for (const x of buf) s += String.fromCharCode(x); return btoa(s);
  }, { seconds, stereo });
  await b.close();
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { encoding: "utf8" }));

test("gravação de 3 s vira OGG/Opus que o ffmpeg decodifica sem erro, com a mesma duração", async () => {
  const webm = await recordWebm(3);
  const ogg = webmOpusToOgg(webm);
  const dir = mkdtempSync(join(tmpdir(), "ogg-"));
  const f = join(dir, "audio.ogg"); writeFileSync(f, ogg);
  const info = probe(f);
  assert.equal(info.format.format_name, "ogg");
  assert.equal(info.streams[0].codec_name, "opus");
  const dur = Number(info.format.duration);
  assert.ok(dur > 2.5 && dur < 3.6, `duração ${dur}`);
  const errs = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(errs.trim(), "");
});

test("áudio estéreo também converte", async () => {
  const ogg = webmOpusToOgg(await recordWebm(1, true));
  const f = join(mkdtempSync(join(tmpdir(), "ogg-")), "s.ogg"); writeFileSync(f, ogg);
  assert.equal(probe(f).streams[0].codec_name, "opus");
});

test("duração dos pacotes Opus pelo TOC", () => {
  assert.equal(opusPacketSamples(new Uint8Array([0xfc])), 960);   // CELT 20 ms, 1 quadro
  assert.equal(opusPacketSamples(new Uint8Array([0x18])), 2880);   // SILK 60 ms (config 3), 1 quadro
  assert.equal(opusPacketSamples(new Uint8Array([0xfd, 0])), 1920); // 2 quadros de 20 ms
});

test("arquivo que não é WebM é recusado com mensagem clara", () => {
  assert.throws(() => webmOpusToOgg(new Uint8Array([1, 2, 3])));
});
