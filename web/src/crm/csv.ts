// CSV: exportação (compatível com Excel pt-BR: ';' + BOM) e leitura tolerante.

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(";"), ...rows.map((r) => headers.map((h) => esc(r[h])).join(";"))].join("\r\n");
}

export function downloadCsv(fileName: string, rows: Record<string, unknown>[]) {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ";": (firstLine.match(/;/g) ?? []).length, ",": (firstLine.match(/,/g) ?? []).length, "\t": (firstLine.match(/\t/g) ?? []).length };
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows };
}

// Sugere o campo do CRM a partir do nome da coluna
const aliases: Record<string, string[]> = {
  name: ["nome", "name", "cliente", "contato", "nome completo", "full name"],
  phone: ["telefone", "phone", "celular", "whatsapp", "fone", "tel", "mobile"],
  email: ["email", "e-mail", "mail"],
  company: ["empresa", "company", "organizacao", "organização", "razao social", "razão social"],
  job_title: ["cargo", "job title", "funcao", "função"],
  city: ["cidade", "city"],
  state: ["estado", "uf", "state"],
  tags: ["tags", "etiquetas", "marcadores"],
  source: ["origem", "source", "canal", "fonte"],
  utm_source: ["utm_source"],
  utm_medium: ["utm_medium"],
  utm_campaign: ["utm_campaign", "campanha"],
  notes: ["observacoes", "observações", "notas", "notes", "obs"],
  owner_email: ["responsavel", "responsável", "owner", "vendedor", "email do responsavel"],
  title: ["negociacao", "negociação", "deal", "oportunidade", "titulo", "título"],
  value: ["valor", "value", "amount", "preco", "preço"],
  stage: ["etapa", "stage", "fase", "status"],
  expected_close_date: ["fechamento", "data de fechamento", "close date", "previsao", "previsão"],
};

export function guessField(header: string): string {
  const h = header.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  for (const [field, list] of Object.entries(aliases)) {
    if (list.some((a) => a.normalize("NFD").replace(/[̀-ͯ]/g, "") === h)) return field;
  }
  return "";
}
