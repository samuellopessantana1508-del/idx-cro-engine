create table if not exists public.invalid_link_events (
  id uuid primary key default gen_random_uuid(),
  code text,
  request_url text,
  ip text,
  ua text,
  reason text not null default 'not_found',
  created_at timestamptz not null default now()
);

alter table public.invalid_link_events enable row level security;

drop policy if exists "invalid_link_events_service_only" on public.invalid_link_events;
create policy "invalid_link_events_service_only"
  on public.invalid_link_events
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, delete on table public.invalid_link_events to service_role;

create index if not exists idx_invalid_link_events_created_at
  on public.invalid_link_events (created_at desc);

create index if not exists idx_invalid_link_events_code
  on public.invalid_link_events (code)
  where code is not null;

drop view if exists public.vw_invalid_link_health;
create view public.vw_invalid_link_health
with (security_invoker = true) as
select
  count(*) filter (where created_at >= now() - interval '7 days')::bigint as invalid_links_7d,
  max(created_at) as last_invalid_link_at
from public.invalid_link_events;

grant select on public.vw_invalid_link_health to service_role;
