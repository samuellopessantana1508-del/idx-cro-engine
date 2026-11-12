-- =============================================================================
-- WhatsApp: duas opções de conexão, a empresa escolhe qual usar
--   • QR Code (motor do CRO, "gateway")
--   • API oficial da Meta (WhatsApp Cloud API, "cloud_api")
-- Tudo que envia (respostas, disparos, automações, cadências) usa a conexão ATIVA.
-- As duas recebem mensagens na mesma caixa de entrada, com IA, atribuição e automações.
-- =============================================================================

-- 1) Qual conexão a empresa usa ------------------------------------------------
create table if not exists public.wa_channel_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  active_provider text not null default 'gateway' check (active_provider in ('gateway', 'cloud_api')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.wa_channel_settings enable row level security;
drop policy if exists wa_channel_settings_read on public.wa_channel_settings;
create policy wa_channel_settings_read on public.wa_channel_settings for select
  using (idx_private.crm_can(tenant_id, 'read'));

create or replace function idx_private.wa_active_provider(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select active_provider from public.wa_channel_settings where tenant_id = p_tenant), 'gateway');
$$;

-- conexão usada para enviar: a do tipo escolhido, conectada e ligada primeiro
create or replace function idx_private.wa_active_instance(p_tenant uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.whatsapp_instances
   where tenant_id = p_tenant and provider = idx_private.wa_active_provider(p_tenant)
   order by (status = 'connected' and desired_status = 'connected') desc, (desired_status = 'connected') desc,
            last_seen_at desc nulls last, created_at
   limit 1;
$$;

create or replace function public.wa_active_instance_id(p_tenant_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select idx_private.wa_active_instance(p_tenant_id);
$$;
revoke all on function public.wa_active_instance_id(uuid) from public, anon, authenticated;
grant execute on function public.wa_active_instance_id(uuid) to service_role;

-- 2) Credenciais da API oficial (criptografadas pela função; nunca vão ao navegador) ----
create table if not exists public.wa_cloud_credentials (
  instance_id uuid primary key references public.whatsapp_instances(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  access_token_enc text not null,
  app_secret_enc text,
  verify_token text not null,
  token_hint text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.wa_cloud_credentials enable row level security; -- sem políticas: só a chave de serviço lê

-- 3) Modelos de mensagem aprovados pela Meta ------------------------------------
create table if not exists public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid not null references public.whatsapp_instances(id) on delete cascade,
  name text not null,
  language text not null,
  status text not null,
  category text,
  body_text text,
  header_text text,
  param_count int not null default 0,
  components jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  unique (instance_id, name, language)
);
alter table public.wa_templates enable row level security;
drop policy if exists wa_templates_read on public.wa_templates;
create policy wa_templates_read on public.wa_templates for select using (idx_private.crm_can(tenant_id, 'read'));
create index if not exists wa_templates_tenant_idx on public.wa_templates(tenant_id, status);

alter table public.wa_outbox add column if not exists template jsonb;
alter table public.wa_campaigns add column if not exists template jsonb;

-- 4) Chamadas internas (função wa-cloud com a chave de serviço e token nulo) reaproveitam o mesmo
--    envio/recebimento do motor do QR Code: wa_gw_claim / wa_gw_result / wa_gw_ingest.
create or replace function idx_private.wa_gw_check(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- chamada interna da função wa-cloud: SEM token (nulo) e com a chave de serviço.
  -- Validações de token (cro-flows, cro-cron, maps-leads) mandam texto, então continuam exigindo o token certo.
  if p_token is null and coalesce(auth.role(), '') = 'service_role' then return; end if;
  if p_token is null or length(p_token) < 32 then raise exception 'gateway_unauthorized'; end if;
  update public.wa_gateway_tokens set last_seen_at = now()
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then raise exception 'gateway_unauthorized'; end if;
end $$;

-- recebimento: aceita as duas conexões (o QR Code continua exigindo o token do motor)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_gw_ingest(text, uuid, jsonb)'::regprocedure);
  d := replace(d, 'where id = p_instance and provider = ''gateway'';',
                  'where id = p_instance and provider in (''gateway'', ''cloud_api'');');
  d := replace(d, 'jsonb_build_object(''via'', ''gateway'')', 'jsonb_build_object(''via'', coalesce(p_msg->>''via'', ''gateway''))');
  execute d;
end $$;

-- 5) Fila de envio: inclui o modelo (template) da API oficial -------------------
create or replace function public.wa_gw_claim(p_token text, p_instance uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.wa_outbox;
  c public.wa_campaigns;
  r public.wa_campaign_recipients;
  v_tz text;
  v_hour int;
  v_body text;
  v_tpl jsonb;
  v_p text;
  v_params jsonb;
  v_tries int := 0;
begin
  perform idx_private.wa_gw_check(p_token);

  -- 1) mensagens manuais e de automações têm prioridade (são conversas em andamento)
  select * into o from public.wa_outbox
   where instance_id = p_instance and status = 'queued' and source in ('manual', 'flow')
   order by (source = 'manual') desc, created_at for update skip locked limit 1;
  if o.id is not null then
    if exists (select 1 from public.wa_optouts where tenant_id = o.tenant_id and phone = o.phone) then
      update public.wa_outbox set status = 'failed', error = 'Contato pediu SAIR' where id = o.id;
      return null;
    end if;
    update public.wa_outbox set status = 'sending', claimed_at = now(), attempts = attempts + 1 where id = o.id;
    return jsonb_build_object('id', o.id, 'phone', o.phone, 'body', o.body, 'source', o.source,
                              'media_url', o.media_url, 'media_type', o.media_type, 'file_name', o.file_name,
                              'template', o.template);
  end if;

  -- 2) campanha em andamento cujo intervalo já passou
  for c in
    select * from public.wa_campaigns
     where instance_id = p_instance and status = 'running' and coalesce(next_send_at, now()) <= now()
     order by next_send_at nulls first
     for update skip locked
  loop
    v_tz := idx_private.crm_tenant_tz(c.tenant_id);
    v_hour := extract(hour from now() at time zone v_tz)::int;

    if v_hour < c.start_hour or v_hour >= c.end_hour then
      update public.wa_campaigns set next_send_at = idx_private.wa_next_window(v_tz, c.start_hour, false) where id = c.id;
      continue;
    end if;
    if idx_private.wa_sent_today(p_instance, v_tz) >= c.daily_limit then
      update public.wa_campaigns set next_send_at = idx_private.wa_next_window(v_tz, c.start_hour, true) where id = c.id;
      continue;
    end if;

    loop
      v_tries := v_tries + 1;
      exit when v_tries > 20;
      select * into r from public.wa_campaign_recipients
       where campaign_id = c.id and status = 'pending'
       order by created_at for update skip locked limit 1;
      if r.id is null then
        if not exists (select 1 from public.wa_campaign_recipients where campaign_id = c.id and status in ('pending', 'queued')) then
          update public.wa_campaigns set status = 'completed', completed_at = now(), next_send_at = null where id = c.id;
        end if;
        exit;
      end if;
      if exists (select 1 from public.wa_optouts where tenant_id = r.tenant_id and phone = r.phone) then
        update public.wa_campaign_recipients set status = 'opted_out' where id = r.id;
        continue;
      end if;

      v_tpl := null;
      if c.template is not null then
        -- API oficial: modelo aprovado com as variáveis de cada contato
        v_params := '[]'::jsonb;
        for v_p in select jsonb_array_elements_text(coalesce(c.template->'params', '[]'::jsonb)) loop
          v_params := v_params || to_jsonb(coalesce(nullif(trim(idx_private.wa_render(v_p, r.name, r.vars)), ''), '-'));
        end loop;
        v_tpl := jsonb_build_object('name', c.template->>'name', 'language', c.template->>'language', 'params', v_params);
        v_body := coalesce(c.template->>'preview', '[modelo ' || (c.template->>'name') || ']');
        for i in 0 .. jsonb_array_length(v_params) - 1 loop
          v_body := replace(v_body, '{{' || (i + 1) || '}}', v_params->>i);
        end loop;
      else
        v_body := idx_private.wa_render(c.messages[1 + floor(random() * cardinality(c.messages))::int], r.name, r.vars);
        if coalesce(v_body, '') = '' then
          update public.wa_campaign_recipients set status = 'failed', error = 'Mensagem vazia' where id = r.id;
          continue;
        end if;
        if c.opt_out_footer then v_body := idx_private.wa_with_footer(v_body); end if;
      end if;

      insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, campaign_id, recipient_id, status, claimed_at, attempts, created_by, template)
      values (c.tenant_id, p_instance, r.phone, left(v_body, 4096), 'campaign', c.id, r.id, 'sending', now(), 1, c.started_by, v_tpl)
      returning * into o;
      update public.wa_campaign_recipients set status = 'queued', outbox_id = o.id where id = r.id;
      update public.wa_campaigns
         set next_send_at = now() + make_interval(secs => c.min_delay_sec + floor(random() * (c.max_delay_sec - c.min_delay_sec + 1))::int)
       where id = c.id;
      return jsonb_build_object('id', o.id, 'phone', o.phone, 'body', o.body, 'source', 'campaign', 'campaign_id', c.id, 'template', v_tpl);
    end loop;
  end loop;
  return null;
end $$;

-- 6) Todo envio usa a conexão ATIVA ----------------------------------------------
do $$
declare r record; d text;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and ((n.nspname = 'public' and p.proname in
            ('wa_send_message', 'wa_campaign_save', 'wa_campaign_action', 'wa_flow_set_status', 'wa_flow_start',
             'cro_health', 'mcp_call', 'wa_ai_claim'))
         or (n.nspname = 'idx_private' and p.proname = 'wa_flow_on_message'))
  loop
    d := pg_get_functiondef(r.oid);
    if r.proname = 'wa_send_message' then
      -- responde sempre pela conexão ativa
      d := replace(d, 'if not exists (select 1 from public.whatsapp_instances where id = v_instance and provider = ''gateway'') then',
                      'if not exists (select 1 from public.whatsapp_instances where id = v_instance and provider = idx_private.wa_active_provider(p_tenant_id)) then');
      d := replace(d, 'where tenant_id = p_tenant_id and provider = ''gateway''',
                      'where tenant_id = p_tenant_id and provider = idx_private.wa_active_provider(p_tenant_id)');
      d := replace(d, 'Conecte o WhatsApp em Disparos → Conexão antes de enviar', 'Conecte o WhatsApp em WhatsApp → Conexão antes de enviar');
    elsif r.proname = 'wa_campaign_save' then
      d := replace(d, 'where tenant_id = p_tenant_id and provider = ''gateway''',
                      'where tenant_id = p_tenant_id and provider = idx_private.wa_active_provider(p_tenant_id)');
    elsif r.proname = 'wa_campaign_action' then
      -- ao iniciar/retomar: sempre a conexão ativa; API oficial exige modelo aprovado
      d := replace(d, 'if c.instance_id is null then
      select id into c.instance_id from public.whatsapp_instances
       where tenant_id = c.tenant_id and provider = ''gateway''',
                      'if c.template is null and idx_private.wa_active_provider(c.tenant_id) = ''cloud_api'' then
      raise exception ''Com a API oficial do WhatsApp, o disparo precisa de um modelo aprovado pela Meta. Escolha o modelo no disparo.'';
    end if;
    if true then
      select id into c.instance_id from public.whatsapp_instances
       where tenant_id = c.tenant_id and provider = idx_private.wa_active_provider(c.tenant_id)');
    elsif r.proname in ('wa_flow_set_status', 'wa_flow_start') then
      d := replace(d, 'where tenant_id = f.tenant_id and provider = ''gateway''',
                      'where tenant_id = f.tenant_id and provider = idx_private.wa_active_provider(f.tenant_id)');
    elsif r.proname = 'cro_health' then
      d := replace(d, 'where tenant_id = p_tenant_id and provider = ''gateway'' order by',
                      'where tenant_id = p_tenant_id and provider = idx_private.wa_active_provider(p_tenant_id) order by');
    elsif r.proname = 'mcp_call' then
      d := replace(d, 'where tenant_id = tid and provider = ''gateway'' and status = ''connected''',
                      'where tenant_id = tid and provider = idx_private.wa_active_provider(tid) and status = ''connected''');
    elsif r.proname = 'wa_ai_claim' then
      d := replace(d, 'where i.provider = ''gateway''', 'where i.provider in (''gateway'', ''cloud_api'')');
    elsif r.proname = 'wa_flow_on_message' then
      d := replace(d, 'if v_provider is distinct from ''gateway'' or v_phone is null then',
                      'if v_provider is null or v_provider not in (''gateway'', ''cloud_api'') or v_phone is null then');
    end if;
    execute d;
  end loop;
end $$;

-- 7) Tela: estado das duas conexões e escolha ------------------------------------
create or replace function public.wa_channel_get(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g public.whatsapp_instances; c public.whatsapp_instances; cr public.wa_cloud_credentials;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  select * into g from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'gateway'
   order by (status = 'connected' and desired_status = 'connected') desc, (desired_status = 'connected') desc, last_seen_at desc nulls last, created_at limit 1;
  select * into c from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'cloud_api'
   order by (status = 'connected') desc, updated_at desc limit 1;
  if c.id is not null then select * into cr from public.wa_cloud_credentials where instance_id = c.id; end if;
  return jsonb_build_object(
    'active', idx_private.wa_active_provider(p_tenant_id),
    'gateway', case when g.id is null then null else jsonb_build_object('id', g.id, 'status', g.status, 'desired_status', g.desired_status, 'phone', g.phone_number) end,
    'cloud', case when c.id is null then null else jsonb_build_object(
      'id', c.id, 'status', c.status, 'phone', c.phone_number,
      'phone_number_id', c.metadata->>'phone_number_id', 'waba_id', c.metadata->>'waba_id',
      'verified_name', c.metadata->>'verified_name', 'quality', c.metadata->>'quality_rating',
      'last_error', c.metadata->>'last_error', 'checked_at', c.metadata->>'checked_at',
      'webhook_seen_at', c.metadata->>'webhook_seen_at',
      'token_hint', cr.token_hint, 'has_app_secret', cr.app_secret_enc is not null,
      -- o código de verificação do webhook só aparece para quem configura
      'verify_token', case when idx_private.crm_can(p_tenant_id, 'configure') then cr.verify_token end,
      'templates', (select count(*) from public.wa_templates t where t.instance_id = c.id and t.status = 'APPROVED')) end);
end $$;
grant execute on function public.wa_channel_get(uuid) to authenticated;

create or replace function public.wa_channel_set(p_tenant_id uuid, p_provider text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Somente gestores podem trocar a conexão do WhatsApp'; end if;
  if p_provider not in ('gateway', 'cloud_api') then raise exception 'Conexão inválida'; end if;
  if p_provider = 'cloud_api' and not exists (
    select 1 from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'cloud_api' and status = 'connected') then
    raise exception 'Configure e teste a API oficial antes de usá-la';
  end if;
  insert into public.wa_channel_settings (tenant_id, active_provider, updated_at, updated_by)
  values (p_tenant_id, p_provider, now(), auth.uid())
  on conflict (tenant_id) do update set active_provider = excluded.active_provider, updated_at = now(), updated_by = auth.uid();
  -- disparos e automações em andamento passam a usar a nova conexão
  update public.wa_campaigns set instance_id = idx_private.wa_active_instance(p_tenant_id)
   where tenant_id = p_tenant_id and status in ('running', 'paused');
  update public.wa_outbox set instance_id = idx_private.wa_active_instance(p_tenant_id)
   where tenant_id = p_tenant_id and status = 'queued';
  return public.wa_channel_get(p_tenant_id);
end $$;
grant execute on function public.wa_channel_set(uuid, text) to authenticated;

-- 8) Função wa-cloud (chave de serviço) ------------------------------------------
create or replace function public.wa_cloud_save(p_tenant_id uuid, p_phone_number_id text, p_waba_id text,
  p_token_enc text, p_token_hint text, p_secret_enc text, p_keep_secret boolean, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_verify text;
begin
  select id into v_id from public.whatsapp_instances where tenant_id = p_tenant_id and provider = 'cloud_api'
   order by (status = 'connected') desc, updated_at desc limit 1;
  if v_id is null then
    insert into public.whatsapp_instances (tenant_id, instance_name, provider, status, desired_status, metadata)
    values (p_tenant_id, 'oficial-' || substr(replace(p_tenant_id::text, '-', ''), 1, 12), 'cloud_api', 'disconnected', 'connected',
            jsonb_build_object('phone_number_id', p_phone_number_id, 'waba_id', p_waba_id))
    on conflict (tenant_id, instance_name) do update set provider = 'cloud_api'
    returning id into v_id;
  end if;
  update public.whatsapp_instances
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('phone_number_id', p_phone_number_id, 'waba_id', p_waba_id),
         status = 'disconnected', updated_at = now()
   where id = v_id;
  select verify_token into v_verify from public.wa_cloud_credentials where instance_id = v_id;
  insert into public.wa_cloud_credentials (instance_id, tenant_id, access_token_enc, app_secret_enc, verify_token, token_hint, updated_at, updated_by)
  values (v_id, p_tenant_id, p_token_enc, p_secret_enc, coalesce(v_verify, replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), p_token_hint, now(), p_user)
  on conflict (instance_id) do update
    set access_token_enc = excluded.access_token_enc,
        app_secret_enc = case when p_keep_secret then wa_cloud_credentials.app_secret_enc else excluded.app_secret_enc end,
        token_hint = excluded.token_hint, updated_at = now(), updated_by = p_user;
  return jsonb_build_object('instance_id', v_id);
end $$;

create or replace function public.wa_cloud_mark(p_instance uuid, p_ok boolean, p_phone text, p_info jsonb, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.whatsapp_instances
     set status = case when p_ok then 'connected' else 'disconnected' end,
         phone_number = coalesce(idx_private.normalize_phone(p_phone), phone_number),
         last_seen_at = case when p_ok then now() else last_seen_at end,
         metadata = (coalesce(metadata, '{}'::jsonb) - 'last_error') || coalesce(p_info, '{}'::jsonb)
                    || jsonb_build_object('checked_at', now())
                    || case when p_error is null then '{}'::jsonb else jsonb_build_object('last_error', left(p_error, 300)) end,
         updated_at = now()
   where id = p_instance and provider = 'cloud_api';
$$;

create or replace function public.wa_cloud_secret(p_instance uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('instance_id', i.id, 'tenant_id', i.tenant_id, 'status', i.status,
                            'phone_number_id', i.metadata->>'phone_number_id', 'waba_id', i.metadata->>'waba_id',
                            'access_token_enc', c.access_token_enc, 'app_secret_enc', c.app_secret_enc, 'verify_token', c.verify_token)
    from public.whatsapp_instances i join public.wa_cloud_credentials c on c.instance_id = i.id
   where i.id = p_instance and i.provider = 'cloud_api';
$$;

create or replace function public.wa_cloud_remove(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.wa_channel_settings set active_provider = 'gateway', updated_at = now() where tenant_id = p_tenant_id;
  delete from public.wa_cloud_credentials where tenant_id = p_tenant_id;
  update public.whatsapp_instances set status = 'disconnected', desired_status = 'disconnected', updated_at = now()
   where tenant_id = p_tenant_id and provider = 'cloud_api';
end $$;

-- atualização de entrega/leitura/falha enviada pela Meta
create or replace function public.wa_cloud_status(p_instance uuid, p_wa_message_id text, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare o public.wa_outbox; v_tenant uuid;
begin
  select tenant_id into v_tenant from public.whatsapp_instances where id = p_instance;
  if v_tenant is null or coalesce(p_wa_message_id, '') = '' then return; end if;
  update public.whatsapp_messages set status = p_status
   where tenant_id = v_tenant and wa_message_id = p_wa_message_id
     and p_status in ('sent', 'delivered', 'read', 'failed')
     and not (status = 'read' and p_status in ('sent', 'delivered'));
  update public.whatsapp_instances
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('webhook_seen_at', now())
   where id = p_instance;
  if p_status = 'failed' then
    select * into o from public.wa_outbox where instance_id = p_instance and wa_message_id = p_wa_message_id;
    if o.id is not null then
      update public.wa_outbox set status = 'failed', error = left(coalesce(p_error, 'A Meta não entregou a mensagem'), 300) where id = o.id;
      if o.recipient_id is not null then
        update public.wa_campaign_recipients set status = 'failed', error = left(coalesce(p_error, 'A Meta não entregou a mensagem'), 300)
         where id = o.recipient_id;
      end if;
    end if;
  end if;
end $$;

create or replace function public.wa_templates_replace(p_instance uuid, p_templates jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_n int;
begin
  select tenant_id into v_tenant from public.whatsapp_instances where id = p_instance and provider = 'cloud_api';
  if v_tenant is null then raise exception 'Conexão não encontrada'; end if;
  delete from public.wa_templates where instance_id = p_instance;
  insert into public.wa_templates (tenant_id, instance_id, name, language, status, category, body_text, header_text, param_count, components)
  select v_tenant, p_instance, t->>'name', t->>'language', t->>'status', t->>'category', t->>'body_text', t->>'header_text',
         coalesce((t->>'param_count')::int, 0), coalesce(t->'components', '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_templates, '[]'::jsonb)) t
  on conflict (instance_id, name, language) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.wa_cloud_save(uuid, text, text, text, text, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.wa_cloud_mark(uuid, boolean, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.wa_cloud_secret(uuid) from public, anon, authenticated;
revoke all on function public.wa_cloud_remove(uuid) from public, anon, authenticated;
revoke all on function public.wa_cloud_status(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_templates_replace(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.wa_cloud_save(uuid, text, text, text, text, text, boolean, uuid) to service_role;
grant execute on function public.wa_cloud_mark(uuid, boolean, text, jsonb, text) to service_role;
grant execute on function public.wa_cloud_secret(uuid) to service_role;
grant execute on function public.wa_cloud_remove(uuid) to service_role;
grant execute on function public.wa_cloud_status(uuid, text, text, text) to service_role;
grant execute on function public.wa_templates_replace(uuid, jsonb) to service_role;

-- 9) Modelos: enviar na conversa (fora da janela de 24 h) e usar em disparos ------
-- janela de atendimento: a API oficial só aceita texto livre até 24 h depois da última mensagem do cliente
create or replace function public.wa_conversation_window(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_last timestamptz;
begin
  select tenant_id into v_tenant from public.whatsapp_conversations where id = p_conversation_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'read') then raise exception 'Conversa não encontrada'; end if;
  select max("timestamp") into v_last from public.whatsapp_messages where conversation_id = p_conversation_id and direction = 'inbound';
  return jsonb_build_object('provider', idx_private.wa_active_provider(v_tenant), 'last_inbound_at', v_last,
                            'open', v_last is not null and v_last > now() - interval '24 hours');
end $$;
grant execute on function public.wa_conversation_window(uuid) to authenticated;

create or replace function idx_private.wa_template_check(p_tenant uuid, p_template jsonb)
returns public.wa_templates language plpgsql stable security definer set search_path = public as $$
declare t public.wa_templates;
begin
  select * into t from public.wa_templates
   where tenant_id = p_tenant and name = p_template->>'name' and language = p_template->>'language' and status = 'APPROVED'
     and instance_id = idx_private.wa_active_instance(p_tenant);
  if t.id is null then raise exception 'Modelo não encontrado ou não aprovado pela Meta. Atualize a lista de modelos.'; end if;
  if jsonb_array_length(coalesce(p_template->'params', '[]'::jsonb)) <> t.param_count then
    raise exception 'O modelo "%" precisa de % variável(is)', t.name, t.param_count;
  end if;
  return t;
end $$;

create or replace function public.wa_send_template(p_tenant_id uuid, p_template jsonb, p_phone text default null, p_conversation_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.wa_templates; v_phone text; v_body text; v_id uuid; v_inst uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para enviar mensagens'; end if;
  if idx_private.wa_active_provider(p_tenant_id) <> 'cloud_api' then raise exception 'Modelos são usados só com a API oficial'; end if;
  t := idx_private.wa_template_check(p_tenant_id, p_template);
  if p_conversation_id is not null then
    select coalesce(c.phone, c.wa_id) into v_phone from public.whatsapp_conversations cv join public.whatsapp_contacts c on c.id = cv.contact_id
     where cv.id = p_conversation_id and cv.tenant_id = p_tenant_id;
  else
    v_phone := p_phone;
  end if;
  v_phone := idx_private.normalize_phone(v_phone);
  if v_phone is null then raise exception 'Telefone inválido'; end if;
  if exists (select 1 from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone) then
    raise exception 'Este contato pediu para não receber mensagens (SAIR)';
  end if;
  v_inst := idx_private.wa_active_instance(p_tenant_id);
  v_body := coalesce(t.body_text, '[modelo ' || t.name || ']');
  for i in 0 .. jsonb_array_length(coalesce(p_template->'params', '[]'::jsonb)) - 1 loop
    v_body := replace(v_body, '{{' || (i + 1) || '}}', p_template->'params'->>i);
  end loop;
  insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, conversation_id, created_by, template)
  values (p_tenant_id, v_inst, v_phone, left(v_body, 4096), 'manual', p_conversation_id, auth.uid(),
          jsonb_build_object('name', t.name, 'language', t.language, 'params', coalesce(p_template->'params', '[]'::jsonb)))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.wa_send_template(uuid, jsonb, text, uuid) to authenticated;

-- modelo do disparo: params são textos com as mesmas variáveis do disparo ({nome}, {empresa}…)
create or replace function public.wa_campaign_set_template(p_campaign_id uuid, p_template jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c public.wa_campaigns; t public.wa_templates;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Disparo não encontrado'; end if;
  if c.status not in ('draft', 'paused') then raise exception 'Pause o disparo para trocar o modelo'; end if;
  if p_template is null then
    update public.wa_campaigns set template = null, updated_at = now() where id = c.id;
    return;
  end if;
  t := idx_private.wa_template_check(c.tenant_id, p_template);
  update public.wa_campaigns
     set template = jsonb_build_object('name', t.name, 'language', t.language, 'params', coalesce(p_template->'params', '[]'::jsonb),
                                       'preview', t.body_text),
         updated_at = now()
   where id = c.id;
end $$;
grant execute on function public.wa_campaign_set_template(uuid, jsonb) to authenticated;
