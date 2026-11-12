-- =============================================================================
-- Extratores de clientes (como no FlowZap original), dentro do CRO:
--  1) Busca rápida no Google Maps (várias formas de busca × 3 páginas, até 120) —
--     reaproveita as "buscas salvas" (lead_sources) e o discador;
--  2) Colar texto: acha os telefones em qualquer texto;
--  3) Grupos do WhatsApp: lista os grupos do número conectado e importa os participantes
--     (com aviso de risco na tela). O motor do WhatsApp executa os pedidos.
-- Tudo pode entrar no CRM como contato com etiqueta (para automações e disparos)
-- e/ou na lista do discador.
-- =============================================================================

-- 1. Importar contatos com etiqueta ----------------------------------------------
create or replace function public.crm_contacts_tag_import(
  p_tenant_id uuid, p_rows jsonb, p_tag text default null, p_source text default 'import')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  x jsonb;
  v_phone text;
  v_id uuid;
  v_tag text := nullif(left(trim(coalesce(p_tag, '')), 40), '');
  v_total int := 0; v_created int := 0; v_existing int := 0; v_invalid int := 0; v_optout int := 0;
  v_seen text[] := '{}';
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para importar'; end if;
  if coalesce(jsonb_array_length(p_rows), 0) > 5000 then raise exception 'No máximo 5000 contatos por vez'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_total := v_total + 1;
    v_phone := idx_private.normalize_phone(coalesce(x->>'phone', x->>'telefone'));
    if v_phone is null or v_phone = any(v_seen) then v_invalid := v_invalid + 1; continue; end if;
    v_seen := v_seen || v_phone;
    if exists (select 1 from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone) then
      v_optout := v_optout + 1; continue;
    end if;
    select id into v_id from public.crm_contacts
     where tenant_id = p_tenant_id and merged_into_id is null
       and (phone = v_phone or phone_match_key = idx_private.phone_match_key(v_phone))
     order by (phone = v_phone) desc limit 1;
    if v_id is null then
      insert into public.crm_contacts (tenant_id, phone, name, city, source_channel, source_detail, inbound_outbound, tags, created_by)
      values (p_tenant_id, v_phone, nullif(left(trim(coalesce(x->>'name', x->>'nome', '')), 200), ''),
              nullif(left(trim(coalesce(x->>'city', x->>'cidade', '')), 120), ''),
              'outbound', left(p_source, 120), 'outbound', case when v_tag is null then '{}' else array[v_tag] end, auth.uid())
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then v_created := v_created + 1; continue; end if;
      select id into v_id from public.crm_contacts where tenant_id = p_tenant_id and phone = v_phone and merged_into_id is null limit 1;
    end if;
    v_existing := v_existing + 1;
    if v_tag is not null and v_id is not null then
      update public.crm_contacts set tags = array_append(tags, v_tag)
       where id = v_id and not (v_tag = any(tags));
    end if;
  end loop;
  return jsonb_build_object('total', v_total, 'created', v_created, 'existing', v_existing, 'invalid', v_invalid, 'optout', v_optout, 'tag', v_tag);
end $$;
grant execute on function public.crm_contacts_tag_import(uuid, jsonb, text, text) to authenticated;

-- Clientes achados por uma busca do Maps (desde um momento) viram contatos com etiqueta
create or replace function public.maps_source_to_contacts(p_source_id uuid, p_since timestamptz, p_tag text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s public.lead_sources; v_rows jsonb;
begin
  select * into s from public.lead_sources where id = p_source_id;
  if s.id is null or not idx_private.crm_can(s.tenant_id, 'write') then raise exception 'Busca não encontrada'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('phone', d.phone, 'name', d.name, 'city', d.city)), '[]'::jsonb) into v_rows
    from public.crm_dial_leads d
   where d.tenant_id = s.tenant_id and d.lead_source_id = s.id and d.created_at >= coalesce(p_since, '-infinity');
  return public.crm_contacts_tag_import(s.tenant_id, v_rows, p_tag, 'google_maps: ' || s.query);
end $$;
grant execute on function public.maps_source_to_contacts(uuid, timestamptz, text) to authenticated;

-- 2. Pedidos de grupos do WhatsApp (o motor executa) --------------------------------
create table if not exists public.wa_group_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid not null references public.whatsapp_instances(id) on delete cascade,
  kind text not null check (kind in ('list', 'members')),
  group_jid text,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  result jsonb,
  error text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists idx_wa_group_jobs_pending on public.wa_group_jobs(instance_id, created_at) where status in ('pending', 'running');
alter table public.wa_group_jobs enable row level security;
drop policy if exists wa_group_jobs_read on public.wa_group_jobs;
create policy wa_group_jobs_read on public.wa_group_jobs for select to authenticated
  using (idx_private.crm_can(tenant_id, 'write'));

create or replace function public.wa_groups_request(p_tenant_id uuid, p_kind text, p_group_jid text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_inst public.whatsapp_instances; v_id uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Só gestores podem extrair contatos de grupos'; end if;
  if p_kind not in ('list', 'members') then raise exception 'Pedido inválido'; end if;
  if p_kind = 'members' and coalesce(p_group_jid, '') !~ '@g\.us$' then raise exception 'Grupo inválido'; end if;
  select * into v_inst from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'gateway'
     order by (status = 'connected') desc, (desired_status = 'connected') desc, created_at limit 1;
  if v_inst.id is null or v_inst.status <> 'connected' then raise exception 'Conecte o WhatsApp do CRO antes (Disparos → Conexão)'; end if;
  -- no máximo um pedido em andamento por vez por número
  if exists (select 1 from public.wa_group_jobs where instance_id = v_inst.id and status in ('pending', 'running') and created_at > now() - interval '2 minutes') then
    raise exception 'Já existe um pedido em andamento — aguarde alguns segundos';
  end if;
  insert into public.wa_group_jobs (tenant_id, instance_id, kind, group_jid, requested_by)
  values (p_tenant_id, v_inst.id, p_kind, p_group_jid, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.wa_groups_request(uuid, text, text) to authenticated;

-- motor: pega pedidos pendentes desta conexão
create or replace function public.wa_gw_group_jobs(p_token text, p_instance uuid)
returns setof public.wa_group_jobs
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.wa_gw_check(p_token);
  -- pedidos velhos que ninguém pegou expiram
  update public.wa_group_jobs set status = 'error', error = 'O WhatsApp não respondeu a tempo', finished_at = now()
   where instance_id = p_instance and status in ('pending', 'running') and created_at < now() - interval '3 minutes';
  return query
    update public.wa_group_jobs j set status = 'running', started_at = now()
     where j.id in (select id from public.wa_group_jobs where instance_id = p_instance and status = 'pending' order by created_at limit 3 for update skip locked)
    returning j.*;
end $$;

create or replace function public.wa_gw_group_result(p_token text, p_job uuid, p_ok boolean, p_result jsonb default null, p_error text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.wa_gw_check(p_token);
  update public.wa_group_jobs
     set status = case when p_ok then 'done' else 'error' end, result = case when p_ok then p_result end,
         error = case when p_ok then null else left(coalesce(p_error, 'Falha'), 300) end, finished_at = now()
   where id = p_job and status = 'running';
end $$;
revoke all on function public.wa_gw_group_jobs(text, uuid) from public;
revoke all on function public.wa_gw_group_result(text, uuid, boolean, jsonb, text) from public;
grant execute on function public.wa_gw_group_jobs(text, uuid) to anon, service_role;
grant execute on function public.wa_gw_group_result(text, uuid, boolean, jsonb, text) to anon, service_role;
