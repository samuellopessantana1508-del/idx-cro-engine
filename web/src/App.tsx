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
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
} from "lucide-react";
import { supabase } from "./lib/supabaseClient";
import { demoCapiEvents, demoCrmActivities, demoHealth, demoLeads, demoLinks, demoMetaCampaigns, demoOffers, demoTenants } from "./lib/demoData";
import type { CapiEvent, CapiHealth, CrmActivity, Lead, LeadStatus, MetaCampaignRoi, Offer, SmartLink, Tenant, TenantUser } from "./lib/types";
import { envConfigured, formatDate, formatMoney, linkCode, slugify, smartLinkUrl, timeAgo } from "./lib/utils";

type Section = "dashboard" | "links" | "leads" | "crm" | "integrations" | "clients" | "users" | "reports" | "capi" | "settings";

type DraftLink = {
  offerName: string;
  category: string;
  price: string;
  linkName: string;
  campaign: string;
  source: string;
  medium: string;
  message: string;
};

type ClientDraft = {
  name: string;
  slug: string;
  whatsapp: string;
};

type InviteDraft = {
  email: string;
  role: "admin" | "operator" | "viewer";
};

type MetaDraft = {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
};

type SupabaseHealthState = {
  database_model?: string;
  database_owner?: string;
  tenant_isolation?: string;
  tenant_scope?: string;
  tables?: Record<string, number>;
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

const emptyDraft: DraftLink = {
  offerName: "",
  category: "",
  price: "",
  linkName: "",
  campaign: "",
  source: "meta",
  medium: "paid",
  message: "Ola! Tenho interesse em {{oferta}}. Ref: {{ref}}",
};

const emptyClientDraft: ClientDraft = {
  name: "",
  slug: "",
  whatsapp: "",
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

export function App() {
  const isConfigured = envConfigured() && Boolean(supabase);
  const [sessionReady, setSessionReady] = useState(!isConfigured);
  const [signedIn, setSignedIn] = useState(!isConfigured);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [tenantSetupRequired, setTenantSetupRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [active, setActive] = useState<Section>("dashboard");
  const [tenants, setTenants] = useState<Tenant[]>(demoTenants);
  const [tenantId, setTenantId] = useState(demoTenants[0].id);
  const [offers, setOffers] = useState<Offer[]>(demoOffers);
  const [links, setLinks] = useState<SmartLink[]>(demoLinks);
  const [leads, setLeads] = useState<Lead[]>(demoLeads);
  const [events, setEvents] = useState<CapiEvent[]>(demoCapiEvents);
  const [crmActivities, setCrmActivities] = useState<CrmActivity[]>(demoCrmActivities);
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([]);
  const [health, setHealth] = useState<CapiHealth>(demoHealth);
  const [metaCampaigns, setMetaCampaigns] = useState<MetaCampaignRoi[]>(demoMetaCampaigns);
  const [draft, setDraft] = useState<DraftLink>(emptyDraft);
  const [toast, setToast] = useState("");
  const [leadSearch, setLeadSearch] = useState("");
  const [saleRef, setSaleRef] = useState("");
  const [salePhone, setSalePhone] = useState("");
  const [saleRevenue, setSaleRevenue] = useState("");
  const [clientDraft, setClientDraft] = useState<ClientDraft>(emptyClientDraft);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(emptyInviteDraft);
  const [metaDraft, setMetaDraft] = useState<MetaDraft>(emptyMetaDraft);
  const [adAccountId, setAdAccountId] = useState("");
  const [crmNotes, setCrmNotes] = useState<Record<string, string>>({});
  const [crmBusyRef, setCrmBusyRef] = useState("");
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [supabaseStatus, setSupabaseStatus] = useState<"unknown" | "ok" | "error">(isConfigured ? "unknown" : "ok");
  const [supabaseHealth, setSupabaseHealth] = useState<SupabaseHealthState>({
    database_model: "single_owned_multi_tenant",
    database_owner: "idx",
    tenant_isolation: "tenant_id + rls + edge_functions",
    tenant_scope: "demo",
  });
  const [loading, setLoading] = useState(false);

  const tenant = tenants.find((item) => item.id === tenantId) ?? tenants[0];
  const tenantLinks = links.filter((item) => item.tenant_id === tenant?.id);
  const tenantLeads = leads.filter((item) => item.tenant_id === tenant?.id);
  const tenantOffers = offers.filter((item) => item.tenant_id === tenant?.id);
  const tenantMetaCampaigns = metaCampaigns.filter((item) => item.tenant_id === tenant?.id);
  const tenantCrmActivities = crmActivities.filter((item) => item.tenant_id === tenant?.id);
  const remarketingLeads = tenantLeads.filter((lead) => lead.lead_status === "qualified");
  const qualityRows = useMemo(() => buildQualityRows(tenantLeads, tenantMetaCampaigns), [tenantLeads, tenantMetaCampaigns]);

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

  useEffect(() => {
    if (!isConfigured || !supabase) return;

    async function boot() {
      const { data } = await supabase!.auth.getSession();
      setSignedIn(Boolean(data.session));
      setSessionReady(true);
      if (data.session) await loadInitialData();
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

  async function login() {
    if (!supabase) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setToast(error.message);
      return;
    }
    setSignedIn(true);
    await loadInitialData();
  }

  async function signup() {
    if (!supabase) return;
    if (!email.trim() || password.length < 6) {
      setToast("Informe email e senha com pelo menos 6 caracteres.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    });
    setLoading(false);

    if (error) {
      setToast(error.message);
      return;
    }

    if (data.session) {
      setSignedIn(true);
      await loadInitialData();
      return;
    }

    setAuthMode("login");
    setToast("Conta criada. Confirme o email e entre no painel.");
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    setSignedIn(false);
    setTenantSetupRequired(false);
  }

  async function authFetch(path: string, options: RequestInit = {}) {
    if (!supabase) throw new Error("Supabase nao configurado");
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
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setLoading(false);
      return;
    }

    const { data: tenantRows, error: tenantError } = await supabase
      .from("tenant_users")
      .select("tenant:tenants(*)")
      .eq("user_id", user.id)
      .eq("status", "active");

    if (tenantError) {
      setToast(tenantError.message);
      setLoading(false);
      return;
    }

    const loadedTenants = (tenantRows ?? [])
      .map((row: any) => row.tenant)
      .filter(Boolean) as Tenant[];

    if (!loadedTenants.length) {
      setTenants([]);
      setTenantId("");
      setTenantSetupRequired(true);
      setActive("clients");
      setToast("Crie a primeira empresa para iniciar o painel.");
      setLoading(false);
      return;
    }

    setTenantSetupRequired(false);
    setTenants(loadedTenants);
    const currentTenant = loadedTenants[0];
    setTenantId(currentTenant.id);
    await loadTenantData(currentTenant.id);
    setLoading(false);
  }

  async function loadTenantData(nextTenantId = tenantId) {
    if (!supabase || !nextTenantId) return;
    const [offerRes, linkRes, leadRes, eventRes, activityRes, userRes, healthRes, metaRoiRes] = await Promise.all([
      supabase.from("offers").select("*").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }),
      supabase.from("vw_smart_link_performance").select("*").eq("tenant_id", nextTenantId),
      supabase.from("vw_lead_queue").select("*").eq("tenant_id", nextTenantId).order("clicked_at", { ascending: false }).limit(100),
      supabase.from("capi_events").select("event_name, ok, status_code, error_message, created_at").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }).limit(40),
      supabase.from("crm_activities").select("*").eq("tenant_id", nextTenantId).order("created_at", { ascending: false }).limit(80),
      supabase.from("tenant_users").select("id, tenant_id, email, role, status, created_at").eq("tenant_id", nextTenantId).order("created_at", { ascending: true }),
      supabase.from("vw_capi_health").select("*").eq("tenant_id", nextTenantId).maybeSingle(),
      supabase.from("vw_meta_campaign_roi").select("*").eq("tenant_id", nextTenantId).order("spend", { ascending: false }).limit(100),
    ]);

    if (offerRes.data) setOffers(offerRes.data as Offer[]);
    if (linkRes.data) setLinks(linkRes.data as SmartLink[]);
    if (leadRes.data) setLeads(leadRes.data as Lead[]);
    if (eventRes.data) setEvents(eventRes.data as CapiEvent[]);
    if (activityRes.data) setCrmActivities(activityRes.data as CrmActivity[]);
    if (userRes.data) setTenantUsers(userRes.data as TenantUser[]);
    if (healthRes.data) setHealth(healthRes.data as CapiHealth);
    if (metaRoiRes.data) setMetaCampaigns(metaRoiRes.data as MetaCampaignRoi[]);
  }

  async function createSmartLink() {
    if (!tenant || !draft.offerName.trim()) {
      setToast("Informe a oferta.");
      return;
    }

    const offerSlug = slugify(draft.offerName);
    const code = linkCode(`${tenant.slug}-${offerSlug}-${draft.campaign || "direct"}`);
    const price = draft.price ? Number(draft.price.replace(",", ".")) : null;
    const linkName = draft.linkName || `${draft.offerName} - ${draft.campaign || "Direto"}`;

    if (!isConfigured || !supabase) {
      const offer: Offer = {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        name: draft.offerName,
        slug: offerSlug,
        category: draft.category || null,
        price,
        default_message: draft.message,
        status: "active",
      };
      const link: SmartLink = {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        offer_id: offer.id,
        code,
        name: linkName,
        message_template: draft.message,
        default_utm_source: draft.source,
        default_utm_medium: draft.medium,
        default_utm_campaign: draft.campaign,
        status: "active",
        offer_name: offer.name,
        category: offer.category,
        clicks: 0,
        sales: 0,
        revenue: 0,
        conversion_rate: 0,
      };
      setOffers((items) => [offer, ...items]);
      setLinks((items) => [link, ...items]);
      setDraft(emptyDraft);
      setToast("Smart Link criado em modo demo.");
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
      default_utm_source: draft.source,
      default_utm_medium: draft.medium,
      default_utm_campaign: draft.campaign,
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

  async function copyLink(code: string) {
    await navigator.clipboard.writeText(smartLinkUrl(code));
    setToast("Link copiado.");
  }

  async function confirmSale() {
    const ref = saleRef.trim().toLowerCase();
    const revenue = Number(saleRevenue.replace(",", "."));
    if (!ref || !salePhone || !revenue) {
      setToast("Informe ref, telefone e valor.");
      return;
    }

    if (!isConfigured || !supabase) {
      setLeads((items) =>
        items.map((lead) =>
          lead.ref === ref
            ? {
                ...lead,
                lead_status: "sold",
                customer_phone: salePhone,
                revenue,
                sold_at: new Date().toISOString(),
              }
            : lead,
        ),
      );
      setToast("Venda confirmada em modo demo.");
      setSaleRef("");
      setSalePhone("");
      setSaleRevenue("");
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
        ref,
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
    setSalePhone("");
    setSaleRevenue("");
    await loadTenantData();
  }

  async function updateCrmStage(lead: Lead, status: LeadStatus) {
    const note = (crmNotes[lead.id] ?? "").trim();
    const eventName = stageEventName(status);

    if (!isConfigured || !supabase) {
      const now = new Date().toISOString();
      const nextTags = mergeLocalTags(lead.tags, status);
      setLeads((items) =>
        items.map((item) =>
          item.id === lead.id
            ? {
                ...item,
                lead_status: status,
                tags: nextTags,
                lead_score: localLeadScore(status),
                qualified_at: status === "qualified" ? item.qualified_at ?? now : item.qualified_at,
                bad_at: status === "bad" ? item.bad_at ?? now : item.bad_at,
                lost_at: status === "lost" ? item.lost_at ?? now : item.lost_at,
                last_crm_activity_at: now,
              }
            : item,
        ),
      );
      setCrmActivities((items) => [
        {
          id: crypto.randomUUID(),
          tenant_id: lead.tenant_id,
          tracking_session_id: lead.id,
          activity_type: "stage_change",
          body: note || null,
          from_status: lead.lead_status,
          to_status: status,
          metadata: { tags: nextTags },
          created_at: now,
        },
        ...items,
      ]);
      if (eventName) {
        setEvents((items) => [
          { event_name: eventName, ok: true, status_code: 200, created_at: now },
          ...items,
        ]);
      }
      setCrmNotes((items) => ({ ...items, [lead.id]: "" }));
      setToast(status === "qualified" ? "Lead qualificado e enviado para remarketing." : `Lead movido para ${statusLabel(status)}.`);
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
      }),
    });
    const data = await res.json();
    setCrmBusyRef("");
    if (!res.ok) return setToast(data.error || "Erro ao atualizar CRM.");
    setCrmNotes((items) => ({ ...items, [lead.id]: "" }));
    setToast(data.capi_ok === false ? "CRM atualizado. CAPI sem credencial ou com erro." : "CRM atualizado e sinal enviado ao Meta.");
    await loadTenantData();
  }

  async function createClient() {
    if (!clientDraft.name.trim() || !clientDraft.whatsapp.trim()) {
      setToast("Informe nome e WhatsApp.");
      return;
    }

    if (!isConfigured || !supabase) {
      const nextTenant: Tenant = {
        id: crypto.randomUUID(),
        slug: slugify(clientDraft.slug || clientDraft.name),
        name: clientDraft.name,
        whatsapp_number: clientDraft.whatsapp.replace(/\D/g, ""),
        status: "active",
        default_message_template: "Ola! Tenho interesse em {{oferta}}. Ref: {{ref}}",
      };
      setTenants((items) => [nextTenant, ...items]);
      setTenantId(nextTenant.id);
      setClientDraft(emptyClientDraft);
      setToast("Cliente criado em modo demo.");
      return;
    }

    const res = await authFetch("tenant-admin", {
      method: "POST",
      body: JSON.stringify({
        action: "create_tenant",
        name: clientDraft.name,
        slug: clientDraft.slug,
        whatsapp_number: clientDraft.whatsapp,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setToast(data.error || "Erro ao criar cliente.");
    setTenants((items) => [data.tenant, ...items]);
    setTenantId(data.tenant.id);
    setTenantSetupRequired(false);
    setClientDraft(emptyClientDraft);
    setToast("Cliente criado.");
    await loadTenantData(data.tenant.id);
  }

  async function inviteUser() {
    if (!tenant || !inviteDraft.email.trim()) {
      setToast("Informe o email do usuário.");
      return;
    }

    if (!isConfigured || !supabase) {
      setInviteDraft(emptyInviteDraft);
      setToast("Convite simulado em modo demo.");
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
    setToast("Convite enviado.");
    await loadTenantData();
  }

  async function startMetaLogin() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Demo: em produção abriria o login do Facebook.");
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
    if (!res.ok) return setToast(data.error || "Erro ao iniciar Facebook Login.");
    window.location.href = data.auth_url;
  }

  async function saveMetaManual() {
    if (!tenant || !metaDraft.pixelId.trim() || !metaDraft.accessToken.trim()) {
      setToast("Informe Pixel ID e token CAPI.");
      return;
    }

    if (!isConfigured || !supabase) {
      setMetaDraft(emptyMetaDraft);
      setToast("Integração Meta salva em modo demo.");
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
  }

  async function testCapi() {
    if (!tenant) return;
    if (!isConfigured || !supabase) {
      setToast("Teste CAPI simulado: OK.");
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
      setToast("Gastos Meta sincronizados em modo demo.");
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

  async function checkSupabaseHealth() {
    if (!isConfigured || !supabase) {
      setSupabaseStatus("ok");
      setSupabaseHealth({
        database_model: "single_owned_multi_tenant",
        database_owner: "idx",
        tenant_isolation: "tenant_id + rls + edge_functions",
        tenant_scope: "demo",
      });
      setToast("Demo: Supabase pronto.");
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

  if (!signedIn) {
    return (
      <main className="login-screen">
        <section className="login-panel">
          <div className="brand-mark">IDX.</div>
          <h1>{authMode === "login" ? "CRO Engine" : "Criar acesso"}</h1>
          <p>{authMode === "login" ? "Entre para gerenciar Smart Links, WhatsApp Leads e CAPI." : "Crie seu acesso inicial e configure a primeira empresa."}</p>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
          </label>
          <label>
            Senha
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} />
          </label>
          <div className="auth-actions">
            <button className="primary-button" onClick={authMode === "login" ? login : signup} disabled={loading}>
              {authMode === "login" ? "Entrar" : "Criar conta"}
            </button>
            <button className="login-link-button" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")} disabled={loading}>
              {authMode === "login" ? "Criar primeiro acesso" : "Voltar para login"}
            </button>
          </div>
        </section>
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  if (isConfigured && (tenantSetupRequired || !tenant)) {
    return (
      <main className="login-screen">
        <section className="login-panel setup-panel">
          <div className="brand-mark">IDX.</div>
          <h1>Primeira empresa</h1>
          <p>Cadastre a empresa que vai usar o tracker. Voce vira o dono da plataforma neste primeiro setup.</p>
          <div className="setup-form">
            <label>
              Nome da empresa
              <input placeholder="Autoescola Vivo Rio Verde" value={clientDraft.name} onChange={(event) => setClientDraft({ ...clientDraft, name: event.target.value, slug: slugify(event.target.value) })} />
            </label>
            <label>
              Slug
              <input placeholder="autoescola-vivo" value={clientDraft.slug} onChange={(event) => setClientDraft({ ...clientDraft, slug: slugify(event.target.value) })} />
            </label>
            <label>
              WhatsApp com DDI e DDD
              <input placeholder="5564999999999" value={clientDraft.whatsapp} onChange={(event) => setClientDraft({ ...clientDraft, whatsapp: event.target.value })} />
            </label>
            <button className="primary-button" onClick={createClient} disabled={loading}>
              Criar primeira empresa
            </button>
            <button className="login-link-button" onClick={logout} disabled={loading}>
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
            <NavButton icon={<Gauge />} label="Dashboard" active={active === "dashboard"} onClick={() => setActive("dashboard")} />
            <NavButton icon={<Link2 />} label="Links" active={active === "links"} onClick={() => setActive("links")} />
            <NavButton icon={<MessageCircle />} label="Atendimentos" active={active === "leads"} onClick={() => setActive("leads")} />
            <NavButton icon={<LayoutList />} label="CRM" active={active === "crm"} onClick={() => setActive("crm")} />
            <NavButton icon={<ShieldCheck />} label="Integrações" active={active === "integrations"} onClick={() => setActive("integrations")} />
            <NavButton icon={<LayoutList />} label="Clientes" active={active === "clients"} onClick={() => setActive("clients")} />
            <NavButton icon={<Users />} label="Usuários" active={active === "users"} onClick={() => setActive("users")} />
            <NavButton icon={<FileText />} label="Relatórios" active={active === "reports"} onClick={() => setActive("reports")} />
            <NavButton icon={<Activity />} label="CAPI" active={active === "capi"} onClick={() => setActive("capi")} />
            <NavButton icon={<Settings />} label="Config" active={active === "settings"} onClick={() => setActive("settings")} />
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
            <p className="eyeline">{isConfigured ? "Produção" : "Modo demo"}</p>
            <h1>{sectionTitle(active)}</h1>
          </div>
          <div className="tenant-chip">
            <CircleDot size={14} />
            {tenant?.name}
          </div>
        </header>

        {active === "dashboard" && (
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
                  <h2>UsuÃ¡rios desta empresa</h2>
                  <p>Cada login fica vinculado apenas Ã  empresa selecionada.</p>
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
                  <p>O atendente usa o ref que veio na mensagem do WhatsApp.</p>
                </div>
                <Check size={18} />
              </div>
              <div className="sale-form">
                <input placeholder="Ref: a7k9-p2m4" value={saleRef} onChange={(event) => setSaleRef(event.target.value)} />
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
              <CrmPipeline
                leads={tenantLeads}
                notes={crmNotes}
                busyRef={crmBusyRef}
                onNoteChange={(leadId, value) => setCrmNotes((items) => ({ ...items, [leadId]: value }))}
                onStageChange={updateCrmStage}
              />
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
                  <button className="ghost-dark-button" onClick={startMetaLogin} disabled={integrationBusy}>
                    Conectar Facebook <ArrowRight size={16} />
                  </button>
                </article>
              </div>
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
                <ReadOnly label="Modo" value={isConfigured ? "Produção" : "Demo local"} />
                <ReadOnly label="Banco" value={supabaseHealth.database_model === "single_owned_multi_tenant" ? "Único IDX / multiempresa" : "IDX multiempresa"} />
                <ReadOnly label="Isolamento" value={supabaseHealth.tenant_isolation ?? "tenant_id + RLS"} />
                <ReadOnly label="Escopo" value={supabaseHealth.tenant_scope === "platform" ? "Gestor IDX" : supabaseHealth.tenant_scope === "member" ? "Empresa atual" : "Demo"} />
                <ReadOnly label="Projeto" value={String(import.meta.env.VITE_SUPABASE_URL || "demo")} />
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
                  <h2>Novo cliente local</h2>
                  <p>Crie pet shop, autoescola, clínica ou qualquer negócio em menos de um minuto.</p>
                </div>
                <Plus size={18} />
              </div>
              <div className="client-form">
                <input placeholder="Nome da empresa" value={clientDraft.name} onChange={(event) => setClientDraft({ ...clientDraft, name: event.target.value, slug: slugify(event.target.value) })} />
                <input placeholder="Slug" value={clientDraft.slug} onChange={(event) => setClientDraft({ ...clientDraft, slug: slugify(event.target.value) })} />
                <input placeholder="WhatsApp com DDI e DDD" value={clientDraft.whatsapp} onChange={(event) => setClientDraft({ ...clientDraft, whatsapp: event.target.value })} />
                <button className="primary-button" onClick={createClient}>Criar cliente</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Clientes</h2>
                  <p>Empresas conectadas à sua operação de CRO local.</p>
                </div>
              </div>
              <div className="client-grid">
                {tenants.map((item) => (
                  <button className={`client-card ${item.id === tenant?.id ? "selected" : ""}`} key={item.id} onClick={() => setTenantId(item.id)}>
                    <strong>{item.name}</strong>
                    <span>{item.slug}</span>
                    <small>{item.whatsapp_number}</small>
                  </button>
                ))}
              </div>
            </section>
          </section>
        )}

        {active === "users" && (
          <section className="stack">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Convidar usuário</h2>
                  <p>Adicione atendentes, gestores e visualizadores sem mexer no banco.</p>
                </div>
                <UserPlus size={18} />
              </div>
              <div className="user-form">
                <input placeholder="email@empresa.com" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} />
                <select value={inviteDraft.role} onChange={(event) => setInviteDraft({ ...inviteDraft, role: event.target.value as InviteDraft["role"] })}>
                  <option value="admin">Admin</option>
                  <option value="operator">Atendente</option>
                  <option value="viewer">Visualizador</option>
                </select>
                <button className="primary-button" onClick={inviteUser}>Enviar convite</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Permissões</h2>
                  <p>Modelo simples para negócios locais.</p>
                </div>
              </div>
              <div className="permission-grid">
                <ReadOnly label="Owner" value="Tudo, incluindo Meta e usuários" />
                <ReadOnly label="Admin" value="Links, integrações e relatórios" />
                <ReadOnly label="Atendente" value="Confirmar venda e perda" />
                <ReadOnly label="Visualizador" value="Apenas relatórios" />
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
                <ReadOnly label="Empresa" value={tenant?.name} />
                <ReadOnly label="Slug" value={tenant?.slug} />
                <ReadOnly label="WhatsApp" value={tenant?.whatsapp_number} />
                <ReadOnly label="Ofertas" value={String(tenantOffers.length)} />
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
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
        <input value={draft.offerName} onChange={(event) => set("offerName", event.target.value)} placeholder="CNH Categoria B, Banho e Tosa, Consulta..." />
      </label>
      <label>
        Categoria
        <input value={draft.category} onChange={(event) => set("category", event.target.value)} placeholder="Autoescola, pet shop, estética" />
      </label>
      <label>
        Preço
        <input value={draft.price} onChange={(event) => set("price", event.target.value)} placeholder="2290" inputMode="decimal" />
      </label>
      <label>
        Nome do link
        <input value={draft.linkName} onChange={(event) => set("linkName", event.target.value)} placeholder="Instagram Stories - Julho" />
      </label>
      <label>
        Campanha
        <input value={draft.campaign} onChange={(event) => set("campaign", event.target.value)} placeholder="cnh-b-julho" />
      </label>
      <label>
        Fonte
        <input value={draft.source} onChange={(event) => set("source", event.target.value)} />
      </label>
      <label>
        Mídia
        <input value={draft.medium} onChange={(event) => set("medium", event.target.value)} />
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

function LinksTable({ links, onCopy }: { links: SmartLink[]; onCopy: (code: string) => void }) {
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
                <small>{smartLinkUrl(link.code)}</small>
              </td>
              <td>{link.offer_name ?? "-"}</td>
              <td>{link.clicks ?? 0}</td>
              <td>{link.sales ?? 0}</td>
              <td>{formatMoney(link.revenue)}</td>
              <td>{Number(link.conversion_rate ?? 0).toFixed(1)}%</td>
              <td>
                <button className="icon-button" onClick={() => onCopy(link.code)} aria-label="Copiar link">
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

function CrmPipeline({
  leads,
  notes,
  busyRef,
  onNoteChange,
  onStageChange,
}: {
  leads: Lead[];
  notes: Record<string, string>;
  busyRef: string;
  onNoteChange: (leadId: string, value: string) => void;
  onStageChange: (lead: Lead, status: LeadStatus) => void;
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
                columnLeads.map((lead) => (
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
                          Qualificar + remarketing
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
                ))
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
              <small>{lead?.offer_name ?? activity.activity_type}</small>
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

function TenantUsersList({ users }: { users: TenantUser[] }) {
  if (!users.length) return <EmptyState text="Nenhum usuario vinculado ainda." />;
  return (
    <div className="user-list">
      {users.map((user) => (
        <article className="user-row" key={user.id}>
          <div>
            <strong>{user.email || "Usuario sem email"}</strong>
            <small>{user.created_at ? `Criado em ${formatDate(user.created_at)}` : "Acesso vinculado"}</small>
          </div>
          <span>{userRoleLabel(user.role)}</span>
          <StatusPill text={userStatusLabel(user.status)} tone={user.status === "active" ? "good" : "muted"} />
        </article>
      ))}
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

function userRoleLabel(role: TenantUser["role"]): string {
  return {
    owner: "Owner",
    admin: "Admin",
    operator: "Atendente",
    viewer: "Visualizador",
  }[role];
}

function userStatusLabel(status: TenantUser["status"]): string {
  return {
    active: "Ativo",
    invited: "Convidado",
    disabled: "Desativado",
  }[status];
}

function stageEventName(status: LeadStatus): string | null {
  return {
    new: null,
    contacted: "ContactedLead",
    qualified: "QualifiedLead",
    bad: "DisqualifiedLead",
    sold: "Purchase",
    lost: "LeadLost",
  }[status];
}

function localLeadScore(status: LeadStatus): number {
  return {
    new: 0,
    contacted: 20,
    qualified: 80,
    bad: -20,
    sold: 100,
    lost: 0,
  }[status];
}

function mergeLocalTags(tags: string[] | null | undefined, status: LeadStatus): string[] {
  const stageTags = {
    new: [],
    contacted: ["contato"],
    qualified: ["bom lead", "remarketing"],
    bad: ["ruim"],
    sold: ["venda"],
    lost: ["perdido"],
  }[status];
  return Array.from(new Set([...(tags ?? []), ...stageTags])).slice(0, 12);
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
