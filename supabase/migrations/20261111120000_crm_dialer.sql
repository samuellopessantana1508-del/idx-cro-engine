-- ============================================================================
-- CRM IDX — Discador (listas de prospecção por telefone)
-- ----------------------------------------------------------------------------
-- Migration ADITIVA. Listas de números para ligar (ex.: farmácias da base aberta
-- de CNPJ da Receita Federal). Um toque no número abre a ligação e marca como
-- "ligado". O resultado (reunião, retornar, sem interesse...) pode virar
-- contato + negociação/tarefa no CRM, sem cadastro duplicado.
-- ============================================================================

create table if not exists public.crm_dial_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_name text not null default 'Farmácias',
  name text not null,
  phone text not null,
  phone2 text,
  city text,
  uf text,
  district text,
  cnpj text,
  source text not null default 'import',
  status text not null default 'pending' check (status in ('pending', 'called')),
  outcome text check (outcome is null or outcome in ('talked', 'meeting', 'callback', 'no_answer', 'not_interested', 'invalid')),
  called_at timestamptz,
  called_by uuid references auth.users(id) on delete set null,
  call_count integer not null default 0,
  notes text,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_dial_leads_unique_phone unique (tenant_id, list_name, phone)
);

create index if not exists idx_crm_dial_leads_queue on public.crm_dial_leads(tenant_id, list_name, status, uf, city, name);
create index if not exists idx_crm_dial_leads_called on public.crm_dial_leads(tenant_id, called_at desc) where called_at is not null;
create index if not exists idx_crm_dial_leads_cnpj on public.crm_dial_leads(tenant_id, cnpj) where cnpj is not null;

drop trigger if exists trg_crm_dial_leads_updated on public.crm_dial_leads;
create trigger trg_crm_dial_leads_updated before update on public.crm_dial_leads
for each row execute function idx_private.touch_updated_at();

alter table public.crm_dial_leads enable row level security;
drop policy if exists crm_dial_leads_select on public.crm_dial_leads;
create policy crm_dial_leads_select on public.crm_dial_leads for select to authenticated
  using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_dial_leads_insert on public.crm_dial_leads;
create policy crm_dial_leads_insert on public.crm_dial_leads for insert to authenticated
  with check (idx_private.crm_can(tenant_id, 'write'));
drop policy if exists crm_dial_leads_update on public.crm_dial_leads;
create policy crm_dial_leads_update on public.crm_dial_leads for update to authenticated
  using (idx_private.crm_can(tenant_id, 'write')) with check (idx_private.crm_can(tenant_id, 'write'));
drop policy if exists crm_dial_leads_delete on public.crm_dial_leads;
create policy crm_dial_leads_delete on public.crm_dial_leads for delete to authenticated
  using (idx_private.crm_can(tenant_id, 'delete'));
grant select, insert, update, delete on public.crm_dial_leads to authenticated;

-- ---------------------------------------------------------------------------
-- Marcar como ligado (um toque no número)
-- ---------------------------------------------------------------------------
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
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resultado da ligação. "Reunião" e "Retornar" viram contato no CRM
-- (com empresa), e respectivamente negociação ou tarefa de retorno.
-- ---------------------------------------------------------------------------
create or replace function public.crm_dial_set_outcome(p_id uuid, p_outcome text, p_notes text default null)
returns public.crm_dial_leads
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  r public.crm_dial_leads;
  v_company uuid;
  v_contact uuid;
  v_pipeline uuid;
  v_tz text;
  v_label text;
begin
  if p_outcome is not null and p_outcome not in ('talked', 'meeting', 'callback', 'no_answer', 'not_interested', 'invalid') then
    raise exception 'Resultado inválido';
  end if;
  update public.crm_dial_leads
     set outcome = p_outcome, notes = coalesce(nullif(trim(p_notes), ''), notes),
         status = 'called', called_at = coalesce(called_at, now()), called_by = coalesce(called_by, auth.uid())
   where id = p_id
  returning * into r;
  if r.id is null then raise exception 'Número não encontrado ou sem permissão'; end if;

  v_label := case p_outcome when 'meeting' then 'Reunião marcada' when 'callback' then 'Pediu retorno'
    when 'talked' then 'Conversou' when 'no_answer' then 'Não atendeu' when 'not_interested' then 'Sem interesse'
    when 'invalid' then 'Número inválido' else 'Ligação' end;

  if p_outcome in ('meeting', 'callback', 'talked') and r.contact_id is null then
    -- empresa (pelo CNPJ, se houver) e contato, reaproveitando cadastro existente pelo telefone
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
    insert into public.crm_timeline(tenant_id, contact_id, kind, title, body, actor_id)
    values (r.tenant_id, r.contact_id, 'call_log', 'Discador: ' || v_label, nullif(trim(p_notes), ''), auth.uid());
  end if;

  if p_outcome = 'meeting' and r.contact_id is not null
     and not exists (select 1 from public.crm_deals where contact_id = r.contact_id and status = 'open') then
    select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = r.tenant_id;
    v_pipeline := coalesce(v_pipeline, idx_private.crm_ensure_defaults(r.tenant_id));
    insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id, source_channel, attribution_basis)
    values (r.tenant_id, v_pipeline,
            coalesce(idx_private.crm_stage_for_legacy(r.tenant_id, v_pipeline, 'qualified'), idx_private.crm_stage_for_legacy(r.tenant_id, v_pipeline, 'new')),
            'Reunião — ' || r.name, r.contact_id,
            (select company_id from public.crm_contacts where id = r.contact_id), auth.uid(), 'outbound', 'known');
  end if;

  if p_outcome = 'callback' and r.contact_id is not null then
    select coalesce(timezone, 'America/Sao_Paulo') into v_tz from public.tenants where id = r.tenant_id;
    insert into public.crm_tasks(tenant_id, task_type, title, description, contact_id, owner_id, due_at, priority)
    values (r.tenant_id, 'call', 'Retornar ligação: ' || r.name, nullif(trim(p_notes), ''), r.contact_id, auth.uid(),
            (date_trunc('day', now() at time zone v_tz) + interval '1 day 9 hours') at time zone v_tz, 'high');
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Importação em lote (CSV pelo painel). Duplicados (mesmo telefone na mesma
-- lista) são ignorados.
-- ---------------------------------------------------------------------------
create or replace function public.crm_dial_import(p_tenant_id uuid, p_list text, p_rows jsonb, p_source text default 'import')
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_list text := coalesce(nullif(trim(p_list), ''), 'Farmácias');
  v_total int := coalesce(jsonb_array_length(p_rows), 0);
  v_valid int;
  v_inserted int;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para importar'; end if;
  if v_total > 5000 then raise exception 'Envie no máximo 5000 linhas por vez'; end if;

  create temp table _dial_in on commit drop as
  select * from (
    select left(coalesce(nullif(trim(x->>'nome'), ''), nullif(trim(x->>'name'), ''), 'Sem nome'), 200) as name,
           idx_private.normalize_phone(coalesce(x->>'telefone', x->>'phone')) as phone,
           idx_private.normalize_phone(coalesce(x->>'telefone2', x->>'phone2')) as phone2,
           nullif(trim(coalesce(x->>'cidade', x->>'city')), '') as city,
           upper(nullif(trim(x->>'uf'), '')) as uf,
           nullif(trim(coalesce(x->>'bairro', x->>'district')), '') as district,
           nullif(regexp_replace(coalesce(x->>'cnpj', ''), '\D', '', 'g'), '') as cnpj
    from jsonb_array_elements(p_rows) x
  ) s where phone is not null;
  get diagnostics v_valid = row_count;

  insert into public.crm_dial_leads(tenant_id, list_name, name, phone, phone2, city, uf, district, cnpj, source)
  select distinct on (phone) p_tenant_id, v_list, name, phone, phone2, city, uf, district, cnpj, coalesce(p_source, 'import') from _dial_in
  on conflict (tenant_id, list_name, phone) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('total', v_total, 'inserted', v_inserted, 'duplicates', v_valid - v_inserted, 'invalid', v_total - v_valid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Painel do discador: listas, contadores e UFs
-- ---------------------------------------------------------------------------
create or replace function public.crm_dial_overview(p_tenant_id uuid, p_list text default null)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp
as $$
  with l as (
    select * from public.crm_dial_leads
    where tenant_id = p_tenant_id and (p_list is null or list_name = p_list)
  )
  select jsonb_build_object(
    'lists', coalesce((select jsonb_agg(jsonb_build_object('name', list_name, 'total', n, 'pending', p) order by list_name)
                       from (select list_name, count(*) n, count(*) filter (where status = 'pending') p
                             from public.crm_dial_leads where tenant_id = p_tenant_id group by list_name) x), '[]'::jsonb),
    'total', (select count(*) from l),
    'pending', (select count(*) from l where status = 'pending'),
    'called', (select count(*) from l where status = 'called'),
    'called_today', (select count(*) from l where called_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'),
    'meetings', (select count(*) from l where outcome = 'meeting'),
    'callbacks', (select count(*) from l where outcome = 'callback'),
    'ufs', coalesce((select jsonb_agg(jsonb_build_object('uf', uf, 'total', n, 'pending', p) order by uf)
                     from (select uf, count(*) n, count(*) filter (where status = 'pending') p from l where uf is not null group by uf) u), '[]'::jsonb)
  );
$$;

grant execute on function public.crm_dial_mark_called(uuid) to authenticated;
grant execute on function public.crm_dial_reset(uuid) to authenticated;
grant execute on function public.crm_dial_set_outcome(uuid, text, text) to authenticated;
grant execute on function public.crm_dial_import(uuid, text, jsonb, text) to authenticated;
grant execute on function public.crm_dial_overview(uuid, text) to authenticated;
