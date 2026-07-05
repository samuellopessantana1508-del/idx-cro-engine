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

async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  );
}

function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-real-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const postBody = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const tenantId = req.method === "POST" ? postBody.tenant_id : url.searchParams.get("tenant_id");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  const hasAccess = req.method === "POST"
    ? await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"])
    : await canReadTenantOrPlatform(supa, tenantId, user.id, user.email);

  if (!hasAccess) return json({ error: "forbidden" }, 403);

  if (req.method === "POST") {
    const { data: creds } = await supa
      .from("tenant_meta_credentials")
      .select("pixel_id, access_token, test_event_code, graph_version")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!creds?.pixel_id || !creds.access_token) return json({ error: "missing_meta_credentials" }, 400);

    const version = Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
    const hashedEmail = user.email ? await h256(user.email) : null;
    const requestPayload = {
      data: [{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: `test_${crypto.randomUUID()}`,
        event_source_url: Deno.env.get("APP_URL") ?? "https://idxparasuaempresa.com.br",
        action_source: "website",
        user_data: cleanObject({
          client_ip_address: clientIp(req),
          client_user_agent: req.headers.get("user-agent"),
          em: hashedEmail ? [hashedEmail] : undefined,
          external_id: [await h256(user.id)],
        }),
        custom_data: {
          content_name: "IDX CAPI Test",
          currency: "BRL",
          value: 1,
        },
      }],
      test_event_code: creds.test_event_code || undefined,
    };
    const metaPayload = {
      ...requestPayload,
      access_token: creds.access_token,
    };

    const response = await fetch(`https://graph.facebook.com/${version}/${creds.pixel_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaPayload),
    });
    const responseBody = await response.json().catch(() => null);

    await supa.from("capi_events").insert({
      tenant_id: tenantId,
      event_name: "Lead",
      event_id: requestPayload.data[0].event_id,
      pixel_id: creds.pixel_id,
      request_payload: requestPayload,
      response_payload: responseBody,
      ok: response.ok,
      status_code: response.status,
      error_message: response.ok ? null : JSON.stringify(responseBody),
    });

    await supa.from("tenant_meta_credentials").update({
      last_verified_at: new Date().toISOString(),
      last_error: response.ok ? null : JSON.stringify(responseBody),
      integration_status: response.ok ? "connected" : "needs_attention",
    }).eq("tenant_id", tenantId);

    return json({ ok: response.ok, status: response.status, response: responseBody }, response.ok ? 200 : 400);
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events, error } = await supa
    .from("capi_events")
    .select("event_name, ok, status_code, error_message, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return json({ error: error.message }, 500);

  const total = events?.length ?? 0;
  const success = events?.filter((event) => event.ok).length ?? 0;
  const failures = total - success;
  const byEvent = (events ?? []).reduce<Record<string, number>>((acc, event) => {
    acc[event.event_name] = (acc[event.event_name] ?? 0) + 1;
    return acc;
  }, {});

  return json({
    total,
    success,
    failures,
    success_rate: total ? Math.round((success / total) * 1000) / 10 : 0,
    by_event: byEvent,
    recent: events ?? [],
  });
});
