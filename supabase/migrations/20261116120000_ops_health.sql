-- =============================================================================
-- Rotinas automáticas sempre ligadas + saúde do sistema
-- -----------------------------------------------------------------------------
-- Antes: as automações agendadas do CRM (negociação parada, tarefa atrasada, RFV)
-- só rodavam quando alguém abria o CRM (não há pg_cron no projeto). Agora o motor
-- do WhatsApp (sempre ligado na VPS) chama a função cro-cron de hora em hora.
-- * cro_jobs: última execução de cada rotina (para a tela "Saúde do sistema").
-- * cro_ops_notifications(): avisos para donos/admins — acesso da Meta perto de
--   vencer ou com erro, Google Ads com erro, WhatsApp do CRO desconectado.
-- Não destrutiva.
-- =============================================================================

create table if not exists public.cro_jobs (
  job text primary key,
  last_run_at timestamptz,
  last_ok boolean,
  last_result jsonb,
  last_error text,
  runs integer not null default 0
);
alter table public.cro_jobs enable row level security;   -- leitura só pela função abaixo

create or replace function public.cro_job_done(p_job text, p_ok boolean, p_result jsonb default null, p_error text default null)
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into public.cro_jobs (job, last_run_at, last_ok, last_result, last_error, runs)
  values (p_job, now(), p_ok, p_result, left(p_error, 500), 1)
  on conflict (job) do update set last_run_at = now(), last_ok = excluded.last_ok, last_result = excluded.last_result,
                                  last_error = excluded.last_error, runs = public.cro_jobs.runs + 1;
$$;

-- Avisos operacionais (deduplicados por dia/vencimento)
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
   where i.provider = 'gateway' and i.desired_status = 'connected' and i.status in ('disconnected', 'banned')
     and i.updated_at < now() - interval '30 minutes'
     and i.phone_number is not null           -- já esteve conectado alguma vez
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  return jsonb_build_object('notifications', n);
end $$;

-- Saúde do sistema (tela): rotinas, motor e integrações da empresa
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
    'cadencias_ativas', (select count(*) from public.crm_cadences where tenant_id = p_tenant_id and active and archived_at is null),
    'buscas_automaticas', (select count(*) from public.lead_sources where tenant_id = p_tenant_id and active and auto),
    'disparos_enviando', (select count(*) from public.wa_campaigns where tenant_id = p_tenant_id and status = 'running'));
end $$;

revoke all on function public.cro_job_done(text, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.cro_ops_notifications() from public, anon, authenticated;
grant execute on function public.cro_job_done(text, boolean, jsonb, text) to service_role;
grant execute on function public.cro_ops_notifications() to service_role;
grant execute on function public.cro_health(uuid) to authenticated;
