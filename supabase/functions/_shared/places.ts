// Google Places API (New) — Text Search. Funções puras + chamada HTTP (testadas em tests/fn/places.test.ts)

export const PLACES_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.nationalPhoneNumber",
  "places.internationalPhoneNumber", "places.rating", "places.userRatingCount", "places.websiteUri",
  "places.googleMapsUri", "places.businessStatus", "places.addressComponents", "nextPageToken",
].join(",");

export type Place = {
  place_id: string; name: string; phone: string | null; address: string | null; city: string | null; uf: string | null;
  district: string | null; rating: number | null; reviews: number | null; rank: number; location: string;
  maps_url: string | null; website: string | null;
};

type Comp = { longText?: string; shortText?: string; types?: string[] };

function comp(c: Comp[] | undefined, type: string, short = false): string | null {
  const x = (c ?? []).find((k) => k.types?.includes(type));
  return (short ? x?.shortText : x?.longText) ?? null;
}

/** Converte a resposta do Google no formato gravado no discador. Ignora fechados. */
export function parsePlaces(json: any, location: string, startRank: number): { places: Place[]; closed: number; next: string | null } {
  const out: Place[] = [];
  let closed = 0;
  let rank = startRank;
  for (const p of json?.places ?? []) {
    rank++;
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") { closed++; continue; }
    const c: Comp[] = p.addressComponents ?? [];
    out.push({
      place_id: String(p.id ?? ""),
      name: String(p.displayName?.text ?? "").trim(),
      phone: p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? null,
      address: p.formattedAddress ?? null,
      city: comp(c, "administrative_area_level_2") ?? comp(c, "locality"),
      uf: comp(c, "administrative_area_level_1", true),
      district: comp(c, "sublocality_level_1") ?? comp(c, "sublocality"),
      rating: typeof p.rating === "number" ? p.rating : null,
      reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      rank,
      location,
      maps_url: p.googleMapsUri ?? null,
      website: p.websiteUri ?? null,
    });
  }
  return { places: out, closed, next: json?.nextPageToken ?? null };
}

/** Texto da busca: "farmácia em Moema, São Paulo SP" */
export function textQuery(query: string, location: string) {
  const q = query.trim();
  const l = location.trim();
  return /\b(em|in|perto de|near)\b/i.test(q) || !l ? q : `${q} em ${l}`;
}

/** Mensagem clara para erros comuns do Google */
export function googleError(status: number, body: any): string {
  const msg = String(body?.error?.message ?? body?.message ?? "");
  const reason = JSON.stringify(body?.error?.details ?? "");
  if (/API_KEY_INVALID|API key not valid/i.test(msg + reason)) return "Chave do Google inválida. Confira a chave em Disparos → Buscar clientes → Configurar.";
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(msg + reason)) return "A “Places API (New)” não está ativada no projeto do Google Cloud desta chave.";
  if (/BILLING|billing/i.test(msg + reason)) return "O projeto do Google Cloud precisa de uma conta de faturamento ativa (a cota gratuita continua valendo).";
  if (status === 429) return "O Google limitou as buscas por agora (muitas chamadas). Tente mais tarde.";
  if (status === 403) return `O Google recusou a busca: ${msg || "acesso negado"}`;
  return `Erro do Google (${status}): ${msg || "falha desconhecida"}`;
}

export class PlacesError extends Error {}

export async function searchText(opts: {
  apiKey: string; query: string; location: string; pageToken?: string | null; baseUrl?: string;
}) {
  const res = await fetch(`${opts.baseUrl ?? "https://places.googleapis.com"}/v1/places:searchText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": PLACES_FIELDS },
    body: JSON.stringify({
      textQuery: textQuery(opts.query, opts.location), languageCode: "pt-BR", regionCode: "BR", pageSize: 20,
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlacesError(googleError(res.status, body));
  return body;
}
