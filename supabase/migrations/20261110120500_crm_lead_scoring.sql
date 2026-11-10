-- ============================================================================
-- CRM IDX — Lead scoring configurável (independente de RFV e de health score)
-- crm_settings.scoring = {"mql_threshold": 50, "rules": [
--   {"label": "Veio de anúncio", "field": "source_channel", "op": "in", "value": ["meta_ads","google_ads"], "points": 10},
--   {"label": "Tem e-mail", "field": "email", "op": "exists", "points": 5},
--   {"label": "Orçamento alto", "field": "qualification.budget", "op": "in", "value": ["alto"], "points": 25},
--   {"label": "Urgente", "field": "qualification.urgency", "op": "eq", "value": "alta", "points": 20},
--   {"label": "Tag VIP", "field": "tags", "op": "contains", "value": "vip", "points": 15}
-- ]}
-- Contato em "lead" com pontuação >= limite vira MQL automaticamente
-- (lifecycle_source = 'auto'); SAL e SQL continuam decisões humanas.
-- ============================================================================

create or replace function idx_private.crm_score_value(c public.crm_contacts, p_field text)
returns jsonb language plpgsql stable set search_path = public, pg_temp
as $$
begin
  if p_field like 'qualification.%' then return c.qualification -> substr(p_field, 15); end if;
  if p_field like 'custom.%' then return c.custom -> substr(p_field, 8); end if;
  return to_jsonb(c) -> p_field;
end;
$$;

create or replace function idx_private.crm_score_contact(c public.crm_contacts, p_rules jsonb)
returns table (score int, details jsonb)
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  rule jsonb; v jsonb; hit boolean; total int := 0; d jsonb := '[]'::jsonb;
begin
  for rule in select * from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    v := idx_private.crm_score_value(c, rule->>'field');
    hit := case rule->>'op'
      when 'exists' then v is not null and v <> 'null'::jsonb and v <> '""'::jsonb and v <> '[]'::jsonb
      when 'eq' then lower(v #>> '{}') = lower(rule->>'value')
      when 'in' then lower(v #>> '{}') in (select lower(x) from jsonb_array_elements_text(rule->'value') x)
      when 'contains' then case when jsonb_typeof(v) = 'array' then exists (select 1 from jsonb_array_elements_text(v) x where lower(x) = lower(rule->>'value'))
                               else position(lower(rule->>'value') in lower(coalesce(v #>> '{}', ''))) > 0 end
      when 'gte' then (v #>> '{}') ~ '^-?[0-9.]+$' and (v #>> '{}')::numeric >= (rule->>'value')::numeric
      else false end;
    if coalesce(hit, false) then
      total := total + coalesce((rule->>'points')::int, 0);
      d := d || jsonb_build_object('label', coalesce(rule->>'label', rule->>'field'), 'points', (rule->>'points')::int);
    end if;
  end loop;
  score := total; details := d;
  return next;
end;
$$;

create or replace function idx_private.crm_contact_score_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare cfg jsonb; s int; d jsonb;
begin
  select scoring into cfg from public.crm_settings where tenant_id = new.tenant_id;
  if cfg is null or jsonb_array_length(coalesce(cfg->'rules', '[]'::jsonb)) = 0 then return new; end if;
  select x.score, x.details into s, d from idx_private.crm_score_contact(new, cfg->'rules') x;
  new.lead_score := s;
  new.lead_score_details := d;
  if new.lifecycle_stage = 'lead' and s >= coalesce((cfg->>'mql_threshold')::int, 50) then
    new.lifecycle_stage := 'mql';
    new.lifecycle_source := 'auto';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_crm_contacts_score on public.crm_contacts;
-- roda depois da normalização (ordem alfabética: before_write < score)
create trigger trg_crm_contacts_score before insert or update of name, email, phone, tags, qualification, custom, source_channel, job_title, city, state, company_id, lifecycle_stage
on public.crm_contacts for each row execute function idx_private.crm_contact_score_trigger();

create or replace function public.crm_recompute_scores(p_tenant_id uuid)
returns int language plpgsql security invoker set search_path = public, pg_temp
as $$
declare n int;
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then
    raise exception 'Somente administradores e gestores.' using errcode = '42501';
  end if;
  update public.crm_contacts set tags = tags where tenant_id = p_tenant_id and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.crm_recompute_scores(uuid) from anon;
grant execute on function public.crm_recompute_scores(uuid) to authenticated;

-- Lifecycle manual registrado na linha do tempo
create or replace function idx_private.crm_contact_lifecycle_log()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.lifecycle_stage is distinct from old.lifecycle_stage then
    insert into public.crm_timeline(tenant_id, contact_id, kind, title, metadata, actor_id)
    values (new.tenant_id, new.id, 'lifecycle', 'Ciclo de vida: ' || old.lifecycle_stage || ' → ' || new.lifecycle_stage,
            jsonb_build_object('from', old.lifecycle_stage, 'to', new.lifecycle_stage, 'source', new.lifecycle_source, 'score', new.lead_score), auth.uid());
  end if;
  return null;
end;
$$;
drop trigger if exists trg_crm_contacts_lifecycle_log on public.crm_contacts;
create trigger trg_crm_contacts_lifecycle_log after update of lifecycle_stage on public.crm_contacts
for each row execute function idx_private.crm_contact_lifecycle_log();
