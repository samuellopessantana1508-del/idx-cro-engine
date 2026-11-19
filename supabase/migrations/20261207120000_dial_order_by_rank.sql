-- Discador: na fila de "a ligar", quem está mais abaixo no Google vem primeiro (mais espaço para crescer).
-- Listas sem posição no Google continuam na ordem de antes (estado, cidade, nome).
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
    case when p_status = 'pending' then l.maps_rank end desc nulls last,
    case when p_status = 'pending' then l.uf end, case when p_status = 'pending' then l.city end, case when p_status = 'pending' then l.name end,
    l.called_at desc nulls last, l.id
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end;
$$;

revoke all on function public.crm_dial_list(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.crm_dial_list(uuid, text, text, text, text, integer, integer) to authenticated;
