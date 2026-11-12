-- =============================================================================
-- Automações de WhatsApp (fluxos visuais, estilo FlowZap/Kommo/n8n) dentro do CRO.
--
-- Um fluxo é um desenho (nós + ligações) salvo em wa_flows.graph. Quem executa é a
-- Edge Function cro-flows (núcleo em _shared/flow-core.ts — o mesmo usado no
-- simulador do editor). O motor do WhatsApp chama cro-flows a cada mensagem recebida
-- e a cada 30s para retomar esperas vencidas.
--
-- Tudo o que o fluxo envia passa pela MESMA fila (wa_outbox, source 'flow') e pela
-- MESMA conexão do resto do CRO; quem pediu SAIR nunca recebe. Nada roda sem o
-- gestor clicar em "Ativar".
-- =============================================================================

-- 1. Fluxos -------------------------------------------------------------------
create table if not exists public.wa_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  graph jsonb not null default '{"nodes": [], "edges": []}'::jsonb,
  trigger_kind text,                -- cópia do gatilho do desenho (para achar rápido)
  trigger_config jsonb not null default '{}'::jsonb,
  -- reentrada: 'once' (uma vez por contato), 'cooldown' (de novo após X horas), 'always'
  reentry text not null default 'cooldown' check (reentry in ('once', 'cooldown', 'always')),
  cooldown_hours int not null default 24 check (cooldown_hours between 0 and 8760),
  priority int not null default 0,
  instance_id uuid references public.whatsapp_instances(id) on delete set null,
  version int not null default 1,
  activated_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists idx_wa_flows_active on public.wa_flows(tenant_id, trigger_kind) where status = 'active';

-- 2. Execuções (um contato percorrendo um fluxo) -------------------------------
create table if not exists public.wa_flow_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_id uuid not null references public.wa_flows(id) on delete cascade,
  instance_id uuid references public.whatsapp_instances(id) on delete set null,
  phone text not null,
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  crm_contact_id uuid references public.crm_contacts(id) on delete set null,
  trigger_kind text,
  is_test boolean not null default false,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'cancelled', 'failed')),
  wait_kind text,
  current_node text,
  resume_at timestamptz,             -- quando retomar (espera / prazo da resposta)
  locked_until timestamptz,          -- trava enquanto um processamento cuida dela
  last_error text,
  steps int not null default 0,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists wa_flow_runs_one_open on public.wa_flow_runs(flow_id, phone) where status in ('running', 'waiting');
create index if not exists idx_wa_flow_runs_due on public.wa_flow_runs(resume_at) where status in ('running', 'waiting');
create index if not exists idx_wa_flow_runs_phone on public.wa_flow_runs(tenant_id, phone, status);
create index if not exists idx_wa_flow_runs_flow on public.wa_flow_runs(flow_id, started_at desc);

-- 3. Histórico por bloco (estatística no desenho) -----------------------------
create table if not exists public.wa_flow_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_id uuid not null references public.wa_flows(id) on delete cascade,
  run_id uuid references public.wa_flow_runs(id) on delete cascade,
  node_id text,
  event text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_flow_events_flow on public.wa_flow_events(flow_id, node_id, event);
create index if not exists idx_wa_flow_events_run on public.wa_flow_events(run_id, id);

-- 4. Fila de acontecimentos para o motor de fluxos ------------------------------
create table if not exists public.wa_flow_queue (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('message', 'tag', 'stage', 'manual')),
  phone text,
  instance_id uuid,
  conversation_id uuid,
  message_id uuid,
  flow_id uuid,
  payload jsonb not null default '{}'::jsonb,
  not_before timestamptz not null default now(),
  locked_until timestamptz,
  attempts int not null default 0,
  processed_at timestamptz,
  result text,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_flow_queue_pending on public.wa_flow_queue(not_before, id) where processed_at is null;

-- 5. Conversa: robô x atendente humano ----------------------------------------
alter table public.whatsapp_conversations add column if not exists bot_mode text not null default 'bot';
alter table public.whatsapp_conversations drop constraint if exists whatsapp_conversations_bot_mode_check;
alter table public.whatsapp_conversations add constraint whatsapp_conversations_bot_mode_check check (bot_mode in ('bot', 'human'));
alter table public.whatsapp_conversations add column if not exists bot_paused_until timestamptz;

-- 6. Fila de envio: aceita mensagens de fluxo e mídia ---------------------------
alter table public.wa_outbox drop constraint if exists wa_outbox_source_check;
alter table public.wa_outbox add constraint wa_outbox_source_check check (source in ('manual', 'campaign', 'flow'));
alter table public.wa_outbox add column if not exists media_url text;
alter table public.wa_outbox add column if not exists media_type text;
alter table public.wa_outbox add column if not exists file_name text;
alter table public.wa_outbox add column if not exists flow_run_id uuid references public.wa_flow_runs(id) on delete set null;
alter table public.wa_outbox drop constraint if exists wa_outbox_body_check;
alter table public.wa_outbox drop constraint if exists wa_outbox_body_media_check;
alter table public.wa_outbox add constraint wa_outbox_body_media_check check (
  length(body) <= 4096 and (length(body) >= 1 or media_url is not null));
alter table public.wa_outbox drop constraint if exists wa_outbox_media_type_check;
alter table public.wa_outbox add constraint wa_outbox_media_type_check check (
  media_type is null or media_type in ('image', 'video', 'audio', 'document'));

drop trigger if exists trg_wa_flows_updated on public.wa_flows;
create trigger trg_wa_flows_updated before update on public.wa_flows
for each row execute function idx_private.touch_updated_at();

-- 7. RLS: leitura para quem acessa o CRM; escrita só pelas funções ---------------
alter table public.wa_flows enable row level security;
alter table public.wa_flow_runs enable row level security;
alter table public.wa_flow_events enable row level security;
alter table public.wa_flow_queue enable row level security;   -- só o servidor
drop policy if exists wa_flows_read on public.wa_flows;
create policy wa_flows_read on public.wa_flows for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists wa_flow_runs_read on public.wa_flow_runs;
create policy wa_flow_runs_read on public.wa_flow_runs for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists wa_flow_events_read on public.wa_flow_events;
create policy wa_flow_events_read on public.wa_flow_events for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

-- 8. Gatilhos do banco → fila do motor ------------------------------------------
create or replace function idx_private.wa_flows_listening(p_tenant uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.wa_flows where tenant_id = p_tenant and status = 'active')
      or exists (select 1 from public.wa_flow_runs where tenant_id = p_tenant and status = 'waiting')
$$;

-- mensagem recebida pela conexão do CRO
create or replace function idx_private.wa_flow_on_message()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_inst uuid;
  v_provider text;
  v_phone text;
  v_first boolean;
begin
  if new.direction <> 'inbound' then return null; end if;
  if not idx_private.wa_flows_listening(new.tenant_id) then return null; end if;
  select c.instance_id, i.provider, coalesce(wc.phone, new.sender_phone)
    into v_inst, v_provider, v_phone
    from public.whatsapp_conversations c
    join public.whatsapp_instances i on i.id = c.instance_id
    join public.whatsapp_contacts wc on wc.id = c.contact_id
   where c.id = new.conversation_id;
  if v_provider is distinct from 'gateway' or v_phone is null then return null; end if;
  v_first := not exists (select 1 from public.whatsapp_messages m
                          where m.conversation_id = new.conversation_id and m.direction = 'inbound' and m.id <> new.id);
  insert into public.wa_flow_queue (tenant_id, kind, phone, instance_id, conversation_id, message_id, payload)
  values (new.tenant_id, 'message', idx_private.normalize_phone(v_phone), v_inst, new.conversation_id, new.id,
          jsonb_build_object('text', coalesce(new.body, ''), 'type', new.content_type, 'first', v_first));
  return null;
exception when others then
  raise warning 'wa_flow_on_message: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_wa_flow_on_message on public.whatsapp_messages;
create trigger trg_wa_flow_on_message after insert on public.whatsapp_messages
for each row execute function idx_private.wa_flow_on_message();

-- etiqueta adicionada no contato
create or replace function idx_private.wa_flow_on_contact_tags()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare t text;
begin
  if new.phone is null then return null; end if;
  if not exists (select 1 from public.wa_flows where tenant_id = new.tenant_id and status = 'active' and trigger_kind = 'tag') then
    return null;
  end if;
  for t in select unnest(new.tags) except select unnest(case when tg_op = 'UPDATE' then old.tags else '{}'::text[] end) loop
    insert into public.wa_flow_queue (tenant_id, kind, phone, payload)
    values (new.tenant_id, 'tag', new.phone, jsonb_build_object('tag', t, 'contact_id', new.id));
  end loop;
  return null;
exception when others then
  raise warning 'wa_flow_on_contact_tags: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_wa_flow_on_contact_tags on public.crm_contacts;
create trigger trg_wa_flow_on_contact_tags after insert or update of tags on public.crm_contacts
for each row execute function idx_private.wa_flow_on_contact_tags();

-- negociação entrou numa etapa do funil
create or replace function idx_private.wa_flow_on_deal_stage()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_phone text;
begin
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then return null; end if;
  if new.contact_id is null then return null; end if;
  if not exists (select 1 from public.wa_flows where tenant_id = new.tenant_id and status = 'active' and trigger_kind = 'stage') then
    return null;
  end if;
  select phone into v_phone from public.crm_contacts where id = new.contact_id;
  if v_phone is null then return null; end if;
  insert into public.wa_flow_queue (tenant_id, kind, phone, payload)
  values (new.tenant_id, 'stage', v_phone, jsonb_build_object('stage_id', new.stage_id, 'deal_id', new.id, 'contact_id', new.contact_id));
  return null;
exception when others then
  raise warning 'wa_flow_on_deal_stage: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_wa_flow_on_deal_stage on public.crm_deals;
create trigger trg_wa_flow_on_deal_stage after insert or update of stage_id on public.crm_deals
for each row execute function idx_private.wa_flow_on_deal_stage();

-- 9. Funções da tela (usuário logado) -----------------------------------------
create or replace function public.wa_flow_save(
  p_tenant_id uuid, p_id uuid, p_name text, p_graph jsonb, p_description text default null,
  p_reentry text default null, p_cooldown_hours int default null, p_priority int default null)
returns public.wa_flows
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  f public.wa_flows;
  v_trigger jsonb;
  v_ntrig int;
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Só gestores podem editar automações'; end if;
  if jsonb_typeof(p_graph->'nodes') <> 'array' or jsonb_typeof(p_graph->'edges') <> 'array' then
    raise exception 'Desenho inválido';
  end if;
  if jsonb_array_length(p_graph->'nodes') > 300 then raise exception 'Fluxo grande demais (máx. 300 blocos)'; end if;
  if octet_length(p_graph::text) > 900000 then raise exception 'Fluxo grande demais'; end if;
  select count(*) into v_ntrig from jsonb_array_elements(p_graph->'nodes') n where n->>'type' = 'trigger';
  if v_ntrig > 1 then raise exception 'O fluxo só pode ter um gatilho'; end if;
  select n->'data'->'config' into v_trigger from jsonb_array_elements(p_graph->'nodes') n where n->>'type' = 'trigger' limit 1;

  if p_id is null then
    insert into public.wa_flows (tenant_id, name, description, graph, trigger_kind, trigger_config, reentry, cooldown_hours, priority, created_by, updated_by)
    values (p_tenant_id, trim(p_name), p_description, p_graph, coalesce(v_trigger->>'kind', case when v_trigger is not null then 'message' end),
            coalesce(v_trigger, '{}'::jsonb), coalesce(p_reentry, 'cooldown'), coalesce(p_cooldown_hours, 24), coalesce(p_priority, 0),
            auth.uid(), auth.uid())
    returning * into f;
  else
    update public.wa_flows
       set name = trim(p_name), description = coalesce(p_description, description), graph = p_graph,
           trigger_kind = coalesce(v_trigger->>'kind', case when v_trigger is not null then 'message' end),
           trigger_config = coalesce(v_trigger, '{}'::jsonb),
           reentry = coalesce(p_reentry, reentry), cooldown_hours = coalesce(p_cooldown_hours, cooldown_hours),
           priority = coalesce(p_priority, priority), version = version + 1, updated_by = auth.uid()
     where id = p_id and tenant_id = p_tenant_id and status <> 'archived'
    returning * into f;
    if f.id is null then raise exception 'Automação não encontrada'; end if;
  end if;
  return f;
end $$;

create or replace function public.wa_flow_set_status(p_flow_id uuid, p_status text)
returns public.wa_flows
language plpgsql security definer set search_path = public, pg_temp
as $$
declare f public.wa_flows; v_inst uuid;
begin
  select * into f from public.wa_flows where id = p_flow_id;
  if f.id is null or not idx_private.crm_can(f.tenant_id, 'configure') then raise exception 'Automação não encontrada'; end if;
  if p_status not in ('active', 'paused', 'draft', 'archived') then raise exception 'Status inválido'; end if;
  if p_status = 'active' then
    if f.trigger_kind is null then raise exception 'Adicione um gatilho antes de ativar'; end if;
    if jsonb_array_length(f.graph->'nodes') < 2 then raise exception 'Adicione pelo menos uma ação depois do gatilho'; end if;
    select id into v_inst from public.whatsapp_instances where tenant_id = f.tenant_id and provider = 'gateway' limit 1;
    if v_inst is null then raise exception 'Conecte o WhatsApp do CRO (Disparos → Conexão) antes de ativar'; end if;
    update public.wa_flows set status = 'active', activated_at = now(), instance_id = coalesce(instance_id, v_inst), updated_by = auth.uid()
     where id = f.id returning * into f;
  else
    update public.wa_flows set status = p_status, updated_by = auth.uid() where id = f.id returning * into f;
    if p_status = 'archived' then
      update public.wa_flow_runs set status = 'cancelled', finished_at = now(), last_error = 'Automação arquivada'
       where flow_id = f.id and status in ('running', 'waiting');
    end if;
  end if;
  return f;
end $$;

create or replace function public.wa_flow_duplicate(p_flow_id uuid)
returns public.wa_flows
language plpgsql security definer set search_path = public, pg_temp
as $$
declare f public.wa_flows;
begin
  select * into f from public.wa_flows where id = p_flow_id;
  if f.id is null or not idx_private.crm_can(f.tenant_id, 'configure') then raise exception 'Automação não encontrada'; end if;
  insert into public.wa_flows (tenant_id, name, description, graph, trigger_kind, trigger_config, reentry, cooldown_hours, priority, created_by, updated_by)
  values (f.tenant_id, left(f.name || ' (cópia)', 120), f.description, f.graph, f.trigger_kind, f.trigger_config, f.reentry, f.cooldown_hours, f.priority, auth.uid(), auth.uid())
  returning * into f;
  return f;
end $$;

-- Lista com números de cada fluxo
create or replace function public.wa_flow_list(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'name', f.name, 'description', f.description, 'status', f.status, 'trigger_kind', f.trigger_kind,
      'trigger_config', f.trigger_config, 'reentry', f.reentry, 'cooldown_hours', f.cooldown_hours, 'priority', f.priority,
      'nodes', jsonb_array_length(f.graph->'nodes'), 'updated_at', f.updated_at, 'activated_at', f.activated_at,
      'runs_total', (select count(*) from public.wa_flow_runs r where r.flow_id = f.id and not r.is_test),
      'runs_open', (select count(*) from public.wa_flow_runs r where r.flow_id = f.id and r.status in ('running', 'waiting')),
      'runs_done', (select count(*) from public.wa_flow_runs r where r.flow_id = f.id and r.status = 'completed' and not r.is_test),
      'runs_7d', (select count(*) from public.wa_flow_runs r where r.flow_id = f.id and not r.is_test and r.started_at > now() - interval '7 days'),
      'sent_7d', (select count(*) from public.wa_outbox o join public.wa_flow_runs r on r.id = o.flow_run_id
                   where r.flow_id = f.id and o.status = 'sent' and o.sent_at > now() - interval '7 days'))
      order by (f.status = 'active') desc, f.updated_at desc)
    from public.wa_flows f where f.tenant_id = p_tenant_id and f.status <> 'archived'), '[]'::jsonb);
end $$;

-- Números por bloco (aparecem no desenho)
create or replace function public.wa_flow_stats(p_flow_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.wa_flows where id = p_flow_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'read') then raise exception 'Automação não encontrada'; end if;
  return jsonb_build_object(
    'nodes', coalesce((select jsonb_object_agg(node_id, s) from (
        select node_id, jsonb_object_agg(event, n) s from (
          select e.node_id, e.event, count(*) n from public.wa_flow_events e
           where e.flow_id = p_flow_id and e.node_id is not null
             and not exists (select 1 from public.wa_flow_runs r where r.id = e.run_id and r.is_test)
           group by 1, 2) x group by node_id) y), '{}'::jsonb),
    'waiting', coalesce((select jsonb_object_agg(current_node, n) from (
        select current_node, count(*) n from public.wa_flow_runs
         where flow_id = p_flow_id and status = 'waiting' and current_node is not null group by 1) w), '{}'::jsonb),
    'runs', (select jsonb_build_object(
        'total', count(*) filter (where not is_test),
        'open', count(*) filter (where status in ('running', 'waiting')),
        'completed', count(*) filter (where status = 'completed' and not is_test),
        'failed', count(*) filter (where status = 'failed' and not is_test),
        'cancelled', count(*) filter (where status = 'cancelled' and not is_test))
      from public.wa_flow_runs where flow_id = p_flow_id));
end $$;

-- Últimas execuções (com o caminho percorrido)
create or replace function public.wa_flow_runs_list(p_flow_id uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.wa_flows where id = p_flow_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'read') then raise exception 'Automação não encontrada'; end if;
  return coalesce((select jsonb_agg(x order by x->>'started_at' desc) from (
    select jsonb_build_object(
      'id', r.id, 'phone', r.phone, 'status', r.status, 'wait_kind', r.wait_kind, 'current_node', r.current_node,
      'resume_at', r.resume_at, 'started_at', r.started_at, 'finished_at', r.finished_at, 'last_error', r.last_error,
      'is_test', r.is_test, 'trigger_kind', r.trigger_kind,
      'name', coalesce(ct.name, (select wc.push_name from public.whatsapp_conversations c join public.whatsapp_contacts wc on wc.id = c.contact_id where c.id = r.conversation_id)),
      'contact_id', r.crm_contact_id, 'conversation_id', r.conversation_id,
      'path', coalesce((select jsonb_agg(jsonb_build_object('node', e.node_id, 'event', e.event, 'at', e.created_at, 'detail', e.detail) order by e.id)
                         from (select * from public.wa_flow_events where run_id = r.id order by id desc limit 80) e), '[]'::jsonb)) x
      from public.wa_flow_runs r
      left join public.crm_contacts ct on ct.id = r.crm_contact_id
     where r.flow_id = p_flow_id
     order by r.started_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)) q), '[]'::jsonb);
end $$;

-- Iniciar manualmente (contatos do CRM e/ou números). Teste: is_test, 1 número, fluxo pode estar em rascunho.
create or replace function public.wa_flow_start(
  p_flow_id uuid, p_contact_ids uuid[] default null, p_phones text[] default null, p_test boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  f public.wa_flows;
  v_phones text[];
  v_phone text;
  v_i int := 0;
  v_queued int := 0;
  v_skipped int := 0;
  v_delay int := 0;
begin
  select * into f from public.wa_flows where id = p_flow_id;
  if f.id is null or not idx_private.crm_can(f.tenant_id, 'write') then raise exception 'Automação não encontrada'; end if;
  if f.status = 'archived' then raise exception 'Automação arquivada'; end if;
  if not p_test and f.status <> 'active' then raise exception 'Ative a automação antes de iniciar para contatos'; end if;
  if not exists (select 1 from public.whatsapp_instances where tenant_id = f.tenant_id and provider = 'gateway') then
    raise exception 'Conecte o WhatsApp do CRO antes';
  end if;

  select array_agg(distinct p) into v_phones from (
    select idx_private.normalize_phone(x) p from unnest(coalesce(p_phones, '{}')) x
    union all
    select c.phone from public.crm_contacts c where c.tenant_id = f.tenant_id and c.id = any(coalesce(p_contact_ids, '{}')) and c.phone is not null
  ) s where p is not null;
  v_phones := coalesce(v_phones, '{}');
  if cardinality(v_phones) = 0 then raise exception 'Nenhum número válido'; end if;
  if p_test and cardinality(v_phones) > 1 then raise exception 'O teste é para um número só'; end if;
  if cardinality(v_phones) > 200 then raise exception 'No máximo 200 contatos por vez (para listas grandes use Disparos)'; end if;

  foreach v_phone in array v_phones loop
    v_i := v_i + 1;
    if exists (select 1 from public.wa_optouts where tenant_id = f.tenant_id and phone = v_phone) then
      v_skipped := v_skipped + 1; continue;
    end if;
    -- proteção anti-bloqueio: contatos iniciados juntos saem espaçados (25–60s)
    insert into public.wa_flow_queue (tenant_id, kind, phone, flow_id, payload, not_before)
    values (f.tenant_id, 'manual', v_phone, f.id,
            jsonb_build_object('test', p_test, 'started_by', auth.uid()), now() + make_interval(secs => v_delay));
    v_delay := v_delay + 25 + floor(random() * 36)::int;
    v_queued := v_queued + 1;
  end loop;
  return jsonb_build_object('queued', v_queued, 'skipped_optout', v_skipped, 'spread_minutes', round(v_delay / 60.0));
end $$;

create or replace function public.wa_flow_cancel_run(p_run_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.wa_flow_runs;
begin
  select * into r from public.wa_flow_runs where id = p_run_id;
  if r.id is null or not idx_private.crm_can(r.tenant_id, 'write') then raise exception 'Execução não encontrada'; end if;
  update public.wa_flow_runs set status = 'cancelled', finished_at = now(), last_error = 'Cancelada por um usuário', locked_until = null
   where id = r.id and status in ('running', 'waiting');
  update public.wa_outbox set status = 'canceled', error = 'Automação cancelada'
   where flow_run_id = r.id and status = 'queued';
end $$;

-- Atendente assume a conversa (robôs param) ou devolve ao robô
create or replace function public.wa_conversation_bot(p_conversation_id uuid, p_mode text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.whatsapp_conversations where id = p_conversation_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Conversa não encontrada'; end if;
  if p_mode not in ('bot', 'human') then raise exception 'Modo inválido'; end if;
  update public.whatsapp_conversations set bot_mode = p_mode, bot_paused_until = null, updated_at = now() where id = p_conversation_id;
  if p_mode = 'human' then
    update public.wa_flow_runs r set status = 'cancelled', finished_at = now(), last_error = 'Atendente assumiu a conversa'
     where r.tenant_id = v_tenant and r.conversation_id = p_conversation_id and r.status in ('running', 'waiting') and not r.is_test;
  end if;
end $$;

-- 10. Funções do servidor (Edge Function com chave de serviço) ----------------
-- Pega acontecimentos da fila (com trava, para dois processamentos não pegarem o mesmo)
create or replace function public.wa_flow_claim_queue(p_limit int default 50)
returns setof public.wa_flow_queue
language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_flow_queue q set locked_until = now() + interval '2 minutes', attempts = attempts + 1
   where q.id in (select id from public.wa_flow_queue
                   where processed_at is null and not_before <= now() and coalesce(locked_until, '-infinity') < now()
                   order by id limit greatest(1, least(p_limit, 200))
                   for update skip locked)
  returning q.*
$$;

-- Execuções cuja espera venceu
create or replace function public.wa_flow_claim_due(p_limit int default 50)
returns setof public.wa_flow_runs
language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_flow_runs r set locked_until = now() + interval '2 minutes'
   where r.id in (select id from public.wa_flow_runs
                   where status in ('running', 'waiting') and resume_at is not null and resume_at <= now()
                     and coalesce(locked_until, '-infinity') < now()
                   order by resume_at limit greatest(1, least(p_limit, 200))
                   for update skip locked)
  returning r.*
$$;

-- Trava uma execução específica (resposta do contato chegou)
create or replace function public.wa_flow_lock_run(p_run_id uuid)
returns public.wa_flow_runs
language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_flow_runs set locked_until = now() + interval '2 minutes'
   where id = p_run_id and status in ('running', 'waiting') and coalesce(locked_until, '-infinity') < now()
  returning *
$$;

-- Contato do CRM para o número (cria se não existir)
create or replace function public.wa_flow_contact(p_tenant_id uuid, p_phone text, p_name text default null)
returns uuid
language sql security definer set search_path = public, pg_temp
as $$
  select idx_private.crm_contact_for_phone(p_tenant_id, p_phone, p_name, null, 'whatsapp', 'unknown', null)
$$;

-- 11. Motor do WhatsApp: mensagens de fluxo saem como as manuais (com mídia) ---------
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
                              'media_url', o.media_url, 'media_type', o.media_type, 'file_name', o.file_name);
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
      'phone', v_phone, 'body', nullif(o.body, ''), 'type', coalesce(o.media_type, 'text'),
      'wa_message_id', p_wa_message_id, 'ts', now()));
  elsif p_retry and o.attempts < 3 then
    if o.source in ('manual', 'flow') then
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
    if o.flow_run_id is not null then
      insert into public.wa_flow_events (tenant_id, flow_id, run_id, event, detail)
      select o.tenant_id, r.flow_id, r.id, 'send_failed', jsonb_build_object('error', left(coalesce(p_error, 'Falha no envio'), 200))
        from public.wa_flow_runs r where r.id = o.flow_run_id;
    end if;
  end if;
end $$;

-- 12. Permissões ----------------------------------------------------------------
revoke all on function idx_private.wa_flows_listening(uuid) from public;
revoke all on function public.wa_flow_claim_queue(int) from public, anon, authenticated;
revoke all on function public.wa_flow_claim_due(int) from public, anon, authenticated;
revoke all on function public.wa_flow_lock_run(uuid) from public, anon, authenticated;
revoke all on function public.wa_flow_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.wa_flow_claim_queue(int) to service_role;
grant execute on function public.wa_flow_claim_due(int) to service_role;
grant execute on function public.wa_flow_lock_run(uuid) to service_role;
grant execute on function public.wa_flow_contact(uuid, text, text) to service_role;

grant execute on function public.wa_flow_save(uuid, uuid, text, jsonb, text, text, int, int) to authenticated;
grant execute on function public.wa_flow_set_status(uuid, text) to authenticated;
grant execute on function public.wa_flow_duplicate(uuid) to authenticated;
grant execute on function public.wa_flow_list(uuid) to authenticated;
grant execute on function public.wa_flow_stats(uuid) to authenticated;
grant execute on function public.wa_flow_runs_list(uuid, int) to authenticated;
grant execute on function public.wa_flow_start(uuid, uuid[], text[], boolean) to authenticated;
grant execute on function public.wa_flow_cancel_run(uuid) to authenticated;
grant execute on function public.wa_conversation_bot(uuid, text) to authenticated;
