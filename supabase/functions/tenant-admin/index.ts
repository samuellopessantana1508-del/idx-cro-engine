import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 64);
}

function cleanPhone(value: string): string {
  return value.replace(/\D/g, "");
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function numericOrNull(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

function envEmailList(name: string): string[] {
  return String(Deno.env.get(name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function platformRole(userId: string, email?: string | null): Promise<string | null> {
  const emailAllowList = envEmailList("PLATFORM_OWNER_EMAILS");
  if (email && emailAllowList.includes(email.toLowerCase())) return "owner";

  const { data } = await supa
    .from("platform_users")
    .select("role")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  return data?.role ?? null;
}

function canCreateTenants(role: string | null): boolean {
  return ["owner", "admin", "support"].includes(String(role ?? ""));
}

async function isFirstPlatformSetup(): Promise<boolean> {
  const [tenants, platformUsers] = await Promise.all([
    supa.from("tenants").select("id", { count: "exact", head: true }),
    supa.from("platform_users").select("id", { count: "exact", head: true }),
  ]);

  return Number(tenants.count ?? 0) === 0 && Number(platformUsers.count ?? 0) === 0;
}

async function canManageTenant(tenantId: string, userId: string): Promise<boolean> {
  const { data } = await supa
    .from("tenant_users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .in("role", ["owner", "admin"])
    .eq("status", "active")
    .maybeSingle();
  return Boolean(data);
}

async function canManageTenantOrPlatform(tenantId: string, userId: string, email?: string | null): Promise<boolean> {
  const role = await platformRole(userId, email);
  if (canCreateTenants(role)) return true;
  return canManageTenant(tenantId, userId);
}

async function audit(
  actorUserId: string,
  action: string,
  tenantId: string | null,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {},
) {
  await supa.from("platform_audit_log").insert({
    actor_user_id: actorUserId,
    tenant_id: tenantId,
    action,
    target_type: targetType ?? null,
    target_id: targetId ?? null,
    metadata,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "create_tenant") {
    const role = await platformRole(user.id, user.email);
    const requirePlatformAdmin = Deno.env.get("REQUIRE_PLATFORM_ADMIN_FOR_TENANT_CREATE") !== "false";
    const firstSetup = requirePlatformAdmin ? await isFirstPlatformSetup() : false;
    if (requirePlatformAdmin && !canCreateTenants(role) && !firstSetup) {
      return json({ error: "platform_admin_required" }, 403);
    }

    const name = cleanText(body.name);
    const whatsapp = cleanPhone(String(body.whatsapp_number ?? ""));
    const slug = slugify(String(body.slug ?? name));
    const businessSegment = cleanText(body.business_segment);
    const city = cleanText(body.city);
    const state = cleanText(body.state).toUpperCase().slice(0, 2);
    const primaryChannel = cleanText(body.primary_channel);
    const responsibleName = cleanText(body.responsible_name);
    const monthlyGoal = numericOrNull(body.monthly_goal);
    const averageTicket = numericOrNull(body.average_ticket);
    if (!name || !slug || !businessSegment || whatsapp.length < 12) {
      return json({ error: "invalid_tenant_payload" }, 400);
    }

    const { data: tenant, error } = await supa
      .from("tenants")
      .insert({
        name,
        slug,
        whatsapp_number: whatsapp,
        timezone: body.timezone ?? "America/Sao_Paulo",
      })
      .select("*")
      .single();

    if (error || !tenant) return json({ error: error?.message ?? "tenant_create_failed" }, 400);

    if (firstSetup) {
      await supa.from("platform_users").upsert({
        user_id: user.id,
        role: "owner",
        status: "active",
      }, { onConflict: "user_id" });
    }

    await supa.from("tenant_users").insert({
      tenant_id: tenant.id,
      user_id: user.id,
      email: user.email?.toLowerCase() ?? null,
      role: "owner",
      status: "active",
    });

    await supa.from("tenant_onboarding").upsert({
      tenant_id: tenant.id,
      tenant_created: true,
      whatsapp_checked: true,
      business_segment: businessSegment,
      city: city || null,
      state: state || null,
      monthly_goal: monthlyGoal,
      average_ticket: averageTicket,
      primary_channel: primaryChannel || null,
      responsible_name: responsibleName || null,
      updated_at: new Date().toISOString(),
    });

    await audit(user.id, "tenant.created", tenant.id, "tenant", tenant.id, {
      slug,
      role: firstSetup ? "first_setup_owner" : role,
      business_segment: businessSegment,
      city: city || null,
      state: state || null,
      primary_channel: primaryChannel || null,
    });

    return json({ ok: true, tenant });
  }

  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canManageTenantOrPlatform(tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);

  if (action === "save_meta_manual") {
    const pixelId = String(body.pixel_id ?? "").trim();
    const accessToken = String(body.access_token ?? "").trim();
    if (!pixelId || !accessToken) return json({ error: "missing_meta_credentials" }, 400);

    const { error } = await supa.from("tenant_meta_credentials").upsert({
      tenant_id: tenantId,
      pixel_id: pixelId,
      access_token: accessToken,
      test_event_code: body.test_event_code || null,
      graph_version: body.graph_version || Deno.env.get("META_GRAPH_VERSION") || "v25.0",
      enabled: true,
      integration_status: "connected",
      last_verified_at: new Date().toISOString(),
      last_error: null,
      updated_by: user.id,
    });

    if (error) return json({ error: error.message }, 400);
    await supa.from("tenant_onboarding").upsert({ tenant_id: tenantId, meta_connected: true });
    await audit(user.id, "meta.manual_saved", tenantId, "tenant_meta_credentials", tenantId, { pixel_id: pixelId });
    return json({ ok: true });
  }

  if (action === "invite_user") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const role = String(body.role ?? "operator");
    if (!email || !["owner", "admin", "operator", "viewer"].includes(role)) {
      return json({ error: "invalid_invite" }, 400);
    }

    const inviteRow = {
      tenant_id: tenantId,
      email,
      role,
      invited_by: user.id,
      status: "pending",
    };

    const { data: invite, error: inviteError } = await supa
      .from("tenant_invites")
      .insert(inviteRow)
      .select("*")
      .single();

    if (inviteError) return json({ error: inviteError.message }, 400);

    const redirectTo = Deno.env.get("APP_URL");
    const { data: authData, error: authError } = await supa.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo ? `${redirectTo}/` : undefined,
      data: { tenant_id: tenantId, tenant_role: role },
    });

    if (authError) {
      await supa.from("tenant_invites").update({
        status: "failed",
        error_message: authError.message,
      }).eq("id", invite.id);
      await audit(user.id, "tenant_user.invite_failed", tenantId, "tenant_invite", invite.id, { email, role, error: authError.message });
      return json({ error: authError.message }, 400);
    }

    if (authData.user?.id) {
      const { error: tenantUserError } = await supa.from("tenant_users").upsert({
        tenant_id: tenantId,
        user_id: authData.user.id,
        email,
        role,
        status: "active",
      }, { onConflict: "tenant_id,user_id" });

      if (tenantUserError) {
        await supa.from("tenant_invites").update({
          status: "failed",
          error_message: tenantUserError.message,
        }).eq("id", invite.id);
        await audit(user.id, "tenant_user.link_failed", tenantId, "tenant_invite", invite.id, { email, role, error: tenantUserError.message });
        return json({ error: tenantUserError.message }, 400);
      }
    }

    await supa.from("tenant_invites").update({ status: "sent" }).eq("id", invite.id);
    await audit(user.id, "tenant_user.invited", tenantId, "tenant_invite", invite.id, { email, role });
    return json({ ok: true, invite });
  }

  return json({ error: "unknown_action" }, 400);
});
