begin;

create or replace function public.get_meta_token(p_client_id uuid)
returns table (ad_account_id text, access_token text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_idx_member() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  return query
  select a.ad_account_id, c.access_token
  from public.client_meta_accounts a
  join private.client_meta_credentials c on c.client_id = a.client_id
  where a.client_id = p_client_id
    and a.ativo = true;
end;
$$;

revoke all on function public.get_meta_token(uuid) from public, anon;
grant execute on function public.get_meta_token(uuid) to authenticated;

commit;
