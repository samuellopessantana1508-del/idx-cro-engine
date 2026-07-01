alter table public.tenant_meta_credentials
  add column if not exists facebook_user_id text,
  add column if not exists facebook_user_name text,
  add column if not exists facebook_token_expires_at timestamptz,
  add column if not exists selected_ad_account_id text,
  add column if not exists selected_ad_account_name text,
  add column if not exists selected_pixel_name text,
  add column if not exists integration_status text not null default 'not_connected'
    check (integration_status in ('not_connected', 'connected', 'needs_attention')),
  add column if not exists last_verified_at timestamptz,
  add column if not exists last_error text;

create table if not exists public.integration_oauth_states (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('meta')),
  state text not null unique,
  redirect_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_onboarding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  tenant_created boolean not null default true,
  whatsapp_checked boolean not null default false,
  meta_connected boolean not null default false,
  first_link_created boolean not null default false,
  first_lead_received boolean not null default false,
  first_purchase_sent boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  role text not null default 'operator' check (role in ('owner', 'admin', 'operator', 'viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.integration_oauth_states enable row level security;
alter table public.tenant_onboarding enable row level security;
alter table public.tenant_invites enable row level security;

create policy integration_oauth_states_service_only
on public.integration_oauth_states for all
to service_role
using (true)
with check (true);

create policy tenant_onboarding_select_member
on public.tenant_onboarding for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy tenant_onboarding_update_admin
on public.tenant_onboarding for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

create policy tenant_invites_select_admin
on public.tenant_invites for select
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

create policy tenant_invites_service_only
on public.tenant_invites for all
to service_role
using (true)
with check (true);

create or replace view public.vw_tenant_report
with (security_invoker = true) as
select
  t.id as tenant_id,
  t.name as tenant_name,
  count(ts.id) as clicks,
  count(ts.id) filter (where ts.lead_status in ('new','contacted','sold','lost')) as whatsapp_leads,
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

grant select on public.tenant_onboarding to authenticated;
grant update on public.tenant_onboarding to authenticated;
grant select on public.tenant_invites to authenticated;
grant select on public.vw_tenant_report to authenticated;
grant select, insert, update, delete on public.integration_oauth_states to service_role;
grant select, insert, update, delete on public.tenant_onboarding to service_role;
grant select, insert, update, delete on public.tenant_invites to service_role;

