-- ============================================================================
-- Discador: desempenho com listas grandes (dezenas de milhares de números)
-- O resumo checava a permissão (RLS) linha a linha em várias varreduras.
-- Agora verifica a permissão uma vez e conta tudo numa passada.
-- ============================================================================

create or replace function public.crm_dial_overview(p_tenant_id uuid, p_list text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  v jsonb;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then
    raise exception 'Sem acesso a esta empresa';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'pending', count(*) filter (where status = 'pending'),
    'called', count(*) filter (where status = 'called'),
    'called_today', count(*) filter (where called_at >= v_today),
    'meetings', count(*) filter (where outcome = 'meeting'),
    'callbacks', count(*) filter (where outcome = 'callback'))
  into v
  from public.crm_dial_leads
  where tenant_id = p_tenant_id and (p_list is null or list_name = p_list);

  v := v || jsonb_build_object(
    'lists', coalesce((select jsonb_agg(jsonb_build_object('name', list_name, 'total', n, 'pending', p) order by list_name)
                       from (select list_name, count(*) n, count(*) filter (where status = 'pending') p
                             from public.crm_dial_leads where tenant_id = p_tenant_id group by list_name) x), '[]'::jsonb),
    'ufs', coalesce((select jsonb_agg(jsonb_build_object('uf', uf, 'total', n, 'pending', p) order by uf)
                     from (select uf, count(*) n, count(*) filter (where status = 'pending') p
                           from public.crm_dial_leads
                           where tenant_id = p_tenant_id and (p_list is null or list_name = p_list) and uf is not null
                           group by uf) u), '[]'::jsonb));
  return v;
end;
$$;

revoke all on function public.crm_dial_overview(uuid, text) from public, anon;
grant execute on function public.crm_dial_overview(uuid, text) to authenticated;

-- índice para a aba "Já liguei" (ordenada pela última ligação) e para busca por estado
create index if not exists idx_crm_dial_leads_called_list on public.crm_dial_leads(tenant_id, list_name, status, called_at desc);

-- listagem/busca do discador: permissão verificada uma vez (em vez de linha a linha)
create or replace function public.crm_dial_list(
  p_tenant_id uuid, p_list text, p_status text, p_uf text default null, p_search text default null,
  p_limit integer default 60, p_offset integer default 0)
returns setof public.crm_dial_leads
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_s text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := regexp_replace(coalesce(p_search, ''), '\D', '', 'g');
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then
    raise exception 'Sem acesso a esta empresa';
  end if;
  return query
  select * from public.crm_dial_leads l
  where l.tenant_id = p_tenant_id
    and (p_list is null or l.list_name = p_list)
    and l.status = p_status
    and (p_uf is null or p_uf = '' or l.uf = p_uf)
    and (v_s is null
         or l.name ilike '%' || v_s || '%' or l.city ilike '%' || v_s || '%' or l.district ilike '%' || v_s || '%'
         or (length(v_digits) >= 4 and l.phone like '%' || v_digits || '%'))
  order by
    case when p_status = 'pending' then l.uf end, case when p_status = 'pending' then l.city end, case when p_status = 'pending' then l.name end,
    l.called_at desc nulls last, l.id
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end;
$$;
revoke all on function public.crm_dial_list(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.crm_dial_list(uuid, text, text, text, text, integer, integer) to authenticated;
