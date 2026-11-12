-- =============================================================================
-- Disparos (FlowZap dentro do CRO) + motor único de WhatsApp (gateway)
-- -----------------------------------------------------------------------------
-- * Um único "motor" de WhatsApp (services/wa-gateway, baseado no Baileys do
--   FlowZap) mantém a conexão por QR e grava tudo nas MESMAS tabelas que o CRO já
--   usa (whatsapp_contacts / conversations / messages). Assim a Caixa de entrada,
--   o CRM, as cadências (param quando o cliente responde) e os Disparos enxergam
--   a mesma conversa — sem duas conexões brigando pelo mesmo número.
-- * Fila única de envio (wa_outbox): respostas manuais da caixa de entrada e
--   mensagens de campanha. Nada sai sem uma ação de uma pessoa (clicar em enviar
--   ou em "Iniciar disparo").
-- * Proteções anti-banimento aplicadas no banco (não dá para pular pela tela):
--   intervalo aleatório (mín. 15 s, padrão 25–60 s), limite diário por número
--   (padrão 200, máx. 500), janela de horário (padrão 8h–20h no fuso da empresa),
--   rodapé "responda SAIR" e lista de descadastro respeitada sempre.
-- * O motor não usa service role: chama apenas funções wa_gw_* que exigem um
--   token cujo hash fica em wa_gateway_tokens (o token só existe na VPS).
-- Não destrutiva: só cria tabelas/funções e amplia o check de provider.
-- =============================================================================

-- 1. Conexões: novo provider "gateway" -----------------------------------------
alter table public.whatsapp_instances drop constraint if exists whatsapp_instances_provider_check;
alter table public.whatsapp_instances add constraint whatsapp_instances_provider_check
  check (provider in ('evolution', 'cloud_api', 'gateway'));
alter table public.whatsapp_instances add column if not exists desired_status text not null default 'connected';
alter table public.whatsapp_instances drop constraint if exists whatsapp_instances_desired_status_check;
alter table public.whatsapp_instances add constraint whatsapp_instances_desired_status_check
  check (desired_status in ('connected', 'disconnected', 'logout'));

-- 2. Tabelas -----------------------------------------------------------------
create table if not exists public.wa_gateway_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,          -- sha256 hex do token (o token fica só na VPS)
  label text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wa_optouts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone text not null,
  source text not null default 'keyword' check (source in ('keyword', 'manual')),
  body text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

create table if not exists public.wa_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid references public.whatsapp_instances(id) on delete set null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed', 'canceled')),
  messages text[] not null default '{}',     -- 1 a 5 variações; uma é sorteada por contato
  audience jsonb not null default '{}'::jsonb,
  min_delay_sec integer not null default 25 check (min_delay_sec >= 15),
  max_delay_sec integer not null default 60 check (max_delay_sec >= 15),
  daily_limit integer not null default 200 check (daily_limit between 1 and 500),
  start_hour integer not null default 8 check (start_hour between 0 and 23),
  end_hour integer not null default 20 check (end_hour between 1 and 24),
  opt_out_footer boolean not null default true,
  next_send_at timestamptz,
  paused_reason text,
  created_by uuid references auth.users(id) on delete set null,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wa_campaigns_delay_order check (max_delay_sec >= min_delay_sec),
  constraint wa_campaigns_window check (end_hour > start_hour)
);
create index if not exists idx_wa_campaigns_tenant on public.wa_campaigns(tenant_id, created_at desc);
create index if not exists idx_wa_campaigns_running on public.wa_campaigns(instance_id, next_send_at) where status = 'running';

create table if not exists public.wa_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.wa_campaigns(id) on delete cascade,
  phone text not null,
  name text,
  vars jsonb not null default '{}'::jsonb,
  crm_contact_id uuid references public.crm_contacts(id) on delete set null,
  dial_lead_id uuid references public.crm_dial_leads(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'failed', 'invalid', 'opted_out', 'skipped')),
  outbox_id uuid,
  wa_message_id text,
  error text,
  sent_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, phone)
);
create index if not exists idx_wa_recipients_queue on public.wa_campaign_recipients(campaign_id, status, created_at);
create index if not exists idx_wa_recipients_phone on public.wa_campaign_recipients(tenant_id, phone, sent_at desc) where sent_at is not null;

create table if not exists public.wa_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid references public.whatsapp_instances(id) on delete set null,
  phone text not null,
  body text not null check (length(body) between 1 and 4096),
  source text not null check (source in ('manual', 'campaign')),
  campaign_id uuid references public.wa_campaigns(id) on delete set null,
  recipient_id uuid references public.wa_campaign_recipients(id) on delete set null,
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'canceled')),
  attempts integer not null default 0,
  wa_message_id text,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_outbox_queue on public.wa_outbox(instance_id, status, created_at) where status in ('queued', 'sending');
create index if not exists idx_wa_outbox_daily on public.wa_outbox(instance_id, source, sent_at) where status = 'sent';
create index if not exists idx_wa_outbox_tenant on public.wa_outbox(tenant_id, created_at desc);

drop trigger if exists trg_wa_campaigns_updated on public.wa_campaigns;
create trigger trg_wa_campaigns_updated before update on public.wa_campaigns
for each row execute function idx_private.touch_updated_at();

-- 3. RLS: leitura para quem acessa o CRM da empresa; escrita só via funções ----
alter table public.wa_gateway_tokens enable row level security;   -- ninguém lê pela API
alter table public.wa_optouts enable row level security;
alter table public.wa_campaigns enable row level security;
alter table public.wa_campaign_recipients enable row level security;
alter table public.wa_outbox enable row level security;

drop policy if exists wa_optouts_read on public.wa_optouts;
create policy wa_optouts_read on public.wa_optouts for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists wa_campaigns_read on public.wa_campaigns;
create policy wa_campaigns_read on public.wa_campaigns for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists wa_recipients_read on public.wa_campaign_recipients;
create policy wa_recipients_read on public.wa_campaign_recipients for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists wa_outbox_read on public.wa_outbox;
create policy wa_outbox_read on public.wa_outbox for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

-- Realtime para a tela acompanhar o progresso
do $$ begin
  begin alter publication supabase_realtime add table public.wa_campaigns; exception when others then null; end;
  begin alter publication supabase_realtime add table public.wa_outbox; exception when others then null; end;
end $$;

-- 4. Utilitários -------------------------------------------------------------
create or replace function idx_private.wa_is_optout_keyword(p_body text)
returns boolean language sql immutable set search_path = pg_temp
as $$
  select lower(trim(both ' .!' from coalesce(p_body, ''))) in
    ('sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover', 'nao quero', 'não quero', 'pare');
$$;

-- Escolhe aleatoriamente opções no formato {Olá|Oi|Bom dia}; mantém {nome} etc.
create or replace function idx_private.wa_spin(p_text text)
returns text language plpgsql volatile set search_path = pg_temp
as $$
declare
  t text := coalesce(p_text, '');
  m text[];
  opts text[];
  guard int := 0;
begin
  loop
    m := regexp_match(t, '\{([^{}]*\|[^{}]*)\}');
    exit when m is null or guard > 50;
    opts := string_to_array(m[1], '|');
    t := overlay(t placing opts[1 + floor(random() * array_length(opts, 1))::int]
                 from strpos(t, '{' || m[1] || '}') for length(m[1]) + 2);
    guard := guard + 1;
  end loop;
  return t;
end $$;

create or replace function idx_private.wa_render(p_text text, p_name text, p_vars jsonb)
returns text language plpgsql volatile set search_path = pg_temp
as $$
declare
  t text := idx_private.wa_spin(p_text);
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_first text := nullif(split_part(coalesce(v_name, ''), ' ', 1), '');
  k text;
begin
  t := replace(t, '{nome}', coalesce(v_name, ''));
  t := replace(t, '{primeiro_nome}', coalesce(v_first, ''));
  t := replace(t, '{empresa}', coalesce(p_vars->>'empresa', v_name, ''));
  t := replace(t, '{cidade}', coalesce(p_vars->>'cidade', ''));
  for k in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    t := replace(t, '{' || k || '}', coalesce(p_vars->>k, ''));
  end loop;
  -- limpa espaços duplos de variáveis vazias ("Olá , tudo bem" → "Olá, tudo bem")
  t := regexp_replace(t, ' +([,.!?])', '\1', 'g');
  t := regexp_replace(t, '[ \t]{2,}', ' ', 'g');
  return trim(t);
end $$;

create or replace function idx_private.wa_with_footer(p_text text)
returns text language sql immutable set search_path = pg_temp
as $$
  select case when p_text ~* '\msair\M' then p_text
              else p_text || E'\n\nSe não quiser receber mais mensagens, responda SAIR.' end;
$$;

-- Envios de campanha do número hoje (no fuso da empresa da campanha)
create or replace function idx_private.wa_sent_today(p_instance uuid, p_tz text)
returns integer language sql stable set search_path = public, pg_temp
as $$
  select count(*)::int from public.wa_outbox
   where instance_id = p_instance and source = 'campaign'
     and status in ('sent', 'sending')
     and coalesce(sent_at, claimed_at) >= (date_trunc('day', now() at time zone p_tz) at time zone p_tz);
$$;

-- Próximo horário permitido (início da janela hoje ou amanhã)
create or replace function idx_private.wa_next_window(p_tz text, p_start int, p_tomorrow boolean)
returns timestamptz language sql stable set search_path = pg_temp
as $$
  select ((date_trunc('day', now() at time zone p_tz)
           + case when p_tomorrow or extract(hour from now() at time zone p_tz) >= p_start
                  then interval '1 day' else interval '0' end
           + make_interval(hours => p_start)) at time zone p_tz)
         + make_interval(secs => floor(random() * 300)::int);   -- espalha até 5 min
$$;

create or replace function idx_private.wa_gw_check(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_token is null or length(p_token) < 32 then raise exception 'gateway_unauthorized'; end if;
  update public.wa_gateway_tokens set last_seen_at = now()
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then raise exception 'gateway_unauthorized'; end if;
end $$;

-- Upsert de contato/conversa do WhatsApp (mesma lógica do webhook do Evolution)
create or replace function idx_private.wa_conversation_for(p_tenant uuid, p_instance uuid, p_wa_id text, p_phone text, p_push_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_contact uuid; v_conv uuid;
begin
  insert into public.whatsapp_contacts (tenant_id, instance_id, wa_id, phone, push_name)
  values (p_tenant, p_instance, p_wa_id, p_phone, nullif(p_push_name, ''))
  on conflict (tenant_id, wa_id) do update
     set push_name = coalesce(excluded.push_name, public.whatsapp_contacts.push_name),
         phone = coalesce(public.whatsapp_contacts.phone, excluded.phone),
         updated_at = now()
  returning id into v_contact;

  select id into v_conv from public.whatsapp_conversations
   where tenant_id = p_tenant and instance_id = p_instance and contact_id = v_contact;
  if v_conv is null then
    insert into public.whatsapp_conversations (tenant_id, instance_id, contact_id, status)
    values (p_tenant, p_instance, v_contact, 'active')
    on conflict (tenant_id, instance_id, contact_id) do update set updated_at = now()
    returning id into v_conv;
  end if;
  return v_conv;
end $$;

-- 5. Funções para a tela (usuário logado) -------------------------------------
create or replace function public.wa_gateway_instance(p_tenant_id uuid)
returns public.whatsapp_instances
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.whatsapp_instances;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  select * into r from public.whatsapp_instances
   where tenant_id = p_tenant_id and provider = 'gateway'
   order by (status = 'connected') desc, created_at limit 1;
  if r.id is not null then r.api_key_hash := null; end if;
  return r;
end $$;

-- Conectar / desconectar / sair (trocar de número). Cria a conexão se não existir.
create or replace function public.wa_gateway_connect(p_tenant_id uuid, p_action text default 'connect')
returns public.whatsapp_instances
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.whatsapp_instances;
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then
    raise exception 'Somente administradores/gestores podem conectar o WhatsApp';
  end if;
  if p_action not in ('connect', 'disconnect', 'logout') then raise exception 'Ação inválida'; end if;

  select * into r from public.whatsapp_instances
   where tenant_id = p_tenant_id and provider = 'gateway' order by created_at limit 1;
  if r.id is null then
    if p_action <> 'connect' then raise exception 'Nenhuma conexão para desconectar'; end if;
    insert into public.whatsapp_instances (tenant_id, instance_name, provider, status, desired_status)
    values (p_tenant_id, 'idx-' || substr(replace(p_tenant_id::text, '-', ''), 1, 12), 'gateway', 'connecting', 'connected')
    on conflict (tenant_id, instance_name) do update set provider = 'gateway', desired_status = 'connected'
    returning * into r;
  else
    update public.whatsapp_instances
       set desired_status = case p_action when 'connect' then 'connected' when 'logout' then 'logout' else 'disconnected' end,
           status = case when p_action = 'connect' and status <> 'connected' then 'connecting' else status end,
           qr_code_data = case when p_action = 'connect' then qr_code_data else null end,
           updated_at = now()
     where id = r.id returning * into r;
  end if;
  r.api_key_hash := null;
  return r;
end $$;

-- Resposta manual (caixa de entrada, tarefa, contato). Só entra na fila.
create or replace function public.wa_send_message(
  p_tenant_id uuid, p_body text, p_phone text default null, p_conversation_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_instance uuid;
  v_conv uuid := p_conversation_id;
  v_id uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para enviar mensagens'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Escreva a mensagem'; end if;

  if v_conv is not null then
    select coalesce(c.phone, c.wa_id), cv.instance_id into v_phone, v_instance
      from public.whatsapp_conversations cv join public.whatsapp_contacts c on c.id = cv.contact_id
     where cv.id = v_conv and cv.tenant_id = p_tenant_id;
    if v_phone is null then raise exception 'Conversa não encontrada'; end if;
    -- conversa veio de outra conexão (ex.: Evolution antigo): responde pelo motor do CRO
    if not exists (select 1 from public.whatsapp_instances where id = v_instance and provider = 'gateway') then
      v_instance := null;
    end if;
  else
    v_phone := p_phone;
  end if;

  v_phone := idx_private.normalize_phone(v_phone);
  if v_phone is null then raise exception 'Telefone inválido'; end if;
  if exists (select 1 from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone) then
    raise exception 'Este contato pediu para não receber mensagens (SAIR)';
  end if;

  if v_instance is null then
    select id into v_instance from public.whatsapp_instances
     where tenant_id = p_tenant_id and provider = 'gateway'
     order by (status = 'connected') desc, created_at limit 1;
  end if;
  if v_instance is null then raise exception 'Conecte o WhatsApp em Disparos → Conexão antes de enviar'; end if;

  insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, conversation_id, created_by)
  values (p_tenant_id, v_instance, v_phone, left(trim(p_body), 4096), 'manual', v_conv, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.wa_cancel_outbox(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.wa_outbox where id = p_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Sem permissão'; end if;
  update public.wa_outbox set status = 'canceled' where id = p_id and status = 'queued';
end $$;

-- Campanha: criar/editar (somente rascunho ou pausada)
create or replace function public.wa_campaign_save(
  p_tenant_id uuid, p_id uuid, p_name text, p_messages text[],
  p_min_delay int default 25, p_max_delay int default 60, p_daily_limit int default 200,
  p_start_hour int default 8, p_end_hour int default 20, p_opt_out_footer boolean default true)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_msgs text[];
  v_id uuid := p_id;
  v_status text;
  v_instance uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Dê um nome ao disparo'; end if;
  select coalesce(array_agg(trim(m)), '{}') into v_msgs from unnest(coalesce(p_messages, '{}')) m where trim(m) <> '';
  if cardinality(v_msgs) = 0 then raise exception 'Escreva pelo menos uma mensagem'; end if;
  if cardinality(v_msgs) > 5 then raise exception 'Use no máximo 5 variações'; end if;
  if p_min_delay < 15 then raise exception 'O intervalo mínimo é de 15 segundos'; end if;
  if p_daily_limit > 500 then raise exception 'O limite diário máximo é 500 por número'; end if;

  select id into v_instance from public.whatsapp_instances
   where tenant_id = p_tenant_id and provider = 'gateway' order by created_at limit 1;

  if v_id is null then
    insert into public.wa_campaigns (tenant_id, instance_id, name, messages, min_delay_sec, max_delay_sec, daily_limit,
                                     start_hour, end_hour, opt_out_footer, created_by)
    values (p_tenant_id, v_instance, trim(p_name), v_msgs, p_min_delay, greatest(p_max_delay, p_min_delay), p_daily_limit,
            p_start_hour, p_end_hour, coalesce(p_opt_out_footer, true), auth.uid())
    returning id into v_id;
  else
    select status into v_status from public.wa_campaigns where id = v_id and tenant_id = p_tenant_id;
    if v_status is null then raise exception 'Disparo não encontrado'; end if;
    if v_status not in ('draft', 'paused') then raise exception 'Pause o disparo antes de editar'; end if;
    update public.wa_campaigns
       set name = trim(p_name), messages = v_msgs, min_delay_sec = p_min_delay,
           max_delay_sec = greatest(p_max_delay, p_min_delay), daily_limit = p_daily_limit,
           start_hour = p_start_hour, end_hour = p_end_hour, opt_out_footer = coalesce(p_opt_out_footer, true),
           instance_id = coalesce(instance_id, v_instance)
     where id = v_id;
  end if;
  return v_id;
end $$;

-- Campanha: adicionar público. p_source: 'dial_list' | 'contacts' | 'rows'
create or replace function public.wa_campaign_add_recipients(
  p_campaign_id uuid, p_source text, p_list_name text default null, p_contact_ids uuid[] default null,
  p_rows jsonb default null, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.wa_campaigns;
  v_before int; v_after int; v_candidates int := 0; v_optout int := 0;
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
    'total', v_after);
end $$;

create or replace function public.wa_campaign_clear_recipients(p_campaign_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.wa_campaigns;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if c.status not in ('draft', 'paused') then raise exception 'Pause o disparo antes de mudar o público'; end if;
  delete from public.wa_campaign_recipients where campaign_id = c.id and status in ('pending', 'opted_out', 'skipped');
end $$;

-- Iniciar / pausar / retomar / cancelar. Iniciar exige clique de quem pode escrever.
create or replace function public.wa_campaign_action(p_campaign_id uuid, p_action text)
returns public.wa_campaigns
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.wa_campaigns; v_pending int; v_inst public.whatsapp_instances;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id for update;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;

  if p_action in ('start', 'resume') then
    if c.status not in ('draft', 'paused') then raise exception 'Este disparo não pode ser iniciado agora'; end if;
    select count(*) into v_pending from public.wa_campaign_recipients where campaign_id = c.id and status = 'pending';
    if v_pending = 0 then raise exception 'Adicione contatos ao público antes de iniciar'; end if;
    if c.instance_id is null then
      select id into c.instance_id from public.whatsapp_instances
       where tenant_id = c.tenant_id and provider = 'gateway' order by created_at limit 1;
    end if;
    select * into v_inst from public.whatsapp_instances where id = c.instance_id;
    if v_inst.id is null then raise exception 'Conecte o WhatsApp antes de iniciar'; end if;
    update public.wa_campaigns
       set status = 'running', instance_id = c.instance_id, next_send_at = now(), paused_reason = null,
           started_at = coalesce(started_at, now()), started_by = coalesce(started_by, auth.uid()), completed_at = null
     where id = c.id returning * into c;
  elsif p_action = 'pause' then
    if c.status <> 'running' then raise exception 'O disparo não está em andamento'; end if;
    update public.wa_campaigns set status = 'paused', paused_reason = 'Pausado manualmente' where id = c.id returning * into c;
  elsif p_action = 'cancel' then
    if c.status in ('completed', 'canceled') then raise exception 'O disparo já terminou'; end if;
    update public.wa_campaigns set status = 'canceled', completed_at = now() where id = c.id returning * into c;
    update public.wa_campaign_recipients set status = 'skipped', error = 'Disparo cancelado'
     where campaign_id = c.id and status = 'pending';
  elsif p_action = 'archive' then
    if c.status in ('running') then raise exception 'Pause ou cancele antes de excluir'; end if;
    if exists (select 1 from public.wa_campaign_recipients where campaign_id = c.id and status = 'sent') then
      raise exception 'Disparos que já enviaram mensagens ficam no histórico';
    end if;
    delete from public.wa_campaigns where id = c.id;
    return c;
  else
    raise exception 'Ação inválida';
  end if;
  return c;
end $$;

-- Lista com contadores calculados (sem contadores que possam ficar errados)
create or replace function public.wa_campaign_list(p_tenant_id uuid)
returns table (
  id uuid, name text, status text, messages text[], min_delay_sec int, max_delay_sec int, daily_limit int,
  start_hour int, end_hour int, opt_out_footer boolean, next_send_at timestamptz, paused_reason text,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz, audience jsonb,
  total bigint, pending bigint, sent bigint, failed bigint, invalid bigint, opted_out bigint, skipped bigint, replied bigint,
  sent_today int)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return query
  select c.id, c.name, c.status, c.messages, c.min_delay_sec, c.max_delay_sec, c.daily_limit,
         c.start_hour, c.end_hour, c.opt_out_footer, c.next_send_at, c.paused_reason,
         c.started_at, c.completed_at, c.created_at, c.audience,
         count(r.id), count(r.id) filter (where r.status in ('pending', 'queued')),
         count(r.id) filter (where r.status = 'sent'), count(r.id) filter (where r.status = 'failed'),
         count(r.id) filter (where r.status = 'invalid'), count(r.id) filter (where r.status = 'opted_out'),
         count(r.id) filter (where r.status = 'skipped'), count(r.id) filter (where r.replied_at is not null),
         case when c.instance_id is null then 0
              else idx_private.wa_sent_today(c.instance_id, idx_private.crm_tenant_tz(c.tenant_id)) end
    from public.wa_campaigns c
    left join public.wa_campaign_recipients r on r.campaign_id = c.id
   where c.tenant_id = p_tenant_id
   group by c.id
   order by c.created_at desc;
end $$;

create or replace function public.wa_optout_set(p_tenant_id uuid, p_phone text, p_optout boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_phone text := idx_private.normalize_phone(p_phone);
begin
  if v_phone is null then raise exception 'Telefone inválido'; end if;
  if p_optout then
    if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
    insert into public.wa_optouts (tenant_id, phone, source, created_by) values (p_tenant_id, v_phone, 'manual', auth.uid())
    on conflict do nothing;
    update public.wa_campaign_recipients set status = 'opted_out'
     where tenant_id = p_tenant_id and phone = v_phone and status = 'pending';
  else
    -- reativar só com o pedido do próprio contato; restrito a gestores
    if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Somente gestores podem reativar um contato'; end if;
    delete from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone;
  end if;
end $$;

create or replace function idx_private.wa_campaign_maybe_finish(p_campaign uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_campaigns set status = 'completed', completed_at = now(), next_send_at = null
   where id = p_campaign and status = 'running'
     and not exists (select 1 from public.wa_campaign_recipients where campaign_id = p_campaign and status in ('pending', 'queued'));
$$;
revoke all on function idx_private.wa_campaign_maybe_finish(uuid) from public;

-- 6. Funções do motor (gateway) — exigem o token ---------------------------------
create or replace function public.wa_gw_instances(p_token text)
returns table (id uuid, tenant_id uuid, instance_name text, desired_status text, status text, phone_number text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.wa_gw_check(p_token);
  return query select i.id, i.tenant_id, i.instance_name, i.desired_status, i.status, i.phone_number
    from public.whatsapp_instances i where i.provider = 'gateway';
end $$;

create or replace function public.wa_gw_instance_update(
  p_token text, p_instance uuid, p_status text, p_qr text default null, p_phone text default null, p_error text default null)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.wa_gw_check(p_token);
  update public.whatsapp_instances
     set status = coalesce(p_status, status),
         qr_code_data = case when p_status = 'connected' or p_status = 'disconnected' then null else coalesce(p_qr, qr_code_data) end,
         phone_number = coalesce(p_phone, phone_number),
         last_seen_at = now(),
         desired_status = case when p_status = 'disconnected' and desired_status = 'logout' then 'disconnected' else desired_status end,
         metadata = case when p_error is null then metadata - 'last_error'
                         else coalesce(metadata, '{}'::jsonb) || jsonb_build_object('last_error', left(p_error, 300), 'last_error_at', now()) end,
         updated_at = now()
   where id = p_instance and provider = 'gateway';
  -- número banido/desconectado: pausa os disparos para não acumular erro
  if p_status in ('banned') then
    update public.wa_campaigns set status = 'paused', paused_reason = 'WhatsApp bloqueado/desconectado'
     where instance_id = p_instance and status = 'running';
  end if;
end $$;

-- Marca envios interrompidos (motor caiu no meio). Nunca reenvia sozinho para não duplicar.
create or replace function public.wa_gw_recover(p_token text, p_instance uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  perform idx_private.wa_gw_check(p_token);
  with x as (
    update public.wa_outbox set status = 'failed', error = 'Envio interrompido (o motor reiniciou). Confira na conversa se chegou.'
     where instance_id = p_instance and status = 'sending' and claimed_at < now() - interval '2 minutes'
    returning recipient_id)
  update public.wa_campaign_recipients r set status = 'failed', error = 'Envio interrompido'
    from x where r.id = x.recipient_id and r.status = 'queued';
  get diagnostics n = row_count;
  return n;
end $$;

-- Próxima mensagem a enviar por esta conexão (atômico; aplica todas as proteções)
create or replace function public.wa_gw_claim(p_token text, p_instance uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o public.wa_outbox;
  c public.wa_campaigns;
  r public.wa_campaign_recipients;
  v_tz text;
  v_hour int;
  v_body text;
  v_tries int := 0;
begin
  perform idx_private.wa_gw_check(p_token);

  -- 1) mensagens manuais têm prioridade (respostas da caixa de entrada)
  select * into o from public.wa_outbox
   where instance_id = p_instance and status = 'queued' and source = 'manual'
   order by created_at for update skip locked limit 1;
  if o.id is not null then
    if exists (select 1 from public.wa_optouts where tenant_id = o.tenant_id and phone = o.phone) then
      update public.wa_outbox set status = 'failed', error = 'Contato pediu SAIR' where id = o.id;
      return null;
    end if;
    update public.wa_outbox set status = 'sending', claimed_at = now(), attempts = attempts + 1 where id = o.id;
    return jsonb_build_object('id', o.id, 'phone', o.phone, 'body', o.body, 'source', 'manual');
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

      v_body := idx_private.wa_render(c.messages[1 + floor(random() * cardinality(c.messages))::int], r.name, r.vars);
      if coalesce(v_body, '') = '' then
        update public.wa_campaign_recipients set status = 'failed', error = 'Mensagem vazia' where id = r.id;
        continue;
      end if;
      if c.opt_out_footer then v_body := idx_private.wa_with_footer(v_body); end if;

      insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, campaign_id, recipient_id, status, claimed_at, attempts, created_by)
      values (c.tenant_id, p_instance, r.phone, left(v_body, 4096), 'campaign', c.id, r.id, 'sending', now(), 1, c.started_by)
      returning * into o;
      update public.wa_campaign_recipients set status = 'queued', outbox_id = o.id where id = r.id;
      update public.wa_campaigns
         set next_send_at = now() + make_interval(secs => c.min_delay_sec + floor(random() * (c.max_delay_sec - c.min_delay_sec + 1))::int)
       where id = c.id;
      return jsonb_build_object('id', o.id, 'phone', o.phone, 'body', o.body, 'source', 'campaign', 'campaign_id', c.id);
    end loop;
  end loop;
  return null;
end $$;

-- Grava a mensagem no histórico do WhatsApp do CRO (entrada ou saída). Idempotente.
create or replace function public.wa_gw_ingest(p_token text, p_instance uuid, p_msg jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_from_me boolean := coalesce((p_msg->>'from_me')::boolean, false);
  v_wa_id text := p_msg->>'wa_id';
  v_phone text := idx_private.normalize_phone(coalesce(p_msg->>'phone', p_msg->>'wa_id'));
  v_body text := p_msg->>'body';
  v_type text := coalesce(p_msg->>'type', 'text');
  v_ts timestamptz := coalesce((p_msg->>'ts')::timestamptz, now());
  v_conv uuid;
  v_msg uuid;
  v_key text;
  rc record;
begin
  perform idx_private.wa_gw_check(p_token);
  select tenant_id into v_tenant from public.whatsapp_instances where id = p_instance and provider = 'gateway';
  if v_tenant is null or coalesce(v_wa_id, '') = '' then return jsonb_build_object('skipped', true); end if;
  if v_type not in ('text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'sticker', 'reaction', 'unknown') then
    v_type := 'unknown';
  end if;

  v_conv := idx_private.wa_conversation_for(v_tenant, p_instance, v_wa_id, v_phone, p_msg->>'push_name');

  insert into public.whatsapp_messages (tenant_id, conversation_id, wa_message_id, direction, sender_phone, content_type,
                                        body, media_mime, quoted_message_id, "timestamp", status, raw_payload)
  values (v_tenant, v_conv, nullif(p_msg->>'wa_message_id', ''), case when v_from_me then 'outbound' else 'inbound' end,
          case when v_from_me then null else v_phone end, v_type, v_body, p_msg->>'mime', p_msg->>'quoted_id', v_ts,
          case when v_from_me then 'sent' else 'delivered' end,
          jsonb_build_object('via', 'gateway'))
  on conflict (tenant_id, wa_message_id) do nothing
  returning id into v_msg;

  if v_msg is null then return jsonb_build_object('duplicate', true, 'conversation_id', v_conv); end if;

  update public.whatsapp_conversations
     set last_message_at = greatest(coalesce(last_message_at, v_ts), v_ts),
         unread_count = unread_count + case when v_from_me then 0 else 1 end,
         updated_at = now()
   where id = v_conv;

  if not v_from_me and v_phone is not null then
    v_key := idx_private.phone_match_key(v_phone);
    -- descadastro por palavra-chave
    if idx_private.wa_is_optout_keyword(v_body) then
      insert into public.wa_optouts (tenant_id, phone, source, body) values (v_tenant, v_phone, 'keyword', left(v_body, 200))
      on conflict do nothing;
      update public.wa_campaign_recipients set status = 'opted_out'
       where tenant_id = v_tenant and status = 'pending'
         and (phone = v_phone or idx_private.phone_match_key(phone) = v_key);
    end if;
    -- marcou resposta de disparo (últimos 30 dias) e avisa quem iniciou
    for rc in
      update public.wa_campaign_recipients r set replied_at = v_ts
       where r.tenant_id = v_tenant and r.status = 'sent' and r.replied_at is null
         and r.sent_at > now() - interval '30 days'
         and (r.phone = v_phone or idx_private.phone_match_key(r.phone) = v_key)
      returning r.id, r.campaign_id, r.name, r.crm_contact_id
    loop
      insert into public.crm_notifications (tenant_id, user_id, title, body, severity, link_type, link_id, dedup_key)
      select v_tenant, coalesce(c.started_by, c.created_by),
             coalesce(rc.name, v_phone) || ' respondeu ao disparo',
             '“' || left(coalesce(v_body, '[mídia]'), 120) || '” · ' || c.name,
             'info', case when rc.crm_contact_id is not null then 'contact' end, rc.crm_contact_id, 'wa-reply-' || rc.id
        from public.wa_campaigns c where c.id = rc.campaign_id and coalesce(c.started_by, c.created_by) is not null
      on conflict do nothing;
    end loop;
  end if;

  return jsonb_build_object('message_id', v_msg, 'conversation_id', v_conv);
end $$;

-- Resultado do envio
create or replace function public.wa_gw_result(
  p_token text, p_outbox_id uuid, p_ok boolean, p_wa_message_id text default null,
  p_jid text default null, p_error text default null, p_invalid boolean default false, p_retry boolean default false)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare o public.wa_outbox; v_phone text;
begin
  perform idx_private.wa_gw_check(p_token);
  select * into o from public.wa_outbox where id = p_outbox_id for update;
  if o.id is null or o.status <> 'sending' then return; end if;

  if p_ok then
    update public.wa_outbox set status = 'sent', sent_at = now(), wa_message_id = p_wa_message_id, error = null where id = o.id;
    if o.recipient_id is not null then
      update public.wa_campaign_recipients set status = 'sent', sent_at = now(), wa_message_id = p_wa_message_id, error = null
       where id = o.recipient_id;
    end if;
    perform idx_private.wa_campaign_maybe_finish(o.campaign_id);
    -- histórico na caixa de entrada (o WhatsApp entrega o número real, às vezes sem o 9º dígito)
    v_phone := coalesce(idx_private.normalize_phone(p_jid), o.phone);
    perform public.wa_gw_ingest(p_token, o.instance_id, jsonb_build_object(
      'from_me', true, 'wa_id', coalesce(nullif(regexp_replace(coalesce(p_jid, ''), '@.*$', ''), ''), v_phone),
      'phone', v_phone, 'body', o.body, 'type', 'text', 'wa_message_id', p_wa_message_id, 'ts', now()));
  elsif p_retry and o.attempts < 3 then
    if o.source = 'manual' then
      update public.wa_outbox set status = 'queued', error = left(p_error, 300) where id = o.id;
    else
      -- campanha: devolve o contato para a fila e cancela este item
      update public.wa_outbox set status = 'canceled', error = left(p_error, 300) where id = o.id;
      update public.wa_campaign_recipients set status = 'pending', outbox_id = null where id = o.recipient_id;
    end if;
  else
    update public.wa_outbox set status = 'failed', error = left(coalesce(p_error, 'Falha no envio'), 300) where id = o.id;
    if o.recipient_id is not null then
      update public.wa_campaign_recipients
         set status = case when p_invalid then 'invalid' else 'failed' end,
             error = left(coalesce(p_error, 'Falha no envio'), 300)
       where id = o.recipient_id;
    end if;
    perform idx_private.wa_campaign_maybe_finish(o.campaign_id);
  end if;
end $$;

create or replace function public.wa_gw_status(p_token text, p_instance uuid, p_wa_message_id text, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  perform idx_private.wa_gw_check(p_token);
  if p_status not in ('sent', 'delivered', 'read', 'failed') then return; end if;
  select tenant_id into v_tenant from public.whatsapp_instances where id = p_instance;
  update public.whatsapp_messages set status = p_status
   where tenant_id = v_tenant and wa_message_id = p_wa_message_id
     and (case status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end)
       < (case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 5 end);
end $$;

-- 7. Permissões -------------------------------------------------------------
revoke all on function idx_private.wa_gw_check(text) from public;
revoke all on function idx_private.wa_conversation_for(uuid, uuid, text, text, text) from public;

grant execute on function public.wa_gateway_instance(uuid) to authenticated;
grant execute on function public.wa_gateway_connect(uuid, text) to authenticated;
grant execute on function public.wa_send_message(uuid, text, text, uuid) to authenticated;
grant execute on function public.wa_cancel_outbox(uuid) to authenticated;
grant execute on function public.wa_campaign_save(uuid, uuid, text, text[], int, int, int, int, int, boolean) to authenticated;
grant execute on function public.wa_campaign_add_recipients(uuid, text, text, uuid[], jsonb, jsonb) to authenticated;
grant execute on function public.wa_campaign_clear_recipients(uuid) to authenticated;
grant execute on function public.wa_campaign_action(uuid, text) to authenticated;
grant execute on function public.wa_campaign_list(uuid) to authenticated;
grant execute on function public.wa_optout_set(uuid, text, boolean) to authenticated;

-- o motor usa a chave pública (anon) + token; sem o token as funções recusam
revoke all on function public.wa_gw_instances(text) from public;
revoke all on function public.wa_gw_instance_update(text, uuid, text, text, text, text) from public;
revoke all on function public.wa_gw_recover(text, uuid) from public;
revoke all on function public.wa_gw_claim(text, uuid) from public;
revoke all on function public.wa_gw_ingest(text, uuid, jsonb) from public;
revoke all on function public.wa_gw_result(text, uuid, boolean, text, text, text, boolean, boolean) from public;
revoke all on function public.wa_gw_status(text, uuid, text, text) from public;
grant execute on function public.wa_gw_instances(text) to anon, service_role;
grant execute on function public.wa_gw_instance_update(text, uuid, text, text, text, text) to anon, service_role;
grant execute on function public.wa_gw_recover(text, uuid) to anon, service_role;
grant execute on function public.wa_gw_claim(text, uuid) to anon, service_role;
grant execute on function public.wa_gw_ingest(text, uuid, jsonb) to anon, service_role;
grant execute on function public.wa_gw_result(text, uuid, boolean, text, text, text, boolean, boolean) to anon, service_role;
grant execute on function public.wa_gw_status(text, uuid, text, text) to anon, service_role;
