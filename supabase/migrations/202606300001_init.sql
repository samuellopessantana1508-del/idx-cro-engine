create extension if not exists pgcrypto;

create schema if not exists idx_private;
revoke all on schema idx_private from public;
revoke all on schema idx_private from anon;
revoke all on schema idx_private from authenticated;
grant usage on schema idx_private to authenticated;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  legal_name text,
  whatsapp_number text not null,
  timezone text not null default 'America/Sao_Paulo',
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  plan text not null default 'starter',
  default_message_template text not null default 'Olá! Tenho interesse em {{oferta}}. Ref: {{ref}}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'operator' check (role in ('owner', 'admin', 'operator', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  slug text not null,
  category text,
  price numeric(12,2),
  default_message text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table public.smart_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  offer_id uuid references public.offers(id) on delete set null,
  code text not null unique,
  name text not null,
  message_template text,
  default_utm_source text,
  default_utm_medium text,
  default_utm_campaign text,
  default_utm_content text,
  default_utm_term text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tracking_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  smart_link_id uuid references public.smart_links(id) on delete set null,
  offer_id uuid references public.offers(id) on delete set null,
  ref text not null unique,
  source_url text,
  request_url text,
  target_url text,
  ip text,
  ua text,
  fbc text,
  fbp text,
  fbclid text,
  gclid text,
  ttclid text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  clicked_at timestamptz not null default now(),
  redirected_at timestamptz,
  lead_status text not null default 'new' check (lead_status in ('new', 'contacted', 'sold', 'lost')),
  customer_phone text,
  customer_email text,
  customer_name text,
  sold_at timestamptz,
  lost_at timestamptz,
  revenue numeric(12,2),
  sale_notes text,
  capi_lead_ok boolean not null default false,
  capi_purchase_ok boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.capi_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  event_name text not null,
  event_id text not null,
  pixel_id text,
  request_payload jsonb,
  response_payload jsonb,
  ok boolean not null default false,
  status_code int,
  error_message text,
  created_at timestamptz not null default now()
);

create table public.tenant_meta_credentials (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  pixel_id text,
  access_token text,
  test_event_code text,
  graph_version text not null default 'v25.0',
  enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index idx_tenant_users_user on public.tenant_users(user_id);
create index idx_offers_tenant on public.offers(tenant_id, status);
create index idx_smart_links_tenant on public.smart_links(tenant_id, status);
create index idx_tracking_sessions_ref on public.tracking_sessions(ref);
create index idx_tracking_sessions_tenant_clicked on public.tracking_sessions(tenant_id, clicked_at desc);
create index idx_tracking_sessions_status on public.tracking_sessions(tenant_id, lead_status, clicked_at desc);
create index idx_capi_events_tenant_created on public.capi_events(tenant_id, created_at desc);

create or replace function idx_private.has_tenant_role(check_tenant_id uuid, allowed_roles text[] default null)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.tenant_users tu
    where tu.tenant_id = check_tenant_id
      and tu.user_id = (select auth.uid())
      and tu.status = 'active'
      and (allowed_roles is null or tu.role = any(allowed_roles))
  );
$$;

revoke all on function idx_private.has_tenant_role(uuid, text[]) from public;
grant execute on function idx_private.has_tenant_role(uuid, text[]) to authenticated;

alter table public.tenants enable row level security;
alter table public.tenant_users enable row level security;
alter table public.offers enable row level security;
alter table public.smart_links enable row level security;
alter table public.tracking_sessions enable row level security;
alter table public.capi_events enable row level security;
alter table public.tenant_meta_credentials enable row level security;

create policy tenants_select_member
on public.tenants for select
to authenticated
using (idx_private.has_tenant_role(id));

create policy tenants_update_admin
on public.tenants for update
to authenticated
using (idx_private.has_tenant_role(id, array['owner','admin']))
with check (idx_private.has_tenant_role(id, array['owner','admin']));

create policy tenant_users_select_member
on public.tenant_users for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy tenant_users_manage_owner
on public.tenant_users for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner']))
with check (idx_private.has_tenant_role(tenant_id, array['owner']));

create policy offers_select_member
on public.offers for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy offers_write_admin
on public.offers for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy smart_links_select_member
on public.smart_links for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy smart_links_write_admin
on public.smart_links for all
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy tracking_sessions_select_member
on public.tracking_sessions for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy tracking_sessions_update_operator
on public.tracking_sessions for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy capi_events_select_member
on public.capi_events for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy tenant_meta_credentials_service_only
on public.tenant_meta_credentials for all
to service_role
using (true)
with check (true);

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
  count(*) filter (where ts.lead_status in ('contacted','sold','lost')) as handled,
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

create or replace view public.vw_capi_health
with (security_invoker = true) as
select
  tenant_id,
  count(*) as total_events,
  count(*) filter (where ok) as successful_events,
  count(*) filter (where not ok) as failed_events,
  count(*) filter (where event_name = 'Lead') as lead_events,
  count(*) filter (where event_name = 'Purchase') as purchase_events,
  max(created_at) as last_event_at,
  case when count(*) = 0 then 0 else round(count(*) filter (where ok)::numeric / count(*) * 100, 1) end as success_rate
from public.capi_events
group by tenant_id;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.tenants to authenticated;
grant select, insert, update, delete on public.tenant_users to authenticated;
grant select, insert, update, delete on public.offers to authenticated;
grant select, insert, update, delete on public.smart_links to authenticated;
grant select, update on public.tracking_sessions to authenticated;
grant select on public.capi_events to authenticated;
grant select on public.vw_smart_link_performance to authenticated;
grant select on public.vw_lead_queue to authenticated;
grant select on public.vw_capi_health to authenticated;
grant select, insert, update, delete on public.tenant_meta_credentials to service_role;
