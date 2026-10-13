import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { syncSessionToMetaAudience } from "../_shared/meta-audiences.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function h256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function cleanDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function cleanText(v: unknown): string {
  return String(v ?? "").trim();
}

async function authenticate(req: Request) {
  const bearer = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearer) {
    const { data, error } = await supa.auth.getUser(bearer);
    if (!error && data.user) return { user: data.user, isWebhook: false };
  }
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const { data } = await supa
      .from("webhook_keys")
      .select("tenant_id")
      .eq("plain_key", apiKey)
      .eq("status", "active")
      .maybeSingle();
    if (data) return { webhookTenantId: data.tenant_id, isWebhook: true };
    const hashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(apiKey),
    );
    const hash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { data: byHash } = await supa
      .from("webhook_keys")
      .select("tenant_id")
      .eq("key_hash", hash)
      .eq("status", "active")
      .maybeSingle();
    if (byHash) return { webhookTenantId: byHash.tenant_id, isWebhook: true };
  }
  return null;
}

type CapiResult = {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
  pixelId?: string;
};

async function sendCapi(
  tenantId: string,
  event: Record<string, unknown>,
): Promise<CapiResult> {
  const { data: creds, error } = await supa
    .from("tenant_meta_credentials")
    .select("pixel_id, access_token, graph_version, enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error)
    return { ok: false, status: null, data: null, error: error.message };
  if (!creds?.enabled || !creds.pixel_id || !creds.access_token) {
    return {
      ok: false,
      status: null,
      data: { error: "missing_meta_credentials" },
    };
  }

  const version =
    Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
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
    return {
      ok: response.ok,
      status: response.status,
      data,
      pixelId: creds.pixel_id,
    };
  } catch (err) {
    return { ok: false, status: null, data: null, error: String(err) };
  }
}

async function buildUserData(
  session: Record<string, any> | null,
  insight: Record<string, any> | null,
) {
  const ud: Record<string, unknown> = {
    country: await h256("br"),
  };
  if (session) {
    ud.client_ip_address = session.ip;
    ud.client_user_agent = session.ua;
    ud.fbc = session.fbc;
    ud.fbp = session.fbp;
  }
  const phone =
    cleanDigits(session?.customer_phone) ||
    cleanDigits(insight?.extracted_phone);
  const email =
    cleanText(session?.customer_email) || cleanText(insight?.extracted_email);
  const name =
    cleanText(session?.customer_name) || cleanText(insight?.extracted_name);

  if (phone) ud.ph = await h256(phone);
  if (email) ud.em = await h256(email);
  if (name) {
    const parts = name.split(/\s+/);
    ud.fn = await h256(parts[0]);
    if (parts.length > 1) ud.ln = await h256(parts.slice(1).join(" "));
  }
  return ud;
}

async function firePurchase(
  signal: Record<string, any>,
  session: Record<string, any> | null,
  insight: Record<string, any> | null,
  userId: string | null,
) {
  const tenantId = signal.tenant_id;
  const revenue = Number(
    signal.estimated_value ?? session?.revenue ?? session?.offer?.price ?? 0,
  );
  if (!Number.isFinite(revenue) || revenue <= 0) {
    return { ok: false, error: "invalid_revenue" };
  }

  const metaEventId = session
    ? `purchase_${session.id}`
    : `purchase_ai_${signal.id}`;

  const { data: existingEvent } = await supa
    .from("capi_events")
    .select("id, ok")
    .eq("event_id", metaEventId)
    .eq("ok", true)
    .maybeSingle();
  if (existingEvent) {
    await supa
      .from("sale_signals")
      .update({
        capi_status: "success",
        capi_event_id: existingEvent.id,
        meta_event_id: metaEventId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", signal.id);
    return { ok: true, already_sent: true, event_id: metaEventId };
  }

  const capiPayload: Record<string, unknown> = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: metaEventId,
    event_source_url:
      session?.request_url ?? session?.source_url ?? "",
    action_source: "website",
    user_data: await buildUserData(session, insight),
    custom_data: {
      content_ids: [
        session?.offer?.slug ??
          session?.smart_link?.code ??
          signal.product_name ??
          session?.ref ??
          "ai_sale",
      ],
      content_type: "product",
      content_name:
        signal.product_name ??
        session?.offer?.name ??
        session?.smart_link?.name ??
        "Local offer",
      content_category:
        signal.product_category ??
        session?.offer?.category ??
        "local_offer",
      value: revenue,
      currency: signal.currency ?? "BRL",
      ref: session?.ref ?? null,
      utm_source: session?.utm_source ?? null,
      utm_medium: session?.utm_medium ?? null,
      utm_campaign: session?.utm_campaign ?? null,
      utm_content: session?.utm_content ?? null,
      utm_term: session?.utm_term ?? null,
    },
  };

  await supa
    .from("sale_signals")
    .update({
      capi_status: "sending",
      capi_attempts: (signal.capi_attempts ?? 0) + 1,
      capi_last_attempt_at: new Date().toISOString(),
      meta_event_id: metaEventId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", signal.id);

  const capi = await sendCapi(tenantId, capiPayload);

  const { data: capiRow } = await supa
    .from("capi_events")
    .insert({
      tenant_id: tenantId,
      tracking_session_id: session?.id ?? signal.tracking_session_id ?? null,
      event_name: "Purchase",
      event_id: metaEventId,
      pixel_id: capi.pixelId ?? null,
      request_payload: capiPayload,
      response_payload: capi.data,
      ok: capi.ok,
      status_code: capi.status,
      error_message: capi.error ?? null,
    })
    .select("id")
    .single();

  await supa
    .from("sale_signals")
    .update({
      capi_status: capi.ok ? "success" : "failed",
      capi_event_id: capiRow?.id ?? null,
      capi_error: capi.ok ? null : (capi.error ?? `HTTP ${capi.status}`),
      updated_at: new Date().toISOString(),
    })
    .eq("id", signal.id);

  if (session && capi.ok) {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      lead_status: "sold",
      sold_at: session.sold_at ?? now,
      revenue,
      capi_purchase_ok: true,
      lead_score: 100,
      last_crm_activity_at: now,
    };
    const phone =
      cleanDigits(insight?.extracted_phone) || session.customer_phone;
    const email =
      cleanText(insight?.extracted_email) || session.customer_email;
    const name =
      cleanText(insight?.extracted_name) || session.customer_name;
    if (phone) updates.customer_phone = phone;
    if (email) updates.customer_email = email;
    if (name) updates.customer_name = name;

    const tags = Array.isArray(session.tags) ? [...session.tags] : [];
    if (!tags.includes("venda")) tags.push("venda");
    if (!tags.includes("venda-ia")) tags.push("venda-ia");
    updates.tags = tags.slice(0, 12);

    await supa
      .from("tracking_sessions")
      .update(updates)
      .eq("id", session.id);

    await supa.from("crm_activities").insert({
      tenant_id: tenantId,
      tracking_session_id: session.id,
      user_id: userId,
      activity_type: "capi",
      body: "Purchase (AI sale signal)",
      from_status: session.lead_status,
      to_status: "sold",
      metadata: {
        ok: capi.ok,
        status_code: capi.status,
        event_id: metaEventId,
        sale_signal_id: signal.id,
        source: "ai_analyzer",
      },
    });

    await syncSessionToMetaAudience(
      supa,
      { ...session, ...updates },
      "purchased",
      {},
    ).catch(() => {});
  }

  return {
    ok: capi.ok,
    event_id: metaEventId,
    capi_status: capi.status,
    error: capi.error ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authenticate(req);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = cleanText(body.action);
  const tenantId = cleanText(body.tenant_id);

  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (!auth.isWebhook) {
    if (
      !(await canOperateTenantOrPlatform(
        supa,
        tenantId,
        auth.user!.id,
        auth.user!.email,
      ))
    )
      return json({ error: "forbidden" }, 403);
  } else {
    if (auth.webhookTenantId !== tenantId)
      return json({ error: "forbidden" }, 403);
  }

  if (action === "list_sales") {
    const status = cleanText(body.status) || null;
    const limit = Math.min(Number(body.limit ?? 50), 200);
    const offset = Number(body.offset ?? 0);

    let query = supa
      .from("sale_signals")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("capi_status", status);
    if (body.signal_type) query = query.eq("signal_type", body.signal_type);

    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);

    const { count } = await supa
      .from("sale_signals")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);

    return json({ ok: true, sales: data ?? [], total: count ?? 0 });
  }

  if (action === "confirm_sale") {
    const signalId = cleanText(body.signal_id);
    if (!signalId) return json({ error: "missing_signal_id" }, 400);

    const { data: signal } = await supa
      .from("sale_signals")
      .select("*")
      .eq("id", signalId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!signal) return json({ error: "signal_not_found" }, 404);
    if (signal.status === "rejected")
      return json({ error: "signal_already_rejected" }, 409);
    if (signal.capi_status === "success")
      return json({ error: "already_sent_to_meta" }, 409);

    const now = new Date().toISOString();
    const userId = auth.isWebhook ? null : auth.user!.id;

    const revenue = Number(body.revenue ?? signal.estimated_value ?? 0);
    if (body.product_name) signal.product_name = body.product_name;
    if (body.product_category) signal.product_category = body.product_category;
    if (revenue > 0) signal.estimated_value = revenue;

    await supa
      .from("sale_signals")
      .update({
        status: "confirmed",
        confirmed_by: userId,
        confirmed_at: now,
        requires_human_confirmation: false,
        estimated_value: signal.estimated_value,
        product_name: signal.product_name,
        product_category: signal.product_category,
        updated_at: now,
      })
      .eq("id", signalId);

    let session = null;
    if (signal.tracking_session_id) {
      const { data } = await supa
        .from("tracking_sessions")
        .select("*, offer:offers(*), smart_link:smart_links(*)")
        .eq("id", signal.tracking_session_id)
        .maybeSingle();
      session = data;
    }

    let insight = null;
    if (signal.conversation_id) {
      const { data } = await supa
        .from("conversation_insights")
        .select("*")
        .eq("conversation_id", signal.conversation_id)
        .maybeSingle();
      insight = data;
    }

    const result = await firePurchase(signal, session, insight, userId);
    return json({ ok: true, ...result });
  }

  if (action === "reject_sale") {
    const signalId = cleanText(body.signal_id);
    if (!signalId) return json({ error: "missing_signal_id" }, 400);

    const { data: signal } = await supa
      .from("sale_signals")
      .select("id, status, capi_status, tenant_id")
      .eq("id", signalId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!signal) return json({ error: "signal_not_found" }, 404);
    if (signal.capi_status === "success")
      return json({ error: "already_sent_to_meta" }, 409);

    const userId = auth.isWebhook ? null : auth.user!.id;
    const now = new Date().toISOString();

    await supa
      .from("sale_signals")
      .update({
        status: "rejected",
        rejected_by: userId,
        rejected_at: now,
        capi_status: "skipped",
        updated_at: now,
      })
      .eq("id", signalId);

    return json({ ok: true, status: "rejected" });
  }

  if (action === "retry_capi") {
    const signalId = cleanText(body.signal_id);
    if (!signalId) return json({ error: "missing_signal_id" }, 400);

    const { data: signal } = await supa
      .from("sale_signals")
      .select("*")
      .eq("id", signalId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!signal) return json({ error: "signal_not_found" }, 404);
    if (signal.capi_status === "success")
      return json({ error: "already_sent" }, 409);
    if (signal.status !== "confirmed")
      return json({ error: "not_confirmed" }, 400);

    let session = null;
    if (signal.tracking_session_id) {
      const { data } = await supa
        .from("tracking_sessions")
        .select("*, offer:offers(*), smart_link:smart_links(*)")
        .eq("id", signal.tracking_session_id)
        .maybeSingle();
      session = data;
    }

    let insight = null;
    if (signal.conversation_id) {
      const { data } = await supa
        .from("conversation_insights")
        .select("*")
        .eq("conversation_id", signal.conversation_id)
        .maybeSingle();
      insight = data;
    }

    const userId = auth.isWebhook ? null : auth.user!.id;
    const result = await firePurchase(signal, session, insight, userId);
    return json({ ok: true, ...result });
  }

  if (action === "auto_process") {
    const conversationId = cleanText(body.conversation_id);
    if (!conversationId)
      return json({ error: "missing_conversation_id" }, 400);

    const { data: signals } = await supa
      .from("sale_signals")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .eq("status", "detected")
      .eq("capi_status", "pending")
      .order("confidence", { ascending: false });

    if (!signals?.length) return json({ ok: true, processed: 0 });

    const results = [];
    for (const signal of signals) {
      const isAutoConfirmable =
        signal.signal_type === "confirmed_sale" &&
        (signal.confidence ?? 0) >= 0.9 &&
        signal.evidence_text;

      if (isAutoConfirmable) {
        const now = new Date().toISOString();
        await supa
          .from("sale_signals")
          .update({
            status: "confirmed",
            confirmed_at: now,
            requires_human_confirmation: false,
            auto_confirmed: true,
            updated_at: now,
          })
          .eq("id", signal.id);
        signal.status = "confirmed";

        let session = null;
        if (signal.tracking_session_id) {
          const { data } = await supa
            .from("tracking_sessions")
            .select("*, offer:offers(*), smart_link:smart_links(*)")
            .eq("id", signal.tracking_session_id)
            .maybeSingle();
          session = data;
        }

        let insight = null;
        if (signal.conversation_id) {
          const { data } = await supa
            .from("conversation_insights")
            .select("*")
            .eq("conversation_id", signal.conversation_id)
            .maybeSingle();
          insight = data;
        }

        const result = await firePurchase(signal, session, insight, null);
        results.push({ signal_id: signal.id, auto: true, ...result });
      } else {
        await supa
          .from("sale_signals")
          .update({
            requires_human_confirmation: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", signal.id);
        results.push({
          signal_id: signal.id,
          auto: false,
          requires_human_confirmation: true,
        });
      }
    }

    return json({ ok: true, processed: results.length, results });
  }

  return json({ error: "unknown_action" }, 400);
});
