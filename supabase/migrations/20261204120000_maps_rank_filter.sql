-- Busca no Google Maps: só empresas abaixo das primeiras posições (ex.: fora do top 9) e sem redes.
--  * lead_sources.min_rank: posição mínima no Google para entrar no discador (1 = todas; 10 = só da 10ª em diante)
--  * rede regional: nome com várias unidades (no discador ou na mesma busca) conta como rede
--  * maps_rank_update: grava a posição no Google das empresas que já estão no discador (checagem de posição)

alter table public.lead_sources add column if not exists min_rank integer not null default 1 check (min_rank between 1 and 60);
alter table public.lead_source_runs add column if not exists top_ranked integer not null default 0;

-- "Drogaria Cristal 24h - Centro" e "Drogaria Cristal 24h Loja 2" → "drogaria cristal 24h"
create or replace function idx_private.maps_name_base(p_name text)
returns text language sql immutable set search_path = pg_temp
as $$
  select nullif(lower(trim(regexp_replace(split_part(coalesce(p_name, ''), ' - ', 1), '\s+(loja|unidade|filial)\M.*$', '', 'i'))), '');
$$;

create or replace function idx_private.maps_ingest(p_run uuid, p_places jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  run public.lead_source_runs;
  s public.lead_sources;
  c public.wa_campaigns;
  p jsonb;
  v_phone text;
  v_id uuid;
  v_ins int := 0; v_dup int := 0; v_nophone int := 0; v_chain int := 0; v_low int := 0; v_opt int := 0; v_camp int := 0;
  v_found int := 0; v_top int := 0;
begin
  select * into run from public.lead_source_runs where id = p_run;
  select * into s from public.lead_sources where id = run.source_id;
  if s.id is null then raise exception 'Fonte não encontrada'; end if;
  if s.campaign_id is not null then
    select * into c from public.wa_campaigns where id = s.campaign_id and status in ('draft', 'running', 'paused') and auto_feed;
  end if;

  for p in select * from jsonb_array_elements(coalesce(p_places, '[]'::jsonb)) loop
    v_found := v_found + 1;
    if v_ins >= s.max_new_per_run then exit; end if;
    v_phone := idx_private.normalize_phone(p->>'phone');
    if v_phone is null then v_nophone := v_nophone + 1; continue; end if;
    -- só quem está abaixo das primeiras posições do Google (ex.: min_rank 10 = fora do top 9)
    if coalesce(s.min_rank, 1) > 1 and coalesce((p->>'rank')::int, 0) < s.min_rank then v_top := v_top + 1; continue; end if;
    if s.exclude_chains and (idx_private.maps_is_chain(p->>'name')
        -- rede regional: outra unidade com o mesmo nome já está no discador (telefone diferente)
        or exists (select 1 from public.crm_dial_leads d where d.tenant_id = s.tenant_id
                     and idx_private.maps_name_base(d.name) = idx_private.maps_name_base(p->>'name')
                     and lower(coalesce(d.city, '')) = lower(coalesce(p->>'city', ''))
                     and d.phone is distinct from v_phone)
        or (select count(*) from jsonb_array_elements(p_places) q
             where idx_private.maps_name_base(q->>'name') = idx_private.maps_name_base(p->>'name')) > 1) then
      v_chain := v_chain + 1; continue;
    end if;
    if s.min_rating is not null and coalesce((p->>'rating')::numeric, 0) < s.min_rating then v_low := v_low + 1; continue; end if;
    if exists (select 1 from public.wa_optouts where tenant_id = s.tenant_id and phone = v_phone) then v_opt := v_opt + 1; continue; end if;
    if exists (select 1 from public.crm_dial_leads d where d.tenant_id = s.tenant_id
                and (d.phone = v_phone or (p->>'place_id' is not null and d.place_id = p->>'place_id'))) then
      v_dup := v_dup + 1; continue;
    end if;

    insert into public.crm_dial_leads (tenant_id, list_name, name, phone, city, uf, district, source, place_id, rating, reviews,
                                       maps_rank, maps_query, maps_url, website, address, lead_source_id)
    values (s.tenant_id, s.list_name, left(coalesce(nullif(p->>'name', ''), 'Sem nome'), 200), v_phone,
            nullif(p->>'city', ''), nullif(upper(p->>'uf'), ''),
            left(concat_ws(' · ',
                 case when (p->>'rank') is not null then '📍 Nº ' || (p->>'rank') || ' no Google' end,
                 case when (p->>'rating') is not null then '⭐ ' || to_char((p->>'rating')::numeric, 'FM0.0') || coalesce(' (' || (p->>'reviews') || ')', '') end,
                 nullif(p->>'address', '')), 400),
            'google_places', nullif(p->>'place_id', ''), (p->>'rating')::numeric, (p->>'reviews')::int,
            (p->>'rank')::int, left(s.query || ' · ' || coalesce(p->>'location', ''), 200),
            nullif(p->>'maps_url', ''), nullif(p->>'website', ''), nullif(p->>'address', ''), s.id)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then v_dup := v_dup + 1; continue; end if;
    v_ins := v_ins + 1;

    if c.id is not null then
      insert into public.wa_campaign_recipients (tenant_id, campaign_id, phone, name, vars, dial_lead_id, status)
      values (s.tenant_id, c.id, v_phone, left(p->>'name', 200),
              jsonb_strip_nulls(jsonb_build_object('empresa', p->>'name', 'cidade', p->>'city', 'uf', p->>'uf',
                                                   'bairro', p->>'district', 'nota', replace(to_char((p->>'rating')::numeric, 'FM0.0'), '.', ','),
                                                   'avaliacoes', p->>'reviews', 'posicao', p->>'rank')),
              v_id, 'pending')
      on conflict (campaign_id, phone) do nothing;
      if found then v_camp := v_camp + 1; end if;
    end if;
  end loop;

  update public.lead_source_runs lr
     set found = lr.found + v_found, inserted = lr.inserted + v_ins, duplicates = lr.duplicates + v_dup,
         no_phone = lr.no_phone + v_nophone, chains = lr.chains + v_chain, low_rating = lr.low_rating + v_low,
         opted_out = lr.opted_out + v_opt, to_campaign = lr.to_campaign + v_camp, top_ranked = lr.top_ranked + v_top
   where lr.id = p_run;
  -- disparo automático parado por falta de contatos volta a enviar sozinho
  if v_camp > 0 then
    update public.wa_campaigns set next_send_at = least(coalesce(next_send_at, now()), now() + interval '1 minute')
     where id = c.id and status = 'running';
  end if;
  return jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'to_campaign', v_camp, 'top_ranked', v_top);
end $$;

create or replace function public.lead_source_set_min_rank(p_source_id uuid, p_min_rank int)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s public.lead_sources;
begin
  select * into s from public.lead_sources where id = p_source_id;
  if s.id is null or not idx_private.crm_can(s.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  update public.lead_sources set min_rank = greatest(1, least(60, coalesce(p_min_rank, 1))) where id = s.id;
  return greatest(1, least(60, coalesce(p_min_rank, 1)));
end $$;
grant execute on function public.lead_source_set_min_rank(uuid, int) to authenticated;

-- Checagem de posição: a função maps-leads busca a cidade no Google e informa a posição de cada lugar;
-- aqui casa com o discador pelo telefone ou pelo nome. p_places: [{name, phone, rank, place_id}]
create or replace function public.maps_rank_update(p_tenant uuid, p_list text, p_city text, p_uf text, p_places jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_matched int := 0;
begin
  with g as (
    select idx_private.normalize_phone(x->>'phone') phone, idx_private.maps_name_base(x->>'name') base,
           nullif(x->>'place_id', '') place_id, (x->>'rank')::int rnk
      from jsonb_array_elements(coalesce(p_places, '[]'::jsonb)) x
  ), m as (
    select d.id, min(g.rnk) rnk, max(g.place_id) place_id
      from public.crm_dial_leads d
      join g on (g.phone is not null and g.phone = d.phone) or (g.base is not null and g.base = idx_private.maps_name_base(d.name))
     where d.tenant_id = p_tenant and d.list_name = p_list
       and lower(coalesce(d.city, '')) = lower(coalesce(p_city, '')) and coalesce(upper(d.uf), '') = coalesce(upper(p_uf), '')
     group by d.id
  )
  update public.crm_dial_leads d set maps_rank = m.rnk, place_id = coalesce(d.place_id, m.place_id)
    from m where m.id = d.id;
  get diagnostics v_matched = row_count;
  -- não apareceu nas posições buscadas: fica marcado como "abaixo" (61 = depois da 60ª) para não checar de novo
  update public.crm_dial_leads d set maps_rank = 61
   where d.tenant_id = p_tenant and d.list_name = p_list and d.maps_rank is null
     and lower(coalesce(d.city, '')) = lower(coalesce(p_city, '')) and coalesce(upper(d.uf), '') = coalesce(upper(p_uf), '');
  return jsonb_build_object('matched', v_matched);
end $$;
revoke all on function public.maps_rank_update(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.maps_rank_update(uuid, text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
