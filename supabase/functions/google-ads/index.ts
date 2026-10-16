import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_DEVELOPER_TOKEN = Deno.env.get("GOOGLE_DEVELOPER_TOKEN") ?? "";

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

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
  const data = await res.json();
  return data.access_token ?? null;
}

async function getValidToken(tenantId: string): Promise<{
  accessToken: string;
  customerId: string;
  managerCustomerId: string | null;
} | null> {
  const { data: creds } = await supa
    .from("tenant_google_credentials")
    .select("access_token, refresh_token, token_expires_at, customer_id, manager_customer_id, enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!creds?.enabled || !creds.refresh_token || !creds.customer_id) return null;

  let accessToken = creds.access_token;

  // Refresh if expired or about to expire (5 min buffer)
  const expiresAt = creds.token_expires_at ? new Date(creds.token_expires_at).getTime() : 0;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    const newToken = await refreshAccessToken(creds.refresh_token);
    if (!newToken) {
      await supa.from("tenant_google_credentials").update({
        integration_status: "needs_attention",
        last_error: "Token refresh failed",
        updated_at: new Date().toISOString(),
      }).eq("tenant_id", tenantId);
      return null;
    }
    accessToken = newToken;
    await supa.from("tenant_google_credentials").update({
      access_token: newToken,
      token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
  }

  return {
    accessToken,
    customerId: creds.customer_id,
    managerCustomerId: creds.manager_customer_id ?? null,
  };
}

function gaqlHeaders(accessToken: string, loginCustomerId?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": GOOGLE_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  return headers;
}

function lastNDays(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// GET: Return cached Google Ads campaign ROI data
async function handleGet(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) {
    return json({ error: "forbidden" }, 403);
  }

  // Return credentials status
  const { data: creds } = await supa
    .from("tenant_google_credentials")
    .select("customer_id, customer_descriptive_name, manager_customer_id, google_user_email, integration_status, enabled, last_synced_at, last_error, currency_code")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // Return cached campaign ROI
  const { data: campaigns } = await supa
    .from("vw_google_campaign_roi")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("spend", { ascending: false })
    .limit(100);

  // Return conversion actions
  const { data: conversionActions } = await supa
    .from("tenant_google_conversion_actions")
    .select("*")
    .eq("tenant_id", tenantId);

  return json({
    ok: true,
    credentials: creds ?? null,
    campaigns: campaigns ?? [],
    conversion_actions: conversionActions ?? [],
  });
}

// POST: Actions — sync_campaigns, list_customers, select_customer, upload_conversion, list_conversion_actions, save_conversion_actions, disconnect
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
  if (action === "select_customer") return handleSelectCustomer(tenantId, body);
  if (action === "save_conversion_actions") return handleSaveConversionActions(tenantId, body);

  const token = await getValidToken(tenantId);
  if (!token) return json({ error: "google_not_connected" }, 400);

  if (action === "sync_campaigns") return handleSyncCampaigns(tenantId, token, body);
  if (action === "list_customers") return handleListCustomers(token);
  if (action === "list_conversion_actions") return handleListConversionActions(tenantId, token);
  if (action === "upload_conversion") return handleUploadConversion(tenantId, token, body);

  return json({ error: "unknown_action" }, 400);
}

async function handleSyncCampaigns(
  tenantId: string,
  token: { accessToken: string; customerId: string; managerCustomerId: string | null },
  body: Record<string, unknown>,
): Promise<Response> {
  const days = Math.min(Math.max(Number(body.days ?? 30), 1), 90);
  const range = body.since && body.until
    ? { start: String(body.since), end: String(body.until) }
    : lastNDays(days);

  const query = `
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
      metrics.cost_per_conversion,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC, metrics.cost_micros DESC
    LIMIT 10000
  `;

  const headers = gaqlHeaders(token.accessToken, token.managerCustomerId);
  const res = await fetch(
    `https://googleads.googleapis.com/v18/customers/${token.customerId}/googleAds:searchStream`,
    { method: "POST", headers, body: JSON.stringify({ query }) },
  );

  const payload = await res.json().catch(() => []);

  if (!res.ok) {
    const errorDetail = Array.isArray(payload) ? payload[0]?.error : payload?.error;
    await supa.from("tenant_google_credentials").update({
      integration_status: "needs_attention",
      last_error: JSON.stringify(errorDetail ?? payload),
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
    return json({ error: "google_ads_api_failed", detail: errorDetail ?? payload }, 400);
  }

  const rows: Record<string, unknown>[] = [];
  for (const batch of Array.isArray(payload) ? payload : [payload]) {
    for (const result of batch.results ?? []) {
      const campaign = result.campaign ?? {};
      const customer = result.customer ?? {};
      const metrics = result.metrics ?? {};
      const date = result.segments?.date;
      if (!date) continue;

      rows.push({
        tenant_id: tenantId,
        customer_id: String(customer.id ?? token.customerId),
        customer_name: customer.descriptiveName ?? null,
        campaign_id: String(campaign.id ?? ""),
        campaign_name: campaign.name ?? "",
        campaign_status: campaign.status ?? null,
        campaign_type: campaign.advertisingChannelType ?? null,
        date,
        impressions: Number(metrics.impressions ?? 0),
        clicks: Number(metrics.clicks ?? 0),
        cost_micros: Number(metrics.costMicros ?? 0),
        ctr: metrics.ctr != null ? Number(metrics.ctr) : null,
        average_cpc_micros: metrics.averageCpc != null ? Number(metrics.averageCpc) : null,
        conversions: metrics.conversions != null ? Number(metrics.conversions) : 0,
        cost_per_conversion_micros: metrics.costPerConversion != null ? Number(metrics.costPerConversion) : null,
        raw: result,
        synced_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length) {
    const { error } = await supa.from("google_campaign_insights").upsert(rows, {
      onConflict: "tenant_id,customer_id,campaign_id,date",
    });
    if (error) return json({ error: error.message }, 500);
  }

  await supa.from("tenant_google_credentials").update({
    integration_status: "connected",
    last_error: null,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);

  const { data: campaigns } = await supa
    .from("vw_google_campaign_roi")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("spend", { ascending: false })
    .limit(100);

  return json({ ok: true, synced: rows.length, campaigns: campaigns ?? [] });
}

async function handleListCustomers(
  token: { accessToken: string; customerId: string; managerCustomerId: string | null },
): Promise<Response> {
  const res = await fetch("https://googleads.googleapis.com/v18/customers:listAccessibleCustomers", {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "developer-token": GOOGLE_DEVELOPER_TOKEN,
    },
  });

  if (!res.ok) return json({ error: "list_customers_failed" }, 400);
  const data = await res.json();

  const customers: { id: string; name: string; manager: boolean }[] = [];
  for (const resourceName of data.resourceNames ?? []) {
    const cid = resourceName.replace("customers/", "");
    const headers = gaqlHeaders(token.accessToken, token.managerCustomerId);
    const query = `SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1`;
    const infoRes = await fetch(
      `https://googleads.googleapis.com/v18/customers/${cid}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query }) },
    );
    if (infoRes.ok) {
      const infoData = await infoRes.json();
      const c = infoData?.[0]?.results?.[0]?.customer;
      if (c) {
        customers.push({
          id: String(c.id),
          name: c.descriptiveName ?? `Customer ${c.id}`,
          manager: c.manager ?? false,
        });
      }
    }
  }

  // If there's a manager, also list its child accounts
  for (const mgr of customers.filter((c) => c.manager)) {
    const headers = gaqlHeaders(token.accessToken, mgr.id);
    const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'`;
    const childRes = await fetch(
      `https://googleads.googleapis.com/v18/customers/${mgr.id}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query }) },
    );
    if (childRes.ok) {
      const childData = await childRes.json();
      for (const batch of Array.isArray(childData) ? childData : [childData]) {
        for (const result of batch.results ?? []) {
          const cc = result.customerClient;
          if (!cc || cc.manager) continue;
          const childId = String(cc.clientCustomer).replace("customers/", "");
          if (!customers.some((c) => c.id === childId)) {
            customers.push({
              id: childId,
              name: cc.descriptiveName ?? `Customer ${childId}`,
              manager: false,
            });
          }
        }
      }
    }
  }

  return json({ ok: true, customers });
}

async function handleSelectCustomer(tenantId: string, body: Record<string, unknown>): Promise<Response> {
  const customerId = String(body.customer_id ?? "");
  const customerName = String(body.customer_name ?? "");
  const managerCustomerId = body.manager_customer_id ? String(body.manager_customer_id) : null;

  if (!customerId) return json({ error: "missing_customer_id" }, 400);

  const { error } = await supa.from("tenant_google_credentials").update({
    customer_id: customerId,
    customer_descriptive_name: customerName || null,
    manager_customer_id: managerCustomerId,
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function handleListConversionActions(
  tenantId: string,
  token: { accessToken: string; customerId: string; managerCustomerId: string | null },
): Promise<Response> {
  const headers = gaqlHeaders(token.accessToken, token.managerCustomerId);
  const query = `SELECT conversion_action.id, conversion_action.name, conversion_action.resource_name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED'`;

  const res = await fetch(
    `https://googleads.googleapis.com/v18/customers/${token.customerId}/googleAds:searchStream`,
    { method: "POST", headers, body: JSON.stringify({ query }) },
  );

  if (!res.ok) return json({ error: "list_conversion_actions_failed" }, 400);
  const data = await res.json();

  const actions: { id: string; name: string; resourceName: string; type: string }[] = [];
  for (const batch of Array.isArray(data) ? data : [data]) {
    for (const result of batch.results ?? []) {
      const ca = result.conversionAction;
      if (!ca) continue;
      actions.push({
        id: String(ca.id),
        name: ca.name ?? "",
        resourceName: ca.resourceName ?? "",
        type: ca.type ?? "",
      });
    }
  }

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

async function handleUploadConversion(
  tenantId: string,
  token: { accessToken: string; customerId: string; managerCustomerId: string | null },
  body: Record<string, unknown>,
): Promise<Response> {
  const sessionId = body.tracking_session_id ? String(body.tracking_session_id) : null;
  const eventType = String(body.event_type ?? "");
  const conversionValue = body.conversion_value != null ? Number(body.conversion_value) : null;

  if (!eventType) return json({ error: "missing_event_type" }, 400);

  // Get conversion action config
  const { data: actionConfig } = await supa
    .from("tenant_google_conversion_actions")
    .select("conversion_action_resource")
    .eq("tenant_id", tenantId)
    .eq("event_type", eventType)
    .maybeSingle();

  if (!actionConfig) return json({ error: "no_conversion_action_configured" }, 400);

  // Get tracking session for click identifiers
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
  const conversionDateTime = new Date().toISOString().replace("T", " ").replace("Z", "+00:00");

  const conversion: Record<string, unknown> = {
    conversionAction: actionConfig.conversion_action_resource,
    conversionDateTime,
    currencyCode,
  };

  if (gclid) conversion.gclid = gclid;
  if (gbraid) conversion.gbraid = gbraid;
  if (wbraid) conversion.wbraid = wbraid;
  if (conversionValue != null && conversionValue > 0) {
    conversion.conversionValue = conversionValue;
  } else {
    conversion.conversionValue = 0;
  }

  const headers = gaqlHeaders(token.accessToken, token.managerCustomerId);
  const uploadRes = await fetch(
    `https://googleads.googleapis.com/v18/customers/${token.customerId}:uploadClickConversions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        conversions: [conversion],
        partialFailure: true,
      }),
    },
  );

  const uploadData = await uploadRes.json().catch(() => null);
  const ok = uploadRes.ok && !uploadData?.partialFailureError;

  // Record upload attempt
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
    response_payload: uploadData,
    error_message: ok ? null : JSON.stringify(uploadData?.partialFailureError ?? uploadData?.error ?? "unknown"),
    sent_at: ok ? new Date().toISOString() : null,
  });

  if (!ok) {
    return json({
      error: "conversion_upload_failed",
      detail: uploadData?.partialFailureError ?? uploadData?.error,
    }, 400);
  }

  return json({ ok: true, result: uploadData });
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
