import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";
import { syncMetaInsights } from "../_shared/meta-sync.ts";

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

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
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

  const result = await syncMetaInsights(supa, tenantId, {
    days: Number(body.days ?? 30),
    since: body.since ? String(body.since) : undefined,
    until: body.until ? String(body.until) : undefined,
    adAccountId: body.ad_account_id ? String(body.ad_account_id) : undefined,
    adAccountName: body.ad_account_name ? String(body.ad_account_name) : undefined,
  });
  if (!result.ok) return json({ error: result.error, detail: result.detail }, result.status);

  const { data: campaigns } = await supa
    .from("vw_meta_campaign_roi")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("spend", { ascending: false })
    .limit(100);

  return json({ ok: true, synced: result.synced, campaigns: campaigns ?? [] });
});
