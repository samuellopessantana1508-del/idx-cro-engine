import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";

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

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

function normalizeActId(value: string): string {
  const clean = value.trim();
  return clean.startsWith("act_") ? clean : `act_${clean}`;
}

function lastNDays(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (date: Date) => date.toISOString().slice(0, 10);
  return { since: fmt(since), until: fmt(until) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenant_id");
    if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);

    const { data, error } = await supa
      .from("vw_meta_campaign_roi")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("spend", { ascending: false })
      .limit(100);

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, campaigns: data ?? [] });
  }

  const body = await req.json().catch(() => ({}));
  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
    return json({ error: "forbidden" }, 403);
  }

  const { data: creds } = await supa
    .from("tenant_meta_credentials")
    .select("access_token, selected_ad_account_id, selected_ad_account_name, graph_version")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!creds?.access_token) return json({ error: "meta_not_connected" }, 400);

  const adAccountId = normalizeActId(String(body.ad_account_id ?? creds.selected_ad_account_id ?? ""));
  if (!adAccountId || adAccountId === "act_") return json({ error: "missing_ad_account_id" }, 400);

  const days = Math.min(Math.max(Number(body.days ?? 30), 1), 90);
  const range = body.since && body.until
    ? { since: String(body.since), until: String(body.until) }
    : lastNDays(days);

  const version = Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
  const fields = [
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "reach",
    "clicks",
    "cpc",
    "cpm",
    "ctr",
    "date_start",
    "date_stop",
  ].join(",");

  const insightsUrl = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  insightsUrl.searchParams.set("level", "campaign");
  insightsUrl.searchParams.set("fields", fields);
  insightsUrl.searchParams.set("time_increment", "1");
  insightsUrl.searchParams.set("limit", "500");
  insightsUrl.searchParams.set("time_range", JSON.stringify(range));
  insightsUrl.searchParams.set("access_token", creds.access_token);

  const response = await fetch(insightsUrl.toString());
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    await supa.from("tenant_meta_credentials").update({
      integration_status: "needs_attention",
      last_error: JSON.stringify(payload),
      last_verified_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId);
    return json({ error: "meta_insights_failed", detail: payload }, 400);
  }

  const rows = (payload.data ?? []).map((item: Record<string, string>) => ({
    tenant_id: tenantId,
    ad_account_id: adAccountId,
    ad_account_name: creds.selected_ad_account_name ?? body.ad_account_name ?? null,
    campaign_id: item.campaign_id,
    campaign_name: item.campaign_name,
    date_start: item.date_start,
    date_stop: item.date_stop,
    spend: Number(item.spend ?? 0),
    impressions: Number(item.impressions ?? 0),
    reach: Number(item.reach ?? 0),
    clicks: Number(item.clicks ?? 0),
    cpc: item.cpc ? Number(item.cpc) : null,
    cpm: item.cpm ? Number(item.cpm) : null,
    ctr: item.ctr ? Number(item.ctr) : null,
    raw: item,
    synced_at: new Date().toISOString(),
  }));

  if (rows.length) {
    const { error } = await supa.from("meta_campaign_insights").upsert(rows, {
      onConflict: "tenant_id,ad_account_id,campaign_id,date_start,date_stop",
    });
    if (error) return json({ error: error.message }, 500);
  }

  await supa.from("tenant_meta_credentials").update({
    selected_ad_account_id: adAccountId,
    selected_ad_account_name: creds.selected_ad_account_name ?? body.ad_account_name ?? null,
    integration_status: "connected",
    last_error: null,
    last_verified_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);

  const { data: campaigns } = await supa
    .from("vw_meta_campaign_roi")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("spend", { ascending: false })
    .limit(100);

  return json({ ok: true, synced: rows.length, campaigns: campaigns ?? [] });
});
