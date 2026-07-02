alter table public.tenant_onboarding
  add column if not exists business_segment text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists monthly_goal numeric(12,2),
  add column if not exists average_ticket numeric(12,2),
  add column if not exists primary_channel text,
  add column if not exists responsible_name text;
