-- =============================================================================
-- Extrator automático do FlowZap original, dentro do CRO.
-- A busca no Google é a mesma do original (Edge Function maps-leads, ação "auto_extract",
-- código em _shared/flowzap-auto-extract.ts). Aqui fica a gravação, com a mesma regra
-- do original: contato novo entra com a etiqueta; contato que já existe só ganha a
-- etiqueta (e o nome, se não tinha). Extra do CRO: pode ir também para o discador e
-- respeita quem pediu SAIR.
-- =============================================================================
create table if not exists public.lead_extractions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source text not null,
  total int not null default 0,
  imported int not null default 0,
  duplicate int not null default 0,
  invalid int not null default 0,
  api_calls int not null default 0,
  tag text,
  list_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_extractions on public.lead_extractions(tenant_id, created_at desc);
alter table public.lead_extractions enable row level security;
drop policy if exists lead_extractions_read on public.lead_extractions;
create policy lead_extractions_read on public.lead_extractions for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

-- chamada só pelo servidor (a Edge Function já conferiu o usuário)
create or replace function public.flowzap_import_leads(
  p_tenant_id uuid, p_user uuid, p_leads jsonb, p_ramo text, p_cidade text, p_tag text,
  p_list_name text default null, p_api_calls int default 0)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  x jsonb;
  v_phone text;
  v_id uuid;
  v_name text;
  v_tag text := nullif(left(trim(coalesce(p_tag, '')), 40), '');
  v_list text := nullif(left(trim(coalesce(p_list_name, '')), 80), '');
  v_imported int := 0; v_duplicate int := 0; v_invalid int := 0; v_optout int := 0; v_dial int := 0;
begin
  if v_tag is null then v_tag := left(lower(regexp_replace(trim(p_ramo) || '-' || trim(p_cidade), '\s+', '-', 'g')), 40); end if;
  for x in select * from jsonb_array_elements(coalesce(p_leads, '[]'::jsonb)) loop
    begin
      v_phone := idx_private.normalize_phone(x->>'phone');
      v_name := nullif(left(trim(coalesce(x->>'name', '')), 200), '');
      if v_phone is null then v_invalid := v_invalid + 1; continue; end if;
      if exists (select 1 from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone) then
        v_optout := v_optout + 1; continue;
      end if;
      select id into v_id from public.crm_contacts
       where tenant_id = p_tenant_id and merged_into_id is null
         and (phone = v_phone or phone_match_key = idx_private.phone_match_key(v_phone))
       order by (phone = v_phone) desc limit 1;
      if v_id is not null then
        v_duplicate := v_duplicate + 1;
        update public.crm_contacts
           set tags = case when v_tag = any(tags) then tags else array_append(tags, v_tag) end,
               name = coalesce(name, v_name)
         where id = v_id;
      else
        insert into public.crm_contacts (tenant_id, phone, name, city, source_channel, source_detail, inbound_outbound, tags, custom, created_by)
        values (p_tenant_id, v_phone, v_name, nullif(left(trim(p_cidade), 120), ''), 'outbound', left('auto:' || p_ramo, 120), 'outbound',
                array[v_tag], jsonb_build_object('endereco', coalesce(x->>'address', ''), 'ramo', p_ramo, 'cidade', p_cidade), p_user);
        v_imported := v_imported + 1;
      end if;
      if v_list is not null then
        insert into public.crm_dial_leads (tenant_id, list_name, name, phone, city, source, address)
        values (p_tenant_id, v_list, coalesce(v_name, v_phone), v_phone, nullif(left(trim(p_cidade), 120), ''), 'google_maps', nullif(x->>'address', ''))
        on conflict do nothing;
        if found then v_dial := v_dial + 1; end if;
      end if;
    exception when others then
      v_invalid := v_invalid + 1;
    end;
  end loop;
  insert into public.lead_extractions (tenant_id, source, total, imported, duplicate, invalid, api_calls, tag, list_name, created_by)
  values (p_tenant_id, left('auto:' || p_ramo || ':' || p_cidade, 200), jsonb_array_length(coalesce(p_leads, '[]'::jsonb)),
          v_imported, v_duplicate, v_invalid + v_optout, coalesce(p_api_calls, 0), v_tag, v_list, p_user);
  return jsonb_build_object('total', jsonb_array_length(coalesce(p_leads, '[]'::jsonb)), 'imported', v_imported, 'duplicate', v_duplicate,
                            'invalid', v_invalid, 'optout', v_optout, 'to_dialer', v_dial, 'tag', v_tag, 'list_name', v_list);
end $$;
revoke all on function public.flowzap_import_leads(uuid, uuid, jsonb, text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.flowzap_import_leads(uuid, uuid, jsonb, text, text, text, text, int) to service_role;
