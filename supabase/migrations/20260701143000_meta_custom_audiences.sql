create table if not exists public.meta_custom_audiences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  audience_key text not null check (audience_key in ('qualified', 'purchased')),
  name text not null,
  description text,
  meta_audience_id text,
  ad_account_id text,
  customer_file_source text not null default 'USER_PROVIDED_ONLY',
  sync_status text not null default 'not_created' check (sync_status in ('not_created', 'created', 'syncing', 'synced', 'failed')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, audience_key)
);

create table if not exists public.meta_audience_syncs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracking_session_id uuid not null references public.tracking_sessions(id) on delete cascade,
  audience_key text not null check (audience_key in ('qualified', 'purchased')),
  meta_audience_id text,
  sync_status text not null default 'pending' check (sync_status in ('pending', 'synced', 'skipped', 'failed')),
  identifiers jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tracking_session_id, audience_key)
);

create index if not exists idx_meta_custom_audiences_tenant
on public.meta_custom_audiences(tenant_id, audience_key);

create index if not exists idx_meta_audience_syncs_tenant_status
on public.meta_audience_syncs(tenant_id, audience_key, sync_status);

create index if not exists idx_meta_audience_syncs_session
on public.meta_audience_syncs(tracking_session_id);

alter table public.meta_custom_audiences enable row level security;
alter table public.meta_audience_syncs enable row level security;

create policy meta_custom_audiences_select_member
on public.meta_custom_audiences for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy meta_custom_audiences_service_only
on public.meta_custom_audiences for all
to service_role
using (true)
with check (true);

create policy meta_audience_syncs_select_member
on public.meta_audience_syncs for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy meta_audience_syncs_service_only
on public.meta_audience_syncs for all
to service_role
using (true)
with check (true);

create or replace view public.vw_meta_audience_status
with (security_invoker = true) as
select
  a.tenant_id,
  a.audience_key,
  a.name,
  a.description,
  a.meta_audience_id,
  a.ad_account_id,
  a.customer_file_source,
  a.sync_status,
  a.last_synced_at,
  a.last_error,
  coalesce(count(s.id) filter (where s.sync_status = 'synced'), 0)::int as synced_members,
  coalesce(count(s.id) filter (where s.sync_status = 'failed'), 0)::int as failed_members,
  coalesce(count(s.id) filter (where s.sync_status = 'skipped'), 0)::int as skipped_members,
  coalesce(count(s.id), 0)::int as total_attempts
from public.meta_custom_audiences a
left join public.meta_audience_syncs s
  on s.tenant_id = a.tenant_id
 and s.audience_key = a.audience_key
group by
  a.tenant_id,
  a.audience_key,
  a.name,
  a.description,
  a.meta_audience_id,
  a.ad_account_id,
  a.customer_file_source,
  a.sync_status,
  a.last_synced_at,
  a.last_error;

grant select on public.meta_custom_audiences to authenticated;
grant select on public.meta_audience_syncs to authenticated;
grant select on public.vw_meta_audience_status to authenticated;
grant select, insert, update, delete on public.meta_custom_audiences to service_role;
grant select, insert, update, delete on public.meta_audience_syncs to service_role;
