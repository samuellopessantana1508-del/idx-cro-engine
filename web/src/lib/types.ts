export type Tenant = {
  id: string;
  slug: string;
  name: string;
  whatsapp_number: string;
  status: "active" | "paused" | "archived";
  default_message_template: string;
};

export type TenantUser = {
  id: string;
  tenant_id: string;
  user_id?: string | null;
  email?: string | null;
  role: "owner" | "admin" | "operator" | "viewer";
  status: "active" | "invited" | "disabled";
  created_at?: string | null;
};

export type Offer = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  category?: string | null;
  price?: number | null;
  default_message?: string | null;
  status: "active" | "paused" | "archived";
};

export type SmartLink = {
  id: string;
  tenant_id: string;
  offer_id?: string | null;
  code: string;
  name: string;
  message_template?: string | null;
  default_utm_source?: string | null;
  default_utm_medium?: string | null;
  default_utm_campaign?: string | null;
  default_utm_content?: string | null;
  default_utm_term?: string | null;
  status: "active" | "paused" | "archived";
  offer_name?: string | null;
  category?: string | null;
  clicks?: number;
  sales?: number;
  revenue?: number;
  conversion_rate?: number;
};

export type LeadStatus = "new" | "contacted" | "qualified" | "bad" | "sold" | "lost";

export type Lead = {
  id: string;
  tenant_id: string;
  ref: string;
  lead_status: LeadStatus;
  clicked_at: string;
  sold_at?: string | null;
  lost_at?: string | null;
  qualified_at?: string | null;
  bad_at?: string | null;
  next_follow_up_at?: string | null;
  lead_score?: number | null;
  tags?: string[] | null;
  last_crm_activity_at?: string | null;
  revenue?: number | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  link_name?: string | null;
  link_code?: string | null;
  offer_name?: string | null;
  category?: string | null;
};

export type CapiEvent = {
  event_name: "Lead" | "Purchase" | string;
  ok: boolean;
  status_code?: number | null;
  error_message?: string | null;
  created_at: string;
};

export type CapiHealth = {
  total_events: number;
  successful_events: number;
  failed_events: number;
  lead_events: number;
  purchase_events: number;
  success_rate: number;
  last_event_at?: string | null;
};

export type CrmActivity = {
  id: string;
  tenant_id: string;
  tracking_session_id: string;
  user_id?: string | null;
  activity_type: "note" | "stage_change" | "whatsapp" | "call" | "tag" | "capi" | "system" | string;
  body?: string | null;
  from_status?: LeadStatus | string | null;
  to_status?: LeadStatus | string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

export type MetaCampaignRoi = {
  tenant_id: string;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  reach: number;
  meta_clicks: number;
  idx_leads: number;
  idx_qualified?: number;
  idx_bad?: number;
  idx_sales: number;
  idx_revenue: number;
  cpl?: number | null;
  cost_per_qualified?: number | null;
  quality_rate?: number | null;
  roas?: number | null;
  date_start?: string | null;
  date_stop?: string | null;
};

export type WhatsAppInstance = {
  id: string;
  tenant_id: string;
  instance_name: string;
  phone_number?: string | null;
  provider: "evolution" | "cloud_api";
  status: "disconnected" | "connecting" | "connected" | "banned";
  api_url?: string | null;
  qr_code_data?: string | null;
  last_seen_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type WhatsAppContact = {
  id: string;
  tenant_id: string;
  instance_id: string;
  wa_id: string;
  phone?: string | null;
  push_name?: string | null;
  profile_pic_url?: string | null;
  is_business: boolean;
  tags?: string[];
  created_at: string;
  updated_at: string;
};

export type WhatsAppConversation = {
  id: string;
  tenant_id: string;
  instance_id: string;
  contact_id: string;
  tracking_session_id?: string | null;
  status: "active" | "archived" | "spam";
  last_message_at?: string | null;
  unread_count: number;
  ai_summary?: string | null;
  ai_intent?: string | null;
  ai_sentiment?: "positive" | "neutral" | "negative" | null;
  ai_purchase_probability?: number | null;
  ai_analyzed_at?: string | null;
  created_at: string;
  updated_at: string;
  contact?: WhatsAppContact;
};

export type WhatsAppMessage = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  wa_message_id?: string | null;
  direction: "inbound" | "outbound";
  sender_phone?: string | null;
  content_type: "text" | "image" | "audio" | "video" | "document" | "location" | "contact" | "sticker" | "reaction" | "unknown";
  body?: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  quoted_message_id?: string | null;
  timestamp: string;
  status: "sent" | "delivered" | "read" | "failed" | "pending";
  created_at: string;
};

export type WebhookKey = {
  id: string;
  tenant_id: string;
  label: string;
  last_used_at?: string | null;
  status: "active" | "revoked";
  created_at: string;
  plain_key?: string;
};

export type ConversationInsight = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  extracted_name?: string | null;
  extracted_email?: string | null;
  extracted_phone?: string | null;
  extracted_address?: string | null;
  products_of_interest?: string[];
  objections?: string[];
  preferences?: Record<string, unknown>;
  commercial_notes?: string | null;
  summary?: string | null;
  intent?: string | null;
  sentiment?: "positive" | "neutral" | "negative" | null;
  purchase_probability?: number | null;
  confidence_score?: number | null;
  last_analyzed_message_id?: string | null;
  messages_analyzed_count?: number;
  model_used?: string | null;
  extracted_data?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SaleSignal = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  tracking_session_id?: string | null;
  product_name?: string | null;
  product_category?: string | null;
  estimated_value?: number | null;
  currency?: string;
  signal_type: "interest" | "negotiation" | "commitment" | "confirmed_sale" | "post_sale";
  confidence?: number | null;
  evidence_text?: string | null;
  evidence_messages?: unknown[];
  status: "detected" | "confirmed" | "rejected" | "converted";
  purchase_data?: Record<string, unknown> | null;
  capi_sent: boolean;
  created_at: string;
  updated_at: string;
};

export type MetaAudienceStatus = {
  tenant_id: string;
  audience_key: "qualified" | "purchased";
  name: string;
  description?: string | null;
  meta_audience_id?: string | null;
  ad_account_id?: string | null;
  customer_file_source?: string | null;
  sync_status: "not_created" | "created" | "syncing" | "synced" | "failed";
  last_synced_at?: string | null;
  last_error?: string | null;
  synced_members: number;
  failed_members: number;
  skipped_members: number;
  total_attempts: number;
};
