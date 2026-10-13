export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  return digits;
}

export function extractWaId(remoteJid: string): string {
  return remoteJid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
}

export function isGroupJid(remoteJid: string): boolean {
  return remoteJid.endsWith("@g.us");
}
