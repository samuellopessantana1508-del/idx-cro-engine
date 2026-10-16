import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI") ?? "";
const GOOGLE_DEVELOPER_TOKEN = Deno.env.get("GOOGLE_DEVELOPER_TOKEN") ?? "";
const appUrl = Deno.env.get("APP_URL") ?? "https://cro.sanmarfidelize.com";

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

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
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
  if (!res.ok) return null;
  return res.json();
}

async function listAccessibleCustomers(accessToken: string): Promise<{ resourceNames: string[] } | null> {
  const res = await fetch("https://googleads.googleapis.com/v18/customers:listAccessibleCustomers", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": GOOGLE_DEVELOPER_TOKEN,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getCustomerInfo(
  accessToken: string,
  customerId: string,
  loginCustomerId?: string,
): Promise<{ id: string; descriptiveName: string; manager: boolean; currencyCode: string; timeZone: string } | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": GOOGLE_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const query = `SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 1`;
  const res = await fetch(
    `https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const row = data?.[0]?.results?.[0]?.customer;
  if (!row) return null;
  return {
    id: row.id,
    descriptiveName: row.descriptiveName ?? "",
    manager: row.manager ?? false,
    currencyCode: row.currencyCode ?? "BRL",
    timeZone: row.timeZone ?? "America/Sao_Paulo",
  };
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

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    return json({ error: "google_oauth_not_configured" }, 500);
  }

  const state = randomState();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const redirectTo = String(body.redirect_to ?? `${appUrl}/`);

  const { error: stateError } = await supa.from("integration_oauth_states").insert({
    tenant_id: tenantId,
    user_id: user.id,
    provider: "google",
    state,
    redirect_to: redirectTo,
    expires_at: expiresAt,
  });

  if (stateError) return json({ error: stateError.message }, 500);

  const scopes = Deno.env.get("GOOGLE_OAUTH_SCOPES") ?? "https://www.googleapis.com/auth/adwords openid email profile";

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return json({ ok: true, auth_url: authUrl.toString() });
}

// GET: OAuth callback — exchange code for tokens, store credentials
async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${appUrl}/?google=error&reason=${encodeURIComponent(error)}`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${appUrl}/?google=error&reason=missing_params`, 302);
  }

  const { data: oauthState, error: stateError } = await supa
    .from("integration_oauth_states")
    .select("*")
    .eq("state", state)
    .eq("provider", "google")
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (stateError || !oauthState) {
    return Response.redirect(`${appUrl}/?google=error&reason=invalid_state`, 302);
  }

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
    return Response.redirect(`${appUrl}/?google=error&reason=token_exchange_failed`, 302);
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

  // List accessible Google Ads customers
  let customerId: string | null = null;
  let customerName: string | null = null;
  let managerCustomerId: string | null = null;
  let currencyCode = "BRL";
  let timeZone = "America/Sao_Paulo";

  if (GOOGLE_DEVELOPER_TOKEN) {
    const customers = await listAccessibleCustomers(accessToken);
    if (customers?.resourceNames?.length) {
      for (const resourceName of customers.resourceNames) {
        const cid = resourceName.replace("customers/", "");
        const info = await getCustomerInfo(accessToken, cid);
        if (info && !info.manager) {
          customerId = cid;
          customerName = info.descriptiveName;
          currencyCode = info.currencyCode;
          timeZone = info.timeZone;
          break;
        }
        if (info?.manager && !managerCustomerId) {
          managerCustomerId = cid;
        }
      }

      // If only manager accounts found, try to get child accounts
      if (!customerId && managerCustomerId) {
        const childInfo = await getManagerChildAccounts(accessToken, managerCustomerId);
        if (childInfo) {
          customerId = childInfo.id;
          customerName = childInfo.descriptiveName;
          currencyCode = childInfo.currencyCode;
          timeZone = childInfo.timeZone;
        }
      }
    }
  }

  // Upsert credentials
  const { error: upsertError } = await supa.from("tenant_google_credentials").upsert({
    tenant_id: tenantId,
    google_user_id: userInfo.id ?? null,
    google_user_email: userInfo.email ?? null,
    google_user_name: userInfo.name ?? null,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: tokenExpiresAt,
    customer_id: customerId,
    customer_descriptive_name: customerName,
    manager_customer_id: managerCustomerId,
    currency_code: currencyCode,
    time_zone: timeZone,
    integration_status: "connected",
    enabled: true,
    last_verified_at: new Date().toISOString(),
    last_error: null,
    updated_by: oauthState.user_id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id" });

  if (upsertError) {
    return Response.redirect(`${appUrl}/?google=error&reason=save_failed`, 302);
  }

  // Mark state as used
  await supa.from("integration_oauth_states").update({ used_at: new Date().toISOString() }).eq("id", oauthState.id);

  // Update onboarding
  await supa.from("tenant_onboarding").update({ google_connected: true }).eq("tenant_id", tenantId);

  const redirectTo = oauthState.redirect_to || appUrl;
  const separator = redirectTo.includes("?") ? "&" : "?";
  return Response.redirect(`${redirectTo}${separator}google=connected`, 302);
}

async function getManagerChildAccounts(
  accessToken: string,
  managerCustomerId: string,
): Promise<{ id: string; descriptiveName: string; currencyCode: string; timeZone: string } | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": GOOGLE_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
    "login-customer-id": managerCustomerId,
  };

  const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED' LIMIT 1`;

  const res = await fetch(
    `https://googleads.googleapis.com/v18/customers/${managerCustomerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const row = data?.[0]?.results?.[0]?.customerClient;
  if (!row) return null;
  return {
    id: String(row.clientCustomer).replace("customers/", ""),
    descriptiveName: row.descriptiveName ?? "",
    currencyCode: row.currencyCode ?? "BRL",
    timeZone: row.timeZone ?? "America/Sao_Paulo",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method === "POST") return handlePost(req);
  if (req.method === "GET") return handleCallback(req);

  return json({ error: "method_not_allowed" }, 405);
});
