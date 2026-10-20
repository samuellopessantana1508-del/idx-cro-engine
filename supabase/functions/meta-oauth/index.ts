import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { metaRedirectUri, publicAppUrl, safeReturnUrl } from "../_shared/meta-config.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function accountPixels(account: Record<string, any>): Record<string, any>[] {
  const pixels = account.adspixels;
  if (Array.isArray(pixels)) return pixels;
  return Array.isArray(pixels?.data) ? pixels.data : [];
}

async function autoSelectMetaAssets(tenantId: string, accessToken: string, version: string): Promise<"kept" | "selected" | "no_ad_accounts" | "failed"> {
  const { data: current } = await supa
    .from("tenant_meta_credentials")
    .select("pixel_id, selected_ad_account_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (current?.selected_ad_account_id) return "kept";

  const assetsUrl = new URL(`https://graph.facebook.com/${version}/me/adaccounts`);
  assetsUrl.searchParams.set("fields", "id,account_id,name,adspixels{id,name}");
  assetsUrl.searchParams.set("limit", "50");
  assetsUrl.searchParams.set("access_token", accessToken);

  const response = await fetch(assetsUrl.toString());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return "failed";
  if (!Array.isArray(payload.data) || !payload.data.length) return "no_ad_accounts";

  const currentPixelId = String(current?.pixel_id ?? "");
  const matchingAccount = currentPixelId
    ? payload.data.find((account: Record<string, any>) => accountPixels(account).some((pixel) => String(pixel.id) === currentPixelId))
    : null;
  const selectedAccount = matchingAccount ?? payload.data.find((account: Record<string, any>) => accountPixels(account).length) ?? payload.data[0];
  const pixels = accountPixels(selectedAccount);
  const selectedPixel = pixels.find((pixel) => String(pixel.id) === currentPixelId) ?? pixels[0] ?? null;

  const updates: Record<string, unknown> = {
    selected_ad_account_id: selectedAccount.id ?? null,
    selected_ad_account_name: selectedAccount.name ?? selectedAccount.account_id ?? null,
    selected_pixel_name: selectedPixel?.name ?? null,
    last_verified_at: new Date().toISOString(),
    last_error: null,
  };

  if (!currentPixelId && selectedPixel?.id) updates.pixel_id = selectedPixel.id;

  await supa.from("tenant_meta_credentials").update(updates).eq("tenant_id", tenantId);
  return "selected";
}

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

// Volta para o painel em Integrações com ?meta=<resultado>, sem perder a rota
// da empresa (/slug). Antes a URL ficava "?section=integrations?meta=connected".
function backToPanel(returnTo: unknown, result: string): Response {
  const url = safeReturnUrl(returnTo);
  url.searchParams.set("section", "integrations");
  url.searchParams.set("meta", result);
  return Response.redirect(url.toString(), 302);
}

async function markMetaError(tenantId: string, error: unknown) {
  await supa.from("tenant_meta_credentials").update({
    integration_status: "needs_attention",
    last_error: typeof error === "string" ? error : JSON.stringify(error).slice(0, 1000),
    last_verified_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);
}

// Guarda o token do Facebook Login sem apagar o Token CAPI salvo manualmente:
// o CAPI continua usando access_token; Ads/campanhas/públicos usam
// ads_access_token. Se a empresa não tinha Token CAPI, o token do Facebook
// também passa a servir para o CAPI (comportamento anterior).
async function saveFacebookToken(
  tenantId: string,
  userId: string | null,
  accessToken: string,
  expiresIn: number,
  me: Record<string, any>,
  version: string,
): Promise<string | null> {
  const { data: current } = await supa
    .from("tenant_meta_credentials")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    facebook_user_id: me.id ?? null,
    facebook_user_name: me.name ?? null,
    facebook_token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    integration_status: "connected",
    enabled: current ? current.enabled ?? true : true,
    graph_version: version,
    updated_by: userId,
    last_verified_at: new Date().toISOString(),
    last_error: null,
    ads_access_token: accessToken,
  };
  if (!current?.access_token) row.access_token = accessToken;

  const { error } = await supa.from("tenant_meta_credentials").upsert(row, { onConflict: "tenant_id" });
  if (!error) return null;

  // Banco ainda sem a coluna ads_access_token (migration não aplicada): grava
  // como antes para a conexão não falhar.
  if (/ads_access_token/.test(error.message)) {
    delete row.ads_access_token;
    row.access_token = accessToken;
    const retry = await supa.from("tenant_meta_credentials").upsert(row, { onConflict: "tenant_id" });
    return retry.error?.message ?? null;
  }
  return error.message;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const redirectUri = metaRedirectUri();
  const loginConfigId = Deno.env.get("META_LOGIN_CONFIG_ID") ?? Deno.env.get("META_CONFIG_ID");
  const appUrl = publicAppUrl();
  const version = Deno.env.get("META_GRAPH_VERSION") ?? "v25.0";

  if (req.method === "POST") {
    const user = await currentUser(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!appId || !appSecret) return json({ error: "missing_meta_app_env" }, 500);

    const body = await req.json().catch(() => ({}));
    const tenantId = String(body.tenant_id ?? "");
    if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }

    const state = randomState();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error: stateError } = await supa.from("integration_oauth_states").insert({
      tenant_id: tenantId,
      user_id: user.id,
      provider: "meta",
      state,
      redirect_to: safeReturnUrl(body.redirect_to).toString(),
      expires_at: expiresAt,
    });
    if (stateError) return json({ error: "oauth_state_failed", detail: stateError.message }, 500);

    const scope = (Deno.env.get("META_OAUTH_SCOPES") ?? [
      "ads_read",
      "ads_management",
      "business_management",
    ].join(",")).trim();

    const authUrl = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    authUrl.searchParams.set("client_id", appId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    if (scope) authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("response_type", "code");
    if (loginConfigId) {
      authUrl.searchParams.set("config_id", loginConfigId);
      authUrl.searchParams.set("override_default_response_type", "true");
    }
    return json({ ok: true, auth_url: authUrl.toString(), redirect_uri: redirectUri });
  }

  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);

  // Diagnóstico sem segredo: mostra a URI que precisa estar cadastrada na Meta.
  if (url.searchParams.get("check") === "1") {
    return json({
      ok: Boolean(appId && appSecret),
      app_url: appUrl,
      redirect_uri: redirectUri,
      meta_app_id_set: Boolean(appId),
      meta_app_secret_set: Boolean(appSecret),
      login_config_id_set: Boolean(loginConfigId),
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const fbError = url.searchParams.get("error");

  // Consome o state uma única vez (atômico): impede reuso do mesmo retorno.
  const claimState = async () => {
    if (!state) return null;
    const { data } = await supa
      .from("integration_oauth_states")
      .update({ used_at: new Date().toISOString() })
      .eq("state", state)
      .eq("provider", "meta")
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("*")
      .maybeSingle();
    return data ?? null;
  };

  if (fbError) {
    // Usuário cancelou ou negou permissão no Facebook.
    const stateRow = await claimState();
    return backToPanel(stateRow?.redirect_to, fbError === "access_denied" ? "denied" : "error");
  }

  if (!code || !state) return backToPanel(null, "error");
  if (!appId || !appSecret) return backToPanel(null, "config_error");

  const stateRow = await claimState();
  if (!stateRow) return backToPanel(null, "state_error");

  const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const shortTokenResponse = await fetch(tokenUrl.toString());
  const shortToken = await shortTokenResponse.json().catch(() => ({}));
  if (!shortTokenResponse.ok || !shortToken.access_token) {
    await markMetaError(stateRow.tenant_id, { step: "code_exchange", redirect_uri: redirectUri, detail: shortToken });
    return backToPanel(stateRow.redirect_to, "token_error");
  }

  const longUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);

  const longResponse = await fetch(longUrl.toString());
  const longToken = await longResponse.json().catch(() => ({}));
  const accessToken = longToken.access_token ?? shortToken.access_token;
  const expiresIn = Number(longToken.expires_in ?? shortToken.expires_in ?? 0);

  const meUrl = new URL(`https://graph.facebook.com/${version}/me`);
  meUrl.searchParams.set("fields", "id,name");
  meUrl.searchParams.set("access_token", accessToken);
  const me = await fetch(meUrl.toString()).then((res) => res.json()).catch(() => ({}));

  const saveError = await saveFacebookToken(stateRow.tenant_id, stateRow.user_id, accessToken, expiresIn, me, version);
  if (saveError) return backToPanel(stateRow.redirect_to, "save_error");

  const assets = await autoSelectMetaAssets(stateRow.tenant_id, accessToken, version);
  await supa.from("tenant_onboarding").upsert({ tenant_id: stateRow.tenant_id, meta_connected: true });

  return backToPanel(stateRow.redirect_to, assets === "no_ad_accounts" ? "no_ad_accounts" : "connected");
});
