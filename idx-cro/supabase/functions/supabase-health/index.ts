import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

function envEmailList(name: string): string[] {
  return String(Deno.env.get(name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function platformRole(userId: string, email?: string | null): Promise<string | null> {
  const emailAllowList = envEmailList("PLATFORM_OWNER_EMAILS");
  if (email && emailAllowList.includes(email.toLowerCase())) return "owner";

  const { data } = await supa
    .from("platform_users")
    .select("role")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  return data?.role ?? null;
}

async function userTenantIds(userId: string): Promise<string[]> {
  const { data } = await supa
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("status", "active");

  return (data ?? []).map((item) => item.tenant_id).filter(Boolean);
}

function tenantScopedCount(table: string, tenantIds: string[]) {
  if (!tenantIds.length) return Promise.resolve({ count: 0, error: null });
  return supa.from(table).select("id", { count: "exact", head: true }).in("tenant_id", tenantIds);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const role = await platformRole(user.id, user.email);
  const isPlatform = ["owner", "admin", "support", "viewer"].includes(String(role ?? ""));
  const tenantIds = isPlatform ? [] : await userTenantIds(user.id);

  const [tenantCount, linkCount, sessionCount, crmCount, capiCount, metaInsightCount, invalidLinkCount] = isPlatform
    ? await Promise.all([
        supa.from("tenants").select("id", { count: "exact", head: true }),
        supa.from("smart_links").select("id", { count: "exact", head: true }),
        supa.from("tracking_sessions").select("id", { count: "exact", head: true }),
        supa.from("crm_activities").select("id", { count: "exact", head: true }),
        supa.from("capi_events").select("id", { count: "exact", head: true }),
        supa.from("meta_campaign_insights").select("id", { count: "exact", head: true }),
        supa.from("invalid_link_events").select("id", { count: "exact", head: true }),
      ])
    : await Promise.all([
        Promise.resolve({ count: tenantIds.length, error: null }),
        tenantScopedCount("smart_links", tenantIds),
        tenantScopedCount("tracking_sessions", tenantIds),
        tenantScopedCount("crm_activities", tenantIds),
        tenantScopedCount("capi_events", tenantIds),
        tenantScopedCount("meta_campaign_insights", tenantIds),
        Promise.resolve({ count: 0, error: null }),
      ]);

  const errors = [tenantCount, linkCount, sessionCount, crmCount, capiCount, metaInsightCount, invalidLinkCount]
    .map((result) => result.error?.message)
    .filter(Boolean);

  return json({
    ok: errors.length === 0,
    database_model: "single_owned_multi_tenant",
    database_owner: "idx",
    tenant_isolation: "tenant_id + rls + edge_functions",
    tenant_scope: isPlatform ? "platform" : "member",
    platform_role: role,
    project_url: Deno.env.get("SUPABASE_URL"),
    app_url: Deno.env.get("APP_URL") ?? null,
    tables: {
      tenants: tenantCount.count ?? 0,
      smart_links: linkCount.count ?? 0,
      tracking_sessions: sessionCount.count ?? 0,
      crm_activities: crmCount.count ?? 0,
      capi_events: capiCount.count ?? 0,
      meta_campaign_insights: metaInsightCount.count ?? 0,
      invalid_link_events: invalidLinkCount.count ?? 0,
    },
    functions: ["go", "convert", "crm", "capi-health", "tenant-admin", "meta-oauth", "meta-assets", "meta-insights", "supabase-health"],
    errors,
  });
});
