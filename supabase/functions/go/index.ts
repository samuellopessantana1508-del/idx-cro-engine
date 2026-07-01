import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const fallbackUrl = Deno.env.get("FALLBACK_URL") ?? "https://wa.me";

type CapiResult = {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
};

function cleanDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function shortRef(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const part = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}`;
}

function param(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return value && value.trim() ? value.trim() : null;
}

function fbcFromFbclid(fbclid: string | null): string | null {
  if (!fbclid) return null;
  return `fb.1.${Date.now()}.${fbclid}`;
}

function money(value: unknown): string {
  const n = Number(value ?? 0);
  return n > 0 ? `R$ ${n.toFixed(2).replace(".", ",")}` : "";
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

async function sendCapi(
  tenantId: string,
  event: Record<string, unknown>,
): Promise<CapiResult & { pixelId?: string }> {
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

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const code = url.pathname.split("/").filter(Boolean).pop();
  if (!code) return Response.redirect(fallbackUrl, 302);

  const { data: link, error } = await supa
    .from("smart_links")
    .select("*, tenant:tenants(*), offer:offers(*)")
    .eq("code", code)
    .eq("status", "active")
    .maybeSingle();

  if (error || !link || link.tenant?.status !== "active") {
    return Response.redirect(fallbackUrl, 302);
  }

  const tenant = link.tenant;
  const offer = link.offer;
  const now = new Date().toISOString();
  const ref = shortRef();
  const fbclid = param(url, "fbclid");
  const fbc = param(url, "fbc") ?? fbcFromFbclid(fbclid);
  const fbp = param(url, "fbp");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = req.headers.get("user-agent");
  const sourceUrl = req.headers.get("referer");

  const utm_source = param(url, "utm_source") ?? link.default_utm_source;
  const utm_medium = param(url, "utm_medium") ?? link.default_utm_medium;
  const utm_campaign = param(url, "utm_campaign") ?? link.default_utm_campaign;
  const utm_content = param(url, "utm_content") ?? link.default_utm_content;
  const utm_term = param(url, "utm_term") ?? link.default_utm_term;

  const template = link.message_template || offer?.default_message || tenant.default_message_template;
  const message = applyTemplate(template, {
    oferta: offer?.name ?? link.name,
    empresa: tenant.name,
    ref,
    preco: money(offer?.price),
    campanha: utm_campaign ?? "",
  });

  const whatsapp = cleanDigits(tenant.whatsapp_number);
  const targetUrl = `https://wa.me/${whatsapp}?text=${encodeURIComponent(message)}`;

  const { data: session, error: sessionError } = await supa
    .from("tracking_sessions")
    .insert({
      tenant_id: tenant.id,
      smart_link_id: link.id,
      offer_id: offer?.id ?? null,
      ref,
      source_url: sourceUrl,
      request_url: url.toString(),
      target_url: targetUrl,
      ip,
      ua,
      fbc,
      fbp,
      fbclid,
      gclid: param(url, "gclid"),
      ttclid: param(url, "ttclid"),
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      clicked_at: now,
      redirected_at: now,
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    return Response.redirect(targetUrl, 302);
  }

  const value = offer?.price ?? 0;
  const eventId = `lead_${session.id}`;
  const capiPayload = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: url.toString(),
    action_source: "website",
    user_data: {
      client_ip_address: ip,
      client_user_agent: ua,
      fbc,
      fbp,
    },
    custom_data: {
      content_ids: [offer?.slug ?? link.code],
      content_type: "product",
      content_name: offer?.name ?? link.name,
      content_category: offer?.category ?? "local_offer",
      value,
      currency: "BRL",
      ref,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
    },
  };

  const capi = await sendCapi(tenant.id, capiPayload);

  await supa.from("capi_events").insert({
    tenant_id: tenant.id,
    tracking_session_id: session.id,
    event_name: "Lead",
    event_id: eventId,
    pixel_id: capi.pixelId ?? null,
    request_payload: capiPayload,
    response_payload: capi.data,
    ok: capi.ok,
    status_code: capi.status,
    error_message: capi.error ?? null,
  });

  if (capi.ok) {
    await supa.from("tracking_sessions").update({ capi_lead_ok: true }).eq("id", session.id);
  }

  return Response.redirect(targetUrl, 302);
});
