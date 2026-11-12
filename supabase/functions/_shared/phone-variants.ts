/** Formas equivalentes de um telefone BR (com/sem 55, com/sem o 9º dígito), para casar registros gravados em formatos diferentes. */
export function phoneVariants(raw: string): string[] {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return [];
  const national = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  const forms = new Set<string>([national]);
  if (national.length === 11 && national[2] === "9") forms.add(national.slice(0, 2) + national.slice(3));
  if (national.length === 10 && /[6-9]/.test(national[2])) forms.add(national.slice(0, 2) + "9" + national.slice(2));
  const out = new Set<string>([digits]);
  for (const f of forms) { out.add(f); out.add(`55${f}`); }
  return [...out];
}
