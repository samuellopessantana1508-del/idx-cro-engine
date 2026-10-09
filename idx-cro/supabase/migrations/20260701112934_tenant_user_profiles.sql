alter table public.tenant_users
  add column if not exists email text;

create index if not exists idx_tenant_users_tenant_email
on public.tenant_users(tenant_id, lower(email))
where email is not null;
