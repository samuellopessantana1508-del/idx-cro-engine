export type CrmRole = "admin" | "manager" | "sales" | "marketing" | "service" | "success" | "viewer";

export type CrmAccess = {
  role: CrmRole | null;
  read: boolean;
  write: boolean;
  configure: boolean;
  finance: boolean;
  delete: boolean;
  export: boolean;
  audit: boolean;
  user_id: string | null;
};

export type Member = { user_id: string; email: string | null; role: string; crm_role: string | null; status: string };

export type Pipeline = { id: string; tenant_id: string; name: string; description: string | null; position: number; is_default: boolean; archived_at: string | null };

export type Stage = {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  name: string;
  position: number;
  probability: number;
  kind: "open" | "won" | "lost";
  legacy_status: string | null;
  color: string | null;
  entry_criteria: string | null;
  exit_criteria: string | null;
  rotting_days: number | null;
  archived_at: string | null;
};

export type LossReason = { id: string; name: string; position: number; archived_at: string | null };

export type Priority = "low" | "normal" | "high" | "urgent";

export type Deal = {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  value: number;
  currency: string;
  probability: number | null;
  expected_close_date: string | null;
  status: "open" | "won" | "lost";
  priority: Priority;
  won_at: string | null;
  lost_at: string | null;
  loss_reason_id: string | null;
  loss_note: string | null;
  stage_entered_at: string;
  position: number;
  last_activity_at: string | null;
  next_activity_at: string | null;
  source_channel: string | null;
  attribution_basis: "known" | "inferred" | "declared" | "unknown";
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  ad_ids: Record<string, string>;
  tracking_session_id: string | null;
  conversation_id: string | null;
  tags: string[];
  custom: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  // vw_crm_deals
  stage_name?: string;
  stage_kind?: string;
  stage_probability?: number;
  stage_color?: string | null;
  stage_position?: number;
  pipeline_name?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  do_not_contact?: boolean | null;
  company_name?: string | null;
  loss_reason_name?: string | null;
  owner_email?: string | null;
  days_in_stage?: number;
  is_rotting?: boolean;
  effective_probability?: number;
  weighted_value?: number;
  next_task_title?: string | null;
  next_task_type?: string | null;
  next_task_id?: string | null;
  ai_purchase_probability?: number | null;
  unread_count?: number | null;
  ai_summary?: string | null;
  is_click_only?: boolean;
  valid_orders?: number;
  valid_revenue?: number;
  pending_orders?: number;
};

export type Lifecycle = "lead" | "mql" | "sal" | "sql" | "opportunity" | "customer" | "inactive";

export type Contact = {
  id: string;
  tenant_id: string;
  unit_id: string | null;
  company_id: string | null;
  name: string | null;
  phone: string | null;
  phone_raw: string | null;
  whatsapp: string | null;
  email: string | null;
  job_title: string | null;
  city: string | null;
  state: string | null;
  lifecycle_stage: Lifecycle;
  lifecycle_source: string;
  owner_id: string | null;
  tags: string[];
  notes: string | null;
  custom: Record<string, unknown>;
  source_channel: string | null;
  source_detail: string | null;
  acquisition_basis: "known" | "inferred" | "declared" | "unknown";
  acquisition_campaign: string | null;
  acquisition_at: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  ad_ids: Record<string, string>;
  inbound_outbound: string | null;
  lead_score: number;
  lead_score_details: { label: string; points: number }[];
  qualification: Record<string, string>;
  disqualification_reason: string | null;
  marketing_consent: "unknown" | "granted" | "denied";
  do_not_contact: boolean;
  created_at: string;
  updated_at: string;
  last_interaction_at: string | null;
  archived_at: string | null;
  // vw_crm_contacts
  company_name?: string | null;
  owner_email?: string | null;
  open_deals?: number;
  open_value?: number;
  won_deals?: number;
  rfv_segment?: RfvSegment | null;
  r_score?: number | null;
  f_score?: number | null;
  m_score?: number | null;
  last_purchase_at?: string | null;
  purchase_count?: number | null;
  net_revenue?: number | null;
  expected_next_purchase_at?: string | null;
  conversation_id?: string | null;
  unread_count?: number | null;
  last_message_at?: string | null;
};

export type Company = {
  id: string;
  tenant_id: string;
  name: string;
  document: string | null;
  domain: string | null;
  segment: string | null;
  size: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  owner_id: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
};

export type TaskType = "call" | "meeting" | "follow_up" | "callback" | "task" | "proposal" | "email" | "whatsapp" | "visit" | "other";

export type Task = {
  id: string;
  tenant_id: string;
  task_type: TaskType;
  title: string;
  description: string | null;
  owner_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  company_id: string | null;
  due_at: string | null;
  duration_minutes: number | null;
  priority: Priority;
  status: "open" | "done" | "canceled";
  outcome: string | null;
  completed_at: string | null;
  automation_rule_id: string | null;
  cadence_enrollment_id?: string | null;
  created_at: string;
  contact?: { name: string | null; phone: string | null } | null;
  deal?: { title: string } | null;
};

export type TimelineItem = {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  deal_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  actor_id: string | null;
  occurred_at: string;
  origin: "crm" | "legacy";
};

export type OrderStatus = "pending" | "confirmed" | "paid" | "partially_refunded" | "refunded" | "cancelled";

export type Order = {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  deal_id: string | null;
  order_number: string | null;
  order_date: string;
  status: OrderStatus;
  order_kind: "one_time" | "recurring_cycle";
  gross_amount: number;
  discount_amount: number;
  refunded_amount: number;
  net_amount: number;
  installments: number;
  is_free: boolean;
  payment_method: string | null;
  evidence_type: string;
  evidence_note: string | null;
  source: string;
  created_at: string;
  company_id?: string | null;
  owner_id?: string | null;
  source_ref?: string | null;
};

export type Offer = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  category: string | null;
  price: number | null;
  status: "active" | "paused" | "archived";
  description: string | null;
  kind: "product" | "service";
  sku: string | null;
  cost: number | null;
  is_recurring: boolean;
  billing_interval: string | null;
  commercial_terms: string | null;
};

export type DealItem = { id: string; deal_id: string; offer_id: string | null; name: string; quantity: number; unit_price: number; discount: number; total: number };

export type Quote = {
  id: string;
  deal_id: string;
  number: number;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  valid_until: string | null;
  items: { name: string; quantity: number; unit_price: number; discount: number; total: number }[];
  subtotal: number;
  discount: number;
  total: number;
  terms: string | null;
  created_at: string;
};

export type RfvSegment = "champions" | "loyal" | "high_value_at_risk" | "at_risk" | "new" | "potential" | "hibernating" | "lost" | "no_purchase";

export type RfvCustomer = {
  contact_id: string;
  tenant_id: string;
  r_score: number | null;
  f_score: number | null;
  m_score: number | null;
  segment: RfvSegment;
  previous_segment: RfvSegment | null;
  segment_changed_at: string | null;
  days_since_last: number | null;
  last_purchase_at: string | null;
  purchase_count: number;
  net_revenue: number;
  avg_ticket: number | null;
  avg_interval_days: number | null;
  expected_next_purchase_at: string | null;
  overdue_days: number | null;
  method_used: string | null;
  rule_version: number | null;
  computed_at: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  owner_id: string | null;
  do_not_contact: boolean;
  marketing_consent: string;
  priority_rank: number;
};

export type RfvSettings = {
  tenant_id: string;
  preset: string;
  method: "auto" | "quintile" | "manual";
  r_thresholds: number[];
  f_thresholds: number[];
  m_thresholds: number[];
  window_days: number | null;
  lost_after_days: number;
  count_recurring_cycles: boolean;
  min_customers_quintile: number;
  rule_version: number;
  dirty: boolean;
  last_computed_at: string | null;
};

export type RfvDashboard = {
  customers: number;
  no_purchase: number;
  revenue: number;
  avg_ticket: number | null;
  avg_frequency: number | null;
  avg_interval_days: number | null;
  at_risk_pct: number | null;
  top20_revenue_share: number | null;
  repurchase_rate: number | null;
  segments: { segment: RfvSegment; customers: number; revenue: number; avg_ticket: number | null; avg_frequency: number | null }[];
  matrix: { r: number; f: number; customers: number; revenue: number }[];
  migrations: { from: RfvSegment; to: RfvSegment; customers: number }[];
  trend: { month: string; segment: RfvSegment; customers: number }[];
  settings: RfvSettings;
};

export type Kpi = {
  value: number | null | unknown[];
  available: boolean;
  unit: "count" | "money" | "percent" | "days" | "minutes" | "table";
  label: string;
  formula: string;
  source: string;
  extra?: unknown;
};

export type KpiResponse = { period: { from: string; to: string }; generated_at: string; metrics: Record<string, Kpi> };

export type AutomationRule = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>[];
  enabled: boolean;
  template_key: string | null;
  run_count: number;
  error_count: number;
  last_run_at: string | null;
};

export type AutomationRun = {
  id: number;
  rule_id: string;
  event: string;
  record_type: string | null;
  record_id: string | null;
  status: "success" | "skipped" | "error";
  message: string | null;
  created_at: string;
};

export type CrmNotification = {
  id: string;
  title: string;
  body: string | null;
  severity: "info" | "warning" | "critical";
  link_type: "deal" | "contact" | "task" | "company" | null;
  link_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type CrmSettings = {
  tenant_id: string;
  currency: string;
  seller_visibility: "all" | "own";
  stale_deal_days: number;
  auto_deal_from_clicks: boolean;
  auto_deal_from_whatsapp: boolean;
  default_pipeline_id: string | null;
  icp: Record<string, unknown>;
  scoring: { mql_threshold: number; rules: ScoringRule[] };
  lifecycle_definitions: Record<string, string>;
};

export type ScoringRule = { label: string; field: string; op: "exists" | "eq" | "in" | "contains" | "gte"; value?: string | string[] | number; points: number };

export type CustomField = { id: string; entity: "contact" | "company" | "deal"; field_key: string; label: string; field_type: string; options: string[]; required: boolean; position: number };

export type Sample = { id: string; contact_id: string; product_name: string; delivered_at: string; campaign: string | null; channel: string | null; feedback: string | null; rating: number | null; first_purchase_after_at?: string | null; days_to_first_purchase?: number | null; revenue_after?: number; contact_name?: string | null };

export type Onboarding = {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  owner_id: string | null;
  title: string;
  status: "not_started" | "in_progress" | "active" | "at_risk" | "churned" | "completed";
  promised: string | null;
  handoff_notes: string | null;
  success_plan: string | null;
  checklist: { id: string; label: string; done: boolean; done_at?: string | null }[];
  started_at: string;
  activated_at: string | null;
  first_value_at: string | null;
  first_value_note: string | null;
  renewal_date: string | null;
  nps: number | null;
  csat: number | null;
  health: "good" | "attention" | "critical" | null;
  risk_notes: string | null;
  expansion_notes: string | null;
};

export type Campaign = { id: string; name: string; kind: string; status: string; channel: string | null; attribution_window_days: number; created_at: string };
export type CampaignResult = { campaign_id: string; name: string; kind: string; status: string; members: number; responded: number; converted: number; revenue: number; reactivated: number; revenue_recovered: number };

export type CrmView =
  | { name: "home" }
  | { name: "routine" }
  | { name: "deals" }
  | { name: "contacts" }
  | { name: "contact"; id: string }
  | { name: "companies" }
  | { name: "tasks" }
  | { name: "products" }
  | { name: "rfv" }
  | { name: "reports" }
  | { name: "automations" }
  | { name: "settings" }
  | { name: "import" }
  | { name: "dialer" }
  | { name: "cadences" }
  | { name: "goals" }
  | { name: "dispatch" };

export type DialOutcome = "talked" | "meeting" | "callback" | "no_answer" | "not_interested" | "invalid";
export type DialLead = {
  id: string; tenant_id: string; list_name: string; name: string; phone: string; phone2: string | null;
  city: string | null; uf: string | null; district: string | null; cnpj: string | null; source: string;
  status: "pending" | "called"; outcome: DialOutcome | null; called_at: string | null; called_by: string | null; objection?: string | null;
  call_count: number; notes: string | null; contact_id: string | null; created_at: string;
};
export type DialOverview = {
  lists: { name: string; total: number; pending: number }[];
  total: number; pending: number; called: number; called_today: number; meetings: number; callbacks: number;
  ufs: { uf: string; total: number; pending: number }[];
};

// ---------- cadências ----------
export type CadenceChannel = "call" | "whatsapp" | "email" | "task";
export type CadenceStep = { id?: string; position: number; wait_days: number; channel: CadenceChannel; title: string | null; template: string | null };
export type Cadence = {
  id: string; name: string; description: string | null; active: boolean; stop_on_reply: boolean; stop_on_deal_close: boolean;
  steps: CadenceStep[]; active_count: number; completed_count: number; replied_count: number; won_count: number;
};
export type CadenceEnrollment = {
  id: string; cadence_id: string; cadence_name: string; contact_id: string; contact_name: string | null; contact_phone: string | null;
  status: "active" | "completed" | "stopped"; stop_reason: string | null; steps_done: number; steps_total: number;
  current_step: { channel: CadenceChannel; title: string | null } | null; next_due_at: string | null; owner_id: string | null;
  enrolled_at: string; finished_at: string | null;
};

// ---------- metas ----------
export type GoalMetric = "won_value" | "won_count" | "deals_created" | "meetings" | "calls";
export type Goal = {
  id: string; tenant_id: string; name: string; metric: GoalMetric; scope: "company" | "user"; user_id: string | null;
  period: "week" | "month" | "quarter"; target: number; pipeline_id: string | null; active: boolean;
};
export type GoalProgress = Omit<Goal, "tenant_id" | "active"> & {
  actual: number; pct: number; elapsed_pct: number; period_start: string; period_end: string; by_user: { user_id: string | null; actual: number }[];
};

// ---------- assistente ----------
export type AssistantPlan = {
  source: "voice" | "text"; transcript: string;
  dial_lead_id: string | null; dial_outcome: DialOutcome | null;
  contact_id: string | null;
  contact: { name?: string; phone?: string; company?: string; email?: string; city?: string; uf?: string };
  deal: { action: "create" | "none"; title?: string | null; value?: number | null; stage_id?: string | null; stage_name?: string | null };
  task: { type: TaskType; title: string; due_local: string | null; due_at: string | null; notes?: string } | null;
  objection: string | null; note: string | null; summary: string | null;
};
export type AssistantMatch = {
  id: string; name: string | null; phone: string | null; company: { id: string; name: string } | null;
  deals: { id: string; title: string; value: number; status: string; stage_name: string }[];
  tasks: { id: string; title: string; due_at: string | null }[];
  cadences: { id: string; name: string }[];
} | null;
export type AssistantResult = { plan: AssistantPlan; match: AssistantMatch; engine: "ai" | "rules"; ai_error: string | null; warnings: string[]; timezone: string };

// ---------- Disparos (WhatsApp) ----------
export type WaGatewayInstance = {
  id: string; tenant_id: string; instance_name: string; phone_number: string | null; provider: string;
  status: "disconnected" | "connecting" | "connected" | "banned"; desired_status: "connected" | "disconnected" | "logout";
  qr_code_data: string | null; last_seen_at: string | null; metadata: Record<string, unknown> | null; updated_at: string;
};
export type WaCampaignStatus = "draft" | "running" | "paused" | "completed" | "canceled";
export type WaCampaign = {
  id: string; name: string; status: WaCampaignStatus; messages: string[];
  min_delay_sec: number; max_delay_sec: number; daily_limit: number; start_hour: number; end_hour: number; opt_out_footer: boolean; auto_feed: boolean;
  next_send_at: string | null; paused_reason: string | null; started_at: string | null; completed_at: string | null; created_at: string;
  audience: Record<string, unknown>;
  total: number; pending: number; sent: number; failed: number; invalid: number; opted_out: number; skipped: number; replied: number;
  sent_today: number;
};
export type WaRecipientStatus = "pending" | "queued" | "sent" | "failed" | "invalid" | "opted_out" | "skipped";
export type WaRecipient = {
  id: string; campaign_id: string; phone: string; name: string | null; vars: Record<string, string>; status: WaRecipientStatus;
  error: string | null; sent_at: string | null; replied_at: string | null; crm_contact_id: string | null; dial_lead_id: string | null;
};
export type WaAddResult = { added: number; invalid_phone: number; duplicates: number; opted_out: number; total: number };
export type WaOutboxItem = {
  id: string; phone: string; body: string; source: "manual" | "campaign"; status: "queued" | "sending" | "sent" | "failed" | "canceled";
  error: string | null; created_at: string; sent_at: string | null; conversation_id: string | null;
};

// ---------- Busca de clientes (Google Maps) ----------
export type MapsStatus = { has_key: boolean; key_hint: string | null; monthly_call_limit: number; calls_this_month: number };
export type LeadSource = {
  id: string; tenant_id: string; name: string; query: string; locations: string[]; location_cursor: number; list_name: string;
  auto: boolean; interval_hours: number; run_hour: number; locations_per_run: number; pages_per_location: number; max_new_per_run: number;
  exclude_chains: boolean; min_rating: number | null; campaign_id: string | null; active: boolean;
  next_run_at: string | null; last_run_at: string | null; running_since: string | null;
  last_result: { inserted: number; found: number; duplicates: number; to_campaign: number; error: string | null; api_calls: number } | null;
  created_at: string;
};
export type LeadSourceRunResult = {
  run_id: string; inserted: number; found: number; duplicates: number; no_phone: number; chains: number; low_rating: number;
  opted_out: number; to_campaign: number; api_calls: number; error: string | null;
};
export type MapsPlace = {
  place_id: string; name: string; phone: string | null; address: string | null; city: string | null; uf: string | null;
  district: string | null; rating: number | null; reviews: number | null; rank: number; maps_url: string | null; already: boolean;
};
