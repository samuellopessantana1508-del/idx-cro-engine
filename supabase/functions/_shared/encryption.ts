const ALGO = "AES-GCM";
const IV_LEN = 12;

function getKey(): string {
  const raw = Deno.env.get("ENCRYPTION_KEY") ?? "";
  if (!raw || raw.length < 32) throw new Error("ENCRYPTION_KEY not set or too short (min 32 hex chars)");
  return raw;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importKey(hex: string): Promise<CryptoKey> {
  const raw = hexToBytes(hex.substring(0, 64));
  return crypto.subtle.importKey("raw", raw, { name: ALGO }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await importKey(getKey());
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LEN);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(encoded: string): Promise<string> {
  const key = await importKey(getKey());
  const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, IV_LEN);
  const ciphertext = raw.slice(IV_LEN);
  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

export function isEncryptionConfigured(): boolean {
  const raw = Deno.env.get("ENCRYPTION_KEY") ?? "";
  return raw.length >= 32;
}
