import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
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

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const redirectUri = Deno.env.get("META_REDIRECT_URI");
  const loginConfigId = Deno.env.get("META_LOGIN_CONFIG_ID") ?? Deno.env.get("META_CONFIG_ID");
  const appUrl = Deno.env.get("APP_URL") ?? "https://cro.idxparasuaempresa.com.br";
  const version = Deno.env.get("META_GRAPH_VERSION") ?? "v25.0";

  if (req.method === "POST") {
    const user = await currentUser(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!appId || !redirectUri) return json({ error: "missing_meta_app_env" }, 500);

    const body = await req.json().catch(() => ({}));
    const tenantId = String(body.tenant_id ?? "");
    if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }

    const state = randomState();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supa.from("integration_oauth_states").insert({
      tenant_id: tenantId,
      user_id: user.id,
      provider: "meta",
      state,
      redirect_to: body.redirect_to ?? `${appUrl}/?section=integrations`,
      expires_at: expiresAt,
    });

    const scope = [
      "email",
      "public_profile",
      "ads_read",
      "ads_management",
      "business_management",
    ].join(",");

    const authUrl = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    authUrl.searchParams.set("client_id", appId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("response_type", "code");
    if (loginConfigId) {
      authUrl.searchParams.set("config_id", loginConfigId);
      authUrl.searchParams.set("override_default_response_type", "true");
    }
    return json({ ok: true, auth_url: authUrl.toString() });
  }

  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !appId || !appSecret || !redirectUri) {
    return Response.redirect(`${appUrl}/?section=integrations&meta=error`, 302);
  }

  const { data: stateRow } = await supa
    .from("integration_oauth_states")
    .select("*")
    .eq("state", state)
    .eq("provider", "meta")
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!stateRow) return Response.redirect(`${appUrl}/?section=integrations&meta=state_error`, 302);

  const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const shortTokenResponse = await fetch(tokenUrl.toString());
  const shortToken = await shortTokenResponse.json();
  if (!shortTokenResponse.ok || !shortToken.access_token) {
    return Response.redirect(`${stateRow.redirect_to ?? appUrl}/?meta=token_error`, 302);
  }

  const longUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);

  const longResponse = await fetch(longUrl.toString());
  const longToken = await longResponse.json();
  const accessToken = longToken.access_token ?? shortToken.access_token;
  const expiresIn = Number(longToken.expires_in ?? shortToken.expires_in ?? 0);

  const meResponse = await fetch(`https://graph.facebook.com/${version}/me?fields=id,name&access_token=${accessToken}`);
  const me = await meResponse.json().catch(() => ({}));

  await supa.from("tenant_meta_credentials").upsert({
    tenant_id: stateRow.tenant_id,
    facebook_user_id: me.id ?? null,
    facebook_user_name: me.name ?? null,
    access_token: accessToken,
    facebook_token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    integration_status: "connected",
    enabled: true,
    graph_version: version,
    updated_by: stateRow.user_id,
    last_verified_at: new Date().toISOString(),
    last_error: null,
  });

  await supa.from("integration_oauth_states").update({ used_at: new Date().toISOString() }).eq("id", stateRow.id);
  await supa.from("tenant_onboarding").upsert({ tenant_id: stateRow.tenant_id, meta_connected: true });

  return Response.redirect(`${stateRow.redirect_to ?? appUrl}?meta=connected`, 302);
});
