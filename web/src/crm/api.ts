import { supabase } from "../lib/supabaseClient";
import type {
  AutomationRule, AutomationRun, Campaign, CampaignResult, Company, Contact, CrmAccess, CrmNotification, CrmSettings, CustomField,
  Deal, DealItem, KpiResponse, LossReason, Member, Offer, Onboarding, Order, Pipeline, Quote, RfvCustomer, RfvDashboard, Sample, Stage, Task,
  TimelineItem, DialLead, DialOutcome, DialOverview, Cadence, CadenceEnrollment, CadenceStep, Goal, GoalProgress, AssistantPlan, AssistantResult,
  WaGatewayInstance, WaCampaign, WaRecipient, WaRecipientStatus, WaAddResult, WaOutboxItem,
} from "./types";

export function db() {
  if (!supabase) throw new Error("Supabase não configurado.");
  return supabase;
}

function check<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

// ---------- acesso / estrutura ----------
export async function setupTenant(tenantId: string) {
  return check(await db().rpc("crm_setup_tenant", { p_tenant_id: tenantId }));
}

export async function myAccess(tenantId: string): Promise<CrmAccess> {
  return check(await db().rpc("crm_my_access", { p_tenant_id: tenantId })) as CrmAccess;
}

export async function loadMembers(tenantId: string): Promise<Member[]> {
  return check(await db().from("tenant_users").select("user_id, email, role, crm_role, status").eq("tenant_id", tenantId).eq("status", "active").not("user_id", "is", null)) as Member[];
}

export async function updateMemberCrmRole(tenantId: string, userId: string, crmRole: string | null) {
  return check(await db().from("tenant_users").update({ crm_role: crmRole }).eq("tenant_id", tenantId).eq("user_id", userId).select().single());
}

export async function loadPipelines(tenantId: string) {
  const [p, s, r, st] = await Promise.all([
    db().from("crm_pipelines").select("*").eq("tenant_id", tenantId).is("archived_at", null).order("position"),
    db().from("crm_stages").select("*").eq("tenant_id", tenantId).is("archived_at", null).order("position"),
    db().from("crm_loss_reasons").select("*").eq("tenant_id", tenantId).is("archived_at", null).order("position"),
    db().from("crm_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  return {
    pipelines: check(p) as Pipeline[],
    stages: check(s) as Stage[],
    lossReasons: check(r) as LossReason[],
    settings: check(st) as CrmSettings | null,
  };
}

// ---------- negociações ----------
export type DealFilter = { pipelineId: string; ownerId?: string | null; search?: string; source?: string; includeClosedDays?: number };

export async function loadDeals(tenantId: string, f: DealFilter): Promise<Deal[]> {
  let q = db().from("vw_crm_deals").select("*").eq("tenant_id", tenantId).eq("pipeline_id", f.pipelineId).is("archived_at", null);
  const since = new Date(Date.now() - (f.includeClosedDays ?? 60) * 86400000).toISOString();
  q = q.or(`status.eq.open,updated_at.gte.${since}`);
  if (f.ownerId === "none") q = q.is("owner_id", null);
  else if (f.ownerId) q = q.eq("owner_id", f.ownerId);
  if (f.source) q = q.eq("source_channel", f.source);
  if (f.search) {
    const s = f.search.replace(/[%,()]/g, " ").trim();
    q = q.or(`title.ilike.%${s}%,contact_name.ilike.%${s}%,contact_phone.ilike.%${s.replace(/\D/g, "") || s}%,company_name.ilike.%${s}%`);
  }
  return check(await q.order("position").order("created_at", { ascending: false }).limit(1500)) as Deal[];
}

export async function getDeal(id: string): Promise<Deal | null> {
  return check(await db().from("vw_crm_deals").select("*").eq("id", id).maybeSingle()) as Deal | null;
}

export async function createDeal(input: Partial<Deal> & { tenant_id: string; pipeline_id: string; stage_id: string; title: string }) {
  return check(await db().from("crm_deals").insert(input).select().single()) as Deal;
}

export async function updateDeal(id: string, patch: Partial<Deal>) {
  return check(await db().from("crm_deals").update(patch).eq("id", id).select().single()) as Deal;
}

export async function deleteDeal(id: string) {
  check(await db().from("crm_deals").delete().eq("id", id));
}

export async function loadStageHistory(tenantId: string, sinceIso: string) {
  return check(await db().from("crm_deal_stage_history").select("deal_id, from_stage_id, to_stage_id, changed_at, seconds_in_previous").eq("tenant_id", tenantId).gte("changed_at", sinceIso).limit(10000)) as {
    deal_id: string; from_stage_id: string | null; to_stage_id: string; changed_at: string; seconds_in_previous: number | null;
  }[];
}

// Edge Function legada (mantém CAPI por etapa e Purchase com deduplicação)
export async function callLegacyCrm(body: Record<string, unknown>) {
  const { data } = await db().auth.getSession();
  const token = data.session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/crm`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Falha ${res.status} ao sincronizar com o IDX`);
  return json as { ok?: boolean; capi_ok?: boolean | null };
}

// ---------- contatos / empresas ----------
export type ContactFilter = { search?: string; lifecycle?: string; ownerId?: string | null; source?: string; segment?: string; tag?: string; page?: number; pageSize?: number; sort?: string; asc?: boolean };

export async function loadContacts(tenantId: string, f: ContactFilter) {
  const size = f.pageSize ?? 50;
  const page = f.page ?? 0;
  let q = db().from("vw_crm_contacts").select("*", { count: "exact" }).eq("tenant_id", tenantId).is("archived_at", null);
  if (f.search) {
    const s = f.search.replace(/[%,()]/g, " ").trim();
    const digits = s.replace(/\D/g, "");
    q = q.or([`name.ilike.%${s}%`, `email.ilike.%${s}%`, `company_name.ilike.%${s}%`, digits.length >= 4 ? `phone.ilike.%${digits}%` : ""].filter(Boolean).join(","));
  }
  if (f.lifecycle) q = q.eq("lifecycle_stage", f.lifecycle);
  if (f.ownerId === "none") q = q.is("owner_id", null);
  else if (f.ownerId) q = q.eq("owner_id", f.ownerId);
  if (f.source) q = q.eq("source_channel", f.source);
  if (f.segment) q = f.segment === "no_purchase" ? q.is("rfv_segment", null) : q.eq("rfv_segment", f.segment);
  if (f.tag) q = q.contains("tags", [f.tag]);
  q = q.order(f.sort ?? "created_at", { ascending: f.asc ?? false, nullsFirst: false });
  const res = await q.range(page * size, page * size + size - 1);
  if (res.error) throw res.error;
  return { rows: (res.data ?? []) as Contact[], total: res.count ?? 0 };
}

export async function getContact(id: string): Promise<Contact | null> {
  return check(await db().from("vw_crm_contacts").select("*").eq("id", id).maybeSingle()) as Contact | null;
}

export async function createContact(input: Partial<Contact> & { tenant_id: string }) {
  return check(await db().from("crm_contacts").insert(input).select().single()) as Contact;
}

export async function updateContact(id: string, patch: Partial<Contact>) {
  return check(await db().from("crm_contacts").update(patch).eq("id", id).select().single()) as Contact;
}

export async function findDuplicates(tenantId: string, phone?: string, email?: string, exclude?: string) {
  return check(await db().rpc("crm_find_duplicates", { p_tenant_id: tenantId, p_phone: phone || null, p_email: email || null, p_exclude: exclude ?? null })) as {
    id: string; name: string | null; phone: string | null; email: string | null; match_reason: string;
  }[];
}

export async function mergeContacts(keep: string, merge: string) {
  check(await db().rpc("crm_merge_contacts", { p_keep: keep, p_merge: merge }));
}

export async function loadCompanies(tenantId: string, search?: string) {
  let q = db().from("crm_companies").select("*").eq("tenant_id", tenantId).is("archived_at", null);
  if (search) q = q.ilike("name", `%${search.replace(/[%,()]/g, " ")}%`);
  return check(await q.order("name").limit(500)) as Company[];
}

export async function saveCompany(input: Partial<Company> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_companies").update(patch).eq("id", id).select().single()) as Company;
  }
  return check(await db().from("crm_companies").insert(input).select().single()) as Company;
}

// ---------- tarefas / timeline ----------
export type TaskFilter = { ownerId?: string | null; status?: "open" | "done" | "all"; from?: string; to?: string; contactId?: string; dealId?: string; type?: string; limit?: number };

export async function loadTasks(tenantId: string, f: TaskFilter): Promise<Task[]> {
  let q = db().from("crm_tasks").select("*, contact:crm_contacts(name, phone), deal:crm_deals(title)").eq("tenant_id", tenantId);
  if (f.ownerId) q = q.eq("owner_id", f.ownerId);
  if (f.status && f.status !== "all") q = q.eq("status", f.status);
  if (f.from) q = q.gte("due_at", f.from);
  if (f.to) q = q.lt("due_at", f.to);
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (f.dealId) q = q.eq("deal_id", f.dealId);
  if (f.type) q = q.eq("task_type", f.type);
  return check(await q.order("due_at", { ascending: true, nullsFirst: false }).limit(f.limit ?? 500)) as Task[];
}

export async function saveTask(input: Partial<Task> & { tenant_id: string }) {
  const { contact: _c, deal: _d, ...clean } = input as Task;
  void _c; void _d;
  if (clean.id) {
    const { id, ...patch } = clean;
    return check(await db().from("crm_tasks").update(patch).eq("id", id).select().single()) as Task;
  }
  return check(await db().from("crm_tasks").insert(clean).select().single()) as Task;
}

export async function deleteTask(id: string) {
  check(await db().from("crm_tasks").delete().eq("id", id));
}

export async function loadTimeline(f: { contactId?: string; dealId?: string; limit?: number }): Promise<TimelineItem[]> {
  let q = db().from("vw_crm_timeline").select("*");
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (f.dealId) q = q.eq("deal_id", f.dealId);
  return check(await q.order("occurred_at", { ascending: false }).limit(f.limit ?? 200)) as TimelineItem[];
}

export async function addNote(input: { tenant_id: string; contact_id?: string | null; deal_id?: string | null; kind: "note" | "call_log" | "meeting_log" | "email_log"; title: string; body: string; actor_id: string }) {
  return check(await db().from("crm_timeline").insert(input).select().single());
}

// ---------- catálogo / itens / propostas ----------
export async function loadOffers(tenantId: string, includeArchived = false): Promise<Offer[]> {
  let q = db().from("offers").select("*").eq("tenant_id", tenantId);
  if (!includeArchived) q = q.neq("status", "archived");
  return check(await q.order("name")) as Offer[];
}

export async function saveOffer(input: Partial<Offer> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("offers").update(patch).eq("id", id).select().single()) as Offer;
  }
  return check(await db().from("offers").insert(input).select().single()) as Offer;
}

export async function loadDealItems(dealId: string): Promise<DealItem[]> {
  return check(await db().from("crm_deal_items").select("*").eq("deal_id", dealId).order("created_at")) as DealItem[];
}

export async function addDealItem(input: { tenant_id: string; deal_id: string; offer_id: string | null; name: string; quantity: number; unit_price: number; discount: number }) {
  return check(await db().from("crm_deal_items").insert(input).select().single()) as DealItem;
}

export async function removeDealItem(id: string) {
  check(await db().from("crm_deal_items").delete().eq("id", id));
}

export async function loadQuotes(dealId: string): Promise<Quote[]> {
  return check(await db().from("crm_quotes").select("*").eq("deal_id", dealId).order("number", { ascending: false })) as Quote[];
}

export async function createQuote(tenantId: string, dealId: string, items: DealItem[], validUntil: string | null, terms: string) {
  const { data: last } = await db().from("crm_quotes").select("number").eq("tenant_id", tenantId).order("number", { ascending: false }).limit(1);
  const number = ((last?.[0]?.number as number | undefined) ?? 0) + 1;
  const subtotal = items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
  const discount = items.reduce((s, i) => s + Number(i.discount), 0);
  return check(await db().from("crm_quotes").insert({
    tenant_id: tenantId, deal_id: dealId, number, valid_until: validUntil, terms: terms || null,
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount, total: i.total })),
    subtotal, discount, total: Math.max(subtotal - discount, 0),
  }).select().single()) as Quote;
}

export async function updateQuote(id: string, patch: Partial<Quote> & { sent_at?: string; decided_at?: string }) {
  return check(await db().from("crm_quotes").update(patch).eq("id", id).select().single()) as Quote;
}

// ---------- vendas ----------
export async function loadOrders(f: { tenantId: string; contactId?: string; dealId?: string; limit?: number }): Promise<Order[]> {
  let q = db().from("crm_orders").select("*").eq("tenant_id", f.tenantId);
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (f.dealId) q = q.eq("deal_id", f.dealId);
  return check(await q.order("order_date", { ascending: false }).limit(f.limit ?? 200)) as Order[];
}

export async function createOrder(input: Partial<Order> & { tenant_id: string; items?: { offer_id: string | null; name: string; quantity: number; unit_price: number; discount: number }[] }) {
  const { items, ...order } = input;
  const created = check(await db().from("crm_orders").insert(order).select().single()) as Order;
  if (items?.length) {
    check(await db().from("crm_order_items").insert(items.map((i) => ({ ...i, tenant_id: input.tenant_id, order_id: created.id }))));
  }
  return created;
}

export async function updateOrder(id: string, patch: Partial<Order> & { cancel_reason?: string }) {
  return check(await db().from("crm_orders").update(patch).eq("id", id).select().single()) as Order;
}

export async function addPayment(input: { tenant_id: string; order_id: string; kind: "payment" | "refund" | "chargeback"; amount: number; method?: string | null; notes?: string | null }) {
  return check(await db().from("crm_payments").insert(input).select().single());
}

export async function loadSamples(tenantId: string, contactId?: string): Promise<Sample[]> {
  let q = db().from("vw_crm_sample_conversion").select("*").eq("tenant_id", tenantId);
  if (contactId) q = q.eq("contact_id", contactId);
  return check(await q.order("delivered_at", { ascending: false }).limit(500)) as Sample[];
}

export async function addSample(input: { tenant_id: string; contact_id: string; offer_id: string | null; product_name: string; delivered_at: string; campaign: string | null; channel: string | null; feedback: string | null; rating: number | null }) {
  return check(await db().from("crm_samples").insert(input).select().single());
}

// ---------- IA / WhatsApp ----------
export async function loadContactAi(contactId: string) {
  const [ai, sig] = await Promise.all([
    db().from("vw_crm_contact_ai").select("*").eq("contact_id", contactId).order("updated_at", { ascending: false }),
    db().from("vw_crm_contact_signals").select("*").eq("contact_id", contactId).order("created_at", { ascending: false }),
  ]);
  return { insights: (check(ai) ?? []) as Record<string, unknown>[], signals: (check(sig) ?? []) as Record<string, unknown>[] };
}

export async function loadConversationMessages(conversationId: string, limit = 40) {
  const rows = check(await db().from("whatsapp_messages").select("id, direction, body, content_type, timestamp").eq("conversation_id", conversationId).order("timestamp", { ascending: false }).limit(limit)) as {
    id: string; direction: "inbound" | "outbound"; body: string | null; content_type: string; timestamp: string;
  }[];
  return rows.reverse();
}

export async function loadAwaitingReply(tenantId: string) {
  return check(await db().from("vw_crm_contacts").select("id, name, phone, owner_id, unread_count, last_message_at, conversation_id").eq("tenant_id", tenantId).gt("unread_count", 0).order("last_message_at", { ascending: false }).limit(30)) as Contact[];
}

export async function createDealFromConversation(conversationId: string) {
  return check(await db().rpc("crm_create_deal_from_conversation", { p_conversation_id: conversationId })) as string;
}

// ---------- RFV / KPIs ----------
export async function computeRfv(tenantId: string) {
  return check(await db().rpc("crm_compute_rfv", { p_tenant_id: tenantId }));
}

export async function rfvDashboard(tenantId: string): Promise<RfvDashboard> {
  return check(await db().rpc("crm_rfv_dashboard", { p_tenant_id: tenantId })) as RfvDashboard;
}

export async function loadRfvCustomers(tenantId: string, segment?: string, ownerId?: string | null): Promise<RfvCustomer[]> {
  let q = db().from("vw_crm_rfv_customers").select("*").eq("tenant_id", tenantId).neq("segment", "no_purchase");
  if (segment) q = q.eq("segment", segment);
  if (ownerId) q = q.eq("owner_id", ownerId);
  return check(await q.order("priority_rank").order("net_revenue", { ascending: false }).limit(500)) as RfvCustomer[];
}

export async function getContactRfv(contactId: string) {
  return check(await db().from("crm_rfv_scores").select("*").eq("contact_id", contactId).maybeSingle());
}

export async function contactRfvHistory(contactId: string) {
  return check(await db().from("crm_rfv_history").select("*").eq("contact_id", contactId).order("computed_at", { ascending: false }).limit(20));
}

export async function saveRfvSettings(tenantId: string, patch: Record<string, unknown>) {
  return check(await db().from("crm_rfv_settings").update(patch).eq("tenant_id", tenantId).select().single());
}

export async function applyRfvPreset(tenantId: string, preset: string) {
  check(await db().rpc("crm_rfv_apply_preset", { p_tenant_id: tenantId, p_preset: preset }));
}

export async function kpis(tenantId: string, from: Date, to: Date, ownerId?: string | null): Promise<KpiResponse> {
  return check(await db().rpc("crm_kpis", { p_tenant_id: tenantId, p_from: from.toISOString(), p_to: to.toISOString(), p_owner: ownerId ?? null })) as KpiResponse;
}

export async function runScheduled(tenantId: string) {
  try {
    return await db().rpc("crm_run_scheduled", { p_tenant_id: tenantId, p_force: false });
  } catch {
    return null;
  }
}

// ---------- automações / notificações ----------
export async function loadAutomations(tenantId: string) {
  const [rules, runs] = await Promise.all([
    db().from("crm_automation_rules").select("*").eq("tenant_id", tenantId).order("created_at"),
    db().from("crm_automation_runs").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100),
  ]);
  return { rules: check(rules) as AutomationRule[], runs: (runs.error ? [] : runs.data) as AutomationRun[] };
}

export async function saveAutomation(input: Partial<AutomationRule> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_automation_rules").update(patch).eq("id", id).select().single()) as AutomationRule;
  }
  return check(await db().from("crm_automation_rules").insert(input).select().single()) as AutomationRule;
}

export async function loadNotifications(tenantId: string, userId: string) {
  return check(await db().from("crm_notifications").select("*").eq("tenant_id", tenantId).eq("user_id", userId).order("created_at", { ascending: false }).limit(50)) as CrmNotification[];
}

export async function markNotificationsRead(ids: string[]) {
  if (!ids.length) return;
  check(await db().from("crm_notifications").update({ read_at: new Date().toISOString() }).in("id", ids));
}

// ---------- configurações ----------
export async function saveSettings(tenantId: string, patch: Partial<CrmSettings>) {
  return check(await db().from("crm_settings").update(patch).eq("tenant_id", tenantId).select().single()) as CrmSettings;
}

export async function savePipeline(input: Partial<Pipeline> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_pipelines").update(patch).eq("id", id).select().single()) as Pipeline;
  }
  return check(await db().from("crm_pipelines").insert(input).select().single()) as Pipeline;
}

export async function saveStage(input: Partial<Stage> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_stages").update(patch).eq("id", id).select().single()) as Stage;
  }
  return check(await db().from("crm_stages").insert(input).select().single()) as Stage;
}

export async function reorderStages(pipelineId: string, ids: string[]) {
  check(await db().rpc("crm_reorder_stages", { p_pipeline_id: pipelineId, p_stage_ids: ids }));
}

export async function saveLossReason(input: { tenant_id: string; id?: string; name: string; archived_at?: string | null; position?: number }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_loss_reasons").update(patch).eq("id", id).select().single());
  }
  return check(await db().from("crm_loss_reasons").insert(input).select().single());
}

export async function loadCustomFields(tenantId: string): Promise<CustomField[]> {
  return check(await db().from("crm_custom_fields").select("*").eq("tenant_id", tenantId).order("position")) as CustomField[];
}

export async function saveCustomField(input: Partial<CustomField> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_custom_fields").update(patch).eq("id", id).select().single());
  }
  return check(await db().from("crm_custom_fields").insert(input).select().single());
}

export async function deleteCustomField(id: string) {
  check(await db().from("crm_custom_fields").delete().eq("id", id));
}

export async function recomputeScores(tenantId: string) {
  return check(await db().rpc("crm_recompute_scores", { p_tenant_id: tenantId }));
}

// ---------- importação ----------
export async function importRows(tenantId: string, entity: "contacts" | "deals", rows: Record<string, string>[], options: Record<string, unknown>, fileName: string) {
  return check(await db().rpc("crm_import", { p_tenant_id: tenantId, p_entity: entity, p_rows: rows, p_options: options, p_file_name: fileName })) as {
    import_id: string; total: number; created: number; updated: number; skipped: number; errors: number; report: { row: number; status: string; message: string }[];
  };
}

export async function loadImports(tenantId: string) {
  return check(await db().from("crm_imports").select("id, entity, file_name, total_rows, created_rows, updated_rows, skipped_rows, error_rows, created_at").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(20));
}

// ---------- CS / campanhas ----------
export async function loadOnboardings(tenantId: string, contactId?: string): Promise<Onboarding[]> {
  let q = db().from("crm_onboardings").select("*").eq("tenant_id", tenantId);
  if (contactId) q = q.eq("contact_id", contactId);
  return check(await q.order("started_at", { ascending: false }).limit(200)) as Onboarding[];
}

export async function saveOnboarding(input: Partial<Onboarding> & { tenant_id: string }) {
  if (input.id) {
    const { id, ...patch } = input;
    return check(await db().from("crm_onboardings").update(patch).eq("id", id).select().single()) as Onboarding;
  }
  return check(await db().from("crm_onboardings").insert(input).select().single()) as Onboarding;
}

export async function loadCampaigns(tenantId: string) {
  const [c, r] = await Promise.all([
    db().from("crm_campaigns").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
    db().from("vw_crm_campaign_results").select("*").eq("tenant_id", tenantId),
  ]);
  return { campaigns: check(c) as Campaign[], results: check(r) as CampaignResult[] };
}

export async function createCampaignWithMembers(tenantId: string, name: string, kind: string, members: { contact_id: string; segment: string }[]) {
  const c = check(await db().from("crm_campaigns").insert({ tenant_id: tenantId, name, kind, status: "active", starts_at: new Date().toISOString().slice(0, 10) }).select().single()) as Campaign;
  if (members.length) {
    check(await db().from("crm_campaign_members").insert(members.map((m) => ({ tenant_id: tenantId, campaign_id: c.id, contact_id: m.contact_id, segment_at_entry: m.segment }))));
  }
  return c;
}

// ---------- busca global ----------
export async function globalSearch(tenantId: string, term: string) {
  const s = term.replace(/[%,()]/g, " ").trim();
  if (s.length < 2) return { contacts: [], deals: [], companies: [] };
  const digits = s.replace(/\D/g, "");
  const [c, d, co] = await Promise.all([
    db().from("crm_contacts").select("id, name, phone, email").eq("tenant_id", tenantId).is("merged_into_id", null)
      .or([`name.ilike.%${s}%`, `email.ilike.%${s}%`, digits.length >= 4 ? `phone.ilike.%${digits}%` : ""].filter(Boolean).join(",")).limit(8),
    db().from("vw_crm_deals").select("id, title, value, stage_name, status, contact_name").eq("tenant_id", tenantId).or(`title.ilike.%${s}%,contact_name.ilike.%${s}%`).limit(8),
    db().from("crm_companies").select("id, name, city").eq("tenant_id", tenantId).ilike("name", `%${s}%`).limit(5),
  ]);
  return {
    contacts: (c.data ?? []) as { id: string; name: string | null; phone: string | null; email: string | null }[],
    deals: (d.data ?? []) as { id: string; title: string; value: number; stage_name: string; status: string; contact_name: string | null }[],
    companies: (co.data ?? []) as { id: string; name: string; city: string | null }[],
  };
}

// ---------- consultas usadas pelas telas de visão geral ----------
export async function loadOpenDeals(tenantId: string, ownerId?: string | null, limit = 500): Promise<Deal[]> {
  let q = db().from("vw_crm_deals").select("*").eq("tenant_id", tenantId).eq("status", "open").is("archived_at", null);
  if (ownerId) q = q.eq("owner_id", ownerId);
  return check(await q.order("expected_close_date", { ascending: true, nullsFirst: false }).limit(limit)) as Deal[];
}

export async function loadContactDeals(contactId: string): Promise<Deal[]> {
  return check(await db().from("vw_crm_deals").select("*").eq("contact_id", contactId).is("archived_at", null).order("created_at", { ascending: false })) as Deal[];
}

export async function loadCompanyRecords(companyId: string) {
  const [c, d] = await Promise.all([
    db().from("vw_crm_contacts").select("id, name, phone, email, job_title, lifecycle_stage").eq("company_id", companyId).is("archived_at", null).limit(100),
    db().from("vw_crm_deals").select("id, title, value, status, stage_name").eq("company_id", companyId).is("archived_at", null).limit(100),
  ]);
  return { contacts: check(c) as Contact[], deals: check(d) as Deal[] };
}

export async function searchContacts(tenantId: string, term: string) {
  const s = term.replace(/[%,()]/g, " ").trim();
  if (s.length < 2) return [] as { id: string; name: string | null; phone: string | null; email: string | null; company_id: string | null }[];
  const digits = s.replace(/\D/g, "");
  return check(await db().from("crm_contacts").select("id, name, phone, email, company_id").eq("tenant_id", tenantId).is("merged_into_id", null).is("archived_at", null)
    .or([`name.ilike.%${s}%`, `email.ilike.%${s}%`, digits.length >= 4 ? `phone.ilike.%${digits}%` : ""].filter(Boolean).join(",")).limit(8)) as {
      id: string; name: string | null; phone: string | null; email: string | null; company_id: string | null;
    }[];
}

export async function deleteOffer(id: string) {
  // ofertas podem estar ligadas a Smart Links e vendas: arquivamos em vez de apagar
  return check(await db().from("offers").update({ status: "archived" }).eq("id", id).select().single()) as Offer;
}

// ---------- discador ----------
export async function dialOverview(tenantId: string, list?: string | null) {
  return check(await db().rpc("crm_dial_overview", { p_tenant_id: tenantId, p_list: list ?? null })) as DialOverview;
}

export async function loadDialLeads(tenantId: string, f: { list?: string | null; status: "pending" | "called"; uf?: string; search?: string; page: number; pageSize: number }) {
  return check(await db().rpc("crm_dial_list", {
    p_tenant_id: tenantId, p_list: f.list ?? null, p_status: f.status, p_uf: f.uf || null, p_search: f.search?.trim() || null,
    p_limit: f.pageSize, p_offset: f.page * f.pageSize,
  })) as DialLead[];
}

export async function dialMarkCalled(id: string) {
  return check(await db().rpc("crm_dial_mark_called", { p_id: id })) as DialLead;
}
export async function dialReset(id: string) {
  return check(await db().rpc("crm_dial_reset", { p_id: id })) as DialLead;
}
export async function dialSetOutcome(id: string, outcome: DialOutcome | null, notes?: string, dueAt?: string | null, objection?: string | null) {
  return check(await db().rpc("crm_dial_set_outcome", { p_id: id, p_outcome: outcome, p_notes: notes ?? null, p_due_at: dueAt ?? null, p_objection: objection ?? null })) as DialLead;
}
export async function dialImport(tenantId: string, list: string, rows: Record<string, string>[], source = "import") {
  return check(await db().rpc("crm_dial_import", { p_tenant_id: tenantId, p_list: list, p_rows: rows, p_source: source })) as {
    total: number; inserted: number; duplicates: number; invalid: number;
  };
}
export async function dialExport(tenantId: string, f: { list?: string | null; uf?: string; status?: "pending" | "called" }) {
  const all: DialLead[] = [];
  for (let page = 0; page < 200; page++) {
    let q = db().from("crm_dial_leads").select("*").eq("tenant_id", tenantId);
    if (f.list) q = q.eq("list_name", f.list);
    if (f.uf) q = q.eq("uf", f.uf);
    if (f.status) q = q.eq("status", f.status);
    const rows = check(await q.order("uf").order("city").order("name").range(page * 1000, page * 1000 + 999)) as DialLead[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

// ---------- cadências ----------
export async function loadCadences(tenantId: string) {
  return check(await db().rpc("crm_cadence_overview", { p_tenant_id: tenantId })) as Cadence[];
}
export async function saveCadence(tenantId: string, c: { id?: string; name: string; description?: string | null; active?: boolean; stop_on_reply?: boolean; stop_on_deal_close?: boolean }, steps: CadenceStep[], removedStepIds: string[]) {
  const { id, ...fields } = c;
  const row = id
    ? check(await db().from("crm_cadences").update(fields).eq("id", id).select().single()) as { id: string }
    : check(await db().from("crm_cadences").insert({ ...fields, tenant_id: tenantId }).select().single()) as { id: string };
  if (removedStepIds.length) check(await db().from("crm_cadence_steps").delete().in("id", removedStepIds));
  for (const [i, s] of steps.entries()) {
    const payload = { position: i, wait_days: s.wait_days, channel: s.channel, title: s.title || null, template: s.template || null };
    if (s.id) check(await db().from("crm_cadence_steps").update(payload).eq("id", s.id));
    else check(await db().from("crm_cadence_steps").insert({ ...payload, tenant_id: tenantId, cadence_id: row.id }));
  }
  return row.id;
}
export async function setCadenceActive(id: string, active: boolean) {
  check(await db().from("crm_cadences").update({ active }).eq("id", id));
}
export async function archiveCadence(id: string) {
  check(await db().from("crm_cadences").update({ archived_at: new Date().toISOString(), active: false }).eq("id", id));
}
export async function enrollInCadence(cadenceId: string, contactIds: string[], dealId?: string | null) {
  return check(await db().rpc("crm_cadence_enroll", { p_cadence_id: cadenceId, p_contact_ids: contactIds, p_deal_id: dealId ?? null })) as { enrolled: number; skipped: number };
}
export async function stopEnrollment(id: string) {
  check(await db().rpc("crm_cadence_stop", { p_enrollment_id: id, p_reason: "manual" }));
}
export async function loadEnrollments(tenantId: string, f: { cadenceId?: string | null; contactId?: string | null }) {
  return check(await db().rpc("crm_cadence_enrollments_list", { p_tenant_id: tenantId, p_cadence_id: f.cadenceId ?? null, p_contact_id: f.contactId ?? null })) as CadenceEnrollment[];
}

// ---------- metas ----------
export async function loadGoalsProgress(tenantId: string) {
  return check(await db().rpc("crm_goals_progress", { p_tenant_id: tenantId })) as GoalProgress[];
}
export async function saveGoal(input: Partial<Goal> & { tenant_id: string }) {
  const { id, ...patch } = input;
  if (id) return check(await db().from("crm_goals").update(patch).eq("id", id).select().single()) as Goal;
  return check(await db().from("crm_goals").insert(patch).select().single()) as Goal;
}
export async function archiveGoal(id: string) {
  check(await db().from("crm_goals").update({ archived_at: new Date().toISOString(), active: false }).eq("id", id));
}

// ---------- assistente (voz/texto → CRM) ----------
export async function askAssistant(tenantId: string, text: string, source: "voice" | "text", context: { dial_lead_id?: string; contact_id?: string } = {}) {
  const { data } = await db().auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/crm-assistant`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: tenantId, text, source, context }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Falha ${res.status} ao interpretar`);
  return json as AssistantResult;
}
export async function applyAssistant(tenantId: string, plan: AssistantPlan) {
  return check(await db().rpc("crm_assistant_apply", { p_tenant_id: tenantId, p_plan: plan })) as { contact_id: string | null; deal_id: string | null; task_id: string | null };
}

// ---------- Disparos / WhatsApp (motor único) ----------
export async function waInstance(tenantId: string) {
  const r = check(await db().rpc("wa_gateway_instance", { p_tenant_id: tenantId })) as WaGatewayInstance | null;
  return r && r.id ? r : null;
}
export async function waConnect(tenantId: string, action: "connect" | "disconnect" | "logout") {
  return check(await db().rpc("wa_gateway_connect", { p_tenant_id: tenantId, p_action: action })) as WaGatewayInstance;
}
export async function waSend(tenantId: string, body: string, target: { phone?: string | null; conversationId?: string | null }) {
  return check(await db().rpc("wa_send_message", {
    p_tenant_id: tenantId, p_body: body, p_phone: target.phone ?? null, p_conversation_id: target.conversationId ?? null,
  })) as string;
}
export async function waCancelOutbox(id: string) {
  check(await db().rpc("wa_cancel_outbox", { p_id: id }));
}
export async function waOutbox(tenantId: string, limit = 30) {
  return check(await db().from("wa_outbox").select("id, phone, body, source, status, error, created_at, sent_at, conversation_id")
    .eq("tenant_id", tenantId).eq("source", "manual").order("created_at", { ascending: false }).limit(limit)) as WaOutboxItem[];
}
export async function waCampaigns(tenantId: string) {
  const rows = check(await db().rpc("wa_campaign_list", { p_tenant_id: tenantId })) as WaCampaign[];
  return rows.map((r) => ({
    ...r, total: Number(r.total), pending: Number(r.pending), sent: Number(r.sent), failed: Number(r.failed), invalid: Number(r.invalid),
    opted_out: Number(r.opted_out), skipped: Number(r.skipped), replied: Number(r.replied), sent_today: Number(r.sent_today),
  }));
}
export async function waSaveCampaign(tenantId: string, id: string | null, c: {
  name: string; messages: string[]; min_delay_sec: number; max_delay_sec: number; daily_limit: number; start_hour: number; end_hour: number; opt_out_footer: boolean;
}) {
  return check(await db().rpc("wa_campaign_save", {
    p_tenant_id: tenantId, p_id: id, p_name: c.name, p_messages: c.messages, p_min_delay: c.min_delay_sec, p_max_delay: c.max_delay_sec,
    p_daily_limit: c.daily_limit, p_start_hour: c.start_hour, p_end_hour: c.end_hour, p_opt_out_footer: c.opt_out_footer,
  })) as string;
}
export async function waAddRecipients(campaignId: string, src:
  | { source: "dial_list"; listName: string; filters?: { uf?: string; city?: string; only_pending?: boolean; skip_not_interested?: boolean } }
  | { source: "contacts"; contactIds: string[] }
  | { source: "rows"; rows: Record<string, string>[] }) {
  return check(await db().rpc("wa_campaign_add_recipients", {
    p_campaign_id: campaignId, p_source: src.source,
    p_list_name: src.source === "dial_list" ? src.listName : null,
    p_contact_ids: src.source === "contacts" ? src.contactIds : null,
    p_rows: src.source === "rows" ? src.rows : null,
    p_filters: src.source === "dial_list" ? (src.filters ?? {}) : {},
  })) as WaAddResult;
}
export async function waClearRecipients(campaignId: string) {
  check(await db().rpc("wa_campaign_clear_recipients", { p_campaign_id: campaignId }));
}
export async function waCampaignAction(campaignId: string, action: "start" | "pause" | "resume" | "cancel" | "archive") {
  check(await db().rpc("wa_campaign_action", { p_campaign_id: campaignId, p_action: action }));
}
export async function waRecipients(campaignId: string, f: { status?: WaRecipientStatus | "replied" | "all"; search?: string; page: number; pageSize: number }) {
  let q = db().from("wa_campaign_recipients").select("id, campaign_id, phone, name, vars, status, error, sent_at, replied_at, crm_contact_id, dial_lead_id", { count: "exact" })
    .eq("campaign_id", campaignId);
  if (f.status === "replied") q = q.not("replied_at", "is", null);
  else if (f.status && f.status !== "all") q = q.eq("status", f.status);
  const s = f.search?.trim();
  if (s) {
    const digits = s.replace(/\D/g, "");
    q = digits.length >= 4 ? q.ilike("phone", `%${digits}%`) : q.ilike("name", `%${s.replace(/[%,()]/g, " ")}%`);
  }
  const r = await q.order("sent_at", { ascending: false, nullsFirst: false }).order("created_at").range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
  if (r.error) throw r.error;
  return { rows: (r.data ?? []) as WaRecipient[], count: r.count ?? 0 };
}
export async function waOptouts(tenantId: string) {
  return check(await db().from("wa_optouts").select("phone, source, body, created_at").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500)) as
    { phone: string; source: string; body: string | null; created_at: string }[];
}
export async function waSetOptout(tenantId: string, phone: string, optout: boolean) {
  check(await db().rpc("wa_optout_set", { p_tenant_id: tenantId, p_phone: phone, p_optout: optout }));
}
export async function waDialLists(tenantId: string) {
  const o = await dialOverview(tenantId, null);
  return o.lists;
}
