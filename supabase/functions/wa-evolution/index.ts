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

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

async function canManageTenant(tenantId: string, userId: string, email?: string | null): Promise<boolean> {
  const ownerEmails = String(Deno.env.get("PLATFORM_OWNER_EMAILS") ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (email && ownerEmails.includes(email.toLowerCase())) return true;

  const { data: platUser } = await supa
    .from("platform_users")
    .select("role")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (["owner", "admin", "support"].includes(platUser?.role ?? "")) return true;

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

async function evoFetch(
  apiUrl: string,
  apiKey: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const base = apiUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const tenantId = String(body.tenant_id ?? "");
  const instanceId = String(body.instance_id ?? "");

  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canManageTenant(tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);

  if (action === "connect_instance") {
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);

    const { data: inst } = await supa
      .from("whatsapp_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!inst) return json({ error: "instance_not_found" }, 404);

    const apiUrl = String(body.api_url ?? inst.api_url ?? "").trim();
    const apiKey = String(body.api_key ?? "").trim();
    if (!apiUrl) return json({ error: "missing_api_url" }, 400);
    if (!apiKey) return json({ error: "missing_api_key" }, 400);

    const evoResult = await evoFetch(apiUrl, apiKey, `/instance/create`, "POST", {
      instanceName: inst.instance_name,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });

    if (!evoResult.ok && evoResult.status !== 403) {
      const evoData = evoResult.data as Record<string, unknown>;
      if (String(evoData?.message ?? "").includes("already")) {
        const qrResult = await evoFetch(apiUrl, apiKey, `/instance/connect/${inst.instance_name}`);
        if (qrResult.ok) {
          const qrData = qrResult.data as Record<string, unknown>;
          const base64 = String(qrData?.base64 ?? qrData?.qrcode?.base64 ?? "");
          const pairingCode = String(qrData?.pairingCode ?? qrData?.code ?? "");

          await supa.from("whatsapp_instances").update({
            api_url: apiUrl,
            status: "connecting",
            qr_code_data: base64 || null,
            metadata: { ...(inst.metadata ?? {}), pairing_code: pairingCode || undefined },
            updated_at: new Date().toISOString(),
          }).eq("id", instanceId);

          return json({ ok: true, qr_code: base64, pairing_code: pairingCode, status: "connecting" });
        }
        return json({ error: "evolution_connect_failed", details: qrResult.data }, 502);
      }
      return json({ error: "evolution_create_failed", details: evoResult.data }, 502);
    }

    const evoData = evoResult.data as Record<string, unknown>;
    const qrBase64 = String(
      evoData?.qrcode?.base64 ??
      (evoData?.qrcode as Record<string, unknown>)?.base64 ??
      evoData?.base64 ??
      ""
    );
    const pairingCode = String(evoData?.qrcode?.pairingCode ?? evoData?.pairingCode ?? "");

    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const apiKeyHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");

    await supa.from("whatsapp_instances").update({
      api_url: apiUrl,
      api_key_hash: apiKeyHash,
      status: "connecting",
      qr_code_data: qrBase64 || null,
      metadata: { ...(inst.metadata ?? {}), pairing_code: pairingCode || undefined },
      updated_at: new Date().toISOString(),
    }).eq("id", instanceId);

    return json({ ok: true, qr_code: qrBase64, pairing_code: pairingCode, status: "connecting" });
  }

  if (action === "fetch_qr") {
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);

    const { data: inst } = await supa
      .from("whatsapp_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!inst) return json({ error: "instance_not_found" }, 404);
    if (!inst.api_url) return json({ error: "no_api_url" }, 400);

    const apiKey = String(body.api_key ?? "").trim();
    if (!apiKey) return json({ error: "missing_api_key" }, 400);

    const result = await evoFetch(inst.api_url, apiKey, `/instance/connect/${inst.instance_name}`);
    if (!result.ok) return json({ error: "evolution_qr_failed", details: result.data }, 502);

    const qrData = result.data as Record<string, unknown>;
    const base64 = String(qrData?.base64 ?? qrData?.qrcode?.base64 ?? "");
    const pairingCode = String(qrData?.pairingCode ?? qrData?.code ?? "");

    if (base64) {
      await supa.from("whatsapp_instances").update({
        qr_code_data: base64,
        status: "connecting",
        updated_at: new Date().toISOString(),
      }).eq("id", instanceId);
    }

    return json({ ok: true, qr_code: base64, pairing_code: pairingCode });
  }

  if (action === "check_status") {
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);

    const { data: inst } = await supa
      .from("whatsapp_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!inst) return json({ error: "instance_not_found" }, 404);
    if (!inst.api_url) return json({ error: "no_api_url" }, 400);

    const apiKey = String(body.api_key ?? "").trim();
    if (!apiKey) return json({ error: "missing_api_key" }, 400);

    const result = await evoFetch(inst.api_url, apiKey, `/instance/connectionState/${inst.instance_name}`);
    if (!result.ok) return json({ error: "evolution_status_failed", details: result.data }, 502);

    const stateData = result.data as Record<string, unknown>;
    const state = String((stateData?.instance as Record<string, unknown>)?.state ?? stateData?.state ?? "");

    const statusMap: Record<string, string> = {
      open: "connected",
      close: "disconnected",
      connecting: "connecting",
      connected: "connected",
      disconnected: "disconnected",
    };
    const newStatus = statusMap[state.toLowerCase()] ?? inst.status;

    await supa.from("whatsapp_instances").update({
      status: newStatus,
      last_seen_at: newStatus === "connected" ? new Date().toISOString() : inst.last_seen_at,
      qr_code_data: newStatus === "connected" ? null : inst.qr_code_data,
      updated_at: new Date().toISOString(),
    }).eq("id", instanceId);

    return json({ ok: true, status: newStatus, raw_state: state });
  }

  if (action === "disconnect_instance") {
    if (!instanceId) return json({ error: "missing_instance_id" }, 400);

    const { data: inst } = await supa
      .from("whatsapp_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!inst) return json({ error: "instance_not_found" }, 404);

    if (inst.api_url) {
      const apiKey = String(body.api_key ?? "").trim();
      if (apiKey) {
        await evoFetch(inst.api_url, apiKey, `/instance/logout/${inst.instance_name}`, "DELETE").catch(() => {});
      }
    }

    await supa.from("whatsapp_instances").update({
      status: "disconnected",
      qr_code_data: null,
      updated_at: new Date().toISOString(),
    }).eq("id", instanceId);

    return json({ ok: true, status: "disconnected" });
  }

  return json({ error: "unknown_action" }, 400);
});
