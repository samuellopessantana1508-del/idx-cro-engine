-- Disparos: não colocar de novo números que já falharam por não ter WhatsApp.
-- Antes, telefones fixos e números sem WhatsApp voltavam em todo disparo novo e falhavam de novo.
-- Agora a lista do disparo pula esses números (de qualquer disparo anterior da empresa) e informa
-- quantos foram pulados em 'sem_whatsapp'.

create or replace function public.wa_campaign_add_recipients(
  p_campaign_id uuid, p_source text, p_list_name text default null, p_contact_ids uuid[] default null,
  p_rows jsonb default null, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.wa_campaigns;
  v_before int; v_after int; v_candidates int := 0; v_optout int := 0; v_nowa int := 0;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if c.status not in ('draft', 'paused') then raise exception 'Pause o disparo antes de mudar o público'; end if;
  select count(*) into v_before from public.wa_campaign_recipients where campaign_id = c.id;

  create temporary table if not exists _wa_new (phone text, name text, vars jsonb, crm_contact_id uuid, dial_lead_id uuid) on commit drop;
  truncate _wa_new;

  if p_source = 'dial_list' then
    insert into _wa_new
    select idx_private.normalize_phone(d.phone), d.name,
           jsonb_strip_nulls(jsonb_build_object('empresa', d.name, 'cidade', d.city, 'uf', d.uf)),
           d.contact_id, d.id
      from public.crm_dial_leads d
     where d.tenant_id = c.tenant_id and d.list_name = p_list_name
       and (coalesce(p_filters->>'uf', '') = '' or d.uf = p_filters->>'uf')
       and (coalesce(p_filters->>'city', '') = '' or d.city ilike p_filters->>'city')
       and (coalesce((p_filters->>'only_pending')::boolean, false) = false or d.status = 'pending')
       and (coalesce((p_filters->>'skip_not_interested')::boolean, true) = false
            or coalesce(d.outcome, '') not in ('not_interested', 'invalid'));
  elsif p_source = 'contacts' then
    insert into _wa_new
    select idx_private.normalize_phone(coalesce(ct.whatsapp, ct.phone)), ct.name,
           jsonb_strip_nulls(jsonb_build_object('empresa', co.name, 'cidade', ct.city)), ct.id, null
      from public.crm_contacts ct left join public.crm_companies co on co.id = ct.company_id
     where ct.tenant_id = c.tenant_id and ct.id = any(coalesce(p_contact_ids, '{}')) and ct.merged_into_id is null;
  elsif p_source = 'rows' then
    insert into _wa_new
    select idx_private.normalize_phone(coalesce(x->>'telefone', x->>'phone', x->>'whatsapp')),
           nullif(trim(coalesce(x->>'nome', x->>'name', '')), ''),
           jsonb_strip_nulls(x - 'telefone' - 'phone' - 'whatsapp'), null, null
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
     limit 20000;
  else
    raise exception 'Origem inválida';
  end if;

  -- Números que já falharam por não ter WhatsApp em qualquer disparo da empresa não entram de novo.
  with gone as (
    delete from _wa_new n
     where n.phone is not null and exists (
       select 1 from public.wa_campaign_recipients r
        where r.tenant_id = c.tenant_id
          and idx_private.phone_match_key(r.phone) = idx_private.phone_match_key(n.phone)
          and (r.status = 'invalid' or (r.status = 'failed' and r.error like 'Este número não tem WhatsApp%')))
    returning 1)
  select count(*) into v_nowa from gone;

  select count(*) into v_candidates from _wa_new where phone is not null;
  select count(*) into v_optout from _wa_new n
   where n.phone is not null and exists (select 1 from public.wa_optouts o where o.tenant_id = c.tenant_id and o.phone = n.phone);

  insert into public.wa_campaign_recipients (tenant_id, campaign_id, phone, name, vars, crm_contact_id, dial_lead_id, status)
  select distinct on (n.phone) c.tenant_id, c.id, n.phone, n.name, coalesce(n.vars, '{}'::jsonb), n.crm_contact_id, n.dial_lead_id,
         case when exists (select 1 from public.wa_optouts o where o.tenant_id = c.tenant_id and o.phone = n.phone)
              then 'opted_out' else 'pending' end
    from _wa_new n where n.phone is not null
  on conflict (campaign_id, phone) do nothing;

  select count(*) into v_after from public.wa_campaign_recipients where campaign_id = c.id;
  update public.wa_campaigns
     set audience = audience || jsonb_build_object('last_source', p_source, 'list_name', p_list_name)
   where id = c.id;

  return jsonb_build_object(
    'added', v_after - v_before,
    'invalid_phone', (select count(*) from _wa_new where phone is null),
    'duplicates', v_candidates - (v_after - v_before),
    'opted_out', v_optout,
    'sem_whatsapp', v_nowa,
    'total', v_after);
end $$;
