import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";
import {
  adsPost,
  CAMPAIGN_COUNT_QUERY,
  CAMPAIGN_METRICS_QUERY,
  classifyAdsError,
  cleanCustomerId,
  developerToken,
  GOOGLE_ADS_API_VERSION,
  GoogleAdsError,
  insightRow,
  listAccessibleAccounts,
  searchStream,
  selectableAccounts,
  syncRange,
} from "../_shared/google-ads.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

type Creds = Record<string, any>;
type AdsToken = { accessToken: string; customerId: string | null; loginCustomerId: string | null };

async function loadCreds(tenantId: string): Promise<Creds | null> {
  const { data } = await supa.from("tenant_google_credentials").select("*").eq("tenant_id", tenantId).maybeSingle();
  return data ?? null;
}

// Etapa real da integração. "Google autorizado" não é o mesmo que "conta Ads
// vinculada" nem que "dados sincronizados".
function connectionStage(creds: Creds | null): string {
  if (!creds || !creds.enabled || !creds.refresh_token) return "not_connected";
  if (creds.integration_status === "needs_attention") return "needs_attention";
  if (!creds.customer_id) return "needs_account";
  if (!creds.last_synced_at) return "account_selected";
  return "synced";
}

// Campos seguros para o painel: nunca tokens.
function publicCreds(creds: Creds | null) {
  if (!creds) return null;
  return {
    customer_id: creds.customer_id ?? null,
    customer_descriptive_name: creds.customer_descriptive_name ?? null,
    manager_customer_id: creds.manager_customer_id ?? null,
    google_user_email: creds.google_user_email ?? null,
    integration_status: creds.integration_status,
    enabled: creds.enabled,
    last_synced_at: creds.last_synced_at ?? null,
    last_verified_at: creds.last_verified_at ?? null,
    last_error: creds.last_error ?? null,
    currency_code: creds.currency_code ?? null,
    time_zone: creds.time_zone ?? null,
    stage: connectionStage(creds),
  };
}

async function markError(tenantId: string, err: GoogleAdsError, needsAttention: boolean) {
  await supa.from("tenant_google_credentials").update({
    ...(needsAttention ? { integration_status: "needs_attention" } : {}),
    last_error: `${err.code}: ${err.detail}`.slice(0, 1000),
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);
}

// Erros que exigem ação fora do painel (token, API, permissão) deixam a
// integração em "needs_attention"; limite de cota não.
function needsAttention(code: string): boolean {
  return code !== "quota_exceeded" && code !== "ads_api_error";
}

function adsErrorResponse(err: GoogleAdsError): Response {
  return json({ error: err.code, detail: err.detail, api_version: GOOGLE_ADS_API_VERSION }, err.code === "quota_exceeded" ? 429 : 400);
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | { error: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return { error: String(data.error ?? `HTTP ${res.status}`) };
  return { access_token: data.access_token, expires_in: Number(data.expires_in ?? 3600) };
}

// Access token válido (renova pelo refresh_token). Não exige conta vinculada:
// listar contas precisa funcionar justamente antes da escolha.
async function getAdsToken(tenantId: string, creds: Creds | null): Promise<AdsToken | Response> {
  if (!creds?.enabled || !creds.refresh_token) return json({ error: "google_not_connected" }, 400);

  let accessToken = creds.access_token as string | null;
  const expiresAt = creds.token_expires_at ? new Date(creds.token_expires_at).getTime() : 0;
  if (!accessToken || Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(creds.refresh_token);
    if ("error" in refreshed) {
      const err = new GoogleAdsError("google_token_invalid", 401, `Falha ao renovar o token do Google (${refreshed.error}). Conecte o Google Ads de novo.`);
      await markError(tenantId, err, true);
      return adsErrorResponse(err);
    }
    accessToken = refreshed.access_token;
    await supa.from("tenant_google_credentials").update({
      access_token: accessToken,
      token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
  }

  const customerId = creds.customer_id ? cleanCustomerId(creds.customer_id) : null;
  const loginCustomerId = creds.manager_customer_id ? cleanCustomerId(creds.manager_customer_id) : customerId;
  return { accessToken: accessToken!, customerId, loginCustomerId };
}

async function campaignRoi(tenantId: string) {
  const { data } = await supa
    .from("vw_google_campaign_roi")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("spend", { ascending: false })
    .limit(200);
  return data ?? [];
}

// GET: status da conexão (sem tokens) + campanhas já importadas
async function handleGet(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) {
    return json({ error: "forbidden" }, 403);
  }

  const creds = await loadCreds(tenantId);
  const { data: conversionActions } = await supa
    .from("tenant_google_conversion_actions")
    .select("*")
    .eq("tenant_id", tenantId);

  return json({
    ok: true,
    credentials: publicCreds(creds),
    developer_token_configured: Boolean(developerToken()),
    api_version: GOOGLE_ADS_API_VERSION,
    campaigns: await campaignRoi(tenantId),
    conversion_actions: conversionActions ?? [],
  });
}

// POST: sync_campaigns, list_customers, select_customer, upload_conversion,
// list_conversion_actions, save_conversion_actions, disconnect
async function handlePost(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "sync_campaigns");
  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  const readActions = ["sync_campaigns", "list_customers", "list_conversion_actions"];
  const writeActions = ["select_customer", "upload_conversion", "save_conversion_actions", "disconnect"];

  if (readActions.includes(action)) {
    if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) {
      return json({ error: "forbidden" }, 403);
    }
  } else if (writeActions.includes(action)) {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }
  } else {
    return json({ error: "unknown_action" }, 400);
  }

  if (action === "disconnect") return handleDisconnect(tenantId);
  if (action === "save_conversion_actions") return handleSaveConversionActions(tenantId, body);

  if (!developerToken()) return json({ error: "developer_token_missing" }, 400);

  const creds = await loadCreds(tenantId);
  const token = await getAdsToken(tenantId, creds);
  if (token instanceof Response) return token;

  try {
    if (action === "list_customers") return await handleListCustomers(tenantId, creds!, token);
    if (action === "select_customer") return await handleSelectCustomer(tenantId, creds!, token, body);

    if (!token.customerId) return json({ error: "google_account_not_selected" }, 400);
    if (action === "sync_campaigns") return await handleSyncCampaigns(tenantId, token, body);
    if (action === "list_conversion_actions") return await handleListConversionActions(token);
    if (action === "upload_conversion") return await handleUploadConversion(tenantId, token, body);
  } catch (err) {
    if (err instanceof GoogleAdsError) {
      await markError(tenantId, err, needsAttention(err.code));
      return adsErrorResponse(err);
    }
    throw err;
  }

  return json({ error: "unknown_action" }, 400);
}

async function handleSyncCampaigns(tenantId: string, token: AdsToken, body: Record<string, unknown>): Promise<Response> {
  const range = syncRange(body);
  const customerId = token.customerId!;

  const results = await searchStream(token.accessToken, customerId, CAMPAIGN_METRICS_QUERY(range.start, range.end), token.loginCustomerId);
  const rows = results
    .map((result) => insightRow(tenantId, customerId, result))
    .filter((row): row is Record<string, unknown> => Boolean(row));

  // Upsert pela chave única (tenant, conta, campanha, dia): sincronizar de novo
  // atualiza os números do dia em vez de duplicar.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supa.from("google_campaign_insights").upsert(rows.slice(i, i + 500), {
      onConflict: "tenant_id,customer_id,campaign_id,date",
    });
    if (error) return json({ error: "save_failed", detail: error.message }, 500);
  }

  // A empresa tem uma conta vinculada: métricas de outra conta (vínculo antigo)
  // não podem somar no relatório.
  await supa.from("google_campaign_insights").delete().eq("tenant_id", tenantId).neq("customer_id", customerId);

  // Distingue "conta sem campanhas" de "campanhas sem dados no período".
  const allCampaigns = await searchStream(token.accessToken, customerId, CAMPAIGN_COUNT_QUERY, token.loginCustomerId);
  const campaignsWithData = new Set(rows.map((row) => row.campaign_id)).size;

  const now = new Date().toISOString();
  await supa.from("tenant_google_credentials").update({
    integration_status: "connected",
    last_error: null,
    last_synced_at: now,
    last_verified_at: now,
    updated_at: now,
  }).eq("tenant_id", tenantId);

  return json({
    ok: true,
    synced: rows.length,
    range,
    campaigns_in_account: allCampaigns.length,
    campaigns_with_data: campaignsWithData,
    last_synced_at: now,
    campaigns: await campaignRoi(tenantId),
  });
}

async function handleListCustomers(tenantId: string, creds: Creds, token: AdsToken): Promise<Response> {
  const accounts = await listAccessibleAccounts(token.accessToken);
  // A API respondeu: o problema anterior (token, API desativada...) foi resolvido.
  if (creds.integration_status === "needs_attention") {
    await supa.from("tenant_google_credentials").update({
      integration_status: "connected",
      last_error: null,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
  }
  return json({
    ok: true,
    customers: selectableAccounts(accounts),
    managers: accounts.filter((account) => account.manager).map(({ id, name }) => ({ id, name })),
  });
}

// Vincula a conta escolhida à empresa. Só aceita contas que este login do
// Google realmente acessa, e guarda a MCC certa para o login-customer-id.
async function handleSelectCustomer(tenantId: string, creds: Creds, token: AdsToken, body: Record<string, unknown>): Promise<Response> {
  const customerId = cleanCustomerId(body.customer_id);
  if (!customerId) return json({ error: "missing_customer_id" }, 400);

  const accounts = selectableAccounts(await listAccessibleAccounts(token.accessToken));
  const account = accounts.find((item) => item.id === customerId);
  if (!account) return json({ error: "customer_not_accessible" }, 400);

  const previous = creds.customer_id ? cleanCustomerId(creds.customer_id) : null;
  const now = new Date().toISOString();
  const { error } = await supa.from("tenant_google_credentials").update({
    customer_id: account.id,
    customer_descriptive_name: account.name,
    manager_customer_id: account.login_customer_id !== account.id ? account.login_customer_id : null,
    currency_code: account.currency_code ?? creds.currency_code ?? "BRL",
    time_zone: account.time_zone ?? creds.time_zone ?? "America/Sao_Paulo",
    integration_status: "connected",
    last_error: null,
    last_synced_at: previous === account.id ? creds.last_synced_at : null,
    last_verified_at: now,
    updated_at: now,
  }).eq("tenant_id", tenantId);
  if (error) return json({ error: "save_failed", detail: error.message }, 500);

  // Trocou de conta: remove as métricas da conta anterior para o relatório da
  // empresa não somar duas contas.
  await supa.from("google_campaign_insights").delete().eq("tenant_id", tenantId).neq("customer_id", account.id);

  return json({ ok: true, customer: account });
}

async function handleListConversionActions(token: AdsToken): Promise<Response> {
  const results = await searchStream(
    token.accessToken,
    token.customerId!,
    "SELECT conversion_action.id, conversion_action.name, conversion_action.resource_name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
    token.loginCustomerId,
  );
  const actions = results
    .map((result) => result.conversionAction)
    .filter(Boolean)
    .map((ca: Record<string, any>) => ({
      id: String(ca.id),
      name: ca.name ?? "",
      resourceName: ca.resourceName ?? "",
      type: ca.type ?? "",
    }));
  return json({ ok: true, conversion_actions: actions });
}

async function handleSaveConversionActions(tenantId: string, body: Record<string, unknown>): Promise<Response> {
  const mappings = body.mappings as Array<{
    event_type: string;
    conversion_action_resource: string;
    conversion_action_name: string;
    auto_send: boolean;
  }> | undefined;

  if (!mappings || !Array.isArray(mappings)) return json({ error: "missing_mappings" }, 400);

  const validTypes = ["qualified", "appointment", "sale"];
  for (const m of mappings) {
    if (!validTypes.includes(m.event_type)) return json({ error: `invalid_event_type: ${m.event_type}` }, 400);
  }

  // Delete existing and re-insert
  await supa.from("tenant_google_conversion_actions").delete().eq("tenant_id", tenantId);

  if (mappings.length > 0) {
    const rows = mappings.map((m) => ({
      tenant_id: tenantId,
      conversion_action_resource: m.conversion_action_resource,
      conversion_action_name: m.conversion_action_name,
      event_type: m.event_type,
      auto_send: m.auto_send ?? false,
    }));

    const { error } = await supa.from("tenant_google_conversion_actions").insert(rows);
    if (error) return json({ error: error.message }, 500);
  }

  return json({ ok: true });
}

async function handleUploadConversion(tenantId: string, token: AdsToken, body: Record<string, unknown>): Promise<Response> {
  const sessionId = body.tracking_session_id ? String(body.tracking_session_id) : null;
  const eventType = String(body.event_type ?? "");
  const conversionValue = body.conversion_value != null ? Number(body.conversion_value) : null;

  if (!eventType) return json({ error: "missing_event_type" }, 400);

  const { data: actionConfig } = await supa
    .from("tenant_google_conversion_actions")
    .select("conversion_action_resource")
    .eq("tenant_id", tenantId)
    .eq("event_type", eventType)
    .maybeSingle();

  if (!actionConfig) return json({ error: "no_conversion_action_configured" }, 400);

  let gclid: string | null = null;
  let gbraid: string | null = null;
  let wbraid: string | null = null;

  if (sessionId) {
    const { data: session } = await supa
      .from("tracking_sessions")
      .select("gclid, gbraid, wbraid")
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (session) {
      gclid = session.gclid;
      gbraid = session.gbraid;
      wbraid = session.wbraid;
    }
  } else {
    gclid = body.gclid ? String(body.gclid) : null;
    gbraid = body.gbraid ? String(body.gbraid) : null;
    wbraid = body.wbraid ? String(body.wbraid) : null;
  }

  if (!gclid && !gbraid && !wbraid) {
    return json({ error: "no_click_identifier", detail: "gclid, gbraid or wbraid required for offline conversion" }, 400);
  }

  const { data: googleCreds } = await supa
    .from("tenant_google_credentials")
    .select("currency_code")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const currencyCode = googleCreds?.currency_code ?? "BRL";
  const conversionDateTime = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00");

  const conversion: Record<string, unknown> = {
    conversionAction: actionConfig.conversion_action_resource,
    conversionDateTime,
    currencyCode,
    conversionValue: conversionValue != null && conversionValue > 0 ? conversionValue : 0,
  };
  if (gclid) conversion.gclid = gclid;
  if (gbraid) conversion.gbraid = gbraid;
  if (wbraid) conversion.wbraid = wbraid;

  const upload = await adsPost(
    token.accessToken,
    `customers/${token.customerId}:uploadClickConversions`,
    { conversions: [conversion], partialFailure: true },
    token.loginCustomerId,
  );
  const ok = upload.ok && !upload.payload?.partialFailureError;
  const failure = ok ? null : (upload.ok ? null : classifyAdsError(upload.status, upload.payload));

  await supa.from("google_conversion_uploads").insert({
    tenant_id: tenantId,
    tracking_session_id: sessionId,
    customer_id: token.customerId,
    conversion_action: actionConfig.conversion_action_resource,
    gclid,
    gbraid,
    wbraid,
    conversion_date_time: conversionDateTime,
    conversion_value: conversionValue,
    currency_code: currencyCode,
    event_type: eventType,
    status: ok ? "sent" : "failed",
    response_payload: upload.payload,
    error_message: ok ? null : JSON.stringify(upload.payload?.partialFailureError ?? failure?.detail ?? "unknown").slice(0, 1000),
    sent_at: ok ? new Date().toISOString() : null,
  });

  if (!ok) {
    return json({
      error: failure?.code ?? "conversion_upload_failed",
      detail: upload.payload?.partialFailureError?.message ?? failure?.detail,
    }, 400);
  }

  return json({ ok: true, result: upload.payload });
}

async function handleDisconnect(tenantId: string): Promise<Response> {
  await supa.from("tenant_google_credentials").update({
    integration_status: "not_connected",
    enabled: false,
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);

  await supa.from("tenant_onboarding").update({ google_connected: false }).eq("tenant_id", tenantId);

  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return handleGet(req);
  if (req.method === "POST") return handlePost(req);
  return json({ error: "method_not_allowed" }, 405);
});
