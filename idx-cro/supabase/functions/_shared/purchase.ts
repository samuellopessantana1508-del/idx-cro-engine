import { sendAndLogCapi, sessionCustomData, sessionUserData } from "./capi.ts";
import { syncSessionToMetaAudience } from "./meta-audiences.ts";

type SupabaseLike = {
  from: (table: string) => any;
};

export type PurchaseInput = {
  revenue: number;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  notes?: string | null;
  userId?: string | null;
  // "manual" = atendente confirmou; "ai" = venda detectada na conversa do WhatsApp.
  source: "manual" | "ai";
  metadata?: Record<string, unknown>;
};

export type PurchaseResult = {
  ok: boolean;
  error?: string;
  capi_ok?: boolean;
  audience_sync?: unknown;
};

// Marca a sessão como vendida, envia Purchase via CAPI, sincroniza o público de
// compradores e registra no histórico do CRM. Usado pelo convert (manual) e
// pela detecção de vendas por IA.
export async function confirmPurchase(
  supa: SupabaseLike,
  session: Record<string, any>,
  input: PurchaseInput,
): Promise<PurchaseResult> {
  if (session.sold_at) return { ok: false, error: "already_sold" };
  if (!Number.isFinite(input.revenue) || input.revenue <= 0) return { ok: false, error: "invalid_revenue" };

  const phone = String(input.phone ?? "").replace(/\D/g, "");
  const email = String(input.email ?? "").trim().toLowerCase();
  const name = String(input.name ?? "").trim();
  const soldAt = new Date().toISOString();

  // Atômico: só a primeira confirmação vira venda (evita Purchase duplicado
  // quando IA e atendente confirmam ao mesmo tempo).
  const { data: updated, error: updateError } = await supa
    .from("tracking_sessions")
    .update({
      lead_status: "sold",
      sold_at: soldAt,
      customer_phone: phone || session.customer_phone || null,
      customer_email: email || session.customer_email || null,
      customer_name: name || session.customer_name || null,
      revenue: input.revenue,
      sale_notes: input.notes ?? null,
      sale_source: input.source,
      // Quem comprou é lead real, mesmo que a entrada no WhatsApp não tenha
      // sido confirmada (ex.: venda lançada pelo telefone).
      lead_confirmed_at: session.lead_confirmed_at ?? soldAt,
      lead_source: session.lead_source ?? "manual",
    })
    .eq("id", session.id)
    .is("sold_at", null)
    .select("id")
    .maybeSingle();

  if (updateError) return { ok: false, error: updateError.message };
  if (!updated) return { ok: false, error: "already_sold" };

  const soldSession = {
    ...session,
    lead_status: "sold",
    sold_at: soldAt,
    customer_phone: phone || session.customer_phone,
    customer_email: email || session.customer_email,
    customer_name: name || session.customer_name,
    revenue: input.revenue,
  };

  const capiPayload = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `purchase_${session.id}`,
    event_source_url: session.request_url ?? session.source_url ?? "",
    action_source: "website",
    user_data: await sessionUserData(soldSession),
    custom_data: sessionCustomData(soldSession, input.revenue),
  };

  const capi = await sendAndLogCapi(supa, soldSession, capiPayload);
  if (capi.ok) {
    await supa.from("tracking_sessions").update({ capi_purchase_ok: true }).eq("id", session.id);
  }

  const audienceSync = await syncSessionToMetaAudience(supa, soldSession, "purchased");

  await supa.from("crm_activities").insert({
    tenant_id: session.tenant_id,
    tracking_session_id: session.id,
    user_id: input.userId ?? null,
    activity_type: "system",
    body: input.source === "ai" ? "ai_sale_confirmed" : "meta_audience_purchased",
    from_status: session.lead_status,
    to_status: "sold",
    metadata: { audience_sync: audienceSync, ...(input.metadata ?? {}) },
  });

  return { ok: true, capi_ok: capi.ok, audience_sync: audienceSync };
}
