-- Google Ads Integration
-- Credentials, campaign insights, offline conversions, attribution view

-- 1. Google Ads credentials per tenant (parallel to tenant_meta_credentials)
create table if not exists public.tenant_google_credentials (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  google_user_id text,
  google_user_email text,
  google_user_name text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  customer_id text,
  customer_descriptive_name text,
  manager_customer_id text,
  currency_code text default 'BRL',
  time_zone text default 'America/Sao_Paulo',
  integration_status text not null default 'not_connected'
    check (integration_status in ('not_connected', 'connected', 'needs_attention')),
  enabled boolean not null default false,
  last_synced_at timestamptz,
  last_verified_at timestamptz,
  last_error text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_google_credentials enable row level security;

-- No SELECT for authenticated: tokens live here, only edge functions (service_role) access this table.
-- Frontend gets safe fields via the google-ads edge function.

create policy google_creds_service_only
on public.tenant_google_credentials for all
to service_role
using (true)
with check (true);

grant select, insert, update, delete on public.tenant_google_credentials to service_role;

-- 2. Extend integration_oauth_states to support google provider
alter table public.integration_oauth_states
  drop constraint if exists integration_oauth_states_provider_check;
alter table public.integration_oauth_states
  add constraint integration_oauth_states_provider_check
  check (provider in ('meta', 'google'));

-- 3. Extend tenant_onboarding
alter table public.tenant_onboarding
  add column if not exists google_connected boolean not null default false;

-- 4. Google campaign insights (parallel to meta_campaign_insights)
create table if not exists public.google_campaign_insights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id text not null,
  customer_name text,
  campaign_id text not null,
  campaign_name text not null,
  campaign_status text,
  campaign_type text,
  date date not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  cost numeric(12,2) generated always as (cost_micros / 1000000.0) stored,
  ctr numeric(12,4),
  average_cpc_micros bigint,
  conversions numeric(12,2) not null default 0,
  cost_per_conversion_micros bigint,
  raw jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, customer_id, campaign_id, date)
);

create index if not exists idx_google_insights_tenant_date
on public.google_campaign_insights(tenant_id, date desc);

create index if not exists idx_google_insights_campaign
on public.google_campaign_insights(tenant_id, campaign_id);

alter table public.google_campaign_insights enable row level security;

create policy google_insights_select_member
on public.google_campaign_insights for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy google_insights_service_only
on public.google_campaign_insights for all
to service_role
using (true)
with check (true);

grant select on public.google_campaign_insights to authenticated;
grant select, insert, update, delete on public.google_campaign_insights to service_role;

-- 5. Google Ads campaign-to-UTM mapping
create table if not exists public.google_campaign_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  utm_campaign text not null,
  google_campaign_id text not null,
  google_campaign_name text,
  created_at timestamptz not null default now(),
  unique (tenant_id, utm_campaign, google_campaign_id)
);

create index if not exists idx_google_mapping_tenant_utm
on public.google_campaign_mappings(tenant_id, utm_campaign);

alter table public.google_campaign_mappings enable row level security;

create policy google_mapping_select_member
on public.google_campaign_mappings for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy google_mapping_write_admin
on public.google_campaign_mappings for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

grant select on public.google_campaign_mappings to authenticated;
grant insert, update, delete on public.google_campaign_mappings to authenticated;

-- 6. Offline conversion uploads history
create table if not exists public.google_conversion_uploads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  customer_id text not null,
  conversion_action text not null,
  gclid text,
  gbraid text,
  wbraid text,
  conversion_date_time text not null,
  conversion_value numeric(12,2),
  currency_code text default 'BRL',
  event_type text not null check (event_type in ('qualified', 'appointment', 'sale')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  response_payload jsonb,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_google_conv_tenant
on public.google_conversion_uploads(tenant_id, status);

create index if not exists idx_google_conv_session
on public.google_conversion_uploads(tracking_session_id);

alter table public.google_conversion_uploads enable row level security;

create policy google_conv_select_member
on public.google_conversion_uploads for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy google_conv_service_only
on public.google_conversion_uploads for all
to service_role
using (true)
with check (true);

grant select on public.google_conversion_uploads to authenticated;
grant select, insert, update, delete on public.google_conversion_uploads to service_role;

-- 7. Google conversion action config per tenant
create table if not exists public.tenant_google_conversion_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversion_action_resource text not null,
  conversion_action_name text not null,
  event_type text not null check (event_type in ('qualified', 'appointment', 'sale')),
  auto_send boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, event_type)
);

alter table public.tenant_google_conversion_actions enable row level security;

create policy google_conv_actions_select_member
on public.tenant_google_conversion_actions for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy google_conv_actions_write_admin
on public.tenant_google_conversion_actions for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

grant select, insert, update, delete on public.tenant_google_conversion_actions to authenticated;

-- 8. Add gbraid/wbraid to tracking_sessions
alter table public.tracking_sessions
  add column if not exists gbraid text,
  add column if not exists wbraid text;

-- 9. Attribution view: Google Ads campaigns + IDX leads/sales
-- Uses DISTINCT ON to assign each session to exactly one campaign (prevents
-- duplicate counting when multiple campaign mappings match the same session).
-- Leads = sessions with real evidence of contact (WhatsApp confirmed or CRM status changed).
create or replace view public.vw_google_campaign_roi
with (security_invoker = true) as
with google as (
  select
    tenant_id,
    campaign_id,
    max(campaign_name) as campaign_name,
    max(campaign_status) as campaign_status,
    max(campaign_type) as campaign_type,
    sum(cost_micros) as cost_micros,
    sum(cost_micros)::numeric / 1000000.0 as spend,
    sum(impressions) as impressions,
    sum(clicks) as clicks,
    sum(conversions) as google_conversions,
    min(date) as date_start,
    max(date) as date_stop
  from public.google_campaign_insights
  group by tenant_id, campaign_id
),
deduped_sessions as (
  select distinct on (ts.id)
    ts.id,
    ts.tenant_id,
    ts.lead_status,
    ts.whatsapp_opened_at,
    ts.revenue,
    coalesce(m.google_campaign_id, ts.utm_campaign) as campaign_key
  from public.tracking_sessions ts
  left join public.google_campaign_mappings m
    on m.tenant_id = ts.tenant_id
   and lower(m.utm_campaign) = lower(ts.utm_campaign)
  where ts.gclid is not null or ts.gbraid is not null or ts.wbraid is not null
     or lower(ts.utm_source) = 'google'
  order by ts.id, m.google_campaign_id nulls last
),
tracked as (
  select
    tenant_id,
    campaign_key,
    count(*) filter (
      where whatsapp_opened_at is not null or lead_status <> 'new'
    ) as leads,
    count(*) filter (where lead_status = 'qualified') as qualified,
    count(*) filter (where lead_status = 'sold') as sales,
    coalesce(sum(revenue) filter (where lead_status = 'sold'), 0) as revenue
  from deduped_sessions
  group by tenant_id, campaign_key
),
matched as (
  select g.tenant_id, g.campaign_id,
    sum(t.leads) as leads,
    sum(t.qualified) as qualified,
    sum(t.sales) as sales,
    sum(t.revenue) as revenue
  from google g
  join tracked t on t.tenant_id = g.tenant_id
    and lower(t.campaign_key) in (lower(g.campaign_id), lower(g.campaign_name))
  group by g.tenant_id, g.campaign_id
)
select
  g.tenant_id,
  g.campaign_id,
  g.campaign_name,
  g.campaign_status,
  g.campaign_type,
  g.date_start,
  g.date_stop,
  g.spend,
  g.impressions,
  g.clicks as google_clicks,
  g.google_conversions,
  coalesce(m.leads, 0) as idx_leads,
  coalesce(m.qualified, 0) as idx_qualified,
  coalesce(m.sales, 0) as idx_sales,
  coalesce(m.revenue, 0) as idx_revenue,
  case when coalesce(m.leads, 0) = 0 then null
       else round(g.spend / m.leads, 2) end as cpl,
  case when coalesce(m.sales, 0) = 0 then null
       else round(g.spend / m.sales, 2) end as cpv,
  case when g.spend = 0 then null
       else round(coalesce(m.revenue, 0) / g.spend, 2) end as roas
from google g
left join matched m
  on m.tenant_id = g.tenant_id
 and m.campaign_id = g.campaign_id;

grant select on public.vw_google_campaign_roi to authenticated;
grant select on public.tenant_google_conversion_actions to service_role;
