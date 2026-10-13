import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
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

function isPlatformRole(role: string | null): boolean {
  return ["owner", "admin", "support", "viewer"].includes(String(role ?? ""));
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

  if (action === "bootstrap") {
    const role = await platformRole(user.id, user.email);
    let tenants: unknown[] = [];

    if (isPlatformRole(role)) {
      const { data, error } = await supa
        .from("tenants")
        .select("*")
        .order("name", { ascending: true });
      if (error) return json({ error: error.message }, 400);
      tenants = data ?? [];
    } else {
      const { data, error } = await supa
        .from("tenant_users")
        .select("tenant:tenants(*)")
        .eq("user_id", user.id)
        .eq("status", "active");
      if (error) return json({ error: error.message }, 400);
      tenants = (data ?? []).map((row: any) => row.tenant).filter(Boolean);
    }

    const tenantIds = (tenants as Array<{ id?: string }>).map((tenant) => tenant.id).filter(Boolean);
    const { data: summaries, error: summaryError } = tenantIds.length
      ? await supa
        .from("vw_tenant_isolation_audit")
        .select("*")
        .in("tenant_id", tenantIds)
        .order("tenant_name", { ascending: true })
      : { data: [], error: null };

    if (summaryError) return json({ error: summaryError.message }, 400);

    return json({
      ok: true,
      platform_role: role,
      tenants,
      tenant_summaries: summaries ?? [],
    });
  }

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

    return json({ ok: true, tenant, platform_role: firstSetup ? "owner" : role });
  }

  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canManageTenantOrPlatform(tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);

  if (action === "update_tenant_profile") {
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
      .update({
        name,
        slug,
        whatsapp_number: whatsapp,
      })
      .eq("id", tenantId)
      .select("*")
      .single();

    if (error || !tenant) return json({ error: error?.message ?? "tenant_update_failed" }, 400);

    const { error: onboardingError } = await supa.from("tenant_onboarding").upsert({
      tenant_id: tenantId,
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

    if (onboardingError) return json({ error: onboardingError.message }, 400);
    await audit(user.id, "tenant.updated", tenantId, "tenant", tenantId, {
      slug,
      business_segment: businessSegment,
      city: city || null,
      state: state || null,
      primary_channel: primaryChannel || null,
    });

    return json({ ok: true, tenant });
  }

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

    const { data: existingTenantUser } = await supa
      .from("tenant_users")
      .select("id, role, status")
      .eq("tenant_id", tenantId)
      .eq("email", email)
      .eq("status", "active")
      .maybeSingle();

    if (existingTenantUser) {
      if (existingTenantUser.role !== role) {
        const { error: roleError } = await supa
          .from("tenant_users")
          .update({ role })
          .eq("id", existingTenantUser.id);
        if (roleError) return json({ error: roleError.message }, 400);
      }

      const { data: previousInvite } = await supa
        .from("tenant_invites")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("email", email)
        .eq("role", role)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (previousInvite) {
        await supa.from("tenant_invites").update({
          invited_by: user.id,
          status: "sent",
          error_message: null,
        }).eq("id", previousInvite.id);
      } else {
        await supa.from("tenant_invites").insert({
          tenant_id: tenantId,
          email,
          role,
          invited_by: user.id,
          status: "sent",
          error_message: null,
        });
      }

      await audit(user.id, "tenant_user.already_active", tenantId, "tenant_user", existingTenantUser.id, { email, role });
      return json({ ok: true, already_active: true });
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

  if (action === "manage_whatsapp_instance") {
    const subAction = String(body.sub_action ?? "list");

    if (subAction === "list") {
      const { data, error: listErr } = await supa
        .from("whatsapp_instances")
        .select("id, instance_name, phone_number, provider, status, mode, api_url, qr_code_data, last_seen_at, created_at, updated_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true });
      if (listErr) return json({ error: listErr.message }, 400);
      return json({ ok: true, instances: data ?? [] });
    }

    if (subAction === "create") {
      const instanceName = cleanText(body.instance_name);
      const apiUrl = cleanText(body.api_url);
      if (!instanceName) return json({ error: "missing_instance_name" }, 400);

      const { data: inst, error: createErr } = await supa
        .from("whatsapp_instances")
        .insert({
          tenant_id: tenantId,
          instance_name: instanceName,
          provider: body.provider === "cloud_api" ? "cloud_api" : "evolution",
          api_url: apiUrl || null,
          status: "disconnected",
        })
        .select("*")
        .single();

      if (createErr) return json({ error: createErr.message }, 400);
      await audit(user.id, "whatsapp_instance.created", tenantId, "whatsapp_instance", inst.id, { instance_name: instanceName });
      return json({ ok: true, instance: inst });
    }

    if (subAction === "update") {
      const instanceId = String(body.instance_id ?? "");
      if (!instanceId) return json({ error: "missing_instance_id" }, 400);

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.api_url !== undefined) updates.api_url = cleanText(body.api_url) || null;
      if (body.instance_name !== undefined) updates.instance_name = cleanText(body.instance_name);
      if (body.status !== undefined && ["disconnected", "connecting", "connected", "banned"].includes(body.status)) {
        updates.status = body.status;
      }

      const { data: updated, error: updateErr } = await supa
        .from("whatsapp_instances")
        .update(updates)
        .eq("id", instanceId)
        .eq("tenant_id", tenantId)
        .select("*")
        .single();

      if (updateErr) return json({ error: updateErr.message }, 400);
      await audit(user.id, "whatsapp_instance.updated", tenantId, "whatsapp_instance", instanceId, updates);
      return json({ ok: true, instance: updated });
    }

    if (subAction === "delete") {
      const instanceId = String(body.instance_id ?? "");
      if (!instanceId) return json({ error: "missing_instance_id" }, 400);

      const { error: delErr } = await supa
        .from("whatsapp_instances")
        .delete()
        .eq("id", instanceId)
        .eq("tenant_id", tenantId);

      if (delErr) return json({ error: delErr.message }, 400);
      await audit(user.id, "whatsapp_instance.deleted", tenantId, "whatsapp_instance", instanceId, {});
      return json({ ok: true });
    }

    return json({ error: "unknown_sub_action" }, 400);
  }

  if (action === "generate_webhook_key") {
    const label = cleanText(body.label) || "default";

    const rawKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const encoded = new TextEncoder().encode(rawKey);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const { data: keyRow, error: keyErr } = await supa
      .from("tenant_webhook_keys")
      .insert({
        tenant_id: tenantId,
        key_hash: keyHash,
        label,
        status: "active",
      })
      .select("id, tenant_id, label, status, created_at")
      .single();

    if (keyErr) return json({ error: keyErr.message }, 400);
    await audit(user.id, "webhook_key.generated", tenantId, "tenant_webhook_key", keyRow.id, { label });
    return json({ ok: true, key: { ...keyRow, plain_key: rawKey } });
  }

  if (action === "list_webhook_keys") {
    const { data, error: listErr } = await supa
      .from("tenant_webhook_keys")
      .select("id, tenant_id, label, last_used_at, status, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (listErr) return json({ error: listErr.message }, 400);
    return json({ ok: true, keys: data ?? [] });
  }

  if (action === "revoke_webhook_key") {
    const keyId = String(body.key_id ?? "");
    if (!keyId) return json({ error: "missing_key_id" }, 400);

    const { error: revokeErr } = await supa
      .from("tenant_webhook_keys")
      .update({ status: "revoked" })
      .eq("id", keyId)
      .eq("tenant_id", tenantId);

    if (revokeErr) return json({ error: revokeErr.message }, 400);
    await audit(user.id, "webhook_key.revoked", tenantId, "tenant_webhook_key", keyId, {});
    return json({ ok: true });
  }

  if (action === "set_instance_mode") {
    const instanceId = String(body.instance_id ?? "");
    const mode = String(body.mode ?? "");
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);
    if (mode !== "test" && mode !== "production") return json({ error: "invalid_mode" }, 400);

    const { data: inst, error: fetchErr } = await supa
      .from("whatsapp_instances")
      .select("id, mode, status")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (fetchErr || !inst) return json({ error: "instance_not_found" }, 404);

    if (inst.mode === mode) return json({ ok: true, mode, changed: false });

    const { error: updateErr } = await supa
      .from("whatsapp_instances")
      .update({ mode, updated_at: new Date().toISOString() })
      .eq("id", instanceId)
      .eq("tenant_id", tenantId);

    if (updateErr) return json({ error: updateErr.message }, 400);
    await audit(user.id, "whatsapp_instance.mode_changed", tenantId, "whatsapp_instance", instanceId, {
      from: inst.mode,
      to: mode,
    });
    return json({ ok: true, mode, changed: true });
  }

  if (action === "purge_test_data") {
    const instanceId = String(body.instance_id ?? "");
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);

    const { data: inst, error: fetchErr } = await supa
      .from("whatsapp_instances")
      .select("id, mode, instance_name")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (fetchErr || !inst) return json({ error: "instance_not_found" }, 404);
    if (inst.mode !== "test") return json({ error: "only_test_instances" }, 400);

    const { data: convos } = await supa
      .from("whatsapp_conversations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("instance_id", instanceId);
    const convoIds = (convos ?? []).map((c: { id: string }) => c.id);

    let deletedMessages = 0;
    let deletedInsights = 0;
    let deletedSignals = 0;

    if (convoIds.length > 0) {
      const { count: msgCount } = await supa
        .from("whatsapp_messages")
        .delete({ count: "exact" })
        .eq("tenant_id", tenantId)
        .in("conversation_id", convoIds);
      deletedMessages = msgCount ?? 0;

      const { count: insightCount } = await supa
        .from("conversation_insights")
        .delete({ count: "exact" })
        .eq("tenant_id", tenantId)
        .in("conversation_id", convoIds);
      deletedInsights = insightCount ?? 0;

      const { count: signalCount } = await supa
        .from("sale_signals")
        .delete({ count: "exact" })
        .eq("tenant_id", tenantId)
        .in("conversation_id", convoIds);
      deletedSignals = signalCount ?? 0;
    }

    const { count: convoCount } = await supa
      .from("whatsapp_conversations")
      .delete({ count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("instance_id", instanceId);

    const { count: contactCount } = await supa
      .from("whatsapp_contacts")
      .delete({ count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("instance_id", instanceId);

    await audit(user.id, "whatsapp_instance.test_data_purged", tenantId, "whatsapp_instance", instanceId, {
      conversations: convoCount ?? 0,
      contacts: contactCount ?? 0,
      messages: deletedMessages,
      insights: deletedInsights,
      signals: deletedSignals,
    });

    return json({
      ok: true,
      purged: {
        conversations: convoCount ?? 0,
        contacts: contactCount ?? 0,
        messages: deletedMessages,
        insights: deletedInsights,
        signals: deletedSignals,
      },
    });
  }

  return json({ error: "unknown_action" }, 400);
});
