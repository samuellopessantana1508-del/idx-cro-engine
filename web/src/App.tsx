import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  Check,
  CircleDot,
  Clock,
  Clipboard,
  FileText,
  Gauge,
  LayoutList,
  Link2,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  Brain,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Download,
  Target,
  Zap,
} from "lucide-react";
import { supabase } from "./lib/supabaseClient";
import type { AiPatterns, CampaignMetric, CapiEvent, CapiHealth, ConversationInsight, CrmActivity, CustomerProfile, FinancialSummary, Lead, LeadStatus, MetaAudienceStatus, MetaCampaignRoi, MonthlyPoint, Offer, SaleSignal, SaleSignalCapiStatus, SmartLink, Tenant, TenantUser, WebhookKey, WhatsAppConversation, WhatsAppInstance, WhatsAppMessage } from "./lib/types";
import { envConfigured, formatDate, formatMoney, linkCode, slugify, smartLinkUrl, timeAgo } from "./lib/utils";

const AI_PLACEHOLDER_VALUES = new Set([
  "string", "string ou null", "ids", "key", "value", "null",
  "citação curta da conversa", "resumo conciso da conversa em 1-2 frases",
  "intenção principal do cliente", "observações comerciais relevantes ou null",
  "observações comerciais relevantes", "nome do produto", "product name",
  "name", "text", "example", "exemplo", "n/a", "none", "nenhum",
  "nenhuma", "não identificado", "não informado", "desconhecido",
  "unknown", "not available", "not found", "sem informação",
  "abc12345", "def67890", "corte de cabelo", "achei caro",
  "joão silva", "joao silva",
]);

function isAiPlaceholder(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t === "" || AI_PLACEHOLDER_VALUES.has(t);
}

function cleanAiText(v: string | null | undefined): string | null {
  if (!v || isAiPlaceholder(v)) return null;
  return v;
}

function cleanAiArray(arr: string[] | null | undefined): string[] {
  if (!arr) return [];
  return arr.filter((v) => !isAiPlaceholder(v));
}

type Section = "dashboard" | "sales" | "links" | "leads" | "crm" | "integrations" | "whatsapp" | "clients" | "users" | "reports" | "capi" | "ai-sales" | "intelligence" | "settings" | "follow-ups" | "segments" | "google-ads";

type GoogleCampaignRoi = {
  tenant_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string | null;
  campaign_type: string | null;
  date_start: string | null;
  date_stop: string | null;
  spend: number;
  impressions: number;
  google_clicks: number;
  google_conversions: number;
  idx_leads: number;
  idx_qualified: number;
  idx_sales: number;
  idx_revenue: number;
  cpl: number | null;
  cpv: number | null;
  roas: number | null;
};

type GoogleCredentials = {
  customer_id: string | null;
  customer_descriptive_name: string | null;
  manager_customer_id: string | null;
  google_user_email: string | null;
  integration_status: string;
  enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  currency_code: string | null;
  last_verified_at?: string | null;
  time_zone?: string | null;
  // not_connected | needs_attention | needs_account | account_selected | synced
  stage?: string;
};

type GoogleCustomer = {
  id: string;
  name: string;
  manager: boolean;
  currency_code?: string | null;
  login_customer_id?: string;
  via_manager_name?: string | null;
};

type PlatformRole = "owner" | "admin" | "support" | "viewer";

type DraftLink = {
  offerName: string;
  category: string;
  price: string;
  linkName: string;
  campaign: string;
  source: string;
  medium: string;
  content: string;
  term: string;
  message: string;
};

type ClientDraft = {
  name: string;
  slug: string;
  whatsapp: string;
  businessSegment: string;
  city: string;
  state: string;
  monthlyGoal: string;
  averageTicket: string;
  primaryChannel: string;
  responsibleName: string;
};

type InviteDraft = {
  email: string;
  role: "owner" | "admin" | "operator" | "viewer";
};

type MetaDraft = {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
};

type ContactDraft = {
  phone: string;
  email: string;
  name: string;
};

type SupabaseHealthState = {
  database_model?: string;
  database_owner?: string;
  tenant_isolation?: string;
  tenant_scope?: string;
  tables?: Record<string, number>;
};

type TenantOnboarding = {
  tenant_id: string;
  tenant_created?: boolean | null;
  whatsapp_checked?: boolean | null;
  meta_connected?: boolean | null;
  business_segment?: string | null;
  city?: string | null;
  state?: string | null;
  monthly_goal?: number | null;
  average_ticket?: number | null;
  primary_channel?: string | null;
  responsible_name?: string | null;
};

type TenantSummary = {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  tenant_users: number;
  offers: number;
  smart_links: number;
  tracking_sessions: number;
  crm_activities: number;
  capi_events: number;
  meta_insight_rows: number;
  last_activity_at?: string | null;
};

type QualityRow = {
  campaign: string;
  spend: number;
  leads: number;
  contacted: number;
  qualified: number;
  bad: number;
  sales: number;
  revenue: number;
  qualityRate: number;
  cpl: number | null;
  costPerQualified: number | null;
  roas: number | null;
};

type CrmFilter = LeadStatus | "all" | "needs_follow_up" | "no_identifier";
type SalesFilter = "now" | "new" | "contacted" | "qualified" | "sold";

type ReadinessItem = {
  title: string;
  detail: string;
  done: boolean;
  section: Section;
};

type ExecutiveInsight = {
  title: string;
  detail: string;
  tone: "good" | "warning" | "neutral";
};

type MetaPixelAsset = {
  id: string;
  name?: string | null;
};

type MetaAdAccountAsset = {
  id: string;
  account_id?: string | null;
  name?: string | null;
  adspixels?: { data?: MetaPixelAsset[] } | MetaPixelAsset[] | null;
};

// Domínio público do painel. A URI abaixo é a que precisa estar em
// Meta Developers > Facebook Login > Valid OAuth Redirect URIs.
const PUBLIC_APP_URL = String(import.meta.env.VITE_PUBLIC_APP_URL ?? "").replace(/\/+$/, "") || "https://cro.sanmarfidelize.com";
const META_OAUTH_CALLBACK_URL = `${PUBLIC_APP_URL}/meta-oauth-callback.html`;

// Resultado do retorno do Facebook Login (?meta=...), definido pela Edge Function meta-oauth.
const META_RETURN_MESSAGES: Record<string, string> = {
  connected: "Facebook conectado. Sincronizando contas e campanhas...",
  no_ad_accounts: "Facebook conectado, mas este login não tem acesso a nenhuma conta de anúncios. Peça acesso no Gerenciador de Negócios e conecte de novo.",
  denied: "Conexão cancelada no Facebook. Clique em Conectar Facebook e aceite as permissões.",
  state_error: "O link de conexão expirou ou já foi usado. Clique em Conectar Facebook de novo.",
  token_error: "O Facebook não liberou o token. Confira se a URI de retorno está cadastrada na Meta App e tente de novo.",
  save_error: "Não foi possível salvar a conexão com o Facebook. Tente de novo.",
  migration_required: "Falta aplicar a migration do token do Facebook no banco. O Token CAPI foi preservado; aplique a migration e conecte de novo.",
  config_error: "Meta App não configurada no servidor (META_APP_ID / META_APP_SECRET).",
  error: "Não foi possível concluir a conexão com o Facebook. Tente de novo.",
};
const validSections: Section[] = ["dashboard", "sales", "links", "leads", "crm", "integrations", "whatsapp", "clients", "users", "reports", "capi", "ai-sales", "intelligence", "settings", "follow-ups", "segments", "google-ads"];

const emptyDraft: DraftLink = {
  offerName: "",
  category: "",
  price: "",
  linkName: "",
  campaign: "",
  source: "meta",
  medium: "paid",
  content: "",
  term: "",
  message: "Olá! Tenho interesse em {{oferta}}. Ref: {{ref}}",
};

const emptyClientDraft: ClientDraft = {
  name: "",
  slug: "",
  whatsapp: "",
  businessSegment: "",
  city: "",
  state: "",
  monthlyGoal: "",
  averageTicket: "",
  primaryChannel: "",
  responsibleName: "",
};

const emptyInviteDraft: InviteDraft = {
  email: "",
  role: "operator",
};

const emptyMetaDraft: MetaDraft = {
  pixelId: "",
  accessToken: "",
  testEventCode: "",
};

const emptyHealth: CapiHealth = {
  total_events: 0,
  successful_events: 0,
  failed_events: 0,
  lead_events: 0,
  purchase_events: 0,
  success_rate: 0,
  last_event_at: null,
};

type LinksTab = "links" | "utm" | "attribution";

type UtmTemplate = {
  label: string;
  source: string;
  medium: string;
  campaignHint: string;
  contentHint: string;
  termHint: string;
};

const UTM_TEMPLATES: UtmTemplate[] = [
  { label: "Meta Ads", source: "meta", medium: "paid", campaignHint: "nome-da-campanha", contentHint: "criativo-ou-conjunto", termHint: "publico-alvo" },
  { label: "Google Ads", source: "google", medium: "cpc", campaignHint: "campanha-search", contentHint: "grupo-de-anuncio", termHint: "palavra-chave" },
  { label: "Instagram Orgânico", source: "instagram", medium: "organic", campaignHint: "bio-link", contentHint: "post-ou-story", termHint: "" },
  { label: "WhatsApp", source: "whatsapp", medium: "referral", campaignHint: "indicacao", contentHint: "", termHint: "" },
  { label: "E-mail", source: "email", medium: "newsletter", campaignHint: "campanha-email", contentHint: "cta-ou-assunto", termHint: "" },
];

type CampaignAttribution = {
  tenant_id: string;
  campaign: string;
  source: string;
  medium: string;
  clicks: number;
  leads: number;
  qualified: number;
  sales: number;
  revenue: number;
  ai_signals: number;
  ai_confirmed_sales: number;
  first_click_at: string | null;
  last_click_at: string | null;
};

function authRedirectTo() {
  return `${window.location.origin}${window.location.pathname}`;
}

function requestedSectionFromUrl(): Section | null {
  const section = new URLSearchParams(window.location.search).get("section") as Section | null;
  return section && validSections.includes(section) ? section : null;
}

function smartLinkWithUtms(link: SmartLink): string {
  const params = new URLSearchParams();
  if (link.default_utm_source) params.set("utm_source", link.default_utm_source);
  if (link.default_utm_medium) params.set("utm_medium", link.default_utm_medium);
  if (link.default_utm_campaign) params.set("utm_campaign", link.default_utm_campaign);
  if (link.default_utm_content) params.set("utm_content", link.default_utm_content);
  if (link.default_utm_term) params.set("utm_term", link.default_utm_term);
  const query = params.toString();
  return `${smartLinkUrl(link.code)}${query ? `?${query}` : ""}`;
}

function normalizeActId(value: string): string {
  const clean = value.trim();
  if (!clean) return "";
  return clean.startsWith("act_") ? clean : `act_${clean}`;
}

function accountPixels(account: MetaAdAccountAsset): MetaPixelAsset[] {
  if (Array.isArray(account.adspixels)) return account.adspixels;
  return account.adspixels?.data ?? [];
}

function metaAssetValue(accountId: string, pixelId = ""): string {
  return `${accountId}|${pixelId}`;
}

const RESERVED_COMPANY_PATHS = new Set([
  "assets",
  "data-deletion.html",
  "favicon.ico",
  "index.html",
  "meta-oauth-callback.html",
  "privacy.html",
  "terms.html",
]);

function tenantSlugFromPath(pathname = window.location.pathname): string {
  const segment = decodeURIComponent(pathname.split("/").filter(Boolean)[0] ?? "");
  if (!segment || segment.includes(".") || RESERVED_COMPANY_PATHS.has(segment.toLowerCase())) return "";
  return slugify(segment);
}

function tenantAccessUrl(slug: string | null | undefined): string {
  const clean = slugify(slug ?? "");
  return clean ? `${window.location.origin}/${clean}` : window.location.origin;
}

function cleanPhone(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function contactWasEdited(lead: Lead, contact: ContactDraft): boolean {
  return Boolean(
    (contact.name.trim() && contact.name.trim() !== String(lead.customer_name ?? "").trim()) ||
      (contact.email.trim() && contact.email.trim().toLowerCase() !== String(lead.customer_email ?? "").trim().toLowerCase()) ||
      (cleanPhone(contact.phone) && cleanPhone(contact.phone) !== cleanPhone(lead.customer_phone)),
  );
}

function duplicateContactLead(lead: Lead, contact: ContactDraft | undefined, allLeads: Lead[]): Lead | null {
  const requestedPhone = cleanPhone(contact?.phone);
  const currentPhone = cleanPhone(lead.customer_phone);
  const phone = requestedPhone || currentPhone;
  if (!phone) return null;
  return allLeads.find((item) => item.id !== lead.id && cleanPhone(item.customer_phone) === phone) ?? null;
}

function isOpenLead(lead: Lead): boolean {
  return !["sold", "lost", "bad"].includes(lead.lead_status);
}

function leadFollowUpDue(lead: Lead): boolean {
  if (!lead.next_follow_up_at || !isOpenLead(lead)) return false;
  const followUpAt = new Date(lead.next_follow_up_at).getTime();
  return Number.isFinite(followUpAt) && followUpAt <= Date.now();
}

function leadContactPhone(lead: Lead, contact?: ContactDraft): string {
  return cleanPhone(contact?.phone || lead.customer_phone || "");
}

function whatsappUrl(phone: string): string {
  return phone ? `https://wa.me/${phone}` : "";
}

function sortSalesQueue(leads: Lead[]): Lead[] {
  const priority: Record<LeadStatus, number> = {
    new: 1,
    contacted: 2,
    qualified: 3,
    bad: 6,
    lost: 7,
    sold: 8,
  };
  return [...leads].sort((a, b) => {
    const dueDiff = Number(leadFollowUpDue(b)) - Number(leadFollowUpDue(a));
    if (dueDiff) return dueDiff;
    const priorityDiff = priority[a.lead_status] - priority[b.lead_status];
    if (priorityDiff) return priorityDiff;
    return new Date(b.clicked_at).getTime() - new Date(a.clicked_at).getTime();
  });
}

export function App() {
  const isConfigured = envConfigured() && Boolean(supabase);
  const requestedTenantSlug = useMemo(() => tenantSlugFromPath(), []);
  const requestedSection = useMemo(() => requestedSectionFromUrl(), []);
  const [sessionReady, setSessionReady] = useState(!isConfigured);
  const [signedIn, setSignedIn] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [tenantSetupRequired, setTenantSetupRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [accessLinkEmail, setAccessLinkEmail] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [currentUserEmail, setCurrentUserEmail] = useState("");
  const [active, setActive] = useState<Section>(requestedSection ?? "dashboard");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [platformRole, setPlatformRole] = useState<PlatformRole | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantSummaries, setTenantSummaries] = useState<TenantSummary[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [links, setLinks] = useState<SmartLink[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [events, setEvents] = useState<CapiEvent[]>([]);
  const [crmActivities, setCrmActivities] = useState<CrmActivity[]>([]);
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([]);
  const [health, setHealth] = useState<CapiHealth>(emptyHealth);
  const [metaCampaigns, setMetaCampaigns] = useState<MetaCampaignRoi[]>([]);
  const [metaAudiences, setMetaAudiences] = useState<MetaAudienceStatus[]>([]);
  const [onboarding, setOnboarding] = useState<TenantOnboarding | null>(null);
  const [draft, setDraft] = useState<DraftLink>(emptyDraft);
  const [toast, setToast] = useState("");
  const [leadSearch, setLeadSearch] = useState("");
  const [saleRef, setSaleRef] = useState("");
  const [saleName, setSaleName] = useState("");
  const [salePhone, setSalePhone] = useState("");
  const [saleRevenue, setSaleRevenue] = useState("");
  const [crmSearch, setCrmSearch] = useState("");
  const [crmFilter, setCrmFilter] = useState<CrmFilter>("all");
  const [salesSearch, setSalesSearch] = useState("");
  const [salesFilter, setSalesFilter] = useState<SalesFilter>("now");
  const [salesSelectedLeadId, setSalesSelectedLeadId] = useState("");
  const [clientDraft, setClientDraft] = useState<ClientDraft>(emptyClientDraft);
  const [profileDraft, setProfileDraft] = useState<ClientDraft>(emptyClientDraft);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(emptyInviteDraft);
  const [sellerInviteEmail, setSellerInviteEmail] = useState("");
  const [metaDraft, setMetaDraft] = useState<MetaDraft>(emptyMetaDraft);
  const [adAccountId, setAdAccountId] = useState("");
  const [metaAdAccounts, setMetaAdAccounts] = useState<MetaAdAccountAsset[]>([]);
  const [selectedMetaAsset, setSelectedMetaAsset] = useState("");
  const [metaAssetsLoaded, setMetaAssetsLoaded] = useState(false);
  const [metaReturn, setMetaReturn] = useState(() => new URLSearchParams(window.location.search).get("meta"));
  const [crmNotes, setCrmNotes] = useState<Record<string, string>>({});
  const [crmContacts, setCrmContacts] = useState<Record<string, ContactDraft>>({});
  const [crmFollowUps, setCrmFollowUps] = useState<Record<string, string>>({});
  const [crmRevenue, setCrmRevenue] = useState<Record<string, string>>({});
  const [crmBusyRef, setCrmBusyRef] = useState("");
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [supabaseStatus, setSupabaseStatus] = useState<"unknown" | "ok" | "error">(isConfigured ? "unknown" : "ok");
  const [supabaseHealth, setSupabaseHealth] = useState<SupabaseHealthState>({
    database_model: undefined,
    database_owner: undefined,
    tenant_isolation: undefined,
    tenant_scope: undefined,
  });
  const [tenantRouteWarning, setTenantRouteWarning] = useState("");
  const [loading, setLoading] = useState(false);
  const [waInstances, setWaInstances] = useState<WhatsAppInstance[]>([]);
  const [waKeys, setWaKeys] = useState<WebhookKey[]>([]);
  const [waNewInstanceName, setWaNewInstanceName] = useState("");
  const [waNewInstanceUrl, setWaNewInstanceUrl] = useState("");
  const [waNewKeyLabel, setWaNewKeyLabel] = useState("");
  const [waGeneratedKey, setWaGeneratedKey] = useState("");
  const [waBusy, setWaBusy] = useState(false);
  const [waTab, setWaTab] = useState<"conversations" | "instances" | "config">("conversations");
  const [waConversations, setWaConversations] = useState<WhatsAppConversation[]>([]);
  const [waMessages, setWaMessages] = useState<WhatsAppMessage[]>([]);
  const [waSelectedConvId, setWaSelectedConvId] = useState("");
  const [waConvSearch, setWaConvSearch] = useState("");
  const [waEvoApiKey, setWaEvoApiKey] = useState("");
  const [waInsight, setWaInsight] = useState<ConversationInsight | null>(null);
  const [waSaleSignals, setWaSaleSignals] = useState<SaleSignal[]>([]);
  const [waInsightOpen, setWaInsightOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const waSelectedConvIdRef = useRef("");
  const waConvLoadingRef = useRef(false);
  const selectConvTokenRef = useRef(0);

  const [aiSales, setAiSales] = useState<SaleSignal[]>([]);
  const [aiSalesFilter, setAiSalesFilter] = useState<SaleSignalCapiStatus | "all">("all");
  const [aiSalesLoading, setAiSalesLoading] = useState(false);
  const [aiSalesBusy, setAiSalesBusy] = useState<string>("");

  const [linksTab, setLinksTab] = useState<LinksTab>("links");
  const [selectedUtmTemplate, setSelectedUtmTemplate] = useState<number>(0);
  const [campaignAttribution, setCampaignAttribution] = useState<CampaignAttribution[]>([]);
  const [attrPeriod, setAttrPeriod] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [attrSourceFilter, setAttrSourceFilter] = useState<string>("all");
  const [attrSearch, setAttrSearch] = useState("");

  const [followUpFilter, setFollowUpFilter] = useState<"due" | "upcoming" | "overdue" | "all">("due");
  const [segmentFilter, setSegmentFilter] = useState<string>("all");
  const [segmentTagInput, setSegmentTagInput] = useState("");
  const [segmentBusy, setSegmentBusy] = useState("");
  const [waCloudPhoneId, setWaCloudPhoneId] = useState("");
  const [waCloudWabaId, setWaCloudWabaId] = useState("");
  const [waCloudToken, setWaCloudToken] = useState("");
  const [waCloudVerifyToken, setWaCloudVerifyToken] = useState("");
  const [waCloudBusy, setWaCloudBusy] = useState(false);

  const [fiSummary, setFiSummary] = useState<FinancialSummary | null>(null);
  const [fiMonthly, setFiMonthly] = useState<MonthlyPoint[]>([]);
  const [fiCampaigns, setFiCampaigns] = useState<CampaignMetric[]>([]);
  const [fiCustomers, setFiCustomers] = useState<CustomerProfile[]>([]);
  const [fiPatterns, setFiPatterns] = useState<AiPatterns | null>(null);
  const [fiLoading, setFiLoading] = useState(false);
  const [fiTab, setFiTab] = useState<"overview" | "campaigns" | "customers" | "ai">("overview");
  const [fiExporting, setFiExporting] = useState(false);

  const [googleCreds, setGoogleCreds] = useState<GoogleCredentials | null>(null);
  const [googleCampaigns, setGoogleCampaigns] = useState<GoogleCampaignRoi[]>([]);
  const [googleCustomers, setGoogleCustomers] = useState<GoogleCustomer[]>([]);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleSyncDays, setGoogleSyncDays] = useState(30);
  const [googleDevTokenOk, setGoogleDevTokenOk] = useState(true);

  const tenant = tenants.find((item) => item.id === tenantId) ?? tenants[0];
  const isPlatformUser = Boolean(platformRole);
  const canCreateClients = ["owner", "admin", "support"].includes(String(platformRole)) || tenantSetupRequired;
  const tenantLinks = links.filter((item) => item.tenant_id === tenant?.id);
  const tenantLeads = leads.filter((item) => item.tenant_id === tenant?.id);
  const tenantOffers = offers.filter((item) => item.tenant_id === tenant?.id);
  const tenantMetaCampaigns = metaCampaigns.filter((item) => item.tenant_id === tenant?.id);
  const tenantCrmActivities = crmActivities.filter((item) => item.tenant_id === tenant?.id);
  const remarketingLeads = tenantLeads.filter((lead) => lead.lead_status === "qualified");
  const sellerUsers = tenantUsers.filter((user) => user.role === "operator");
  const hasOperationalData = tenantLinks.length > 0 || tenantLeads.length > 0;
  const needsOperationalOnboarding = Boolean(tenant && !loading && !hasOperationalData);
  const qualityRows = useMemo(() => buildQualityRows(tenantLeads, tenantMetaCampaigns), [tenantLeads, tenantMetaCampaigns]);
  const tenantSummary = tenantSummaries.find((item) => item.tenant_id === tenant?.id);
  const currentTenantUser = tenantUsers.find((user) =>
    (currentUserId && user.user_id === currentUserId) ||
    (currentUserEmail && user.email?.toLowerCase() === currentUserEmail.toLowerCase()),
  );
  const currentTenantRole = currentTenantUser?.role ?? (isPlatformUser ? "owner" : null);
  const isSellerExperience = currentTenantRole === "operator" && !isPlatformUser;
  const secondaryMobileSections: Section[] = isSellerExperience ? ["leads"] : ["integrations", "whatsapp", "leads", "clients", "users", "reports", "capi", "settings", "follow-ups", "segments", "google-ads"];
  const moreActive = secondaryMobileSections.includes(active);

  function goToSection(section: Section) {
    setActive(section);
    setMobileMenuOpen(false);
  }

  async function copyTenantAccessUrl() {
    if (!tenant?.slug) return;
    await navigator.clipboard.writeText(tenantAccessUrl(tenant.slug));
    setToast("Link de acesso da empresa copiado.");
  }

  function focusCrmLead(lead: Lead) {
    setActive("crm");
    setCrmFilter("all");
    setCrmSearch(lead.ref || lead.customer_phone || lead.customer_email || "");
    setToast(`Lead ${lead.ref} destacado no CRM.`);
  }

  const followUpLeads = useMemo(() => {
    const now = Date.now();
    return tenantLeads
      .filter((lead) => {
        if (!isOpenLead(lead)) return false;
        if (followUpFilter === "due") return leadFollowUpDue(lead) || lead.lead_status === "new";
        if (followUpFilter === "overdue") return leadFollowUpDue(lead);
        if (followUpFilter === "upcoming") {
          if (!lead.next_follow_up_at) return false;
          const t = new Date(lead.next_follow_up_at).getTime();
          return Number.isFinite(t) && t > now;
        }
        return true;
      })
      .sort((a, b) => {
        const aTime = a.next_follow_up_at ? new Date(a.next_follow_up_at).getTime() : Infinity;
        const bTime = b.next_follow_up_at ? new Date(b.next_follow_up_at).getTime() : Infinity;
        const aDue = Number.isFinite(aTime) && aTime <= now ? 0 : 1;
        const bDue = Number.isFinite(bTime) && bTime <= now ? 0 : 1;
        if (aDue !== bDue) return aDue - bDue;
        return aTime - bTime;
      });
  }, [tenantLeads, followUpFilter]);

  const overdueCount = useMemo(() => tenantLeads.filter((l) => leadFollowUpDue(l)).length, [tenantLeads]);
  const dueNowCount = useMemo(() => tenantLeads.filter((l) => isOpenLead(l) && (leadFollowUpDue(l) || l.lead_status === "new")).length, [tenantLeads]);

  const allSegmentTags = useMemo(() => {
    const set = new Set<string>();
    for (const lead of tenantLeads) {
      if (lead.tags) lead.tags.forEach((t) => set.add(t));
    }
    return Array.from(set).sort();
  }, [tenantLeads]);

  const segmentedLeads = useMemo(() => {
    if (segmentFilter === "all") return tenantLeads;
    if (segmentFilter === "no_phone") return tenantLeads.filter((l) => !l.customer_phone);
    if (segmentFilter === "repeat") return tenantLeads.filter((l) => l.lead_status === "sold" && (l.tags?.includes("repeat") || false));
    if (segmentFilter === "high_value") return tenantLeads.filter((l) => l.lead_status === "sold" && (l.revenue ?? 0) > 0);
    if (segmentFilter.startsWith("status:")) {
      const s = segmentFilter.replace("status:", "") as LeadStatus;
      return tenantLeads.filter((l) => l.lead_status === s);
    }
    if (segmentFilter.startsWith("source:")) {
      const src = segmentFilter.replace("source:", "");
      return tenantLeads.filter((l) => l.utm_source === src);
    }
    if (segmentFilter.startsWith("campaign:")) {
      const c = segmentFilter.replace("campaign:", "");
      return tenantLeads.filter((l) => l.utm_campaign === c);
    }
    if (segmentFilter.startsWith("tag:")) {
      const tag = segmentFilter.replace("tag:", "");
      return tenantLeads.filter((l) => l.tags?.includes(tag));
    }
    return tenantLeads;
  }, [tenantLeads, segmentFilter]);

  const allSources = useMemo(() => {
    const set = new Set<string>();
    for (const l of tenantLeads) if (l.utm_source) set.add(l.utm_source);
    return Array.from(set).sort();
  }, [tenantLeads]);

  const allCampaigns = useMemo(() => {
    const set = new Set<string>();
    for (const l of tenantLeads) if (l.utm_campaign) set.add(l.utm_campaign);
    return Array.from(set).sort();
  }, [tenantLeads]);

  async function addTagToLead(leadRef: string, tag: string) {
    if (!tenant || !isConfigured || !supabase) return;
    setSegmentBusy(leadRef);
    try {
      await authFetch("crm", {
        method: "POST",
        body: JSON.stringify({ action: "add_tag", ref: leadRef, tag }),
      });
      await loadTenantData();
      setToast(`Tag "${tag}" adicionada.`);
    } catch { setToast("Erro ao adicionar tag."); }
    setSegmentBusy("");
  }

  async function removeTagFromLead(leadRef: string, tag: string) {
    if (!tenant || !isConfigured || !supabase) return;
    setSegmentBusy(leadRef);
    try {
      await authFetch("crm", {
        method: "POST",
        body: JSON.stringify({ action: "remove_tag", ref: leadRef, tag }),
      });
      await loadTenantData();
      setToast(`Tag "${tag}" removida.`);
    } catch { setToast("Erro ao remover tag."); }
    setSegmentBusy("");
  }

  async function createCloudApiInstance() {
    if (!tenant || !waCloudPhoneId.trim() || !waCloudToken.trim()) {
      setToast("Informe o Phone Number ID e o Access Token.");
      return;
    }
    setWaCloudBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "manage_whatsapp_instance",
          sub_action: "create",
          tenant_id: tenant.id,
          instance_name: `cloud-${waCloudPhoneId.trim().slice(-6)}`,
          provider: "cloud_api",
          metadata: {
            phone_number_id: waCloudPhoneId.trim(),
            waba_id: waCloudWabaId.trim() || undefined,
            verify_token: waCloudVerifyToken.trim() || undefined,
          },
          api_key: waCloudToken.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setWaCloudPhoneId("");
        setWaCloudWabaId("");
        setWaCloudToken("");
        setWaCloudVerifyToken("");
        setToast("Instância Cloud API criada com sucesso.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao criar instância Cloud API.");
      }
    } catch { setToast("Erro ao criar instância Cloud API."); }
    setWaCloudBusy(false);
  }

  const metrics = useMemo(() => {
    const clicks = tenantLinks.reduce((sum, link) => sum + Number(link.clicks ?? 0), 0);
    const sales = tenantLeads.filter((lead) => lead.lead_status === "sold").length ||
      tenantLinks.reduce((sum, link) => sum + Number(link.sales ?? 0), 0);
    const revenue = tenantLeads.reduce((sum, lead) => sum + Number(lead.revenue ?? 0), 0) ||
      tenantLinks.reduce((sum, link) => sum + Number(link.revenue ?? 0), 0);
    const waiting = tenantLeads.filter((lead) => lead.lead_status === "new").length;
    const conversion = clicks ? (sales / clicks) * 100 : 0;
    return { clicks, sales, revenue, waiting, conversion };
  }, [tenantLeads, tenantLinks]);

  const crmVisibleLeads = useMemo(() => {
    const q = crmSearch.trim().toLowerCase();
    const now = Date.now();
    return tenantLeads.filter((lead) => {
      const hasIdentifier = Boolean(lead.customer_phone || lead.customer_email);
      const followUpAt = lead.next_follow_up_at ? new Date(lead.next_follow_up_at).getTime() : 0;
      const followUpDue = Boolean(followUpAt && followUpAt <= now && !["sold", "lost", "bad"].includes(lead.lead_status));
      const statusMatches =
        crmFilter === "all" ||
        lead.lead_status === crmFilter ||
        (crmFilter === "needs_follow_up" && followUpDue) ||
        (crmFilter === "no_identifier" && !hasIdentifier);

      if (!statusMatches) return false;
      if (!q) return true;

      return [
        lead.ref,
        lead.customer_name,
        lead.customer_phone,
        lead.customer_email,
        lead.offer_name,
        lead.link_name,
        lead.utm_source,
        lead.utm_campaign,
        lead.utm_content,
      ].some((value) => String(value ?? "").toLowerCase().includes(q));
    });
  }, [crmFilter, crmSearch, tenantLeads]);

  const salesVisibleLeads = useMemo(() => {
    const q = salesSearch.trim().toLowerCase();
    const openLeads = tenantLeads.filter((lead) => {
      if (salesFilter === "now") return isOpenLead(lead);
      return lead.lead_status === salesFilter;
    });
    const searched = q
      ? openLeads.filter((lead) => [
        lead.ref,
        lead.customer_name,
        lead.customer_phone,
        lead.customer_email,
        lead.offer_name,
        lead.link_name,
        lead.utm_campaign,
        lead.utm_content,
      ].some((value) => String(value ?? "").toLowerCase().includes(q)))
      : openLeads;
    return sortSalesQueue(searched);
  }, [salesFilter, salesSearch, tenantLeads]);

  const selectedSalesLead = salesVisibleLeads.find((lead) => lead.id === salesSelectedLeadId) ?? salesVisibleLeads[0] ?? null;
  const salesStats = useMemo(() => ({
    now: tenantLeads.filter(isOpenLead).length,
    due: tenantLeads.filter(leadFollowUpDue).length,
    qualified: tenantLeads.filter((lead) => lead.lead_status === "qualified").length,
    sold: tenantLeads.filter((lead) => lead.lead_status === "sold").length,
  }), [tenantLeads]);

  const operationalChecklist: ReadinessItem[] = useMemo(() => {
    const hasUtmReadyLink = tenantLinks.some((link) => link.default_utm_source && link.default_utm_medium && link.default_utm_campaign);
    const qualifiedAudience = metaAudiences.find((audience) => audience.audience_key === "qualified");
    const purchasedAudience = metaAudiences.find((audience) => audience.audience_key === "purchased");
    const metaAdAccountReady = tenantMetaCampaigns.length > 0 || metaAudiences.some((audience) => audience.ad_account_id);
    const anyCapiSignal = health.total_events > 0 || events.length > 0;

    return [
      {
        title: "Empresa",
        detail: tenant?.whatsapp_number ? `${tenant.name} · ${tenant.whatsapp_number}` : "WhatsApp com DDI/DDD pendente",
        done: Boolean(tenant?.id && tenant?.whatsapp_number),
        section: "settings",
      },
      {
        title: "Perfil operacional",
        detail: onboarding?.business_segment && onboarding?.city
          ? `${onboarding.business_segment} · ${onboarding.city}${onboarding.state ? `/${onboarding.state}` : ""}`
          : "Segmento, cidade e responsável ainda precisam ser preenchidos",
        done: Boolean(onboarding?.business_segment && onboarding?.city && onboarding?.responsible_name),
        section: "settings",
      },
      {
        title: "Smart Link com UTM",
        detail: tenantLinks.length ? `${tenantLinks.length} link(s), ${hasUtmReadyLink ? "UTM pronta" : "UTM incompleta"}` : "Nenhum link real criado",
        done: tenantLinks.length > 0 && hasUtmReadyLink,
        section: "links",
      },
      {
        title: "Primeiro clique real",
        detail: tenantLeads.length ? `${tenantLeads.length} atendimento(s) capturado(s)` : "O lead aparece somente depois de clique real no Smart Link",
        done: tenantLeads.length > 0,
        section: "links",
      },
      {
        title: "Meta CAPI",
        detail: anyCapiSignal ? `${health.successful_events}/${health.total_events} evento(s) OK nos últimos 7 dias` : "Pixel ID + Token CAPI ainda sem evento real",
        done: Boolean(onboarding?.meta_connected || anyCapiSignal),
        section: "integrations",
      },
      {
        title: "Conta Meta Ads",
        detail: metaAdAccountReady ? `${tenantMetaCampaigns.length} linha(s) de campanha/gasto` : "Conecte Facebook Login e selecione a conta de anúncios",
        done: metaAdAccountReady,
        section: "integrations",
      },
      {
        title: "Públicos automáticos",
        detail: qualifiedAudience?.meta_audience_id && purchasedAudience?.meta_audience_id
          ? "Qualificados e compradores criados no Meta"
          : "Faltam público de qualificados ou compradores",
        done: Boolean(qualifiedAudience?.meta_audience_id && purchasedAudience?.meta_audience_id),
        section: "crm",
      },
      {
        title: "CRM em operação",
        detail: tenantCrmActivities.length ? `${tenantCrmActivities.length} movimento(s) no CRM` : "Nenhum lead movimentado no pipeline",
        done: tenantCrmActivities.length > 0,
        section: "crm",
      },
      {
        title: "Stakeholders",
        detail: tenantUsers.length ? `${tenantUsers.length} usuário(s) vinculado(s)` : "Inclua dono, atendente ou visualizador",
        done: tenantUsers.length > 0,
        section: "users",
      },
    ];
  }, [events.length, health.successful_events, health.total_events, metaAudiences, onboarding, tenant, tenantCrmActivities.length, tenantLeads.length, tenantLinks, tenantMetaCampaigns.length, tenantUsers.length]);

  const executiveInsights = useMemo(() => buildExecutiveInsights(qualityRows, operationalChecklist, health, metaAudiences), [health, metaAudiences, operationalChecklist, qualityRows]);

  useEffect(() => {
    if (!isConfigured || !supabase) return;

    async function boot() {
      const { data } = await supabase!.auth.getSession();
      if (data.session) {
        setSignedIn(true);
        await loadInitialData();
      } else {
        setSignedIn(false);
      }
      setSessionReady(true);
    }

    boot();
  }, [isConfigured]);

  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get("section") as Section | null;
    if (section && validSections.includes(section)) {
      setActive(section);
    }
  }, []);

  // Volta do Facebook Login: avisa o resultado e, se conectou, já busca as
  // contas e sincroniza as campanhas da empresa.
  useEffect(() => {
    if (!metaReturn || !tenant?.id) return;
    const result = metaReturn;
    setMetaReturn(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("meta");
    window.history.replaceState(null, "", url.toString());
    setActive("integrations");
    setToast(META_RETURN_MESSAGES[result] ?? META_RETURN_MESSAGES.error);
    if (result === "connected" || result === "no_ad_accounts") {
      void (async () => {
        await loadTenantData(tenant.id);
        await loadMetaAssets();
        if (result === "connected") await syncMetaInsights();
      })();
    }
  }, [metaReturn, tenant?.id]);

  useEffect(() => {
    if (!isSellerExperience || requestedSection) return;
    if (["dashboard", "links", "integrations", "clients", "users", "reports", "capi", "settings"].includes(active)) {
      setActive("sales");
    }
  }, [active, isSellerExperience, requestedSection]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!tenant) return;
    setProfileDraft({
      name: tenant.name ?? "",
      slug: tenant.slug ?? "",
      whatsapp: tenant.whatsapp_number ?? "",
      businessSegment: onboarding?.business_segment ?? "",
      city: onboarding?.city ?? "",
      state: onboarding?.state ?? "",
      monthlyGoal: onboarding?.monthly_goal ? String(onboarding.monthly_goal) : "",
      averageTicket: onboarding?.average_ticket ? String(onboarding.average_ticket) : "",
      primaryChannel: onboarding?.primary_channel ?? "",
      responsibleName: onboarding?.responsible_name ?? "",
    });
  }, [tenant?.id, onboarding]);

  async function login() {
    if (!supabase) return;
    const normalizedEmail = email.trim().toLowerCase();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error) {
      setLoading(false);
      setToast(error.message);
      return;
    }
    setSignedIn(true);
    setAccessLinkEmail("");
    await loadInitialData();
  }

  async function sendAccessLink() {
    if (!supabase) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setToast("Informe o email para receber o link de acesso.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: authRedirectTo(),
        shouldCreateUser: false,
      },
    });
    setLoading(false);

    if (error) {
      setToast(error.message);
      return;
    }

    setAccessLinkEmail(normalizedEmail);
    setToast("Enviamos um link seguro para acessar.");
  }

  async function signup() {
    if (!supabase) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || password.length < 6) {
      setToast("Informe email e senha com pelo menos 6 caracteres.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        emailRedirectTo: authRedirectTo(),
      },
    });

    if (error) {
      setLoading(false);
      setToast(error.message);
      return;
    }

    if (data.session) {
      setSignedIn(true);
      setConfirmationEmail("");
      await loadInitialData();
      return;
    }

    setLoading(false);
    setConfirmationEmail(normalizedEmail);
    setPassword("");
    setAuthMode("login");
    setToast("Enviamos o email de confirmação. Abra o link para ativar o acesso.");
  }

  async function resendConfirmationEmail() {
    if (!supabase) return;
    const targetEmail = (confirmationEmail || email).trim().toLowerCase();
    if (!targetEmail) {
      setToast("Informe o email para reenviar a confirmação.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: targetEmail,
      options: {
        emailRedirectTo: authRedirectTo(),
      },
    });
    setLoading(false);

    if (error) {
      setToast(error.message);
      return;
    }

    setConfirmationEmail(targetEmail);
    setToast("Email de confirmação reenviado.");
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    setSignedIn(false);
    setCurrentUserId("");
    setCurrentUserEmail("");
    setTenantSetupRequired(false);
    setOnboarding(null);
    setPlatformRole(null);
    setTenantSummaries([]);
  }

  async function authFetch(path: string, options: RequestInit = {}) {
    if (!supabase) throw new Error("Supabase não configurado");
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("Sessao expirada");
    return fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        ...(options.headers ?? {}),
      },
    });
  }

  async function loadInitialData() {
    if (!supabase) return;
    setLoading(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setLoading(false);
      return;
    }

    setCurrentUserId(session.user.id);
    setCurrentUserEmail(session.user.email?.toLowerCase() ?? "");

    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({ action: "bootstrap" }),
    });
    const data = await res.json();

    if (!res.ok) {
      setToast(data.error || "Erro ao carregar acesso.");
      setLoading(false);
      return;
    }

    const loadedTenants = (data.tenants ?? []) as Tenant[];
    setPlatformRole((data.platform_role ?? null) as PlatformRole | null);
    setTenantSummaries((data.tenant_summaries ?? []) as TenantSummary[]);

    if (!loadedTenants.length && data.platform_role) {
      setTenants([]);
      setTenantId("");
      setOnboarding(null);
      setTenantSetupRequired(false);
      setActive("clients");
      setToast("Gestor IDX ativo. Cadastre o primeiro cliente com dados reais.");
      setLoading(false);
      return;
    }

    if (!loadedTenants.length) {
      setTenants([]);
      setTenantId("");
      setOnboarding(null);
      setTenantSetupRequired(true);
      setActive("clients");
      setToast("Crie a primeira empresa para iniciar o painel.");
      setLoading(false);
      return;
    }

    setTenantSetupRequired(false);
    setTenants(loadedTenants);
    const routeTenant = requestedTenantSlug ? loadedTenants.find((item) => item.slug === requestedTenantSlug) : null;
    if (requestedTenantSlug && !routeTenant) {
      setTenantRouteWarning(`O login atual não tem acesso à empresa /${requestedTenantSlug} ou ela ainda não existe.`);
    } else {
      setTenantRouteWarning("");
    }
    const currentTenant = routeTenant ?? loadedTenants.find((item) => item.id === tenantId) ?? loadedTenants[0];
    setTenantId(currentTenant.id);
    await loadTenantData(currentTenant.id);
    setLoading(false);
  }

  async function loadTenantData(nextTenantId = tenantId) {
    if (!supabase || !nextTenantId) return;
    const [offerRes, linkRes, leadRes, eventRes, activityRes, userRes, healthRes, metaRoiRes, audienceRes, onboardingRes] = await Promise.all([
      supabase.from("offers").select("*").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }),
      supabase.from("vw_smart_link_performance").select("*").eq("tenant_id", nextTenantId),
      supabase.from("vw_lead_queue").select("*").eq("tenant_id", nextTenantId).order("clicked_at", { ascending: false }).limit(100),
      supabase.from("capi_events").select("event_name, ok, status_code, error_message, created_at").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }).limit(40),
      supabase.from("crm_activities").select("*").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }).limit(80),
      supabase.from("tenant_users").select("id, tenant_id, user_id, email, role, status, created_at").eq("tenant_id", nextTenantId).order("created_at", { ascending: true }),
      supabase.from("vw_capi_health").select("*").eq("tenant_id", nextTenantId).maybeSingle(),
      supabase.from("vw_meta_campaign_roi").select("*").eq("tenant_id", nextTenantId).order("spend", { ascending: false }).limit(100),
      supabase.from("vw_meta_audience_status").select("*").eq("tenant_id", nextTenantId).order("audience_key", { ascending: true }),
      supabase.from("tenant_onboarding").select("*").eq("tenant_id", nextTenantId).maybeSingle(),
    ]);

    if (offerRes.data) setOffers(offerRes.data as Offer[]);
    if (linkRes.data) setLinks(linkRes.data as SmartLink[]);
    if (leadRes.data) setLeads(leadRes.data as Lead[]);
    if (eventRes.data) setEvents(eventRes.data as CapiEvent[]);
    if (activityRes.data) setCrmActivities(activityRes.data as CrmActivity[]);
    if (userRes.data) setTenantUsers(userRes.data as TenantUser[]);
    if (healthRes.data) setHealth(healthRes.data as CapiHealth);
    if (metaRoiRes.data) setMetaCampaigns(metaRoiRes.data as MetaCampaignRoi[]);
    if (audienceRes.data) setMetaAudiences(audienceRes.data as MetaAudienceStatus[]);
    setOnboarding((onboardingRes.data as TenantOnboarding | null) ?? null);
  }

  async function createSmartLink() {
    if (!tenant || !draft.offerName.trim()) {
      setToast("Informe a oferta.");
      return;
    }

    const source = draft.source.trim();
    const medium = draft.medium.trim();
    const campaign = draft.campaign.trim();
    const content = draft.content.trim();
    const term = draft.term.trim();
    if (!source || !medium || !campaign) {
      setToast("Informe as UTMs obrigatórias: fonte, mídia e campanha.");
      return;
    }

    const offerSlug = slugify(draft.offerName);
    const campaignSlug = slugify(campaign) || "campanha";
    const code = linkCode(`${tenant.slug}-${offerSlug}-${campaignSlug}`);
    const price = draft.price ? Number(draft.price.replace(",", ".")) : null;
    const linkName = draft.linkName.trim() || `${draft.offerName} - ${campaign}`;

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para criar Smart Links reais.");
      return;
    }

    setLoading(true);
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .insert({
        tenant_id: tenant.id,
        name: draft.offerName,
        slug: offerSlug,
        category: draft.category || null,
        price,
        default_message: draft.message,
      })
      .select("*")
      .single();

    if (offerError) {
      setToast(offerError.message);
      setLoading(false);
      return;
    }

    const { error: linkError } = await supabase.from("smart_links").insert({
      tenant_id: tenant.id,
      offer_id: offer.id,
      code,
      name: linkName,
      message_template: draft.message,
      default_utm_source: source,
      default_utm_medium: medium,
      default_utm_campaign: campaign,
      default_utm_content: content || null,
      default_utm_term: term || null,
    });

    setLoading(false);
    if (linkError) {
      setToast(linkError.message);
      return;
    }

    setDraft(emptyDraft);
    setToast("Smart Link criado.");
    await loadTenantData();
  }

  async function copyLink(link: SmartLink) {
    await navigator.clipboard.writeText(smartLinkWithUtms(link));
    setToast("Link copiado.");
  }

  async function confirmSale() {
    const ref = saleRef.trim().toLowerCase();
    const revenue = moneyInputToNumber(saleRevenue);
    if (!salePhone.trim() || !Number.isFinite(revenue) || revenue <= 0) {
      setToast("Informe telefone e valor. O ref é opcional.");
      return;
    }

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para confirmar vendas reais.");
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        action: "purchase",
        tenant_id: tenant?.id,
        ref: ref || undefined,
        customer_name: saleName || undefined,
        customer_phone: salePhone,
        revenue,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      setToast(body.error || "Erro ao confirmar venda.");
      return;
    }

    setToast(body.capi_ok ? "Venda confirmada e enviada ao Meta." : "Venda confirmada. CAPI sem credencial ou com erro.");
    setSaleRef("");
    setSaleName("");
    setSalePhone("");
    setSaleRevenue("");
    await loadTenantData();
  }

  async function updateCrmStage(lead: Lead, status: LeadStatus) {
    const note = (crmNotes[lead.id] ?? "").trim();
    const contact = crmContacts[lead.id] ?? { phone: "", email: "", name: "" };
    const saleValue = moneyInputToNumber(crmRevenue[lead.id] ?? String(lead.revenue ?? ""));
    const followUpValue = crmFollowUps[lead.id];
    const typedPhone = cleanPhone(contact.phone);
    const savedPhone = cleanPhone(lead.customer_phone);
    const duplicateLead = typedPhone && typedPhone !== savedPhone ? duplicateContactLead(lead, contact, tenantLeads) : null;

    if (duplicateLead) {
      setCrmFilter("all");
      setCrmSearch(duplicateLead.ref);
      setToast(`Telefone já existe no lead ${duplicateLead.ref}. Abra o lead existente antes de salvar.`);
      return;
    }

    if (["qualified", "sold"].includes(status) && contactWasEdited(lead, contact)) {
      const confirmed = window.confirm(
        "Você alterou nome, telefone ou email deste lead. Confirme apenas se estes dados pertencem exatamente a esta conversa; isso será usado no Meta CAPI e nas audiências.",
      );
      if (!confirmed) return;
    }

    if (status === "sold" && (!Number.isFinite(saleValue) || saleValue <= 0)) {
      setToast("Informe o valor da venda no card do lead.");
      return;
    }

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para atualizar o CRM real.");
      return;
    }

    setCrmBusyRef(lead.ref);
    const res = await authFetch("crm", {
      method: "POST",
      body: JSON.stringify({
        action: "update_stage",
        ref: lead.ref,
        status,
        note: note || undefined,
        customer_phone: contact.phone || undefined,
        customer_email: contact.email || undefined,
        customer_name: contact.name || undefined,
        next_follow_up_at: followUpValue === undefined ? undefined : localDateTimeToIso(followUpValue),
        revenue: status === "sold" ? saleValue : undefined,
      }),
    });
    const data = await res.json();
    setCrmBusyRef("");
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao atualizar CRM.");
    setCrmNotes((items) => ({ ...items, [lead.id]: "" }));
    setCrmContacts((items) => ({ ...items, [lead.id]: { phone: "", email: "", name: "" } }));
    setCrmFollowUps((items) => {
      const next = { ...items };
      delete next[lead.id];
      return next;
    });
    if (status === "sold") setCrmRevenue((items) => ({ ...items, [lead.id]: "" }));
    setToast(crmUpdateToast(data, status));
    await loadTenantData();
  }

  async function createClient() {
    if (!clientDraft.name.trim() || !clientDraft.businessSegment.trim() || !clientDraft.whatsapp.trim()) {
      setToast("Informe nome, segmento e WhatsApp.");
      return;
    }

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para criar empresas reais.");
      return;
    }

    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "create_tenant",
        name: clientDraft.name,
        slug: clientDraft.slug,
        whatsapp_number: clientDraft.whatsapp,
        business_segment: clientDraft.businessSegment,
        city: clientDraft.city,
        state: clientDraft.state,
        monthly_goal: clientDraft.monthlyGoal,
        average_ticket: clientDraft.averageTicket,
        primary_channel: clientDraft.primaryChannel,
        responsible_name: clientDraft.responsibleName,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao criar cliente.");
    setTenants((items) => [data.tenant, ...items]);
    setTenantId(data.tenant.id);
    setPlatformRole((data.platform_role ?? platformRole) as PlatformRole | null);
    setTenantSetupRequired(false);
    setClientDraft(emptyClientDraft);
    setToast("Cliente criado.");
    await loadInitialData();
    await loadTenantData(data.tenant.id);
  }

  async function saveTenantProfile() {
    if (!tenant || !profileDraft.name.trim() || !profileDraft.businessSegment.trim() || !profileDraft.whatsapp.trim()) {
      setToast("Informe nome, segmento e WhatsApp.");
      return;
    }

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para atualizar empresas reais.");
      return;
    }

    setLoading(true);
    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "update_tenant_profile",
        tenant_id: tenant.id,
        name: profileDraft.name,
        slug: profileDraft.slug,
        whatsapp_number: profileDraft.whatsapp,
        business_segment: profileDraft.businessSegment,
        city: profileDraft.city,
        state: profileDraft.state,
        monthly_goal: profileDraft.monthlyGoal,
        average_ticket: profileDraft.averageTicket,
        primary_channel: profileDraft.primaryChannel,
        responsible_name: profileDraft.responsibleName,
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao atualizar empresa.");
    setTenants((items) => items.map((item) => (item.id === data.tenant.id ? data.tenant : item)));
    setToast("Empresa atualizada.");
    await loadTenantData(data.tenant.id);
  }

  async function inviteUser(options?: { email?: string; role?: InviteDraft["role"]; successMessage?: string }) {
    const email = (options?.email ?? inviteDraft.email).trim();
    const role = options?.role ?? inviteDraft.role;

    if (!tenant || !email) {
      setToast(role === "operator" ? "Informe o email do vendedor." : "Informe o email do usuário.");
      return;
    }

    if (!isConfigured || !supabase) {
      if (role === "operator") setSellerInviteEmail("");
      else setInviteDraft(emptyInviteDraft);
      setToast("Configure o Supabase para enviar convites reais.");
      return;
    }

    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "invite_user",
        tenant_id: tenant.id,
        email,
        role,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setToast(data.error || "Erro ao convidar usuário.");
    if (role === "operator") setSellerInviteEmail("");
    else setInviteDraft(emptyInviteDraft);
    setToast(data.already_active ? "Este vendedor já tinha acesso ativo. Ele pode entrar por senha ou link no email." : (options?.successMessage ?? "Convite enviado por email."));
    await loadTenantData();
  }

  async function startMetaLogin() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para conectar o Facebook.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("meta-oauth", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant.id,
        redirect_to: `${window.location.origin}${window.location.pathname}?section=integrations`,
      }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao iniciar Facebook Login.");
    window.location.href = data.auth_url;
  }

  async function copyMetaCallbackUrl() {
    await navigator.clipboard.writeText(META_OAUTH_CALLBACK_URL);
    setToast("URL de retorno copiada.");
  }

  async function loadMetaAssets() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para buscar ativos Meta.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch(`meta-assets?tenant_id=${tenant.id}`, { method: "GET" });
    const data = await res.json();
    setIntegrationBusy(false);
    setMetaAssetsLoaded(true);

    if (!res.ok) {
      setMetaAdAccounts([]);
      setToast(humanError(data.error) || "Erro ao buscar ativos Meta.");
      return;
    }

    const accounts = (data.ad_accounts ?? []) as MetaAdAccountAsset[];
    setMetaAdAccounts(accounts);

    const selectedAccountId = String(data.selected_ad_account_id ?? "");
    const selectedPixelId = String(data.selected_pixel_id ?? "");
    if (selectedAccountId) {
      setAdAccountId(selectedAccountId);
      setSelectedMetaAsset(metaAssetValue(selectedAccountId, selectedPixelId));
    } else if (accounts.length) {
      const first = accounts[0];
      const firstPixel = accountPixels(first)[0];
      setSelectedMetaAsset(metaAssetValue(first.id, firstPixel?.id ?? ""));
    }

    setToast(accounts.length ? `${accounts.length} conta(s) Meta encontradas.` : "Nenhuma conta Meta encontrada.");
  }

  async function saveMetaAssetSelection() {
    if (!tenant) return;
    const [selectedAccountId, selectedPixelId] = selectedMetaAsset.split("|");
    const account = metaAdAccounts.find((item) => item.id === selectedAccountId);
    const pixel = account ? accountPixels(account).find((item) => item.id === selectedPixelId) : null;
    const manualAdAccountId = normalizeActId(adAccountId);
    const adAccountToSave = account?.id || manualAdAccountId;

    if (!adAccountToSave) {
      setToast("Selecione ou informe uma conta de anúncios.");
      return;
    }

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para salvar ativos Meta.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("meta-assets", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant.id,
        ad_account_id: adAccountToSave,
        ad_account_name: account?.name ?? null,
        pixel_id: pixel?.id ?? undefined,
        pixel_name: pixel?.name ?? null,
      }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao salvar ativos Meta.");

    setAdAccountId(String(data.selected_ad_account_id ?? adAccountToSave));
    setToast("Conta Meta salva para campanhas e públicos.");
    await loadTenantData();
  }

  async function saveMetaManual() {
    if (!tenant || !metaDraft.pixelId.trim() || !metaDraft.accessToken.trim()) {
      setToast("Informe Pixel ID e token CAPI.");
      return;
    }

    if (!isConfigured || !supabase) {
      setMetaDraft(emptyMetaDraft);
      setToast("Configure o Supabase para salvar integrações reais.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "save_meta_manual",
        tenant_id: tenant.id,
        pixel_id: metaDraft.pixelId,
        access_token: metaDraft.accessToken,
        test_event_code: metaDraft.testEventCode || null,
      }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(data.error || "Erro ao salvar Meta.");
    setMetaDraft(emptyMetaDraft);
    setToast("Meta conectado.");
    await loadTenantData();
  }

  async function testCapi() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para testar CAPI real.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("capi-health", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenant.id }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(data.error || "CAPI com erro.");
    setToast(data.ok ? "Evento de teste enviado ao Meta." : "Meta respondeu com erro.");
    await loadTenantData();
  }

  async function syncMetaInsights() {
    if (!tenant) return;

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para sincronizar gastos reais.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("meta-insights", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant.id,
        ad_account_id: adAccountId || undefined,
        days: 30,
      }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(data.error || "Erro ao sincronizar gastos Meta.");
    setMetaCampaigns(data.campaigns ?? []);
    setToast(`${data.synced ?? 0} linhas de campanhas sincronizadas.`);
  }

  // Volta do Google OAuth (Google Ads).
  const [googleReturn, setGoogleReturn] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    return result ? { result, reason: params.get("reason") ?? "" } : null;
  });

  useEffect(() => {
    if (!googleReturn || !tenant?.id) return;
    const { result, reason } = googleReturn;
    setGoogleReturn(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("google");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", url.toString());
    setActive("google-ads");
    if (result === "error") {
      setToast(GOOGLE_RETURN_MESSAGES[reason] ?? `${GOOGLE_RETURN_MESSAGES.error}${reason ? ` (${reason})` : ""}`);
      return;
    }
    // "authorized" com motivo: Google autorizado, mas a parte do Google Ads falhou.
    setToast(result === "authorized" && reason ? googleAdsMessage(reason) : (GOOGLE_RETURN_MESSAGES[result] ?? GOOGLE_RETURN_MESSAGES.error));
    void (async () => {
      const creds = await loadGoogleAdsData();
      if (result === "connected" && creds?.customer_id) await syncGoogleAds();
      if (result === "select_account") await listGoogleCustomers();
    })();
  }, [googleReturn, tenant?.id]);

  async function loadGoogleAdsData(): Promise<GoogleCredentials | null> {
    if (!tenant || !isConfigured || !supabase) return null;
    setGoogleBusy(true);
    const res = await authFetch(`google-ads?tenant_id=${tenant.id}`, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    setGoogleBusy(false);
    if (!res.ok) return null;
    const creds = (data.credentials ?? null) as GoogleCredentials | null;
    setGoogleCreds(creds);
    setGoogleCampaigns(data.campaigns ?? []);
    setGoogleDevTokenOk(data.developer_token_configured !== false);
    return creds;
  }

  async function startGoogleLogin() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para conectar o Google Ads.");
      return;
    }
    setGoogleBusy(true);
    const res = await authFetch("google-oauth", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant.id,
        redirect_to: `${window.location.origin}${window.location.pathname}?section=google-ads`,
      }),
    });
    const data = await res.json();
    setGoogleBusy(false);
    if (!res.ok) return setToast(humanError(data.error) || "Erro ao iniciar Google Login.");
    window.location.href = data.auth_url;
  }

  async function syncGoogleAds() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para sincronizar campanhas Google.");
      return;
    }
    setGoogleBusy(true);
    const res = await authFetch("google-ads", {
      method: "POST",
      body: JSON.stringify({
        action: "sync_campaigns",
        tenant_id: tenant.id,
        days: googleSyncDays,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setGoogleBusy(false);
    if (!res.ok) {
      setToast(googleAdsMessage(data.error, "Erro ao sincronizar Google Ads."));
      await loadGoogleAdsData();
      return;
    }
    setGoogleCampaigns(data.campaigns ?? []);
    if (!data.campaigns_in_account) setToast("Sincronizado: a conta do Google Ads não tem campanhas.");
    else if (!data.synced) setToast(`Sincronizado: ${data.campaigns_in_account} campanha(s) na conta, nenhuma com dados nos últimos ${googleSyncDays} dias.`);
    else setToast(`${data.campaigns_with_data} campanha(s) com dados importadas (${data.synced} linhas diárias).`);
    await loadGoogleAdsData();
  }

  async function listGoogleCustomers() {
    if (!tenant) return;
    if (!isConfigured || !supabase) return;
    setGoogleBusy(true);
    const res = await authFetch("google-ads", {
      method: "POST",
      body: JSON.stringify({ action: "list_customers", tenant_id: tenant.id }),
    });
    const data = await res.json().catch(() => ({}));
    setGoogleBusy(false);
    if (!res.ok) {
      setToast(googleAdsMessage(data.error, "Erro ao listar contas Google Ads."));
      await loadGoogleAdsData();
      return;
    }
    const customers = (data.customers ?? []) as GoogleCustomer[];
    setGoogleCustomers(customers);
    if (!customers.length) setToast(googleAdsMessage("no_ads_accounts"));
  }

  async function selectGoogleCustomer(customer: GoogleCustomer) {
    if (!tenant) return;
    setGoogleBusy(true);
    const res = await authFetch("google-ads", {
      method: "POST",
      body: JSON.stringify({
        action: "select_customer",
        tenant_id: tenant.id,
        customer_id: customer.id,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setGoogleBusy(false);
    if (!res.ok) return setToast(googleAdsMessage(data.error, "Erro ao vincular a conta."));
    setGoogleCustomers([]);
    setToast(`Conta ${customer.name} vinculada. Importando campanhas...`);
    await loadGoogleAdsData();
    await syncGoogleAds();
  }

  async function disconnectGoogle() {
    if (!tenant) return;
    setGoogleBusy(true);
    const res = await authFetch("google-ads", {
      method: "POST",
      body: JSON.stringify({ action: "disconnect", tenant_id: tenant.id }),
    });
    await res.json();
    setGoogleBusy(false);
    setGoogleCreds(null);
    setGoogleCampaigns([]);
    setGoogleCustomers([]);
    setToast("Google Ads desconectado.");
  }

  async function syncMetaAudiences() {
    if (!tenant) return;

    if (!isConfigured || !supabase) {
      setToast("Configure o Supabase para sincronizar públicos reais.");
      return;
    }

    setIntegrationBusy(true);
    const res = await authFetch("meta-audiences", {
      method: "POST",
      body: JSON.stringify({
        action: "sync",
        tenant_id: tenant.id,
        audience_key: "all",
        ad_account_id: adAccountId || undefined,
      }),
    });
    const data = await res.json();
    setIntegrationBusy(false);
    if (!res.ok) return setToast(data.error || "Erro ao sincronizar públicos Meta.");
    setMetaAudiences(data.audiences ?? []);
    const totals = (data.results ?? []).reduce(
      (acc: { synced: number; skipped: number; failed: number }, item: { synced?: number; skipped?: number; failed?: number }) => ({
        synced: acc.synced + Number(item.synced ?? 0),
        skipped: acc.skipped + Number(item.skipped ?? 0),
        failed: acc.failed + Number(item.failed ?? 0),
      }),
      { synced: 0, skipped: 0, failed: 0 },
    );
    setToast(`${totals.synced} pessoas sincronizadas. ${totals.skipped} sem telefone/email. ${totals.failed} falhas.`);
  }

  async function loadWaInstances() {
    if (!tenant) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({ action: "manage_whatsapp_instance", sub_action: "list", tenant_id: tenant.id }),
      });
      const data = await res.json();
      if (data.ok) setWaInstances(data.instances ?? []);
    } catch { /* */ }
    setWaBusy(false);
  }

  async function createWaInstance() {
    if (!tenant || !waNewInstanceName.trim()) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "manage_whatsapp_instance",
          sub_action: "create",
          tenant_id: tenant.id,
          instance_name: waNewInstanceName.trim(),
          api_url: waNewInstanceUrl.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setWaNewInstanceName("");
        setWaNewInstanceUrl("");
        setToast("Instância criada.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao criar instância.");
      }
    } catch { setToast("Erro ao criar instância."); }
    setWaBusy(false);
  }

  async function deleteWaInstance(instanceId: string) {
    if (!tenant) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "manage_whatsapp_instance",
          sub_action: "delete",
          tenant_id: tenant.id,
          instance_id: instanceId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast("Instância removida.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao remover.");
      }
    } catch { setToast("Erro ao remover."); }
    setWaBusy(false);
  }

  async function loadWaKeys() {
    if (!tenant) return;
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({ action: "list_webhook_keys", tenant_id: tenant.id }),
      });
      const data = await res.json();
      if (data.ok) setWaKeys(data.keys ?? []);
    } catch { /* */ }
  }

  async function generateWaKey() {
    if (!tenant) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "generate_webhook_key",
          tenant_id: tenant.id,
          label: waNewKeyLabel.trim() || "default",
        }),
      });
      const data = await res.json();
      if (data.ok && data.key) {
        setWaGeneratedKey(data.key.plain_key);
        setWaNewKeyLabel("");
        setToast("Chave gerada. Copie agora — ela não será exibida novamente.");
        await loadWaKeys();
      } else {
        setToast(data.error ?? "Erro ao gerar chave.");
      }
    } catch { setToast("Erro ao gerar chave."); }
    setWaBusy(false);
  }

  async function revokeWaKey(keyId: string) {
    if (!tenant) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({ action: "revoke_webhook_key", tenant_id: tenant.id, key_id: keyId }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast("Chave revogada.");
        await loadWaKeys();
      }
    } catch { /* */ }
    setWaBusy(false);
  }

  async function loadWaConversations() {
    if (!tenant || !supabase) return;
    if (waConvLoadingRef.current) return;
    waConvLoadingRef.current = true;
    try {
      const { data } = await supabase
        .from("whatsapp_conversations")
        .select("*, contact:whatsapp_contacts(*)")
        .eq("tenant_id", tenant.id)
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (data) setWaConversations(data);
    } finally {
      waConvLoadingRef.current = false;
    }
  }

  async function loadWaMessages(conversationId: string) {
    if (!supabase) return;
    const { data } = await supabase
      .from("whatsapp_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("timestamp", { ascending: true })
      .limit(500);
    if (data) setWaMessages(data);
  }

  const selectConversation = useCallback(async (convId: string) => {
    const token = ++selectConvTokenRef.current;
    setWaSelectedConvId(convId);
    waSelectedConvIdRef.current = convId;
    setWaInsight(null);
    setWaSaleSignals([]);
    setWaInsightOpen(false);
    await loadWaMessages(convId);
    if (selectConvTokenRef.current !== token) return;
    loadWaInsights(convId);
    if (supabase) {
      const conv = waConversations.find((c) => c.id === convId);
      if (conv && conv.unread_count > 0) {
        supabase
          .from("whatsapp_conversations")
          .update({ unread_count: 0 })
          .eq("id", convId)
          .then(() => {});
      }
    }
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, [waConversations]);

  async function loadWaInsights(conversationId: string) {
    if (!supabase) return;
    const { data: insight } = await supabase
      .from("conversation_insights")
      .select("*")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    setWaInsight(insight);
    const { data: signals } = await supabase
      .from("sale_signals")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    setWaSaleSignals(signals ?? []);
  }

  async function loadAiSales() {
    if (!tenant || !supabase) return;
    setAiSalesLoading(true);
    try {
      let query = supabase
        .from("sale_signals")
        .select("*")
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (aiSalesFilter !== "all") query = query.eq("capi_status", aiSalesFilter);
      const { data } = await query;
      setAiSales(data ?? []);
    } finally {
      setAiSalesLoading(false);
    }
  }

  async function loadCampaignAttribution() {
    if (!tenant || !supabase) return;
    try {
      let query = supabase
        .from("vw_campaign_attribution")
        .select("*")
        .eq("tenant_id", tenant.id)
        .order("clicks", { ascending: false });
      if (attrPeriod !== "all") {
        const days = attrPeriod === "7d" ? 7 : attrPeriod === "30d" ? 30 : 90;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        query = query.gte("last_click_at", since);
      }
      const { data } = await query;
      setCampaignAttribution((data ?? []) as CampaignAttribution[]);
    } catch { /* view may not exist yet */ }
  }

  async function confirmAiSale(signalId: string, revenue?: number) {
    if (!tenant) return;
    setAiSalesBusy(signalId);
    try {
      const payload: Record<string, unknown> = {
        action: "confirm_sale",
        tenant_id: tenant.id,
        signal_id: signalId,
      };
      if (revenue && revenue > 0) payload.revenue = revenue;
      const res = await authFetch("sale-confirm", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setToast(data.already_sent ? "Venda já enviada ao Meta anteriormente." : data.error ? `CAPI falhou: ${data.error}` : "Venda confirmada e enviada ao Meta.");
        loadAiSales();
      } else {
        setToast(data.error ?? "Erro ao confirmar venda.");
      }
    } finally {
      setAiSalesBusy("");
    }
  }

  async function rejectAiSale(signalId: string) {
    if (!tenant) return;
    setAiSalesBusy(signalId);
    try {
      const res = await authFetch("sale-confirm", {
        method: "POST",
        body: JSON.stringify({ action: "reject_sale", tenant_id: tenant.id, signal_id: signalId }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast("Sinal rejeitado.");
        loadAiSales();
      } else {
        setToast(data.error ?? "Erro ao rejeitar.");
      }
    } finally {
      setAiSalesBusy("");
    }
  }

  async function retryAiSaleCapi(signalId: string) {
    if (!tenant) return;
    setAiSalesBusy(signalId);
    try {
      const res = await authFetch("sale-confirm", {
        method: "POST",
        body: JSON.stringify({ action: "retry_capi", tenant_id: tenant.id, signal_id: signalId }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast(data.error ? `CAPI falhou novamente: ${data.error}` : "Evento reenviado ao Meta.");
        loadAiSales();
      } else {
        setToast(data.error ?? "Erro ao reenviar.");
      }
    } finally {
      setAiSalesBusy("");
    }
  }

  async function loadFinancialDashboard() {
    if (!tenant) return;
    setFiLoading(true);
    try {
      const [dashRes, custRes, patRes] = await Promise.all([
        authFetch("financial-intelligence", {
          method: "POST",
          body: JSON.stringify({ action: "dashboard", tenant_id: tenant.id }),
        }),
        authFetch("financial-intelligence", {
          method: "POST",
          body: JSON.stringify({ action: "customers", tenant_id: tenant.id }),
        }),
        authFetch("financial-intelligence", {
          method: "POST",
          body: JSON.stringify({ action: "ai_patterns", tenant_id: tenant.id }),
        }),
      ]);
      const dash = await dashRes.json();
      const cust = await custRes.json();
      const pat = await patRes.json();
      if (dash.ok) {
        setFiSummary(dash.summary);
        setFiMonthly(dash.monthly_chart ?? []);
        setFiCampaigns(dash.campaigns ?? []);
      }
      if (cust.ok) setFiCustomers(cust.customers ?? []);
      if (pat.ok) setFiPatterns(pat.patterns ?? null);
    } finally {
      setFiLoading(false);
    }
  }

  async function exportCsv(report: string) {
    if (!tenant) return;
    setFiExporting(true);
    try {
      const res = await authFetch("financial-intelligence", {
        method: "POST",
        body: JSON.stringify({ action: "export_csv", tenant_id: tenant.id, report }),
      });
      if (!res.ok) { setToast("Erro ao exportar."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${report}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setToast("CSV exportado.");
    } finally {
      setFiExporting(false);
    }
  }

  async function connectEvoInstance(instanceId: string) {
    if (!tenant) return;
    const inst = waInstances.find((i) => i.id === instanceId);
    if (!inst) return;
    if (!waEvoApiKey.trim()) { setToast("Informe a API Key da Evolution API."); return; }
    setWaBusy(true);
    try {
      const res = await authFetch("wa-evolution", {
        method: "POST",
        body: JSON.stringify({
          action: "connect_instance",
          tenant_id: tenant.id,
          instance_id: instanceId,
          api_url: inst.api_url || waNewInstanceUrl || undefined,
          api_key: waEvoApiKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast("QR Code gerado. Escaneie com o WhatsApp.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao conectar.");
      }
    } catch { setToast("Erro ao conectar."); }
    setWaBusy(false);
  }

  async function checkEvoStatus(instanceId: string) {
    if (!tenant) return;
    setWaBusy(true);
    try {
      const payload: Record<string, string> = {
        action: "check_status",
        tenant_id: tenant.id,
        instance_id: instanceId,
      };
      if (waEvoApiKey.trim()) payload.api_key = waEvoApiKey;
      const res = await authFetch("wa-evolution", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setToast(`Status: ${data.status}`);
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao verificar.");
      }
    } catch { setToast("Erro ao verificar."); }
    setWaBusy(false);
  }

  async function disconnectEvoInstance(instanceId: string) {
    if (!tenant) return;
    if (!confirm("Deseja desconectar esta instância do WhatsApp?")) return;
    setWaBusy(true);
    try {
      const payload: Record<string, string> = {
        action: "disconnect_instance",
        tenant_id: tenant.id,
        instance_id: instanceId,
      };
      if (waEvoApiKey.trim()) payload.api_key = waEvoApiKey;
      const res = await authFetch("wa-evolution", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setToast("Instância desconectada.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao desconectar.");
      }
    } catch { setToast("Erro ao desconectar."); }
    setWaBusy(false);
  }

  async function setInstanceMode(instanceId: string, mode: "test" | "production") {
    if (!tenant) return;
    if (mode === "production" && !confirm("Ativar modo produção? Eventos CAPI serão enviados ao Meta em tempo real.")) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "set_instance_mode",
          tenant_id: tenant.id,
          instance_id: instanceId,
          mode,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast(mode === "test" ? "Modo teste ativado." : "Modo produção ativado.");
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao alterar modo.");
      }
    } catch { setToast("Erro ao alterar modo."); }
    setWaBusy(false);
  }

  async function purgeTestData(instanceId: string) {
    if (!tenant) return;
    if (!confirm("ATENÇÃO: Isso apagará TODAS as conversas, mensagens, insights e sinais de venda desta instância de teste. Essa ação é irreversível. Continuar?")) return;
    setWaBusy(true);
    try {
      const res = await authFetch("tenant-admin", {
        method: "POST",
        body: JSON.stringify({
          action: "purge_test_data",
          tenant_id: tenant.id,
          instance_id: instanceId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const p = data.purged;
        setToast(`Dados de teste apagados: ${p.conversations} conversas, ${p.messages} mensagens, ${p.insights} insights, ${p.signals} sinais.`);
        await loadWaInstances();
      } else {
        setToast(data.error ?? "Erro ao limpar dados.");
      }
    } catch { setToast("Erro ao limpar dados."); }
    setWaBusy(false);
  }

  useEffect(() => {
    if (!supabase || !tenant || active !== "whatsapp") return;

    const channel = supabase
      .channel(`wa-messages-${tenant.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "whatsapp_messages",
          filter: `tenant_id=eq.${tenant.id}`,
        },
        (payload) => {
          const newMsg = payload.new as WhatsAppMessage;
          if (newMsg.conversation_id === waSelectedConvIdRef.current) {
            setWaMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
          }
          loadWaConversations();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "whatsapp_messages",
          filter: `tenant_id=eq.${tenant.id}`,
        },
        (payload) => {
          const updated = payload.new as WhatsAppMessage;
          setWaMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "whatsapp_instances",
          filter: `tenant_id=eq.${tenant.id}`,
        },
        () => { loadWaInstances(); },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "whatsapp_conversations",
          filter: `tenant_id=eq.${tenant.id}`,
        },
        (payload) => {
          const updated = payload.new as WhatsAppConversation;
          if (updated.id === waSelectedConvIdRef.current && updated.ai_analyzed_at) {
            loadWaInsights(updated.id);
          }
          loadWaConversations();
        },
      )
      .subscribe();

    return () => { supabase?.removeChannel(channel); };
  }, [tenant?.id, active]);

  useEffect(() => {
    if (active === "whatsapp" && tenant) {
      loadWaConversations();
      loadWaInstances();
      loadWaKeys();
    }
    if (active === "dashboard" && tenant) {
      loadWaConversations();
      loadAiSales();
    }
  }, [active, tenant?.id]);

  useEffect(() => {
    if (active === "ai-sales" && tenant) loadAiSales();
  }, [active, tenant?.id, aiSalesFilter]);

  useEffect(() => {
    if (active === "links" && linksTab === "attribution" && tenant) loadCampaignAttribution();
  }, [active, linksTab, tenant?.id, attrPeriod]);

  useEffect(() => {
    if ((active === "dashboard" || active === "reports") && tenant) loadCampaignAttribution();
  }, [active, tenant?.id]);

  useEffect(() => {
    if (active === "intelligence" && tenant) loadFinancialDashboard();
  }, [active, tenant?.id]);

  useEffect(() => {
    // Integrações também mostra o status do Google Ads; antes só a seção
    // Google Ads carregava, e Integrações exibia "Conectar" mesmo conectado.
    if ((active === "google-ads" || active === "integrations") && tenant) loadGoogleAdsData();
  }, [active, tenant?.id]);

  useEffect(() => {
    if (waMessages.length > 0) {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, [waMessages.length]);

  const filteredConversations = waConversations.filter((conv) => {
    if (!waConvSearch.trim()) return true;
    const q = waConvSearch.toLowerCase();
    const c = conv.contact;
    return [c?.push_name, c?.phone, c?.wa_id].some((v) => String(v ?? "").toLowerCase().includes(q));
  });

  const selectedConv = waConversations.find((c) => c.id === waSelectedConvId);
  const selectedContact = selectedConv?.contact;

  function waConvLeadLink(conv: WhatsAppConversation) {
    if (!conv.tracking_session_id) return null;
    const lead = tenantLeads.find((l) => l.id === conv.tracking_session_id);
    return lead ?? null;
  }

  function formatMsgTime(ts: string) {
    return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function formatMsgDate(ts: string) {
    return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function msgStatusIcon(status: string) {
    if (status === "read") return "✓✓";
    if (status === "delivered") return "✓✓";
    if (status === "sent") return "✓";
    if (status === "failed") return "✗";
    return "";
  }

  async function checkSupabaseHealth() {
    if (!isConfigured || !supabase) {
      setSupabaseStatus("error");
      setToast("Supabase não configurado neste build.");
      return;
    }
    setIntegrationBusy(true);
    const res = await authFetch("supabase-health", { method: "GET" });
    const data = await res.json();
    setIntegrationBusy(false);
    setSupabaseStatus(res.ok && data.ok ? "ok" : "error");
    setSupabaseHealth(data);
    setToast(res.ok && data.ok ? "Supabase saudável." : "Supabase precisa de atenção.");
  }

  const filteredLeads = tenantLeads.filter((lead) => {
    if (!leadSearch.trim()) return true;
    const q = leadSearch.toLowerCase();
    return [lead.ref, lead.offer_name, lead.link_name, lead.utm_campaign].some((value) =>
      String(value ?? "").toLowerCase().includes(q),
    );
  });

  if (!sessionReady) {
    return <div className="center-screen">Carregando</div>;
  }

  if (!isConfigured) {
    return (
      <main className="login-screen">
        <section className="login-panel setup-panel">
          <div className="brand-mark">IDX.</div>
          <h1>Configuração necessária</h1>
          <p>Este painel só mostra dados reais. Configure o Supabase do projeto para liberar login, onboarding e métricas reais.</p>
          <div className="config-list">
            <ReadOnly label="VITE_SUPABASE_URL" value="Obrigatório no build" />
            <ReadOnly label="VITE_SUPABASE_ANON_KEY" value="Obrigatório no build" />
            <ReadOnly label="Dados exibidos" value="Somente dados reais do banco IDX" />
          </div>
        </section>
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main className="login-screen">
        <form
          className="login-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (loading) return;
            void (authMode === "login" ? login() : signup());
          }}
        >
          <div className="brand-mark">IDX.</div>
          <h1>{authMode === "login" ? "CRO Engine" : "Criar acesso"}</h1>
          <p>{authMode === "login" ? "Entre para gerenciar Smart Links, WhatsApp Leads e CAPI." : "Crie seu acesso inicial e configure a primeira empresa."}</p>
          {requestedTenantSlug && (
            <p className="auth-hint compact">
              Acesso da empresa <strong>/{requestedTenantSlug}</strong>.
            </p>
          )}
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
          </label>
          <label>
            Senha
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} />
          </label>
          <div className="auth-actions">
            <button className="primary-button" type="submit" disabled={loading}>
              {authMode === "login" ? "Entrar" : "Criar conta"}
            </button>
            {authMode === "login" && (
              <button className="login-link-button strong" type="button" onClick={sendAccessLink} disabled={loading}>
                Receber link no email
              </button>
            )}
            <button className="login-link-button" type="button" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")} disabled={loading}>
              {authMode === "login" ? "Criar primeiro acesso" : "Voltar para login"}
            </button>
            {(authMode === "signup" || confirmationEmail) && (
              <button className="login-link-button" type="button" onClick={resendConfirmationEmail} disabled={loading}>
                Reenviar confirmação por email
              </button>
            )}
          </div>
          {confirmationEmail && (
            <p className="auth-hint">
              Email de confirmação enviado para <strong>{confirmationEmail}</strong>.
            </p>
          )}
          {accessLinkEmail && (
            <p className="auth-hint">
              Link de acesso enviado para <strong>{accessLinkEmail}</strong>. Abra o email neste dispositivo para entrar.
            </p>
          )}
        </form>
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  if (isConfigured && (tenantSetupRequired || !tenant) && !isPlatformUser) {
    return (
      <main className="login-screen">
        <section className="login-panel setup-panel">
          <div className="brand-mark">IDX.</div>
          <h1>Onboarding da empresa</h1>
          <p>Preencha os dados reais da empresa. O painel só será criado com informações salvas no banco da IDX.</p>
          <div className="setup-form">
            <label>
              Nome real da empresa
              <input placeholder="Nome cadastrado da empresa" value={clientDraft.name} onChange={(event) => setClientDraft({ ...clientDraft, name: event.target.value, slug: slugify(event.target.value) })} />
            </label>
            <label>
              Segmento
              <input placeholder="Segmento de atuação" value={clientDraft.businessSegment} onChange={(event) => setClientDraft({ ...clientDraft, businessSegment: event.target.value })} />
            </label>
            <label>
              WhatsApp com DDI e DDD
              <input placeholder="5564999999999" value={clientDraft.whatsapp} onChange={(event) => setClientDraft({ ...clientDraft, whatsapp: event.target.value })} />
            </label>
            <label>
              Cidade
              <input placeholder="Cidade" value={clientDraft.city} onChange={(event) => setClientDraft({ ...clientDraft, city: event.target.value })} />
            </label>
            <label>
              UF
              <input placeholder="GO" maxLength={2} value={clientDraft.state} onChange={(event) => setClientDraft({ ...clientDraft, state: event.target.value.toUpperCase() })} />
            </label>
            <label>
              Slug do painel
              <input placeholder="nome-da-empresa" value={clientDraft.slug} onChange={(event) => setClientDraft({ ...clientDraft, slug: slugify(event.target.value) })} />
            </label>
            <label>
              Meta mensal em R$
              <input inputMode="decimal" placeholder="0,00" value={clientDraft.monthlyGoal} onChange={(event) => setClientDraft({ ...clientDraft, monthlyGoal: event.target.value })} />
            </label>
            <label>
              Ticket médio em R$
              <input inputMode="decimal" placeholder="0,00" value={clientDraft.averageTicket} onChange={(event) => setClientDraft({ ...clientDraft, averageTicket: event.target.value })} />
            </label>
            <label>
              Canal principal
              <input placeholder="Origem principal dos leads" value={clientDraft.primaryChannel} onChange={(event) => setClientDraft({ ...clientDraft, primaryChannel: event.target.value })} />
            </label>
            <label>
              Responsável interno
              <input placeholder="Nome do responsável" value={clientDraft.responsibleName} onChange={(event) => setClientDraft({ ...clientDraft, responsibleName: event.target.value })} />
            </label>
            <button className="primary-button span-2" onClick={createClient} disabled={loading}>
              Criar painel real
            </button>
            <button className="login-link-button span-2" onClick={logout} disabled={loading}>
              Sair
            </button>
          </div>
        </section>
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-row">
            <div className="brand-mark">IDX.</div>
            <span>CRO Engine</span>
          </div>
          {isSellerExperience ? (
            <nav className="nav-list">
              <NavButton icon={<PhoneCall />} label="Atender" active={active === "sales"} onClick={() => goToSection("sales")} />
              <NavButton icon={<MessageCircle />} label="Atendimentos" active={active === "leads"} onClick={() => goToSection("leads")} />
            </nav>
          ) : (
          <nav className="nav-list">
            <NavButton icon={<Gauge />} label="Dashboard" active={active === "dashboard"} onClick={() => goToSection("dashboard")} />
            <NavButton icon={<MessageCircle />} label="WhatsApp" active={active === "whatsapp"} onClick={() => { goToSection("whatsapp"); loadWaInstances(); loadWaKeys(); }} />
            <NavButton icon={<TrendingUp />} label="Vendas IA" active={active === "ai-sales"} onClick={() => goToSection("ai-sales")} />
            <NavButton icon={<LayoutList />} label="CRM" active={active === "crm"} onClick={() => goToSection("crm")} />
            <NavButton icon={<Bell />} label={`Follow-ups${overdueCount ? ` (${overdueCount})` : ""}`} active={active === "follow-ups"} onClick={() => goToSection("follow-ups")} />
            <NavButton icon={<Tag />} label="Segmentos" active={active === "segments"} onClick={() => goToSection("segments")} />
            <div className="nav-separator" />
            <NavButton icon={<PhoneCall />} label="Atender" active={active === "sales"} onClick={() => goToSection("sales")} />
            <NavButton icon={<MessageCircle />} label="Atendimentos" active={active === "leads"} onClick={() => goToSection("leads")} />
            <NavButton icon={<Link2 />} label="Links" active={active === "links"} onClick={() => goToSection("links")} />
            <NavButton icon={<LayoutList />} label="Clientes" active={active === "clients"} onClick={() => goToSection("clients")} />
            <NavButton icon={<BarChart3 />} label="Inteligência" active={active === "intelligence"} onClick={() => goToSection("intelligence")} />
            <NavButton icon={<Zap />} label="Google Ads" active={active === "google-ads"} onClick={() => goToSection("google-ads")} />
            <div className="nav-separator" />
            <NavButton icon={<ShieldCheck />} label="Integrações" active={active === "integrations"} onClick={() => goToSection("integrations")} />
            <NavButton icon={<Activity />} label="CAPI" active={active === "capi"} onClick={() => goToSection("capi")} />
            <NavButton icon={<FileText />} label="Relatórios" active={active === "reports"} onClick={() => goToSection("reports")} />
            <NavButton icon={<Users />} label="Usuários" active={active === "users"} onClick={() => goToSection("users")} />
            <NavButton icon={<Settings />} label="Config" active={active === "settings"} onClick={() => goToSection("settings")} />
          </nav>
          )}
        </div>
        <div className="sidebar-bottom">
          <label className="mini-label">Empresa</label>
          <select
            value={tenant?.id ?? ""}
            onChange={async (event) => {
              const nextTenantId = event.target.value;
              setTenantId(nextTenantId);
              if (isConfigured) await loadTenantData(nextTenantId);
            }}
          >
            {tenants.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="ghost-button full" onClick={logout}>
            <LogOut size={16} /> Sair
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyeline">{isPlatformUser ? `Gestor IDX · ${platformRoleLabel(platformRole)}` : "Dados reais da empresa"}</p>
            <h1>{sectionTitle(active)}</h1>
          </div>
          <div className="tenant-chip">
            <CircleDot size={14} />
            {tenant?.name}
          </div>
        </header>

        {tenantRouteWarning && (
          <div className="inline-alert">
            <strong>Acesso por link de empresa</strong>
            <span>{tenantRouteWarning}</span>
          </div>
        )}

        {active === "sales" && (
          <SalesConsole
            leads={salesVisibleLeads}
            allLeads={tenantLeads}
            selectedLead={selectedSalesLead}
            selectedLeadId={selectedSalesLead?.id ?? ""}
            stats={salesStats}
            filter={salesFilter}
            search={salesSearch}
            notes={crmNotes}
            contacts={crmContacts}
            followUps={crmFollowUps}
            revenues={crmRevenue}
            busyRef={crmBusyRef}
            onFilterChange={setSalesFilter}
            onSearchChange={setSalesSearch}
            onSelectLead={setSalesSelectedLeadId}
            onNoteChange={(leadId, value) => setCrmNotes((items) => ({ ...items, [leadId]: value }))}
            onContactChange={(leadId, value) => setCrmContacts((items) => ({ ...items, [leadId]: { ...(items[leadId] ?? { phone: "", email: "", name: "" }), ...value } }))}
            onFollowUpChange={(leadId, value) => setCrmFollowUps((items) => ({ ...items, [leadId]: value }))}
            onRevenueChange={(leadId, value) => setCrmRevenue((items) => ({ ...items, [leadId]: value }))}
            onStageChange={updateCrmStage}
          />
        )}

        {active === "dashboard" && needsOperationalOnboarding && (
          <section className="page-grid">
            <section className="panel wide onboarding-panel">
              <div className="panel-head">
                <div>
                  <h2>Onboarding operacional</h2>
                  <p>Esta empresa ainda não tem dados suficientes. Complete os pontos abaixo para liberar um painel confiável.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <ReadinessChecklist items={operationalChecklist} onGo={goToSection} />
            </section>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Criar primeiro Smart Link</h2>
                  <p>Use a mesma UTM que será colocada no anúncio, bio, stories ou campanha.</p>
                </div>
                <Plus size={18} />
              </div>
              <SmartLinkForm draft={draft} setDraft={setDraft} onSubmit={createSmartLink} loading={loading} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Perfil da empresa</h2>
                  <p>Base operacional que alimenta implantação e relatórios.</p>
                </div>
              </div>
              <div className="settings-grid compact-grid">
                <ReadOnly label="Segmento" value={onboarding?.business_segment ?? "Não preenchido"} />
                <ReadOnly label="Cidade" value={onboarding?.city ?? "Não preenchido"} />
                <ReadOnly label="UF" value={onboarding?.state ?? "Não preenchido"} />
                <ReadOnly label="Responsável" value={onboarding?.responsible_name ?? "Não preenchido"} />
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Alertas de integração</h2>
                  <p>Somente bloqueios reais encontrados nos dados desta empresa.</p>
                </div>
                <Activity size={18} />
              </div>
              <IntegrationAlerts
                checklist={operationalChecklist}
                audiences={metaAudiences}
                leads={tenantLeads}
                health={health}
                campaigns={tenantMetaCampaigns}
              />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Usuários desta empresa</h2>
                  <p>Cada login fica vinculado apenas à empresa selecionada.</p>
                </div>
                <Users size={18} />
              </div>
              <TenantUsersList users={tenantUsers} />
            </section>
          </section>
        )}

        {active === "dashboard" && !needsOperationalOnboarding && (() => {
          const totalConvs = waConversations.length;
          const highIntentConvs = waConversations.filter((c) => c.ai_purchase_probability != null && c.ai_purchase_probability > 0.5).length;
          const confirmedSales = aiSales.filter((s) => s.signal_type === "confirmed_sale" || s.status === "confirmed" || s.status === "converted").length;
          const pendingSales = aiSales.filter((s) => (s.signal_type === "declared_purchase" || s.signal_type === "high_intent") && s.status !== "confirmed" && s.status !== "converted" && s.status !== "rejected").length;
          const aiRevenue = aiSales.filter((s) => s.status === "confirmed" || s.status === "converted").reduce((sum, s) => sum + Number(s.estimated_value ?? 0), 0);
          const totalRevenue = metrics.revenue || aiRevenue;
          const convRate = totalConvs > 0 ? ((confirmedSales / totalConvs) * 100) : metrics.conversion;
          const recentConvs = waConversations.slice(0, 5);
          const recentSignals = aiSales.slice(0, 5);
          return (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Conversas" value={totalConvs.toString()} accent="#3b82f6" />
              <Kpi label="Oportunidades" value={(highIntentConvs + pendingSales).toString()} accent="#f59e0b" />
              <Kpi label="Vendas" value={(confirmedSales || metrics.sales).toString()} accent="#10b981" />
              <Kpi label="Receita" value={formatMoney(totalRevenue)} accent="#111" />
              <Kpi label="Conversão" value={`${convRate.toFixed(1)}%`} accent="#8b5cf6" />
              <Kpi label="Cliques" value={metrics.clicks.toLocaleString("pt-BR")} accent="#64748b" />
            </div>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Atividade recente</h2>
                  <p>Últimas conversas e sinais de venda detectados pela IA.</p>
                </div>
                <Activity size={18} />
              </div>
              <div className="dash-activity-feed">
                {recentConvs.length === 0 && recentSignals.length === 0 && (
                  <p className="empty-state">Nenhuma atividade recente.</p>
                )}
                {recentConvs.map((conv) => {
                  const c = conv.contact;
                  const name = c?.push_name || c?.phone || c?.wa_id || "Desconhecido";
                  return (
                    <div key={conv.id} className="dash-activity-row" onClick={() => { goToSection("whatsapp"); setTimeout(() => selectConversation(conv.id), 100); }}>
                      <div className="dash-activity-icon" style={{ background: "#3b82f6" }}><MessageCircle size={14} /></div>
                      <div className="dash-activity-body">
                        <strong>{name}</strong>
                        <span>{cleanAiText(conv.ai_summary) || "Nova conversa"}</span>
                      </div>
                      <div className="dash-activity-meta">
                        {conv.last_message_at && <span>{timeAgo(conv.last_message_at)}</span>}
                        {conv.ai_purchase_probability != null && conv.ai_purchase_probability > 0.3 && (
                          <span className="wa-purchase-badge">{Math.round(conv.ai_purchase_probability * 100)}%</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {recentSignals.map((sig) => {
                  const typeLabel = sig.signal_type === "confirmed_sale" ? "Venda confirmada" : sig.signal_type === "declared_purchase" ? "Compra declarada" : sig.signal_type === "high_intent" ? "Alta intenção" : sig.signal_type === "negotiation" ? "Negociação" : sig.signal_type === "interest" ? "Interesse" : sig.signal_type;
                  return (
                    <div key={sig.id} className="dash-activity-row" onClick={() => goToSection("ai-sales")}>
                      <div className="dash-activity-icon" style={{ background: sig.signal_type === "confirmed_sale" ? "#10b981" : sig.signal_type === "declared_purchase" ? "#f59e0b" : "#8b5cf6" }}><TrendingUp size={14} /></div>
                      <div className="dash-activity-body">
                        <strong>{typeLabel}</strong>
                        <span>{cleanAiText(sig.evidence_text) || cleanAiText(sig.product_name) || "Sinal detectado"}</span>
                      </div>
                      <div className="dash-activity-meta">
                        {sig.created_at && <span>{timeAgo(sig.created_at)}</span>}
                        {sig.confidence != null && <span style={{ fontSize: 11, opacity: 0.7 }}>{Math.round(sig.confidence * 100)}%</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>CAPI Health</h2>
                  <p>Últimos 7 dias.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <div className="health-meter">
                <span>{health.success_rate}%</span>
                <div>
                  <strong>{health.successful_events}</strong>
                  <small>eventos OK</small>
                </div>
              </div>
              <div className="meter-track">
                <span style={{ width: `${Math.min(100, health.success_rate)}%` }} />
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Prontidão operacional</h2>
                  <p>Checklist de integração.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <ReadinessChecklist items={operationalChecklist} onGo={goToSection} compact />
            </section>

            {campaignAttribution.length > 0 && (
              <section className="panel wide">
                <div className="panel-head">
                  <div>
                    <h2>Top campanhas por atribuição</h2>
                    <p>Campanhas que mais geraram contatos, oportunidades e vendas confirmadas.</p>
                  </div>
                  <Target size={18} />
                </div>
                <div className="table-wrap">
                  <table className="attr-table">
                    <thead>
                      <tr>
                        <th>Campanha</th>
                        <th>Fonte</th>
                        <th>Cliques</th>
                        <th>CTR</th>
                        <th>CPC</th>
                        <th>Conv. Google</th>
                        <th>Leads</th>
                        <th>Vendas</th>
                        <th>Conv.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaignAttribution.slice(0, 5).map((row) => {
                        const conv = Number(row.clicks) > 0 ? ((Number(row.sales) + Number(row.ai_confirmed_sales)) / Number(row.clicks)) * 100 : 0;
                        return (
                          <tr key={`${row.campaign}-${row.source}`}>
                            <td className="attr-campaign">{row.campaign}</td>
                            <td><span className={`attr-source-tag ${(() => { const s = row.source.toLowerCase(); if (s.includes("meta") || s.includes("facebook") || s.includes("instagram")) return "attr-source-meta"; if (s.includes("google")) return "attr-source-google"; return "attr-source-default"; })()}`}>{row.source}</span></td>
                            <td>{Number(row.clicks).toLocaleString("pt-BR")}</td>
                            <td>{row.leads}</td>
                            <td>{Number(row.sales) + Number(row.ai_confirmed_sales)}</td>
                            <td>{conv.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button className="ghost-button full" style={{ marginTop: 8 }} onClick={() => { goToSection("links"); setLinksTab("attribution"); }}>Ver relatório completo <ArrowRight size={14} /></button>
              </section>
            )}

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Performance por link</h2>
                  <p>Cada linha conecta campanha, oferta, WhatsApp e venda.</p>
                </div>
              </div>
              <LinksTable links={tenantLinks} onCopy={copyLink} />
            </section>
          </section>
          );
        })()}

        {active === "links" && (
          <section className="stack">
            <div className="links-tab-bar">
              <button className={linksTab === "links" ? "active" : ""} onClick={() => setLinksTab("links")}>Smart Links</button>
              <button className={linksTab === "utm" ? "active" : ""} onClick={() => setLinksTab("utm")}>UTMs e Atribuição</button>
              <button className={linksTab === "attribution" ? "active" : ""} onClick={() => setLinksTab("attribution")}>Relatório por Campanha</button>
            </div>

            {linksTab === "links" && (
              <>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Novo link</h2>
                      <p>Crie uma oferta rastreável para qualquer negócio local.</p>
                    </div>
                  </div>
                  <SmartLinkForm draft={draft} setDraft={setDraft} onSubmit={createSmartLink} loading={loading} />
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Links ativos</h2>
                      <p>Copie e use em anúncio, bio, stories ou campanha.</p>
                    </div>
                  </div>
                  <LinksTable links={tenantLinks} onCopy={copyLink} />
                </section>
              </>
            )}

            {linksTab === "utm" && (
              <>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Gerador de links com UTMs</h2>
                      <p>Selecione um template e preencha os campos. O link com UTMs é gerado automaticamente.</p>
                    </div>
                    <Target size={18} />
                  </div>
                  <div className="utm-templates">
                    {UTM_TEMPLATES.map((tpl, i) => (
                      <button
                        key={tpl.label}
                        className={`utm-template-btn${selectedUtmTemplate === i ? " active" : ""}`}
                        onClick={() => {
                          setSelectedUtmTemplate(i);
                          setDraft((prev) => ({
                            ...prev,
                            source: tpl.source,
                            medium: tpl.medium,
                            campaign: prev.campaign || "",
                            content: prev.content || "",
                            term: prev.term || "",
                          }));
                        }}
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                  <SmartLinkForm
                    draft={draft}
                    setDraft={setDraft}
                    onSubmit={createSmartLink}
                    loading={loading}
                    template={UTM_TEMPLATES[selectedUtmTemplate]}
                  />
                  {(draft.source || draft.campaign) && (
                    <UtmPreview draft={draft} tenantSlug={tenant?.slug ?? "empresa"} />
                  )}
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Links com UTM ativos</h2>
                      <p>Todos os Smart Links com parâmetros UTM configurados.</p>
                    </div>
                  </div>
                  <LinksTable links={tenantLinks} onCopy={copyLink} />
                </section>
              </>
            )}

            {linksTab === "attribution" && (
              <CampaignAttributionPanel
                data={campaignAttribution}
                period={attrPeriod}
                sourceFilter={attrSourceFilter}
                search={attrSearch}
                onPeriodChange={setAttrPeriod}
                onSourceFilterChange={setAttrSourceFilter}
                onSearchChange={setAttrSearch}
                onRefresh={loadCampaignAttribution}
              />
            )}
          </section>
        )}

        {active === "leads" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Confirmar venda</h2>
                  <p>Use telefone e valor. A ref continua opcional para atribuição exata quando estiver disponível.</p>
                </div>
                <Check size={18} />
              </div>
              <div className="sale-form">
                <input placeholder="Ref opcional: a7k9-p2m4" value={saleRef} onChange={(event) => setSaleRef(event.target.value)} />
                <input placeholder="Nome do cliente" value={saleName} onChange={(event) => setSaleName(event.target.value)} />
                <input placeholder="Telefone com DDD" value={salePhone} onChange={(event) => setSalePhone(event.target.value)} />
                <input placeholder="Valor da venda" value={saleRevenue} onChange={(event) => setSaleRevenue(event.target.value)} />
                <button className="primary-button" onClick={confirmSale}>Confirmar Purchase</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Atendimentos</h2>
                  <p>Todos os cliques que chegaram ao WhatsApp.</p>
                </div>
                <div className="search-box">
                  <Search size={15} />
                  <input value={leadSearch} onChange={(event) => setLeadSearch(event.target.value)} placeholder="Buscar ref ou campanha" />
                </div>
              </div>
              <LeadList leads={filteredLeads} />
            </section>
          </section>
        )}

        {active === "crm" && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Novos" value={String(tenantLeads.filter((lead) => lead.lead_status === "new").length)} />
              <Kpi label="Em contato" value={String(tenantLeads.filter((lead) => lead.lead_status === "contacted").length)} />
              <Kpi label="Remarketing" value={String(remarketingLeads.length)} />
              <Kpi label="Ruins" value={String(tenantLeads.filter((lead) => lead.lead_status === "bad").length)} />
              <Kpi label="Vendas" value={String(tenantLeads.filter((lead) => lead.lead_status === "sold").length)} />
            </div>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Pipeline CRM</h2>
                  <p>Lead qualificado entra no mesmo segmento de remarketing.</p>
                </div>
                <LayoutList size={18} />
              </div>
              <div className="crm-toolbar">
                <div className="search-box">
                  <Search size={15} />
                  <input value={crmSearch} onChange={(event) => setCrmSearch(event.target.value)} placeholder="Buscar nome, telefone, ref ou campanha" />
                </div>
                <div className="segmented-filter" aria-label="Filtro do CRM">
                  {crmFilterOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={crmFilter === option.value ? "active" : ""}
                      onClick={() => setCrmFilter(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
                <CrmPipeline
                  leads={crmVisibleLeads}
                  allLeads={tenantLeads}
                  notes={crmNotes}
                  contacts={crmContacts}
                  followUps={crmFollowUps}
                  revenues={crmRevenue}
                  busyRef={crmBusyRef}
                  onNoteChange={(leadId, value) => setCrmNotes((items) => ({ ...items, [leadId]: value }))}
                  onContactChange={(leadId, value) => setCrmContacts((items) => ({ ...items, [leadId]: { ...(items[leadId] ?? { phone: "", email: "", name: "" }), ...value } }))}
                  onFollowUpChange={(leadId, value) => setCrmFollowUps((items) => ({ ...items, [leadId]: value }))}
                  onRevenueChange={(leadId, value) => setCrmRevenue((items) => ({ ...items, [leadId]: value }))}
                  onStageChange={updateCrmStage}
                  onOpenLead={focusCrmLead}
                />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Públicos automáticos</h2>
                  <p>Qualificados e compradores viram Custom Audiences no Meta Ads.</p>
                </div>
                <Users size={18} />
              </div>
              <div className="ad-sync-row">
                <input placeholder="ID da conta de anúncios, ex: act_123456789" value={adAccountId} onChange={(event) => setAdAccountId(event.target.value)} />
                <button className="primary-button" onClick={syncMetaAudiences} disabled={integrationBusy}>
                  Sincronizar públicos
                </button>
              </div>
              <MetaAudiencesTable audiences={metaAudiences} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Segmento remarketing</h2>
                  <p>Qualificados prontos para audiência e otimização.</p>
                </div>
                <Activity size={18} />
              </div>
              <LeadList leads={remarketingLeads.slice(0, 6)} compact />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Histórico CRM</h2>
                  <p>Últimos movimentos de atendimento.</p>
                </div>
                <FileText size={18} />
              </div>
              <CrmHistory activities={tenantCrmActivities} leads={tenantLeads} />
            </section>
          </section>
        )}

        {active === "follow-ups" && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Atrasados" value={String(overdueCount)} />
              <Kpi label="Ação agora" value={String(dueNowCount)} />
              <Kpi label="Com follow-up" value={String(tenantLeads.filter((l) => l.next_follow_up_at && isOpenLead(l)).length)} />
              <Kpi label="Sem agendamento" value={String(tenantLeads.filter((l) => !l.next_follow_up_at && isOpenLead(l)).length)} />
            </div>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Central de Follow-ups</h2>
                  <p>Alertas e lembretes para o vendedor entrar em contato no momento certo.</p>
                </div>
                <Bell size={18} />
              </div>
              <div className="followup-toolbar">
                <div className="segmented-filter" aria-label="Filtro follow-up">
                  {([
                    { value: "due" as const, label: "Ação agora" },
                    { value: "overdue" as const, label: "Atrasados" },
                    { value: "upcoming" as const, label: "Agendados" },
                    { value: "all" as const, label: "Todos abertos" },
                  ]).map((o) => (
                    <button key={o.value} className={followUpFilter === o.value ? "active" : ""} onClick={() => setFollowUpFilter(o.value)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              {followUpLeads.length === 0 ? (
                <EmptyState text="Nenhum lead neste filtro." />
              ) : (
                <div className="followup-list">
                  {followUpLeads.map((lead) => {
                    const isOverdue = leadFollowUpDue(lead);
                    const isNew = lead.lead_status === "new" && !lead.next_follow_up_at;
                    const fuDate = lead.next_follow_up_at ? new Date(lead.next_follow_up_at) : null;
                    const timeUntil = fuDate ? fuDate.getTime() - Date.now() : 0;
                    const hoursUntil = Math.round(timeUntil / 3600000);
                    return (
                      <article key={lead.id} className={`followup-card${isOverdue ? " followup-overdue" : ""}${isNew ? " followup-new" : ""}`}>
                        <div className="followup-card-header">
                          <div>
                            <strong>{lead.customer_name || lead.offer_name || lead.ref}</strong>
                            <small>
                              {lead.customer_phone || lead.ref} · {lead.utm_campaign ?? "sem campanha"} · <Status status={lead.lead_status} />
                            </small>
                          </div>
                          <div className="followup-timing">
                            {isOverdue && <span className="followup-badge overdue"><Clock size={12} /> Atrasado</span>}
                            {isNew && <span className="followup-badge new-lead"><Bell size={12} /> Lead novo</span>}
                            {!isOverdue && !isNew && fuDate && (
                              <span className="followup-badge upcoming">
                                <Clock size={12} /> {hoursUntil <= 0 ? "Agora" : hoursUntil < 24 ? `${hoursUntil}h` : `${Math.round(hoursUntil / 24)}d`}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="followup-card-body">
                          <div className="followup-meta">
                            {lead.next_follow_up_at && <span><Clock size={12} /> {formatDate(lead.next_follow_up_at)}</span>}
                            {lead.utm_source && <span className="attr-source-tag attr-source-default">{lead.utm_source}/{lead.utm_medium ?? "?"}</span>}
                            <TagRow tags={lead.tags} />
                          </div>
                          <div className="followup-card-actions">
                            {lead.customer_phone && (
                              <a href={whatsappUrl(lead.customer_phone)} target="_blank" rel="noopener noreferrer" className="ghost-dark-button">
                                <MessageCircle size={13} /> WhatsApp
                              </a>
                            )}
                            <button className="ghost-dark-button" onClick={() => focusCrmLead(lead)}>
                              <LayoutList size={13} /> Abrir no CRM
                            </button>
                            <input
                              type="datetime-local"
                              value={crmFollowUps[lead.id] ?? dateTimeLocalValue(lead.next_follow_up_at)}
                              onChange={(e) => setCrmFollowUps((items) => ({ ...items, [lead.id]: e.target.value }))}
                              style={{ fontSize: "0.82rem", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line)" }}
                            />
                            <button
                              className="primary-button"
                              onClick={() => updateCrmStage(lead, lead.lead_status)}
                              disabled={crmBusyRef === lead.ref}
                              style={{ fontSize: "0.82rem", padding: "4px 12px" }}
                            >
                              Salvar
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </section>
        )}

        {active === "segments" && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Total leads" value={String(tenantLeads.length)} />
              <Kpi label="Tags únicas" value={String(allSegmentTags.length)} />
              <Kpi label="Com telefone" value={String(tenantLeads.filter((l) => l.customer_phone).length)} />
              <Kpi label="Vendidos" value={String(tenantLeads.filter((l) => l.lead_status === "sold").length)} />
            </div>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Segmentação de Clientes</h2>
                  <p>Filtre por perfil, histórico, origem ou estágio na jornada.</p>
                </div>
                <Tag size={18} />
              </div>

              <div className="segment-filters">
                <div className="segment-group">
                  <label className="mini-label">Por estágio</label>
                  <div className="segment-chips">
                    <button className={segmentFilter === "all" ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter("all")}>Todos</button>
                    {(["new", "contacted", "qualified", "sold", "lost", "bad"] as LeadStatus[]).map((s) => (
                      <button key={s} className={segmentFilter === `status:${s}` ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter(`status:${s}`)}>
                        {statusLabel(s)} ({tenantLeads.filter((l) => l.lead_status === s).length})
                      </button>
                    ))}
                  </div>
                </div>

                {allSources.length > 0 && (
                  <div className="segment-group">
                    <label className="mini-label">Por origem</label>
                    <div className="segment-chips">
                      {allSources.map((src) => (
                        <button key={src} className={segmentFilter === `source:${src}` ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter(`source:${src}`)}>
                          {src} ({tenantLeads.filter((l) => l.utm_source === src).length})
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {allCampaigns.length > 0 && (
                  <div className="segment-group">
                    <label className="mini-label">Por campanha</label>
                    <div className="segment-chips">
                      {allCampaigns.slice(0, 10).map((c) => (
                        <button key={c} className={segmentFilter === `campaign:${c}` ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter(`campaign:${c}`)}>
                          {c} ({tenantLeads.filter((l) => l.utm_campaign === c).length})
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {allSegmentTags.length > 0 && (
                  <div className="segment-group">
                    <label className="mini-label">Por tag</label>
                    <div className="segment-chips">
                      {allSegmentTags.map((tag) => (
                        <button key={tag} className={segmentFilter === `tag:${tag}` ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter(`tag:${tag}`)}>
                          {tag} ({tenantLeads.filter((l) => l.tags?.includes(tag)).length})
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="segment-group">
                  <label className="mini-label">Especiais</label>
                  <div className="segment-chips">
                    <button className={segmentFilter === "no_phone" ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter("no_phone")}>
                      Sem telefone ({tenantLeads.filter((l) => !l.customer_phone).length})
                    </button>
                    <button className={segmentFilter === "high_value" ? "segment-chip active" : "segment-chip"} onClick={() => setSegmentFilter("high_value")}>
                      Vendas ({tenantLeads.filter((l) => l.lead_status === "sold" && (l.revenue ?? 0) > 0).length})
                    </button>
                  </div>
                </div>
              </div>

              <div className="segment-result-header">
                <strong>{segmentedLeads.length} leads</strong>
                <span className="muted">{segmentFilter === "all" ? "Todos os leads" : `Filtro: ${segmentFilter.replace(":", " → ")}`}</span>
              </div>

              <div className="segment-table-wrap">
                <table className="segment-table">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>Status</th>
                      <th>Telefone</th>
                      <th>Origem</th>
                      <th>Campanha</th>
                      <th>Tags</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segmentedLeads.slice(0, 50).map((lead) => (
                      <tr key={lead.id}>
                        <td>
                          <strong>{lead.customer_name || lead.ref}</strong>
                          <br /><small className="muted">{lead.offer_name || "-"}</small>
                        </td>
                        <td><Status status={lead.lead_status} /></td>
                        <td>{lead.customer_phone || <span className="muted">-</span>}</td>
                        <td>{lead.utm_source ? <span className="attr-source-tag attr-source-default">{lead.utm_source}</span> : <span className="muted">-</span>}</td>
                        <td><small>{lead.utm_campaign || "-"}</small></td>
                        <td>
                          <div className="tag-row">
                            {(lead.tags ?? []).map((t) => (
                              <span key={t} className="tag tag-removable" onClick={() => removeTagFromLead(lead.ref, t)} title="Clique para remover">
                                {t} ×
                              </span>
                            ))}
                          </div>
                          <div className="tag-add-row">
                            <input
                              placeholder="+ tag"
                              value={segmentTagInput && segmentBusy === lead.ref ? segmentTagInput : ""}
                              onChange={(e) => { setSegmentTagInput(e.target.value); setSegmentBusy(lead.ref); }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && segmentTagInput.trim()) {
                                  addTagToLead(lead.ref, segmentTagInput.trim().toLowerCase());
                                  setSegmentTagInput("");
                                }
                              }}
                              style={{ width: 80, fontSize: "0.78rem", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 4 }}
                            />
                          </div>
                        </td>
                        <td>
                          <button className="ghost-dark-button" onClick={() => focusCrmLead(lead)} style={{ fontSize: "0.78rem", padding: "2px 8px" }}>CRM</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {segmentedLeads.length > 50 && <p className="muted" style={{ textAlign: "center", marginTop: 8 }}>Exibindo 50 de {segmentedLeads.length} leads.</p>}
              </div>
            </section>
          </section>
        )}

        {active === "integrations" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Integração Meta</h2>
                  <p>Conecte Facebook, escolha o Pixel e valide CAPI sem abrir SQL.</p>
                </div>
                <ShieldCheck size={18} />
              </div>

              <div className="integration-grid">
                <article className="integration-card">
                  <span className="step-number">1</span>
                  <h3>Pixel e CAPI</h3>
                  <p>Padrão recomendado: cole o Pixel ID e o Token CAPI do Events Manager. Não depende de aprovação da Meta App.</p>
                  <div className="mini-form">
                    <input placeholder="Pixel ID" value={metaDraft.pixelId} onChange={(event) => setMetaDraft({ ...metaDraft, pixelId: event.target.value })} />
                    <input placeholder="Token CAPI" value={metaDraft.accessToken} onChange={(event) => setMetaDraft({ ...metaDraft, accessToken: event.target.value })} type="password" />
                    <input placeholder="Test Event Code opcional" value={metaDraft.testEventCode} onChange={(event) => setMetaDraft({ ...metaDraft, testEventCode: event.target.value })} />
                    <button className="ghost-dark-button" onClick={saveMetaManual} disabled={integrationBusy}>Salvar integração</button>
                  </div>
                </article>

                <article className="integration-card">
                  <span className="step-number">2</span>
                  <h3>Testar evento</h3>
                  <p>Envia um Lead de teste ao Events Manager para confirmar que o Meta recebeu.</p>
                  <button className="primary-button" onClick={testCapi} disabled={integrationBusy}>
                    Testar CAPI
                  </button>
                </article>

                <article className="integration-card muted-card">
                  <span className="step-number">3</span>
                  <h3>Facebook Ads</h3>
                  <p>Opcional: conecta a conta de anúncios para cruzar campanhas, gastos, CPL e ROAS com os leads do IDX.</p>
                  <div className="oauth-callback-box">
                    <span>URI de redirecionamento OAuth</span>
                    <div className="copy-line">
                      <code>{META_OAUTH_CALLBACK_URL}</code>
                      <button className="icon-button" onClick={copyMetaCallbackUrl} title="Copiar URL de retorno" type="button">
                        <Clipboard size={15} />
                      </button>
                    </div>
                  </div>
                  <button className="ghost-dark-button" onClick={startMetaLogin} disabled={integrationBusy}>
                    Conectar Facebook <ArrowRight size={16} />
                  </button>
                </article>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Conta de anúncios e Pixel</h2>
                  <p>Selecione os ativos reais do Facebook ou salve o ID da conta para sincronizar campanhas e públicos.</p>
                </div>
                <SlidersHorizontal size={18} />
              </div>
              <div className="asset-toolbar">
                <button className="primary-button" onClick={loadMetaAssets} disabled={integrationBusy}>
                  Buscar ativos Meta
                </button>
                <input placeholder="ID da conta de anúncios, ex: act_123456789" value={adAccountId} onChange={(event) => setAdAccountId(event.target.value)} />
                <button className="ghost-dark-button" onClick={saveMetaAssetSelection} disabled={integrationBusy}>
                  Salvar conta
                </button>
              </div>
              <MetaAssetsSelector
                accounts={metaAdAccounts}
                selected={selectedMetaAsset}
                loaded={metaAssetsLoaded}
                onChange={setSelectedMetaAsset}
                onSave={saveMetaAssetSelection}
                busy={integrationBusy}
              />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Gastos e campanhas</h2>
                  <p>Sincronize dados do Meta Ads para cruzar investimento com leads e vendas.</p>
                </div>
                <Activity size={18} />
              </div>
              <div className="ad-sync-row">
                <input placeholder="ID da conta de anúncios, ex: act_123456789" value={adAccountId} onChange={(event) => setAdAccountId(event.target.value)} />
                <button className="primary-button" onClick={syncMetaInsights} disabled={integrationBusy}>
                  Sincronizar Meta Ads
                </button>
              </div>
              <MetaRoiTable campaigns={tenantMetaCampaigns} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Google Ads</h2>
                  <p>Conecte o Google Ads para cruzar campanhas, gastos, CPL e ROAS com os leads do IDX.</p>
                </div>
                <Zap size={18} />
              </div>
              <GoogleAdsConnection
                creds={googleCreds}
                devTokenOk={googleDevTokenOk}
                busy={googleBusy}
                customers={googleCustomers}
                syncDays={googleSyncDays}
                onSyncDaysChange={setGoogleSyncDays}
                onConnect={startGoogleLogin}
                onListCustomers={listGoogleCustomers}
                onSelectCustomer={selectGoogleCustomer}
                onSync={syncGoogleAds}
                onDisconnect={disconnectGoogle}
                onOpenDashboard={() => goToSection("google-ads")}
              />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Supabase</h2>
                  <p>A plataforma já vem conectada. O cliente local não precisa logar no Supabase.</p>
                </div>
                <CircleDot size={18} />
              </div>
              <div className="supabase-box">
                <ReadOnly label="Status" value={supabaseStatus === "ok" ? "Conectado" : supabaseStatus === "error" ? "Atenção" : "Não testado"} />
                <ReadOnly label="Modo" value="Produção" />
                <ReadOnly label="Banco" value={supabaseHealth.database_model === "single_owned_multi_tenant" ? "Único IDX / multiempresa" : "IDX multiempresa"} />
                <ReadOnly label="Isolamento" value={supabaseHealth.tenant_isolation ?? "tenant_id + RLS"} />
                <ReadOnly label="Escopo" value={supabaseHealth.tenant_scope === "platform" ? "Gestor IDX" : "Empresa atual"} />
                <ReadOnly label="Projeto" value={String(import.meta.env.VITE_SUPABASE_URL || "Configurado no build")} />
                <button className="primary-button" onClick={checkSupabaseHealth} disabled={integrationBusy}>Verificar Supabase</button>
              </div>
            </section>
          </section>
        )}

        {active === "google-ads" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Google Ads</h2>
                  <p>Campanhas, investimento e atribuição com leads IDX.</p>
                </div>
                <Zap size={18} />
              </div>

              <GoogleAdsConnection
                creds={googleCreds}
                devTokenOk={googleDevTokenOk}
                busy={googleBusy}
                customers={googleCustomers}
                syncDays={googleSyncDays}
                onSyncDaysChange={setGoogleSyncDays}
                onConnect={startGoogleLogin}
                onListCustomers={listGoogleCustomers}
                onSelectCustomer={selectGoogleCustomer}
                onSync={syncGoogleAds}
                onDisconnect={disconnectGoogle}
              />
              {googleCampaigns.length > 0 && (
                <div className="kpi-grid" style={{ marginTop: 16 }}>
                  <Kpi label="Investimento" value={formatMoney(googleCampaigns.reduce((s, c) => s + Number(c.spend ?? 0), 0))} accent="#4285F4" />
                  <Kpi label="Impressões" value={googleCampaigns.reduce((s, c) => s + Number(c.impressions ?? 0), 0).toLocaleString("pt-BR")} accent="#4285F4" />
                  <Kpi label="Cliques" value={googleCampaigns.reduce((s, c) => s + Number(c.google_clicks ?? 0), 0).toLocaleString("pt-BR")} accent="#34A853" />
                  <Kpi label="Conversões Google" value={googleCampaigns.reduce((s, c) => s + Number(c.google_conversions ?? 0), 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} accent="#FBBC04" />
                  <Kpi label="Leads IDX" value={String(googleCampaigns.reduce((s, c) => s + Number(c.idx_leads ?? 0), 0))} accent="#FBBC04" />
                  <Kpi label="Vendas IDX" value={String(googleCampaigns.reduce((s, c) => s + Number(c.idx_sales ?? 0), 0))} accent="#EA4335" />
                  <Kpi label="Receita" value={formatMoney(googleCampaigns.reduce((s, c) => s + Number(c.idx_revenue ?? 0), 0))} accent="#34A853" />
                  <Kpi label="ROAS médio" value={(() => {
                    const totalSpend = googleCampaigns.reduce((s, c) => s + Number(c.spend ?? 0), 0);
                    const totalRevenue = googleCampaigns.reduce((s, c) => s + Number(c.idx_revenue ?? 0), 0);
                    return totalSpend > 0 ? `${(totalRevenue / totalSpend).toFixed(2)}x` : "—";
                  })()} accent="#4285F4" />
                </div>
              )}
            </section>

            {googleCampaigns.length > 0 && (
              <section className="panel wide">
                <div className="panel-head">
                  <div>
                    <h2>Campanhas Google Ads × IDX</h2>
                    <p>Investimento real cruzado com leads, vendas e receita do IDX.</p>
                  </div>
                  <Target size={18} />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Campanha</th>
                        <th>Status</th>
                        <th>Tipo</th>
                        <th>Investimento</th>
                        <th>Impressões</th>
                        <th>Cliques</th>
                        <th>CTR</th>
                        <th>CPC</th>
                        <th>Conv. Google</th>
                        <th>Leads</th>
                        <th>Qualif.</th>
                        <th>Vendas</th>
                        <th>Receita</th>
                        <th>CPL</th>
                        <th>CPV</th>
                        <th>ROAS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {googleCampaigns.map((c) => (
                        <tr key={c.campaign_id}>
                          <td title={c.campaign_id}>{c.campaign_name}</td>
                          <td><span className={`status-badge ${c.campaign_status === "ENABLED" ? "active" : "inactive"}`}>{c.campaign_status === "ENABLED" ? "Ativa" : c.campaign_status ?? "—"}</span></td>
                          <td>{c.campaign_type ?? "—"}</td>
                          <td>{formatMoney(c.spend)}</td>
                          <td>{c.impressions?.toLocaleString("pt-BR") ?? 0}</td>
                          <td>{c.google_clicks?.toLocaleString("pt-BR") ?? 0}</td>
                          <td>{Number(c.impressions) > 0 ? `${((Number(c.google_clicks) / Number(c.impressions)) * 100).toFixed(2)}%` : "—"}</td>
                          <td>{Number(c.google_clicks) > 0 ? formatMoney(Number(c.spend) / Number(c.google_clicks)) : "—"}</td>
                          <td>{Number(c.google_conversions ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</td>
                          <td>{c.idx_leads}</td>
                          <td>{c.idx_qualified}</td>
                          <td>{c.idx_sales}</td>
                          <td>{formatMoney(c.idx_revenue)}</td>
                          <td>{c.cpl != null ? formatMoney(c.cpl) : "—"}</td>
                          <td>{c.cpv != null ? formatMoney(c.cpv) : "—"}</td>
                          <td>{c.roas != null ? `${c.roas}x` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {googleCampaigns.length === 0 && googleCreds?.stage === "account_selected" && (
              <EmptyState text="Conta vinculada. Clique em Sincronizar para importar as campanhas." />
            )}
          </section>
        )}

        {active === "whatsapp" && (
          <section className="stack">
            <div className="wa-tab-bar">
              <button className={waTab === "conversations" ? "active" : ""} onClick={() => setWaTab("conversations")}>
                <MessageCircle size={15} style={{ verticalAlign: "middle", marginRight: 4 }} /> Conversas
              </button>
              <button className={waTab === "instances" ? "active" : ""} onClick={() => setWaTab("instances")}>
                <Wifi size={15} style={{ verticalAlign: "middle", marginRight: 4 }} /> Instâncias
              </button>
              <button className={waTab === "config" ? "active" : ""} onClick={() => setWaTab("config")}>
                <SlidersHorizontal size={15} style={{ verticalAlign: "middle", marginRight: 4 }} /> Config
              </button>
            </div>

            {waTab === "conversations" && (
              <div className="wa-chat-layout">
                <div className="wa-contact-list">
                  <div className="wa-contact-search">
                    <input placeholder="Buscar contato..." value={waConvSearch} onChange={(e) => setWaConvSearch(e.target.value)} />
                  </div>
                  {filteredConversations.length === 0 && (
                    <div style={{ padding: "2rem 1rem", textAlign: "center", color: "var(--muted)" }}>
                      {waConversations.length === 0 ? "Nenhuma conversa ainda. Conecte uma instância e aguarde mensagens." : "Nenhum resultado."}
                    </div>
                  )}
                  {filteredConversations.map((conv) => {
                    const c = conv.contact;
                    const initials = (c?.push_name ?? c?.wa_id ?? "?").slice(0, 2).toUpperCase();
                    const linkedLead = waConvLeadLink(conv);
                    const sentimentEmoji = conv.ai_sentiment === "positive" ? "+" : conv.ai_sentiment === "negative" ? "-" : "";
                    return (
                      <div
                        key={conv.id}
                        className={`wa-contact-item${conv.id === waSelectedConvId ? " active" : ""}`}
                        onClick={() => selectConversation(conv.id)}
                      >
                        <div className="wa-contact-avatar">{initials}</div>
                        <div className="wa-contact-info">
                          <div className="wa-contact-name">
                            {c?.push_name || c?.phone || c?.wa_id || "Desconhecido"}
                            {linkedLead && <span className="wa-link-pill" style={{ marginLeft: 6 }}>CRM</span>}
                            {conv.ai_analyzed_at && sentimentEmoji && (
                              <span className={`wa-sentiment-dot ${conv.ai_sentiment}`} title={`Sentimento: ${conv.ai_sentiment}`}>{sentimentEmoji}</span>
                            )}
                          </div>
                          <div className="wa-contact-preview">
                            {cleanAiText(conv.ai_summary) || (c?.phone ? c.phone : c?.wa_id)}
                          </div>
                        </div>
                        <div className="wa-contact-meta">
                          {conv.last_message_at && <div className="wa-contact-time">{timeAgo(conv.last_message_at)}</div>}
                          {conv.unread_count > 0 && <div className="wa-contact-badge">{conv.unread_count}</div>}
                          {conv.ai_purchase_probability != null && conv.ai_purchase_probability > 0.3 && (
                            <div className="wa-purchase-badge" title={`Probabilidade: ${Math.round(conv.ai_purchase_probability * 100)}%`}>
                              {Math.round(conv.ai_purchase_probability * 100)}%
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {!waSelectedConvId ? (
                  <div className="wa-empty-thread">
                    <div style={{ textAlign: "center" }}>
                      <MessageCircle size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
                      <div>Selecione uma conversa para ver as mensagens</div>
                      <button className="ghost-dark-button" onClick={loadWaConversations} style={{ marginTop: 12 }}>
                        <RefreshCw size={14} style={{ marginRight: 4 }} /> Atualizar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="wa-thread">
                    <div className="wa-thread-header">
                      <div className="wa-contact-avatar" style={{ width: 36, height: 36, fontSize: "0.8rem" }}>
                        {(selectedContact?.push_name ?? selectedContact?.wa_id ?? "?").slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="wa-thread-header-name">
                          {selectedContact?.push_name || selectedContact?.phone || selectedContact?.wa_id || "Contato"}
                        </div>
                        <div className="wa-thread-header-sub">
                          {selectedContact?.phone || selectedContact?.wa_id}
                          {selectedConv?.tracking_session_id && (() => {
                            const lead = waConvLeadLink(selectedConv);
                            if (!lead) return " · Vinculado ao CRM";
                            const origin = lead.utm_campaign && lead.utm_source
                              ? `${lead.utm_source}/${lead.utm_campaign}`
                              : null;
                            return (
                              <>
                                {` · Lead: ${lead.ref} (${lead.lead_status})`}
                                {origin ? (
                                  <span className="origin-badge origin-known" style={{ marginLeft: 6 }}>{origin}</span>
                                ) : (
                                  <span className="origin-badge" style={{ marginLeft: 6 }}>Origem desconhecida</span>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {waInsight && (
                      <div className="wa-ai-panel">
                        <button className="wa-ai-panel-toggle" onClick={() => setWaInsightOpen(!waInsightOpen)}>
                          <Brain size={16} />
                          <span>Análise IA</span>
                          {waInsight.sentiment && (
                            <span className={`wa-ai-sentiment-chip ${waInsight.sentiment}`}>
                              {waInsight.sentiment === "positive" ? "Positivo" : waInsight.sentiment === "negative" ? "Negativo" : "Neutro"}
                            </span>
                          )}
                          {(waInsight.purchase_probability ?? 0) > 0.3 && (
                            <span className="wa-ai-prob-chip">
                              <TrendingUp size={12} /> {Math.round((waInsight.purchase_probability ?? 0) * 100)}%
                            </span>
                          )}
                          {waInsightOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                        {waInsightOpen && (
                          <div className="wa-ai-panel-body">
                            {cleanAiText(waInsight.summary) && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Resumo</div>
                                <div className="wa-ai-section-text">{cleanAiText(waInsight.summary)}</div>
                              </div>
                            )}
                            {cleanAiText(waInsight.intent) && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Intenção</div>
                                <div className="wa-ai-section-text">{cleanAiText(waInsight.intent)}</div>
                              </div>
                            )}
                            {(waInsight.purchase_probability ?? 0) > 0 && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Probabilidade de compra</div>
                                <div className="wa-ai-prob-bar-wrap">
                                  <div className="wa-ai-prob-bar" style={{ width: `${Math.round((waInsight.purchase_probability ?? 0) * 100)}%` }} />
                                  <span>{Math.round((waInsight.purchase_probability ?? 0) * 100)}%</span>
                                </div>
                              </div>
                            )}
                            {(cleanAiText(waInsight.extracted_name) || cleanAiText(waInsight.extracted_email) || cleanAiText(waInsight.extracted_phone) || cleanAiText(waInsight.extracted_address)) && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Dados extraídos</div>
                                <div className="wa-ai-extracted-grid">
                                  {cleanAiText(waInsight.extracted_name) && <div><strong>Nome:</strong> {cleanAiText(waInsight.extracted_name)}</div>}
                                  {cleanAiText(waInsight.extracted_phone) && <div><strong>Telefone:</strong> {cleanAiText(waInsight.extracted_phone)}</div>}
                                  {cleanAiText(waInsight.extracted_email) && <div><strong>Email:</strong> {cleanAiText(waInsight.extracted_email)}</div>}
                                  {cleanAiText(waInsight.extracted_address) && <div><strong>Endereço:</strong> {cleanAiText(waInsight.extracted_address)}</div>}
                                </div>
                              </div>
                            )}
                            {cleanAiArray(waInsight.products_of_interest).length > 0 ? (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Produtos de interesse</div>
                                <div className="wa-ai-tags">
                                  {cleanAiArray(waInsight.products_of_interest).map((p, i) => <span key={i} className="wa-ai-tag">{p}</span>)}
                                </div>
                              </div>
                            ) : waInsight.updated_at ? (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Produtos de interesse</div>
                                <div className="wa-ai-section-text empty-hint">Nenhum identificado</div>
                              </div>
                            ) : null}
                            {cleanAiArray(waInsight.objections).length > 0 ? (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Objeções</div>
                                <div className="wa-ai-tags">
                                  {cleanAiArray(waInsight.objections).map((o, i) => <span key={i} className="wa-ai-tag objection">{o}</span>)}
                                </div>
                              </div>
                            ) : waInsight.updated_at ? (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Objeções</div>
                                <div className="wa-ai-section-text empty-hint">Nenhum identificado</div>
                              </div>
                            ) : null}
                            {cleanAiText(waInsight.commercial_notes) && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Notas comerciais</div>
                                <div className="wa-ai-section-text">{cleanAiText(waInsight.commercial_notes)}</div>
                              </div>
                            )}
                            {waSaleSignals.length > 0 && (
                              <div className="wa-ai-section">
                                <div className="wa-ai-section-title">Sinais de venda</div>
                                {waSaleSignals.map((sig) => (
                                  <div key={sig.id} className={`wa-ai-signal wa-ai-signal-${sig.signal_type}`}>
                                    <div className="wa-ai-signal-header">
                                      <span className="wa-ai-signal-type">
                                        {sig.signal_type === "interest" ? "Interesse" : sig.signal_type === "high_intent" ? "Alta intenção" : sig.signal_type === "negotiation" ? "Negociação" : sig.signal_type === "declared_purchase" ? "Compra declarada" : sig.signal_type === "confirmed_sale" ? "Venda confirmada" : sig.signal_type === "abandonment" ? "Abandono" : sig.signal_type === "commitment" ? "Compromisso" : "Pós-venda"}
                                      </span>
                                      {sig.confidence != null && <span className="wa-ai-signal-conf">{Math.round(sig.confidence * 100)}% confiança</span>}
                                      <span className={`wa-ai-signal-status ${sig.status}`}>
                                        {sig.status === "detected" ? "Detectado" : sig.status === "confirmed" ? "Confirmado" : sig.status === "rejected" ? "Rejeitado" : "Convertido"}
                                      </span>
                                    </div>
                                    {cleanAiText(sig.product_name) && <div className="wa-ai-signal-product">{cleanAiText(sig.product_name)}{sig.estimated_value ? ` · ${formatMoney(sig.estimated_value)}` : ""}</div>}
                                    {cleanAiText(sig.evidence_text) && <div className="wa-ai-signal-evidence">"{cleanAiText(sig.evidence_text)}"</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="wa-ai-footer">
                              {waInsight.messages_analyzed_count != null && <span>{waInsight.messages_analyzed_count} mensagens analisadas</span>}
                              {waInsight.model_used && <span>Modelo: {waInsight.model_used}</span>}
                              {waInsight.updated_at && <span>Última análise: {timeAgo(waInsight.updated_at)}</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="wa-thread-messages">
                      {waMessages.reduce<{ elements: React.ReactNode[]; lastDate: string }>((acc, msg) => {
                        const msgDate = formatMsgDate(msg.timestamp);
                        if (msgDate !== acc.lastDate) {
                          acc.elements.push(
                            <div key={`date-${msgDate}`} className="wa-date-sep"><span>{msgDate}</span></div>
                          );
                          acc.lastDate = msgDate;
                        }
                        acc.elements.push(
                          <div key={msg.id} className={`wa-msg ${msg.direction}`}>
                            {msg.content_type === "text" ? (
                              <div>{msg.body}</div>
                            ) : msg.content_type === "image" && msg.media_url ? (
                              <>
                                <img src={msg.media_url} alt="Imagem" className="wa-msg-media" />
                                {msg.body && <div>{msg.body}</div>}
                              </>
                            ) : msg.content_type === "audio" ? (
                              <div className="wa-msg-type-badge">Áudio {msg.media_url && <audio controls src={msg.media_url} style={{ maxWidth: 220 }} />}</div>
                            ) : msg.content_type === "video" && msg.media_url ? (
                              <video controls src={msg.media_url} className="wa-msg-media" />
                            ) : msg.content_type === "document" ? (
                              <div className="wa-msg-type-badge">Documento{msg.body ? `: ${msg.body}` : ""}</div>
                            ) : msg.content_type === "sticker" ? (
                              <div className="wa-msg-type-badge">Sticker</div>
                            ) : msg.content_type === "location" ? (
                              <div className="wa-msg-type-badge">Localização</div>
                            ) : msg.content_type === "contact" ? (
                              <div className="wa-msg-type-badge">Contato compartilhado</div>
                            ) : msg.content_type === "reaction" ? (
                              <div style={{ fontSize: "1.4rem" }}>{msg.body}</div>
                            ) : (
                              <div className="wa-msg-type-badge">{msg.content_type}{msg.body ? `: ${msg.body}` : ""}</div>
                            )}
                            <div className="wa-msg-time">
                              {formatMsgTime(msg.timestamp)}
                              {msg.direction === "outbound" && (
                                <span className="wa-msg-status" style={{ color: msg.status === "read" ? "#53bdeb" : undefined }}>
                                  {msgStatusIcon(msg.status)}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                        return acc;
                      }, { elements: [], lastDate: "" }).elements}
                      <div ref={messagesEndRef} />
                    </div>

                    <div className="wa-readonly-bar">
                      Modo leitura — o IDX não envia mensagens pelo WhatsApp
                    </div>
                  </div>
                )}
              </div>
            )}

            {waTab === "instances" && (
              <section className="stack">
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Instâncias WhatsApp</h2>
                      <p>Gerencie conexões com a Evolution API. Cada empresa pode ter uma ou mais instâncias.</p>
                    </div>
                    <MessageCircle size={18} />
                  </div>

                  <div className="mini-form" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <input placeholder="Nome da instância" value={waNewInstanceName} onChange={(e) => setWaNewInstanceName(e.target.value)} style={{ flex: "1 1 180px" }} />
                    <input placeholder="URL da Evolution API" value={waNewInstanceUrl} onChange={(e) => setWaNewInstanceUrl(e.target.value)} style={{ flex: "1 1 240px" }} />
                    <button className="primary-button" onClick={createWaInstance} disabled={waBusy || !waNewInstanceName.trim()}>Criar instância</button>
                  </div>

                  <div style={{ marginTop: "0.75rem" }}>
                    <label className="mini-label">API Key da Evolution (necessária para conectar)</label>
                    <input
                      type="password"
                      placeholder="Cole aqui a API Key da sua Evolution API"
                      value={waEvoApiKey}
                      onChange={(e) => setWaEvoApiKey(e.target.value)}
                      style={{ width: "100%", maxWidth: 480 }}
                    />
                  </div>

                  {waInstances.length === 0 && !waBusy && (
                    <p style={{ opacity: 0.6, marginTop: "0.75rem" }}>Nenhuma instância cadastrada.</p>
                  )}

                  {waInstances.map((inst) => (
                    <div key={inst.id} className="panel" style={{ marginTop: "0.75rem", padding: "1rem", border: "1px solid var(--line)", borderRadius: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
                        <div>
                          <strong>{inst.instance_name}</strong>
                          <span style={{ marginLeft: 8, fontSize: "0.82rem", color: "var(--muted)" }}>{inst.provider === "evolution" ? "Evolution API" : "Cloud API"}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            padding: "2px 8px",
                            borderRadius: 6,
                            background: inst.mode === "production" ? "rgba(37,211,102,0.15)" : "rgba(255,193,7,0.18)",
                            color: inst.mode === "production" ? "#25d366" : "#d4a017",
                          }}>
                            {inst.mode === "production" ? "Produção" : "Teste"}
                          </span>
                          {inst.status === "connected" ? <Wifi size={14} color="#25d366" /> : <WifiOff size={14} color="var(--muted)" />}
                          <span className={`status-dot ${inst.status === "connected" ? "status-active" : inst.status === "connecting" ? "status-warn" : "status-off"}`} />
                          {inst.status === "connected" ? "Conectado" : inst.status === "connecting" ? "Conectando" : inst.status === "banned" ? "Banido" : "Desconectado"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                        <span>Tel: {inst.phone_number ?? "-"}</span>
                        <span>Último: {inst.last_seen_at ? timeAgo(inst.last_seen_at) : "-"}</span>
                        {inst.api_url && <span>API: {inst.api_url}</span>}
                      </div>

                      {inst.qr_code_data && inst.status !== "connected" && (
                        <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                          <p style={{ fontSize: "0.85rem", marginBottom: 8 }}>Escaneie o QR Code abaixo com o WhatsApp:</p>
                          <img
                            src={inst.qr_code_data.startsWith("data:") ? inst.qr_code_data : `data:image/png;base64,${inst.qr_code_data}`}
                            alt="QR Code"
                            style={{ width: 200, height: 200, borderRadius: 10, background: "#fff", padding: 8, border: "1px solid var(--line)" }}
                          />
                        </div>
                      )}

                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem", alignItems: "center" }}>
                        {inst.status !== "connected" && (
                          <button className="primary-button" onClick={() => connectEvoInstance(inst.id)} disabled={waBusy || !waEvoApiKey.trim()}>
                            {inst.qr_code_data ? "Gerar novo QR" : "Conectar (QR Code)"}
                          </button>
                        )}
                        {inst.status === "connected" && (
                          <button className="ghost-dark-button" onClick={() => disconnectEvoInstance(inst.id)} disabled={waBusy} style={{ color: "#e74c3c" }}>
                            <WifiOff size={13} style={{ marginRight: 3 }} /> Desconectar
                          </button>
                        )}
                        <button className="ghost-dark-button" onClick={() => checkEvoStatus(inst.id)} disabled={waBusy}>
                          <RefreshCw size={13} style={{ marginRight: 3 }} /> Verificar status
                        </button>
                        <button
                          className="ghost-dark-button"
                          onClick={() => setInstanceMode(inst.id, inst.mode === "production" ? "test" : "production")}
                          disabled={waBusy}
                          style={{ fontSize: "0.82rem" }}
                        >
                          {inst.mode === "production" ? "Mudar p/ Teste" : "Mudar p/ Produção"}
                        </button>
                        {inst.mode !== "production" && (
                          <button className="ghost-dark-button" onClick={() => purgeTestData(inst.id)} disabled={waBusy} style={{ fontSize: "0.8rem", color: "#e74c3c" }}>
                            Limpar dados de teste
                          </button>
                        )}
                        <button className="ghost-dark-button" onClick={() => deleteWaInstance(inst.id)} disabled={waBusy} style={{ marginLeft: "auto", fontSize: "0.8rem", opacity: 0.7 }}>
                          Remover
                        </button>
                      </div>
                    </div>
                  ))}

                  <button className="ghost-dark-button" onClick={loadWaInstances} disabled={waBusy} style={{ marginTop: "0.75rem" }}>
                    <RefreshCw size={13} style={{ marginRight: 3 }} /> Atualizar lista
                  </button>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Chaves de API (Webhook)</h2>
                      <p>Gere chaves para autenticar os webhooks do n8n.</p>
                    </div>
                    <ShieldCheck size={18} />
                  </div>

                  <div className="mini-form" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <input placeholder="Rótulo (ex: n8n-producao)" value={waNewKeyLabel} onChange={(e) => setWaNewKeyLabel(e.target.value)} style={{ flex: "1 1 200px" }} />
                    <button className="primary-button" onClick={generateWaKey} disabled={waBusy}>Gerar chave</button>
                  </div>

                  {waGeneratedKey && (
                    <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "var(--soft)", borderRadius: 8, wordBreak: "break-all" }}>
                      <label className="mini-label">Chave gerada (copie agora)</label>
                      <div className="copy-line">
                        <code style={{ fontSize: "0.85rem" }}>{waGeneratedKey}</code>
                        <button className="icon-button" onClick={() => { navigator.clipboard.writeText(waGeneratedKey); setToast("Chave copiada."); }} title="Copiar chave" type="button">
                          <Clipboard size={15} />
                        </button>
                      </div>
                    </div>
                  )}

                  {waKeys.length > 0 && (
                    <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
                      <table>
                        <thead>
                          <tr><th>Rótulo</th><th>Status</th><th>Último uso</th><th>Criada em</th><th></th></tr>
                        </thead>
                        <tbody>
                          {waKeys.map((k) => (
                            <tr key={k.id}>
                              <td>{k.label}</td>
                              <td>
                                <span className={`status-dot ${k.status === "active" ? "status-active" : "status-off"}`} />
                                {k.status === "active" ? "Ativa" : "Revogada"}
                              </td>
                              <td>{k.last_used_at ? timeAgo(k.last_used_at) : "Nunca"}</td>
                              <td>{formatDate(k.created_at)}</td>
                              <td>
                                {k.status === "active" && (
                                  <button className="ghost-dark-button" onClick={() => revokeWaKey(k.id)} disabled={waBusy} style={{ fontSize: "0.8rem" }}>Revogar</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </section>
            )}

            {waTab === "config" && (
              <section className="stack">
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Configuração n8n</h2>
                      <p>Use o endpoint abaixo no n8n para enviar eventos da Evolution API ao IDX.</p>
                    </div>
                    <SlidersHorizontal size={18} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <div>
                      <label className="mini-label">URL do Webhook</label>
                      <div className="copy-line">
                        <code style={{ fontSize: "0.85rem" }}>{String(import.meta.env.VITE_SUPABASE_URL || "https://tykeycwworjtfpssjevw.supabase.co")}/functions/v1/n8n-webhook</code>
                        <button className="icon-button" onClick={() => { navigator.clipboard.writeText(`${String(import.meta.env.VITE_SUPABASE_URL || "https://tykeycwworjtfpssjevw.supabase.co")}/functions/v1/n8n-webhook`); setToast("URL copiada."); }} title="Copiar URL" type="button">
                          <Clipboard size={15} />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="mini-label">Header de autenticação</label>
                      <div className="copy-line">
                        <code style={{ fontSize: "0.85rem" }}>x-api-key: [sua chave gerada na aba Instâncias]</code>
                      </div>
                    </div>
                    <div>
                      <label className="mini-label">Método</label>
                      <code style={{ fontSize: "0.85rem" }}>POST</code>
                    </div>
                    <div>
                      <label className="mini-label">Ações disponíveis</label>
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        {["connection_status", "message_received", "message_sent", "message_status"].map((a) => (
                          <span key={a} className="tag-pill">{a}</span>
                        ))}
                      </div>
                    </div>
                    <details style={{ marginTop: "0.25rem" }}>
                      <summary style={{ cursor: "pointer", fontWeight: 500 }}>Exemplo de payload</summary>
                      <pre style={{ fontSize: "0.8rem", padding: "0.75rem", background: "var(--soft)", borderRadius: 8, overflowX: "auto", marginTop: "0.5rem" }}>{`{
  "action": "message_received",
  "instance": "nome-da-instancia",
  "data": {
    "key": {
      "remoteJid": "5511999998888@s.whatsapp.net",
      "fromMe": false,
      "id": "ABC123"
    },
    "pushName": "Cliente",
    "messageType": "conversation",
    "message": {
      "conversation": "Olá, tenho interesse!"
    },
    "messageTimestamp": 1697200000
  }
}`}</pre>
                    </details>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Fluxo da integração</h2>
                      <p>Como o WhatsApp chega ao IDX CRO Engine.</p>
                    </div>
                    <ArrowRight size={18} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.88rem" }}>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span className="tag-pill">1</span> Crie uma instância na aba Instâncias e conecte via QR Code
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span className="tag-pill">2</span> Configure o webhook da Evolution API para enviar eventos ao n8n
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span className="tag-pill">3</span> No n8n, crie um workflow que receba os eventos e envie ao endpoint acima com a API Key
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span className="tag-pill">4</span> As mensagens aparecem automaticamente na aba Conversas em tempo real
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span className="tag-pill">5</span> Contatos são vinculados ao CRM pelo telefone quando há correspondência
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>WhatsApp Oficial (Cloud API)</h2>
                      <p>Para empresas que desejam usar a API oficial do WhatsApp Business Platform.</p>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <div className="cloud-api-info">
                    <p style={{ fontSize: "0.88rem", color: "var(--muted)", marginBottom: "1rem" }}>
                      A Cloud API é a integração oficial da Meta para WhatsApp Business. Diferente da Evolution API (não-oficial),
                      ela oferece selo de verificação, maior estabilidade e conformidade com políticas da Meta.
                    </p>
                    <div className="cloud-api-comparison">
                      <div className="comparison-col">
                        <strong>Evolution API</strong>
                        <ul>
                          <li>Gratuita / auto-hospedada</li>
                          <li>Sem aprovação da Meta</li>
                          <li>Risco de banimento</li>
                          <li>Setup rápido via QR Code</li>
                        </ul>
                      </div>
                      <div className="comparison-col highlight">
                        <strong>Cloud API (Oficial)</strong>
                        <ul>
                          <li>Plataforma oficial da Meta</li>
                          <li>Selo verde / verificado</li>
                          <li>Sem risco de banimento</li>
                          <li>Requer conta Meta Business</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1rem" }}>
                    <div>
                      <label className="mini-label">Phone Number ID *</label>
                      <input
                        placeholder="Ex: 123456789012345"
                        value={waCloudPhoneId}
                        onChange={(e) => setWaCloudPhoneId(e.target.value)}
                        style={{ width: "100%", maxWidth: 400 }}
                      />
                      <small className="muted" style={{ display: "block", marginTop: 2 }}>
                        Encontre em Meta Business Suite &gt; WhatsApp &gt; Configurações da API
                      </small>
                    </div>
                    <div>
                      <label className="mini-label">WhatsApp Business Account ID</label>
                      <input
                        placeholder="Ex: 987654321098765"
                        value={waCloudWabaId}
                        onChange={(e) => setWaCloudWabaId(e.target.value)}
                        style={{ width: "100%", maxWidth: 400 }}
                      />
                    </div>
                    <div>
                      <label className="mini-label">Access Token permanente *</label>
                      <input
                        type="password"
                        placeholder="Token de acesso do sistema"
                        value={waCloudToken}
                        onChange={(e) => setWaCloudToken(e.target.value)}
                        style={{ width: "100%", maxWidth: 400 }}
                      />
                      <small className="muted" style={{ display: "block", marginTop: 2 }}>
                        Gere um token de sistema permanente em developers.facebook.com &gt; Configurações do app
                      </small>
                    </div>
                    <div>
                      <label className="mini-label">Verify Token (para webhook)</label>
                      <input
                        placeholder="Token de verificação personalizado"
                        value={waCloudVerifyToken}
                        onChange={(e) => setWaCloudVerifyToken(e.target.value)}
                        style={{ width: "100%", maxWidth: 400 }}
                      />
                      <small className="muted" style={{ display: "block", marginTop: 2 }}>
                        Defina um token para validar o webhook da Meta (será usado na verificação do endpoint).
                      </small>
                    </div>
                    <button
                      className="primary-button"
                      onClick={createCloudApiInstance}
                      disabled={waCloudBusy || !waCloudPhoneId.trim() || !waCloudToken.trim()}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {waCloudBusy ? "Criando..." : "Criar instância Cloud API"}
                    </button>
                  </div>

                  {waInstances.filter((i) => i.provider === "cloud_api").length > 0 && (
                    <div style={{ marginTop: "1rem" }}>
                      <label className="mini-label">Instâncias Cloud API ativas</label>
                      {waInstances.filter((i) => i.provider === "cloud_api").map((inst) => (
                        <div key={inst.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--line)" }}>
                          <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>{inst.instance_name}</span>
                          <span className={`status-dot ${inst.status === "connected" ? "status-active" : "status-off"}`} />
                          <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{inst.status === "connected" ? "Conectado" : inst.status}</span>
                          <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>Tel: {inst.phone_number ?? "-"}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <details style={{ marginTop: "1rem" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 500, fontSize: "0.9rem" }}>Como configurar o webhook da Cloud API</summary>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem", fontSize: "0.85rem" }}>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <span className="tag-pill">1</span> Acesse Meta Business Suite &gt; WhatsApp &gt; Configurações
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <span className="tag-pill">2</span> Em Webhook, configure a URL de callback:
                      </div>
                      <div className="copy-line" style={{ marginLeft: 32 }}>
                        <code style={{ fontSize: "0.82rem" }}>{String(import.meta.env.VITE_SUPABASE_URL || "https://tykeycwworjtfpssjevw.supabase.co")}/functions/v1/n8n-webhook</code>
                        <button className="icon-button" onClick={() => { navigator.clipboard.writeText(`${String(import.meta.env.VITE_SUPABASE_URL || "https://tykeycwworjtfpssjevw.supabase.co")}/functions/v1/n8n-webhook`); setToast("URL copiada."); }} title="Copiar URL" type="button">
                          <Clipboard size={15} />
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <span className="tag-pill">3</span> Use o Verify Token definido acima
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <span className="tag-pill">4</span> Assine os campos: messages, message_deliveries, message_reads
                      </div>
                    </div>
                  </details>
                </section>
              </section>
            )}
          </section>
        )}

        {active === "clients" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{isPlatformUser ? "Central do gestor IDX" : "Empresa vinculada"}</h2>
                  <p>{isPlatformUser ? "Cadastre, selecione e audite todos os clientes locais em uma conta de gestão." : "Seu acesso fica limitado às empresas nas quais você foi adicionado."}</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <div className="permission-grid">
                <ReadOnly label="Seu acesso" value={isPlatformUser ? `Gestor IDX - ${platformRoleLabel(platformRole)}` : "Cliente ou colaborador"} />
                <ReadOnly label="Empresas visíveis" value={String(tenants.length)} />
                <ReadOnly label="Empresa atual" value={tenant?.name ?? "-"} />
                <ReadOnly label="Stakeholders" value={String(tenantSummary?.tenant_users ?? tenantUsers.length)} />
              </div>
            </section>

            {canCreateClients && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Novo cliente local</h2>
                    <p>Crie pet shop, autoescola, clínica ou qualquer negócio local com dados reais.</p>
                  </div>
                  <Plus size={18} />
                </div>
                <div className="client-form">
                  <input placeholder="Nome da empresa" value={clientDraft.name} onChange={(event) => setClientDraft({ ...clientDraft, name: event.target.value, slug: slugify(event.target.value) })} />
                  <input placeholder="Segmento" value={clientDraft.businessSegment} onChange={(event) => setClientDraft({ ...clientDraft, businessSegment: event.target.value })} />
                  <input placeholder="Slug" value={clientDraft.slug} onChange={(event) => setClientDraft({ ...clientDraft, slug: slugify(event.target.value) })} />
                  <input placeholder="WhatsApp com DDI e DDD" value={clientDraft.whatsapp} onChange={(event) => setClientDraft({ ...clientDraft, whatsapp: event.target.value })} />
                  <input placeholder="Cidade" value={clientDraft.city} onChange={(event) => setClientDraft({ ...clientDraft, city: event.target.value })} />
                  <input placeholder="UF" maxLength={2} value={clientDraft.state} onChange={(event) => setClientDraft({ ...clientDraft, state: event.target.value.toUpperCase() })} />
                  <input placeholder="Responsável" value={clientDraft.responsibleName} onChange={(event) => setClientDraft({ ...clientDraft, responsibleName: event.target.value })} />
                  <button className="primary-button" onClick={createClient}>Criar cliente</button>
                </div>
              </section>
            )}

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Saúde dos clientes</h2>
                  <p>Auditoria rápida para saber quem está pronto, quem precisa implantação e onde agir.</p>
                </div>
                <Activity size={18} />
              </div>
              <ClientHealthTable tenants={tenants} summaries={tenantSummaries} selectedTenantId={tenant?.id} onSelect={async (id) => {
                setTenantId(id);
                if (isConfigured) await loadTenantData(id);
              }} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{isPlatformUser ? "Clientes" : "Minhas empresas"}</h2>
                  <p>{isPlatformUser ? "Empresas conectadas à sua operação de CRO local." : "Empresas liberadas para o seu login."}</p>
                </div>
              </div>
              <div className="client-grid">
                {tenants.map((item) => {
                  const summary = tenantSummaries.find((summary) => summary.tenant_id === item.id);
                  return (
                    <button
                      className={`client-card ${item.id === tenant?.id ? "selected" : ""}`}
                      key={item.id}
                      onClick={async () => {
                        setTenantId(item.id);
                        if (isConfigured) await loadTenantData(item.id);
                      }}
                    >
                      <strong>{item.name}</strong>
                      <span>{item.slug}</span>
                      <span>{tenantAccessUrl(item.slug)}</span>
                      <small>{summary ? `${summary.tenant_users} stakeholders · ${summary.smart_links} links · ${summary.tracking_sessions} cliques` : item.whatsapp_number}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          </section>
        )}

        {active === "users" && (
          <section className="stack">
            <section className="panel access-hero-panel">
              <div className="panel-head">
                <div>
                  <h2>Enviar acesso de vendedor</h2>
                  <p>Libere um login simples para atendimento. O vendedor entra direto na fila, atualiza o CRM e não vê integrações, clientes ou configurações.</p>
                </div>
                <UserPlus size={18} />
              </div>
              <div className="access-hero-grid">
                <div className="seller-invite-box">
                  <div className="access-kicker">
                    <span>{sellerUsers.length}</span>
                    <strong>vendedores ativos nesta empresa</strong>
                  </div>
                  <div className="seller-invite-form">
                    <label>
                      Email do vendedor
                      <input
                        type="email"
                        placeholder="vendedor@empresa.com"
                        value={sellerInviteEmail}
                        onChange={(event) => setSellerInviteEmail(event.target.value)}
                      />
                    </label>
                    <button
                      className="primary-button"
                      onClick={() => inviteUser({
                        email: sellerInviteEmail,
                        role: "operator",
                        successMessage: "Acesso de vendedor enviado por email.",
                      })}
                    >
                      Enviar acesso
                    </button>
                  </div>
                  <div className="seller-permission-strip">
                    <span>Atender leads</span>
                    <span>Qualificar</span>
                    <span>Registrar venda</span>
                    <span>Sem painel gerencial</span>
                  </div>
                </div>

                <SellerAccessPreview />
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Outros acessos da empresa</h2>
                  <p>Use para donos, gestores, administradores e visualizadores. Cada login fica vinculado apenas à empresa selecionada.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <div className="user-form">
                <input placeholder="email@empresa.com" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} />
                <select value={inviteDraft.role} onChange={(event) => setInviteDraft({ ...inviteDraft, role: event.target.value as InviteDraft["role"] })}>
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="operator">CRM / Atendimento</option>
                  <option value="viewer">Visualizador</option>
                </select>
                <button className="primary-button" onClick={() => inviteUser()}>Enviar convite</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Acessos desta empresa</h2>
                  <p>Quem pode entrar no painel da {tenant?.name ?? "empresa"} e qual experiência cada pessoa recebe.</p>
                </div>
                <Users size={18} />
              </div>
              <TenantUsersList users={tenantUsers} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Permissões</h2>
                  <p>Modelo de papéis para clientes locais e operação IDX.</p>
                </div>
              </div>
              <div className="permission-grid">
                <ReadOnly label="Gestor IDX" value="Acesso multiempresa via platform_users" />
                <ReadOnly label="Owner" value="Dono da empresa, integrações e stakeholders" />
                <ReadOnly label="Admin" value="Links, integrações, CRM e relatórios" />
                <ReadOnly label="Vendedor / Atendimento" value="Tela reduzida: Atender, leads e ações de CRM" />
                <ReadOnly label="Visualizador" value="Verifica dados e relatórios da empresa" />
              </div>
            </section>
          </section>
        )}

        {active === "reports" && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Cliques" value={metrics.clicks.toLocaleString("pt-BR")} />
              <Kpi label="Leads WhatsApp" value={String(tenantLeads.length)} />
              <Kpi label="Vendas" value={String(metrics.sales)} />
              <Kpi label="Receita" value={formatMoney(metrics.revenue)} />
              <Kpi label="Conv." value={`${metrics.conversion.toFixed(1)}%`} />
            </div>
            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Resumo executivo</h2>
                  <p>Leitura objetiva para decidir próxima ação com dados reais.</p>
                </div>
                <FileText size={18} />
              </div>
              <ExecutiveInsights insights={executiveInsights} />
            </section>
            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Relatório CRO</h2>
                  <p>Resumo que a IDX pode mandar para o dono do negócio local.</p>
                </div>
                <FileText size={18} />
              </div>
              <div className="report-layout">
                <div className="report-copy">
                  <h3>{tenant?.name}</h3>
                  <p>
                    O funil mostra quais Smart Links geram conversas e quais conversas viram venda confirmada. Use isso para ajustar oferta, criativo, atendimento e orçamento.
                  </p>
                </div>
                <LinksTable links={tenantLinks} onCopy={copyLink} />
              </div>
            </section>
            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Meta Ads x IDX</h2>
                  <p>Campanhas com gasto importado da Meta e conversão medida pelo Smart Link.</p>
                </div>
              </div>
              <MetaRoiTable campaigns={tenantMetaCampaigns} />
            </section>
            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Qualidade por campanha</h2>
                  <p>Qualificado e remarketing são a mesma etapa operacional.</p>
                </div>
              </div>
              <LeadQualityTable rows={qualityRows} />
            </section>
            {campaignAttribution.length > 0 && (
              <section className="panel wide">
                <div className="panel-head">
                  <div>
                    <h2>Atribuição de campanhas</h2>
                    <p>Campanhas ranqueadas por resultado comercial real.</p>
                  </div>
                  <Target size={18} />
                </div>
                <div className="table-wrap">
                  <table className="attr-table">
                    <thead>
                      <tr>
                        <th>Campanha</th>
                        <th>Fonte / Mídia</th>
                        <th>Cliques</th>
                        <th>CTR</th>
                        <th>CPC</th>
                        <th>Conv. Google</th>
                        <th>Leads</th>
                        <th>Vendas</th>
                        <th>Receita</th>
                        <th>Conv.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaignAttribution.slice(0, 10).map((row) => {
                        const conv = Number(row.clicks) > 0 ? ((Number(row.sales) + Number(row.ai_confirmed_sales)) / Number(row.clicks)) * 100 : 0;
                        return (
                          <tr key={`${row.campaign}-${row.source}-${row.medium}`}>
                            <td className="attr-campaign">{row.campaign}</td>
                            <td><span className={`attr-source-tag ${(() => { const s = row.source.toLowerCase(); if (s.includes("meta") || s.includes("facebook") || s.includes("instagram")) return "attr-source-meta"; if (s.includes("google")) return "attr-source-google"; return "attr-source-default"; })()}`}>{row.source}/{row.medium}</span></td>
                            <td>{Number(row.clicks).toLocaleString("pt-BR")}</td>
                            <td>{row.leads}</td>
                            <td>{Number(row.sales) + Number(row.ai_confirmed_sales)}</td>
                            <td>{formatMoney(Number(row.revenue))}</td>
                            <td>{conv.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </section>
        )}

        {active === "capi" && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Eventos" value={String(health.total_events)} />
              <Kpi label="Sucesso" value={`${health.success_rate}%`} />
              <Kpi label="Leads" value={String(health.lead_events)} />
              <Kpi label="Purchases" value={String(health.purchase_events)} />
              <Kpi label="Falhas" value={String(health.failed_events)} />
            </div>
            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Eventos recentes</h2>
                  <p>Diagnóstico simples para saber se o Meta recebeu os sinais.</p>
                </div>
              </div>
              <EventsTable events={events} />
            </section>
          </section>
        )}

        {active === "ai-sales" && (
          <section className="page-grid">
            <div className="ai-sales-filters">
              {(["all", "pending", "success", "failed", "skipped"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`ghost-button ${aiSalesFilter === f ? "active" : ""}`}
                  onClick={() => setAiSalesFilter(f)}
                >
                  {f === "all" ? "Todos" : f === "pending" ? "Pendentes" : f === "success" ? "Enviadas" : f === "failed" ? "Falhas" : "Rejeitadas"}
                </button>
              ))}
            </div>

            <div className="kpi-grid">
              <Kpi label="Total" value={String(aiSales.length)} />
              <Kpi label="Pendentes" value={String(aiSales.filter((s) => s.capi_status === "pending").length)} />
              <Kpi label="Confirmadas" value={String(aiSales.filter((s) => s.status === "confirmed" || s.status === "converted").length)} />
              <Kpi label="Enviadas ao Meta" value={String(aiSales.filter((s) => s.capi_status === "success").length)} />
              <Kpi label="Falhas" value={String(aiSales.filter((s) => s.capi_status === "failed").length)} />
            </div>

            {aiSalesLoading && <p className="empty-state">Carregando sinais de venda…</p>}

            {!aiSalesLoading && aiSales.length === 0 && (
              <p className="empty-state">Nenhum sinal de venda encontrado.</p>
            )}

            {!aiSalesLoading && aiSales.length > 0 && (
              <section className="ai-sales-list">
                {aiSales.map((sig) => {
                  const busy = aiSalesBusy === sig.id;
                  const needsManualConfirm = sig.status === "detected" && sig.capi_status === "pending" && sig.requires_human_confirmation;
                  const isAutoConfirmed = sig.status === "confirmed" && !sig.confirmed_by;
                  const isManualConfirmed = sig.status === "confirmed" && sig.confirmed_by;
                  const isFailed = sig.capi_status === "failed";
                  const isRejected = sig.status === "rejected";
                  const isSent = sig.capi_status === "success";
                  const signalLabel: Record<string, string> = {
                    interest: "Interesse",
                    high_intent: "Alta intenção",
                    negotiation: "Negociação",
                    declared_purchase: "Compra declarada",
                    confirmed_sale: "Venda confirmada",
                    abandonment: "Abandono",
                    commitment: "Compromisso",
                    post_sale: "Pós-venda",
                  };
                  const unifiedStatus = isRejected ? { label: "Rejeitado", cls: "badge-muted" }
                    : isSent ? { label: "Enviado ao Meta", cls: "badge-ok" }
                    : isFailed ? { label: "Falha no envio", cls: "badge-bad" }
                    : sig.capi_status === "sending" ? { label: "Enviando…", cls: "badge-info" }
                    : isAutoConfirmed ? { label: "Auto-confirmado", cls: "badge-ok" }
                    : isManualConfirmed ? { label: "Confirmado", cls: "badge-ok" }
                    : needsManualConfirm ? { label: "Aguardando confirmação", cls: "badge-warn" }
                    : { label: "Detectado", cls: "badge-info" };
                  return (
                    <article key={sig.id} className="ai-sale-card">
                      <div className="ai-sale-header">
                        <div className="ai-sale-title">
                          <strong>{cleanAiText(sig.product_name) || "Produto não identificado"}</strong>
                          {sig.estimated_value != null && sig.estimated_value > 0 && (
                            <span className="ai-sale-value">R$ {sig.estimated_value.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                          )}
                        </div>
                        <span className={`badge ${unifiedStatus.cls}`}>{unifiedStatus.label}</span>
                      </div>

                      <div className="ai-sale-meta">
                        <span className={`badge ${
                          sig.signal_type === "confirmed_sale" ? "badge-ok" :
                          sig.signal_type === "declared_purchase" ? "badge-orange" :
                          sig.signal_type === "high_intent" || sig.signal_type === "commitment" ? "badge-purple" :
                          sig.signal_type === "negotiation" ? "badge-warn" :
                          sig.signal_type === "abandonment" ? "badge-bad" :
                          "badge-info"
                        }`}>{signalLabel[sig.signal_type] ?? sig.signal_type}</span>
                        {sig.confidence != null && (
                          <span className="ai-sale-confidence">
                            Confiança: {Math.round(sig.confidence * 100)}%
                          </span>
                        )}
                        {sig.product_category && <span className="ai-sale-cat">{sig.product_category}</span>}
                      </div>

                      {cleanAiText(sig.evidence_text) && (
                        <p className="ai-sale-evidence">"{cleanAiText(sig.evidence_text)}"</p>
                      )}

                      {isFailed && sig.capi_error && (
                        <p className="ai-sale-error">Erro: {sig.capi_error} (tentativas: {sig.capi_attempts})</p>
                      )}

                      <p className="ai-sale-ts">
                        Detectado em {new Date(sig.created_at).toLocaleString("pt-BR")}
                        {sig.confirmed_at && ` · Confirmado em ${new Date(sig.confirmed_at).toLocaleString("pt-BR")}`}
                        {sig.rejected_at && ` · Rejeitado em ${new Date(sig.rejected_at).toLocaleString("pt-BR")}`}
                      </p>

                      <div className="ai-sale-actions">
                        {needsManualConfirm && (
                          <>
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busy}
                              onClick={() => {
                                const raw = prompt("Valor da venda (R$)? Deixe vazio para manter o estimado.");
                                const rev = raw ? parseFloat(raw.replace(",", ".")) : undefined;
                                confirmAiSale(sig.id, rev);
                              }}
                            >
                              {busy ? "Confirmando…" : "Confirmar venda"}
                            </button>
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={busy}
                              onClick={() => rejectAiSale(sig.id)}
                            >
                              Rejeitar
                            </button>
                          </>
                        )}
                        {isFailed && (
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy}
                            onClick={() => retryAiSaleCapi(sig.id)}
                          >
                            {busy ? "Reenviando…" : "Reenviar ao Meta"}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
          </section>
        )}

        {active === "intelligence" && (
          <section className="page-grid">
            <div className="fi-tabs">
              {(["overview", "campaigns", "customers", "ai"] as const).map((t) => (
                <button key={t} type="button" className={`ghost-button ${fiTab === t ? "active" : ""}`}
                  onClick={() => setFiTab(t)}>
                  {t === "overview" ? "Visão Geral" : t === "campaigns" ? "Campanhas" : t === "customers" ? "Clientes" : "IA Patterns"}
                </button>
              ))}
              <button type="button" className="ghost-button" disabled={fiExporting}
                onClick={() => exportCsv(fiTab === "overview" ? "monthly" : fiTab === "campaigns" ? "campaigns" : fiTab === "customers" ? "customers" : "leads")}>
                <Download size={14} /> {fiExporting ? "Exportando…" : "CSV"}
              </button>
            </div>

            {fiLoading && <p className="empty-state">Carregando inteligência financeira…</p>}

            {!fiLoading && fiTab === "overview" && fiSummary && (
              <>
                <div className="kpi-grid">
                  <Kpi label="Faturamento" value={formatMoney(fiSummary.total_revenue)} />
                  <Kpi label="Investimento" value={fiSummary.total_spend > 0 ? formatMoney(fiSummary.total_spend) : "—"} />
                  <Kpi label="ROAS" value={fiSummary.roas != null ? `${fiSummary.roas.toFixed(2)}x` : "—"} />
                  <Kpi label="CAC" value={fiSummary.cac != null ? formatMoney(fiSummary.cac) : "—"} />
                  <Kpi label="LTV Realizado" value={fiSummary.unique_buyers > 0 ? formatMoney(fiSummary.ltv_realized) : "—"} />
                </div>
                <div className="kpi-grid">
                  <Kpi label="Leads" value={String(fiSummary.total_leads)} />
                  <Kpi label="Vendas" value={String(fiSummary.total_sales)} />
                  <Kpi label="Ticket Médio" value={fiSummary.total_sales > 0 ? formatMoney(fiSummary.avg_ticket) : "—"} />
                  <Kpi label="CPL" value={fiSummary.cpl != null ? formatMoney(fiSummary.cpl) : "—"} />
                  <Kpi label="CPA" value={fiSummary.cpa != null ? formatMoney(fiSummary.cpa) : "—"} />
                </div>
                <div className="kpi-grid">
                  <Kpi label="Qualificados" value={String(fiSummary.total_qualified)} />
                  <Kpi label="Compradores" value={String(fiSummary.unique_buyers)} />
                  <Kpi label="Recompra" value={`${fiSummary.repurchase_rate.toFixed(1)}%`} />
                  <Kpi label="Conversão" value={`${fiSummary.conversion_rate.toFixed(1)}%`} />
                  <Kpi label="Qualificação" value={`${fiSummary.qualification_rate.toFixed(1)}%`} />
                </div>

                {fiMonthly.length > 1 && (
                  <section className="panel wide">
                    <div className="panel-head">
                      <div>
                        <h2>Evolução mensal</h2>
                        <p>Faturamento, investimento e vendas mês a mês.</p>
                      </div>
                      <BarChart3 size={18} />
                    </div>
                    <MonthlyChart data={fiMonthly} />
                  </section>
                )}

                {fiMonthly.length > 1 && (
                  <section className="panel wide">
                    <div className="panel-head">
                      <div>
                        <h2>Comparativo mensal</h2>
                        <p>Evolução de CAC, ROAS e conversão entre períodos.</p>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Mês</th>
                            <th>Leads</th>
                            <th>Vendas</th>
                            <th>Receita</th>
                            <th>Invest.</th>
                            <th>ROAS</th>
                            <th>CAC</th>
                            <th>Conv.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fiMonthly.map((m) => (
                            <tr key={m.month}>
                              <td>{new Date(m.month).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" })}</td>
                              <td>{m.leads}</td>
                              <td>{m.sales}</td>
                              <td>{formatMoney(m.revenue)}</td>
                              <td>{formatMoney(m.spend)}</td>
                              <td>{m.spend > 0 ? `${(m.revenue / m.spend).toFixed(2)}x` : "—"}</td>
                              <td>{m.unique_buyers > 0 && m.spend > 0 ? formatMoney(m.spend / m.unique_buyers) : "—"}</td>
                              <td>{m.leads > 0 ? `${((m.sales / m.leads) * 100).toFixed(1)}%` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </>
            )}

            {!fiLoading && fiTab === "campaigns" && (
              <section className="panel wide">
                <div className="panel-head">
                  <div>
                    <h2>Performance por campanha</h2>
                    <p>CAC, CPA, ROAS e conversão detalhados por campanha Meta Ads.</p>
                  </div>
                </div>
                {fiCampaigns.length === 0 ? (
                  <p className="empty-state">Nenhuma campanha com dados financeiros.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Campanha</th>
                          <th>Invest.</th>
                          <th>Leads</th>
                          <th>Qual.</th>
                          <th>Vendas</th>
                          <th>Receita</th>
                          <th>CPL</th>
                          <th>CPA</th>
                          <th>ROAS</th>
                          <th>Conv.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fiCampaigns.map((c) => (
                          <tr key={c.campaign_id}>
                            <td>
                              <strong>{c.campaign_name}</strong>
                              <small>{c.campaign_id}</small>
                            </td>
                            <td>{formatMoney(c.spend)}</td>
                            <td>{c.leads}</td>
                            <td>{c.qualified}</td>
                            <td>{c.sales}</td>
                            <td>{formatMoney(c.revenue)}</td>
                            <td>{c.cpl != null ? formatMoney(c.cpl) : "—"}</td>
                            <td>{c.cpa != null ? formatMoney(c.cpa) : "—"}</td>
                            <td>{c.roas != null ? `${c.roas.toFixed(2)}x` : "—"}</td>
                            <td>{`${c.conversion_rate.toFixed(1)}%`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {!fiLoading && fiTab === "customers" && (
              <section className="panel wide">
                <div className="panel-head">
                  <div>
                    <h2>Histórico de clientes</h2>
                    <p>Compras, LTV realizado, ticket médio e recompra por cliente.</p>
                  </div>
                </div>
                {fiCustomers.length === 0 ? (
                  <p className="empty-state">Nenhum cliente com compra confirmada.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Telefone</th>
                          <th>Compras</th>
                          <th>Receita total</th>
                          <th>Ticket médio</th>
                          <th>Primeira</th>
                          <th>Última</th>
                          <th>Produtos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fiCustomers.map((c) => (
                          <tr key={c.customer_key}>
                            <td>
                              <strong>{c.customer_name || "—"}</strong>
                              {c.is_repeat && <span className="badge badge-ok" style={{ marginLeft: 6 }}>Recompra</span>}
                            </td>
                            <td>{c.customer_phone || "—"}</td>
                            <td>{c.purchase_count}</td>
                            <td>{formatMoney(c.total_revenue)}</td>
                            <td>{formatMoney(c.avg_ticket)}</td>
                            <td>{c.first_purchase_at ? new Date(c.first_purchase_at).toLocaleDateString("pt-BR") : "—"}</td>
                            <td>{c.last_purchase_at ? new Date(c.last_purchase_at).toLocaleDateString("pt-BR") : "—"}</td>
                            <td>{cleanAiArray(c.products).length > 0 ? cleanAiArray(c.products).join(", ") : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {!fiLoading && fiTab === "ai" && fiPatterns && (
              <>
                <div className="kpi-grid">
                  <Kpi label="Conversas analisadas" value={String(fiPatterns.total_conversations_analyzed)} />
                  <Kpi label="Sinais detectados" value={String(fiPatterns.total_signals)} />
                  <Kpi label="Ticket médio IA" value={fiPatterns.avg_signal_value != null ? formatMoney(fiPatterns.avg_signal_value) : "—"} />
                  <Kpi label="Sentimento +" value={String(fiPatterns.sentiment.positive)} />
                  <Kpi label="Sentimento −" value={String(fiPatterns.sentiment.negative)} />
                </div>

                <section className="panel wide">
                  <div className="panel-head">
                    <div>
                      <h2>Produtos mais procurados</h2>
                      <p>Frequência de menção em conversas analisadas pela IA.</p>
                    </div>
                  </div>
                  {fiPatterns.top_products.filter((p) => !isAiPlaceholder(p.name)).length === 0 ? (
                    <p className="empty-state">Nenhum identificado.</p>
                  ) : (
                    <div className="fi-bar-list">
                      {fiPatterns.top_products.filter((p) => !isAiPlaceholder(p.name)).map((p) => (
                        <div key={p.name} className="fi-bar-row">
                          <span className="fi-bar-label">{p.name}</span>
                          <div className="fi-bar-track">
                            <div className="fi-bar-fill" style={{ width: `${Math.min((p.count / (fiPatterns.top_products.filter((x) => !isAiPlaceholder(x.name))[0]?.count || 1)) * 100, 100)}%` }} />
                          </div>
                          <span className="fi-bar-count">{p.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel wide">
                  <div className="panel-head">
                    <div>
                      <h2>Objeções mais frequentes</h2>
                      <p>Motivos de resistência identificados pela IA nas conversas.</p>
                    </div>
                  </div>
                  {fiPatterns.top_objections.filter((o) => !isAiPlaceholder(o.text)).length === 0 ? (
                    <p className="empty-state">Nenhum identificado.</p>
                  ) : (
                    <div className="fi-bar-list">
                      {fiPatterns.top_objections.filter((o) => !isAiPlaceholder(o.text)).map((o) => (
                        <div key={o.text} className="fi-bar-row">
                          <span className="fi-bar-label">{o.text}</span>
                          <div className="fi-bar-track">
                            <div className="fi-bar-fill fi-bar-warn" style={{ width: `${Math.min((o.count / (fiPatterns.top_objections.filter((x) => !isAiPlaceholder(x.text))[0]?.count || 1)) * 100, 100)}%` }} />
                          </div>
                          <span className="fi-bar-count">{o.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel wide">
                  <div className="panel-head">
                    <div>
                      <h2>Intenções detectadas</h2>
                      <p>Distribuição de intenções identificadas nas conversas.</p>
                    </div>
                  </div>
                  {fiPatterns.top_intents.filter((i) => !isAiPlaceholder(i.intent)).length === 0 ? (
                    <p className="empty-state">Nenhum identificado.</p>
                  ) : (
                    <div className="fi-bar-list">
                      {fiPatterns.top_intents.filter((i) => !isAiPlaceholder(i.intent)).map((i) => (
                        <div key={i.intent} className="fi-bar-row">
                          <span className="fi-bar-label">{i.intent}</span>
                          <div className="fi-bar-track">
                            <div className="fi-bar-fill fi-bar-info" style={{ width: `${Math.min((i.count / (fiPatterns.top_intents.filter((x) => !isAiPlaceholder(x.intent))[0]?.count || 1)) * 100, 100)}%` }} />
                          </div>
                          <span className="fi-bar-count">{i.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel wide">
                  <div className="panel-head">
                    <div>
                      <h2>Sinais de venda por tipo</h2>
                      <p>Distribuição dos sinais detectados automaticamente.</p>
                    </div>
                  </div>
                  <div className="insight-grid">
                    {Object.entries(fiPatterns.signals_by_type).map(([type, count]) => (
                      <article key={type} className="insight-card">
                        <strong>{type === "interest" ? "Interesse" : type === "high_intent" ? "Alta intenção" : type === "negotiation" ? "Negociação" : type === "declared_purchase" ? "Compra declarada" : type === "confirmed_sale" ? "Confirmada" : type === "abandonment" ? "Abandono" : type === "commitment" ? "Compromisso" : type === "post_sale" ? "Pós-venda" : type}</strong>
                        <p>{count} sinais</p>
                      </article>
                    ))}
                  </div>
                </section>
              </>
            )}
          </section>
        )}

        {active === "settings" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Empresa</h2>
                  <p>Configuração essencial para implantação rápida.</p>
                </div>
                <SlidersHorizontal size={18} />
              </div>
              <div className="settings-grid">
                <label>
                  Empresa
                  <input value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value, slug: slugify(event.target.value) })} />
                </label>
                <label>
                  Segmento
                  <input value={profileDraft.businessSegment} onChange={(event) => setProfileDraft({ ...profileDraft, businessSegment: event.target.value })} />
                </label>
                <label>
                  Slug
                  <input value={profileDraft.slug} onChange={(event) => setProfileDraft({ ...profileDraft, slug: slugify(event.target.value) })} />
                </label>
                <label>
                  WhatsApp
                  <input value={profileDraft.whatsapp} onChange={(event) => setProfileDraft({ ...profileDraft, whatsapp: event.target.value })} />
                </label>
                <label>
                  Cidade
                  <input value={profileDraft.city} onChange={(event) => setProfileDraft({ ...profileDraft, city: event.target.value })} />
                </label>
                <label>
                  UF
                  <input maxLength={2} value={profileDraft.state} onChange={(event) => setProfileDraft({ ...profileDraft, state: event.target.value.toUpperCase() })} />
                </label>
                <label>
                  Meta mensal
                  <input inputMode="decimal" value={profileDraft.monthlyGoal} onChange={(event) => setProfileDraft({ ...profileDraft, monthlyGoal: event.target.value })} />
                </label>
                <label>
                  Ticket médio
                  <input inputMode="decimal" value={profileDraft.averageTicket} onChange={(event) => setProfileDraft({ ...profileDraft, averageTicket: event.target.value })} />
                </label>
                <label>
                  Canal principal
                  <input value={profileDraft.primaryChannel} onChange={(event) => setProfileDraft({ ...profileDraft, primaryChannel: event.target.value })} />
                </label>
                <label>
                  Responsável
                  <input value={profileDraft.responsibleName} onChange={(event) => setProfileDraft({ ...profileDraft, responsibleName: event.target.value })} />
                </label>
                <ReadOnly label="Ofertas" value={String(tenantOffers.length)} />
                <ReadOnly label="Link de acesso" value={tenantAccessUrl(profileDraft.slug || tenant?.slug)} />
                <button className="ghost-dark-button" onClick={copyTenantAccessUrl} disabled={!tenant?.slug}>Copiar acesso</button>
                <button className="primary-button" onClick={saveTenantProfile} disabled={loading}>Salvar empresa</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Governança e dados</h2>
                  <p>Escopo operacional para vender com confiança e manter dados separados por empresa.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <div className="permission-grid">
                <ReadOnly label="Banco" value="Único IDX com tenant_id" />
                <ReadOnly label="Acesso" value="Empresa vê apenas seus próprios dados" />
                <ReadOnly label="CAPI" value="Eventos enviados server-side" />
                <ReadOnly label="Públicos" value="Telefone/email enviados com hash SHA-256" />
              </div>
              <div className="legal-link-row">
                <a href="/privacy.html" target="_blank" rel="noreferrer">Privacidade</a>
                <a href="/terms.html" target="_blank" rel="noreferrer">Termos</a>
                <a href="/data-deletion.html" target="_blank" rel="noreferrer">Exclusão de dados</a>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Checklist de implantação</h2>
                  <p>O produto só está pronto para cliente quando estes pontos fecharem.</p>
                </div>
              </div>
              <div className="checklist">
                <CheckItem text="Banco único da IDX com tenant_id e RLS por empresa" />
                <CheckItem text="Cliente local acessa só o painel, nunca o Supabase" />
                <CheckItem text="WhatsApp validado com DDI e DDD" />
                <CheckItem text="Pixel ID e token CAPI cadastrados no schema privado" />
                <CheckItem text="Primeiro clique real gerando Lead no Meta" />
                <CheckItem text="Primeira venda confirmada gerando Purchase" />
                <CheckItem text="Relatório entendido pelo dono do negócio local" />
              </div>
            </section>
          </section>
        )}
      </main>

      {mobileMenuOpen && isSellerExperience && (
        <section className="mobile-more-sheet" aria-label="Mais opções">
          <button type="button" onClick={() => goToSection("leads")} className={active === "leads" ? "active" : ""}><MessageCircle size={17} /> Atendimentos</button>
          <button type="button" onClick={logout}><LogOut size={17} /> Sair</button>
        </section>
      )}

      {mobileMenuOpen && !isSellerExperience && (
        <section className="mobile-more-sheet" aria-label="Mais opções">
          <button type="button" onClick={() => goToSection("integrations")} className={active === "integrations" ? "active" : ""}><ShieldCheck size={17} /> Meta</button>
          <button type="button" onClick={() => { goToSection("whatsapp"); loadWaInstances(); loadWaKeys(); }} className={active === "whatsapp" ? "active" : ""}><MessageCircle size={17} /> WhatsApp</button>
          <button type="button" onClick={() => goToSection("leads")} className={active === "leads" ? "active" : ""}><MessageCircle size={17} /> Atendimentos</button>
          <button type="button" onClick={() => goToSection("clients")} className={active === "clients" ? "active" : ""}><LayoutList size={17} /> Clientes</button>
          <button type="button" onClick={() => goToSection("users")} className={active === "users" ? "active" : ""}><Users size={17} /> Usuários</button>
          <button type="button" onClick={() => goToSection("reports")} className={active === "reports" ? "active" : ""}><FileText size={17} /> Relatórios</button>
          <button type="button" onClick={() => goToSection("capi")} className={active === "capi" ? "active" : ""}><Activity size={17} /> CAPI</button>
          <button type="button" onClick={() => goToSection("ai-sales")} className={active === "ai-sales" ? "active" : ""}><TrendingUp size={17} /> Vendas IA</button>
          <button type="button" onClick={() => goToSection("intelligence")} className={active === "intelligence" ? "active" : ""}><BarChart3 size={17} /> Inteligência</button>
          <button type="button" onClick={() => goToSection("google-ads")} className={active === "google-ads" ? "active" : ""}><Zap size={17} /> Google Ads</button>
          <button type="button" onClick={() => goToSection("settings")} className={active === "settings" ? "active" : ""}><Settings size={17} /> Config</button>
          <button type="button" onClick={logout}><LogOut size={17} /> Sair</button>
        </section>
      )}

      {isSellerExperience && (
      <nav className="mobile-tabbar seller-mobile-tabbar" aria-label="Navegação do atendimento">
        <NavButton icon={<PhoneCall />} label="Atender" active={active === "sales"} onClick={() => goToSection("sales")} />
        <NavButton icon={<MessageCircle />} label="Leads" active={active === "leads"} onClick={() => goToSection("leads")} />
        <NavButton icon={<MoreHorizontal />} label="Mais" active={moreActive || mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)} />
      </nav>
      )}

      {!isSellerExperience && (
      <nav className="mobile-tabbar" aria-label="Navegação principal">
        <NavButton icon={<Gauge />} label="Início" active={active === "dashboard"} onClick={() => goToSection("dashboard")} />
        <NavButton icon={<PhoneCall />} label="Atender" active={active === "sales"} onClick={() => goToSection("sales")} />
        <NavButton icon={<Link2 />} label="Links" active={active === "links"} onClick={() => goToSection("links")} />
        <NavButton icon={<LayoutList />} label="CRM" active={active === "crm"} onClick={() => goToSection("crm")} />
        <NavButton icon={<MoreHorizontal />} label="Mais" active={moreActive || mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)} />
      </nav>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} type="button" aria-label={label} aria-current={active ? "page" : undefined}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <article className="kpi" style={accent ? { borderTop: `3px solid ${accent}` } : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SalesConsole({
  leads,
  allLeads,
  selectedLead,
  selectedLeadId,
  stats,
  filter,
  search,
  notes,
  contacts,
  followUps,
  revenues,
  busyRef,
  onFilterChange,
  onSearchChange,
  onSelectLead,
  onNoteChange,
  onContactChange,
  onFollowUpChange,
  onRevenueChange,
  onStageChange,
}: {
  leads: Lead[];
  allLeads: Lead[];
  selectedLead: Lead | null;
  selectedLeadId: string;
  stats: { now: number; due: number; qualified: number; sold: number };
  filter: SalesFilter;
  search: string;
  notes: Record<string, string>;
  contacts: Record<string, ContactDraft>;
  followUps: Record<string, string>;
  revenues: Record<string, string>;
  busyRef: string;
  onFilterChange: (value: SalesFilter) => void;
  onSearchChange: (value: string) => void;
  onSelectLead: (leadId: string) => void;
  onNoteChange: (leadId: string, value: string) => void;
  onContactChange: (leadId: string, value: Partial<ContactDraft>) => void;
  onFollowUpChange: (leadId: string, value: string) => void;
  onRevenueChange: (leadId: string, value: string) => void;
  onStageChange: (lead: Lead, status: LeadStatus) => void;
}) {
  const lead = selectedLead;
  const contact = lead ? contacts[lead.id] : undefined;
  const phone = lead ? leadContactPhone(lead, contact) : "";
  const duplicateLead = lead ? duplicateContactLead(lead, contact, allLeads) : null;
  const filters: { value: SalesFilter; label: string }[] = [
    { value: "now", label: "Agora" },
    { value: "new", label: "Novos" },
    { value: "contacted", label: "Contato" },
    { value: "qualified", label: "Remarketing" },
    { value: "sold", label: "Vendas" },
  ];

  return (
    <section className="seller-page">
      <div className="seller-summary">
        <article>
          <span>Fila aberta</span>
          <strong>{stats.now}</strong>
        </article>
        <article>
          <span>Follow-up</span>
          <strong>{stats.due}</strong>
        </article>
        <article>
          <span>Remarketing</span>
          <strong>{stats.qualified}</strong>
        </article>
        <article>
          <span>Vendas</span>
          <strong>{stats.sold}</strong>
        </article>
      </div>

      <section className="seller-workspace">
        <aside className="seller-queue" aria-label="Fila de atendimento">
          <div className="seller-section-head">
            <div>
              <h2>Fila de atendimento</h2>
              <p>Priorize retorno, contato e qualificação.</p>
            </div>
          </div>
          <div className="search-box seller-search">
            <Search size={15} />
            <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Buscar lead, telefone ou campanha" />
          </div>
          <div className="segmented-filter seller-filter" aria-label="Filtro do atendimento">
            {filters.map((item) => (
              <button key={item.value} type="button" className={filter === item.value ? "active" : ""} onClick={() => onFilterChange(item.value)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="seller-lead-list">
            {leads.length ? leads.map((item) => (
              <button
                className={`seller-lead-row ${item.id === selectedLeadId ? "active" : ""}`}
                type="button"
                key={item.id}
                onClick={() => onSelectLead(item.id)}
              >
                <span>
                  <strong>{item.customer_name || item.offer_name || item.link_name || "Lead WhatsApp"}</strong>
                  <small>{item.ref} · {timeAgo(item.clicked_at)} · {item.utm_campaign ?? "sem campanha"}</small>
                </span>
                <Status status={item.lead_status} />
                {leadFollowUpDue(item) && <em>retornar</em>}
              </button>
            )) : <EmptyState text="Nenhum lead nesta fila." />}
          </div>
        </aside>

        <section className="seller-detail" aria-label="Atendimento selecionado">
          {lead ? (
            <>
              <div className="seller-detail-top">
                <div>
                  <span className="seller-ref">Ref {lead.ref}</span>
                  <h2>{lead.offer_name ?? lead.link_name ?? "Atendimento WhatsApp"}</h2>
                  <p>{timeAgo(lead.clicked_at)} · {lead.utm_campaign ?? "sem campanha"} · {lead.utm_source ?? "origem não informada"}</p>
                </div>
                <Status status={lead.lead_status} />
              </div>

              <TagRow tags={lead.tags} fallback={lead.utm_content ?? lead.category ?? "lead"} />

              <div className="seller-contact-grid">
                <label>
                  Nome
                  <input value={contact?.name ?? lead.customer_name ?? ""} onChange={(event) => onContactChange(lead.id, { name: event.target.value })} placeholder="Nome do lead" />
                </label>
                <label>
                  Telefone
                  <input value={contact?.phone ?? lead.customer_phone ?? ""} onChange={(event) => onContactChange(lead.id, { phone: event.target.value })} placeholder="Telefone com DDI/DDD" inputMode="tel" />
                </label>
                <label>
                  Email
                  <input value={contact?.email ?? lead.customer_email ?? ""} onChange={(event) => onContactChange(lead.id, { email: event.target.value })} placeholder="Email opcional" type="email" />
                </label>
                <label>
                  Retorno
                  <input value={followUps[lead.id] ?? dateTimeLocalValue(lead.next_follow_up_at)} onChange={(event) => onFollowUpChange(lead.id, event.target.value)} type="datetime-local" />
                </label>
                <label>
                  Valor da venda
                  <input value={revenues[lead.id] ?? (lead.revenue ? String(lead.revenue) : "")} onChange={(event) => onRevenueChange(lead.id, event.target.value)} placeholder="0,00" inputMode="decimal" />
                </label>
              </div>

              {duplicateLead && (
                <div className="crm-warning">
                  <span>Este telefone já está no lead {duplicateLead.ref}. Abra o lead correto antes de salvar.</span>
                </div>
              )}

              <label className="seller-note">
                Nota do atendimento
                <textarea value={notes[lead.id] ?? ""} onChange={(event) => onNoteChange(lead.id, event.target.value)} rows={3} placeholder="Resumo objetivo da conversa" />
              </label>

              <div className="seller-actions">
                {phone ? (
                  <a className="primary-button seller-whatsapp" href={whatsappUrl(phone)} target="_blank" rel="noreferrer">
                    <PhoneCall size={16} /> WhatsApp
                  </a>
                ) : (
                  <button className="ghost-dark-button" type="button" disabled>Sem telefone</button>
                )}
                <button className="ghost-dark-button" type="button" onClick={() => onStageChange(lead, lead.lead_status)} disabled={busyRef === lead.ref}>Salvar</button>
                <button className="ghost-dark-button" type="button" onClick={() => onStageChange(lead, "contacted")} disabled={busyRef === lead.ref || lead.lead_status === "contacted"}>Contato</button>
                <button className="primary-button" type="button" onClick={() => onStageChange(lead, "qualified")} disabled={busyRef === lead.ref || lead.lead_status === "qualified"}>Qualificar</button>
                <button className="primary-button" type="button" onClick={() => onStageChange(lead, "sold")} disabled={busyRef === lead.ref}>Venda</button>
                <button className="ghost-dark-button" type="button" onClick={() => onStageChange(lead, "bad")} disabled={busyRef === lead.ref || lead.lead_status === "bad"}>Ruim</button>
                <button className="ghost-dark-button" type="button" onClick={() => onStageChange(lead, "lost")} disabled={busyRef === lead.ref || lead.lead_status === "lost"}>Perdido</button>
              </div>

              <div className="seller-guidance">
                <strong>Qualificado = remarketing.</strong>
                <span>Use somente quando o lead realmente tem potencial. O sistema envia esse sinal para o Meta.</span>
              </div>
            </>
          ) : (
            <EmptyState text="Nenhum atendimento aberto agora." />
          )}
        </section>
      </section>
    </section>
  );
}

function OnboardingStep({
  title,
  detail,
  done,
  action,
  onClick,
}: {
  title: string;
  detail: string;
  done: boolean;
  action: string;
  onClick: () => void;
}) {
  return (
    <article className={`onboarding-step ${done ? "done" : ""}`}>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      {done ? (
        <span className="status-pill status-pill-good">Pronto</span>
      ) : (
        <button className="ghost-dark-button" onClick={onClick}>{action}</button>
      )}
    </article>
  );
}

function ReadinessChecklist({ items, onGo, compact = false }: { items: ReadinessItem[]; onGo: (section: Section) => void; compact?: boolean }) {
  const doneCount = items.filter((item) => item.done).length;
  return (
    <div className={`readiness-block ${compact ? "compact" : ""}`}>
      <div className="readiness-progress">
        <strong>{doneCount}/{items.length} prontos</strong>
        <div className="meter-track">
          <span style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="readiness-grid">
        {items.map((item) => (
          <button className={`readiness-item ${item.done ? "done" : ""}`} key={item.title} type="button" onClick={() => onGo(item.section)}>
            <span className="readiness-dot">{item.done ? <Check size={14} /> : <CircleDot size={14} />}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SmartLinkForm({
  draft,
  setDraft,
  onSubmit,
  loading,
  template,
}: {
  draft: DraftLink;
  setDraft: (draft: DraftLink) => void;
  onSubmit: () => void;
  loading: boolean;
  template?: UtmTemplate;
}) {
  const set = (key: keyof DraftLink, value: string) => setDraft({ ...draft, [key]: value });
  return (
    <div className="link-form">
      <label>
        Oferta
        <input value={draft.offerName} onChange={(event) => set("offerName", event.target.value)} placeholder="Nome real da oferta" />
      </label>
      <label>
        Categoria
        <input value={draft.category} onChange={(event) => set("category", event.target.value)} placeholder="Segmento ou categoria" />
      </label>
      <label>
        Preço
        <input value={draft.price} onChange={(event) => set("price", event.target.value)} placeholder="Valor real da oferta" inputMode="decimal" />
      </label>
      <label>
        Nome do link
        <input value={draft.linkName} onChange={(event) => set("linkName", event.target.value)} placeholder="Origem ou campanha do link" />
      </label>
      <label>
        Campanha (utm_campaign)
        <input value={draft.campaign} onChange={(event) => set("campaign", event.target.value)} placeholder={template?.campaignHint ?? "utm_campaign do anúncio"} />
      </label>
      <label>
        Fonte (utm_source)
        <input value={draft.source} onChange={(event) => set("source", event.target.value)} placeholder={template?.source ?? "meta"} />
      </label>
      <label>
        Mídia (utm_medium)
        <input value={draft.medium} onChange={(event) => set("medium", event.target.value)} placeholder={template?.medium ?? "paid"} />
      </label>
      <label>
        Conteúdo (utm_content)
        <input value={draft.content} onChange={(event) => set("content", event.target.value)} placeholder={template?.contentHint ?? "criativo ou anúncio"} />
      </label>
      <label>
        Termo (utm_term)
        <input value={draft.term} onChange={(event) => set("term", event.target.value)} placeholder={template?.termHint ?? "palavra ou público"} />
      </label>
      <label className="span-2">
        Mensagem WhatsApp
        <textarea value={draft.message} onChange={(event) => set("message", event.target.value)} rows={3} />
      </label>
      <button className="primary-button span-2" onClick={onSubmit} disabled={loading}>
        <Plus size={16} /> Criar Smart Link
      </button>
    </div>
  );
}

function UtmPreview({ draft, tenantSlug }: { draft: DraftLink; tenantSlug: string }) {
  const code = `${slugify(tenantSlug)}-${slugify(draft.offerName || "oferta")}-preview`;
  const params = new URLSearchParams();
  if (draft.source) params.set("utm_source", draft.source);
  if (draft.medium) params.set("utm_medium", draft.medium);
  if (draft.campaign) params.set("utm_campaign", draft.campaign);
  if (draft.content) params.set("utm_content", draft.content);
  if (draft.term) params.set("utm_term", draft.term);
  const query = params.toString();
  const base = smartLinkUrl(code);
  return (
    <div className="utm-preview">
      <strong>Preview do link:</strong><br />
      {base}{query ? `?${query}` : ""}
    </div>
  );
}

function CampaignAttributionPanel({
  data,
  period,
  sourceFilter,
  search,
  onPeriodChange,
  onSourceFilterChange,
  onSearchChange,
  onRefresh,
}: {
  data: CampaignAttribution[];
  period: "7d" | "30d" | "90d" | "all";
  sourceFilter: string;
  search: string;
  onPeriodChange: (v: "7d" | "30d" | "90d" | "all") => void;
  onSourceFilterChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  onRefresh: () => void;
}) {
  const sources = Array.from(new Set(data.map((d) => d.source))).sort();
  const filtered = data.filter((d) => {
    if (sourceFilter !== "all" && d.source !== sourceFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.campaign.toLowerCase().includes(q) || d.source.toLowerCase().includes(q) || d.medium.toLowerCase().includes(q);
    }
    return true;
  });
  const totalClicks = filtered.reduce((s, d) => s + Number(d.clicks), 0);
  const totalLeads = filtered.reduce((s, d) => s + Number(d.leads), 0);
  const totalSales = filtered.reduce((s, d) => s + Number(d.sales), 0);
  const totalRevenue = filtered.reduce((s, d) => s + Number(d.revenue), 0);
  const totalAiSignals = filtered.reduce((s, d) => s + Number(d.ai_signals), 0);
  const totalAiConfirmed = filtered.reduce((s, d) => s + Number(d.ai_confirmed_sales), 0);
  const globalConv = totalClicks > 0 ? ((totalSales / totalClicks) * 100) : 0;

  function sourceClass(src: string) {
    const s = src.toLowerCase();
    if (s.includes("meta") || s.includes("facebook") || s.includes("instagram")) return "attr-source-meta";
    if (s.includes("google")) return "attr-source-google";
    if (s.includes("organic") || s.includes("whatsapp") || s.includes("email")) return "attr-source-organic";
    return "attr-source-default";
  }

  function convClass(rate: number) {
    if (rate >= 5) return "attr-conv-good";
    if (rate >= 1) return "attr-conv-ok";
    return "attr-conv-low";
  }

  return (
    <>
      <section className="panel wide">
        <div className="panel-head">
          <div>
            <h2>Atribuição por campanha</h2>
            <p>Qual campanha gera cliques, leads, oportunidades e vendas confirmadas.</p>
          </div>
          <button className="icon-button" onClick={onRefresh} aria-label="Atualizar"><RefreshCw size={16} /></button>
        </div>
        <div className="attr-summary">
          <div className="attr-summary-item"><div className="attr-sum-value">{totalClicks.toLocaleString("pt-BR")}</div><div className="attr-sum-label">Cliques</div></div>
          <div className="attr-summary-item"><div className="attr-sum-value">{totalLeads}</div><div className="attr-sum-label">Leads</div></div>
          <div className="attr-summary-item"><div className="attr-sum-value">{totalAiSignals}</div><div className="attr-sum-label">Sinais IA</div></div>
          <div className="attr-summary-item"><div className="attr-sum-value">{totalSales + totalAiConfirmed}</div><div className="attr-sum-label">Vendas</div></div>
          <div className="attr-summary-item"><div className="attr-sum-value">{formatMoney(totalRevenue)}</div><div className="attr-sum-label">Receita</div></div>
          <div className="attr-summary-item"><div className="attr-sum-value">{globalConv.toFixed(1)}%</div><div className="attr-sum-label">Conversão</div></div>
        </div>
        <div className="attr-filters">
          <select value={period} onChange={(e) => onPeriodChange(e.target.value as typeof period)}>
            <option value="7d">7 dias</option>
            <option value="30d">30 dias</option>
            <option value="90d">90 dias</option>
            <option value="all">Todo período</option>
          </select>
          <select value={sourceFilter} onChange={(e) => onSourceFilterChange(e.target.value)}>
            <option value="all">Todas as fontes</option>
            {sources.map((src) => <option key={src} value={src}>{src}</option>)}
          </select>
          <input placeholder="Buscar campanha..." value={search} onChange={(e) => onSearchChange(e.target.value)} />
        </div>
        {filtered.length === 0 ? (
          <EmptyState text="Nenhum dado de campanha encontrado no período." />
        ) : (
          <div className="table-wrap">
            <table className="attr-table">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Fonte / Mídia</th>
                  <th>Cliques</th>
                  <th>Leads</th>
                  <th>Sinais IA</th>
                  <th>Vendas</th>
                  <th>Receita</th>
                  <th>Conv.</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const conv = Number(row.clicks) > 0 ? ((Number(row.sales) + Number(row.ai_confirmed_sales)) / Number(row.clicks)) * 100 : 0;
                  return (
                    <tr key={`${row.campaign}-${row.source}-${row.medium}`}>
                      <td className="attr-campaign">{row.campaign}</td>
                      <td><span className={`attr-source-tag ${sourceClass(row.source)}`}>{row.source}/{row.medium}</span></td>
                      <td>{Number(row.clicks).toLocaleString("pt-BR")}</td>
                      <td>{row.leads}</td>
                      <td>{row.ai_signals}</td>
                      <td>{Number(row.sales) + Number(row.ai_confirmed_sales)}</td>
                      <td>{formatMoney(Number(row.revenue))}</td>
                      <td><span className={`attr-conv-rate ${convClass(conv)}`}>{conv.toFixed(1)}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function LinksTable({ links, onCopy }: { links: SmartLink[]; onCopy: (link: SmartLink) => void }) {
  if (!links.length) return <EmptyState text="Nenhum link criado ainda." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Link</th>
            <th>Oferta</th>
            <th>Cliques</th>
            <th>Vendas</th>
            <th>Receita</th>
            <th>Conv.</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.id}>
              <td>
                <strong>{link.name}</strong>
                <small>{smartLinkWithUtms(link)}</small>
              </td>
              <td>{link.offer_name ?? "-"}</td>
              <td>{link.clicks ?? 0}</td>
              <td>{link.sales ?? 0}</td>
              <td>{formatMoney(link.revenue)}</td>
              <td>{Number(link.conversion_rate ?? 0).toFixed(1)}%</td>
              <td>
                <button className="icon-button" onClick={() => onCopy(link)} aria-label="Copiar link">
                  <Clipboard size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const crmColumns: { status: LeadStatus; title: string; color: string }[] = [
  { status: "new", title: "Novo", color: "#94a3b8" },
  { status: "contacted", title: "Contato", color: "#f59e0b" },
  { status: "qualified", title: "Qualificado / Remarketing", color: "#3b82f6" },
  { status: "bad", title: "Ruim", color: "#ef4444" },
  { status: "sold", title: "Vendido", color: "#10b981" },
  { status: "lost", title: "Perdido", color: "#6b7280" },
];

const crmFilterOptions: { value: CrmFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "new", label: "Novos" },
  { value: "contacted", label: "Contato" },
  { value: "qualified", label: "Remarketing" },
  { value: "needs_follow_up", label: "Follow-up" },
  { value: "no_identifier", label: "Sem contato" },
  { value: "sold", label: "Vendas" },
];

function CrmPipeline({
  leads,
  allLeads,
  notes,
  contacts,
  followUps,
  revenues,
  busyRef,
  onNoteChange,
  onContactChange,
  onFollowUpChange,
  onRevenueChange,
  onStageChange,
  onOpenLead,
}: {
  leads: Lead[];
  allLeads: Lead[];
  notes: Record<string, string>;
  contacts: Record<string, ContactDraft>;
  followUps: Record<string, string>;
  revenues: Record<string, string>;
  busyRef: string;
  onNoteChange: (leadId: string, value: string) => void;
  onContactChange: (leadId: string, value: Partial<ContactDraft>) => void;
  onFollowUpChange: (leadId: string, value: string) => void;
  onRevenueChange: (leadId: string, value: string) => void;
  onStageChange: (lead: Lead, status: LeadStatus) => void;
  onOpenLead: (lead: Lead) => void;
}) {
  if (!leads.length) return <EmptyState text="Nenhum lead no CRM ainda." />;

  return (
    <div className="crm-pipeline">
      {crmColumns.map((column) => {
        const columnLeads = leads.filter((lead) => lead.lead_status === column.status);
        return (
          <section className="crm-column" key={column.status}>
            <div className="crm-column-head" style={{ borderBottomColor: column.color }}>
              <strong>{column.title}</strong>
              <span style={{ background: column.color }}>{columnLeads.length}</span>
            </div>
            <div className="crm-card-list">
              {columnLeads.length ? (
                columnLeads.map((lead) => {
                  const duplicateLead = duplicateContactLead(lead, contacts[lead.id], allLeads);
                  return (
                  <article className="crm-card" key={lead.id}>
                    <div className="crm-card-top">
                      <div>
                        <strong>{lead.offer_name ?? lead.link_name ?? "Oferta local"}</strong>
                        <small>
                          Ref {lead.ref} · {timeAgo(lead.clicked_at)} · {lead.utm_campaign ?? "sem campanha"}
                        </small>
                      </div>
                      <Status status={lead.lead_status} />
                    </div>
                    <TagRow tags={lead.tags} fallback={lead.utm_source ?? "whatsapp"} />
                    {duplicateLead && (
                      <div className="crm-warning">
                        <span>Telefone já aparece no lead {duplicateLead.ref}.</span>
                        <button type="button" onClick={() => onOpenLead(duplicateLead)}>
                          Abrir lead
                        </button>
                      </div>
                    )}
                    {lead.next_follow_up_at && (
                      <span className={`followup-pill ${isFollowUpDue(lead.next_follow_up_at) ? "due" : ""}`}>
                        Follow-up {formatDate(lead.next_follow_up_at)}
                      </span>
                    )}
                    <div className="crm-contact-grid">
                      <input
                        value={contacts[lead.id]?.name ?? lead.customer_name ?? ""}
                        onChange={(event) => onContactChange(lead.id, { name: event.target.value })}
                        placeholder="Nome do contato"
                      />
                      <input
                        value={contacts[lead.id]?.phone ?? lead.customer_phone ?? ""}
                        onChange={(event) => onContactChange(lead.id, { phone: event.target.value })}
                        placeholder="Telefone para público"
                      />
                      <input
                        value={contacts[lead.id]?.email ?? lead.customer_email ?? ""}
                        onChange={(event) => onContactChange(lead.id, { email: event.target.value })}
                        placeholder="Email opcional"
                        type="email"
                      />
                      <input
                        value={followUps[lead.id] ?? dateTimeLocalValue(lead.next_follow_up_at)}
                        onChange={(event) => onFollowUpChange(lead.id, event.target.value)}
                        placeholder="Próximo follow-up"
                        type="datetime-local"
                      />
                      <input
                        value={revenues[lead.id] ?? (lead.revenue ? String(lead.revenue) : "")}
                        onChange={(event) => onRevenueChange(lead.id, event.target.value)}
                        placeholder="Valor da venda"
                        inputMode="decimal"
                      />
                    </div>
                    <textarea
                      value={notes[lead.id] ?? ""}
                      onChange={(event) => onNoteChange(lead.id, event.target.value)}
                      placeholder="Nota do atendimento"
                      rows={2}
                    />
                    {lead.lead_status !== "sold" && (
                      <div className="crm-actions">
                        <button
                          className="ghost-dark-button"
                          onClick={() => onStageChange(lead, lead.lead_status)}
                          disabled={busyRef === lead.ref}
                        >
                          Salvar
                        </button>
                        <button
                          className="ghost-dark-button"
                          onClick={() => onStageChange(lead, "contacted")}
                          disabled={busyRef === lead.ref || lead.lead_status === "contacted"}
                        >
                          Contato
                        </button>
                        <button
                          className="primary-button"
                          onClick={() => onStageChange(lead, "qualified")}
                          disabled={busyRef === lead.ref || lead.lead_status === "qualified"}
                        >
                          Qualificar
                        </button>
                        <button
                          className="primary-button"
                          onClick={() => onStageChange(lead, "sold")}
                          disabled={busyRef === lead.ref}
                        >
                          Vender
                        </button>
                        <button
                          className="ghost-dark-button"
                          onClick={() => onStageChange(lead, "bad")}
                          disabled={busyRef === lead.ref || lead.lead_status === "bad"}
                        >
                          Ruim
                        </button>
                        <button
                          className="ghost-dark-button"
                          onClick={() => onStageChange(lead, "lost")}
                          disabled={busyRef === lead.ref || lead.lead_status === "lost"}
                        >
                          Perdido
                        </button>
                      </div>
                    )}
                  </article>
                  );
                })
              ) : (
                <div className="crm-empty">Sem leads</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TagRow({ tags, fallback }: { tags?: string[] | null; fallback?: string | null }) {
  const visible = tags?.length ? tags : fallback ? [fallback] : [];
  if (!visible.length) return null;
  return (
    <div className="tag-row">
      {visible.slice(0, 4).map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </div>
  );
}

function CrmHistory({ activities, leads }: { activities: CrmActivity[]; leads: Lead[] }) {
  if (!activities.length) return <EmptyState text="Nenhum movimento no CRM ainda." />;
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  return (
    <div className="history-list">
      {activities.slice(0, 8).map((activity) => {
        const lead = leadById.get(activity.tracking_session_id);
        return (
          <article className="history-row" key={activity.id}>
            <div>
              <strong>{lead?.ref ?? "Lead"}</strong>
              <small>{[lead?.offer_name ?? activity.activity_type, crmActivityDetail(activity)].filter(Boolean).join(" · ")}</small>
            </div>
            <span>
              {activity.from_status && activity.to_status
                ? `${statusLabel(activity.from_status as LeadStatus)} -> ${statusLabel(activity.to_status as LeadStatus)}`
                : activity.activity_type}
            </span>
            <small>{formatDate(activity.created_at)}</small>
          </article>
        );
      })}
    </div>
  );
}

function crmActivityDetail(activity: CrmActivity): string {
  if (activity.metadata?.contact_changed === true) return "contato alterado";
  if (activity.activity_type === "capi" && activity.metadata?.ok === false) return "CAPI com falha";
  if (activity.activity_type === "system" && String(activity.body ?? "").includes("meta_audience")) return "público Meta";
  return "";
}

function TenantUsersList({ users }: { users: TenantUser[] }) {
  if (!users.length) return <EmptyState text="Nenhum usuário vinculado ainda." />;
  return (
    <div className="user-list">
      {users.map((user) => (
        <article className={`user-row user-row-${user.role}`} key={user.id}>
          <div>
            <strong>{user.email || "Usuário sem email"}</strong>
            <small>{user.created_at ? `Criado em ${formatDate(user.created_at)}` : "Acesso vinculado"}</small>
          </div>
          <span>{userRoleLabel(user.role)}</span>
          <StatusPill text={userStatusLabel(user.status)} tone={user.status === "active" ? "good" : "muted"} />
        </article>
      ))}
    </div>
  );
}

function SellerAccessPreview() {
  return (
    <div className="seller-access-preview" aria-label="Prévia do acesso de vendedor">
      <div className="preview-topbar">
        <strong>IDX.</strong>
        <span>Vendedor</span>
      </div>
      <div className="preview-screen">
        <div className="preview-head">
          <small>Acesso reduzido</small>
          <strong>Atender</strong>
        </div>
        <div className="preview-metrics">
          <span>Fila 4</span>
          <span>Remarketing 2</span>
        </div>
        <div className="preview-lead active">
          <div>
            <strong>Lead WhatsApp</strong>
            <small>Campanha CNH · agora</small>
          </div>
          <span>Novo</span>
        </div>
        <div className="preview-actions">
          <button type="button"><PhoneCall size={14} /> WhatsApp</button>
          <button type="button"><Check size={14} /> Qualificar</button>
        </div>
        <div className="preview-tabs">
          <span><PhoneCall size={13} /> Atender</span>
          <span><MessageCircle size={13} /> Leads</span>
          <span><MoreHorizontal size={13} /> Mais</span>
        </div>
      </div>
    </div>
  );
}

function MetaAssetsSelector({
  accounts,
  selected,
  loaded,
  onChange,
  onSave,
  busy,
}: {
  accounts: MetaAdAccountAsset[];
  selected: string;
  loaded: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  busy: boolean;
}) {
  if (!loaded) {
    return <EmptyState text="Conecte o Facebook e busque os ativos para selecionar conta e Pixel." />;
  }

  if (!accounts.length) {
    return <EmptyState text="Nenhuma conta de anúncios retornada pelo Meta." />;
  }

  return (
    <div className="meta-assets-box">
      <select value={selected} onChange={(event) => onChange(event.target.value)}>
        {accounts.flatMap((account) => {
          const pixels = accountPixels(account);
          if (!pixels.length) {
            return (
              <option key={account.id} value={metaAssetValue(account.id)}>
                {account.name ?? account.id} · sem Pixel listado
              </option>
            );
          }

          return pixels.map((pixel) => (
            <option key={`${account.id}-${pixel.id}`} value={metaAssetValue(account.id, pixel.id)}>
              {account.name ?? account.id} · {pixel.name ?? pixel.id}
            </option>
          ));
        })}
      </select>
      <button className="primary-button" onClick={onSave} disabled={busy || !selected}>
        Usar estes ativos
      </button>
    </div>
  );
}

function MetaRoiTable({ campaigns }: { campaigns: MetaCampaignRoi[] }) {
  if (!campaigns.length) return <EmptyState text="Nenhum gasto Meta sincronizado ainda." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Campanha</th>
            <th>Gasto</th>
            <th>Cliques Meta</th>
            <th>Leads IDX</th>
            <th>Qualificados</th>
            <th>Vendas</th>
            <th>CPL</th>
            <th>CP Qual.</th>
            <th>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <tr key={campaign.campaign_id}>
              <td>
                <strong>{campaign.campaign_name}</strong>
                <small>{campaign.campaign_id}</small>
              </td>
              <td>{formatMoney(campaign.spend)}</td>
              <td>{Number(campaign.meta_clicks ?? 0).toLocaleString("pt-BR")}</td>
              <td>{campaign.idx_leads ?? 0}</td>
              <td>{campaign.idx_qualified ?? 0}</td>
              <td>{campaign.idx_sales ?? 0}</td>
              <td>{campaign.cpl == null ? "-" : formatMoney(campaign.cpl)}</td>
              <td>{campaign.cost_per_qualified == null ? "-" : formatMoney(campaign.cost_per_qualified)}</td>
              <td>{campaign.roas == null ? "-" : `${Number(campaign.roas).toFixed(2)}x`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetaAudiencesTable({ audiences }: { audiences: MetaAudienceStatus[] }) {
  const defaults: MetaAudienceStatus[] = [
    {
      tenant_id: "",
      audience_key: "qualified",
      name: "IDX - Leads qualificados",
      sync_status: "not_created",
      synced_members: 0,
      failed_members: 0,
      skipped_members: 0,
      total_attempts: 0,
    },
    {
      tenant_id: "",
      audience_key: "purchased",
      name: "IDX - Compradores",
      sync_status: "not_created",
      synced_members: 0,
      failed_members: 0,
      skipped_members: 0,
      total_attempts: 0,
    },
  ];
  const expected = defaults.map((item) => audiences.find((audience) => audience.audience_key === item.audience_key) ?? item);

  return (
    <div className="audience-grid">
      {expected.map((audience) => (
        <article className="audience-row" key={audience.audience_key}>
          <div>
            <strong>{audience.name}</strong>
            <small>{audience.meta_audience_id ? `Meta ID ${audience.meta_audience_id}` : "Ainda não criado no Meta"}</small>
          </div>
          <div className="audience-stats">
            <span>{audienceStatusLabel(audience.sync_status)}</span>
            <strong>{audience.synced_members}</strong>
            <small>sincronizados</small>
          </div>
          <div className="audience-stats muted">
            <strong>{audience.skipped_members}</strong>
            <small>sem telefone/email</small>
          </div>
        </article>
      ))}
    </div>
  );
}

function IntegrationAlerts({
  checklist,
  audiences,
  leads,
  health,
  campaigns,
}: {
  checklist: ReadinessItem[];
  audiences: MetaAudienceStatus[];
  leads: Lead[];
  health: CapiHealth;
  campaigns: MetaCampaignRoi[];
}) {
  const missing = checklist.filter((item) => !item.done && ["Meta CAPI", "Conta Meta Ads", "Públicos automáticos", "Smart Link com UTM"].includes(item.title));
  const skippedMembers = audiences.reduce((sum, item) => sum + Number(item.skipped_members ?? 0), 0);
  const failedMembers = audiences.reduce((sum, item) => sum + Number(item.failed_members ?? 0), 0);
  const leadsWithoutIdentifier = leads.filter((lead) => !lead.customer_phone && !lead.customer_email).length;
  const alerts = [
    ...missing.map((item) => ({ title: item.title, detail: item.detail, tone: "warning" as const })),
    ...(health.failed_events ? [{ title: "Falhas CAPI", detail: `${health.failed_events} evento(s) com falha nos últimos 7 dias`, tone: "warning" as const }] : []),
    ...(skippedMembers ? [{ title: "Públicos incompletos", detail: `${skippedMembers} lead(s) sem telefone/email para enviar ao Meta`, tone: "warning" as const }] : []),
    ...(failedMembers ? [{ title: "Sincronização Meta", detail: `${failedMembers} tentativa(s) de público falharam`, tone: "warning" as const }] : []),
    ...(leads.length && leadsWithoutIdentifier ? [{ title: "Identificação do lead", detail: `${leadsWithoutIdentifier} lead(s) ainda sem telefone/email no CRM`, tone: "neutral" as const }] : []),
    ...(campaigns.length ? [] : [{ title: "Gastos Meta", detail: "Nenhuma campanha sincronizada para cruzar investimento com qualidade", tone: "neutral" as const }]),
  ];

  if (!alerts.length) return <EmptyState text="Nenhum alerta de integração no momento." />;

  return (
    <div className="alert-list">
      {alerts.map((alert) => (
        <article className={`alert-row alert-${alert.tone}`} key={`${alert.title}-${alert.detail}`}>
          <strong>{alert.title}</strong>
          <span>{alert.detail}</span>
        </article>
      ))}
    </div>
  );
}

function ExecutiveInsights({ insights }: { insights: ExecutiveInsight[] }) {
  if (!insights.length) return <EmptyState text="Ainda não há dados suficientes para recomendações." />;
  return (
    <div className="insight-grid">
      {insights.map((insight) => (
        <article className={`insight-card insight-${insight.tone}`} key={insight.title}>
          <strong>{insight.title}</strong>
          <p>{insight.detail}</p>
        </article>
      ))}
    </div>
  );
}

function ClientHealthTable({
  tenants,
  summaries,
  selectedTenantId,
  onSelect,
}: {
  tenants: Tenant[];
  summaries: TenantSummary[];
  selectedTenantId?: string;
  onSelect: (tenantId: string) => void;
}) {
  if (!tenants.length) return <EmptyState text="Nenhum cliente cadastrado." />;
  const byTenant = new Map(summaries.map((summary) => [summary.tenant_id, summary]));

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Implantação</th>
            <th>Links</th>
            <th>Leads</th>
            <th>CRM</th>
            <th>CAPI</th>
            <th>Meta</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => {
            const summary = byTenant.get(tenant.id);
            const score = [
              Boolean(tenant.whatsapp_number),
              Boolean(summary?.smart_links),
              Boolean(summary?.tracking_sessions),
              Boolean(summary?.crm_activities),
              Boolean(summary?.capi_events),
              Boolean(summary?.meta_insight_rows),
            ].filter(Boolean).length;
            const status = score >= 5 ? "Operando" : score >= 3 ? "Em implantação" : "Precisa setup";

            return (
              <tr key={tenant.id} className={tenant.id === selectedTenantId ? "selected-row" : ""}>
                <td>
                  <strong>{tenant.name}</strong>
                  <small>{tenant.slug}</small>
                </td>
                <td>{status}</td>
                <td>{summary?.smart_links ?? 0}</td>
                <td>{summary?.tracking_sessions ?? 0}</td>
                <td>{summary?.crm_activities ?? 0}</td>
                <td>{summary?.capi_events ?? 0}</td>
                <td>{summary?.meta_insight_rows ?? 0}</td>
                <td>
                  <button className="ghost-dark-button table-action" type="button" onClick={() => onSelect(tenant.id)}>
                    Abrir
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LeadQualityTable({ rows }: { rows: QualityRow[] }) {
  if (!rows.length) return <EmptyState text="Sem leads suficientes para relatório de qualidade." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Campanha</th>
            <th>Leads</th>
            <th>Contato</th>
            <th>Remarketing</th>
            <th>Ruins</th>
            <th>Vendas</th>
            <th>Qualidade</th>
            <th>CP Qual.</th>
            <th>Receita</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.campaign}>
              <td>
                <strong>{row.campaign}</strong>
                <small>Gasto Meta {formatMoney(row.spend)}</small>
              </td>
              <td>{row.leads}</td>
              <td>{row.contacted}</td>
              <td>{row.qualified}</td>
              <td>{row.bad}</td>
              <td>{row.sales}</td>
              <td>{row.qualityRate.toFixed(1)}%</td>
              <td>{row.costPerQualified == null ? "-" : formatMoney(row.costPerQualified)}</td>
              <td>{formatMoney(row.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadList({ leads, compact = false }: { leads: Lead[]; compact?: boolean }) {
  if (!leads.length) return <EmptyState text="Nenhum atendimento ainda." />;
  return (
    <div className={`lead-list ${compact ? "compact" : ""}`}>
      {leads.map((lead) => (
        <article className="lead-row" key={lead.id}>
          <div>
            <strong>{lead.offer_name ?? lead.link_name ?? "Oferta local"}</strong>
            <small>
              Ref {lead.ref} · {timeAgo(lead.clicked_at)} · {lead.utm_campaign ?? "sem campanha"}
            </small>
          </div>
          <Status status={lead.lead_status} />
          <span>{lead.revenue ? formatMoney(lead.revenue) : formatDate(lead.clicked_at)}</span>
        </article>
      ))}
    </div>
  );
}

function EventsTable({ events }: { events: CapiEvent[] }) {
  if (!events.length) return <EmptyState text="Nenhum evento CAPI registrado." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Evento</th>
            <th>Status</th>
            <th>HTTP</th>
            <th>Erro</th>
            <th>Hora</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.created_at}-${index}`}>
              <td>{event.event_name}</td>
              <td>{event.ok ? "OK" : "Falha"}</td>
              <td>{event.status_code ?? "-"}</td>
              <td>{event.error_message ?? "-"}</td>
              <td>{formatDate(event.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Status({ status }: { status: Lead["lead_status"] }) {
  return <span className={`status status-${status}`}>{statusLabel(status)}</span>;
}

function StatusPill({ text, tone }: { text: string; tone: "good" | "muted" }) {
  return <span className={`status-pill status-pill-${tone}`}>{text}</span>;
}

function statusLabel(status: LeadStatus | string): string {
  return {
    new: "Aguardando",
    contacted: "Contato",
    qualified: "Remarketing",
    bad: "Ruim",
    sold: "Vendido",
    lost: "Perdido",
  }[status] ?? String(status);
}

function audienceStatusLabel(status: MetaAudienceStatus["sync_status"]): string {
  return {
    not_created: "Não criado",
    created: "Criado",
    syncing: "Sincronizando",
    synced: "Sincronizado",
    failed: "Falha",
  }[status];
}

function crmUpdateToast(data: { capi_ok?: boolean | null; audience_sync?: { status?: string; error?: string } | null }, status: LeadStatus): string {
  if (status === "qualified" || status === "sold") {
    if (data.audience_sync?.status === "synced") return "CRM atualizado e lead enviado ao público Meta.";
    if (data.audience_sync?.status === "skipped") return "CRM atualizado. Informe telefone/email para entrar no público Meta.";
    if (data.audience_sync?.status === "failed") return `CRM atualizado. Público Meta com erro: ${data.audience_sync.error ?? "verifique a integração"}.`;
  }

  return data.capi_ok === false ? "CRM atualizado. CAPI sem credencial ou com erro." : "CRM atualizado e sinal enviado ao Meta.";
}

function userRoleLabel(role: TenantUser["role"]): string {
  return {
    owner: "Owner",
    admin: "Admin",
    operator: "Vendedor / Atendimento",
    viewer: "Visualizador",
  }[role];
}

function platformRoleLabel(role: PlatformRole | null): string {
  if (!role) return "Empresa";
  return {
    owner: "Owner",
    admin: "Admin",
    support: "Gestor de tráfego",
    viewer: "Leitura",
  }[role];
}

// Resultado do retorno do Google (?google=...&reason=...), definido pela Edge Function google-oauth.
const GOOGLE_RETURN_MESSAGES: Record<string, string> = {
  connected: "Google Ads conectado e conta vinculada. Importando campanhas...",
  select_account: "Google autorizado. Escolha qual conta do Google Ads pertence a esta empresa.",
  authorized: "Google autorizado, mas o Google Ads ainda não foi vinculado.",
  access_denied: "Conexão cancelada no Google. Clique em Conectar Google Ads e aceite as permissões.",
  invalid_state: "O link de conexão expirou ou já foi usado. Clique em Conectar Google Ads de novo.",
  token_exchange_failed: "O Google não liberou o token. Confira se a redirect_uri está cadastrada no cliente OAuth do Google Cloud.",
  missing_refresh_token: "O Google não enviou o token de acesso contínuo. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.",
  save_failed: "Não foi possível salvar a conexão com o Google. Tente de novo.",
  error: "Não foi possível concluir a conexão com o Google. Tente de novo.",
};

// Erros da Google Ads API devolvidos pelas Edge Functions google-ads e google-oauth.
const GOOGLE_ADS_ERRORS: Record<string, string> = {
  developer_token_missing: "Falta configurar o GOOGLE_DEVELOPER_TOKEN no Supabase. Sem ele a Google Ads API não responde.",
  developer_token_not_approved: "O developer token do Google Ads só tem acesso de teste. Solicite o acesso Básico na Central de API da conta MCC.",
  developer_token_invalid: "O developer token do Google Ads é inválido. Confira o GOOGLE_DEVELOPER_TOKEN no Supabase.",
  google_token_invalid: "A autorização do Google expirou ou foi revogada. Conecte o Google Ads de novo.",
  google_not_connected: "Google Ads não conectado. Clique em Conectar Google Ads.",
  google_account_not_selected: "Escolha a conta do Google Ads desta empresa antes de sincronizar.",
  ads_api_disabled: "A Google Ads API não está ativada no projeto do Google Cloud. Ative em APIs e serviços → Biblioteca.",
  ads_api_version_unsupported: "A versão da Google Ads API usada foi desativada pelo Google. Atualize o secret GOOGLE_ADS_API_VERSION.",
  permission_denied: "Este login do Google não tem permissão nessa conta do Google Ads (ou na MCC). Peça acesso ou escolha outra conta.",
  customer_not_enabled: "A conta do Google Ads está cancelada ou suspensa.",
  customer_not_accessible: "Essa conta não está entre as que este login do Google acessa.",
  not_ads_user: "Este login do Google não tem nenhuma conta do Google Ads.",
  no_ads_accounts: "Este login do Google não acessa nenhuma conta ativa do Google Ads.",
  quota_exceeded: "Limite de requisições da Google Ads API atingido. Tente de novo em alguns minutos.",
  ads_api_error: "A Google Ads API retornou um erro. Veja o detalhe abaixo e tente de novo.",
  save_failed: "Os dados vieram do Google, mas não foram salvos. Tente de novo.",
};

function googleAdsMessage(code?: string | null, fallback = "Erro no Google Ads."): string {
  if (!code) return fallback;
  return GOOGLE_ADS_ERRORS[code] ?? GOOGLE_RETURN_MESSAGES[code] ?? fallback;
}

// last_error é gravado como "codigo: detalhe".
function googleErrorCode(lastError?: string | null): string {
  return String(lastError ?? "").split(":")[0].trim();
}


// Estado real da integração Google Ads, em etapas: autorizar o Google, vincular
// a conta Ads da empresa e sincronizar. Usado em Integrações e em Google Ads.
function GoogleAdsConnection({
  creds,
  devTokenOk,
  busy,
  customers,
  syncDays,
  onSyncDaysChange,
  onConnect,
  onListCustomers,
  onSelectCustomer,
  onSync,
  onDisconnect,
  onOpenDashboard,
}: {
  creds: GoogleCredentials | null;
  devTokenOk: boolean;
  busy: boolean;
  customers: GoogleCustomer[];
  syncDays: number;
  onSyncDaysChange: (days: number) => void;
  onConnect: () => void;
  onListCustomers: () => void;
  onSelectCustomer: (customer: GoogleCustomer) => void;
  onSync: () => void;
  onDisconnect: () => void;
  onOpenDashboard?: () => void;
}) {
  const stage = creds?.stage ?? (creds?.integration_status === "connected" ? "account_selected" : "not_connected");
  const errorCode = googleErrorCode(creds?.last_error);

  if (stage === "not_connected") {
    return (
      <div className="google-connect-box">
        <p className="muted" style={{ marginBottom: 12 }}>Conecte via OAuth para importar campanhas e enviar conversões offline ao Google Ads.</p>
        <button className="primary-button" onClick={onConnect} disabled={busy}>
          Conectar Google Ads <ArrowRight size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="google-connect-box">
      <div className="google-status-row">
        <div className="google-status-connected">
          {stage === "synced" || stage === "account_selected" ? <><Check size={16} /> Google Ads conectado</> : stage === "needs_account" ? "Google autorizado — falta vincular a conta Google Ads" : "Google Ads precisa de atenção"}
          {creds?.google_user_email && <span className="muted"> — {creds.google_user_email}</span>}
        </div>

        {creds?.customer_id && (
          <div className="settings-grid compact-grid">
            <ReadOnly label="Conta Google Ads" value={creds.customer_descriptive_name ?? "—"} />
            <ReadOnly label="ID da conta" value={creds.customer_id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")} />
            {creds.manager_customer_id && <ReadOnly label="Via MCC" value={creds.manager_customer_id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")} />}
            <ReadOnly label="Última sincronização" value={creds.last_synced_at ? formatDate(creds.last_synced_at) : "Ainda não sincronizado"} />
          </div>
        )}

        {!devTokenOk && <div className="google-error-box">{googleAdsMessage("developer_token_missing")}</div>}
        {creds?.last_error && (stage === "needs_attention" || stage === "needs_account") && (
          <div className="google-error-box">
            {googleAdsMessage(errorCode, "Atenção:")}
            <small style={{ display: "block", marginTop: 4, opacity: 0.8 }}>{creds.last_error}</small>
          </div>
        )}

        {stage === "needs_account" && customers.length === 0 && (
          <p className="muted" style={{ marginTop: 8 }}>Escolha qual conta do Google Ads pertence a esta empresa.</p>
        )}

        {customers.length > 0 && (
          <div className="google-customer-list">
            <label className="mini-label">Selecionar conta Google Ads desta empresa</label>
            {customers.map((customer) => (
              <button
                key={customer.id}
                className={`ghost-button ${customer.id === creds?.customer_id ? "active" : ""}`}
                onClick={() => onSelectCustomer(customer)}
                disabled={busy}
              >
                {customer.name} ({customer.id}){customer.via_manager_name ? ` — via ${customer.via_manager_name}` : ""}
              </button>
            ))}
          </div>
        )}

        <div className="ad-sync-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          {(stage === "account_selected" || stage === "synced") && (
            <>
              <select value={syncDays} onChange={(event) => onSyncDaysChange(Number(event.target.value))}>
                <option value={7}>7 dias</option>
                <option value={14}>14 dias</option>
                <option value={30}>30 dias</option>
                <option value={60}>60 dias</option>
                <option value={90}>90 dias</option>
              </select>
              <button className="primary-button" onClick={onSync} disabled={busy}>
                <RefreshCw size={15} /> Sincronizar agora
              </button>
            </>
          )}
          {stage === "needs_attention" && creds?.customer_id && errorCode !== "google_token_invalid" && (
            <button className="primary-button" onClick={onSync} disabled={busy}>
              <RefreshCw size={15} /> Tentar sincronizar de novo
            </button>
          )}
          <button className={stage === "needs_account" ? "primary-button" : "ghost-button"} onClick={onListCustomers} disabled={busy}>
            {creds?.customer_id ? "Trocar conta" : "Escolher conta Google Ads"}
          </button>
          {(stage === "needs_attention" || errorCode === "google_token_invalid") && (
            <button className="ghost-button" onClick={onConnect} disabled={busy}>Reconectar Google</button>
          )}
          {onOpenDashboard && (stage === "account_selected" || stage === "synced") && (
            <button className="ghost-button" onClick={onOpenDashboard} disabled={busy}>Dashboard Google Ads</button>
          )}
          <button className="ghost-button" onClick={onDisconnect} disabled={busy}>Desconectar</button>
        </div>
      </div>
    </div>
  );
}

function humanError(error?: string | null): string {
  return {
    invalid_tenant_payload: "Preencha nome, segmento e WhatsApp real com DDI/DDD. Exemplo: 5564999999999.",
    platform_admin_required: "Este login não tem permissão de gestor IDX para criar clientes.",
    missing_tenant_id: "Selecione uma empresa antes de continuar.",
    forbidden: "Seu login não tem permissão para esta ação.",
    contact_match_not_found: "Não encontrei lead com esse telefone. Salve o contato no card do CRM ou informe a ref.",
    ambiguous_contact_match: "Encontrei mais de um lead para esse contato. Informe a ref para confirmar sem risco.",
    missing_contact_identifier: "Informe telefone ou email do cliente para localizar o lead.",
    missing_meta_app_env: "Facebook Login ainda não está configurado. Informe META_APP_ID e META_APP_SECRET da Meta App, ou use Pixel ID + Token CAPI.",
    missing_meta_credentials: "Salve Pixel ID e Token CAPI antes de testar ou sincronizar eventos.",
    meta_not_connected: "Conecte a Meta com Pixel ID + Token CAPI ou Facebook Login antes de sincronizar.",
    invalid_revenue: "Informe o valor real da venda no card do lead.",
  }[String(error ?? "")] ?? String(error ?? "");
}

function dateTimeLocalValue(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeToIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isFollowUpDue(value?: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function moneyInputToNumber(value: string): number {
  const clean = value.trim().replace(/[^\d,.-]/g, "");
  const comma = clean.lastIndexOf(",");
  const dot = clean.lastIndexOf(".");
  if (comma >= 0) return Number(clean.replace(/\./g, "").replace(",", "."));
  if ((clean.match(/\./g) ?? []).length > 1) return Number(clean.replace(/\./g, ""));
  if (dot >= 0 && clean.length - dot - 1 === 3) return Number(clean.replace(".", ""));
  return Number(clean.replace(/,/g, ""));
}

function userStatusLabel(status: TenantUser["status"]): string {
  return {
    active: "Ativo",
    invited: "Convidado",
    disabled: "Desativado",
  }[status];
}

function buildExecutiveInsights(
  rows: QualityRow[],
  checklist: ReadinessItem[],
  health: CapiHealth,
  audiences: MetaAudienceStatus[],
): ExecutiveInsight[] {
  const insights: ExecutiveInsight[] = [];
  const firstMissing = checklist.find((item) => !item.done);

  if (firstMissing) {
    insights.push({
      title: "Próximo bloqueio",
      detail: `${firstMissing.title}: ${firstMissing.detail}`,
      tone: "warning",
    });
  }

  const bestByQuality = rows
    .filter((row) => row.leads > 0)
    .sort((a, b) => b.qualityRate - a.qualityRate || b.sales - a.sales || b.revenue - a.revenue)[0];

  if (bestByQuality) {
    insights.push({
      title: "Campanha com melhor qualidade",
      detail: `${bestByQuality.campaign}: ${bestByQuality.qualityRate.toFixed(1)}% de qualidade, ${bestByQuality.qualified} lead(s) em remarketing e ${bestByQuality.sales} venda(s).`,
      tone: bestByQuality.qualityRate > 0 ? "good" : "neutral",
    });
  }

  const bestByRevenue = rows.filter((row) => row.revenue > 0).sort((a, b) => b.revenue - a.revenue)[0];
  if (bestByRevenue) {
    insights.push({
      title: "Campanha com receita confirmada",
      detail: `${bestByRevenue.campaign}: ${formatMoney(bestByRevenue.revenue)} em vendas registradas no CRM.`,
      tone: "good",
    });
  }

  const audienceIssues = audiences.reduce((sum, audience) => sum + Number(audience.skipped_members ?? 0) + Number(audience.failed_members ?? 0), 0);
  if (audienceIssues) {
    insights.push({
      title: "Ajuste de público",
      detail: `${audienceIssues} tentativa(s) de público precisam de telefone/email válido ou revisão da integração Meta.`,
      tone: "warning",
    });
  }

  if (health.total_events > 0) {
    insights.push({
      title: "Saúde CAPI",
      detail: `${health.success_rate}% de sucesso em ${health.total_events} evento(s) recentes.`,
      tone: health.success_rate >= 90 ? "good" : "warning",
    });
  }

  return insights.slice(0, 4);
}

function buildQualityRows(leads: Lead[], campaigns: MetaCampaignRoi[]): QualityRow[] {
  const rows = new Map<string, QualityRow>();

  for (const lead of leads) {
    const campaign = lead.utm_campaign || "sem-campanha";
    const row = rows.get(campaign) ?? {
      campaign,
      spend: 0,
      leads: 0,
      contacted: 0,
      qualified: 0,
      bad: 0,
      sales: 0,
      revenue: 0,
      qualityRate: 0,
      cpl: null,
      costPerQualified: null,
      roas: null,
    };

    row.leads += 1;
    if (lead.lead_status === "contacted") row.contacted += 1;
    if (lead.lead_status === "qualified") row.qualified += 1;
    if (lead.lead_status === "bad") row.bad += 1;
    if (lead.lead_status === "sold") {
      row.sales += 1;
      row.revenue += Number(lead.revenue ?? 0);
    }
    rows.set(campaign, row);
  }

  for (const campaign of campaigns) {
    const key = campaign.campaign_name || campaign.campaign_id;
    const row = rows.get(key) ?? {
      campaign: key,
      spend: 0,
      leads: Number(campaign.idx_leads ?? 0),
      contacted: 0,
      qualified: Number(campaign.idx_qualified ?? 0),
      bad: Number(campaign.idx_bad ?? 0),
      sales: Number(campaign.idx_sales ?? 0),
      revenue: Number(campaign.idx_revenue ?? 0),
      qualityRate: 0,
      cpl: null,
      costPerQualified: null,
      roas: null,
    };
    row.spend = Number(campaign.spend ?? row.spend);
    row.leads = campaign.idx_leads == null ? row.leads : Number(campaign.idx_leads);
    row.qualified = campaign.idx_qualified == null ? row.qualified : Number(campaign.idx_qualified);
    row.bad = campaign.idx_bad == null ? row.bad : Number(campaign.idx_bad);
    row.sales = campaign.idx_sales == null ? row.sales : Number(campaign.idx_sales);
    row.revenue = campaign.idx_revenue == null ? row.revenue : Number(campaign.idx_revenue);
    row.cpl = campaign.cpl ?? (row.leads ? row.spend / row.leads : null);
    row.costPerQualified = campaign.cost_per_qualified ?? (row.qualified ? row.spend / row.qualified : null);
    row.roas = campaign.roas ?? (row.spend ? row.revenue / row.spend : null);
    rows.set(key, row);
  }

  return Array.from(rows.values())
    .map((row) => ({
      ...row,
      qualityRate: row.leads ? (row.qualified / row.leads) * 100 : 0,
      cpl: row.cpl ?? (row.leads && row.spend ? row.spend / row.leads : null),
      costPerQualified: row.costPerQualified ?? (row.qualified && row.spend ? row.spend / row.qualified : null),
      roas: row.roas ?? (row.spend ? row.revenue / row.spend : null),
    }))
    .sort((a, b) => b.spend - a.spend || b.leads - a.leads);
}

function ReadOnly({ label, value }: { label: string; value?: string }) {
  return (
    <div className="readonly">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function CheckItem({ text }: { text: string }) {
  return (
    <div className="check-item">
      <Check size={15} />
      <span>{text}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function sectionTitle(section: Section): string {
  return {
    dashboard: "Dashboard",
    sales: "Atender",
    links: "Links e Atribuição",
    leads: "Atendimentos",
    crm: "CRM",
    integrations: "Integrações",
    whatsapp: "WhatsApp",
    clients: "Clientes",
    users: "Usuários",
    reports: "Relatórios",
    capi: "CAPI Health",
    "ai-sales": "Vendas IA",
    intelligence: "Inteligência Financeira",
    settings: "Configuração",
    "follow-ups": "Follow-ups",
    segments: "Segmentação",
    "google-ads": "Google Ads",
  }[section];
}

function MonthlyChart({ data }: { data: MonthlyPoint[] }) {
  if (data.length < 2) return null;
  const maxRevenue = Math.max(...data.map((d) => d.revenue), 1);
  const maxSpend = Math.max(...data.map((d) => d.spend), 1);
  const maxVal = Math.max(maxRevenue, maxSpend) * 1.1;
  const w = 720;
  const h = 240;
  const pad = { top: 28, right: 16, bottom: 40, left: 16 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const step = cw / (data.length - 1);

  function yScale(v: number) {
    return pad.top + ch - (v / maxVal) * ch;
  }

  const revLine = data.map((d, i) => `${i === 0 ? "M" : "L"}${pad.left + i * step},${yScale(d.revenue)}`).join(" ");
  const revArea = revLine + ` L${pad.left + (data.length - 1) * step},${pad.top + ch} L${pad.left},${pad.top + ch} Z`;
  const spendLine = data.map((d, i) => `${i === 0 ? "M" : "L"}${pad.left + i * step},${yScale(d.spend)}`).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((pct) => pad.top + ch * (1 - pct));

  return (
    <div className="fi-chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="fi-chart">
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#111" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLines.map((y, i) => (
          <line key={i} x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="#e5e7eb" strokeWidth="1" />
        ))}
        <path d={revArea} fill="url(#revGrad)" />
        <path d={revLine} fill="none" stroke="#111" strokeWidth="2.5" strokeLinejoin="round" />
        <path d={spendLine} fill="none" stroke="#ef4444" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" />
        {data.map((d, i) => (
          <g key={d.month}>
            <circle cx={pad.left + i * step} cy={yScale(d.revenue)} r="4" fill="#111" stroke="#fff" strokeWidth="2" />
            <circle cx={pad.left + i * step} cy={yScale(d.spend)} r="3" fill="#ef4444" stroke="#fff" strokeWidth="1.5" />
            <text x={pad.left + i * step} y={h - 8} textAnchor="middle" fontSize="10" fill="#94a3b8" fontWeight="500">
              {new Date(d.month).toLocaleDateString("pt-BR", { month: "short" })}
            </text>
          </g>
        ))}
        <circle cx={pad.left} cy={pad.top - 10} r="4" fill="#111" />
        <text x={pad.left + 10} y={pad.top - 6} fontSize="10" fill="#111" fontWeight="600">Receita</text>
        <line x1={pad.left + 70} y1={pad.top - 10} x2={pad.left + 86} y2={pad.top - 10} stroke="#ef4444" strokeWidth="2" strokeDasharray="4 3" />
        <text x={pad.left + 92} y={pad.top - 6} fontSize="10" fill="#ef4444" fontWeight="500">Investimento</text>
      </svg>
    </div>
  );
}
