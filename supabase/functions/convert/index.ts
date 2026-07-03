import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { syncSessionToMetaAudience } from "../_shared/meta-audiences.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CapiResult = {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
  pixelId?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function cleanDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sendCapi(
  tenantId: string,
  event: Record<string, unknown>,
): Promise<CapiResult> {
  const { data: creds, error } = await supa
    .from("tenant_meta_credentials")
    .select("pixel_id, access_token, graph_version, enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) return { ok: false, status: null, data: null, error: error.message };
  if (!creds?.enabled || !creds.pixel_id || !creds.access_token) {
    return { ok: false, status: null, data: { error: "missing_meta_credentials" } };
  }

  const version = Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
  const endpoint = `https://graph.facebook.com/${version}/${creds.pixel_id}/events`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [event],
        access_token: creds.access_token,
      }),
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data, pixelId: creds.pixel_id };
  } catch (err) {
    return { ok: false, status: null, data: null, error: String(err) };
  }
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
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "purchase";
  const ref = String(body.ref ?? "").trim().toLowerCase();
  if (!ref) return json({ error: "missing_ref" }, 400);

  const { data: session, error: sessionError } = await supa
    .from("tracking_sessions")
    .select("*, tenant:tenants(*), offer:offers(*), smart_link:smart_links(*)")
    .eq("ref", ref)
    .maybeSingle();

  if (sessionError || !session) return json({ error: "session_not_found" }, 404);

  if (!(await canOperateTenantOrPlatform(supa, session.tenant_id, user.id, user.email))) {
    return json({ error: "forbidden" }, 403);
  }

  if (action === "lost") {
    await supa
      .from("tracking_sessions")
      .update({
        lead_status: "lost",
        lost_at: new Date().toISOString(),
        sale_notes: body.notes ?? session.sale_notes,
      })
      .eq("id", session.id);
    return json({ ok: true, status: "lost" });
  }

  if (session.sold_at) return json({ error: "already_sold" }, 409);

  const phone = cleanDigits(body.customer_phone);
  const email = String(body.customer_email ?? "").trim();
  const name = String(body.customer_name ?? "").trim();
  const revenue = Number(body.revenue ?? session.offer?.price ?? 0);
  if (!Number.isFinite(revenue) || revenue <= 0) {
    return json({ error: "invalid_revenue" }, 400);
  }

  await supa
    .from("tracking_sessions")
    .update({
      lead_status: "sold",
      sold_at: new Date().toISOString(),
      customer_phone: phone || null,
      customer_email: email || null,
      customer_name: name || null,
      revenue,
      sale_notes: body.notes ?? null,
    })
    .eq("id", session.id);

  const userData: Record<string, unknown> = {
    client_ip_address: session.ip,
    client_user_agent: session.ua,
    fbc: session.fbc,
    fbp: session.fbp,
    country: await h256("br"),
  };

  if (phone) userData.ph = await h256(phone);
  if (email) userData.em = await h256(email);
  if (name) {
    const parts = name.split(/\s+/);
    userData.fn = await h256(parts[0]);
    if (parts.length > 1) userData.ln = await h256(parts.slice(1).join(" "));
  }

  const eventId = `purchase_${session.id}`;
  const capiPayload = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: session.request_url ?? session.source_url ?? "",
    action_source: "website",
    user_data: userData,
    custom_data: {
      content_ids: [session.offer?.slug ?? session.smart_link?.code ?? session.ref],
      content_type: "product",
      content_name: session.offer?.name ?? session.smart_link?.name ?? "Local offer",
      content_category: session.offer?.category ?? "local_offer",
      value: revenue,
      currency: "BRL",
      ref: session.ref,
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
    },
  };

  const capi = await sendCapi(session.tenant_id, capiPayload);

  await supa.from("capi_events").insert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    event_name: "Purchase",
    event_id: eventId,
    pixel_id: capi.pixelId ?? null,
    request_payload: capiPayload,
    response_payload: capi.data,
    ok: capi.ok,
    status_code: capi.status,
    error_message: capi.error ?? null,
  });

  if (capi.ok) {
    await supa.from("tracking_sessions").update({ capi_purchase_ok: true }).eq("id", session.id);
  }

  const updatedSession = {
    ...session,
    lead_status: "sold",
    customer_phone: phone || session.customer_phone,
    customer_email: email || session.customer_email,
    customer_name: name || session.customer_name,
    revenue,
  };
  const audienceSync = await syncSessionToMetaAudience(supa, updatedSession, "purchased", body);

  await supa.from("crm_activities").insert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    user_id: user.id,
    activity_type: "system",
    body: "meta_audience_purchased",
    from_status: session.lead_status,
    to_status: "sold",
    metadata: audienceSync,
  });

  return json({ ok: true, capi_ok: capi.ok, audience_sync: audienceSync, status: "sold" });
});
