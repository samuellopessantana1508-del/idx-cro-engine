/**
 * Converte o áudio gravado pelo navegador (WebM/Opus, formato do MediaRecorder do Chrome)
 * para OGG/Opus — o formato de áudio de voz do WhatsApp, aceito pela API oficial da Meta.
 * Não recodifica: copia os mesmos pacotes Opus de um contêiner para o outro (sem perda).
 */

// ---- leitura do WebM (EBML) ----
const ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1f43b675, ID_TRACKS = 0x1654ae6b, ID_TRACK_ENTRY = 0xae;
const ID_BLOCK_GROUP = 0xa0, ID_AUDIO = 0xe1, ID_CODEC_ID = 0x86, ID_CODEC_PRIVATE = 0x63a2;
const ID_CHANNELS = 0x9f, ID_SIMPLE_BLOCK = 0xa3, ID_BLOCK = 0xa1, ID_TRACK_NUMBER = 0xd7;
const CONTAINERS = new Set([ID_SEGMENT, ID_CLUSTER, ID_TRACKS, ID_TRACK_ENTRY, ID_BLOCK_GROUP, ID_AUDIO]);

function readVint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = b[pos];
  if (first === undefined) throw new Error("WebM incompleto");
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error("WebM inválido");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const x = b[pos + i];
    if (x !== 0xff) allOnes = false;
    value = value * 256 + x;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

type Parsed = { codecPrivate: Uint8Array | null; channels: number; codec: string; track: number; packets: Uint8Array[] };

export function parseWebmOpus(b: Uint8Array): Parsed {
  const out: Parsed = { codecPrivate: null, channels: 1, codec: "", track: 1, packets: [] };
  let pos = 0;
  while (pos < b.length) {
    if (b.length - pos < 2) break;
    const id = readVint(b, pos, true);
    const size = readVint(b, pos + id.length, false);
    const start = pos + id.length + size.length;
    if (CONTAINERS.has(id.value)) { pos = start; continue; } // entra no contêiner (aceita tamanho desconhecido)
    const end = size.unknown ? b.length : Math.min(b.length, start + size.value);
    const data = b.subarray(start, end);
    if (id.value === ID_CODEC_ID) out.codec = new TextDecoder().decode(data);
    else if (id.value === ID_CODEC_PRIVATE) out.codecPrivate = data.slice();
    else if (id.value === ID_TRACK_NUMBER) out.track = data.reduce((a, x) => a * 256 + x, 0);
    else if (id.value === ID_CHANNELS) out.channels = data.reduce((a, x) => a * 256 + x, 0) || 1;
    else if (id.value === ID_SIMPLE_BLOCK || id.value === ID_BLOCK) {
      const tn = readVint(data, 0, false);
      if (tn.value === out.track) {
        const flags = data[tn.length + 2];
        if (flags & 0x06) throw new Error("Áudio com lacing não suportado");
        out.packets.push(data.slice(tn.length + 3));
      }
    }
    pos = end;
  }
  if (out.codec && out.codec !== "A_OPUS") throw new Error(`Áudio ${out.codec} não suportado (esperado Opus)`);
  if (!out.packets.length) throw new Error("Gravação vazia");
  return out;
}

/** Amostras (48 kHz) de um pacote Opus, pelo byte TOC (RFC 6716, seção 3.1). */
export function opusPacketSamples(p: Uint8Array): number {
  if (!p.length) return 0;
  const toc = p[0], config = toc >> 3;
  let ms: number;
  if (config < 12) ms = [10, 20, 40, 60][config % 4];
  else if (config < 16) ms = [10, 20][config % 2];
  else ms = [2.5, 5, 10, 20][config % 4];
  const c = toc & 3;
  const frames = c === 0 ? 1 : c === 3 ? (p[1] ?? 0) & 0x3f : 2;
  return Math.round(frames * ms * 48);
}

// ---- escrita do OGG ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(b: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ b[i]]) >>> 0;
  return crc >>> 0;
}

function oggPage(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error("Página OGG grande demais");
  const bodyLen = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; page[5] = flags;
  dv.setUint32(6, granule >>> 0, true); dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, serial, true); dv.setUint32(18, seq, true); dv.setUint32(22, 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  dv.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(channels: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set(new TextEncoder().encode("OpusHead"), 0);
  const dv = new DataView(h.buffer);
  h[8] = 1; h[9] = channels; dv.setUint16(10, 312, true); dv.setUint32(12, 48000, true); dv.setInt16(16, 0, true); h[18] = 0;
  return h;
}
function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("IDX CRO");
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  t.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(t.buffer).setUint32(8, vendor.length, true);
  t.set(vendor, 12);
  return t; // 0 comentários (já zerado)
}

export function webmOpusToOgg(webm: Uint8Array): Uint8Array {
  const w = parseWebmOpus(webm);
  const head = w.codecPrivate && new TextDecoder().decode(w.codecPrivate.subarray(0, 8)) === "OpusHead" ? w.codecPrivate : opusHead(w.channels);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages: Uint8Array[] = [oggPage([head], 0, serial, 0, 0x02), oggPage([opusTags()], 0, serial, 1, 0)];
  let seq = 2, granule = 0, group: Uint8Array[] = [], segs = 0;
  w.packets.forEach((p, i) => {
    const need = Math.floor(p.length / 255) + 1;
    if (group.length && segs + need > 255) { pages.push(oggPage(group, granule, serial, seq++, 0)); group = []; segs = 0; }
    group.push(p); segs += need; granule += opusPacketSamples(p);
    const last = i === w.packets.length - 1;
    if (last || group.length >= 50) { pages.push(oggPage(group, granule, serial, seq++, last ? 0x04 : 0)); group = []; segs = 0; }
  });
  const out = new Uint8Array(pages.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}
