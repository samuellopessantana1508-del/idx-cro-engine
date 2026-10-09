-- Consolida a atribuição de leads por campanha Meta em UMA linha.
-- Antes, quando sessões chegavam com utm_campaign igual ao NOME da campanha e
-- outras com o ID, cada chave virava uma linha duplicada na tabela de ROI.
-- Agora as chaves casadas são somadas por campanha.

create or replace view public.vw_meta_campaign_roi
with (security_invoker = true) as
with meta as (
  select
    tenant_id,
    campaign_id,
    max(campaign_name) as campaign_name,
    sum(spend) as spend,
    sum(impressions) as impressions,
    sum(reach) as reach,
    sum(clicks) as clicks,
    min(date_start) as date_start,
    max(date_stop) as date_stop
  from public.meta_campaign_insights
  group by tenant_id, campaign_id
),
tracked as (
  select
    ts.tenant_id,
    coalesce(m.meta_campaign_id, ts.utm_campaign) as campaign_key,
    count(ts.id) filter (where ts.whatsapp_opened_at is not null) as leads,
    count(ts.id) filter (where ts.lead_status = 'qualified') as qualified_leads,
    count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
    count(ts.id) filter (where ts.lead_status = 'sold') as sales,
    coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue
  from public.tracking_sessions ts
  left join public.meta_campaign_mappings m
    on m.tenant_id = ts.tenant_id
   and lower(m.utm_campaign) = lower(ts.utm_campaign)
  group by ts.tenant_id, coalesce(m.meta_campaign_id, ts.utm_campaign)
),
matched as (
  select
    meta.tenant_id,
    meta.campaign_id,
    sum(t.leads) as leads,
    sum(t.qualified_leads) as qualified_leads,
    sum(t.bad_leads) as bad_leads,
    sum(t.sales) as sales,
    sum(t.revenue) as revenue
  from meta
  join tracked t
    on t.tenant_id = meta.tenant_id
   and lower(t.campaign_key) in (lower(meta.campaign_id), lower(meta.campaign_name))
  group by meta.tenant_id, meta.campaign_id
)
select
  meta.tenant_id,
  meta.campaign_id,
  meta.campaign_name,
  meta.date_start,
  meta.date_stop,
  meta.spend,
  meta.impressions,
  meta.reach,
  meta.clicks as meta_clicks,
  coalesce(matched.leads, 0)::bigint as idx_leads,
  coalesce(matched.qualified_leads, 0)::bigint as idx_qualified,
  coalesce(matched.bad_leads, 0)::bigint as idx_bad,
  coalesce(matched.sales, 0)::bigint as idx_sales,
  coalesce(matched.revenue, 0) as idx_revenue,
  case when coalesce(matched.leads, 0) = 0 then null else round(meta.spend / matched.leads, 2) end as cpl,
  case when coalesce(matched.qualified_leads, 0) = 0 then null else round(meta.spend / matched.qualified_leads, 2) end as cost_per_qualified,
  case when coalesce(matched.leads, 0) = 0 then 0 else round(matched.qualified_leads::numeric / matched.leads * 100, 1) end as quality_rate,
  case when meta.spend = 0 then null else round(coalesce(matched.revenue, 0) / meta.spend, 2) end as roas
from meta
left join matched
  on matched.tenant_id = meta.tenant_id
 and matched.campaign_id = meta.campaign_id;
