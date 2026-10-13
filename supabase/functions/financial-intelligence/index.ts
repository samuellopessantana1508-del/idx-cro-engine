import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canReadTenantOrPlatform } from "../_shared/access.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function csvResponse(rows: Record<string, unknown>[], filename: string): Response {
  if (!rows.length) return new Response("", { status: 200, headers: { ...cors, "Content-Type": "text/csv" } });
  const keys = Object.keys(rows[0]);
  const header = keys.join(",");
  const body = rows.map((r) => keys.map((k) => {
    const v = r[k];
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  return new Response(`${header}\n${body}`, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

interface Filters {
  tenant_id: string;
  since?: string;
  until?: string;
  campaign_id?: string;
  utm_source?: string;
  seller_email?: string;
}

function dateFilter(query: any, field: string, since?: string, until?: string) {
  if (since) query = query.gte(field, since);
  if (until) query = query.lte(field, until);
  return query;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "missing_tenant_id" }, 400);
  if (!(await canReadTenantOrPlatform(supa, tenantId, user.id, user.email))) {
    return json({ error: "forbidden" }, 403);
  }

  const filters: Filters = {
    tenant_id: tenantId,
    since: body.since ?? undefined,
    until: body.until ?? undefined,
    campaign_id: body.campaign_id ?? undefined,
    utm_source: body.utm_source ?? undefined,
    seller_email: body.seller_email ?? undefined,
  };

  if (action === "dashboard") return handleDashboard(filters);
  if (action === "customers") return handleCustomers(filters);
  if (action === "campaign_detail") return handleCampaignDetail(filters);
  if (action === "ai_patterns") return handleAiPatterns(filters);
  if (action === "export_csv") return handleExportCsv(filters, String(body.report ?? ""));
  return json({ error: "unknown_action" }, 400);
});

async function handleDashboard(f: Filters) {
  const [monthly, spend, customers, campaigns, totalSessions] = await Promise.all([
    loadMonthlyFinancial(f),
    loadMonthlySpend(f),
    loadCustomerPurchases(f),
    loadCampaignRoi(f),
    loadTotalSessions(f),
  ]);

  const totalRevenue = customers.reduce((s, c) => s + Number(c.total_revenue ?? 0), 0);
  const totalSales = customers.reduce((s, c) => s + Number(c.purchase_count ?? 0), 0);
  const uniqueBuyers = customers.length;
  const totalSpend = spend.reduce((s, m) => s + Number(m.total_spend ?? 0), 0);
  const totalLeads = monthly.reduce((s, m) => s + Number(m.total_leads ?? 0), 0);
  const totalQualified = monthly.reduce((s, m) => s + Number(m.qualified ?? 0), 0);

  const repeatBuyers = customers.filter((c) => Number(c.purchase_count) > 1);
  const avgTicket = totalSales > 0 ? totalRevenue / totalSales : 0;

  const newCustomers = customers.filter((c) => {
    if (!c.first_purchase_at) return false;
    if (Number(c.purchase_count) < 1) return false;
    if (f.since && c.first_purchase_at < f.since) return false;
    if (f.until && c.first_purchase_at > f.until) return false;
    return true;
  });
  const newCustomerCount = newCustomers.length;

  const ltvRealized = uniqueBuyers > 0 ? totalRevenue / uniqueBuyers : 0;
  const cac = newCustomerCount > 0 && totalSpend > 0 ? totalSpend / newCustomerCount : null;
  const roas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const cpl = totalLeads > 0 && totalSpend > 0 ? totalSpend / totalLeads : null;
  const cpa = totalSales > 0 && totalSpend > 0 ? totalSpend / totalSales : null;
  const conversionRate = totalLeads > 0 ? (totalSales / totalLeads) * 100 : 0;
  const qualificationRate = totalLeads > 0 ? (totalQualified / totalLeads) * 100 : 0;
  const repurchaseRate = uniqueBuyers > 0 ? (repeatBuyers.length / uniqueBuyers) * 100 : 0;

  const monthlyChart = buildMonthlyChart(monthly, spend);

  const campaignMetrics = campaigns.map((c: any) => ({
    campaign_id: c.campaign_id,
    campaign_name: c.campaign_name,
    spend: Number(c.spend ?? 0),
    leads: Number(c.idx_leads ?? 0),
    qualified: Number(c.idx_qualified ?? 0),
    sales: Number(c.idx_sales ?? 0),
    revenue: Number(c.idx_revenue ?? 0),
    cpl: c.cpl != null ? Number(c.cpl) : null,
    cpa: Number(c.idx_sales ?? 0) > 0 && Number(c.spend ?? 0) > 0
      ? Math.round((Number(c.spend) / Number(c.idx_sales)) * 100) / 100
      : null,
    roas: c.roas != null ? Number(c.roas) : null,
    conversion_rate: Number(c.idx_leads ?? 0) > 0
      ? Math.round((Number(c.idx_sales) / Number(c.idx_leads)) * 1000) / 10
      : 0,
  }));

  return json({
    ok: true,
    summary: {
      total_revenue: round2(totalRevenue),
      total_spend: round2(totalSpend),
      total_leads: totalLeads,
      total_qualified: totalQualified,
      total_sales: totalSales,
      unique_buyers: uniqueBuyers,
      new_customers: newCustomerCount,
      repeat_buyers: repeatBuyers.length,
      avg_ticket: round2(avgTicket),
      ltv_realized: round2(ltvRealized),
      cac: cac != null ? round2(cac) : null,
      roas: roas != null ? round2(roas) : null,
      cpl: cpl != null ? round2(cpl) : null,
      cpa: cpa != null ? round2(cpa) : null,
      conversion_rate: round1(conversionRate),
      qualification_rate: round1(qualificationRate),
      repurchase_rate: round1(repurchaseRate),
    },
    monthly_chart: monthlyChart,
    campaigns: campaignMetrics,
  });
}

async function handleCustomers(f: Filters) {
  let query = supa
    .from("vw_customer_purchases")
    .select("*")
    .eq("tenant_id", f.tenant_id)
    .order("total_revenue", { ascending: false })
    .limit(200);

  const { data } = await query;
  const customers = (data ?? []).map((c: any) => ({
    customer_key: c.customer_key,
    customer_name: c.customer_name,
    customer_phone: c.customer_phone,
    customer_email: c.customer_email,
    purchase_count: Number(c.purchase_count),
    total_revenue: round2(Number(c.total_revenue ?? 0)),
    avg_ticket: round2(Number(c.avg_ticket ?? 0)),
    first_purchase_at: c.first_purchase_at,
    last_purchase_at: c.last_purchase_at,
    products: c.products ?? [],
    categories: c.categories ?? [],
    sources: c.sources ?? [],
    campaigns: c.campaigns ?? [],
    is_repeat: Number(c.purchase_count) > 1,
  }));

  return json({ ok: true, customers });
}

async function handleCampaignDetail(f: Filters) {
  if (!f.campaign_id) return json({ error: "missing_campaign_id" }, 400);

  let query = supa
    .from("tracking_sessions")
    .select("id, ref, lead_status, clicked_at, sold_at, revenue, customer_phone, customer_name, utm_source, utm_medium, utm_campaign, utm_content")
    .eq("tenant_id", f.tenant_id)
    .or(`utm_campaign.ilike.${f.campaign_id}`)
    .order("clicked_at", { ascending: false })
    .limit(500);

  query = dateFilter(query, "clicked_at", f.since, f.until);

  const { data } = await query;
  return json({ ok: true, sessions: data ?? [] });
}

async function handleAiPatterns(f: Filters) {
  let insightsQuery = supa
    .from("conversation_insights")
    .select("products_of_interest, objections, intent, sentiment, purchase_probability")
    .eq("tenant_id", f.tenant_id)
    .order("updated_at", { ascending: false })
    .limit(500);

  let signalsQuery = supa
    .from("sale_signals")
    .select("product_name, product_category, signal_type, confidence, estimated_value, status, capi_status")
    .eq("tenant_id", f.tenant_id)
    .order("created_at", { ascending: false })
    .limit(500);

  const [insightsRes, signalsRes] = await Promise.all([insightsQuery, signalsQuery]);
  const insights = insightsRes.data ?? [];
  const signals = signalsRes.data ?? [];

  const productFreq: Record<string, number> = {};
  const objectionFreq: Record<string, number> = {};
  const intentFreq: Record<string, number> = {};
  let sentimentPos = 0, sentimentNeu = 0, sentimentNeg = 0;

  for (const i of insights) {
    if (i.products_of_interest) {
      for (const p of i.products_of_interest) {
        productFreq[p] = (productFreq[p] ?? 0) + 1;
      }
    }
    if (i.objections) {
      for (const o of i.objections) {
        objectionFreq[o] = (objectionFreq[o] ?? 0) + 1;
      }
    }
    if (i.intent) intentFreq[i.intent] = (intentFreq[i.intent] ?? 0) + 1;
    if (i.sentiment === "positive") sentimentPos++;
    else if (i.sentiment === "negative") sentimentNeg++;
    else sentimentNeu++;
  }

  const signalsByType: Record<string, number> = {};
  const signalsByStatus: Record<string, number> = {};
  let totalSignalValue = 0;
  let signalValueCount = 0;

  for (const s of signals) {
    signalsByType[s.signal_type] = (signalsByType[s.signal_type] ?? 0) + 1;
    signalsByStatus[s.status] = (signalsByStatus[s.status] ?? 0) + 1;
    if (s.estimated_value && s.estimated_value > 0) {
      totalSignalValue += s.estimated_value;
      signalValueCount++;
    }
  }

  const topProducts = Object.entries(productFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  const topObjections = Object.entries(objectionFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([text, count]) => ({ text, count }));
  const topIntents = Object.entries(intentFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([intent, count]) => ({ intent, count }));

  return json({
    ok: true,
    patterns: {
      top_products: topProducts,
      top_objections: topObjections,
      top_intents: topIntents,
      sentiment: { positive: sentimentPos, neutral: sentimentNeu, negative: sentimentNeg },
      signals_by_type: signalsByType,
      signals_by_status: signalsByStatus,
      avg_signal_value: signalValueCount > 0 ? round2(totalSignalValue / signalValueCount) : null,
      total_conversations_analyzed: insights.length,
      total_signals: signals.length,
    },
  });
}

async function handleExportCsv(f: Filters, report: string) {
  if (report === "campaigns") {
    const campaigns = await loadCampaignRoi(f);
    const rows = campaigns.map((c: any) => ({
      campanha: c.campaign_name,
      campanha_id: c.campaign_id,
      investimento: Number(c.spend ?? 0),
      leads: Number(c.idx_leads ?? 0),
      qualificados: Number(c.idx_qualified ?? 0),
      vendas: Number(c.idx_sales ?? 0),
      receita: Number(c.idx_revenue ?? 0),
      cpl: c.cpl ?? "",
      roas: c.roas ?? "",
      quality_rate: c.quality_rate ?? "",
    }));
    return csvResponse(rows, "campanhas.csv");
  }

  if (report === "customers") {
    const { data } = await supa
      .from("vw_customer_purchases")
      .select("*")
      .eq("tenant_id", f.tenant_id)
      .order("total_revenue", { ascending: false })
      .limit(1000);
    const rows = (data ?? []).map((c: any) => ({
      cliente: c.customer_name ?? "",
      telefone: c.customer_phone ?? "",
      email: c.customer_email ?? "",
      compras: c.purchase_count,
      receita_total: c.total_revenue,
      ticket_medio: round2(Number(c.avg_ticket ?? 0)),
      primeira_compra: c.first_purchase_at ?? "",
      ultima_compra: c.last_purchase_at ?? "",
      produtos: (c.products ?? []).join("; "),
    }));
    return csvResponse(rows, "clientes.csv");
  }

  if (report === "leads") {
    let query = supa
      .from("tracking_sessions")
      .select("ref, lead_status, clicked_at, sold_at, revenue, customer_phone, customer_name, customer_email, utm_source, utm_medium, utm_campaign, utm_content, utm_term")
      .eq("tenant_id", f.tenant_id)
      .order("clicked_at", { ascending: false })
      .limit(2000);
    query = dateFilter(query, "clicked_at", f.since, f.until);
    if (f.campaign_id) query = query.ilike("utm_campaign", f.campaign_id);
    const { data } = await query;
    const rows = (data ?? []).map((s: any) => ({
      ref: s.ref,
      status: s.lead_status,
      clicou_em: s.clicked_at ?? "",
      vendeu_em: s.sold_at ?? "",
      receita: s.revenue ?? "",
      telefone: s.customer_phone ?? "",
      nome: s.customer_name ?? "",
      email: s.customer_email ?? "",
      utm_source: s.utm_source ?? "",
      utm_medium: s.utm_medium ?? "",
      utm_campaign: s.utm_campaign ?? "",
      utm_content: s.utm_content ?? "",
      utm_term: s.utm_term ?? "",
    }));
    return csvResponse(rows, "leads.csv");
  }

  if (report === "monthly") {
    const [monthly, spend] = await Promise.all([
      loadMonthlyFinancial(f),
      loadMonthlySpend(f),
    ]);
    const chart = buildMonthlyChart(monthly, spend);
    const rows = chart.map((m) => ({
      mes: m.month,
      leads: m.leads,
      qualificados: m.qualified,
      vendas: m.sales,
      receita: m.revenue,
      investimento: m.spend,
      compradores_unicos: m.unique_buyers,
      roas: m.spend > 0 ? round2(m.revenue / m.spend) : "",
      cac: m.unique_buyers > 0 && m.spend > 0 ? round2(m.spend / m.unique_buyers) : "",
    }));
    return csvResponse(rows, "mensal.csv");
  }

  return json({ error: "unknown_report" }, 400);
}

// --- helpers ---

async function loadMonthlyFinancial(f: Filters) {
  let query = supa
    .from("vw_monthly_financial")
    .select("*")
    .eq("tenant_id", f.tenant_id)
    .order("month", { ascending: true })
    .limit(36);
  const { data } = await query;
  return data ?? [];
}

async function loadMonthlySpend(f: Filters) {
  let query = supa
    .from("vw_monthly_spend")
    .select("*")
    .eq("tenant_id", f.tenant_id)
    .order("month", { ascending: true })
    .limit(36);
  const { data } = await query;
  return data ?? [];
}

async function loadCustomerPurchases(f: Filters) {
  let query = supa
    .from("vw_customer_purchases")
    .select("*")
    .eq("tenant_id", f.tenant_id)
    .limit(2000);
  const { data } = await query;
  return data ?? [];
}

async function loadCampaignRoi(f: Filters) {
  let query = supa
    .from("vw_meta_campaign_roi")
    .select("*")
    .eq("tenant_id", f.tenant_id)
    .order("spend", { ascending: false })
    .limit(100);
  const { data } = await query;
  return data ?? [];
}

async function loadTotalSessions(f: Filters) {
  let query = supa
    .from("tracking_sessions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", f.tenant_id);
  query = dateFilter(query, "clicked_at", f.since, f.until);
  const { count } = await query;
  return count ?? 0;
}

interface MonthlyPoint {
  month: string;
  leads: number;
  qualified: number;
  sales: number;
  lost: number;
  revenue: number;
  spend: number;
  unique_buyers: number;
}

function buildMonthlyChart(monthly: any[], spend: any[]): MonthlyPoint[] {
  const spendMap = new Map<string, number>();
  for (const s of spend) spendMap.set(s.month, Number(s.total_spend ?? 0));

  return monthly.map((m) => ({
    month: m.month,
    leads: Number(m.total_leads ?? 0),
    qualified: Number(m.qualified ?? 0),
    sales: Number(m.sales ?? 0),
    lost: Number(m.lost ?? 0),
    revenue: Number(m.revenue ?? 0),
    spend: spendMap.get(m.month) ?? 0,
    unique_buyers: Number(m.unique_buyers ?? 0),
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
