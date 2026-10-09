create index if not exists idx_tenant_invites_tenant_email_role_created
on public.tenant_invites(tenant_id, lower(email), role, created_at desc);

create index if not exists idx_tenant_invites_invited_by
on public.tenant_invites(invited_by);
