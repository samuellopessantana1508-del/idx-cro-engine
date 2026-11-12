-- =============================================================================
-- Correções da auditoria de 12/11/2026
--  1. Atribuição: o código "Ref" que o Smart Link coloca na mensagem do WhatsApp
--     agora liga sozinho a conversa, o contato e a negociação à campanha (antes só
--     acontecia se alguém digitasse a ref ou o telefone no Atender).
--  2. Negociação duplicada (uma do WhatsApp e outra do clique) agora vira uma só.
--  3. QR do WhatsApp que ninguém lê não fica sendo gerado para sempre.
--  4. Aviso de WhatsApp parado também quando ele fica esperando QR.
--  5. Saúde do sistema mostra as automações de WhatsApp e as extrações.
-- =============================================================================

-- 1/2. Ref da mensagem → campanha ----------------------------------------------
create or replace function idx_private.wa_link_tracking_ref(p_message_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  m public.whatsapp_messages;
  c public.whatsapp_conversations;
  wc public.whatsapp_contacts;
  s public.tracking_sessions;
  cur public.tracking_sessions;
  v_ref text;
  v_phone text;
  v_contact uuid;
  v_channel text;
  v_deal uuid;
begin
  select * into m from public.whatsapp_messages where id = p_message_id;
  if m.id is null or m.direction <> 'inbound' or coalesce(m.body, '') = '' then return null; end if;
  -- formato gerado pelo /go: 4 letras/números, hífen, 4 letras/números (ex.: a7k9-p2m4)
  v_ref := (regexp_match(lower(m.body), '(?:^|[^a-z0-9])([a-z0-9]{4}-[a-z0-9]{4})(?:[^a-z0-9-]|$)'))[1];
  if v_ref is null then return null; end if;
  select * into s from public.tracking_sessions where ref = v_ref and tenant_id = m.tenant_id;
  if s.id is null then return null; end if;

  select * into c from public.whatsapp_conversations where id = m.conversation_id;
  select * into wc from public.whatsapp_contacts where id = c.contact_id;
  v_phone := idx_private.normalize_phone(coalesce(wc.phone, m.sender_phone, wc.wa_id));
  v_contact := wc.crm_contact_id;
  v_channel := idx_private.crm_channel_from_session(s);

  -- a conversa passa a apontar para o clique mais recente que trouxe esta pessoa
  if c.tracking_session_id is null then
    update public.whatsapp_conversations set tracking_session_id = s.id where id = c.id;
  elsif c.tracking_session_id <> s.id then
    select * into cur from public.tracking_sessions where id = c.tracking_session_id;
    if cur.id is null or cur.clicked_at < s.clicked_at then
      update public.whatsapp_conversations set tracking_session_id = s.id where id = c.id;
    end if;
  end if;

  if v_contact is not null then
    -- contato criado pelo WhatsApp sem origem: agora a origem é conhecida (veio do anúncio/link)
    update public.crm_contacts
       set source_channel = case when acquisition_basis = 'unknown' or source_channel in ('whatsapp') then v_channel else source_channel end,
           acquisition_basis = case when acquisition_basis = 'unknown' then 'known' else acquisition_basis end,
           utm_source = coalesce(utm_source, s.utm_source), utm_medium = coalesce(utm_medium, s.utm_medium),
           utm_campaign = coalesce(utm_campaign, s.utm_campaign), utm_content = coalesce(utm_content, s.utm_content),
           utm_term = coalesce(utm_term, s.utm_term), acquisition_campaign = coalesce(acquisition_campaign, s.utm_campaign),
           first_tracking_session_id = coalesce(first_tracking_session_id, s.id),
           acquisition_at = least(coalesce(acquisition_at, s.clicked_at), s.clicked_at)
     where id = v_contact;

    -- negociação que o WhatsApp abriu sozinho (sem origem) vira a negociação deste clique
    if not exists (select 1 from public.crm_deals where tracking_session_id = s.id) then
      select id into v_deal from public.crm_deals
       where tenant_id = m.tenant_id and contact_id = v_contact and status = 'open' and tracking_session_id is null
         and created_at > now() - interval '14 days'
       order by created_at desc limit 1;
      if v_deal is not null then
        update public.crm_deals
           set tracking_session_id = s.id, attribution_basis = 'known', source_channel = v_channel,
               utm_source = coalesce(utm_source, s.utm_source), utm_medium = coalesce(utm_medium, s.utm_medium),
               utm_campaign = coalesce(utm_campaign, s.utm_campaign), utm_content = coalesce(utm_content, s.utm_content),
               utm_term = coalesce(utm_term, s.utm_term),
               ad_ids = coalesce(ad_ids, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('fbclid', s.fbclid, 'gclid', s.gclid, 'ttclid', s.ttclid, 'ref', s.ref)),
               conversation_id = coalesce(conversation_id, c.id)
         where id = v_deal;
      end if;
    end if;
  end if;

  -- o lead do clique ganha o telefone de quem escreveu (sem sobrescrever o que já tinha)
  -- → dispara a sincronização com o CRM (contato + negociação com a campanha)
  update public.tracking_sessions
     set customer_phone = coalesce(customer_phone, v_phone),
         customer_name = coalesce(customer_name, nullif(trim(wc.push_name), '')),
         tags = case when 'entrou no whatsapp' = any(coalesce(tags, '{}')) then tags
                     else (coalesce(tags, '{}') || array['entrou no whatsapp'])[1:12] end
   where id = s.id;
  return s.id;
end $$;

create or replace function idx_private.wa_link_tracking_ref_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.direction = 'inbound' and new.body ~* '[a-z0-9]{4}-[a-z0-9]{4}' then
    perform idx_private.wa_link_tracking_ref(new.id);
  end if;
  return null;
exception when others then
  raise warning 'wa_link_tracking_ref: %', sqlerrm;   -- nunca bloqueia a mensagem
  return null;
end $$;
drop trigger if exists trg_wa_link_tracking_ref on public.whatsapp_messages;
create trigger trg_wa_link_tracking_ref after insert on public.whatsapp_messages
for each row execute function idx_private.wa_link_tracking_ref_trigger();

-- 3. QR que ninguém lê: o motor avisa "qr_expired" e a conexão para de gerar QR ---------
create or replace function public.wa_gw_instance_update(
  p_token text, p_instance uuid, p_status text, p_qr text default null, p_phone text default null, p_error text default null)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.wa_gw_check(p_token);
  if p_status = 'qr_expired' then
    update public.whatsapp_instances
       set status = 'disconnected', desired_status = 'disconnected', qr_code_data = null, last_seen_at = now(),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('last_error', 'O QR Code expirou sem ser lido. Clique em Conectar para gerar outro.', 'last_error_at', now()),
           updated_at = now()
     where id = p_instance and provider = 'gateway';
    return;
  end if;
  update public.whatsapp_instances
     set status = coalesce(p_status, status),
         qr_code_data = case when p_status = 'connected' or p_status = 'disconnected' then null else coalesce(p_qr, qr_code_data) end,
         phone_number = coalesce(p_phone, phone_number),
         last_seen_at = now(),
         desired_status = case when p_status = 'disconnected' and desired_status = 'logout' then 'disconnected' else desired_status end,
         -- o aviso de erro fica visível até a próxima tentativa (desconectar não apaga o motivo)
         metadata = case when p_error is not null then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('last_error', left(p_error, 300), 'last_error_at', now())
                         when p_status in ('connected', 'connecting') then metadata - 'last_error'
                         else metadata end,
         updated_at = case when status is distinct from coalesce(p_status, status) then now() else updated_at end
   where id = p_instance and provider = 'gateway';
  if p_status in ('banned') then
    update public.wa_campaigns set status = 'paused', paused_reason = 'WhatsApp bloqueado/desconectado'
     where instance_id = p_instance and status = 'running';
  end if;
end $$;

-- conexões antigas (Evolution) paradas há mais de 7 dias não ficam mais "pedindo conexão"
update public.whatsapp_instances set desired_status = 'disconnected'
 where provider = 'evolution' and status <> 'connected' and desired_status = 'connected' and updated_at < now() - interval '7 days';

-- 4. Avisos ---------------------------------------------------------------------
create or replace function public.cro_ops_notifications()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int := 0; k int;
begin
  -- Meta: acesso vence em até 14 dias (ou já venceu)
  insert into public.crm_notifications (tenant_id, user_id, title, body, severity, dedup_key)
  select m.tenant_id, tu.user_id,
         case when m.facebook_token_expires_at < now() then 'O acesso à Meta venceu — reconecte'
              else 'Reconecte a Meta: o acesso vence em ' || greatest(1, ceil(extract(epoch from m.facebook_token_expires_at - now()) / 86400))::int || ' dia(s)' end,
         'A Meta exige reconectar a cada ~60 dias. Vá em Integrações → Meta → Conectar com Facebook. Sem isso, gastos e conversões param de sincronizar.',
         case when m.facebook_token_expires_at < now() + interval '3 days' then 'critical' else 'warning' end,
         'meta-exp-' || m.tenant_id || '-' || to_char(m.facebook_token_expires_at, 'YYYYMMDD') || '-' ||
           case when m.facebook_token_expires_at < now() then 'x' when m.facebook_token_expires_at < now() + interval '3 days' then '3' else '14' end
    from public.tenant_meta_credentials m
    join public.tenant_users tu on tu.tenant_id = m.tenant_id and tu.status = 'active' and tu.role in ('owner', 'admin') and tu.user_id is not null
   where m.enabled and m.facebook_token_expires_at is not null and m.facebook_token_expires_at < now() + interval '14 days'
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  -- Meta / Google com erro de integração
  insert into public.crm_notifications (tenant_id, user_id, title, body, severity, dedup_key)
  select m.tenant_id, tu.user_id, 'Integração com a Meta precisa de atenção',
         'A última sincronização falhou. Abra Integrações → Meta para reconectar ou revisar a conta de anúncios.', 'warning',
         'meta-err-' || m.tenant_id || '-' || current_date
    from public.tenant_meta_credentials m
    join public.tenant_users tu on tu.tenant_id = m.tenant_id and tu.status = 'active' and tu.role in ('owner', 'admin') and tu.user_id is not null
   where m.enabled and m.integration_status = 'needs_attention'
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  insert into public.crm_notifications (tenant_id, user_id, title, body, severity, dedup_key)
  select g.tenant_id, tu.user_id, 'Integração com o Google Ads precisa de atenção',
         coalesce('Erro: ' || left(g.last_error, 160), 'A última sincronização falhou.') || ' Abra Integrações → Google Ads.', 'warning',
         'google-err-' || g.tenant_id || '-' || current_date
    from public.tenant_google_credentials g
    join public.tenant_users tu on tu.tenant_id = g.tenant_id and tu.status = 'active' and tu.role in ('owner', 'admin') and tu.user_id is not null
   where g.enabled and g.last_error is not null
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  -- WhatsApp do CRO desconectado há mais de 30 min (com disparo ou conexão pedida)
  insert into public.crm_notifications (tenant_id, user_id, title, body, severity, dedup_key)
  select i.tenant_id, tu.user_id, 'WhatsApp do CRO desconectado',
         case when exists (select 1 from public.wa_campaigns c where c.instance_id = i.id and c.status = 'running')
              then 'Há disparo em andamento parado. Reconecte em Disparos → Conexão (ler o QR Code).'
              else 'Respostas e envios estão parados. Reconecte em Disparos → Conexão (ler o QR Code).' end,
         'critical', 'wa-off-' || i.id || '-' || current_date
    from public.whatsapp_instances i
    join public.tenant_users tu on tu.tenant_id = i.tenant_id and tu.status = 'active' and tu.role in ('owner', 'admin') and tu.user_id is not null
   where i.provider = 'gateway' and i.desired_status = 'connected' and i.status in ('disconnected', 'banned', 'connecting')
     and i.updated_at < now() - interval '30 minutes'
     and i.phone_number is not null           -- já esteve conectado alguma vez
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  return jsonb_build_object('notifications', n);
end $$;

-- 5. Saúde do sistema ------------------------------------------------------------
create or replace function public.cro_health(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return jsonb_build_object(
    'motor_visto_em', (select max(last_seen_at) from public.wa_gateway_tokens),
    'rotinas', (select coalesce(jsonb_object_agg(job, jsonb_build_object('quando', last_run_at, 'ok', last_ok, 'erro', last_error, 'resultado', last_result)), '{}')
                  from public.cro_jobs),
    'whatsapp', (select jsonb_build_object('status', status, 'numero', phone_number, 'desde', updated_at)
                   from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'gateway' order by created_at limit 1),
    'meta', (select jsonb_build_object('status', integration_status, 'vence_em', facebook_token_expires_at, 'verificado_em', last_verified_at,
                                       'conta', selected_ad_account_name, 'erro', last_error is not null)
               from public.tenant_meta_credentials where tenant_id = p_tenant_id),
    'google', (select jsonb_build_object('status', integration_status, 'sincronizado_em', last_synced_at, 'conta', customer_descriptive_name,
                                         'erro', last_error is not null)
                 from public.tenant_google_credentials where tenant_id = p_tenant_id),
    'google_maps', public.maps_status(p_tenant_id),
    'automacoes_ativas', (select count(*) from public.crm_automation_rules where tenant_id = p_tenant_id and enabled),
    'automacoes_whatsapp', (select count(*) from public.wa_flows where tenant_id = p_tenant_id and status = 'active'),
    'automacoes_whatsapp_em_andamento', (select count(*) from public.wa_flow_runs where tenant_id = p_tenant_id and status in ('running', 'waiting') and not is_test),
    'automacoes_whatsapp_erros_7d', (select count(*) from public.wa_flow_runs where tenant_id = p_tenant_id and status = 'failed' and not is_test and finished_at > now() - interval '7 days'),
    'extracoes_30d', (select count(*) from public.lead_extractions where tenant_id = p_tenant_id and created_at > now() - interval '30 days'),
    'cadencias_ativas', (select count(*) from public.crm_cadences where tenant_id = p_tenant_id and active and archived_at is null),
    'buscas_automaticas', (select count(*) from public.lead_sources where tenant_id = p_tenant_id and active and auto),
    'disparos_enviando', (select count(*) from public.wa_campaigns where tenant_id = p_tenant_id and status = 'running'));
end $$;

-- 6. Qual conexão do CRO usar -----------------------------------------------------
-- Antes: "status conectado" vinha primeiro, então uma conexão antiga que ficou marcada
-- como conectada (mas que foi pausada) podia ser escolhida e a mensagem nunca saía.
-- Agora: primeiro a que está conectada E ligada, depois a que está ligada, depois a vista mais recentemente.
do $$
declare r record; d text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and n.nspname = 'public'
       and p.proname in ('wa_gateway_instance', 'wa_send_message', 'wa_flow_set_status', 'wa_groups_request')
  loop
    d := pg_get_functiondef(r.oid);
    d := replace(d, 'order by (status = ''connected'') desc, (desired_status = ''connected'') desc, created_at',
                    'order by (status = ''connected'' and desired_status = ''connected'') desc, (desired_status = ''connected'') desc, last_seen_at desc nulls last, created_at');
    d := replace(d, 'order by (status = ''connected'') desc, created_at',
                    'order by (status = ''connected'' and desired_status = ''connected'') desc, (desired_status = ''connected'') desc, last_seen_at desc nulls last, created_at');
    execute d;
  end loop;
end $$;
