-- Phase 5: Financial Intelligence — views and indexes for advanced metrics

-- Index for period-based queries on tracking_sessions
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_sold_at
  ON tracking_sessions (tenant_id, sold_at) WHERE sold_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_clicked_at
  ON tracking_sessions (tenant_id, clicked_at);

-- Index for period-based queries on meta_campaign_insights
CREATE INDEX IF NOT EXISTS idx_meta_campaign_insights_date
  ON meta_campaign_insights (tenant_id, date_start, date_stop);

-- Customer purchase history: groups tracking_sessions by customer identity
CREATE OR REPLACE VIEW public.vw_customer_purchases
WITH (security_invoker = true) AS
SELECT
  ts.tenant_id,
  coalesce(ts.customer_phone, ts.customer_email) AS customer_key,
  ts.customer_phone,
  ts.customer_email,
  max(ts.customer_name) AS customer_name,
  count(ts.id) AS purchase_count,
  sum(ts.revenue) AS total_revenue,
  min(ts.sold_at) AS first_purchase_at,
  max(ts.sold_at) AS last_purchase_at,
  avg(ts.revenue) AS avg_ticket,
  array_agg(DISTINCT o.name) FILTER (WHERE o.name IS NOT NULL) AS products,
  array_agg(DISTINCT o.category) FILTER (WHERE o.category IS NOT NULL) AS categories,
  array_agg(DISTINCT ts.utm_source) FILTER (WHERE ts.utm_source IS NOT NULL) AS sources,
  array_agg(DISTINCT ts.utm_campaign) FILTER (WHERE ts.utm_campaign IS NOT NULL) AS campaigns
FROM tracking_sessions ts
LEFT JOIN offers o ON o.id = ts.offer_id
WHERE ts.lead_status = 'sold' AND ts.sold_at IS NOT NULL AND ts.revenue > 0
  AND coalesce(ts.customer_phone, ts.customer_email) IS NOT NULL
GROUP BY ts.tenant_id, coalesce(ts.customer_phone, ts.customer_email),
  ts.customer_phone, ts.customer_email;

GRANT SELECT ON public.vw_customer_purchases TO authenticated;

-- Monthly financial summary per tenant
CREATE OR REPLACE VIEW public.vw_monthly_financial
WITH (security_invoker = true) AS
SELECT
  ts.tenant_id,
  date_trunc('month', ts.clicked_at)::date AS month,
  count(ts.id) AS total_leads,
  count(ts.id) FILTER (WHERE ts.lead_status = 'qualified') AS qualified,
  count(ts.id) FILTER (WHERE ts.lead_status = 'sold') AS sales,
  count(ts.id) FILTER (WHERE ts.lead_status = 'lost') AS lost,
  coalesce(sum(ts.revenue) FILTER (WHERE ts.lead_status = 'sold'), 0) AS revenue,
  count(DISTINCT coalesce(ts.customer_phone, ts.customer_email))
    FILTER (WHERE ts.lead_status = 'sold' AND ts.revenue > 0) AS unique_buyers
FROM tracking_sessions ts
WHERE ts.clicked_at IS NOT NULL
GROUP BY ts.tenant_id, date_trunc('month', ts.clicked_at)::date;

GRANT SELECT ON public.vw_monthly_financial TO authenticated;

-- Monthly spend per tenant (from Meta campaign insights)
CREATE OR REPLACE VIEW public.vw_monthly_spend
WITH (security_invoker = true) AS
SELECT
  mci.tenant_id,
  date_trunc('month', mci.date_start::date)::date AS month,
  sum(mci.spend) AS total_spend,
  count(DISTINCT mci.campaign_id) AS active_campaigns
FROM meta_campaign_insights mci
WHERE mci.date_start IS NOT NULL
GROUP BY mci.tenant_id, date_trunc('month', mci.date_start::date)::date;

GRANT SELECT ON public.vw_monthly_spend TO authenticated;
