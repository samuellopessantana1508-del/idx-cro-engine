alter table public.tracking_sessions
  add column if not exists qualified_at timestamptz,
  add column if not exists bad_at timestamptz,
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists lead_score int not null default 0,
  add column if not exists tags text[] not null default '{}',
  add column if not exists last_crm_activity_at timestamptz;

alter table public.tracking_sessions
  drop constraint if exists tracking_sessions_lead_status_check;

alter table public.tracking_sessions
  add constraint tracking_sessions_lead_status_check
  check (lead_status in ('new', 'contacted', 'qualified', 'bad', 'sold', 'lost'));

drop view if exists public.vw_crm_pipeline;
drop view if exists public.vw_remarketing_audience;
drop view if exists public.vw_lead_quality_report;
drop view if exists public.vw_meta_campaign_roi;
drop view if exists public.vw_tenant_report;
drop view if exists public.vw_smart_link_performance;
drop view if exists public.vw_lead_queue;

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracking_session_id uuid not null references public.tracking_sessions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  activity_type text not null check (activity_type in ('note', 'stage_change', 'whatsapp', 'call', 'tag', 'capi', 'system')),
  body text,
  from_status text,
  to_status text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_tracking_sessions_follow_up
on public.tracking_sessions(tenant_id, next_follow_up_at)
where next_follow_up_at is not null;

create index if not exists idx_tracking_sessions_tags
on public.tracking_sessions using gin(tags);

create index if not exists idx_crm_activities_session_created
on public.crm_activities(tracking_session_id, created_at desc);

create index if not exists idx_crm_activities_tenant_created
on public.crm_activities(tenant_id, created_at desc);

alter table public.crm_activities enable row level security;

create policy crm_activities_select_member
on public.crm_activities for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy crm_activities_insert_operator
on public.crm_activities for insert
to authenticated
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

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
left join public.offers o on o.id = ts.offer_id;

create or replace view public.vw_smart_link_performance
with (security_invoker = true) as
select
  sl.id,
  sl.tenant_id,
  sl.code,
  sl.name,
  sl.status,
  o.name as offer_name,
  o.category,
  count(ts.id) as clicks,
  count(*) filter (where ts.lead_status in ('contacted','qualified','bad','sold','lost')) as handled,
  count(*) filter (where ts.lead_status = 'qualified') as qualified,
  count(*) filter (where ts.lead_status = 'bad') as bad_leads,
  count(*) filter (where ts.lead_status = 'sold') as sales,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case
    when count(ts.id) = 0 then 0
    else round((count(*) filter (where ts.lead_status = 'sold'))::numeric / count(ts.id) * 100, 1)
  end as conversion_rate
from public.smart_links sl
left join public.offers o on o.id = sl.offer_id
left join public.tracking_sessions ts on ts.smart_link_id = sl.id
group by sl.id, sl.tenant_id, sl.code, sl.name, sl.status, o.name, o.category;

create or replace view public.vw_crm_pipeline
with (security_invoker = true) as
with activity as (
  select
    tracking_session_id,
    count(*) as activity_count,
    max(created_at) as last_activity_at
  from public.crm_activities
  group by tracking_session_id
)
select
  q.*,
  coalesce(a.activity_count, 0) as activity_count,
  a.last_activity_at,
  (q.lead_status = 'qualified') as is_remarketing
from public.vw_lead_queue q
left join activity a on a.tracking_session_id = q.id;

create or replace view public.vw_lead_quality_report
with (security_invoker = true) as
select
  ts.tenant_id,
  coalesce(ts.utm_campaign, 'sem-campanha') as campaign_key,
  max(coalesce(sl.name, 'Sem link')) as link_name,
  count(ts.id) as leads,
  count(ts.id) filter (where ts.lead_status = 'new') as new_leads,
  count(ts.id) filter (where ts.lead_status = 'contacted') as contacted_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as qualified_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as remarketing_leads,
  count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
  count(ts.id) filter (where ts.lead_status = 'sold') as sales,
  count(ts.id) filter (where ts.lead_status = 'lost') as lost_leads,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case when count(ts.id) = 0 then 0 else round(count(ts.id) filter (where ts.lead_status = 'qualified')::numeric / count(ts.id) * 100, 1) end as quality_rate,
  case when count(ts.id) = 0 then 0 else round(count(ts.id) filter (where ts.lead_status = 'bad')::numeric / count(ts.id) * 100, 1) end as bad_rate,
  max(ts.clicked_at) as last_lead_at
from public.tracking_sessions ts
left join public.smart_links sl on sl.id = ts.smart_link_id
group by ts.tenant_id, coalesce(ts.utm_campaign, 'sem-campanha');

create or replace view public.vw_remarketing_audience
with (security_invoker = true) as
select
  ts.id,
  ts.tenant_id,
  ts.ref,
  ts.customer_phone,
  ts.customer_email,
  ts.customer_name,
  ts.utm_source,
  ts.utm_medium,
  ts.utm_campaign,
  ts.qualified_at,
  ts.tags,
  o.name as offer_name,
  sl.name as link_name
from public.tracking_sessions ts
left join public.smart_links sl on sl.id = ts.smart_link_id
left join public.offers o on o.id = ts.offer_id
where ts.lead_status = 'qualified';

create or replace view public.vw_tenant_report
with (security_invoker = true) as
select
  t.id as tenant_id,
  t.name as tenant_name,
  count(ts.id) as clicks,
  count(ts.id) filter (where ts.lead_status in ('new','contacted','qualified','bad','sold','lost')) as whatsapp_leads,
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
    count(ts.id) as leads,
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

grant select, insert on public.crm_activities to authenticated;
grant select, insert, update, delete on public.crm_activities to service_role;
grant select on public.vw_crm_pipeline to authenticated;
grant select on public.vw_lead_quality_report to authenticated;
grant select on public.vw_remarketing_audience to authenticated;
