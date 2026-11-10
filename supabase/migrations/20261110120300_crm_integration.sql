-- ============================================================================
-- CRM IDX — Integração com o IDX existente
-- ----------------------------------------------------------------------------
-- Um único cadastro: o contato do CRM é a mesma pessoa do WhatsApp e do lead
-- do Smart Link (tracking_sessions). Nada é duplicado:
--   whatsapp_contacts.crm_contact_id  → crm_contacts
--   crm_deals.tracking_session_id     → tracking_sessions (1 lead legado = 1 negociação)
--   crm_deals.conversation_id         → whatsapp_conversations
--   crm_orders(source='legacy_tracking') ← venda confirmada no fluxo /crm ou /convert
-- O fluxo legado (Atender, CAPI por etapa, Purchase) continua igual. O CRM
-- apenas acompanha. Purchase CAPI continua sendo enviado SOMENTE pelos fluxos
-- já auditados (functions/crm, convert, sale-confirm), com event_id determinístico.
-- ============================================================================

alter table public.whatsapp_contacts add column if not exists crm_contact_id uuid references public.crm_contacts(id) on delete set null;
create index if not exists idx_wa_contacts_crm_contact on public.whatsapp_contacts(crm_contact_id) where crm_contact_id is not null;

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------
-- Canal de aquisição a partir de evidências do clique (nunca inventa)
create or replace function idx_private.crm_channel_from_session(s public.tracking_sessions)
returns text language sql immutable set search_path = pg_temp
as $$
  select case
    when s.fbclid is not null or lower(coalesce(s.utm_source, '')) in ('facebook', 'fb', 'instagram', 'ig', 'meta', 'meta_ads', 'facebook_ads', 'an', 'msg') then 'meta_ads'
    when s.gclid is not null or lower(coalesce(s.utm_source, '')) in ('google', 'google_ads', 'adwords', 'youtube') then 'google_ads'
    when s.ttclid is not null or lower(coalesce(s.utm_source, '')) in ('tiktok', 'tiktok_ads') then 'tiktok_ads'
    when s.utm_source is not null then lower(s.utm_source)
    else 'smart_link' end;
$$;

-- Encontra ou cria o contato por telefone (sem mesclar pessoas por suposição)
create or replace function idx_private.crm_contact_for_phone(
  p_tenant_id uuid, p_phone text, p_name text default null, p_email text default null,
  p_source_channel text default null, p_basis text default 'unknown', p_session uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := idx_private.normalize_phone(p_phone);
  v_key text;
  v_id uuid;
  v_candidates int;
  s public.tracking_sessions;
begin
  if v_phone is null then return null; end if;
  select id into v_id from public.crm_contacts
  where tenant_id = p_tenant_id and phone = v_phone and merged_into_id is null limit 1;
  if v_id is not null then return v_id; end if;

  v_key := idx_private.phone_match_key(v_phone);
  select count(*), min(id::text)::uuid into v_candidates, v_id from public.crm_contacts
  where tenant_id = p_tenant_id and phone_match_key = v_key and merged_into_id is null;
  if v_candidates = 1 then return v_id; end if;   -- equivalente único (9º dígito)
  v_id := null;

  if p_session is not null then
    select * into s from public.tracking_sessions where id = p_session;
  end if;

  insert into public.crm_contacts(tenant_id, phone, name, email, source_channel, acquisition_basis, acquisition_at,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, acquisition_campaign, ad_ids, first_tracking_session_id, inbound_outbound)
  values (p_tenant_id, v_phone, nullif(trim(p_name), ''),
          case when p_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then p_email end,
          p_source_channel, coalesce(p_basis, 'unknown'),
          coalesce(s.clicked_at, now()),
          s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.utm_campaign,
          jsonb_strip_nulls(jsonb_build_object('fbclid', s.fbclid, 'gclid', s.gclid, 'ttclid', s.ttclid)),
          p_session, 'inbound')
  on conflict (tenant_id, phone) where phone is not null and merged_into_id is null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.crm_contacts where tenant_id = p_tenant_id and phone = v_phone and merged_into_id is null limit 1;
  end if;
  return v_id;
end;
$$;

create or replace function idx_private.crm_stage_for_legacy(p_tenant_id uuid, p_pipeline uuid, p_status text)
returns uuid language sql security definer stable set search_path = public, pg_temp
as $$
  select id from public.crm_stages
  where tenant_id = p_tenant_id and pipeline_id = p_pipeline and legacy_status = p_status and archived_at is null
  order by position limit 1;
$$;

-- Pedido espelho da venda confirmada no fluxo legado
create or replace function idx_private.crm_sync_legacy_order(s public.tracking_sessions, p_deal uuid, p_contact uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ai_unreviewed boolean;
begin
  if s.lead_status = 'sold' and coalesce(s.revenue, 0) > 0 then
    -- Venda confirmada automaticamente pela IA (sem revisão humana) fica pendente:
    -- intenção/confiança da IA não é comprovação de pagamento.
    select exists (select 1 from public.sale_signals ss
                   where ss.tracking_session_id = s.id and ss.auto_confirmed and ss.status in ('confirmed', 'converted'))
           and not exists (select 1 from public.sale_signals ss
                   where ss.tracking_session_id = s.id and not ss.auto_confirmed and ss.confirmed_by is not null)
      into ai_unreviewed;
    insert into public.crm_orders(tenant_id, contact_id, deal_id, order_date, status, gross_amount, evidence_type, evidence_note,
                                  source, source_ref, tracking_session_id, notes)
    values (s.tenant_id, p_contact, p_deal, coalesce(s.sold_at, now()),
            case when ai_unreviewed then 'pending' else 'confirmed' end,
            s.revenue,
            case when ai_unreviewed then 'ai_auto_unreviewed' else 'legacy_confirmation' end,
            case when ai_unreviewed then 'Venda marcada automaticamente pela IA. Confirme a evidência antes de contar como receita.'
                 else 'Venda confirmada pelo atendente no IDX (lead ' || s.ref || ').' end,
            'legacy_tracking', s.id::text, s.id, s.sale_notes)
    on conflict (tenant_id, source, source_ref) where source_ref is not null do update
      set gross_amount = excluded.gross_amount,
          order_date = excluded.order_date,
          contact_id = coalesce(public.crm_orders.contact_id, excluded.contact_id),
          deal_id = coalesce(public.crm_orders.deal_id, excluded.deal_id),
          status = case when public.crm_orders.status = 'cancelled' then excluded.status else public.crm_orders.status end,
          cancelled_at = case when public.crm_orders.status = 'cancelled' then null else public.crm_orders.cancelled_at end
      where public.crm_orders.gross_amount is distinct from excluded.gross_amount
         or public.crm_orders.status = 'cancelled'
         or public.crm_orders.contact_id is null or public.crm_orders.deal_id is null;
  else
    -- venda desfeita no fluxo legado: cancela o espelho (não apaga histórico)
    update public.crm_orders set status = 'cancelled', cancel_reason = 'Classificação do lead alterada de "Venda" para "' || s.lead_status || '" no IDX.'
    where tenant_id = s.tenant_id and source = 'legacy_tracking' and source_ref = s.id::text and status <> 'cancelled';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. tracking_sessions → contato + negociação + pedido
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_sync_tracking_session(p_session_id uuid, p_force_deal boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.tracking_sessions;
  cfg public.crm_settings;
  v_pipeline uuid;
  v_contact uuid;
  v_deal uuid;
  d record;
  v_target uuid;
  tgt record;
  cur record;
  v_offer record;
  v_channel text;
  v_conv uuid;
begin
  select * into s from public.tracking_sessions where id = p_session_id;
  if not found then return null; end if;
  select * into cfg from public.crm_settings where tenant_id = s.tenant_id;
  if not found then
    perform idx_private.crm_ensure_defaults(s.tenant_id);
    select * into cfg from public.crm_settings where tenant_id = s.tenant_id;
  end if;
  v_channel := idx_private.crm_channel_from_session(s);

  if s.customer_phone is not null then
    v_contact := idx_private.crm_contact_for_phone(s.tenant_id, s.customer_phone, s.customer_name, s.customer_email, v_channel, 'known', s.id);
    if v_contact is not null then
      update public.crm_contacts set
        name = coalesce(name, nullif(trim(s.customer_name), '')),
        email = coalesce(email, case when s.customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(s.customer_email) end),
        source_channel = coalesce(source_channel, v_channel),
        acquisition_basis = case when acquisition_basis = 'unknown' then 'known' else acquisition_basis end,
        utm_source = coalesce(utm_source, s.utm_source), utm_medium = coalesce(utm_medium, s.utm_medium),
        utm_campaign = coalesce(utm_campaign, s.utm_campaign), utm_content = coalesce(utm_content, s.utm_content),
        utm_term = coalesce(utm_term, s.utm_term), acquisition_campaign = coalesce(acquisition_campaign, s.utm_campaign),
        first_tracking_session_id = coalesce(first_tracking_session_id, s.id),
        acquisition_at = least(coalesce(acquisition_at, s.clicked_at), s.clicked_at)
      where id = v_contact
        and (name is null or email is null or source_channel is null or acquisition_basis = 'unknown'
             or first_tracking_session_id is null or utm_campaign is null);
    end if;
  end if;

  select * into d from public.crm_deals where tracking_session_id = s.id;
  if not found then
    if not (cfg.auto_deal_from_clicks or p_force_deal) then return null; end if;
    v_pipeline := coalesce(cfg.default_pipeline_id, idx_private.crm_ensure_defaults(s.tenant_id));
    v_target := coalesce(idx_private.crm_stage_for_legacy(s.tenant_id, v_pipeline, s.lead_status),
                         idx_private.crm_stage_for_legacy(s.tenant_id, v_pipeline, 'new'),
                         (select id from public.crm_stages where pipeline_id = v_pipeline and archived_at is null order by position limit 1));
    select o.name, o.price into v_offer from public.offers o where o.id = s.offer_id;
    select wc.id into v_conv from public.whatsapp_conversations wc where wc.tracking_session_id = s.id order by wc.last_message_at desc nulls last limit 1;
    insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, value, source_channel, attribution_basis,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, ad_ids, tracking_session_id, conversation_id, tags, created_at,
      loss_reason_id)
    values (s.tenant_id, v_pipeline, v_target,
            coalesce(nullif(trim(s.customer_name), ''), v_offer.name, 'Lead') || ' · ' || s.ref,
            v_contact,
            case when s.lead_status = 'sold' and s.revenue > 0 then s.revenue else coalesce(v_offer.price, 0) end,
            v_channel, 'known', s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term,
            jsonb_strip_nulls(jsonb_build_object('fbclid', s.fbclid, 'gclid', s.gclid, 'ttclid', s.ttclid, 'ref', s.ref)),
            s.id, v_conv, coalesce(s.tags, '{}'), s.clicked_at,
            case when s.lead_status = 'bad' then (select id from public.crm_loss_reasons where tenant_id = s.tenant_id and name = 'Lead ruim (classificação legada)') end)
    on conflict (tracking_session_id) where tracking_session_id is not null do nothing
    returning id into v_deal;
    if v_deal is null then select id into v_deal from public.crm_deals where tracking_session_id = s.id; end if;
  else
    v_deal := d.id;
    if d.contact_id is null and v_contact is not null then
      update public.crm_deals set contact_id = v_contact where id = d.id;
    end if;
    -- acompanha a classificação legada sem voltar etapas abertas mais avançadas
    v_target := idx_private.crm_stage_for_legacy(s.tenant_id, d.pipeline_id, s.lead_status);
    if v_target is not null and v_target <> d.stage_id then
      select kind, position into tgt from public.crm_stages where id = v_target;
      select kind, position, legacy_status into cur from public.crm_stages where id = d.stage_id;
      if tgt.kind <> 'open' or cur.kind <> 'open' or tgt.position > cur.position then
        update public.crm_deals set stage_id = v_target,
          value = case when s.lead_status = 'sold' and s.revenue > 0 then s.revenue else value end
        where id = d.id;
      end if;
    elsif s.lead_status = 'sold' and s.revenue > 0 and d.value is distinct from s.revenue then
      update public.crm_deals set value = s.revenue where id = d.id;
    end if;
  end if;

  perform idx_private.crm_sync_legacy_order(s, v_deal, v_contact);
  return v_deal;
end;
$$;

create or replace function idx_private.crm_tracking_session_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT'
     or new.lead_status is distinct from old.lead_status
     or new.customer_phone is distinct from old.customer_phone
     or new.customer_name is distinct from old.customer_name
     or new.customer_email is distinct from old.customer_email
     or new.revenue is distinct from old.revenue then
    begin
      perform idx_private.crm_sync_tracking_session(new.id);
    exception when others then
      -- o fluxo de clique/CAPI nunca pode falhar por causa do CRM
      raise warning 'crm_sync_tracking_session falhou para %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_tracking_sessions_crm_sync on public.tracking_sessions;
create trigger trg_tracking_sessions_crm_sync
after insert or update of lead_status, customer_phone, customer_name, customer_email, revenue on public.tracking_sessions
for each row execute function idx_private.crm_tracking_session_trigger();

-- ---------------------------------------------------------------------------
-- 3. WhatsApp → contato / negociação
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_whatsapp_contact_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.crm_contact_id is null then
    begin
      new.crm_contact_id := idx_private.crm_contact_for_phone(new.tenant_id, coalesce(new.phone, new.wa_id), new.push_name, null, 'whatsapp', 'unknown', null);
    exception when others then
      raise warning 'crm_whatsapp_contact_trigger: %', sqlerrm;
    end;
  end if;
  if new.crm_contact_id is not null and new.push_name is not null then
    update public.crm_contacts set name = new.push_name where id = new.crm_contact_id and name is null;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_whatsapp_contacts_crm on public.whatsapp_contacts;
create trigger trg_whatsapp_contacts_crm
before insert or update of phone, push_name, crm_contact_id on public.whatsapp_contacts
for each row execute function idx_private.crm_whatsapp_contact_trigger();

create or replace function idx_private.crm_whatsapp_conversation_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_contact uuid;
  v_name text;
  cfg public.crm_settings;
  v_pipeline uuid;
begin
  select wc.crm_contact_id, coalesce(wc.push_name, wc.phone) into v_contact, v_name
  from public.whatsapp_contacts wc where wc.id = new.contact_id;

  if new.tracking_session_id is not null and (tg_op = 'INSERT' or new.tracking_session_id is distinct from old.tracking_session_id) then
    update public.crm_deals set conversation_id = coalesce(conversation_id, new.id), contact_id = coalesce(contact_id, v_contact)
    where tracking_session_id = new.tracking_session_id;
  end if;

  if tg_op = 'INSERT' and new.tracking_session_id is null and v_contact is not null then
    select * into cfg from public.crm_settings where tenant_id = new.tenant_id;
    if coalesce(cfg.auto_deal_from_whatsapp, false)
       and not exists (select 1 from public.crm_deals d where d.contact_id = v_contact and d.status = 'open') then
      v_pipeline := coalesce(cfg.default_pipeline_id, idx_private.crm_ensure_defaults(new.tenant_id));
      insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, source_channel, attribution_basis, conversation_id)
      values (new.tenant_id, v_pipeline, idx_private.crm_stage_for_legacy(new.tenant_id, v_pipeline, 'new'),
              'WhatsApp · ' || coalesce(v_name, 'novo contato'), v_contact, 'whatsapp', 'unknown', new.id);
    end if;
  end if;
  return null;
exception when others then
  raise warning 'crm_whatsapp_conversation_trigger: %', sqlerrm;
  return null;
end;
$$;
drop trigger if exists trg_whatsapp_conversations_crm on public.whatsapp_conversations;
create trigger trg_whatsapp_conversations_crm
after insert or update of tracking_session_id on public.whatsapp_conversations
for each row execute function idx_private.crm_whatsapp_conversation_trigger();

create or replace function idx_private.crm_whatsapp_message_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_contact uuid;
begin
  select wc.crm_contact_id into v_contact
  from public.whatsapp_conversations c join public.whatsapp_contacts wc on wc.id = c.contact_id
  where c.id = new.conversation_id;
  if v_contact is not null then
    update public.crm_contacts set last_interaction_at = new."timestamp"
    where id = v_contact and (last_interaction_at is null or last_interaction_at < new."timestamp");
    if new.direction = 'outbound' then
      update public.crm_deals set last_activity_at = new."timestamp"
      where contact_id = v_contact and status = 'open' and (last_activity_at is null or last_activity_at < new."timestamp");
    end if;
  end if;
  return null;
exception when others then
  raise warning 'crm_whatsapp_message_trigger: %', sqlerrm;
  return null;
end;
$$;
drop trigger if exists trg_whatsapp_messages_crm on public.whatsapp_messages;
create trigger trg_whatsapp_messages_crm after insert on public.whatsapp_messages
for each row execute function idx_private.crm_whatsapp_message_trigger();

-- Criar negociação a partir de uma conversa (1 clique no painel)
create or replace function public.crm_create_deal_from_conversation(p_conversation_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c record;
  v_pipeline uuid;
  v_deal uuid;
begin
  select conv.id, conv.tenant_id, conv.tracking_session_id, wc.crm_contact_id, coalesce(wc.push_name, wc.phone) as name
    into c
  from public.whatsapp_conversations conv join public.whatsapp_contacts wc on wc.id = conv.contact_id
  where conv.id = p_conversation_id;
  if not found then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if c.tracking_session_id is not null then
    select id into v_deal from public.crm_deals where tracking_session_id = c.tracking_session_id;
    if v_deal is not null then return v_deal; end if;
  end if;
  select id into v_deal from public.crm_deals where conversation_id = c.id and status = 'open' limit 1;
  if v_deal is not null then return v_deal; end if;
  select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = c.tenant_id;
  insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, source_channel, attribution_basis, conversation_id, owner_id)
  values (c.tenant_id, v_pipeline, idx_private.crm_stage_for_legacy(c.tenant_id, v_pipeline, 'new'),
          'WhatsApp · ' || coalesce(c.name, 'contato'), c.crm_contact_id, 'whatsapp', 'unknown', c.id, auth.uid())
  returning id into v_deal;
  return v_deal;
end;
$$;
grant execute on function public.crm_create_deal_from_conversation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Correção de permissão: sale_signals / conversation_insights
--    Antes: qualquer membro (inclusive "viewer") podia INSERT/UPDATE direto.
--    Agora: leitura para membros; escrita só owner/admin/operator.
--    As Edge Functions usam service_role e não são afetadas.
-- ---------------------------------------------------------------------------
drop policy if exists "ci_tenant_isolation" on public.conversation_insights;
drop policy if exists ci_select_member on public.conversation_insights;
drop policy if exists ci_write_operator on public.conversation_insights;
create policy ci_select_member on public.conversation_insights for select to authenticated
  using (idx_private.has_tenant_role(tenant_id));
create policy ci_write_operator on public.conversation_insights for update to authenticated
  using (idx_private.has_tenant_role(tenant_id, array['owner', 'admin', 'operator']))
  with check (idx_private.has_tenant_role(tenant_id, array['owner', 'admin', 'operator']));

drop policy if exists "ss_tenant_isolation" on public.sale_signals;
drop policy if exists ss_select_member on public.sale_signals;
drop policy if exists ss_write_operator on public.sale_signals;
create policy ss_select_member on public.sale_signals for select to authenticated
  using (idx_private.has_tenant_role(tenant_id));
create policy ss_write_operator on public.sale_signals for update to authenticated
  using (idx_private.has_tenant_role(tenant_id, array['owner', 'admin', 'operator']))
  with check (idx_private.has_tenant_role(tenant_id, array['owner', 'admin', 'operator']));
revoke insert on public.conversation_insights, public.sale_signals from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill (idempotente)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  -- contatos do WhatsApp
  update public.whatsapp_contacts set crm_contact_id = null where crm_contact_id is null; -- dispara o trigger

  -- leads legados que já tiveram tratamento, contato, conversa ou são recentes (90 dias).
  -- Cliques antigos sem nenhuma interação continuam na fila legada "Atendimentos".
  for r in
    select ts.id from public.tracking_sessions ts
    where ts.lead_status <> 'new'
       or ts.customer_phone is not null
       or ts.clicked_at > now() - interval '90 days'
       or exists (select 1 from public.whatsapp_conversations wc where wc.tracking_session_id = ts.id)
    order by ts.clicked_at
  loop
    perform idx_private.crm_sync_tracking_session(r.id, true);
  end loop;

  -- conversas já vinculadas a leads
  update public.crm_deals d set conversation_id = wc.id
  from public.whatsapp_conversations wc
  where wc.tracking_session_id = d.tracking_session_id and d.conversation_id is null;
end $$;

-- RFV inicial
do $$
declare r record;
begin
  for r in select id from public.tenants loop
    perform public.crm_compute_rfv(r.id);
  end loop;
end $$;
