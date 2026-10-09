type SupabaseLike = {
  from: (table: string) => any;
};

export type CapiResult = {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
  pixelId?: string;
};

export async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sendCapi(
  supa: SupabaseLike,
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
      body: JSON.stringify({ data: [event], access_token: creds.access_token }),
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data, pixelId: creds.pixel_id };
  } catch (err) {
    return { ok: false, status: null, data: null, error: String(err) };
  }
}

// Sends the event and records it in capi_events (same row shape used by go/convert/crm).
export async function sendAndLogCapi(
  supa: SupabaseLike,
  session: Record<string, any>,
  payload: Record<string, unknown>,
): Promise<CapiResult> {
  const capi = await sendCapi(supa, session.tenant_id, payload);
  await supa.from("capi_events").insert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    event_name: payload.event_name,
    event_id: payload.event_id,
    pixel_id: capi.pixelId ?? null,
    request_payload: payload,
    response_payload: capi.data,
    ok: capi.ok,
    status_code: capi.status,
    error_message: capi.error ?? null,
  });
  return capi;
}

export async function sessionUserData(
  session: Record<string, any>,
  contact: { phone?: string | null; email?: string | null; name?: string | null } = {},
): Promise<Record<string, unknown>> {
  const userData: Record<string, unknown> = {
    client_ip_address: session.ip ?? undefined,
    client_user_agent: session.ua ?? undefined,
    fbc: session.fbc ?? undefined,
    fbp: session.fbp ?? undefined,
    country: await h256("br"),
  };
  const phone = String(contact.phone ?? session.customer_phone ?? "").replace(/\D/g, "");
  const email = String(contact.email ?? session.customer_email ?? "").trim().toLowerCase();
  const name = String(contact.name ?? session.customer_name ?? "").trim();
  if (phone) userData.ph = await h256(phone);
  if (email) userData.em = await h256(email);
  if (name) {
    const parts = name.split(/\s+/);
    userData.fn = await h256(parts[0]);
    if (parts.length > 1) userData.ln = await h256(parts.slice(1).join(" "));
  }
  return userData;
}

export function sessionCustomData(session: Record<string, any>, value: number): Record<string, unknown> {
  const offer = session.offer ?? null;
  const link = session.smart_link ?? null;
  return {
    content_ids: [offer?.slug ?? link?.code ?? session.ref],
    content_type: "product",
    content_name: offer?.name ?? link?.name ?? "Local offer",
    content_category: offer?.category ?? "local_offer",
    value,
    currency: "BRL",
    ref: session.ref,
    utm_source: session.utm_source,
    utm_medium: session.utm_medium,
    utm_campaign: session.utm_campaign,
    utm_content: session.utm_content,
    utm_term: session.utm_term,
  };
}
