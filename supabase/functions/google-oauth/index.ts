import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { developerToken, GOOGLE_ADS_API_VERSION, GoogleAdsError, listAccessibleAccounts, selectableAccounts } from "../_shared/google-ads.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// URL pública do painel. Valores antigos de APP_URL apontando para o domínio
// desativado são ignorados.
const DEFAULT_APP_URL = "https://cro.sanmarfidelize.com";
const RETIRED_HOSTS = new Set(["idxparasuaempresa.com.br", "www.idxparasuaempresa.com.br"]);

function publicAppUrl(): string {
  try {
    const url = new URL(String(Deno.env.get("APP_URL") ?? "").trim());
    if (url.protocol === "https:" && !RETIRED_HOSTS.has(url.hostname.toLowerCase())) return url.origin;
  } catch {
    // usa o padrão
  }
  return DEFAULT_APP_URL;
}

// Só aceita voltar para o próprio painel (evita redirecionar para outro site).
function safeReturnUrl(candidate: unknown, fallbackPath: string): URL {
  const app = new URL(publicAppUrl());
  try {
    const url = new URL(String(candidate ?? ""), app);
    if (url.origin === app.origin) return url;
  } catch {
    // cai no padrão
  }
  return new URL(fallbackPath, app);
}

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
// O callback é esta mesma função (GET). Precisa ser idêntica em
// "URIs de redirecionamento autorizados" do cliente OAuth no Google Cloud.
const GOOGLE_REDIRECT_URI = (Deno.env.get("GOOGLE_REDIRECT_URI") ?? "").trim() ||
  `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/google-oauth`;
const appUrl = publicAppUrl();
const GOOGLE_SCOPES = Deno.env.get("GOOGLE_OAUTH_SCOPES") ?? "https://www.googleapis.com/auth/adwords openid email profile";

// Volta para o painel na tela do Google Ads com ?google=<resultado>.
function backToPanel(returnTo: unknown, result: string, reason?: string): Response {
  const url = safeReturnUrl(returnTo, "/?section=google-ads");
  url.searchParams.set("section", "google-ads");
  url.searchParams.set("google", result);
  if (reason) url.searchParams.set("reason", reason);
  else url.searchParams.delete("reason");
  return Response.redirect(url.toString(), 302);
}

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

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// POST: Initiate Google OAuth — returns auth URL
async function handlePost(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
    return json({ error: "forbidden" }, 403);
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "google_oauth_not_configured" }, 500);
  }

  const state = randomState();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const redirectTo = safeReturnUrl(body.redirect_to, "/?section=google-ads").toString();

  const { error: stateError } = await supa.from("integration_oauth_states").insert({
    tenant_id: tenantId,
    user_id: user.id,
    provider: "google",
    state,
    redirect_to: redirectTo,
    expires_at: expiresAt,
  });

  if (stateError) return json({ error: stateError.message }, 500);

  const scopes = GOOGLE_SCOPES;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return json({ ok: true, auth_url: authUrl.toString(), client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI });
}

// GET: OAuth callback — exchange code for tokens, store credentials
async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Diagnóstico sem segredo: Client ID efetivo (público, vai em toda URL de
  // autorização), número do projeto Google dono dele e redirect_uri.
  if (url.searchParams.get("check") === "1") {
    return json({
      ok: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      client_id: GOOGLE_CLIENT_ID || null,
      google_cloud_project_number: GOOGLE_CLIENT_ID.split("-")[0] || null,
      redirect_uri: GOOGLE_REDIRECT_URI,
      redirect_uri_from_secret: Boolean((Deno.env.get("GOOGLE_REDIRECT_URI") ?? "").trim()),
      scopes: GOOGLE_SCOPES.split(/\s+/),
      client_secret_set: Boolean(GOOGLE_CLIENT_SECRET),
      developer_token_set: Boolean(developerToken()),
      google_ads_api_version: GOOGLE_ADS_API_VERSION,
      app_url: appUrl,
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Consome o state uma única vez (atômico) e recupera a página de volta.
  const claimState = async () => {
    if (!state) return null;
    const { data } = await supa
      .from("integration_oauth_states")
      .update({ used_at: new Date().toISOString() })
      .eq("state", state)
      .eq("provider", "google")
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("*")
      .maybeSingle();
    return data ?? null;
  };

  if (error) {
    const denied = await claimState();
    return backToPanel(denied?.redirect_to, "error", error);
  }

  if (!code || !state) return backToPanel(null, "error", "missing_params");

  const oauthState = await claimState();
  if (!oauthState) return backToPanel(null, "error", "invalid_state");

  const tenantId = oauthState.tenant_id;

  // Exchange authorization code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenData?.access_token) {
    await supa.from("tenant_google_credentials").update({
      integration_status: "needs_attention",
      last_error: JSON.stringify({ step: "code_exchange", redirect_uri: GOOGLE_REDIRECT_URI, detail: tokenData }).slice(0, 1000),
      last_verified_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
    return backToPanel(oauthState.redirect_to, "error", "token_exchange_failed");
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token ?? null;
  const expiresIn = tokenData.expires_in ?? 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Get Google user info
  const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const userInfo = await userInfoRes.json().catch(() => ({}));

  // Credenciais atuais: reconectar não pode apagar refresh_token nem a conta
  // já vinculada (o Google só manda refresh_token no primeiro consentimento).
  const { data: current } = await supa
    .from("tenant_google_credentials")
    .select("refresh_token, customer_id, customer_descriptive_name, manager_customer_id, currency_code, time_zone")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const storedRefreshToken = refreshToken ?? current?.refresh_token ?? null;
  if (!storedRefreshToken) {
    // Sem refresh_token não dá para sincronizar depois que o access token vencer.
    return backToPanel(oauthState.redirect_to, "error", "missing_refresh_token");
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await supa.from("tenant_google_credentials").upsert({
    tenant_id: tenantId,
    google_user_id: userInfo.id ?? null,
    google_user_email: userInfo.email ?? null,
    google_user_name: userInfo.name ?? null,
    access_token: accessToken,
    refresh_token: storedRefreshToken,
    token_expires_at: tokenExpiresAt,
    integration_status: "connected",
    enabled: true,
    last_verified_at: now,
    last_error: null,
    updated_by: oauthState.user_id,
    updated_at: now,
  }, { onConflict: "tenant_id" });

  if (upsertError) return backToPanel(oauthState.redirect_to, "error", "save_failed");
  await supa.from("tenant_onboarding").update({ google_connected: true }).eq("tenant_id", tenantId);

  // Autorização do Google concluída. Agora a parte do Google Ads: descobrir as
  // contas que este login acessa e vincular uma à empresa.
  if (!developerToken()) return backToPanel(oauthState.redirect_to, "authorized", "developer_token_missing");

  try {
    const accounts = selectableAccounts(await listAccessibleAccounts(accessToken));
    const keep = current?.customer_id ? accounts.find((account) => account.id === String(current.customer_id).replace(/\D/g, "")) : null;
    const chosen = keep ?? (accounts.length === 1 ? accounts[0] : null);

    if (!chosen) {
      return backToPanel(oauthState.redirect_to, accounts.length ? "select_account" : "authorized", accounts.length ? undefined : "no_ads_accounts");
    }

    await supa.from("tenant_google_credentials").update({
      customer_id: chosen.id,
      customer_descriptive_name: chosen.name,
      manager_customer_id: chosen.login_customer_id !== chosen.id ? chosen.login_customer_id : null,
      currency_code: chosen.currency_code ?? current?.currency_code ?? "BRL",
      time_zone: chosen.time_zone ?? current?.time_zone ?? "America/Sao_Paulo",
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
    return backToPanel(oauthState.redirect_to, "connected");
  } catch (err) {
    if (!(err instanceof GoogleAdsError)) throw err;
    await supa.from("tenant_google_credentials").update({
      integration_status: "needs_attention",
      last_error: `${err.code}: ${err.detail}`.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
    return backToPanel(oauthState.redirect_to, "authorized", err.code);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method === "POST") return handlePost(req);
  if (req.method === "GET") return handleCallback(req);

  return json({ error: "method_not_allowed" }, 405);
});
