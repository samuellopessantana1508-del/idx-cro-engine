create table if not exists public.meta_campaign_insights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ad_account_id text not null,
  ad_account_name text,
  campaign_id text not null,
  campaign_name text not null,
  date_start date not null,
  date_stop date not null,
  spend numeric(12,2) not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  cpc numeric(12,4),
  cpm numeric(12,4),
  ctr numeric(12,4),
  raw jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, ad_account_id, campaign_id, date_start, date_stop)
);

create table if not exists public.meta_campaign_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  utm_campaign text not null,
  meta_campaign_id text not null,
  meta_campaign_name text,
  created_at timestamptz not null default now(),
  unique (tenant_id, utm_campaign, meta_campaign_id)
);

create index if not exists idx_meta_insights_tenant_date
on public.meta_campaign_insights(tenant_id, date_start desc);

create index if not exists idx_meta_insights_campaign
on public.meta_campaign_insights(tenant_id, campaign_id);

create index if not exists idx_meta_mapping_tenant_utm
on public.meta_campaign_mappings(tenant_id, utm_campaign);

alter table public.meta_campaign_insights enable row level security;
alter table public.meta_campaign_mappings enable row level security;

create policy meta_insights_select_member
on public.meta_campaign_insights for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy meta_insights_service_only
on public.meta_campaign_insights for all
to service_role
using (true)
with check (true);

create policy meta_mapping_select_member
on public.meta_campaign_mappings for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy meta_mapping_write_admin
on public.meta_campaign_mappings for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

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
  coalesce(tracked.sales, 0) as idx_sales,
  coalesce(tracked.revenue, 0) as idx_revenue,
  case when coalesce(tracked.leads, 0) = 0 then null else round(meta.spend / tracked.leads, 2) end as cpl,
  case when meta.spend = 0 then null else round(tracked.revenue / meta.spend, 2) end as roas
from meta
left join tracked
  on tracked.tenant_id = meta.tenant_id
 and lower(tracked.campaign_key) in (lower(meta.campaign_id), lower(meta.campaign_name));

grant select on public.meta_campaign_insights to authenticated;
grant select on public.meta_campaign_mappings to authenticated;
grant insert, update, delete on public.meta_campaign_mappings to authenticated;
grant select on public.vw_meta_campaign_roi to authenticated;
grant select, insert, update, delete on public.meta_campaign_insights to service_role;

