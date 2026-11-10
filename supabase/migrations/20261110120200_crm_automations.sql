-- ============================================================================
-- CRM IDX — Automações internas (gatilho → condições → ações) com histórico
-- ----------------------------------------------------------------------------
-- Somente ações INTERNAS: criar tarefa, notificar usuário, etiquetar,
-- atribuir responsável, criar onboarding, incluir em campanha.
-- NÃO há ação de envio de WhatsApp/e-mail: disparos externos exigem
-- configuração, consentimento e autorização explícitos e não fazem parte deste
-- motor. As regras modelo nascem DESATIVADAS — a empresa valida e liga.
-- Uma falha em uma regra nunca desfaz a operação comercial que a disparou:
-- o erro é registrado em crm_automation_runs.
-- ============================================================================

create table if not exists public.crm_automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  trigger_event text not null check (trigger_event in (
    'deal_created', 'deal_stage_changed', 'deal_won', 'deal_lost', 'deal_stale',
    'contact_created', 'first_purchase', 'repeat_purchase', 'rfv_segment_changed', 'task_overdue')),
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  template_key text,
  run_count int not null default 0,
  error_count int not null default 0,
  last_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, template_key)
);

create table if not exists public.crm_automation_runs (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  rule_id uuid references public.crm_automation_rules(id) on delete cascade,
  event text not null,
  record_type text,
  record_id uuid,
  status text not null check (status in ('success', 'skipped', 'error')),
  message text,
  actions_result jsonb not null default '[]'::jsonb,
  dedup_key text,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_automation_runs on public.crm_automation_runs(tenant_id, created_at desc);
create unique index if not exists crm_automation_runs_dedup on public.crm_automation_runs(rule_id, dedup_key) where dedup_key is not null and status = 'success';

alter table public.crm_settings add column if not exists last_scheduled_run_at timestamptz;

create or replace function idx_private.crm_automation_rule_validate()
returns trigger language plpgsql set search_path = pg_temp
as $$
declare a jsonb;
begin
  if jsonb_typeof(new.actions) <> 'array' then
    raise exception 'actions precisa ser uma lista.' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(new.actions) loop
    if coalesce(a->>'type', '') not in ('create_task', 'notify', 'add_tag', 'assign_owner', 'create_onboarding', 'add_to_campaign') then
      raise exception 'Ação de automação não permitida: %. Disparos externos (WhatsApp/e-mail) não são executados automaticamente.', a->>'type' using errcode = '22023';
    end if;
  end loop;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_crm_automation_rules_validate on public.crm_automation_rules;
create trigger trg_crm_automation_rules_validate before insert or update on public.crm_automation_rules
for each row execute function idx_private.crm_automation_rule_validate();

-- Resolve destinatário: dono do registro, usuário fixo ou administradores
create or replace function idx_private.crm_resolve_user(p_tenant_id uuid, p_spec text, p_record_owner uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp stable
as $$
declare u uuid;
begin
  if p_spec is null or p_spec = 'record_owner' then
    if p_record_owner is not null then return p_record_owner; end if;
    p_spec := 'admin';
  end if;
  if p_spec like 'user:%' then
    u := nullif(substr(p_spec, 6), '')::uuid;
    if idx_private.is_tenant_member(p_tenant_id, u) then return u; end if;
    return null;
  end if;
  select tu.user_id into u from public.tenant_users tu
  where tu.tenant_id = p_tenant_id and tu.status = 'active' and tu.user_id is not null
    and (tu.role in ('owner', 'admin') or tu.crm_role = 'manager')
  order by case tu.role when 'owner' then 0 when 'admin' then 1 else 2 end, tu.created_at
  limit 1;
  return u;
end;
$$;

-- Executa as regras ativas de um evento
create or replace function idx_private.crm_fire_event(p_tenant_id uuid, p_event text, p_record_type text, p_record_id uuid, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rule record;
  act jsonb;
  results jsonb;
  ctx record;
  v_contact uuid; v_deal uuid; v_company uuid; v_owner uuid; v_title text; v_pipeline uuid; v_stage uuid; v_source text; v_value numeric;
  v_user uuid; v_dedup text; v_task uuid; cond jsonb; ok boolean; skip_reason text;
begin
  -- contexto do registro
  if p_record_type = 'deal' then
    select d.contact_id, d.id, d.company_id, d.owner_id, d.title, d.pipeline_id, d.stage_id, d.source_channel, d.value
      into v_contact, v_deal, v_company, v_owner, v_title, v_pipeline, v_stage, v_source, v_value
    from public.crm_deals d where d.id = p_record_id;
  elsif p_record_type = 'contact' then
    select c.id, c.company_id, c.owner_id, coalesce(c.name, c.phone, c.email), c.source_channel
      into v_contact, v_company, v_owner, v_title, v_source
    from public.crm_contacts c where c.id = p_record_id;
  elsif p_record_type = 'order' then
    select o.contact_id, o.deal_id, o.company_id, coalesce(o.owner_id, c.owner_id), coalesce(c.name, c.phone, 'Cliente'), o.net_amount
      into v_contact, v_deal, v_company, v_owner, v_title, v_value
    from public.crm_orders o left join public.crm_contacts c on c.id = o.contact_id where o.id = p_record_id;
  elsif p_record_type = 'task' then
    select t.contact_id, t.deal_id, t.company_id, t.owner_id, t.title into v_contact, v_deal, v_company, v_owner, v_title
    from public.crm_tasks t where t.id = p_record_id;
  end if;

  for rule in
    select * from public.crm_automation_rules r
    where r.tenant_id = p_tenant_id and r.enabled and r.trigger_event = p_event
    order by r.created_at
  loop
    begin
      cond := rule.conditions;
      ok := true; skip_reason := null;
      if cond ? 'pipeline_id' and v_pipeline is distinct from (cond->>'pipeline_id')::uuid then ok := false; skip_reason := 'funil diferente'; end if;
      if ok and cond ? 'to_stage_id' and coalesce(p_payload->>'to_stage_id', v_stage::text) is distinct from cond->>'to_stage_id' then ok := false; skip_reason := 'etapa diferente'; end if;
      if ok and cond ? 'source_channel' and v_source is distinct from cond->>'source_channel' then ok := false; skip_reason := 'origem diferente'; end if;
      if ok and cond ? 'min_value' and coalesce(v_value, 0) < (cond->>'min_value')::numeric then ok := false; skip_reason := 'valor abaixo do mínimo'; end if;
      if ok and cond ? 'segments' and not (coalesce(p_payload->>'segment', '') = any (array(select jsonb_array_elements_text(cond->'segments')))) then
        ok := false; skip_reason := 'segmento diferente';
      end if;

      v_dedup := p_event || ':' || coalesce(p_record_id::text, '') || ':' || coalesce(p_payload->>'dedup', p_payload->>'to_stage_id', p_payload->>'segment', '');

      if not ok then
        insert into public.crm_automation_runs(tenant_id, rule_id, event, record_type, record_id, status, message)
        values (p_tenant_id, rule.id, p_event, p_record_type, p_record_id, 'skipped', skip_reason);
        continue;
      end if;

      if exists (select 1 from public.crm_automation_runs x where x.rule_id = rule.id and x.dedup_key = v_dedup and x.status = 'success') then
        continue; -- já executada para este mesmo fato (idempotência)
      end if;

      results := '[]'::jsonb;
      for act in select * from jsonb_array_elements(rule.actions) loop
        if act->>'type' = 'create_task' then
          v_user := idx_private.crm_resolve_user(p_tenant_id, act->>'assign_to', v_owner);
          insert into public.crm_tasks(tenant_id, task_type, title, description, owner_id, contact_id, deal_id, company_id, due_at, priority, automation_rule_id)
          values (p_tenant_id, coalesce(act->>'task_type', 'follow_up'),
                  replace(coalesce(act->>'title', 'Acompanhar'), '{nome}', coalesce(v_title, '')),
                  act->>'description', v_user, v_contact, v_deal, v_company,
                  now() + make_interval(hours => coalesce((act->>'due_in_hours')::int, 24)),
                  coalesce(act->>'priority', 'normal'), rule.id)
          returning id into v_task;
          results := results || jsonb_build_object('type', 'create_task', 'task_id', v_task, 'owner_id', v_user);
        elsif act->>'type' = 'notify' then
          v_user := idx_private.crm_resolve_user(p_tenant_id, act->>'to', v_owner);
          if v_user is not null then
            insert into public.crm_notifications(tenant_id, user_id, title, body, severity, link_type, link_id, dedup_key)
            values (p_tenant_id, v_user, replace(coalesce(act->>'title', rule.name), '{nome}', coalesce(v_title, '')),
                    replace(coalesce(act->>'body', ''), '{nome}', coalesce(v_title, '')),
                    coalesce(act->>'severity', 'info'),
                    case when v_deal is not null then 'deal' when v_contact is not null then 'contact' end,
                    coalesce(v_deal, v_contact), rule.id::text || ':' || v_dedup)
            on conflict do nothing;
          end if;
          results := results || jsonb_build_object('type', 'notify', 'user_id', v_user);
        elsif act->>'type' = 'add_tag' then
          if v_deal is not null and p_record_type = 'deal' then
            update public.crm_deals set tags = array(select distinct unnest(tags || array[act->>'tag'])) where id = v_deal;
          elsif v_contact is not null then
            update public.crm_contacts set tags = array(select distinct unnest(tags || array[act->>'tag'])) where id = v_contact;
          end if;
          results := results || jsonb_build_object('type', 'add_tag', 'tag', act->>'tag');
        elsif act->>'type' = 'assign_owner' then
          if v_deal is not null and v_owner is null then
            if act->>'strategy' = 'round_robin' then
              select tu.user_id into v_user from public.tenant_users tu
              where tu.tenant_id = p_tenant_id and tu.status = 'active' and tu.user_id is not null
                and tu.role = 'operator' and coalesce(tu.crm_role, 'sales') = 'sales'
              order by (select count(*) from public.crm_deals d where d.owner_id = tu.user_id and d.status = 'open' and d.tenant_id = p_tenant_id), tu.created_at
              limit 1;
            else
              v_user := idx_private.crm_resolve_user(p_tenant_id, act->>'user', null);
            end if;
            if v_user is not null then
              update public.crm_deals set owner_id = v_user where id = v_deal and owner_id is null;
              v_owner := v_user;
            end if;
          end if;
          results := results || jsonb_build_object('type', 'assign_owner', 'owner_id', v_owner);
        elsif act->>'type' = 'create_onboarding' then
          if v_contact is not null then
            insert into public.crm_onboardings(tenant_id, contact_id, company_id, deal_id, owner_id, title, status, checklist)
            values (p_tenant_id, v_contact, v_company, v_deal, v_owner,
                    coalesce(act->>'title', 'Onboarding de ' || coalesce(v_title, 'cliente')), 'not_started',
                    coalesce((select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'label', l, 'done', false))
                              from jsonb_array_elements_text(act->'checklist') l), '[]'::jsonb))
            on conflict do nothing;
          end if;
          results := results || jsonb_build_object('type', 'create_onboarding');
        elsif act->>'type' = 'add_to_campaign' then
          if v_contact is not null and act ? 'campaign_id' then
            insert into public.crm_campaign_members(tenant_id, campaign_id, contact_id, segment_at_entry)
            values (p_tenant_id, (act->>'campaign_id')::uuid, v_contact, p_payload->>'segment')
            on conflict do nothing;
          end if;
          results := results || jsonb_build_object('type', 'add_to_campaign');
        end if;
      end loop;

      insert into public.crm_automation_runs(tenant_id, rule_id, event, record_type, record_id, status, actions_result, dedup_key)
      values (p_tenant_id, rule.id, p_event, p_record_type, p_record_id, 'success', results, v_dedup);
      update public.crm_automation_rules set run_count = run_count + 1, last_run_at = now() where id = rule.id;
      insert into public.crm_timeline(tenant_id, contact_id, deal_id, company_id, kind, title, metadata)
      values (p_tenant_id, v_contact, v_deal, v_company, 'automation', 'Automação: ' || rule.name,
              jsonb_build_object('rule_id', rule.id, 'results', results));
    exception when others then
      -- registra a falha sem derrubar a operação comercial
      insert into public.crm_automation_runs(tenant_id, rule_id, event, record_type, record_id, status, message)
      values (p_tenant_id, rule.id, p_event, p_record_type, p_record_id, 'error', left(sqlerrm, 500));
      update public.crm_automation_rules set error_count = error_count + 1, last_run_at = now() where id = rule.id;
    end;
  end loop;
end;
$$;

-- Gatilhos de negociação e contato
create or replace function idx_private.crm_deal_automation_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform idx_private.crm_fire_event(new.tenant_id, 'deal_created', 'deal', new.id, '{}'::jsonb);
  elsif new.stage_id is distinct from old.stage_id then
    perform idx_private.crm_fire_event(new.tenant_id, 'deal_stage_changed', 'deal', new.id,
      jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id));
    if new.status = 'won' and old.status <> 'won' then
      perform idx_private.crm_fire_event(new.tenant_id, 'deal_won', 'deal', new.id, '{}'::jsonb);
    elsif new.status = 'lost' and old.status <> 'lost' then
      perform idx_private.crm_fire_event(new.tenant_id, 'deal_lost', 'deal', new.id, '{}'::jsonb);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_crm_deals_automation on public.crm_deals;
create trigger trg_crm_deals_automation after insert or update of stage_id on public.crm_deals
for each row execute function idx_private.crm_deal_automation_trigger();

create or replace function idx_private.crm_contact_automation_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.crm_fire_event(new.tenant_id, 'contact_created', 'contact', new.id, '{}'::jsonb);
  return new;
end;
$$;
drop trigger if exists trg_crm_contacts_automation on public.crm_contacts;
create trigger trg_crm_contacts_automation after insert on public.crm_contacts
for each row execute function idx_private.crm_contact_automation_trigger();

-- Rotinas periódicas: negociações paradas e tarefas atrasadas.
-- O painel chama no máximo 1x por hora por empresa; para cron use crm_run_scheduled_all().
create or replace function public.crm_run_scheduled(p_tenant_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.crm_settings;
  d record;
  t record;
  n_stale int := 0;
  n_overdue int := 0;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  select * into s from public.crm_settings where tenant_id = p_tenant_id;
  if not found then return jsonb_build_object('skipped', 'no_settings'); end if;
  if not p_force and s.last_scheduled_run_at is not null and s.last_scheduled_run_at > now() - interval '1 hour' then
    return jsonb_build_object('skipped', 'recent');
  end if;
  update public.crm_settings set last_scheduled_run_at = now() where tenant_id = p_tenant_id;

  for d in
    select dl.id from public.crm_deals dl
    join public.crm_stages st on st.id = dl.stage_id
    where dl.tenant_id = p_tenant_id and dl.status = 'open' and dl.archived_at is null
      and dl.next_activity_at is null
      and coalesce(dl.last_activity_at, dl.stage_entered_at, dl.created_at)
          < now() - make_interval(days => coalesce(st.rotting_days, s.stale_deal_days))
  loop
    perform idx_private.crm_fire_event(p_tenant_id, 'deal_stale', 'deal', d.id,
      jsonb_build_object('dedup', to_char(now(), 'IYYY-IW')));
    n_stale := n_stale + 1;
  end loop;

  for t in
    select tk.id from public.crm_tasks tk
    where tk.tenant_id = p_tenant_id and tk.status = 'open' and tk.due_at < now() - interval '1 hour'
  loop
    perform idx_private.crm_fire_event(p_tenant_id, 'task_overdue', 'task', t.id, jsonb_build_object('dedup', to_char(now(), 'YYYY-MM-DD')));
    n_overdue := n_overdue + 1;
  end loop;

  if exists (select 1 from public.crm_rfv_settings r where r.tenant_id = p_tenant_id and (r.dirty or r.last_computed_at is null or r.last_computed_at < now() - interval '20 hours')) then
    perform public.crm_compute_rfv(p_tenant_id);
  end if;

  return jsonb_build_object('stale_deals', n_stale, 'overdue_tasks', n_overdue);
end;
$$;
revoke all on function public.crm_run_scheduled(uuid, boolean) from public;
grant execute on function public.crm_run_scheduled(uuid, boolean) to authenticated, service_role;

create or replace function public.crm_run_scheduled_all()
returns int language plpgsql security definer set search_path = public, pg_temp
as $$
declare t record; n int := 0;
begin
  for t in select id from public.tenants where status = 'active' loop
    perform public.crm_run_scheduled(t.id, true);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.crm_run_scheduled_all() from public, authenticated;
grant execute on function public.crm_run_scheduled_all() to service_role;

-- Regras modelo (desativadas)
create or replace function idx_private.crm_seed_automation_templates(p_tenant_id uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into public.crm_automation_rules(tenant_id, template_key, name, description, trigger_event, conditions, actions, enabled) values
  (p_tenant_id, 'new_deal_first_contact', 'Nova negociação: primeiro contato',
   'Cria tarefa de primeiro contato em 1 hora para o responsável (ou para o administrador, se não houver responsável).',
   'deal_created', '{}'::jsonb,
   '[{"type":"create_task","task_type":"follow_up","title":"Primeiro contato com {nome}","due_in_hours":1,"priority":"high","assign_to":"record_owner"}]'::jsonb, false),
  (p_tenant_id, 'new_deal_round_robin', 'Distribuir novas negociações entre vendedores',
   'Atribui a negociação sem responsável ao vendedor com menos negociações abertas.',
   'deal_created', '{}'::jsonb, '[{"type":"assign_owner","strategy":"round_robin"}]'::jsonb, false),
  (p_tenant_id, 'stale_deal_alert', 'Negociação sem atividade',
   'Quando a negociação passa do prazo da etapa sem próxima atividade: alerta o responsável e sugere follow-up.',
   'deal_stale', '{}'::jsonb,
   '[{"type":"notify","title":"Negociação parada: {nome}","body":"Sem atividade dentro do prazo da etapa. Agende o próximo passo.","severity":"warning","to":"record_owner"},{"type":"create_task","task_type":"follow_up","title":"Retomar contato: {nome}","due_in_hours":4,"priority":"high","assign_to":"record_owner"}]'::jsonb, false),
  (p_tenant_id, 'hv_at_risk', 'Cliente de alto valor em risco',
   'Cria tarefa prioritária de diagnóstico e notifica o responsável.',
   'rfv_segment_changed', '{"segments":["high_value_at_risk"]}'::jsonb,
   '[{"type":"create_task","task_type":"call","title":"Diagnóstico de relacionamento: {nome}","due_in_hours":24,"priority":"urgent","assign_to":"record_owner"},{"type":"notify","title":"Cliente de alto valor em risco: {nome}","severity":"critical","to":"record_owner"}]'::jsonb, false),
  (p_tenant_id, 'at_risk_task', 'Cliente em risco',
   'Cria tarefa preventiva quando o cliente entra em "em risco".',
   'rfv_segment_changed', '{"segments":["at_risk"]}'::jsonb,
   '[{"type":"create_task","task_type":"follow_up","title":"Ação preventiva: {nome}","due_in_hours":48,"priority":"high","assign_to":"record_owner"}]'::jsonb, false),
  (p_tenant_id, 'hibernating_suggest', 'Cliente hibernando',
   'Notifica o responsável sugerindo incluir o cliente em uma campanha de reativação.',
   'rfv_segment_changed', '{"segments":["hibernating"]}'::jsonb,
   '[{"type":"notify","title":"Sugestão de reativação: {nome}","body":"Cliente sem compras há muito tempo. Avalie incluir em campanha de reativação.","to":"record_owner"}]'::jsonb, false),
  (p_tenant_id, 'first_purchase_onboarding', 'Novo cliente: onboarding',
   'Na primeira compra válida, cria checklist de onboarding.',
   'first_purchase', '{}'::jsonb,
   '[{"type":"create_onboarding","checklist":["Boas-vindas e alinhamento do que foi prometido","Confirmar entrega/ativação","Registrar primeiro resultado percebido","Pedir avaliação da experiência","Estimular segunda compra"]}]'::jsonb, false)
  on conflict (tenant_id, template_key) do nothing;
$$;

do $$
declare r record;
begin
  for r in select id from public.tenants loop
    perform idx_private.crm_seed_automation_templates(r.id);
  end loop;
end $$;

create or replace function idx_private.crm_tenant_after_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.crm_ensure_defaults(new.id);
  insert into public.crm_rfv_settings(tenant_id) values (new.id) on conflict do nothing;
  perform idx_private.crm_seed_automation_templates(new.id);
  return new;
end;
$$;

alter table public.crm_automation_rules enable row level security;
alter table public.crm_automation_runs enable row level security;
drop policy if exists crm_automation_rules_select on public.crm_automation_rules;
drop policy if exists crm_automation_rules_write on public.crm_automation_rules;
create policy crm_automation_rules_select on public.crm_automation_rules for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
create policy crm_automation_rules_write on public.crm_automation_rules for all to authenticated
  using (idx_private.crm_can(tenant_id, 'configure')) with check (idx_private.crm_can(tenant_id, 'configure'));
drop policy if exists crm_automation_runs_select on public.crm_automation_runs;
create policy crm_automation_runs_select on public.crm_automation_runs for select to authenticated using (idx_private.crm_can(tenant_id, 'configure'));

grant select, insert, update, delete on public.crm_automation_rules to authenticated;
grant select on public.crm_automation_runs to authenticated;
revoke all on public.crm_automation_rules, public.crm_automation_runs from anon;
grant all on public.crm_automation_rules, public.crm_automation_runs to service_role;
grant usage, select on sequence public.crm_automation_runs_id_seq to service_role;

drop trigger if exists trg_crm_automation_rules_audit on public.crm_automation_rules;
create trigger trg_crm_automation_rules_audit after insert or update or delete on public.crm_automation_rules
for each row execute function idx_private.crm_audit();
