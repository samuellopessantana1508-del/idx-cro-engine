import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canOperateTenantOrPlatform, canReadTenantOrPlatform } from "../_shared/access.ts";
import {
  configureEvolutionWebhook,
  evolutionConnectionState,
  webhookUrl,
  type WhatsappIntegration,
} from "../_shared/whatsapp.ts";
import { analyzeConversation, analyzePendingConversations, confirmDetection } from "../_shared/sale-detector.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function bearer(req: Request): string {
  return req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
}

async function currentUser(req: Request) {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

// Nunca devolve api_key nem o segredo cru para o navegador.
function publicStatus(integration: Record<string, any> | null) {
  if (!integration) return { configured: false };
  return {
    configured: true,
    api_url: integration.api_url,
    instance_name: integration.instance_name,
    enabled: integration.enabled,
    connection_state: integration.connection_state,
    integration_status: integration.integration_status,
    last_event_at: integration.last_event_at,
    last_error: integration.last_error,
    ai_enabled: integration.ai_enabled,
    ai_auto_confirm: integration.ai_auto_confirm,
    ai_min_confidence: Number(integration.ai_min_confidence),
    webhook_url: webhookUrl(integration.webhook_secret),
    ai_ready: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
  };
}

async function loadIntegration(tenantId: string): Promise<Record<string, any> | null> {
  const { data } = await supa.from("tenant_whatsapp_integrations").select("*").eq("tenant_id", tenantId).maybeSingle();
  return data ?? null;
}

async function verifyAndConfigure(integration: WhatsappIntegration) {
  const webhook = await configureEvolutionWebhook(integration);
  const state = await evolutionConnectionState(integration);
  const connected = webhook.ok && state === "open";
  const lastError = !webhook.ok
    ? `Falha ao registrar webhook na Evolution API (HTTP ${webhook.status}): ${JSON.stringify(webhook.data).slice(0, 300)}`
    : state !== "open"
      ? `Instância "${integration.instance_name}" não está conectada ao WhatsApp (estado: ${state ?? "desconhecido"}). Leia o QR Code na Evolution API.`
      : null;
  await supa.from("tenant_whatsapp_integrations").update({
    connection_state: state,
    integration_status: connected ? "connected" : "needs_attention",
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", integration.tenant_id);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "method_not_allowed" }, 405);

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  // Agendamento (pg_cron): autenticado com a service role key.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (body.action === "analyze_pending" && serviceKey && bearer(req) === serviceKey) {
    const result = await analyzePendingConversations(supa, { idleMinutes: 15, limit: 30 });
    return json({ ok: true, ...result });
  }

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const tenantId = String(req.method === "GET" ? new URL(req.url).searchParams.get("tenant_id") ?? "" : body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);

  if (req.method === "GET") {
    if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);
    return json({ ok: true, integration: publicStatus(await loadIntegration(tenantId)) });
  }

  const action = String(body.action ?? "");

  if (action === "save") {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }
    const current = await loadIntegration(tenantId);
    const apiUrl = String(body.api_url ?? current?.api_url ?? "").trim();
    const instanceName = String(body.instance_name ?? current?.instance_name ?? "").trim();
    // API key em branco no formulário = manter a salva.
    const apiKey = String(body.api_key ?? "").trim() || current?.api_key || "";
    if (!/^https?:\/\//.test(apiUrl)) return json({ error: "invalid_api_url" }, 400);
    if (!instanceName) return json({ error: "missing_instance_name" }, 400);
    if (!apiKey) return json({ error: "missing_api_key" }, 400);

    const minConfidence = Number(body.ai_min_confidence ?? current?.ai_min_confidence ?? 0.85);
    const { error } = await supa.from("tenant_whatsapp_integrations").upsert({
      tenant_id: tenantId,
      api_url: apiUrl,
      instance_name: instanceName,
      api_key: apiKey,
      enabled: body.enabled ?? current?.enabled ?? true,
      ai_enabled: body.ai_enabled ?? current?.ai_enabled ?? true,
      ai_auto_confirm: body.ai_auto_confirm ?? current?.ai_auto_confirm ?? true,
      ai_min_confidence: Math.min(1, Math.max(0.5, Number.isFinite(minConfidence) ? minConfidence : 0.85)),
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id" });
    if (error) return json({ error: error.message }, 500);

    const saved = await loadIntegration(tenantId);
    if (saved) await verifyAndConfigure(saved as WhatsappIntegration);
    return json({ ok: true, integration: publicStatus(await loadIntegration(tenantId)) });
  }

  if (action === "test") {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email, ["owner", "admin"]))) {
      return json({ error: "forbidden" }, 403);
    }
    const integration = await loadIntegration(tenantId);
    if (!integration) return json({ error: "whatsapp_not_configured" }, 400);
    await verifyAndConfigure(integration as WhatsappIntegration);
    return json({ ok: true, integration: publicStatus(await loadIntegration(tenantId)) });
  }

  if (action === "analyze") {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);
    if (body.conversation_id) {
      const { data: conversation } = await supa
        .from("whatsapp_conversations")
        .select("id")
        .eq("id", String(body.conversation_id))
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!conversation) return json({ error: "conversation_not_found" }, 404);
      return json({ ok: true, outcome: await analyzeConversation(supa, conversation.id) });
    }
    // Botão "Analisar agora": não espera a conversa ficar parada.
    const result = await analyzePendingConversations(supa, { tenantId, idleMinutes: 0, limit: 15 });
    return json({ ok: true, ...result });
  }

  if (action === "review") {
    if (!(await canOperateTenantOrPlatform(supa, tenantId, user.id, user.email))) return json({ error: "forbidden" }, 403);
    const { data: detection } = await supa
      .from("sale_detections")
      .select("*")
      .eq("id", String(body.detection_id ?? ""))
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!detection) return json({ error: "detection_not_found" }, 404);
    if (detection.status !== "pending") return json({ error: "detection_already_reviewed" }, 409);

    if (body.decision === "dismiss") {
      await supa.from("sale_detections").update({
        status: "dismissed",
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", detection.id);
      return json({ ok: true, status: "dismissed" });
    }

    if (body.decision === "confirm") {
      const revenue = body.revenue != null && String(body.revenue).trim() !== ""
        ? Number(String(body.revenue).replace(",", "."))
        : null;
      const result = await confirmDetection(supa, detection, { revenue, userId: user.id, status: "confirmed" });
      if (!result.ok) return json({ error: result.error }, result.error === "already_sold" ? 409 : 400);
      return json({ ok: true, status: "confirmed" });
    }

    return json({ error: "invalid_decision" }, 400);
  }

  return json({ error: "invalid_action" }, 400);
});
