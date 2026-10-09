import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseEvolutionMessage, processIncomingMessage } from "../_shared/whatsapp.ts";
import { analyzeConversation } from "../_shared/sale-detector.ts";

// Webhook público da Evolution API. A empresa é identificada pelo segredo na
// URL (gerado em tenant_whatsapp_integrations.webhook_secret).
const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Intervalo mínimo entre análises imediatas da mesma conversa.
const ANALYZE_COOLDOWN_MS = 2 * 60 * 1000;

function runBackground(promise: Promise<unknown>): void {
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(promise.catch(() => {}));
  } else {
    promise.catch(() => {});
  }
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function eventName(payload: Record<string, any>): string {
  return String(payload.event ?? "").toLowerCase().replace(/_/g, ".");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = new URL(req.url).searchParams.get("secret") ?? "";
  if (!secret || secret.length < 32) return new Response("Unauthorized", { status: 401 });

  const { data: integration } = await supa
    .from("tenant_whatsapp_integrations")
    .select("tenant_id, enabled, ai_enabled, integration_status")
    .eq("webhook_secret", secret)
    .maybeSingle();
  if (!integration) return new Response("Unauthorized", { status: 401 });
  if (!integration.enabled) return ok();

  const payload = await req.json().catch(() => null) as Record<string, any> | null;
  if (!payload) return ok();

  const event = eventName(payload);
  const statusUpdate: Record<string, unknown> = { last_event_at: new Date().toISOString() };

  if (event === "connection.update") {
    const state = String(payload.data?.state ?? "");
    statusUpdate.connection_state = state || null;
    if (state === "open") {
      statusUpdate.integration_status = "connected";
      statusUpdate.last_error = null;
    } else if (state === "close") {
      statusUpdate.integration_status = "needs_attention";
      statusUpdate.last_error = "WhatsApp desconectado na Evolution API";
    }
    await supa.from("tenant_whatsapp_integrations").update(statusUpdate).eq("tenant_id", integration.tenant_id);
    return ok();
  }

  if (event !== "messages.upsert") return ok();

  // Chegou mensagem: a instância está funcionando.
  if (integration.integration_status !== "connected") {
    statusUpdate.integration_status = "connected";
    statusUpdate.last_error = null;
  }
  await supa.from("tenant_whatsapp_integrations").update(statusUpdate).eq("tenant_id", integration.tenant_id);

  const items = Array.isArray(payload.data) ? payload.data : payload.data?.messages ?? [payload.data];
  const toAnalyze = new Set<string>();

  for (const item of items as Record<string, any>[]) {
    const msg = parseEvolutionMessage(item ?? {});
    if (!msg) continue;
    const result = await processIncomingMessage(supa, integration.tenant_id, msg);
    if (result?.saleSignal && integration.ai_enabled) toAnalyze.add(result.conversationId);
  }

  // Mensagem com cara de fechamento (pix, comprovante, fechado...): analisa já,
  // respeitando um intervalo mínimo por conversa. O resto é analisado pelo
  // agendamento quando a conversa fica parada.
  if (toAnalyze.size) {
    runBackground((async () => {
      for (const conversationId of toAnalyze) {
        const { data: conversation } = await supa
          .from("whatsapp_conversations")
          .select("last_analyzed_at")
          .eq("id", conversationId)
          .maybeSingle();
        const last = conversation?.last_analyzed_at ? new Date(conversation.last_analyzed_at).getTime() : 0;
        if (Date.now() - last < ANALYZE_COOLDOWN_MS) continue;
        await analyzeConversation(supa, conversationId);
      }
    })());
  }

  return ok();
});
