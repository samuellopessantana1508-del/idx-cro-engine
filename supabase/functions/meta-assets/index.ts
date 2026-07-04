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

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeActId(value: unknown): string {
  const clean = cleanText(value);
  if (!clean) return "";
  return clean.startsWith("act_") ? clean : `act_${clean}`;
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

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const version = Deno.env.get("META_GRAPH_VERSION") ?? "v25.0";

  if (req.method === "GET") {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenant_id");
    if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }

    const { data: creds } = await supa
      .from("tenant_meta_credentials")
      .select("access_token, pixel_id, selected_pixel_name, selected_ad_account_id, selected_ad_account_name")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!creds?.access_token) return json({ error: "meta_not_connected" }, 400);

    const graphUrl = new URL(`https://graph.facebook.com/${version}/me/adaccounts`);
    graphUrl.searchParams.set("fields", "id,account_id,name,adspixels{id,name}");
    graphUrl.searchParams.set("limit", "50");
    graphUrl.searchParams.set("access_token", creds.access_token);

    const response = await fetch(graphUrl.toString());
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: "meta_assets_failed", detail: data }, 400);

    return json({
      ok: true,
      ad_accounts: data.data ?? [],
      selected_ad_account_id: creds.selected_ad_account_id,
      selected_ad_account_name: creds.selected_ad_account_name,
      selected_pixel_id: creds.pixel_id,
      selected_pixel_name: creds.selected_pixel_name,
    });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const tenantId = String(body.tenant_id ?? "");
    if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }

    const adAccountId = normalizeActId(body.ad_account_id);
    const pixelId = cleanText(body.pixel_id);
    if (!adAccountId && !pixelId) return json({ error: "missing_meta_asset_selection" }, 400);

    const updates: Record<string, unknown> = {
      tenant_id: tenantId,
      selected_ad_account_id: adAccountId || null,
      selected_ad_account_name: cleanText(body.ad_account_name) || null,
      integration_status: "connected",
      enabled: true,
      updated_by: user.id,
      last_verified_at: new Date().toISOString(),
      last_error: null,
    };

    if (pixelId) {
      updates.pixel_id = pixelId;
      updates.selected_pixel_name = cleanText(body.pixel_name) || null;
    }

    const { error } = await supa
      .from("tenant_meta_credentials")
      .upsert(updates, { onConflict: "tenant_id" });

    if (error) return json({ error: error.message }, 400);
    return json({
      ok: true,
      selected_ad_account_id: adAccountId || null,
      selected_ad_account_name: updates.selected_ad_account_name,
      selected_pixel_id: pixelId || null,
      selected_pixel_name: updates.selected_pixel_name ?? null,
    });
  }

  return json({ error: "method_not_allowed" }, 405);
});
