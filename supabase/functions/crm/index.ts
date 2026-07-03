import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { syncSessionToMetaAudience, type AudienceKey } from "../_shared/meta-audiences.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const allowedStatuses = ["new", "contacted", "qualified", "bad", "sold", "lost"] as const;
type LeadStatus = (typeof allowedStatuses)[number];

type CapiResult = {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
  pixelId?: string;
};

const stageEvents: Partial<Record<LeadStatus, string>> = {
  contacted: "ContactedLead",
  qualified: "QualifiedLead",
  bad: "DisqualifiedLead",
  lost: "LeadLost",
  sold: "Purchase",
};

const statusScore: Record<LeadStatus, number> = {
  new: 0,
  contacted: 20,
  qualified: 80,
  bad: -20,
  sold: 100,
  lost: 0,
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

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function isAllowedStatus(value: unknown): value is LeadStatus {
  return allowedStatuses.includes(value as LeadStatus);
}

function mergeTags(current: unknown, requested: unknown, status: LeadStatus): string[] {
  const base = Array.isArray(current) ? current.map(String) : [];
  const incoming = Array.isArray(requested) ? requested.map(String) : [];
  const stageTags: string[] = [];

  if (status === "qualified") stageTags.push("bom lead", "remarketing");
  if (status === "bad") stageTags.push("ruim");
  if (status === "sold") stageTags.push("venda");
  if (status === "lost") stageTags.push("perdido");
  if (status === "contacted") stageTags.push("contato");

  return Array.from(new Set([...base, ...incoming, ...stageTags].map((tag) => tag.trim()).filter(Boolean))).slice(0, 12);
}

async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

async function sendCapi(tenantId: string, event: Record<string, unknown>): Promise<CapiResult> {
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

async function buildUserData(session: Record<string, any>, body: Record<string, any>) {
  const phone = cleanDigits(body.customer_phone ?? session.customer_phone);
  const email = cleanText(body.customer_email ?? session.customer_email);
  const name = cleanText(body.customer_name ?? session.customer_name);
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

  return userData;
}

async function buildCapiPayload(
  eventName: string,
  session: Record<string, any>,
  status: LeadStatus,
  body: Record<string, any>,
) {
  const revenue = Number(body.revenue ?? session.revenue ?? session.offer?.price ?? 0);
  const eventId = `${eventName.toLowerCase()}_${session.id}_${Date.now()}`;
  return {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: session.request_url ?? session.source_url ?? "",
    action_source: "website",
    user_data: await buildUserData(session, body),
    custom_data: {
      content_ids: [session.offer?.slug ?? session.smart_link?.code ?? session.ref],
      content_type: "product",
      content_name: session.offer?.name ?? session.smart_link?.name ?? "Local offer",
      content_category: session.offer?.category ?? "local_offer",
      value: eventName === "Purchase" ? revenue : Number(session.offer?.price ?? 0),
      currency: "BRL",
      ref: session.ref,
      lead_status: status,
      remarketing: status === "qualified",
      quality_signal: status === "qualified" ? "good" : status === "bad" ? "bad" : "neutral",
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = cleanText(body.action || "update_stage");
  const ref = cleanText(body.ref).toLowerCase();
  const sessionId = cleanText(body.session_id);

  if (!ref && !sessionId) return json({ error: "missing_ref" }, 400);

  let query = supa
    .from("tracking_sessions")
    .select("*, tenant:tenants(*), offer:offers(*), smart_link:smart_links(*)");

  query = sessionId ? query.eq("id", sessionId) : query.eq("ref", ref);

  const { data: session, error: sessionError } = await query.maybeSingle();
  if (sessionError || !session) return json({ error: "session_not_found" }, 404);
  if (!(await canOperateTenantOrPlatform(supa, session.tenant_id, user.id, user.email))) {
    return json({ error: "forbidden" }, 403);
  }

  const note = cleanText(body.note);

  if (action === "add_note") {
    if (!note) return json({ error: "missing_note" }, 400);
    await supa.from("crm_activities").insert({
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      user_id: user.id,
      activity_type: "note",
      body: note,
    });
    await supa.from("tracking_sessions").update({ last_crm_activity_at: new Date().toISOString() }).eq("id", session.id);
    return json({ ok: true });
  }

  const status = cleanText(body.status) as LeadStatus;
  if (action !== "update_stage") return json({ error: "unknown_action" }, 400);
  if (!isAllowedStatus(status)) return json({ error: "invalid_status" }, 400);

  const now = new Date().toISOString();
  const tags = mergeTags(session.tags, body.tags, status);
  const updates: Record<string, unknown> = {
    lead_status: status,
    tags,
    lead_score: statusScore[status],
    last_crm_activity_at: now,
  };

  if (body.next_follow_up_at !== undefined) {
    updates.next_follow_up_at = cleanText(body.next_follow_up_at) || null;
  }

  const phone = cleanDigits(body.customer_phone);
  const email = cleanText(body.customer_email);
  const name = cleanText(body.customer_name);
  if (phone) updates.customer_phone = phone;
  if (email) updates.customer_email = email;
  if (name) updates.customer_name = name;

  if (status === "qualified" && !session.qualified_at) updates.qualified_at = now;
  if (status === "bad" && !session.bad_at) updates.bad_at = now;
  if (status === "lost" && !session.lost_at) updates.lost_at = now;

  if (status === "sold") {
    const revenue = Number(body.revenue ?? session.revenue ?? session.offer?.price ?? 0);
    if (!Number.isFinite(revenue) || revenue <= 0) return json({ error: "invalid_revenue" }, 400);
    updates.revenue = revenue;
    updates.sold_at = session.sold_at ?? now;
  }

  const { error: updateError } = await supa.from("tracking_sessions").update(updates).eq("id", session.id);
  if (updateError) return json({ error: updateError.message }, 500);

  const activities: Record<string, unknown>[] = [
    {
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      user_id: user.id,
      activity_type: "stage_change",
      body: note || null,
      from_status: session.lead_status,
      to_status: status,
      metadata: { tags },
    },
  ];

  if (note) {
    activities.push({
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      user_id: user.id,
      activity_type: "note",
      body: note,
      from_status: session.lead_status,
      to_status: status,
      metadata: {},
    });
  }

  await supa.from("crm_activities").insert(activities);

  const eventName = stageEvents[status];
  let capi: CapiResult | null = null;
  let eventId: string | null = null;

  if (eventName) {
    const capiPayload = await buildCapiPayload(eventName, session, status, body);
    eventId = String(capiPayload.event_id);
    capi = await sendCapi(session.tenant_id, capiPayload);

    await supa.from("capi_events").insert({
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      event_name: eventName,
      event_id: eventId,
      pixel_id: capi.pixelId ?? null,
      request_payload: capiPayload,
      response_payload: capi.data,
      ok: capi.ok,
      status_code: capi.status,
      error_message: capi.error ?? null,
    });

    await supa.from("crm_activities").insert({
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      user_id: user.id,
      activity_type: "capi",
      body: eventName,
      from_status: session.lead_status,
      to_status: status,
      metadata: { ok: capi.ok, status_code: capi.status, event_id: eventId },
    });

    if (eventName === "Purchase" && capi.ok) {
      await supa.from("tracking_sessions").update({ capi_purchase_ok: true }).eq("id", session.id);
    }
  }

  const audienceKey: AudienceKey | null = status === "qualified" ? "qualified" : status === "sold" ? "purchased" : null;
  let audienceSync = null;

  if (audienceKey) {
    const updatedSession = { ...session, ...updates };
    audienceSync = await syncSessionToMetaAudience(supa, updatedSession, audienceKey, body);

    await supa.from("crm_activities").insert({
      tenant_id: session.tenant_id,
      tracking_session_id: session.id,
      user_id: user.id,
      activity_type: "system",
      body: audienceKey === "qualified" ? "meta_audience_qualified" : "meta_audience_purchased",
      from_status: session.lead_status,
      to_status: status,
      metadata: audienceSync,
    });
  }

  return json({
    ok: true,
    status,
    tags,
    event_name: eventName ?? null,
    capi_ok: capi?.ok ?? null,
    audience_sync: audienceSync,
  });
});
