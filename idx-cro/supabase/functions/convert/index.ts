import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform } from "../_shared/access.ts";
import { confirmPurchase } from "../_shared/purchase.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  const ref = cleanText(body.ref).toLowerCase();
  const requestedTenantId = cleanText(body.tenant_id);
  const phone = cleanDigits(body.customer_phone);
  const email = cleanText(body.customer_email).toLowerCase();
  const name = cleanText(body.customer_name);
  const select = "*, tenant:tenants(*), offer:offers(*), smart_link:smart_links(*)";
  let session: Record<string, any> | null = null;
  let matchStrategy = "ref";

  if (ref) {
    const { data, error: sessionError } = await supa
      .from("tracking_sessions")
      .select(select)
      .eq("ref", ref)
      .maybeSingle();

    if (sessionError || !data) return json({ error: "session_not_found" }, 404);
    session = data as Record<string, any>;

    if (!(await canOperateTenantOrPlatform(supa, data.tenant_id, user.id, user.email))) {
      return json({ error: "forbidden" }, 403);
    }
  } else {
    if (!requestedTenantId) return json({ error: "missing_tenant_id" }, 400);
    if (!phone && !email) return json({ error: "missing_contact_identifier" }, 400);
    if (!(await canOperateTenantOrPlatform(supa, requestedTenantId, user.id, user.email))) {
      return json({ error: "forbidden" }, 403);
    }

    const matches = new Map<string, Record<string, any>>();
    const addMatches = (rows: Record<string, any>[] | null) => {
      for (const row of rows ?? []) matches.set(row.id, row);
    };

    if (phone) {
      const { data } = await supa
        .from("tracking_sessions")
        .select(select)
        .eq("tenant_id", requestedTenantId)
        .neq("lead_status", "sold")
        .eq("customer_phone", phone)
        .order("clicked_at", { ascending: false })
        .limit(3);
      addMatches(data as Record<string, any>[] | null);
      matchStrategy = "phone";
    }

    if (email) {
      const { data } = await supa
        .from("tracking_sessions")
        .select(select)
        .eq("tenant_id", requestedTenantId)
        .neq("lead_status", "sold")
        .ilike("customer_email", email)
        .order("clicked_at", { ascending: false })
        .limit(3);
      addMatches(data as Record<string, any>[] | null);
      matchStrategy = phone ? "phone_or_email" : "email";
    }

    const matchedSessions = Array.from(matches.values()).sort((a, b) => String(b.clicked_at).localeCompare(String(a.clicked_at)));
    if (!matchedSessions.length) return json({ error: "contact_match_not_found" }, 404);
    if (matchedSessions.length > 1) return json({ error: "ambiguous_contact_match", matches: matchedSessions.map((item) => ({ ref: item.ref, clicked_at: item.clicked_at })) }, 409);
    session = matchedSessions[0];
  }

  if (!session) return json({ error: "session_not_found" }, 404);

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

  const revenue = Number(body.revenue ?? session.offer?.price ?? 0);
  if (!Number.isFinite(revenue) || revenue <= 0) {
    return json({ error: "invalid_revenue" }, 400);
  }

  // Purchase CAPI, público de compradores e histórico do CRM ficam em
  // _shared/purchase.ts, que também é usado pela detecção de vendas por IA.
  const result = await confirmPurchase(supa, session, {
    revenue,
    phone,
    email,
    name,
    notes: body.notes ?? null,
    userId: user.id,
    source: "manual",
  });
  if (!result.ok) return json({ error: result.error }, result.error === "already_sold" ? 409 : 400);

  return json({ ok: true, capi_ok: result.capi_ok, audience_sync: result.audience_sync, status: "sold", match_strategy: matchStrategy, ref: session.ref });
});
