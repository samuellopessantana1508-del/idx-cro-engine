-- ============================================================================
-- CRM IDX — Cadências, Metas, Registro de atividades e Assistente (IA)
-- ----------------------------------------------------------------------------
-- Migration ADITIVA (não apaga nem altera dados existentes):
--   * crm_activity_events  — ligações e reuniões marcadas (base das metas)
--   * crm_cadences/_steps/_enrollments — sequências de ligação/WhatsApp/tarefa.
--     WhatsApp NUNCA é enviado automaticamente: a cadência cria a tarefa com o
--     texto pronto e o vendedor envia com um toque.
--   * crm_goals + crm_goals_progress — metas por empresa ou vendedor
--   * crm_assistant_apply — aplica (após confirmação do usuário) o plano que a
--     IA montou a partir de um áudio/texto. Nunca marca venda ganha/perdida.
--   * crm_dial_set_outcome ganha data/hora do retorno ou reunião e objeção.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Registro de atividades (ligações / reuniões marcadas)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_activity_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('call', 'meeting_booked', 'whatsapp')),
  ref_table text,
  ref_id uuid,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_activity_events_tenant on public.crm_activity_events(tenant_id, kind, occurred_at);
create index if not exists idx_crm_activity_events_ref on public.crm_activity_events(ref_id) where ref_id is not null;

alter table public.crm_activity_events enable row level security;
drop policy if exists crm_activity_events_select on public.crm_activity_events;
create policy crm_activity_events_select on public.crm_activity_events for select to authenticated
  using (idx_private.crm_can(tenant_id, 'read'));
grant select on public.crm_activity_events to authenticated;

create or replace function idx_private.crm_log_event(p_tenant uuid, p_user uuid, p_kind text, p_ref_table text, p_ref uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into public.crm_activity_events(tenant_id, user_id, kind, ref_table, ref_id)
  select p_tenant, p_user, p_kind, p_ref_table, p_ref
  where auth.uid() is null or idx_private.crm_can(p_tenant, 'write');
$$;
revoke all on function idx_private.crm_log_event(uuid, uuid, text, text, uuid) from public;
grant execute on function idx_private.crm_log_event(uuid, uuid, text, text, uuid) to authenticated, service_role;

-- histórico já existente do discador (uma ligação por número já ligado)
insert into public.crm_activity_events(tenant_id, user_id, kind, ref_table, ref_id, occurred_at)
select l.tenant_id, l.called_by, 'call', 'crm_dial_leads', l.id, l.called_at
from public.crm_dial_leads l
where l.called_at is not null
  and not exists (select 1 from public.crm_activity_events e where e.ref_id = l.id and e.kind = 'call');
insert into public.crm_activity_events(tenant_id, user_id, kind, ref_table, ref_id, occurred_at)
select l.tenant_id, l.called_by, 'meeting_booked', 'crm_dial_leads', l.id, l.called_at
from public.crm_dial_leads l
where l.outcome = 'meeting'
  and not exists (select 1 from public.crm_activity_events e where e.ref_id = l.id and e.kind = 'meeting_booked');

-- ---------------------------------------------------------------------------
-- Cadências
-- ---------------------------------------------------------------------------
create table if not exists public.crm_cadences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  active boolean not null default true,
  stop_on_reply boolean not null default true,
  stop_on_deal_close boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, id)
);

create table if not exists public.crm_cadence_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cadence_id uuid not null,
  position int not null check (position >= 0),
  wait_days int not null default 0 check (wait_days between 0 and 90),
  channel text not null check (channel in ('call', 'whatsapp', 'email', 'task')),
  title text,
  template text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, cadence_id) references public.crm_cadences(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_cadence_steps on public.crm_cadence_steps(cadence_id, position);

create table if not exists public.crm_cadence_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cadence_id uuid not null,
  contact_id uuid not null,
  deal_id uuid,
  owner_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  current_step_id uuid,
  steps_done int not null default 0,
  stop_reason text,
  enrolled_by uuid references auth.users(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, cadence_id) references public.crm_cadences(tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete set null (deal_id)
);
create unique index if not exists crm_cadence_enrollments_one_active
  on public.crm_cadence_enrollments(cadence_id, contact_id) where status = 'active';
create index if not exists idx_crm_cadence_enrollments_contact on public.crm_cadence_enrollments(contact_id, status);
create index if not exists idx_crm_cadence_enrollments_cadence on public.crm_cadence_enrollments(cadence_id, status);

alter table public.crm_tasks add column if not exists cadence_enrollment_id uuid;
alter table public.crm_tasks add column if not exists cadence_step_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_tasks_cadence_enrollment_fk') then
    alter table public.crm_tasks add constraint crm_tasks_cadence_enrollment_fk
      foreign key (cadence_enrollment_id) references public.crm_cadence_enrollments(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_tasks_cadence_step_fk') then
    alter table public.crm_tasks add constraint crm_tasks_cadence_step_fk
      foreign key (cadence_step_id) references public.crm_cadence_steps(id) on delete set null;
  end if;
end $$;
create index if not exists idx_crm_tasks_cadence on public.crm_tasks(cadence_enrollment_id) where cadence_enrollment_id is not null;

drop trigger if exists trg_crm_cadences_updated on public.crm_cadences;
create trigger trg_crm_cadences_updated before update on public.crm_cadences
for each row execute function idx_private.touch_updated_at();
drop trigger if exists trg_crm_cadence_enrollments_updated on public.crm_cadence_enrollments;
create trigger trg_crm_cadence_enrollments_updated before update on public.crm_cadence_enrollments
for each row execute function idx_private.touch_updated_at();

alter table public.crm_cadences enable row level security;
alter table public.crm_cadence_steps enable row level security;
alter table public.crm_cadence_enrollments enable row level security;

drop policy if exists crm_cadences_select on public.crm_cadences;
create policy crm_cadences_select on public.crm_cadences for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_cadences_write on public.crm_cadences;
create policy crm_cadences_write on public.crm_cadences for all to authenticated
  using (idx_private.crm_can(tenant_id, 'configure')) with check (idx_private.crm_can(tenant_id, 'configure'));

drop policy if exists crm_cadence_steps_select on public.crm_cadence_steps;
create policy crm_cadence_steps_select on public.crm_cadence_steps for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_cadence_steps_write on public.crm_cadence_steps;
create policy crm_cadence_steps_write on public.crm_cadence_steps for all to authenticated
  using (idx_private.crm_can(tenant_id, 'configure')) with check (idx_private.crm_can(tenant_id, 'configure'));

drop policy if exists crm_cadence_enrollments_select on public.crm_cadence_enrollments;
create policy crm_cadence_enrollments_select on public.crm_cadence_enrollments for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
-- inscrições só mudam pelas funções abaixo (que validam permissão)

grant select, insert, update, delete on public.crm_cadences, public.crm_cadence_steps to authenticated;
grant select on public.crm_cadence_enrollments to authenticated;

create or replace function idx_private.crm_tenant_tz(p_tenant uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce((select nullif(timezone, '') from public.tenants where id = p_tenant), 'America/Sao_Paulo') $$;

-- "Esperar N dias": N=0 → agora; N>0 → às 9h (fuso da empresa) daqui a N dias
create or replace function idx_private.crm_cadence_due(p_tenant uuid, p_wait int)
returns timestamptz language plpgsql stable set search_path = public, pg_temp
as $$
declare v_tz text := idx_private.crm_tenant_tz(p_tenant);
begin
  if coalesce(p_wait, 0) <= 0 then return now(); end if;
  return (date_trunc('day', now() at time zone v_tz) + make_interval(days => p_wait) + interval '9 hours') at time zone v_tz;
end $$;

create or replace function idx_private.crm_cadence_render(p_template text, p_contact uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare c record; v text := coalesce(p_template, '');
begin
  select ct.name, ct.city, co.name as company into c
    from public.crm_contacts ct left join public.crm_companies co on co.id = ct.company_id
   where ct.id = p_contact;
  v := replace(v, '{nome}', coalesce(c.name, ''));
  v := replace(v, '{primeiro_nome}', coalesce(split_part(trim(coalesce(c.name, '')), ' ', 1), ''));
  v := replace(v, '{empresa}', coalesce(c.company, c.name, ''));
  v := replace(v, '{cidade}', coalesce(c.city, ''));
  return nullif(trim(v), '');
end $$;

create or replace function idx_private.crm_cadence_make_task(p_enrollment uuid, p_step uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare e public.crm_cadence_enrollments; s public.crm_cadence_steps; v_name text; v_id uuid; v_title text;
begin
  select * into e from public.crm_cadence_enrollments where id = p_enrollment;
  select * into s from public.crm_cadence_steps where id = p_step;
  select coalesce(name, phone, 'contato') into v_name from public.crm_contacts where id = e.contact_id;
  v_title := coalesce(nullif(trim(s.title), ''), case s.channel
    when 'call' then 'Ligar' when 'whatsapp' then 'WhatsApp' when 'email' then 'E-mail' else 'Tarefa' end) || ': ' || v_name;
  insert into public.crm_tasks(tenant_id, task_type, title, description, owner_id, contact_id, deal_id, due_at, priority,
                               cadence_enrollment_id, cadence_step_id, created_by)
  values (e.tenant_id, case s.channel when 'task' then 'follow_up' else s.channel end, left(v_title, 200),
          idx_private.crm_cadence_render(s.template, e.contact_id), e.owner_id, e.contact_id, e.deal_id,
          idx_private.crm_cadence_due(e.tenant_id, s.wait_days), 'normal', e.id, s.id, e.enrolled_by)
  returning id into v_id;
  update public.crm_cadence_enrollments set current_step_id = s.id where id = e.id;
  return v_id;
end $$;

create or replace function idx_private.crm_cadence_finish(p_enrollment uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare e public.crm_cadence_enrollments; v_cad text;
begin
  update public.crm_cadence_enrollments
     set status = p_status, stop_reason = p_reason, finished_at = now()
   where id = p_enrollment and status = 'active'
  returning * into e;
  if e.id is null then return; end if;
  -- tarefas abertas da cadência deixam de valer
  update public.crm_tasks set status = 'canceled', outcome = coalesce(outcome, 'Cadência ' || case p_status when 'completed' then 'concluída' else 'encerrada' end)
   where cadence_enrollment_id = e.id and status = 'open';
  select name into v_cad from public.crm_cadences where id = e.cadence_id;
  insert into public.crm_timeline(tenant_id, contact_id, deal_id, kind, title, body, metadata, actor_id)
  values (e.tenant_id, e.contact_id, e.deal_id, 'automation',
          case p_status when 'completed' then 'Cadência concluída: ' else 'Cadência encerrada: ' end || coalesce(v_cad, ''),
          case p_reason when 'reply' then 'O contato respondeu no WhatsApp.' when 'deal_won' then 'Negociação ganha.'
            when 'deal_lost' then 'Negociação perdida.' when 'task_canceled' then 'Tarefa da cadência cancelada.'
            when 'manual' then 'Encerrada manualmente.' else p_reason end,
          jsonb_build_object('cadence_id', e.cadence_id, 'enrollment_id', e.id, 'reason', p_reason), auth.uid());
end $$;

create or replace function public.crm_cadence_enroll(p_cadence_id uuid, p_contact_ids uuid[], p_deal_id uuid default null, p_owner_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.crm_cadences; v_first uuid; v_contact uuid; v_enr uuid; v_ok int := 0; v_skip int := 0;
begin
  select * into c from public.crm_cadences where id = p_cadence_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Cadência não encontrada ou sem permissão'; end if;
  if not c.active or c.archived_at is not null then raise exception 'Esta cadência está pausada'; end if;
  if coalesce(array_length(p_contact_ids, 1), 0) = 0 then raise exception 'Escolha ao menos um contato'; end if;
  if array_length(p_contact_ids, 1) > 500 then raise exception 'Inscreva no máximo 500 contatos por vez'; end if;
  select id into v_first from public.crm_cadence_steps where cadence_id = c.id order by position limit 1;
  if v_first is null then raise exception 'Adicione ao menos um passo na cadência'; end if;
  if p_deal_id is not null and not exists (select 1 from public.crm_deals where id = p_deal_id and tenant_id = c.tenant_id) then
    raise exception 'Negociação inválida';
  end if;

  foreach v_contact in array p_contact_ids loop
    if not exists (select 1 from public.crm_contacts where id = v_contact and tenant_id = c.tenant_id and merged_into_id is null)
       or exists (select 1 from public.crm_cadence_enrollments where cadence_id = c.id and contact_id = v_contact and status = 'active') then
      v_skip := v_skip + 1; continue;
    end if;
    insert into public.crm_cadence_enrollments(tenant_id, cadence_id, contact_id, deal_id, owner_id, enrolled_by)
    values (c.tenant_id, c.id, v_contact, p_deal_id,
            coalesce(p_owner_id, (select owner_id from public.crm_contacts where id = v_contact), auth.uid()), auth.uid())
    returning id into v_enr;
    perform idx_private.crm_cadence_make_task(v_enr, v_first);
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, kind, title, metadata, actor_id)
    values (c.tenant_id, v_contact, p_deal_id, 'automation', 'Entrou na cadência: ' || c.name,
            jsonb_build_object('cadence_id', c.id, 'enrollment_id', v_enr), auth.uid());
    v_ok := v_ok + 1;
  end loop;
  return jsonb_build_object('enrolled', v_ok, 'skipped', v_skip);
end $$;

create or replace function public.crm_cadence_stop(p_enrollment_id uuid, p_reason text default 'manual')
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.crm_cadence_enrollments where id = p_enrollment_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Inscrição não encontrada ou sem permissão'; end if;
  perform idx_private.crm_cadence_finish(p_enrollment_id, 'stopped', coalesce(nullif(trim(p_reason), ''), 'manual'));
end $$;

-- Avanço: tarefa da cadência concluída → próximo passo; cancelada → encerra
create or replace function idx_private.crm_cadence_on_task()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare e public.crm_cadence_enrollments; v_pos int; v_next uuid;
begin
  if new.cadence_enrollment_id is null or new.status = old.status then return new; end if;
  select * into e from public.crm_cadence_enrollments where id = new.cadence_enrollment_id;
  if e.id is null or e.status <> 'active' then return new; end if;
  if new.status = 'done' then
    select position into v_pos from public.crm_cadence_steps where id = new.cadence_step_id;
    update public.crm_cadence_enrollments set steps_done = steps_done + 1 where id = e.id;
    select id into v_next from public.crm_cadence_steps
     where cadence_id = e.cadence_id and position > coalesce(v_pos, -1) order by position limit 1;
    if v_next is null then
      perform idx_private.crm_cadence_finish(e.id, 'completed', 'completed');
    else
      perform idx_private.crm_cadence_make_task(e.id, v_next);
    end if;
  elsif new.status = 'canceled' then
    perform idx_private.crm_cadence_finish(e.id, 'stopped', 'task_canceled');
  end if;
  return new;
end $$;
drop trigger if exists trg_crm_tasks_cadence on public.crm_tasks;
create trigger trg_crm_tasks_cadence after update of status on public.crm_tasks
for each row execute function idx_private.crm_cadence_on_task();

-- Parar quando o contato responde no WhatsApp (nunca quebra a entrada da mensagem)
create or replace function idx_private.crm_cadence_on_reply()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_phone text; v_key text; e record; v_name text;
begin
  if new.direction <> 'inbound' then return new; end if;
  begin
    select wc.phone into v_phone from public.whatsapp_conversations c
      join public.whatsapp_contacts wc on wc.id = c.contact_id where c.id = new.conversation_id;
    v_phone := idx_private.normalize_phone(coalesce(v_phone, new.sender_phone));
    if v_phone is null then return new; end if;
    v_key := idx_private.phone_match_key(v_phone);
    for e in
      select en.id, en.owner_id, en.contact_id from public.crm_cadence_enrollments en
        join public.crm_cadences cd on cd.id = en.cadence_id and cd.stop_on_reply
        join public.crm_contacts ct on ct.id = en.contact_id
       where en.tenant_id = new.tenant_id and en.status = 'active'
         and (ct.phone = v_phone or ct.phone_match_key = v_key or idx_private.normalize_phone(ct.whatsapp) = v_phone)
    loop
      perform idx_private.crm_cadence_finish(e.id, 'stopped', 'reply');
      select name into v_name from public.crm_contacts where id = e.contact_id;
      if e.owner_id is not null then
        insert into public.crm_notifications(tenant_id, user_id, title, body, severity, link_type, link_id, dedup_key)
        values (new.tenant_id, e.owner_id, coalesce(v_name, 'Contato') || ' respondeu no WhatsApp',
                'A cadência foi pausada para você continuar a conversa.', 'info', 'contact', e.contact_id, 'cad-reply-' || e.id)
        on conflict do nothing;
      end if;
    end loop;
  exception when others then
    raise warning 'crm_cadence_on_reply: %', sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists trg_wa_messages_cadence_reply on public.whatsapp_messages;
create trigger trg_wa_messages_cadence_reply after insert on public.whatsapp_messages
for each row execute function idx_private.crm_cadence_on_reply();

-- Parar quando a negociação é ganha/perdida
create or replace function idx_private.crm_cadence_on_deal()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare e record;
begin
  if new.status = old.status or new.status not in ('won', 'lost') then return new; end if;
  for e in
    select en.id from public.crm_cadence_enrollments en join public.crm_cadences cd on cd.id = en.cadence_id
     where en.tenant_id = new.tenant_id and en.status = 'active'
       and (en.deal_id = new.id or (cd.stop_on_deal_close and new.contact_id is not null and en.contact_id = new.contact_id))
  loop
    perform idx_private.crm_cadence_finish(e.id, 'stopped', 'deal_' || new.status);
  end loop;
  return new;
end $$;
drop trigger if exists trg_crm_deals_cadence on public.crm_deals;
create trigger trg_crm_deals_cadence after update of status on public.crm_deals
for each row execute function idx_private.crm_cadence_on_deal();

-- Lista de cadências com contadores
create or replace function public.crm_cadence_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'description', c.description, 'active', c.active,
      'stop_on_reply', c.stop_on_reply, 'stop_on_deal_close', c.stop_on_deal_close,
      'steps', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'wait_days', s.wait_days,
                         'channel', s.channel, 'title', s.title, 'template', s.template) order by s.position)
                         from public.crm_cadence_steps s where s.cadence_id = c.id), '[]'::jsonb),
      'active_count', (select count(*) from public.crm_cadence_enrollments e where e.cadence_id = c.id and e.status = 'active'),
      'completed_count', (select count(*) from public.crm_cadence_enrollments e where e.cadence_id = c.id and e.status = 'completed'),
      'replied_count', (select count(*) from public.crm_cadence_enrollments e where e.cadence_id = c.id and e.stop_reason = 'reply'),
      'won_count', (select count(*) from public.crm_cadence_enrollments e where e.cadence_id = c.id and e.stop_reason = 'deal_won')
    ) order by c.created_at)
    from public.crm_cadences c where c.tenant_id = p_tenant_id and c.archived_at is null), '[]'::jsonb);
end $$;

create or replace function public.crm_cadence_enrollments_list(p_tenant_id uuid, p_cadence_id uuid default null, p_contact_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'enrolled_at' desc) from (
      select jsonb_build_object('id', e.id, 'cadence_id', e.cadence_id, 'cadence_name', cd.name, 'contact_id', e.contact_id,
        'contact_name', ct.name, 'contact_phone', ct.phone, 'status', e.status, 'stop_reason', e.stop_reason,
        'steps_done', e.steps_done, 'steps_total', (select count(*) from public.crm_cadence_steps s where s.cadence_id = e.cadence_id),
        'current_step', (select jsonb_build_object('channel', s.channel, 'title', s.title) from public.crm_cadence_steps s where s.id = e.current_step_id),
        'next_due_at', (select min(t.due_at) from public.crm_tasks t where t.cadence_enrollment_id = e.id and t.status = 'open'),
        'owner_id', e.owner_id, 'enrolled_at', e.enrolled_at, 'finished_at', e.finished_at) as x
      from public.crm_cadence_enrollments e
      join public.crm_cadences cd on cd.id = e.cadence_id
      join public.crm_contacts ct on ct.id = e.contact_id
      where e.tenant_id = p_tenant_id
        and (p_cadence_id is null or e.cadence_id = p_cadence_id)
        and (p_contact_id is null or e.contact_id = p_contact_id)
      order by e.enrolled_at desc limit 300) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Metas
-- ---------------------------------------------------------------------------
create table if not exists public.crm_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  metric text not null check (metric in ('won_value', 'won_count', 'deals_created', 'meetings', 'calls')),
  scope text not null default 'company' check (scope in ('company', 'user')),
  user_id uuid references auth.users(id) on delete cascade,
  period text not null default 'month' check (period in ('week', 'month', 'quarter')),
  target numeric(14,2) not null check (target > 0),
  pipeline_id uuid,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (scope = 'company' or user_id is not null)
);
create index if not exists idx_crm_goals_tenant on public.crm_goals(tenant_id) where archived_at is null;
drop trigger if exists trg_crm_goals_updated on public.crm_goals;
create trigger trg_crm_goals_updated before update on public.crm_goals
for each row execute function idx_private.touch_updated_at();
alter table public.crm_goals enable row level security;
drop policy if exists crm_goals_select on public.crm_goals;
create policy crm_goals_select on public.crm_goals for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_goals_write on public.crm_goals;
create policy crm_goals_write on public.crm_goals for all to authenticated
  using (idx_private.crm_can(tenant_id, 'configure')) with check (idx_private.crm_can(tenant_id, 'configure'));
grant select, insert, update, delete on public.crm_goals to authenticated;

create or replace function idx_private.crm_metric_by_user(p_tenant uuid, p_metric text, p_from timestamptz, p_to timestamptz, p_pipeline uuid)
returns table(user_id uuid, actual numeric) language sql stable security definer set search_path = public, pg_temp
as $$
  select owner_id, sum(value) from public.crm_deals
   where p_metric = 'won_value' and tenant_id = p_tenant and status = 'won' and won_at >= p_from and won_at < p_to
     and (p_pipeline is null or pipeline_id = p_pipeline) group by owner_id
  union all
  select owner_id, count(*) from public.crm_deals
   where p_metric = 'won_count' and tenant_id = p_tenant and status = 'won' and won_at >= p_from and won_at < p_to
     and (p_pipeline is null or pipeline_id = p_pipeline) group by owner_id
  union all
  select owner_id, count(*) from public.crm_deals
   where p_metric = 'deals_created' and tenant_id = p_tenant and created_at >= p_from and created_at < p_to
     and (p_pipeline is null or pipeline_id = p_pipeline) group by owner_id
  union all
  select e.user_id, count(*) from public.crm_activity_events e
   where p_metric in ('meetings', 'calls') and e.tenant_id = p_tenant
     and e.kind = case p_metric when 'meetings' then 'meeting_booked' else 'call' end
     and e.occurred_at >= p_from and e.occurred_at < p_to group by e.user_id
$$;

create or replace function public.crm_goals_progress(p_tenant_id uuid, p_ref date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_tz text := idx_private.crm_tenant_tz(p_tenant_id);
  v_ref date := coalesce(p_ref, (now() at time zone v_tz)::date);
  g record; v_start date; v_end date; v_from timestamptz; v_to timestamptz;
  v_out jsonb := '[]'::jsonb; v_actual numeric; v_by jsonb; v_elapsed numeric;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  for g in select * from public.crm_goals where tenant_id = p_tenant_id and archived_at is null and active order by created_at loop
    v_start := date_trunc(g.period, v_ref)::date;
    v_end := (v_start + case g.period when 'week' then interval '1 week' when 'quarter' then interval '3 months' else interval '1 month' end)::date;
    v_from := v_start::timestamp at time zone v_tz;
    v_to := v_end::timestamp at time zone v_tz;
    v_elapsed := least(1, greatest(0, extract(epoch from (now() - v_from)) / nullif(extract(epoch from (v_to - v_from)), 0)));

    select coalesce(sum(m.actual) filter (where g.scope = 'company' or m.user_id = g.user_id), 0),
           coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'actual', m.actual) order by m.actual desc)
                    filter (where g.scope = 'company'), '[]'::jsonb)
      into v_actual, v_by
      from idx_private.crm_metric_by_user(p_tenant_id, g.metric, v_from, v_to, g.pipeline_id) m;

    v_out := v_out || jsonb_build_object(
      'id', g.id, 'name', g.name, 'metric', g.metric, 'scope', g.scope, 'user_id', g.user_id, 'period', g.period,
      'pipeline_id', g.pipeline_id, 'target', g.target, 'actual', v_actual,
      'pct', round(100 * v_actual / g.target, 1), 'elapsed_pct', round(100 * v_elapsed, 1),
      'period_start', v_start, 'period_end', v_end - 1, 'by_user', v_by);
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Discador: ligação/reunião entram no registro de atividades; resultado aceita
-- data do retorno/reunião e objeção.
-- ---------------------------------------------------------------------------
alter table public.crm_dial_leads add column if not exists objection text;

create or replace function public.crm_dial_mark_called(p_id uuid)
returns public.crm_dial_leads
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare r public.crm_dial_leads;
begin
  update public.crm_dial_leads
     set status = 'called', called_at = now(), called_by = auth.uid(), call_count = call_count + 1
   where id = p_id
  returning * into r;
  if r.id is null then raise exception 'Número não encontrado ou sem permissão'; end if;
  perform idx_private.crm_log_event(r.tenant_id, auth.uid(), 'call', 'crm_dial_leads', r.id);
  if r.contact_id is not null then
    insert into public.crm_timeline(tenant_id, contact_id, kind, title, body, actor_id)
    values (r.tenant_id, r.contact_id, 'call_log', 'Ligação pelo discador', null, auth.uid());
  end if;
  return r;
end;
$$;

create or replace function public.crm_dial_reset(p_id uuid)
returns public.crm_dial_leads
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare r public.crm_dial_leads;
begin
  update public.crm_dial_leads set status = 'pending', outcome = null where id = p_id returning * into r;
  if r.id is null then raise exception 'Número não encontrado ou sem permissão'; end if;
  perform idx_private.crm_undo_dial_events(r.id);
  return r;
end;
$$;

-- desfazer: retira a última ligação registrada desse número (e a reunião, se houver)
create or replace function idx_private.crm_undo_dial_events(p_lead uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  delete from public.crm_activity_events where id in (
    select e.id from public.crm_activity_events e
     where e.ref_id = p_lead and e.kind = 'call' and e.user_id = auth.uid() and idx_private.crm_can(e.tenant_id, 'write')
     order by e.occurred_at desc limit 1);
  delete from public.crm_activity_events e
   where e.ref_id = p_lead and e.kind = 'meeting_booked' and idx_private.crm_can(e.tenant_id, 'write');
$$;
revoke all on function idx_private.crm_undo_dial_events(uuid) from public;
grant execute on function idx_private.crm_undo_dial_events(uuid) to authenticated;

drop function if exists public.crm_dial_set_outcome(uuid, text, text);
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

  if p_outcome = 'meeting' then
    if v_prev is distinct from 'meeting' then
      perform idx_private.crm_log_event(r.tenant_id, auth.uid(), 'meeting_booked', 'crm_dial_leads', r.id);
    end if;
    if r.contact_id is not null and not exists (select 1 from public.crm_deals where contact_id = r.contact_id and status = 'open') then
      select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = r.tenant_id;
      v_pipeline := coalesce(v_pipeline, idx_private.crm_ensure_defaults(r.tenant_id));
      insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id, source_channel, attribution_basis)
      values (r.tenant_id, v_pipeline,
              coalesce(idx_private.crm_stage_for_legacy(r.tenant_id, v_pipeline, 'qualified'), idx_private.crm_stage_for_legacy(r.tenant_id, v_pipeline, 'new')),
              'Reunião — ' || r.name, r.contact_id,
              (select company_id from public.crm_contacts where id = r.contact_id), auth.uid(), 'outbound', 'known');
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

-- reuniões agendadas fora do discador (tarefa do tipo reunião) também contam
create or replace function idx_private.crm_task_events()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.task_type = 'meeting' and coalesce(current_setting('idx.skip_meeting_event', true), '') <> '1' then
      perform idx_private.crm_log_event(new.tenant_id, coalesce(new.owner_id, new.created_by, auth.uid()), 'meeting_booked', 'crm_tasks', new.id);
    end if;
  elsif new.status = 'done' and old.status <> 'done' and new.task_type in ('call', 'callback', 'whatsapp') then
    perform idx_private.crm_log_event(new.tenant_id, coalesce(new.completed_by, auth.uid(), new.owner_id),
      case when new.task_type = 'whatsapp' then 'whatsapp' else 'call' end, 'crm_tasks', new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_crm_tasks_events on public.crm_tasks;
create trigger trg_crm_tasks_events after insert or update of status on public.crm_tasks
for each row execute function idx_private.crm_task_events();

-- ---------------------------------------------------------------------------
-- Assistente: aplica o plano confirmado pelo usuário (áudio/texto → CRM)
-- p_plan = { source, transcript, dial_lead_id, dial_outcome, contact_id,
--            contact:{name,phone,company,email,city,uf},
--            deal:{action:'create'|'update'|'none', deal_id, title, value, stage_id},
--            task:{type,title,due_at,notes}, note, objection }
-- ---------------------------------------------------------------------------
create or replace function public.crm_assistant_apply(p_tenant_id uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_lead public.crm_dial_leads;
  v_contact uuid := nullif(p_plan->>'contact_id', '')::uuid;
  v_company uuid;
  v_deal uuid;
  v_task uuid;
  v_pipeline uuid;
  v_stage uuid;
  v_kind text;
  c jsonb := coalesce(p_plan->'contact', '{}'::jsonb);
  d jsonb := coalesce(p_plan->'deal', '{}'::jsonb);
  t jsonb := p_plan->'task';
  v_phone text := idx_private.normalize_phone(c->>'phone');
  v_note text := nullif(trim(coalesce(p_plan->>'note', '')), '');
  v_obj text := nullif(trim(coalesce(p_plan->>'objection', '')), '');
  v_due timestamptz := nullif(t->>'due_at', '')::timestamptz;
  v_value numeric := nullif(d->>'value', '')::numeric;
  v_task_type text := coalesce(nullif(t->>'type', ''), 'follow_up');
begin
  if v_uid is null or not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para registrar no CRM'; end if;
  if v_value is not null and v_value < 0 then raise exception 'Valor inválido'; end if;
  if v_task_type not in ('call', 'meeting', 'follow_up', 'callback', 'task', 'proposal', 'email', 'whatsapp', 'visit', 'other') then
    v_task_type := 'follow_up';
  end if;

  -- 1) Ligação do discador: registra o resultado (cria contato/negociação como o botão faria)
  if nullif(p_plan->>'dial_lead_id', '') is not null then
    select * into v_lead from public.crm_dial_leads where id = (p_plan->>'dial_lead_id')::uuid and tenant_id = p_tenant_id;
    if v_lead.id is null then raise exception 'Número do discador não encontrado'; end if;
    if nullif(p_plan->>'dial_outcome', '') is not null then
      select * into v_lead from public.crm_dial_set_outcome(v_lead.id, p_plan->>'dial_outcome', v_note,
        case when p_plan->>'dial_outcome' in ('callback', 'meeting') then v_due end, v_obj);
      -- a tarefa de retorno/reunião já foi criada com a data informada
      if p_plan->>'dial_outcome' in ('callback', 'meeting') then t := null; end if;
    end if;
    v_contact := coalesce(v_contact, v_lead.contact_id);
  end if;

  -- 2) Contato: escolhido > mesmo telefone > novo
  if v_contact is not null and not exists (select 1 from public.crm_contacts where id = v_contact and tenant_id = p_tenant_id) then
    raise exception 'Contato inválido';
  end if;
  if v_contact is null and v_phone is not null then
    select id into v_contact from public.crm_contacts
     where tenant_id = p_tenant_id and merged_into_id is null
       and (phone = v_phone or phone_match_key = idx_private.phone_match_key(v_phone))
     order by created_at limit 1;
  end if;
  if nullif(trim(coalesce(c->>'company', '')), '') is not null then
    select id into v_company from public.crm_companies
     where tenant_id = p_tenant_id and lower(name) = lower(trim(c->>'company')) limit 1;
    if v_company is null then
      insert into public.crm_companies(tenant_id, name, city, state, phone, owner_id)
      values (p_tenant_id, left(trim(c->>'company'), 200), nullif(trim(c->>'city'), ''), upper(nullif(trim(c->>'uf'), '')), v_phone, v_uid)
      returning id into v_company;
    end if;
  end if;
  if v_contact is null and (v_phone is not null or nullif(trim(coalesce(c->>'name', '')), '') is not null) then
    insert into public.crm_contacts(tenant_id, name, phone, email, company_id, city, state, owner_id, source_channel, acquisition_basis)
    values (p_tenant_id, left(coalesce(nullif(trim(c->>'name'), ''), trim(c->>'company'), v_phone), 200), v_phone,
            nullif(trim(lower(c->>'email')), ''), v_company, nullif(trim(c->>'city'), ''), upper(nullif(trim(c->>'uf'), '')),
            v_uid, 'manual', 'unknown')
    returning id into v_contact;
  elsif v_contact is not null and v_company is not null then
    update public.crm_contacts set company_id = coalesce(company_id, v_company) where id = v_contact;
  end if;

  -- 3) Negociação (nunca ganha/perdida por aqui: só etapas "em andamento")
  if d->>'action' = 'create' then
    if v_contact is null then raise exception 'Informe o contato para criar a negociação'; end if;
    select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = p_tenant_id;
    v_pipeline := coalesce(v_pipeline, idx_private.crm_ensure_defaults(p_tenant_id));
    v_stage := nullif(d->>'stage_id', '')::uuid;
    if v_stage is not null then
      select kind, pipeline_id into v_kind, v_pipeline from public.crm_stages where id = v_stage and tenant_id = p_tenant_id and archived_at is null;
      if v_kind is distinct from 'open' then raise exception 'A IA só pode usar etapas em andamento — marque venda ganha/perdida manualmente'; end if;
    else
      select id into v_stage from public.crm_stages where pipeline_id = v_pipeline and kind = 'open' and archived_at is null order by position limit 1;
    end if;
    -- já existe negociação aberta para o contato? atualiza em vez de duplicar
    select id into v_deal from public.crm_deals where tenant_id = p_tenant_id and contact_id = v_contact and status = 'open'
     order by created_at desc limit 1;
    if v_deal is not null then
      update public.crm_deals set value = case when coalesce(v_value, 0) > 0 then v_value else value end,
             stage_id = case when nullif(d->>'stage_id', '') is not null then v_stage else stage_id end
       where id = v_deal;
    else
    insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id, value)
    values (p_tenant_id, v_pipeline, v_stage,
            left(coalesce(nullif(trim(d->>'title'), ''), (select coalesce(name, 'Negociação') from public.crm_contacts where id = v_contact)), 200),
            v_contact, coalesce(v_company, (select company_id from public.crm_contacts where id = v_contact)), v_uid, coalesce(v_value, 0))
    returning id into v_deal;
    end if;
  elsif d->>'action' = 'update' and nullif(d->>'deal_id', '') is not null then
    select id into v_deal from public.crm_deals where id = (d->>'deal_id')::uuid and tenant_id = p_tenant_id and status = 'open';
    if v_deal is null then raise exception 'Negociação não encontrada ou já encerrada'; end if;
    v_stage := nullif(d->>'stage_id', '')::uuid;
    if v_stage is not null then
      select kind into v_kind from public.crm_stages where id = v_stage and tenant_id = p_tenant_id and archived_at is null;
      if v_kind is distinct from 'open' then raise exception 'A IA só pode usar etapas em andamento — marque venda ganha/perdida manualmente'; end if;
    end if;
    update public.crm_deals set stage_id = coalesce(v_stage, stage_id), value = coalesce(v_value, value) where id = v_deal;
  end if;

  -- 4) Tarefa
  if t is not null and jsonb_typeof(t) = 'object' and (nullif(t->>'title', '') is not null or v_due is not null) then
    insert into public.crm_tasks(tenant_id, task_type, title, description, owner_id, contact_id, deal_id, due_at, priority, created_by)
    values (p_tenant_id, v_task_type,
            left(coalesce(nullif(trim(t->>'title'), ''), 'Próximo passo') ||
                 coalesce(': ' || (select name from public.crm_contacts where id = v_contact and position(name in coalesce(t->>'title', '')) = 0), ''), 200),
            nullif(trim(coalesce(t->>'notes', '')), ''), v_uid, v_contact, v_deal,
            coalesce(v_due, now() + interval '1 day'), 'normal', v_uid)
    returning id into v_task;
  end if;

  -- 5) Registro na linha do tempo (o resultado do discador já registrou o próprio)
  if v_contact is not null and (v_lead.id is null or nullif(p_plan->>'dial_outcome', '') is null)
     and (v_note is not null or nullif(p_plan->>'transcript', '') is not null) then
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, kind, title, body, metadata, actor_id)
    values (p_tenant_id, v_contact, v_deal, 'note',
            case p_plan->>'source' when 'voice' then 'Registro por voz' else 'Registro rápido' end,
            nullif(concat_ws(E'\n', v_note, 'Objeção: ' || v_obj), ''),
            jsonb_build_object('via', 'assistant', 'source', p_plan->>'source', 'transcript', left(p_plan->>'transcript', 4000)), v_uid);
  end if;

  return jsonb_build_object('contact_id', v_contact, 'deal_id', v_deal, 'task_id', v_task, 'dial_lead_id', v_lead.id);
end $$;

-- ---------------------------------------------------------------------------
-- Busca rápida por telefone (extensão do WhatsApp Web / assistente)
-- ---------------------------------------------------------------------------
create or replace function public.crm_lookup_phone(p_tenant_id uuid, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_phone text := idx_private.normalize_phone(p_phone); v_id uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  if v_phone is null then return null; end if;
  select id into v_id from public.crm_contacts
   where tenant_id = p_tenant_id and merged_into_id is null
     and (phone = v_phone or phone_match_key = idx_private.phone_match_key(v_phone) or whatsapp = v_phone)
   order by created_at limit 1;
  if v_id is null then return null; end if;
  return (
    select jsonb_build_object(
      'id', ct.id, 'name', ct.name, 'phone', ct.phone, 'email', ct.email, 'city', ct.city, 'state', ct.state,
      'lifecycle_stage', ct.lifecycle_stage, 'tags', ct.tags, 'notes', ct.notes, 'owner_id', ct.owner_id,
      'company', (select jsonb_build_object('id', co.id, 'name', co.name) from public.crm_companies co where co.id = ct.company_id),
      'deals', coalesce((select jsonb_agg(jsonb_build_object('id', dl.id, 'title', dl.title, 'value', dl.value, 'status', dl.status,
                 'stage_id', dl.stage_id, 'stage_name', st.name, 'pipeline_id', dl.pipeline_id) order by dl.status = 'open' desc, dl.updated_at desc)
                 from public.crm_deals dl join public.crm_stages st on st.id = dl.stage_id
                 where dl.contact_id = ct.id), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'due_at', tk.due_at, 'task_type', tk.task_type,
                 'description', tk.description) order by tk.due_at nulls last)
                 from public.crm_tasks tk where tk.contact_id = ct.id and tk.status = 'open'), '[]'::jsonb),
      'timeline', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('title', tl.title, 'body', tl.body, 'occurred_at', tl.occurred_at) x
                   from public.crm_timeline tl where tl.contact_id = ct.id order by tl.occurred_at desc limit 5) q), '[]'::jsonb),
      'cadences', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', cd.name))
                 from public.crm_cadence_enrollments e join public.crm_cadences cd on cd.id = e.cadence_id
                 where e.contact_id = ct.id and e.status = 'active'), '[]'::jsonb)
    ) from public.crm_contacts ct where ct.id = v_id);
end $$;

grant execute on function public.crm_cadence_enroll(uuid, uuid[], uuid, uuid) to authenticated;
grant execute on function public.crm_cadence_stop(uuid, text) to authenticated;
grant execute on function public.crm_cadence_overview(uuid) to authenticated;
grant execute on function public.crm_cadence_enrollments_list(uuid, uuid, uuid) to authenticated;
grant execute on function public.crm_goals_progress(uuid, date) to authenticated;
grant execute on function public.crm_assistant_apply(uuid, jsonb) to authenticated;
grant execute on function public.crm_lookup_phone(uuid, text) to authenticated;
revoke execute on function public.crm_cadence_enroll(uuid, uuid[], uuid, uuid) from anon;
revoke execute on function public.crm_cadence_stop(uuid, text) from anon;
revoke execute on function public.crm_cadence_overview(uuid) from anon;
revoke execute on function public.crm_cadence_enrollments_list(uuid, uuid, uuid) from anon;
revoke execute on function public.crm_goals_progress(uuid, date) from anon;
revoke execute on function public.crm_assistant_apply(uuid, jsonb) from anon;
revoke execute on function public.crm_lookup_phone(uuid, text) from anon;

notify pgrst, 'reload schema';
