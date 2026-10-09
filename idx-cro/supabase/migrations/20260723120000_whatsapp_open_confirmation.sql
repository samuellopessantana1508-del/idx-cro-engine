-- Lead real = pessoa que efetivamente saiu do Smart Link para o WhatsApp.
-- O clique continua registrado em tracking_sessions, mas o evento Lead (CAPI)
-- e os relatórios de lead passam a considerar apenas sessões confirmadas.

alter table public.tracking_sessions
  add column if not exists whatsapp_opened_at timestamptz;

-- Backfill: todo o histórico anterior já foi tratado como lead, então preserva.
update public.tracking_sessions
  set whatsapp_opened_at = coalesce(redirected_at, clicked_at)
  where whatsapp_opened_at is null;

create index if not exists idx_tracking_sessions_whatsapp_opened
  on public.tracking_sessions (tenant_id, whatsapp_opened_at);

-- Fila do CRM: mostra apenas quem entrou no WhatsApp de verdade.
create or replace view public.vw_lead_queue
with (security_invoker = true) as
select
  ts.id,
  ts.tenant_id,
  ts.ref,
  ts.lead_status,
  ts.clicked_at,
  ts.sold_at,
  ts.lost_at,
  ts.qualified_at,
  ts.bad_at,
  ts.next_follow_up_at,
  ts.lead_score,
  ts.tags,
  ts.last_crm_activity_at,
  ts.revenue,
  ts.customer_phone,
  ts.utm_source,
  ts.utm_medium,
  ts.utm_campaign,
  sl.name as link_name,
  sl.code as link_code,
  o.name as offer_name,
  o.category
from public.tracking_sessions ts
left join public.smart_links sl on sl.id = ts.smart_link_id
left join public.offers o on o.id = ts.offer_id
where ts.whatsapp_opened_at is not null;

-- Qualidade por campanha: "leads" = entradas confirmadas no WhatsApp.
create or replace view public.vw_lead_quality_report
with (security_invoker = true) as
select
  ts.tenant_id,
  coalesce(ts.utm_campaign, 'sem-campanha') as campaign_key,
  max(coalesce(sl.name, 'Sem link')) as link_name,
  count(ts.id) filter (where ts.whatsapp_opened_at is not null) as leads,
  count(ts.id) filter (where ts.lead_status = 'new' and ts.whatsapp_opened_at is not null) as new_leads,
  count(ts.id) filter (where ts.lead_status = 'contacted') as contacted_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as qualified_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as remarketing_leads,
  count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
  count(ts.id) filter (where ts.lead_status = 'sold') as sales,
  count(ts.id) filter (where ts.lead_status = 'lost') as lost_leads,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case when count(ts.id) filter (where ts.whatsapp_opened_at is not null) = 0 then 0
       else round(count(ts.id) filter (where ts.lead_status = 'qualified')::numeric
            / count(ts.id) filter (where ts.whatsapp_opened_at is not null) * 100, 1) end as quality_rate,
  case when count(ts.id) filter (where ts.whatsapp_opened_at is not null) = 0 then 0
       else round(count(ts.id) filter (where ts.lead_status = 'bad')::numeric
            / count(ts.id) filter (where ts.whatsapp_opened_at is not null) * 100, 1) end as bad_rate,
  max(ts.clicked_at) as last_lead_at
from public.tracking_sessions ts
left join public.smart_links sl on sl.id = ts.smart_link_id
group by ts.tenant_id, coalesce(ts.utm_campaign, 'sem-campanha');

-- Relatório por empresa: cliques continuam sendo todos; whatsapp_leads agora
-- é a contagem real de entradas no WhatsApp.
create or replace view public.vw_tenant_report
with (security_invoker = true) as
select
  t.id as tenant_id,
  t.name as tenant_name,
  count(ts.id) as clicks,
  count(ts.id) filter (where ts.whatsapp_opened_at is not null) as whatsapp_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as remarketing_leads,
  count(ts.id) filter (where ts.lead_status = 'sold') as sales,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case
    when count(ts.id) = 0 then 0
    else round(count(ts.id) filter (where ts.lead_status = 'sold')::numeric / count(ts.id) * 100, 1)
  end as conversion_rate,
  max(ts.clicked_at) as last_click_at,
  max(ts.sold_at) as last_sale_at
from public.tenants t
left join public.tracking_sessions ts on ts.tenant_id = t.id
group by t.id, t.name;

-- ROI por campanha Meta: idx_leads = entradas confirmadas no WhatsApp.
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
  coalesce(tracked.leads, 0) as idx_leads,
  coalesce(tracked.qualified_leads, 0) as idx_qualified,
  coalesce(tracked.bad_leads, 0) as idx_bad,
  coalesce(tracked.sales, 0) as idx_sales,
  coalesce(tracked.revenue, 0) as idx_revenue,
  case when coalesce(tracked.leads, 0) = 0 then null else round(meta.spend / tracked.leads, 2) end as cpl,
  case when coalesce(tracked.qualified_leads, 0) = 0 then null else round(meta.spend / tracked.qualified_leads, 2) end as cost_per_qualified,
  case when coalesce(tracked.leads, 0) = 0 then 0 else round(tracked.qualified_leads::numeric / tracked.leads * 100, 1) end as quality_rate,
  case when meta.spend = 0 then null else round(tracked.revenue / meta.spend, 2) end as roas
from meta
left join tracked
  on tracked.tenant_id = meta.tenant_id
 and lower(tracked.campaign_key) in (lower(meta.campaign_id), lower(meta.campaign_name));
