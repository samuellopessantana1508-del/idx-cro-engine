-- =============================================================================
-- Correção: automações agendadas falhavam em produção
-- -----------------------------------------------------------------------------
-- O banco de produção usa pg_safeupdate (recusa UPDATE sem WHERE). O cálculo de
-- RFV (crm_compute_rfv), chamado pelas automações agendadas (crm_run_scheduled),
-- fazia 4 UPDATEs numa tabela temporária sem WHERE → "UPDATE requires a WHERE
-- clause" e a rotina inteira era desfeita. Mesma função, só com "where true".
-- Não destrutiva.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.crm_compute_rfv(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  cfg public.crm_rfv_settings;
  n_customers int;
  use_quintile boolean;
  v_window_start timestamptz;
  changed int := 0;
  rec record;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  insert into public.crm_rfv_settings(tenant_id) values (p_tenant_id) on conflict do nothing;
  select * into cfg from public.crm_rfv_settings where tenant_id = p_tenant_id;
  v_window_start := case when cfg.window_days is null then null else now() - make_interval(days => cfg.window_days) end;

  create temporary table if not exists _rfv (
    contact_id uuid primary key, first_at timestamptz, last_at timestamptz, cnt int, revenue numeric,
    days_since int, avg_interval numeric, r int, f int, m int, segment text) on commit drop;
  truncate _rfv;

  insert into _rfv(contact_id, first_at, last_at, cnt, revenue)
  select o.contact_id, min(o.order_date), max(o.order_date),
         count(*) filter (where cfg.count_recurring_cycles or o.order_kind <> 'recurring_cycle'),
         sum(o.net_amount)
  from public.crm_orders o
  join public.crm_contacts c on c.id = o.contact_id and c.merged_into_id is null
  where o.tenant_id = p_tenant_id
    and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
    and (v_window_start is null or o.order_date >= v_window_start)
  group by o.contact_id;

  update _rfv set cnt = greatest(cnt, 1),
    days_since = greatest(0, floor(extract(epoch from now() - last_at) / 86400))::int,
    avg_interval = case when cnt > 1 then round((extract(epoch from last_at - first_at) / 86400.0 / (cnt - 1))::numeric, 1) end
    where true;

  select count(*) into n_customers from _rfv;
  use_quintile := cfg.method = 'quintile' or (cfg.method = 'auto' and n_customers >= cfg.min_customers_quintile);
  -- base pequena demais para quintis gera notas sem sentido: usa faixas manuais
  if n_customers < 10 then use_quintile := false; end if;

  if use_quintile then
    -- quintis da própria base para R e V; empates recebem a mesma nota
    update _rfv x set r = q.r, m = q.m from (
      select contact_id,
             least(5, greatest(1, ceil(cume_dist() over (order by days_since desc) * 5)))::int as r,
             least(5, greatest(1, ceil(cume_dist() over (order by revenue) * 5)))::int as m
      from _rfv) q
    where q.contact_id = x.contact_id;
  else
    update _rfv set
      r = case when days_since <= cfg.r_thresholds[1] then 5 when days_since <= cfg.r_thresholds[2] then 4
               when days_since <= cfg.r_thresholds[3] then 3 when days_since <= cfg.r_thresholds[4] then 2 else 1 end,
      m = case when revenue >= cfg.m_thresholds[4] then 5 when revenue >= cfg.m_thresholds[3] then 4
               when revenue >= cfg.m_thresholds[2] then 3 when revenue >= cfg.m_thresholds[1] then 2 else 1 end
    where true;
  end if;
  -- Frequência sempre por faixas: "1 compra" nunca vira nota alta por causa de empate em quintil
  update _rfv set f = case when cnt >= cfg.f_thresholds[4] then 5 when cnt >= cfg.f_thresholds[3] then 4
                           when cnt >= cfg.f_thresholds[2] then 3 when cnt >= cfg.f_thresholds[1] then 2 else 1 end
    where true;

  -- Segmentação: regras em ordem de prioridade => um único segmento por cliente.
  update _rfv set segment = case
    when days_since > cfg.lost_after_days then 'lost'
    when r <= 2 and m >= 4 then 'high_value_at_risk'
    when r >= 4 and f >= 4 and m >= 4 then 'champions'
    when r >= 3 and f >= 4 then 'loyal'
    when r >= 4 and cnt = 1 then 'new'
    when r >= 3 then 'potential'
    when r = 2 then 'at_risk'
    else 'hibernating' end
    where true;

  -- Histórico só quando algo mudou (ou primeira vez)
  insert into public.crm_rfv_history(tenant_id, contact_id, r_score, f_score, m_score, segment, previous_segment, net_revenue, purchase_count, rule_version, method_used)
  select p_tenant_id, x.contact_id, x.r, x.f, x.m, x.segment, s.segment, x.revenue, x.cnt, cfg.rule_version,
         case when use_quintile then 'quintile' else 'manual' end
  from _rfv x
  left join public.crm_rfv_scores s on s.tenant_id = p_tenant_id and s.contact_id = x.contact_id
  where s.contact_id is null or (s.r_score, s.f_score, s.m_score, s.segment) is distinct from (x.r, x.f, x.m, x.segment);
  get diagnostics changed = row_count;

  -- Eventos de mudança de segmento (para automações)
  for rec in
    select x.contact_id, x.segment, s.segment as prev
    from _rfv x join public.crm_rfv_scores s on s.tenant_id = p_tenant_id and s.contact_id = x.contact_id
    where s.segment is distinct from x.segment
  loop
    perform idx_private.crm_fire_event(p_tenant_id, 'rfv_segment_changed', 'contact', rec.contact_id,
      jsonb_build_object('segment', rec.segment, 'previous_segment', rec.prev));
    insert into public.crm_timeline(tenant_id, contact_id, kind, title, metadata)
    values (p_tenant_id, rec.contact_id, 'rfv', 'Segmento RFV: ' || coalesce(rec.prev, '—') || ' → ' || rec.segment,
            jsonb_build_object('segment', rec.segment, 'previous_segment', rec.prev));
  end loop;

  insert into public.crm_rfv_scores as s (tenant_id, contact_id, r_score, f_score, m_score, segment, previous_segment, segment_changed_at,
      days_since_last, first_purchase_at, last_purchase_at, purchase_count, net_revenue, avg_ticket, avg_interval_days,
      expected_next_purchase_at, overdue_days, method_used, rule_version, window_start, computed_at)
  select p_tenant_id, x.contact_id, x.r, x.f, x.m, x.segment, null, now(),
         x.days_since, x.first_at, x.last_at, x.cnt, round(x.revenue, 2), round(x.revenue / x.cnt, 2), x.avg_interval,
         case when x.avg_interval is not null then x.last_at + make_interval(days => ceil(x.avg_interval)::int) end,
         case when x.avg_interval is not null and now() > x.last_at + make_interval(days => ceil(x.avg_interval)::int)
              then floor(extract(epoch from now() - (x.last_at + make_interval(days => ceil(x.avg_interval)::int))) / 86400)::int end,
         case when use_quintile then 'quintile' else 'manual' end, cfg.rule_version, v_window_start, now()
  from _rfv x
  on conflict (tenant_id, contact_id) do update set
    previous_segment = case when s.segment is distinct from excluded.segment then s.segment else s.previous_segment end,
    segment_changed_at = case when s.segment is distinct from excluded.segment then now() else s.segment_changed_at end,
    r_score = excluded.r_score, f_score = excluded.f_score, m_score = excluded.m_score, segment = excluded.segment,
    days_since_last = excluded.days_since_last, first_purchase_at = excluded.first_purchase_at,
    last_purchase_at = excluded.last_purchase_at, purchase_count = excluded.purchase_count,
    net_revenue = excluded.net_revenue, avg_ticket = excluded.avg_ticket, avg_interval_days = excluded.avg_interval_days,
    expected_next_purchase_at = excluded.expected_next_purchase_at, overdue_days = excluded.overdue_days,
    method_used = excluded.method_used, rule_version = excluded.rule_version, window_start = excluded.window_start,
    computed_at = excluded.computed_at;

  -- Quem tinha compra e não tem mais (estorno/cancelamento): volta a "sem histórico"
  with gone as (
    update public.crm_rfv_scores s set
      previous_segment = s.segment, segment = 'no_purchase', segment_changed_at = now(),
      r_score = null, f_score = null, m_score = null, purchase_count = 0, net_revenue = 0,
      avg_ticket = null, avg_interval_days = null, expected_next_purchase_at = null, overdue_days = null,
      days_since_last = null, last_purchase_at = null, first_purchase_at = null, computed_at = now(), rule_version = cfg.rule_version
    where s.tenant_id = p_tenant_id and s.segment <> 'no_purchase'
      and not exists (select 1 from _rfv x where x.contact_id = s.contact_id)
    returning s.contact_id, s.previous_segment
  )
  insert into public.crm_rfv_history(tenant_id, contact_id, segment, previous_segment, net_revenue, purchase_count, rule_version, method_used)
  select p_tenant_id, contact_id, 'no_purchase', previous_segment, 0, 0, cfg.rule_version, 'manual' from gone;

  update public.crm_rfv_settings set dirty = false, last_computed_at = now() where tenant_id = p_tenant_id;

  return jsonb_build_object('customers', n_customers, 'method', case when use_quintile then 'quintile' else 'manual' end,
                            'changed', changed, 'rule_version', cfg.rule_version, 'computed_at', now());
end;
$function$;
