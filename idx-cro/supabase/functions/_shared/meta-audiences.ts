export type AudienceKey = "qualified" | "purchased";

type SupabaseLike = {
  from: (table: string) => any;
};

type AudienceResult = {
  ok: boolean;
  audience_key: AudienceKey;
  status: "created" | "synced" | "skipped" | "failed";
  meta_audience_id?: string | null;
  error?: string;
  detail?: unknown;
  identifiers?: Record<string, boolean>;
};

const audienceConfig: Record<AudienceKey, { name: string; description: string }> = {
  qualified: {
    name: "IDX - Leads qualificados",
    description: "Leads marcados como qualificados no CRM IDX. Usar para remarketing e lookalike de bons leads.",
  },
  purchased: {
    name: "IDX - Compradores",
    description: "Clientes que compraram e foram marcados como venda no IDX. Usar para exclusao, upsell e lookalike.",
  },
};

function cleanDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeActId(value: unknown): string {
  const clean = cleanText(value);
  if (!clean) return "";
  return clean.startsWith("act_") ? clean : `act_${clean}`;
}

async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function audienceIdentifiers(session: Record<string, any>, body: Record<string, any> = {}) {
  const phone = cleanDigits(body.customer_phone || session.customer_phone);
  const email = cleanText(body.customer_email || session.customer_email).toLowerCase();
  const schema: string[] = [];
  const row: string[] = [];
  const identifiers: Record<string, boolean> = {};

  if (email) {
    schema.push("EMAIL_SHA256");
    row.push(await h256(email));
    identifiers.email = true;
  }

  if (phone) {
    schema.push("PHONE_SHA256");
    row.push(await h256(phone));
    identifiers.phone = true;
  }

  return { schema, row, identifiers };
}

async function markAudience(
  supa: SupabaseLike,
  tenantId: string,
  audienceKey: AudienceKey,
  values: Record<string, unknown>,
) {
  await supa.from("meta_custom_audiences").upsert({
    tenant_id: tenantId,
    audience_key: audienceKey,
    name: audienceConfig[audienceKey].name,
    description: audienceConfig[audienceKey].description,
    updated_at: new Date().toISOString(),
    ...values,
  }, { onConflict: "tenant_id,audience_key" });
}

async function markSync(
  supa: SupabaseLike,
  session: Record<string, any>,
  audienceKey: AudienceKey,
  values: Record<string, unknown>,
) {
  await supa.from("meta_audience_syncs").upsert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    audience_key: audienceKey,
    updated_at: new Date().toISOString(),
    ...values,
  }, { onConflict: "tracking_session_id,audience_key" });
}

export async function ensureMetaAudience(
  supa: SupabaseLike,
  tenantId: string,
  audienceKey: AudienceKey,
  options: { adAccountId?: string | null } = {},
): Promise<AudienceResult> {
  const { data: existing } = await supa
    .from("meta_custom_audiences")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("audience_key", audienceKey)
    .maybeSingle();

  if (existing?.meta_audience_id) {
    return {
      ok: true,
      audience_key: audienceKey,
      status: "created",
      meta_audience_id: existing.meta_audience_id,
    };
  }

  const { data: creds, error: credsError } = await supa
    .from("tenant_meta_credentials")
    .select("access_token, graph_version, selected_ad_account_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (credsError) {
    await markAudience(supa, tenantId, audienceKey, { sync_status: "failed", last_error: credsError.message });
    return { ok: false, audience_key: audienceKey, status: "failed", error: credsError.message };
  }

  if (!creds?.access_token) {
    const error = "meta_not_connected";
    await markAudience(supa, tenantId, audienceKey, { sync_status: "failed", last_error: error });
    return { ok: false, audience_key: audienceKey, status: "failed", error };
  }

  const adAccountId = normalizeActId(options.adAccountId || creds.selected_ad_account_id);
  if (!adAccountId) {
    const error = "missing_ad_account_id";
    await markAudience(supa, tenantId, audienceKey, { sync_status: "failed", last_error: error });
    return { ok: false, audience_key: audienceKey, status: "failed", error };
  }

  const version = Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
  const endpoint = `https://graph.facebook.com/${version}/${adAccountId}/customaudiences`;
  const form = new FormData();
  form.set("name", audienceConfig[audienceKey].name);
  form.set("description", audienceConfig[audienceKey].description);
  form.set("subtype", "CUSTOM");
  form.set("customer_file_source", "USER_PROVIDED_ONLY");
  form.set("access_token", creds.access_token);

  const response = await fetch(endpoint, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  const metaAudienceId = String(payload.id ?? "");

  if (!response.ok || !metaAudienceId) {
    const error = JSON.stringify(payload);
    await markAudience(supa, tenantId, audienceKey, {
      ad_account_id: adAccountId,
      sync_status: "failed",
      last_error: error,
    });
    return { ok: false, audience_key: audienceKey, status: "failed", error, detail: payload };
  }

  await markAudience(supa, tenantId, audienceKey, {
    meta_audience_id: metaAudienceId,
    ad_account_id: adAccountId,
    customer_file_source: "USER_PROVIDED_ONLY",
    sync_status: "created",
    last_error: null,
  });

  return {
    ok: true,
    audience_key: audienceKey,
    status: "created",
    meta_audience_id: metaAudienceId,
    detail: payload,
  };
}

export async function syncSessionToMetaAudience(
  supa: SupabaseLike,
  session: Record<string, any>,
  audienceKey: AudienceKey,
  body: Record<string, any> = {},
  options: { adAccountId?: string | null } = {},
): Promise<AudienceResult> {
  const identifiers = await audienceIdentifiers(session, body);

  if (!identifiers.row.length) {
    const error = "missing_customer_identifier";
    await markSync(supa, session, audienceKey, {
      sync_status: "skipped",
      identifiers: identifiers.identifiers,
      last_error: error,
      last_synced_at: new Date().toISOString(),
    });
    return {
      ok: false,
      audience_key: audienceKey,
      status: "skipped",
      error,
      identifiers: identifiers.identifiers,
    };
  }

  const audience = await ensureMetaAudience(supa, session.tenant_id, audienceKey, options);
  if (!audience.ok || !audience.meta_audience_id) {
    await markSync(supa, session, audienceKey, {
      sync_status: "failed",
      identifiers: identifiers.identifiers,
      last_error: audience.error ?? "audience_create_failed",
      last_synced_at: new Date().toISOString(),
    });
    return audience;
  }

  const { data: creds } = await supa
    .from("tenant_meta_credentials")
    .select("access_token, graph_version")
    .eq("tenant_id", session.tenant_id)
    .maybeSingle();

  const version = Deno.env.get("META_GRAPH_VERSION") ?? creds?.graph_version ?? "v25.0";
  const endpoint = `https://graph.facebook.com/${version}/${audience.meta_audience_id}/users`;
  const form = new FormData();
  form.set("payload", JSON.stringify({
    schema: identifiers.schema,
    data: [identifiers.row],
  }));
  form.set("access_token", creds?.access_token ?? "");

  const response = await fetch(endpoint, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = JSON.stringify(payload);
    await markSync(supa, session, audienceKey, {
      meta_audience_id: audience.meta_audience_id,
      sync_status: "failed",
      identifiers: identifiers.identifiers,
      response_payload: payload,
      last_error: error,
      last_synced_at: new Date().toISOString(),
    });
    return {
      ok: false,
      audience_key: audienceKey,
      status: "failed",
      meta_audience_id: audience.meta_audience_id,
      error,
      detail: payload,
      identifiers: identifiers.identifiers,
    };
  }

  await markSync(supa, session, audienceKey, {
    meta_audience_id: audience.meta_audience_id,
    sync_status: "synced",
    identifiers: identifiers.identifiers,
    response_payload: payload,
    last_error: null,
    last_synced_at: new Date().toISOString(),
  });

  await markAudience(supa, session.tenant_id, audienceKey, {
    meta_audience_id: audience.meta_audience_id,
    sync_status: "synced",
    last_error: null,
    last_synced_at: new Date().toISOString(),
  });

  return {
    ok: true,
    audience_key: audienceKey,
    status: "synced",
    meta_audience_id: audience.meta_audience_id,
    detail: payload,
    identifiers: identifiers.identifiers,
  };
}

export async function syncTenantAudience(
  supa: SupabaseLike,
  tenantId: string,
  audienceKey: AudienceKey,
  options: { adAccountId?: string | null; limit?: number } = {},
) {
  const status = audienceKey === "qualified" ? "qualified" : "sold";
  const limit = Math.min(Math.max(Number(options.limit ?? 500), 1), 1000);
  const { data: sessions, error } = await supa
    .from("tracking_sessions")
    .select("*, tenant:tenants(*), offer:offers(*), smart_link:smart_links(*)")
    .eq("tenant_id", tenantId)
    .eq("lead_status", status)
    .order("clicked_at", { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: error.message, synced: 0, failed: 0, skipped: 0 };

  const results = [];
  for (const session of sessions ?? []) {
    results.push(await syncSessionToMetaAudience(supa, session, audienceKey, {}, options));
  }

  return {
    ok: results.every((item) => item.ok || item.status === "skipped"),
    total: results.length,
    synced: results.filter((item) => item.status === "synced").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results,
  };
}
