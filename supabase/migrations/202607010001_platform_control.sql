create table if not exists public.platform_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('owner', 'admin', 'support', 'viewer')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_platform_users_user_status
on public.platform_users(user_id, status);

create index if not exists idx_platform_audit_tenant_created
on public.platform_audit_log(tenant_id, created_at desc);

create index if not exists idx_platform_audit_actor_created
on public.platform_audit_log(actor_user_id, created_at desc);

alter table public.platform_users enable row level security;
alter table public.platform_audit_log enable row level security;

create policy platform_users_service_only
on public.platform_users for all
to service_role
using (true)
with check (true);

create policy platform_audit_log_service_only
on public.platform_audit_log for all
to service_role
using (true)
with check (true);

create or replace function idx_private.is_platform_user(allowed_roles text[] default null)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.platform_users pu
    where pu.user_id = (select auth.uid())
      and pu.status = 'active'
      and (allowed_roles is null or pu.role = any(allowed_roles))
  );
$$;

revoke all on function idx_private.is_platform_user(text[]) from public;
grant execute on function idx_private.is_platform_user(text[]) to authenticated;

create or replace function idx_private.has_tenant_role(check_tenant_id uuid, allowed_roles text[] default null)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    exists (
      select 1
      from public.platform_users pu
      where pu.user_id = (select auth.uid())
        and pu.status = 'active'
        and (
          pu.role in ('owner', 'admin', 'support')
          or (allowed_roles is null and pu.role = 'viewer')
        )
    )
    or exists (
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

create or replace view public.vw_tenant_isolation_audit
with (security_invoker = true) as
select
  t.id as tenant_id,
  t.name as tenant_name,
  t.slug as tenant_slug,
  t.status as tenant_status,
  count(distinct tu.id) as tenant_users,
  count(distinct o.id) as offers,
  count(distinct sl.id) as smart_links,
  count(distinct ts.id) as tracking_sessions,
  count(distinct ca.id) as crm_activities,
  count(distinct ce.id) as capi_events,
  count(distinct mi.id) as meta_insight_rows,
  max(greatest(
    coalesce(t.updated_at, t.created_at),
    coalesce(ts.created_at, t.created_at),
    coalesce(ca.created_at, t.created_at),
    coalesce(ce.created_at, t.created_at),
    coalesce(mi.synced_at, t.created_at)
  )) as last_activity_at
from public.tenants t
left join public.tenant_users tu on tu.tenant_id = t.id
left join public.offers o on o.tenant_id = t.id
left join public.smart_links sl on sl.tenant_id = t.id
left join public.tracking_sessions ts on ts.tenant_id = t.id
left join public.crm_activities ca on ca.tenant_id = t.id
left join public.capi_events ce on ce.tenant_id = t.id
left join public.meta_campaign_insights mi on mi.tenant_id = t.id
group by t.id, t.name, t.slug, t.status;

grant select, insert, update, delete on public.platform_users to service_role;
grant select, insert, update, delete on public.platform_audit_log to service_role;
grant select on public.vw_tenant_isolation_audit to authenticated;
