import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";
import { ensureMetaAudience, syncTenantAudience, type AudienceKey } from "../_shared/meta-audiences.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const audienceKeys: AudienceKey[] = ["qualified", "purchased"];

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

async function audienceStatus(tenantId: string) {
  const { data, error } = await supa
    .from("vw_meta_audience_status")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("audience_key", { ascending: true });

  if (error) throw error;
  return data ?? [];
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

    try {
      return json({ ok: true, audiences: await audienceStatus(tenantId) });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  const body = await req.json().catch(() => ({}));
  const tenantId = String(body.tenant_id ?? "");
  const action = String(body.action ?? "sync");
  const requestedKey = String(body.audience_key ?? "all") as AudienceKey | "all";
  const keys = requestedKey === "all" ? audienceKeys : [requestedKey as AudienceKey];

  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
    return json({ error: "forbidden" }, 403);
  }
  if (keys.some((key) => !audienceKeys.includes(key))) return json({ error: "invalid_audience_key" }, 400);

  if (body.ad_account_id) {
    await supa.from("tenant_meta_credentials").update({
      selected_ad_account_id: String(body.ad_account_id).trim(),
    }).eq("tenant_id", tenantId);
  }

  if (action === "ensure") {
    const results = [];
    for (const key of keys) {
      results.push(await ensureMetaAudience(supa, tenantId, key, { adAccountId: body.ad_account_id }));
    }
    return json({ ok: results.every((item) => item.ok), results, audiences: await audienceStatus(tenantId) });
  }

  if (action === "sync") {
    const results = [];
    for (const key of keys) {
      await ensureMetaAudience(supa, tenantId, key, { adAccountId: body.ad_account_id });
      results.push(await syncTenantAudience(supa, tenantId, key, {
        adAccountId: body.ad_account_id,
        limit: body.limit,
      }));
    }

    return json({
      ok: results.every((item) => item.ok),
      results,
      audiences: await audienceStatus(tenantId),
    });
  }

  return json({ error: "unknown_action" }, 400);
});
