-- Allow multiple Meta ad accounts per client (e.g. Lucas Rocha has both "Lucas Rocha Lemes" and "CA Lucas/Lannussy")

-- 1. Drop the unique constraint on client_id so multiple accounts are allowed
alter table public.client_meta_accounts drop constraint if exists client_meta_accounts_client_id_key;

-- 2. Add a composite unique constraint so the same ad_account can't be added twice to the same client
alter table public.client_meta_accounts add constraint client_meta_accounts_client_account_uniq unique (client_id, ad_account_id);

-- 3. Replace save_client_meta_account to upsert on (client_id, ad_account_id) instead of (client_id)
create or replace function public.save_client_meta_account(
  p_client_id uuid,
  p_ad_account_id text,
  p_ad_account_name text,
  p_access_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row_id uuid;
  normalized_account_id text;
begin
  if not private.is_idx_admin() then
    raise exception 'Apenas administradores podem configurar credenciais Meta.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or nullif(btrim(coalesce(p_ad_account_id, '')), '') is null
     or nullif(btrim(coalesce(p_access_token, '')), '') is null then
    raise exception 'Cliente, conta de anúncios e token são obrigatórios.'
      using errcode = '22023';
  end if;

  normalized_account_id := case
    when left(btrim(p_ad_account_id), 4) = 'act_' then btrim(p_ad_account_id)
    else 'act_' || btrim(p_ad_account_id)
  end;

  insert into public.client_meta_accounts (
    client_id,
    ad_account_id,
    ad_account_name,
    ativo
  )
  values (
    p_client_id,
    normalized_account_id,
    coalesce(nullif(btrim(p_ad_account_name), ''), normalized_account_id),
    true
  )
  on conflict (client_id, ad_account_id) do update set
    ad_account_name = excluded.ad_account_name,
    ativo = true
  returning id into account_row_id;

  insert into private.client_meta_credentials (client_id, access_token)
  values (p_client_id, p_access_token)
  on conflict (client_id) do update set
    access_token = excluded.access_token;

  return account_row_id;
end;
$$;

-- 4. Insert the second Meta account for Lucas Rocha (Lanussy)
-- This will run after the constraint change, so it won't conflict
-- We need the client_id for Lucas Rocha - we'll do it via a DO block
do $$
declare
  v_client_id uuid;
begin
  select id into v_client_id from public.clientes where nome ilike '%lucas%rocha%' limit 1;
  if v_client_id is not null then
    insert into public.client_meta_accounts (client_id, ad_account_id, ad_account_name, ativo)
    values (v_client_id, 'act_974670561860498', 'CA Lucas/Lanussy', true)
    on conflict (client_id, ad_account_id) do nothing;
  end if;
end;
$$;
