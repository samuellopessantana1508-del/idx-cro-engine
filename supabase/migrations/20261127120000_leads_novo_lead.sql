-- Caminhos de lead para Negociações: quem atende no discador ou responde a um disparo
-- vira negociação em "Novo lead" (1ª etapa do funil padrão), se ainda não tiver uma aberta.

-- 1ª etapa do funil padrão ("Novo lead"): etapa com status legado 'new' ou a primeira em aberto
create or replace function idx_private.crm_new_lead_stage(p_tenant_id uuid)
returns uuid
language plpgsql security definer stable set search_path = public, pg_temp
as $$
declare
  v_pipeline uuid;
  v_stage uuid;
begin
  select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = p_tenant_id;
  if v_pipeline is null or not exists (select 1 from public.crm_pipelines where id = v_pipeline and archived_at is null) then
    select id into v_pipeline from public.crm_pipelines
     where tenant_id = p_tenant_id and archived_at is null order by is_default desc, position limit 1;
  end if;
  if v_pipeline is null then return null; end if;
  v_stage := idx_private.crm_stage_for_legacy(p_tenant_id, v_pipeline, 'new');
  if v_stage is null then
    select id into v_stage from public.crm_stages
     where tenant_id = p_tenant_id and pipeline_id = v_pipeline and kind = 'open' and archived_at is null
     order by position limit 1;
  end if;
  return v_stage;
end;
$$;

-- Garante uma negociação aberta para o contato; se não houver, cria em "Novo lead"
create or replace function idx_private.crm_ensure_lead_deal(p_tenant_id uuid, p_contact_id uuid, p_title text,
                                                            p_source text, p_owner uuid default null, p_conversation uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_deal uuid;
  v_stage uuid;
  v_pipeline uuid;
  v_owner uuid;
begin
  if p_contact_id is null then return null; end if;
  select id into v_deal from public.crm_deals
   where tenant_id = p_tenant_id and contact_id = p_contact_id and status = 'open' and archived_at is null
   order by created_at desc limit 1;
  if v_deal is not null then return v_deal; end if;

  if not exists (select 1 from public.crm_pipelines where tenant_id = p_tenant_id and archived_at is null) then
    perform idx_private.crm_ensure_defaults(p_tenant_id);
  end if;
  v_stage := idx_private.crm_new_lead_stage(p_tenant_id);
  if v_stage is null then return null; end if;
  select pipeline_id into v_pipeline from public.crm_stages where id = v_stage;

  -- responsável: quem fez a ação (se for da empresa) ou o dono do contato
  v_owner := case when p_owner is not null and idx_private.is_tenant_member(p_tenant_id, p_owner) then p_owner end;
  if v_owner is null then
    select c.owner_id into v_owner from public.crm_contacts c where c.id = p_contact_id;
    if v_owner is not null and not idx_private.is_tenant_member(p_tenant_id, v_owner) then v_owner := null; end if;
  end if;

  insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id,
                               source_channel, attribution_basis, conversation_id)
  values (p_tenant_id, v_pipeline, v_stage, left(coalesce(nullif(trim(p_title), ''), 'Novo lead'), 200), p_contact_id,
          (select company_id from public.crm_contacts where id = p_contact_id), v_owner,
          p_source, 'known', p_conversation)
  returning id into v_deal;
  return v_deal;
end;
$$;

-- Resposta a disparo → contato + negociação em "Novo lead" (quem pediu SAIR não entra)
create or replace function idx_private.wa_reply_to_lead()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_contact uuid;
  v_key text := idx_private.phone_match_key(new.phone);
  v_conv uuid;
begin
  if exists (select 1 from public.wa_optouts o where o.tenant_id = new.tenant_id
              and (o.phone = new.phone or idx_private.phone_match_key(o.phone) = v_key)) then
    return new;
  end if;
  if new.crm_contact_id is not null then
    select coalesce(c.merged_into_id, c.id) into v_contact from public.crm_contacts c where c.id = new.crm_contact_id;
  end if;
  if v_contact is null then
    v_contact := idx_private.crm_contact_for_phone(new.tenant_id, new.phone, new.name, null, 'whatsapp', 'known');
    if v_contact is not null then
      update public.wa_campaign_recipients set crm_contact_id = v_contact where id = new.id;
    end if;
  end if;
  if v_contact is null then return new; end if;

  select cv.id into v_conv from public.whatsapp_conversations cv
    join public.whatsapp_contacts wc on wc.id = cv.contact_id
   where cv.tenant_id = new.tenant_id and (wc.phone = new.phone or idx_private.phone_match_key(wc.phone) = v_key)
   order by cv.last_message_at desc nulls last limit 1;

  perform idx_private.crm_ensure_lead_deal(new.tenant_id, v_contact,
    'Disparo — ' || coalesce(nullif(trim(new.name), ''), (select name from public.crm_contacts where id = v_contact), new.phone),
    'whatsapp', null, v_conv);
  return new;
exception when others then
  -- nunca derruba o recebimento da mensagem por causa do CRM
  raise warning 'wa_reply_to_lead: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists wa_reply_to_lead on public.wa_campaign_recipients;
create trigger wa_reply_to_lead
  after update of replied_at on public.wa_campaign_recipients
  for each row when (old.replied_at is null and new.replied_at is not null)
  execute function idx_private.wa_reply_to_lead();

-- Discador: atendeu (conversou, pediu retorno ou marcou reunião) → negociação em "Novo lead"
create or replace function public.crm_dial_set_outcome(p_id uuid, p_outcome text, p_notes text default null,
                                                       p_due_at timestamptz default null, p_objection text default null)
returns public.crm_dial_leads
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  r public.crm_dial_leads;
  v_prev text;
  v_company uuid;
  v_contact uuid;
  v_pipeline uuid;
  v_tz text;
  v_label text;
begin
  if p_outcome is not null and p_outcome not in ('talked', 'meeting', 'callback', 'no_answer', 'not_interested', 'invalid') then
    raise exception 'Resultado inválido';
  end if;
  select outcome into v_prev from public.crm_dial_leads where id = p_id;
  update public.crm_dial_leads
     set outcome = p_outcome, notes = coalesce(nullif(trim(p_notes), ''), notes),
         objection = coalesce(nullif(trim(p_objection), ''), objection),
         status = 'called', called_at = coalesce(called_at, now()), called_by = coalesce(called_by, auth.uid())
   where id = p_id
  returning * into r;
  if r.id is null then raise exception 'Número não encontrado ou sem permissão'; end if;

  v_label := case p_outcome when 'meeting' then 'Reunião marcada' when 'callback' then 'Pediu retorno'
    when 'talked' then 'Conversou' when 'no_answer' then 'Não atendeu' when 'not_interested' then 'Sem interesse'
    when 'invalid' then 'Número inválido' else 'Ligação' end;

  if p_outcome in ('meeting', 'callback', 'talked') and r.contact_id is null then
    select id into v_company from public.crm_companies
     where tenant_id = r.tenant_id and ((r.cnpj is not null and document = r.cnpj) or lower(name) = lower(r.name))
     limit 1;
    if v_company is null then
      insert into public.crm_companies(tenant_id, name, document, city, state, phone, segment, owner_id)
      values (r.tenant_id, r.name, r.cnpj, r.city, r.uf, r.phone, r.list_name, auth.uid())
      returning id into v_company;
    end if;
    select id into v_contact from public.crm_contacts
     where tenant_id = r.tenant_id and merged_into_id is null
       and (phone = r.phone or phone_match_key = idx_private.phone_match_key(r.phone))
     limit 1;
    if v_contact is null then
      insert into public.crm_contacts(tenant_id, name, phone, company_id, city, state, owner_id, source_channel, acquisition_basis, notes)
      values (r.tenant_id, r.name, r.phone, v_company, r.city, r.uf, auth.uid(), 'outbound', 'known', nullif(trim(p_notes), ''))
      returning id into v_contact;
    end if;
    update public.crm_dial_leads set contact_id = v_contact where id = r.id returning * into r;
  end if;

  if r.contact_id is not null then
    insert into public.crm_timeline(tenant_id, contact_id, kind, title, body, metadata, actor_id)
    values (r.tenant_id, r.contact_id, 'call_log', 'Discador: ' || v_label,
            nullif(concat_ws(E'\n', nullif(trim(p_notes), ''), 'Objeção: ' || nullif(trim(p_objection), '')), ''),
            jsonb_build_object('dial_lead_id', r.id, 'outcome', p_outcome), auth.uid());
  end if;

  if p_outcome in ('talked', 'callback', 'meeting') and r.contact_id is not null then
    perform idx_private.crm_ensure_lead_deal(r.tenant_id, r.contact_id,
      case when p_outcome = 'meeting' then 'Reunião — ' else 'Discador — ' end || r.name, 'outbound', auth.uid());
  end if;

  if p_outcome = 'meeting' then
    if v_prev is distinct from 'meeting' then
      perform idx_private.crm_log_event(r.tenant_id, auth.uid(), 'meeting_booked', 'crm_dial_leads', r.id);
    end if;
    if p_due_at is not null and r.contact_id is not null then
      perform set_config('idx.skip_meeting_event', '1', true);
      insert into public.crm_tasks(tenant_id, task_type, title, description, contact_id, deal_id, owner_id, due_at, duration_minutes, priority)
      values (r.tenant_id, 'meeting', 'Reunião: ' || r.name, nullif(trim(p_notes), ''), r.contact_id,
              (select id from public.crm_deals where contact_id = r.contact_id and status = 'open' order by created_at desc limit 1),
              auth.uid(), p_due_at, 30, 'high');
      perform set_config('idx.skip_meeting_event', '', true);
    end if;
  elsif v_prev = 'meeting' then
    delete from public.crm_activity_events where ref_id = r.id and kind = 'meeting_booked';
  end if;

  if p_outcome = 'callback' and r.contact_id is not null then
    v_tz := idx_private.crm_tenant_tz(r.tenant_id);
    insert into public.crm_tasks(tenant_id, task_type, title, description, contact_id, owner_id, due_at, priority)
    values (r.tenant_id, 'call', 'Retornar ligação: ' || r.name, nullif(trim(p_notes), ''), r.contact_id, auth.uid(),
            coalesce(p_due_at, (date_trunc('day', now() at time zone v_tz) + interval '1 day 9 hours') at time zone v_tz), 'high');
  end if;
  return r;
end;
$$;
grant execute on function public.crm_dial_set_outcome(uuid, text, text, timestamptz, text) to authenticated;

grant execute on function idx_private.crm_new_lead_stage(uuid) to authenticated, service_role;
grant execute on function idx_private.crm_ensure_lead_deal(uuid, uuid, text, text, uuid, uuid) to authenticated, service_role;
