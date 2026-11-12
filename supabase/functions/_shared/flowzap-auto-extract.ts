// Extrator automático do FlowZap original (src/app/api/leads/auto-extract/route.ts),
// copiado sem mudanças de lógica: mesmas 7 buscas, mesmos campos pedidos ao Google,
// até 3 páginas por busca (2 s entre páginas) e limite de 120 clientes.
// Única adaptação: o endereço da API pode ser trocado nos testes (baseUrl) e cada
// chamada é avisada (onCall) para o CRO contar na cota mensal.

export interface GooglePlace {
  displayName?: { text: string };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  formattedAddress?: string;
}

export interface Lead {
  name: string;
  phone: string;
  address?: string;
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.startsWith("55") && digits.length >= 12) return "+" + digits;
  if (digits.length === 10 || digits.length === 11) return "+55" + digits;
  return "+" + digits;
}

export function placeToLead(place: GooglePlace): Lead | null {
  const raw = place.internationalPhoneNumber || place.nationalPhoneNumber;
  if (!raw) return null;
  const phone = normalizePhone(raw);
  if (!phone) return null;
  return {
    name: place.displayName?.text || "",
    phone,
    address: place.formattedAddress,
  };
}

export async function searchPlaces(
  apiKey: string,
  query: string,
  pageToken?: string,
  baseUrl = "https://places.googleapis.com",
  timeoutMs = 15_000,
): Promise<{ places: GooglePlace[]; nextToken?: string; error?: string }> {
  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "pt-BR",
  };
  if (pageToken) body.pageToken = pageToken;

  try {
    const res = await fetch(`${baseUrl}/v1/places:searchText`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs), // CRO: uma busca travada não segura a extração inteira
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.formattedAddress,nextPageToken",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[auto-extract] Google Places error:", res.status, text.slice(0, 300));
      let msg = `Google respondeu ${res.status}`;
      try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* texto */ }
      return { places: [], error: msg };
    }

    const data = await res.json();
    return {
      places: data.places || [],
      nextToken: data.nextPageToken,
    };
  } catch (e) {
    console.error("[auto-extract] fetch error:", e);
    return { places: [], error: "Falha de conexão com o Google" };
  }
}

export function buildQueries(ramo: string, cidade: string): string[] {
  return [
    `${ramo} em ${cidade}`,
    `${ramo} ${cidade}`,
    `melhores ${ramo} em ${cidade}`,
    `${ramo} perto de ${cidade}`,
    `${ramo} centro ${cidade}`,
    `${ramo} zona sul ${cidade}`,
    `${ramo} zona norte ${cidade}`,
  ];
}

/** O laço de busca do original, sem mudanças. */
export async function collectLeads(
  apiKey: string, ramo: string, cidade: string,
  opts: { baseUrl?: string; pageDelayMs?: number; onCall?: () => Promise<boolean>; deadlineMs?: number } = {},
): Promise<{ leads: Lead[]; calls: number; errors: string[]; timedOut: boolean }> {
  let timedOut = false;
  const allLeads = new Map<string, Lead>();
  const queries = buildQueries(ramo.trim(), cidade.trim());
  const errors: string[] = [];
  let calls = 0;
  const call = async (q: string, token?: string) => {
    // CRO: termina com o que já achou antes do limite de tempo da função (sem perder a extração)
    if (opts.deadlineMs && Date.now() > opts.deadlineMs) { timedOut = true; return null; }
    if (opts.onCall && !(await opts.onCall())) return null; // cota mensal do CRO acabou
    calls++;
    const r = await searchPlaces(apiKey, q, token, opts.baseUrl);
    if (r.error) errors.push(r.error);
    return r;
  };

  for (const query of queries) {
    if (allLeads.size >= 120) break;

    let result = await call(query);
    if (!result) break;
    for (const p of result.places) {
      const lead = placeToLead(p);
      if (lead && !allLeads.has(lead.phone)) allLeads.set(lead.phone, lead);
    }

    let pages = 1;
    while (result.nextToken && pages < 3 && allLeads.size < 120) {
      await new Promise((r) => setTimeout(r, opts.pageDelayMs ?? 2000));
      const next = await call(query, result.nextToken);
      if (!next) break;
      result = next;
      for (const p of result.places) {
        const lead = placeToLead(p);
        if (lead && !allLeads.has(lead.phone)) allLeads.set(lead.phone, lead);
      }
      pages++;
    }
    // chave inválida/sem faturamento: para na primeira busca, como mensagem clara
    if (errors.length && allLeads.size === 0 && calls === 1) break;
  }
  return { leads: Array.from(allLeads.values()), calls, errors, timedOut };
}
