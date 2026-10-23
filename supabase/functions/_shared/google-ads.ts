// Cliente mínimo da Google Ads API (REST) usado por google-oauth e google-ads.
//
// As versões v18–v21 já foram desativadas pelo Google (HTTP 404). A versão fica
// num lugar só e pode ser trocada pelo secret GOOGLE_ADS_API_VERSION sem deploy
// de código quando o Google desativar a atual.
export const GOOGLE_ADS_API_VERSION = (Deno.env.get("GOOGLE_ADS_API_VERSION") ?? "").trim() || "v25";
const API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

export function developerToken(): string {
  return (Deno.env.get("GOOGLE_DEVELOPER_TOKEN") ?? "").trim();
}

// Erros traduzidos para um código estável que o painel mostra com mensagem própria.
export type AdsErrorCode =
  | "developer_token_missing"
  | "developer_token_not_approved"
  | "developer_token_invalid"
  | "google_token_invalid"
  | "ads_api_disabled"
  | "ads_api_version_unsupported"
  | "permission_denied"
  | "customer_not_enabled"
  | "not_ads_user"
  | "quota_exceeded"
  | "ads_api_error";

export class GoogleAdsError extends Error {
  code: AdsErrorCode;
  status: number;
  detail: string;
  constructor(code: AdsErrorCode, status: number, detail: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function errorCodes(payload: unknown): string[] {
  const codes: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    const obj = value as Record<string, unknown>;
    if (obj.errorCode && typeof obj.errorCode === "object") {
      for (const code of Object.values(obj.errorCode as Record<string, unknown>)) codes.push(String(code));
    }
    for (const nested of Object.values(obj)) visit(nested);
  };
  visit(payload);
  return codes;
}

export function classifyAdsError(status: number, payload: unknown): GoogleAdsError {
  const body = Array.isArray(payload) ? payload[0] : payload;
  const error = (body as Record<string, any> | null)?.error ?? body ?? {};
  const message = String(error?.message ?? "");
  const codes = errorCodes(error);
  const detail = (codes.length ? `${codes.join(", ")}: ` : "") + message.slice(0, 300);
  const has = (code: string) => codes.includes(code);

  if (status === 404) return new GoogleAdsError("ads_api_version_unsupported", status, detail || `Versão ${GOOGLE_ADS_API_VERSION} indisponível`);
  if (has("DEVELOPER_TOKEN_NOT_APPROVED")) return new GoogleAdsError("developer_token_not_approved", status, detail);
  if (has("DEVELOPER_TOKEN_INVALID") || has("DEVELOPER_TOKEN_PROHIBITED") || has("DEVELOPER_TOKEN_PARAMETER_MISSING")) {
    return new GoogleAdsError("developer_token_invalid", status, detail);
  }
  if (/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message) || has("SERVICE_DISABLED")) {
    return new GoogleAdsError("ads_api_disabled", status, detail);
  }
  if (has("NOT_ADS_USER")) return new GoogleAdsError("not_ads_user", status, detail);
  if (has("CUSTOMER_NOT_ENABLED")) return new GoogleAdsError("customer_not_enabled", status, detail);
  if (has("USER_PERMISSION_DENIED") || has("CUSTOMER_NOT_FOUND")) return new GoogleAdsError("permission_denied", status, detail);
  if (status === 429 || has("RESOURCE_EXHAUSTED") || has("RESOURCE_TEMPORARILY_EXHAUSTED")) {
    return new GoogleAdsError("quota_exceeded", status, detail);
  }
  if (status === 401 || has("OAUTH_TOKEN_INVALID") || has("OAUTH_TOKEN_EXPIRED") || has("OAUTH_TOKEN_REVOKED")) {
    return new GoogleAdsError("google_token_invalid", status, detail);
  }
  if (status === 403) return new GoogleAdsError("permission_denied", status, detail);
  return new GoogleAdsError("ads_api_error", status, detail || `HTTP ${status}`);
}

function headers(accessToken: string, loginCustomerId?: string | null): Record<string, string> {
  const token = developerToken();
  if (!token) throw new GoogleAdsError("developer_token_missing", 0, "GOOGLE_DEVELOPER_TOKEN não configurado");
  const result: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": token,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) result["login-customer-id"] = cleanCustomerId(loginCustomerId);
  return result;
}

export function cleanCustomerId(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

// searchStream devolve todas as linhas da consulta em lotes (sem paginação manual).
export async function searchStream(
  accessToken: string,
  customerId: string,
  query: string,
  loginCustomerId?: string | null,
): Promise<Record<string, any>[]> {
  const res = await fetch(`${API_BASE}/customers/${cleanCustomerId(customerId)}/googleAds:searchStream`, {
    method: "POST",
    headers: headers(accessToken, loginCustomerId),
    body: JSON.stringify({ query }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw classifyAdsError(res.status, payload);
  const rows: Record<string, any>[] = [];
  for (const batch of Array.isArray(payload) ? payload : [payload]) {
    for (const row of batch?.results ?? []) rows.push(row);
  }
  return rows;
}

export async function adsPost(
  accessToken: string,
  path: string,
  body: unknown,
  loginCustomerId?: string | null,
): Promise<{ ok: boolean; status: number; payload: any }> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: headers(accessToken, loginCustomerId),
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, payload: await res.json().catch(() => null) };
}

export type AdsAccount = {
  id: string;
  name: string;
  manager: boolean;
  currency_code: string | null;
  time_zone: string | null;
  // Conta usada no cabeçalho login-customer-id: a MCC quando o acesso vem por ela,
  // a própria conta quando o acesso é direto.
  login_customer_id: string;
  via_manager_name: string | null;
};

const MAX_DIRECT_ACCOUNTS = 50;

// Contas que o usuário consegue consultar: as de acesso direto e, para cada MCC,
// as contas clientes (não-gerentes) ativas abaixo dela.
export async function listAccessibleAccounts(accessToken: string): Promise<AdsAccount[]> {
  const res = await fetch(`${API_BASE}/customers:listAccessibleCustomers`, {
    headers: headers(accessToken),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw classifyAdsError(res.status, payload);

  const ids = ((payload?.resourceNames ?? []) as string[])
    .map((name) => cleanCustomerId(name))
    .filter(Boolean)
    .slice(0, MAX_DIRECT_ACCOUNTS);

  const accounts = new Map<string, AdsAccount>();
  let firstError: GoogleAdsError | null = null;

  for (const id of ids) {
    let info: Record<string, any> | undefined;
    try {
      const rows = await searchStream(
        accessToken,
        id,
        "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
        id,
      );
      info = rows[0]?.customer;
    } catch (err) {
      // Conta cancelada/sem permissão não derruba a listagem das outras.
      if (err instanceof GoogleAdsError) {
        if (["developer_token_not_approved", "developer_token_invalid", "ads_api_disabled", "google_token_invalid", "ads_api_version_unsupported"].includes(err.code)) {
          throw err;
        }
        firstError ??= err;
        continue;
      }
      throw err;
    }
    if (!info) continue;

    const account: AdsAccount = {
      id,
      name: info.descriptiveName || `Conta ${id}`,
      manager: Boolean(info.manager),
      currency_code: info.currencyCode ?? null,
      time_zone: info.timeZone ?? null,
      login_customer_id: id,
      via_manager_name: null,
    };
    if (!accounts.has(id)) accounts.set(id, account);

    if (account.manager) {
      try {
        const children = await searchStream(
          accessToken,
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code, customer_client.time_zone, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'",
          id,
        );
        for (const row of children) {
          const child = row.customerClient ?? {};
          const childId = cleanCustomerId(child.id);
          if (!childId || accounts.has(childId)) continue;
          accounts.set(childId, {
            id: childId,
            name: child.descriptiveName || `Conta ${childId}`,
            manager: false,
            currency_code: child.currencyCode ?? null,
            time_zone: child.timeZone ?? null,
            login_customer_id: id,
            via_manager_name: account.name,
          });
        }
      } catch (err) {
        if (err instanceof GoogleAdsError) firstError ??= err;
        else throw err;
      }
    }
  }

  if (!accounts.size && firstError) throw firstError;
  return Array.from(accounts.values());
}

export function selectableAccounts(accounts: AdsAccount[]): AdsAccount[] {
  return accounts.filter((account) => !account.manager);
}

export function lastNDays(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function syncRange(body: Record<string, unknown>): { start: string; end: string } {
  const since = String(body.since ?? "");
  const until = String(body.until ?? "");
  if (DATE_RE.test(since) && DATE_RE.test(until) && since <= until) return { start: since, end: until };
  const days = Math.min(Math.max(Number(body.days ?? 30), 1), 365);
  return lastNDays(days);
}

// Linhas diárias por campanha no período. Campanhas sem impressão no período
// não geram linha (a API só devolve dias com métrica).
export const CAMPAIGN_METRICS_QUERY = (start: string, end: string) => `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    customer.id,
    customer.descriptive_name,
    metrics.impressions,
    metrics.clicks,
    metrics.cost_micros,
    metrics.ctr,
    metrics.average_cpc,
    metrics.conversions,
    metrics.conversions_value,
    metrics.all_conversions,
    metrics.cost_per_conversion,
    segments.date
  FROM campaign
  WHERE segments.date BETWEEN '${start}' AND '${end}'
    AND campaign.status != 'REMOVED'
`;

export const CAMPAIGN_COUNT_QUERY = "SELECT campaign.id, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'";

export function insightRow(tenantId: string, customerId: string, result: Record<string, any>): Record<string, unknown> | null {
  const campaign = result.campaign ?? {};
  const customer = result.customer ?? {};
  const metrics = result.metrics ?? {};
  const date = result.segments?.date;
  const campaignId = campaign.id != null ? String(campaign.id) : "";
  if (!date || !campaignId) return null;
  const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
  return {
    tenant_id: tenantId,
    customer_id: cleanCustomerId(customer.id ?? customerId),
    customer_name: customer.descriptiveName ?? null,
    campaign_id: campaignId,
    campaign_name: campaign.name ?? `Campanha ${campaignId}`,
    campaign_status: campaign.status ?? null,
    campaign_type: campaign.advertisingChannelType ?? null,
    date,
    impressions: num(metrics.impressions) ?? 0,
    clicks: num(metrics.clicks) ?? 0,
    cost_micros: num(metrics.costMicros) ?? 0,
    ctr: num(metrics.ctr),
    average_cpc_micros: num(metrics.averageCpc) == null ? null : Math.round(Number(metrics.averageCpc)),
    conversions: num(metrics.conversions) ?? 0,
    cost_per_conversion_micros: num(metrics.costPerConversion) == null ? null : Math.round(Number(metrics.costPerConversion)),
    raw: result,
    synced_at: new Date().toISOString(),
  };
}
