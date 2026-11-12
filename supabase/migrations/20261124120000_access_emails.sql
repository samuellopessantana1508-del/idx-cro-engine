-- =============================================================================
-- E-mails de acesso pelo Resend: convites, link de acesso e nova senha.
-- (o envio padrão do Supabase só entrega para a equipe do projeto e 2 por hora;
--  os convites ficavam "enviados" sem chegar)
-- =============================================================================

alter table public.tenant_invites add column if not exists email_status text
  check (email_status in ('sent', 'failed', 'not_configured'));
alter table public.tenant_invites add column if not exists email_error text;
alter table public.tenant_invites add column if not exists email_sent_at timestamptz;
alter table public.tenant_invites add column if not exists email_id text;
alter table public.tenant_invites add column if not exists updated_at timestamptz not null default now();
create index if not exists tenant_invites_tenant_email_idx on public.tenant_invites(tenant_id, email, created_at desc);

-- pedidos de link pela tela de login (sem login): limite por e-mail e por origem,
-- guardados só como hash (sem o endereço em texto)
create table if not exists public.auth_email_requests (
  id bigserial primary key,
  email_hash text not null,
  ip_hash text not null,
  kind text not null,
  created_at timestamptz not null default now()
);
alter table public.auth_email_requests enable row level security; -- sem políticas: só a chave de serviço
create index if not exists auth_email_requests_email_idx on public.auth_email_requests(email_hash, created_at desc);
create index if not exists auth_email_requests_ip_idx on public.auth_email_requests(ip_hash, created_at desc);

create or replace function public.auth_email_allow(p_email_hash text, p_ip_hash text, p_kind text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from public.auth_email_requests where created_at < now() - interval '1 day';
  if (select count(*) from public.auth_email_requests where email_hash = p_email_hash and created_at > now() - interval '1 hour') >= 3 then
    return false;
  end if;
  if (select count(*) from public.auth_email_requests where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    return false;
  end if;
  insert into public.auth_email_requests (email_hash, ip_hash, kind) values (p_email_hash, p_ip_hash, left(p_kind, 20));
  return true;
end $$;
revoke all on function public.auth_email_allow(text, text, text) from public, anon, authenticated;
grant execute on function public.auth_email_allow(text, text, text) to service_role;
