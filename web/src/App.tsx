import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  CircleDot,
  Clipboard,
  FileText,
  Gauge,
  LayoutList,
  Link2,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
} from "lucide-react";
import { supabase } from "./lib/supabaseClient";
import type { CapiEvent, CapiHealth, CrmActivity, Lead, LeadStatus, MetaAudienceStatus, MetaCampaignRoi, Offer, SmartLink, Tenant, TenantUser } from "./lib/types";
import { envConfigured, formatDate, formatMoney, linkCode, slugify, smartLinkUrl, timeAgo } from "./lib/utils";

type Section = "dashboard" | "links" | "leads" | "crm" | "integrations" | "clients" | "users" | "reports" | "capi" | "settings";

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

const META_OAUTH_CALLBACK_URL = "https://cro.idxparasuaempresa.com.br/meta-oauth-callback.html";

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

function authRedirectTo() {
  return `${window.location.origin}${window.location.pathname}`;
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

export function App() {
  const isConfigured = envConfigured() && Boolean(supabase);
  const requestedTenantSlug = useMemo(() => tenantSlugFromPath(), []);
  const [sessionReady, setSessionReady] = useState(!isConfigured);
  const [signedIn, setSignedIn] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [tenantSetupRequired, setTenantSetupRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [active, setActive] = useState<Section>("dashboard");
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
  const [clientDraft, setClientDraft] = useState<ClientDraft>(emptyClientDraft);
  const [profileDraft, setProfileDraft] = useState<ClientDraft>(emptyClientDraft);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(emptyInviteDraft);
  const [metaDraft, setMetaDraft] = useState<MetaDraft>(emptyMetaDraft);
  const [adAccountId, setAdAccountId] = useState("");
  const [metaAdAccounts, setMetaAdAccounts] = useState<MetaAdAccountAsset[]>([]);
  const [selectedMetaAsset, setSelectedMetaAsset] = useState("");
  const [metaAssetsLoaded, setMetaAssetsLoaded] = useState(false);
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

  const tenant = tenants.find((item) => item.id === tenantId) ?? tenants[0];
  const isPlatformUser = Boolean(platformRole);
  const canCreateClients = ["owner", "admin", "support"].includes(String(platformRole)) || tenantSetupRequired;
  const tenantLinks = links.filter((item) => item.tenant_id === tenant?.id);
  const tenantLeads = leads.filter((item) => item.tenant_id === tenant?.id);
  const tenantOffers = offers.filter((item) => item.tenant_id === tenant?.id);
  const tenantMetaCampaigns = metaCampaigns.filter((item) => item.tenant_id === tenant?.id);
  const tenantCrmActivities = crmActivities.filter((item) => item.tenant_id === tenant?.id);
  const remarketingLeads = tenantLeads.filter((lead) => lead.lead_status === "qualified");
  const hasOperationalData = tenantLinks.length > 0 || tenantLeads.length > 0;
  const needsOperationalOnboarding = Boolean(tenant && !loading && !hasOperationalData);
  const qualityRows = useMemo(() => buildQualityRows(tenantLeads, tenantMetaCampaigns), [tenantLeads, tenantMetaCampaigns]);
  const tenantSummary = tenantSummaries.find((item) => item.tenant_id === tenant?.id);
  const secondaryMobileSections: Section[] = ["leads", "clients", "users", "reports", "capi", "settings"];
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
    if (section && ["dashboard", "links", "leads", "crm", "integrations", "clients", "users", "reports", "capi", "settings"].includes(section)) {
      setActive(section);
    }
  }, []);

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
    await loadInitialData();
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
      supabase.from("tenant_users").select("id, tenant_id, email, role, status, created_at").eq("tenant_id", nextTenantId).order("created_at", { ascending: true }),
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

  async function inviteUser() {
    if (!tenant || !inviteDraft.email.trim()) {
      setToast("Informe o email do usuário.");
      return;
    }

    if (!isConfigured || !supabase) {
      setInviteDraft(emptyInviteDraft);
      setToast("Configure o Supabase para enviar convites reais.");
      return;
    }

    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "invite_user",
        tenant_id: tenant.id,
        email: inviteDraft.email,
        role: inviteDraft.role,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setToast(data.error || "Erro ao convidar usuário.");
    setInviteDraft(emptyInviteDraft);
    setToast("Convite enviado por email.");
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
          <nav className="nav-list">
            <NavButton icon={<Gauge />} label="Dashboard" active={active === "dashboard"} onClick={() => goToSection("dashboard")} />
            <NavButton icon={<Link2 />} label="Links" active={active === "links"} onClick={() => goToSection("links")} />
            <NavButton icon={<MessageCircle />} label="Atendimentos" active={active === "leads"} onClick={() => goToSection("leads")} />
            <NavButton icon={<LayoutList />} label="CRM" active={active === "crm"} onClick={() => goToSection("crm")} />
            <NavButton icon={<ShieldCheck />} label="Integrações" active={active === "integrations"} onClick={() => goToSection("integrations")} />
            <NavButton icon={<LayoutList />} label="Clientes" active={active === "clients"} onClick={() => goToSection("clients")} />
            <NavButton icon={<Users />} label="Usuários" active={active === "users"} onClick={() => goToSection("users")} />
            <NavButton icon={<FileText />} label="Relatórios" active={active === "reports"} onClick={() => goToSection("reports")} />
            <NavButton icon={<Activity />} label="CAPI" active={active === "capi"} onClick={() => goToSection("capi")} />
            <NavButton icon={<Settings />} label="Config" active={active === "settings"} onClick={() => goToSection("settings")} />
          </nav>
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

        {active === "dashboard" && !needsOperationalOnboarding && (
          <section className="page-grid">
            <div className="kpi-grid">
              <Kpi label="Cliques" value={metrics.clicks.toLocaleString("pt-BR")} />
              <Kpi label="Aguardando" value={metrics.waiting.toString()} />
              <Kpi label="Vendas" value={metrics.sales.toString()} />
              <Kpi label="Receita" value={formatMoney(metrics.revenue)} />
              <Kpi label="Conversão" value={`${metrics.conversion.toFixed(1)}%`} />
            </div>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Prontidão operacional</h2>
                  <p>Checklist real para saber se a empresa está pronta para vender, medir e otimizar.</p>
                </div>
                <ShieldCheck size={18} />
              </div>
              <ReadinessChecklist items={operationalChecklist} onGo={goToSection} compact />
            </section>

            <section className="panel wide">
              <div className="panel-head">
                <div>
                  <h2>Criar Smart Link</h2>
                  <p>Link direto para WhatsApp com rastreamento server-side.</p>
                </div>
                <Plus size={18} />
              </div>
              <SmartLinkForm draft={draft} setDraft={setDraft} onSubmit={createSmartLink} loading={loading} />
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

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>WhatsApp Leads</h2>
                  <p>Fila operacional sem mexer no WhatsApp.</p>
                </div>
                <MessageCircle size={18} />
              </div>
              <LeadList leads={tenantLeads.slice(0, 5)} compact />
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
        )}

        {active === "links" && (
          <section className="stack">
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
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Convidar stakeholder</h2>
                  <p>Adicione donos, gestores, atendentes e visualizadores vinculados apenas à empresa atual.</p>
                </div>
                <UserPlus size={18} />
              </div>
              <div className="user-form">
                <input placeholder="email@empresa.com" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} />
                <select value={inviteDraft.role} onChange={(event) => setInviteDraft({ ...inviteDraft, role: event.target.value as InviteDraft["role"] })}>
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="operator">CRM / Atendimento</option>
                  <option value="viewer">Visualizador</option>
                </select>
                <button className="primary-button" onClick={inviteUser}>Enviar convite</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Stakeholders cadastrados</h2>
                  <p>Acessos liberados para verificar dados e operar o CRM desta empresa.</p>
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
                <ReadOnly label="CRM / Atendimento" value="Acompanha leads e atualiza pipeline" />
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

      {mobileMenuOpen && (
        <section className="mobile-more-sheet" aria-label="Mais opções">
          <button type="button" onClick={() => goToSection("leads")} className={active === "leads" ? "active" : ""}><MessageCircle size={17} /> Atendimentos</button>
          <button type="button" onClick={() => goToSection("clients")} className={active === "clients" ? "active" : ""}><LayoutList size={17} /> Clientes</button>
          <button type="button" onClick={() => goToSection("users")} className={active === "users" ? "active" : ""}><Users size={17} /> Usuários</button>
          <button type="button" onClick={() => goToSection("reports")} className={active === "reports" ? "active" : ""}><FileText size={17} /> Relatórios</button>
          <button type="button" onClick={() => goToSection("capi")} className={active === "capi" ? "active" : ""}><Activity size={17} /> CAPI</button>
          <button type="button" onClick={() => goToSection("settings")} className={active === "settings" ? "active" : ""}><Settings size={17} /> Config</button>
          <button type="button" onClick={logout}><LogOut size={17} /> Sair</button>
        </section>
      )}

      <nav className="mobile-tabbar" aria-label="Navegação principal">
        <NavButton icon={<Gauge />} label="Início" active={active === "dashboard"} onClick={() => goToSection("dashboard")} />
        <NavButton icon={<Link2 />} label="Links" active={active === "links"} onClick={() => goToSection("links")} />
        <NavButton icon={<LayoutList />} label="CRM" active={active === "crm"} onClick={() => goToSection("crm")} />
        <NavButton icon={<ShieldCheck />} label="Meta" active={active === "integrations"} onClick={() => goToSection("integrations")} />
        <NavButton icon={<MoreHorizontal />} label="Mais" active={moreActive || mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)} />
      </nav>

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

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
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
}: {
  draft: DraftLink;
  setDraft: (draft: DraftLink) => void;
  onSubmit: () => void;
  loading: boolean;
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
        Campanha
        <input value={draft.campaign} onChange={(event) => set("campaign", event.target.value)} placeholder="utm_campaign do anúncio" />
      </label>
      <label>
        Fonte
        <input value={draft.source} onChange={(event) => set("source", event.target.value)} placeholder="meta" />
      </label>
      <label>
        Mídia
        <input value={draft.medium} onChange={(event) => set("medium", event.target.value)} placeholder="paid" />
      </label>
      <label>
        Conteúdo
        <input value={draft.content} onChange={(event) => set("content", event.target.value)} placeholder="criativo ou anúncio" />
      </label>
      <label>
        Termo
        <input value={draft.term} onChange={(event) => set("term", event.target.value)} placeholder="palavra ou público" />
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

const crmColumns: { status: LeadStatus; title: string }[] = [
  { status: "new", title: "Novo" },
  { status: "contacted", title: "Contato" },
  { status: "qualified", title: "Qualificado / Remarketing" },
  { status: "bad", title: "Ruim" },
  { status: "sold", title: "Vendido" },
  { status: "lost", title: "Perdido" },
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
            <div className="crm-column-head">
              <strong>{column.title}</strong>
              <span>{columnLeads.length}</span>
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
        <article className="user-row" key={user.id}>
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
    operator: "CRM / Atendimento",
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
    links: "Smart Links",
    leads: "Atendimentos",
    crm: "CRM",
    integrations: "Integrações",
    clients: "Clientes",
    users: "Usuários",
    reports: "Relatórios",
    capi: "CAPI Health",
    settings: "Configuração",
  }[section];
}
