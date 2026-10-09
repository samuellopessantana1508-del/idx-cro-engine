alter table public.tenant_invites
  drop constraint if exists tenant_invites_status_check;

alter table public.tenant_invites
  add constraint tenant_invites_status_check
  check (status in ('pending', 'sent', 'accepted', 'failed'));

update public.tenant_invites i
set status = 'sent',
    error_message = null
where i.status = 'pending'
  and exists (
    select 1
    from public.tenant_users tu
    where tu.tenant_id = i.tenant_id
      and lower(tu.email) = lower(i.email)
      and tu.role = i.role
      and tu.status = 'active'
  );
