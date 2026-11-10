-- ============================================================================
-- CRM IDX — Views de leitura do painel e indicadores de Revenue Operations
-- Todas as views usam security_invoker: o RLS das tabelas de origem vale.
-- Indicadores retornam "available=false" quando não há dados suficientes,
-- em vez de mostrar zero enganoso.
-- ============================================================================

create or replace view public.vw_crm_deals
with (security_invoker = true) as
select
  d.*,
  st.name as stage_name, st.kind as stage_kind, st.probability as stage_probability, st.color as stage_color,
  st.position as stage_position, st.rotting_days,
  p.name as pipeline_name,
  c.name as contact_name, c.phone as contact_phone, c.email as contact_email, c.do_not_contact,
  co.name as company_name,
  lr.name as loss_reason_name,
  tu.email as owner_email,
  floor(extract(epoch from now() - d.stage_entered_at) / 86400)::int as days_in_stage,
  (d.status = 'open' and d.next_activity_at is null
    and coalesce(d.last_activity_at, d.stage_entered_at) < now() - make_interval(days => coalesce(st.rotting_days, s.stale_deal_days, 7))) as is_rotting,
  coalesce(d.probability, st.probability) as effective_probability,
  round(d.value * coalesce(d.probability, st.probability) / 100.0, 2) as weighted_value,
  nt.title as next_task_title, nt.task_type as next_task_type, nt.id as next_task_id,
  wc.ai_purchase_probability, wc.unread_count, wc.ai_summary,
  (d.contact_id is null and d.conversation_id is null) as is_click_only,
  coalesce(ord.valid_orders, 0) as valid_orders,
  coalesce(ord.valid_revenue, 0) as valid_revenue,
  coalesce(ord.pending_orders, 0) as pending_orders
from public.crm_deals d
join public.crm_stages st on st.id = d.stage_id
join public.crm_pipelines p on p.id = d.pipeline_id
left join public.crm_settings s on s.tenant_id = d.tenant_id
left join public.crm_contacts c on c.id = d.contact_id
left join public.crm_companies co on co.id = d.company_id
left join public.crm_loss_reasons lr on lr.id = d.loss_reason_id
left join lateral (
  select x.email from public.tenant_users x where x.tenant_id = d.tenant_id and x.user_id = d.owner_id limit 1
) tu on true
left join lateral (
  select t.id, t.title, t.task_type from public.crm_tasks t
  where t.deal_id = d.id and t.status = 'open' order by t.due_at nulls last limit 1
) nt on true
left join public.whatsapp_conversations wc on wc.id = d.conversation_id
left join lateral (
  select count(*) filter (where idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)) as valid_orders,
         sum(o.net_amount) filter (where idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)) as valid_revenue,
         count(*) filter (where o.status = 'pending') as pending_orders
  from public.crm_orders o where o.deal_id = d.id
) ord on true;

create or replace view public.vw_crm_contacts
with (security_invoker = true) as
select
  c.*,
  co.name as company_name,
  tu.email as owner_email,
  coalesce(dl.open_deals, 0) as open_deals,
  coalesce(dl.open_value, 0) as open_value,
  coalesce(dl.won_deals, 0) as won_deals,
  r.segment as rfv_segment, r.r_score, r.f_score, r.m_score, r.last_purchase_at, r.purchase_count, r.net_revenue,
  r.expected_next_purchase_at,
  wa.conversation_id, wa.unread_count, wa.last_message_at
from public.crm_contacts c
left join public.crm_companies co on co.id = c.company_id
left join lateral (
  select x.email from public.tenant_users x where x.tenant_id = c.tenant_id and x.user_id = c.owner_id limit 1
) tu on true
left join lateral (
  select count(*) filter (where d.status = 'open') as open_deals,
         sum(d.value) filter (where d.status = 'open') as open_value,
         count(*) filter (where d.status = 'won') as won_deals
  from public.crm_deals d where d.contact_id = c.id and d.archived_at is null
) dl on true
left join public.crm_rfv_scores r on r.contact_id = c.id and r.tenant_id = c.tenant_id
left join lateral (
  select conv.id as conversation_id, conv.unread_count, conv.last_message_at
  from public.whatsapp_contacts w join public.whatsapp_conversations conv on conv.contact_id = w.id
  where w.crm_contact_id = c.id order by conv.last_message_at desc nulls last limit 1
) wa on true
where c.merged_into_id is null;

-- Linha do tempo unificada: eventos do CRM + anotações/CAPI do fluxo legado
create or replace view public.vw_crm_timeline
with (security_invoker = true) as
select t.id, t.tenant_id, t.contact_id, t.deal_id, t.company_id, t.kind, t.title, t.body, t.metadata, t.actor_id,
       t.occurred_at, 'crm'::text as origin
from public.crm_timeline t
union all
select a.id, a.tenant_id, d.contact_id, d.id, d.company_id,
       case a.activity_type when 'note' then 'note' when 'whatsapp' then 'whatsapp' when 'call' then 'call_log' else 'system' end,
       case a.activity_type
         when 'note' then 'Anotação (Atender)'
         when 'whatsapp' then 'WhatsApp (Atender)'
         when 'call' then 'Ligação (Atender)'
         when 'tag' then 'Etiqueta ' || coalesce(a.body, '')
         when 'capi' then 'Evento enviado ao Meta: ' || coalesce(a.body, '') || case when (a.metadata->>'ok')::boolean then ' (ok)' else ' (falhou)' end
         else 'IDX: ' || a.activity_type end,
       case when a.activity_type in ('note', 'whatsapp', 'call') then a.body end,
       a.metadata, a.user_id, a.created_at, 'legacy'::text
from public.crm_activities a
join public.crm_deals d on d.tracking_session_id = a.tracking_session_id
where a.activity_type <> 'stage_change';

-- Inteligência da IA por contato (com origem rastreável e marcada como inferida)
create or replace view public.vw_crm_contact_ai
with (security_invoker = true) as
select w.crm_contact_id as contact_id, ci.tenant_id, ci.conversation_id, ci.summary, ci.intent, ci.sentiment,
       ci.purchase_probability, ci.confidence_score, ci.products_of_interest, ci.objections, ci.commercial_notes,
       ci.extracted_name, ci.extracted_email, ci.model_used, ci.messages_analyzed_count, ci.updated_at, ci.evidence
from public.conversation_insights ci
join public.whatsapp_conversations conv on conv.id = ci.conversation_id
join public.whatsapp_contacts w on w.id = conv.contact_id
where w.crm_contact_id is not null;

create or replace view public.vw_crm_contact_signals
with (security_invoker = true) as
select w.crm_contact_id as contact_id, ss.id, ss.tenant_id, ss.conversation_id, ss.signal_type, ss.confidence, ss.status,
       ss.product_name, ss.estimated_value, ss.evidence_text, ss.auto_confirmed, ss.capi_status, ss.created_at
from public.sale_signals ss
join public.whatsapp_conversations conv on conv.id = ss.conversation_id
join public.whatsapp_contacts w on w.id = conv.contact_id
where w.crm_contact_id is not null;

grant select on public.vw_crm_deals, public.vw_crm_contacts, public.vw_crm_timeline, public.vw_crm_contact_ai, public.vw_crm_contact_signals to authenticated;
revoke all on public.vw_crm_deals, public.vw_crm_contacts, public.vw_crm_timeline, public.vw_crm_contact_ai, public.vw_crm_contact_signals from anon;

-- ---------------------------------------------------------------------------
-- Indicadores (RevOps). Cada item: valor, disponibilidade, fórmula e fonte.
-- ---------------------------------------------------------------------------
create or replace function public.crm_kpis(p_tenant_id uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  res jsonb := '{}'::jsonb;
  v_open int; v_pipeline numeric; v_weighted numeric; v_won int; v_won_value numeric; v_lost int;
  v_cycle numeric; v_no_next int; v_rotting int; v_forecast numeric;
  v_orders int; v_revenue numeric; v_pending int; v_pending_value numeric;
  v_leads int; v_qualified int; v_spend_meta numeric; v_spend_google numeric; v_spend numeric; v_has_spend boolean;
  v_new_customers int; v_customers int; v_repeat int; v_lost_customers int;
  v_tasks_done int; v_tasks_overdue int; v_tasks_today int;
  v_contacts int; v_with_phone int; v_with_source int; v_with_owner int;
  v_auto_errors int; v_sla_total int; v_sla_ok int; v_resp_avg numeric; v_resp_n int;
  v_r0 numeric; v_r1 numeric; v_keep numeric; v_m0 date; v_m1 date;
  v_reactivated int; v_by_channel jsonb; v_by_owner jsonb;
  function_def text;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;

  -- Vendas
  select count(*) filter (where status = 'open'),
         coalesce(sum(value) filter (where status = 'open'), 0),
         coalesce(sum(round(value * coalesce(d.probability, st.probability) / 100.0, 2)) filter (where status = 'open'), 0),
         count(*) filter (where status = 'won' and won_at >= p_from and won_at < p_to),
         coalesce(sum(value) filter (where status = 'won' and won_at >= p_from and won_at < p_to), 0),
         count(*) filter (where status = 'lost' and lost_at >= p_from and lost_at < p_to),
         avg(extract(epoch from won_at - d.created_at) / 86400.0) filter (where status = 'won' and won_at >= p_from and won_at < p_to),
         count(*) filter (where status = 'open' and next_activity_at is null),
         coalesce(sum(round(value * coalesce(d.probability, st.probability) / 100.0, 2))
                  filter (where status = 'open' and expected_close_date >= date_trunc('month', now())::date
                          and expected_close_date < (date_trunc('month', now()) + interval '1 month')::date), 0)
    into v_open, v_pipeline, v_weighted, v_won, v_won_value, v_lost, v_cycle, v_no_next, v_forecast
  from public.crm_deals d join public.crm_stages st on st.id = d.stage_id
  where d.tenant_id = p_tenant_id and d.archived_at is null and (p_owner is null or d.owner_id = p_owner);

  select count(*) into v_rotting from public.vw_crm_deals
  where tenant_id = p_tenant_id and is_rotting and archived_at is null and (p_owner is null or owner_id = p_owner);

  select count(*) filter (where idx_private.crm_is_valid_purchase(status, is_free, net_amount)),
         coalesce(sum(net_amount) filter (where idx_private.crm_is_valid_purchase(status, is_free, net_amount)), 0),
         count(*) filter (where status = 'pending'),
         coalesce(sum(gross_amount - discount_amount) filter (where status = 'pending'), 0)
    into v_orders, v_revenue, v_pending, v_pending_value
  from public.crm_orders
  where tenant_id = p_tenant_id and order_date >= p_from and order_date < p_to and (p_owner is null or owner_id = p_owner);

  res := res
    || jsonb_build_object('open_deals', jsonb_build_object('value', v_open, 'available', true, 'unit', 'count',
         'label', 'Negociações abertas', 'formula', 'Negociações com status aberto (não arquivadas).', 'source', 'crm_deals'))
    || jsonb_build_object('pipeline_value', jsonb_build_object('value', v_pipeline, 'available', true, 'unit', 'money',
         'label', 'Valor em negociação', 'formula', 'Soma do valor estimado das negociações abertas.', 'source', 'crm_deals'))
    || jsonb_build_object('weighted_pipeline', jsonb_build_object('value', v_weighted, 'available', true, 'unit', 'money',
         'label', 'Pipeline ponderado', 'formula', 'Σ valor × probabilidade da etapa (ou da negociação).', 'source', 'crm_deals + crm_stages'))
    || jsonb_build_object('won_deals', jsonb_build_object('value', v_won, 'available', true, 'unit', 'count',
         'label', 'Negociações ganhas', 'formula', 'Negociações que entraram em etapa de ganho no período.', 'source', 'crm_deals.won_at'))
    || jsonb_build_object('lost_deals', jsonb_build_object('value', v_lost, 'available', true, 'unit', 'count',
         'label', 'Negociações perdidas', 'formula', 'Negociações que entraram em etapa de perda no período.', 'source', 'crm_deals.lost_at'))
    || jsonb_build_object('win_rate', jsonb_build_object('value', case when v_won + v_lost > 0 then round(v_won::numeric / (v_won + v_lost) * 100, 1) end,
         'available', v_won + v_lost > 0, 'unit', 'percent',
         'label', 'Win rate', 'formula', 'Ganhas ÷ (ganhas + perdidas) no período.', 'source', 'crm_deals'))
    || jsonb_build_object('sales_cycle_days', jsonb_build_object('value', round(v_cycle, 1), 'available', v_cycle is not null, 'unit', 'days',
         'label', 'Ciclo de vendas', 'formula', 'Média de dias entre criação e ganho das negociações ganhas no período.', 'source', 'crm_deals'))
    || jsonb_build_object('deals_without_next_action', jsonb_build_object('value', v_no_next, 'available', true, 'unit', 'count',
         'label', 'Negociações sem próxima ação', 'formula', 'Negociações abertas sem tarefa aberta agendada.', 'source', 'crm_deals + crm_tasks'))
    || jsonb_build_object('rotting_deals', jsonb_build_object('value', v_rotting, 'available', true, 'unit', 'count',
         'label', 'Negociações paradas', 'formula', 'Abertas, sem próxima ação e sem atividade além do prazo da etapa.', 'source', 'vw_crm_deals'))
    || jsonb_build_object('forecast_month', jsonb_build_object('value', v_forecast, 'available', true, 'unit', 'money',
         'label', 'Previsão do mês', 'formula', 'Σ valor × probabilidade das abertas com fechamento previsto neste mês.', 'source', 'crm_deals.expected_close_date'))
    || jsonb_build_object('revenue', jsonb_build_object('value', v_revenue, 'available', true, 'unit', 'money',
         'label', 'Receita confirmada', 'formula', 'Σ valor líquido de pedidos válidos (confirmados/pagos, não gratuitos, menos devoluções) no período.', 'source', 'crm_orders'))
    || jsonb_build_object('orders', jsonb_build_object('value', v_orders, 'available', true, 'unit', 'count',
         'label', 'Vendas confirmadas', 'formula', 'Quantidade de pedidos válidos no período.', 'source', 'crm_orders'))
    || jsonb_build_object('avg_ticket', jsonb_build_object('value', case when v_orders > 0 then round(v_revenue / v_orders, 2) end,
         'available', v_orders > 0, 'unit', 'money', 'label', 'Ticket médio', 'formula', 'Receita confirmada ÷ vendas confirmadas.', 'source', 'crm_orders'))
    || jsonb_build_object('pending_sales', jsonb_build_object('value', v_pending, 'available', true, 'unit', 'count', 'extra', v_pending_value,
         'label', 'Vendas aguardando confirmação', 'formula', 'Pedidos com status pendente (venda declarada ou marcada pela IA sem revisão). Não entram na receita.', 'source', 'crm_orders'));

  -- Tempo de primeira resposta no WhatsApp
  select avg(extract(epoch from fo.first_out - fi.first_in) / 60.0), count(*)
    into v_resp_avg, v_resp_n
  from public.whatsapp_conversations conv
  join lateral (select min(m."timestamp") as first_in from public.whatsapp_messages m where m.conversation_id = conv.id and m.direction = 'inbound') fi on true
  join lateral (select min(m."timestamp") as first_out from public.whatsapp_messages m where m.conversation_id = conv.id and m.direction = 'outbound' and m."timestamp" >= fi.first_in) fo on true
  where conv.tenant_id = p_tenant_id and fi.first_in >= p_from and fi.first_in < p_to and fo.first_out is not null;
  res := res || jsonb_build_object('first_response_minutes', jsonb_build_object('value', round(v_resp_avg, 1), 'available', coalesce(v_resp_n, 0) > 0,
    'unit', 'minutes', 'label', 'Tempo de primeira resposta', 'formula', 'Média de minutos entre a 1ª mensagem recebida e a 1ª resposta, por conversa iniciada no período.', 'source', 'whatsapp_messages'));

  -- SLA: negociações criadas no período com primeira atividade em até 24h
  select count(*), count(*) filter (where fa.first_at is not null and fa.first_at <= d.created_at + interval '24 hours')
    into v_sla_total, v_sla_ok
  from public.crm_deals d
  left join lateral (
    select least(
      (select min(t.completed_at) from public.crm_tasks t where t.deal_id = d.id and t.status = 'done'),
      (select min(tl.occurred_at) from public.crm_timeline tl where tl.deal_id = d.id and tl.kind in ('note', 'call_log', 'meeting_log', 'whatsapp', 'stage_change')),
      d.last_activity_at) as first_at
  ) fa on true
  where d.tenant_id = p_tenant_id and d.created_at >= p_from and d.created_at < p_to and d.contact_id is not null
    and (p_owner is null or d.owner_id = p_owner);
  res := res || jsonb_build_object('sla_24h', jsonb_build_object('value', case when v_sla_total > 0 then round(v_sla_ok::numeric / v_sla_total * 100, 1) end,
    'available', v_sla_total > 0, 'unit', 'percent', 'label', 'SLA de primeiro atendimento (24h)',
    'formula', '% das negociações com contato criadas no período que tiveram atividade em até 24h.', 'source', 'crm_deals + crm_tasks + crm_timeline'));

  -- Marketing
  select count(*), count(*) filter (where c.lifecycle_stage in ('mql', 'sal', 'sql', 'opportunity', 'customer'))
    into v_leads, v_qualified
  from public.crm_contacts c
  where c.tenant_id = p_tenant_id and c.created_at >= p_from and c.created_at < p_to and c.merged_into_id is null;

  select coalesce(sum(spend), 0), count(*) > 0 into v_spend_meta, v_has_spend
  from public.meta_campaign_insights where tenant_id = p_tenant_id and date_start >= p_from::date and date_start < p_to::date;
  select coalesce(sum(cost), 0) into v_spend_google
  from public.google_campaign_insights where tenant_id = p_tenant_id and date >= p_from::date and date < p_to::date;
  v_has_spend := v_has_spend or v_spend_google > 0;
  v_spend := v_spend_meta + v_spend_google;

  select count(*) into v_new_customers from (
    select o.contact_id, min(o.order_date) as first_at from public.crm_orders o
    where o.tenant_id = p_tenant_id and o.contact_id is not null and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
    group by o.contact_id) f
  where f.first_at >= p_from and f.first_at < p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'leads', n, 'won', w, 'revenue', rv) order by n desc), '[]'::jsonb)
    into v_by_channel
  from (
    select coalesce(d.source_channel, 'desconhecido') as ch, count(*) as n,
           count(*) filter (where d.status = 'won') as w,
           coalesce(sum(d.valid_revenue), 0) as rv
    from public.vw_crm_deals d
    where d.tenant_id = p_tenant_id and d.created_at >= p_from and d.created_at < p_to
    group by 1) x;

  res := res
    || jsonb_build_object('new_contacts', jsonb_build_object('value', v_leads, 'available', true, 'unit', 'count',
         'label', 'Leads gerados', 'formula', 'Contatos criados no período (todas as origens).', 'source', 'crm_contacts'))
    || jsonb_build_object('qualified_contacts', jsonb_build_object('value', v_qualified, 'available', true, 'unit', 'count',
         'label', 'Oportunidades qualificadas', 'formula', 'Contatos do período que chegaram a MQL/SAL/SQL/oportunidade/cliente.', 'source', 'crm_contacts.lifecycle_stage'))
    || jsonb_build_object('ad_spend', jsonb_build_object('value', v_spend, 'available', v_has_spend, 'unit', 'money',
         'label', 'Investimento em anúncios', 'formula', 'Σ gasto diário Meta Ads + Google Ads no período (dados sincronizados).', 'source', 'meta_campaign_insights + google_campaign_insights'))
    || jsonb_build_object('cpl', jsonb_build_object('value', case when v_has_spend and v_leads > 0 then round(v_spend / v_leads, 2) end,
         'available', v_has_spend and v_leads > 0, 'unit', 'money', 'label', 'Custo por lead',
         'formula', 'Investimento em anúncios ÷ leads gerados.', 'source', 'ads + crm_contacts'))
    || jsonb_build_object('new_customers', jsonb_build_object('value', v_new_customers, 'available', true, 'unit', 'count',
         'label', 'Novos clientes', 'formula', 'Contatos cuja primeira compra válida ocorreu no período.', 'source', 'crm_orders'))
    || jsonb_build_object('cac', jsonb_build_object('value', case when v_has_spend and v_new_customers > 0 then round(v_spend / v_new_customers, 2) end,
         'available', v_has_spend and v_new_customers > 0, 'unit', 'money', 'label', 'CAC (mídia)',
         'formula', 'Investimento em anúncios ÷ novos clientes do período. Não inclui custos de equipe.', 'source', 'ads + crm_orders'))
    || jsonb_build_object('by_channel', jsonb_build_object('value', v_by_channel, 'available', jsonb_array_length(v_by_channel) > 0, 'unit', 'table',
         'label', 'Conversão por origem', 'formula', 'Negociações criadas no período por canal de origem, ganhas e receita válida.', 'source', 'vw_crm_deals'));

  -- Retenção
  select count(*), count(*) filter (where purchase_count >= 2), count(*) filter (where segment = 'lost')
    into v_customers, v_repeat, v_lost_customers
  from public.crm_rfv_scores where tenant_id = p_tenant_id and segment <> 'no_purchase';

  select count(distinct h.contact_id) into v_reactivated
  from public.crm_rfv_history h
  where h.tenant_id = p_tenant_id and h.computed_at >= p_from and h.computed_at < p_to
    and h.previous_segment in ('hibernating', 'lost', 'at_risk', 'high_value_at_risk')
    and h.segment in ('champions', 'loyal', 'potential', 'new');

  -- GRR / NRR com receita recorrente: mês anterior ao fim do período vs mês final
  v_m1 := date_trunc('month', p_to - interval '1 second')::date;
  v_m0 := (v_m1 - interval '1 month')::date;
  select coalesce(sum(r0), 0), coalesce(sum(r1), 0), coalesce(sum(least(r0, r1)), 0) into v_r0, v_r1, v_keep
  from (
    select o.contact_id,
           sum(o.net_amount) filter (where date_trunc('month', o.order_date)::date = v_m0) as r0,
           coalesce(sum(o.net_amount) filter (where date_trunc('month', o.order_date)::date = v_m1), 0) as r1
    from public.crm_orders o
    where o.tenant_id = p_tenant_id and o.order_kind = 'recurring_cycle'
      and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
      and o.order_date >= v_m0 and o.order_date < (v_m1 + interval '1 month')
    group by o.contact_id) x
  where r0 > 0;

  res := res
    || jsonb_build_object('customers', jsonb_build_object('value', v_customers, 'available', true, 'unit', 'count',
         'label', 'Clientes com compra', 'formula', 'Contatos com ao menos uma compra válida (base do RFV).', 'source', 'crm_rfv_scores'))
    || jsonb_build_object('repurchase_rate', jsonb_build_object('value', case when v_customers > 0 then round(v_repeat::numeric / v_customers * 100, 1) end,
         'available', v_customers > 0, 'unit', 'percent', 'label', 'Taxa de recompra',
         'formula', 'Clientes com 2+ compras válidas ÷ clientes com compra.', 'source', 'crm_rfv_scores'))
    || jsonb_build_object('customer_churn', jsonb_build_object('value', case when v_customers > 0 then round(v_lost_customers::numeric / v_customers * 100, 1) end,
         'available', v_customers > 0, 'unit', 'percent', 'label', 'Churn de clientes (RFV)',
         'formula', 'Clientes no segmento "Perdidos" (inativos além do ciclo configurado) ÷ clientes com compra.', 'source', 'crm_rfv_scores'))
    || jsonb_build_object('reactivated', jsonb_build_object('value', v_reactivated, 'available', true, 'unit', 'count',
         'label', 'Clientes reativados', 'formula', 'Clientes que saíram de em risco/hibernando/perdido para um segmento ativo no período.', 'source', 'crm_rfv_history'))
    || jsonb_build_object('grr', jsonb_build_object('value', case when v_r0 > 0 then round(v_keep / v_r0 * 100, 1) end,
         'available', v_r0 > 0, 'unit', 'percent', 'label', 'GRR',
         'formula', 'Receita recorrente mantida (sem expansão) no mês final ÷ receita recorrente do mês anterior, mesmos clientes.', 'source', 'crm_orders (recurring_cycle)'))
    || jsonb_build_object('nrr', jsonb_build_object('value', case when v_r0 > 0 then round(v_r1 / v_r0 * 100, 1) end,
         'available', v_r0 > 0, 'unit', 'percent', 'label', 'NRR',
         'formula', 'Receita recorrente no mês final (com expansão) ÷ receita recorrente do mês anterior, mesmos clientes.', 'source', 'crm_orders (recurring_cycle)'))
    || jsonb_build_object('revenue_churn', jsonb_build_object('value', case when v_r0 > 0 then round((1 - v_keep / v_r0) * 100, 1) end,
         'available', v_r0 > 0, 'unit', 'percent', 'label', 'Churn de receita',
         'formula', '1 − GRR.', 'source', 'crm_orders (recurring_cycle)'));

  -- Operação
  select count(*) filter (where status = 'done' and completed_at >= p_from and completed_at < p_to),
         count(*) filter (where status = 'open' and due_at < now()),
         count(*) filter (where status = 'open' and due_at >= date_trunc('day', now()) and due_at < date_trunc('day', now()) + interval '1 day')
    into v_tasks_done, v_tasks_overdue, v_tasks_today
  from public.crm_tasks where tenant_id = p_tenant_id and (p_owner is null or owner_id = p_owner);

  select count(*), count(*) filter (where phone is not null or email is not null),
         count(*) filter (where source_channel is not null), count(*) filter (where owner_id is not null)
    into v_contacts, v_with_phone, v_with_source, v_with_owner
  from public.crm_contacts where tenant_id = p_tenant_id and merged_into_id is null and archived_at is null;

  select count(*) into v_auto_errors from public.crm_automation_runs
  where tenant_id = p_tenant_id and status = 'error' and created_at >= p_from and created_at < p_to;

  select coalesce(jsonb_agg(x order by (x->>'won_value')::numeric desc nulls last), '[]'::jsonb) into v_by_owner
  from (
    select jsonb_build_object(
      'owner_id', tu.user_id, 'email', tu.email,
      'open_deals', (select count(*) from public.crm_deals d where d.tenant_id = p_tenant_id and d.owner_id = tu.user_id and d.status = 'open'),
      'won_deals', (select count(*) from public.crm_deals d where d.tenant_id = p_tenant_id and d.owner_id = tu.user_id and d.status = 'won' and d.won_at >= p_from and d.won_at < p_to),
      'won_value', (select coalesce(sum(d.value), 0) from public.crm_deals d where d.tenant_id = p_tenant_id and d.owner_id = tu.user_id and d.status = 'won' and d.won_at >= p_from and d.won_at < p_to),
      'tasks_done', (select count(*) from public.crm_tasks t where t.tenant_id = p_tenant_id and t.owner_id = tu.user_id and t.status = 'done' and t.completed_at >= p_from and t.completed_at < p_to),
      'tasks_overdue', (select count(*) from public.crm_tasks t where t.tenant_id = p_tenant_id and t.owner_id = tu.user_id and t.status = 'open' and t.due_at < now())
    ) as x
    from public.tenant_users tu where tu.tenant_id = p_tenant_id and tu.status = 'active' and tu.user_id is not null
  ) q;

  res := res
    || jsonb_build_object('tasks_done', jsonb_build_object('value', v_tasks_done, 'available', true, 'unit', 'count',
         'label', 'Atividades concluídas', 'formula', 'Tarefas concluídas no período.', 'source', 'crm_tasks'))
    || jsonb_build_object('tasks_overdue', jsonb_build_object('value', v_tasks_overdue, 'available', true, 'unit', 'count',
         'label', 'Atividades atrasadas', 'formula', 'Tarefas abertas com prazo vencido (agora).', 'source', 'crm_tasks'))
    || jsonb_build_object('tasks_today', jsonb_build_object('value', v_tasks_today, 'available', true, 'unit', 'count',
         'label', 'Atividades de hoje', 'formula', 'Tarefas abertas com prazo hoje.', 'source', 'crm_tasks'))
    || jsonb_build_object('data_completeness', jsonb_build_object(
         'value', case when v_contacts > 0 then round(((v_with_phone + v_with_source + v_with_owner)::numeric / (v_contacts * 3)) * 100, 1) end,
         'available', v_contacts > 0, 'unit', 'percent', 'label', 'Completude dos dados',
         'extra', jsonb_build_object('contacts', v_contacts, 'with_contact_info', v_with_phone, 'with_source', v_with_source, 'with_owner', v_with_owner),
         'formula', 'Média de: % contatos com telefone/e-mail, % com origem, % com responsável.', 'source', 'crm_contacts'))
    || jsonb_build_object('automation_errors', jsonb_build_object('value', v_auto_errors, 'available', true, 'unit', 'count',
         'label', 'Falhas de automação', 'formula', 'Execuções de automação com erro no período.', 'source', 'crm_automation_runs'))
    || jsonb_build_object('by_owner', jsonb_build_object('value', v_by_owner, 'available', jsonb_array_length(v_by_owner) > 0, 'unit', 'table',
         'label', 'Produtividade por responsável', 'formula', 'Negociações abertas, ganhas (qtde e valor) e tarefas por usuário no período.', 'source', 'crm_deals + crm_tasks'));

  return jsonb_build_object('period', jsonb_build_object('from', p_from, 'to', p_to), 'generated_at', now(), 'metrics', res);
end;
$$;
grant execute on function public.crm_kpis(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- Painel RFV agregado
create or replace function public.crm_rfv_dashboard(p_tenant_id uuid)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $$
declare
  v_segments jsonb; v_matrix jsonb; v_total int; v_revenue numeric; v_no_purchase int; v_top20 numeric;
  v_avg_ticket numeric; v_avg_freq numeric; v_avg_interval numeric; v_risk int; v_migrations jsonb; v_settings jsonb;
  v_trend jsonb;
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;

  select count(*), coalesce(sum(net_revenue), 0), round(avg(avg_ticket), 2), round(avg(purchase_count), 2), round(avg(avg_interval_days), 1),
         count(*) filter (where segment in ('at_risk', 'high_value_at_risk'))
    into v_total, v_revenue, v_avg_ticket, v_avg_freq, v_avg_interval, v_risk
  from public.crm_rfv_scores where tenant_id = p_tenant_id and segment <> 'no_purchase';

  select count(*) into v_no_purchase from public.crm_contacts c
  where c.tenant_id = p_tenant_id and c.merged_into_id is null and c.archived_at is null
    and not exists (select 1 from public.crm_rfv_scores s where s.contact_id = c.id and s.segment <> 'no_purchase');

  select coalesce(jsonb_agg(jsonb_build_object('segment', segment, 'customers', n, 'revenue', rv, 'avg_ticket', tk, 'avg_frequency', fq) order by rv desc), '[]'::jsonb)
    into v_segments
  from (select segment, count(*) n, coalesce(sum(net_revenue), 0) rv, round(avg(avg_ticket), 2) tk, round(avg(purchase_count), 2) fq
        from public.crm_rfv_scores where tenant_id = p_tenant_id and segment <> 'no_purchase' group by segment) s;

  -- concentração: receita dos 20% clientes de maior valor
  select coalesce(sum(net_revenue), 0) into v_top20 from (
    select net_revenue, ntile(5) over (order by net_revenue desc) as q from public.crm_rfv_scores
    where tenant_id = p_tenant_id and segment <> 'no_purchase') x where q = 1;

  select coalesce(jsonb_agg(jsonb_build_object('r', r_score, 'f', f_score, 'customers', n, 'revenue', rv)), '[]'::jsonb) into v_matrix
  from (select r_score, f_score, count(*) n, coalesce(sum(net_revenue), 0) rv from public.crm_rfv_scores
        where tenant_id = p_tenant_id and segment <> 'no_purchase' group by r_score, f_score) m;

  select coalesce(jsonb_agg(jsonb_build_object('from', previous_segment, 'to', segment, 'customers', n) order by n desc), '[]'::jsonb) into v_migrations
  from (select previous_segment, segment, count(*) n from public.crm_rfv_history
        where tenant_id = p_tenant_id and previous_segment is not null and computed_at > now() - interval '90 days'
        group by previous_segment, segment) mg;

  select coalesce(jsonb_agg(jsonb_build_object('month', month, 'segment', segment, 'customers', n) order by month), '[]'::jsonb) into v_trend
  from (
    select to_char(date_trunc('month', h.computed_at), 'YYYY-MM') as month, h.segment, count(distinct h.contact_id) n
    from public.crm_rfv_history h where h.tenant_id = p_tenant_id and h.computed_at > now() - interval '12 months'
    group by 1, 2) t;

  select to_jsonb(s) into v_settings from public.crm_rfv_settings s where s.tenant_id = p_tenant_id;

  return jsonb_build_object(
    'customers', v_total, 'no_purchase', v_no_purchase, 'revenue', v_revenue,
    'avg_ticket', v_avg_ticket, 'avg_frequency', v_avg_freq, 'avg_interval_days', v_avg_interval,
    'at_risk_pct', case when v_total > 0 then round(v_risk::numeric / v_total * 100, 1) end,
    'top20_revenue_share', case when v_revenue > 0 then round(v_top20 / v_revenue * 100, 1) end,
    'repurchase_rate', case when v_total > 0 then round((select count(*) from public.crm_rfv_scores where tenant_id = p_tenant_id and purchase_count >= 2)::numeric / v_total * 100, 1) end,
    'segments', v_segments, 'matrix', v_matrix, 'migrations', v_migrations, 'trend', v_trend, 'settings', v_settings);
end;
$$;
grant execute on function public.crm_rfv_dashboard(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Importação CSV (contatos e negociações) com deduplicação e relatório
-- ---------------------------------------------------------------------------
create or replace function public.crm_import(p_tenant_id uuid, p_entity text, p_rows jsonb, p_options jsonb default '{}'::jsonb, p_file_name text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r jsonb; i int := 0;
  v_created int := 0; v_updated int := 0; v_skipped int := 0; v_errors int := 0;
  report jsonb := '[]'::jsonb;
  v_contact uuid; v_company uuid; v_phone text; v_email text; v_dup uuid; v_stage uuid; v_pipeline uuid; v_owner uuid;
  v_mode text := coalesce(p_options->>'on_duplicate', 'skip');  -- skip | update
  v_import uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then
    raise exception 'Sem permissão para importar.' using errcode = '42501';
  end if;
  if p_entity not in ('contacts', 'deals') then raise exception 'Entidade inválida.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Máximo de 5.000 linhas por importação.' using errcode = '22023'; end if;
  select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = p_tenant_id;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_phone := nullif(trim(r->>'phone'), '');
      v_email := nullif(lower(trim(r->>'email')), '');
      if v_phone is not null and idx_private.normalize_phone(v_phone) is null then
        raise exception 'telefone inválido (%)', v_phone;
      end if;
      if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'e-mail inválido (%)', v_email;
      end if;
      if coalesce(nullif(trim(r->>'name'), ''), v_phone, v_email) is null then
        raise exception 'linha sem nome, telefone ou e-mail';
      end if;

      v_company := null;
      if nullif(trim(r->>'company'), '') is not null then
        select id into v_company from public.crm_companies where tenant_id = p_tenant_id and lower(name) = lower(trim(r->>'company')) limit 1;
        if v_company is null then
          insert into public.crm_companies(tenant_id, name) values (p_tenant_id, trim(r->>'company')) returning id into v_company;
        end if;
      end if;

      v_owner := null;
      if nullif(trim(r->>'owner_email'), '') is not null then
        select user_id into v_owner from public.tenant_users where tenant_id = p_tenant_id and lower(email) = lower(trim(r->>'owner_email')) and status = 'active' limit 1;
      end if;

      -- duplicidade: telefone exato > e-mail exato
      v_dup := null;
      if v_phone is not null then
        select id into v_dup from public.crm_contacts where tenant_id = p_tenant_id and phone = idx_private.normalize_phone(v_phone) and merged_into_id is null;
      end if;
      if v_dup is null and v_email is not null then
        select id into v_dup from public.crm_contacts where tenant_id = p_tenant_id and email = v_email and merged_into_id is null limit 1;
      end if;

      if v_dup is not null then
        v_contact := v_dup;
        if v_mode = 'update' then
          update public.crm_contacts set
            name = coalesce(nullif(trim(r->>'name'), ''), name),
            email = coalesce(v_email, email),
            company_id = coalesce(v_company, company_id),
            job_title = coalesce(nullif(trim(r->>'job_title'), ''), job_title),
            city = coalesce(nullif(trim(r->>'city'), ''), city),
            state = coalesce(nullif(trim(r->>'state'), ''), state),
            owner_id = coalesce(v_owner, owner_id),
            tags = case when nullif(trim(r->>'tags'), '') is null then tags
                        else array(select distinct unnest(tags || string_to_array(replace(r->>'tags', ';', ','), ','))) end
          where id = v_dup;
          if p_entity = 'contacts' then v_updated := v_updated + 1; end if;
        elsif p_entity = 'contacts' then
          v_skipped := v_skipped + 1;
          report := report || jsonb_build_object('row', i, 'status', 'skipped', 'message', 'duplicado (contato já existe)', 'contact_id', v_dup);
        end if;
      else
        insert into public.crm_contacts(tenant_id, name, phone, email, company_id, job_title, city, state, owner_id, tags, notes,
          source_channel, acquisition_basis, lifecycle_source, utm_source, utm_medium, utm_campaign, acquisition_campaign, created_by)
        values (p_tenant_id, nullif(trim(r->>'name'), ''), v_phone, v_email, v_company,
                nullif(trim(r->>'job_title'), ''), nullif(trim(r->>'city'), ''), nullif(trim(r->>'state'), ''), v_owner,
                coalesce(array(select trim(x) from unnest(string_to_array(replace(coalesce(r->>'tags', ''), ';', ','), ',')) x where trim(x) <> ''), '{}'),
                nullif(trim(r->>'notes'), ''),
                coalesce(nullif(trim(r->>'source'), ''), 'import'),
                case when nullif(trim(r->>'source'), '') is not null then 'declared' else 'unknown' end, 'import',
                nullif(trim(r->>'utm_source'), ''), nullif(trim(r->>'utm_medium'), ''), nullif(trim(r->>'utm_campaign'), ''),
                nullif(trim(r->>'utm_campaign'), ''), auth.uid())
        returning id into v_contact;
        if p_entity = 'contacts' then v_created := v_created + 1; end if;
      end if;

      if p_entity = 'deals' then
        v_stage := null;
        if nullif(trim(r->>'stage'), '') is not null then
          select id into v_stage from public.crm_stages where tenant_id = p_tenant_id and pipeline_id = v_pipeline
            and lower(name) = lower(trim(r->>'stage')) and archived_at is null limit 1;
          if v_stage is null then raise exception 'etapa "%" não existe no funil padrão', r->>'stage'; end if;
        else
          select id into v_stage from public.crm_stages where pipeline_id = v_pipeline and archived_at is null order by position limit 1;
        end if;
        insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id, value,
          expected_close_date, source_channel, attribution_basis, created_by)
        values (p_tenant_id, v_pipeline, v_stage,
                coalesce(nullif(trim(r->>'title'), ''), coalesce(nullif(trim(r->>'name'), ''), v_phone, v_email)),
                v_contact, v_company, v_owner,
                coalesce(nullif(replace(replace(r->>'value', '.', ''), ',', '.'), '')::numeric, 0),
                nullif(trim(r->>'expected_close_date'), '')::date,
                coalesce(nullif(trim(r->>'source'), ''), 'import'),
                case when nullif(trim(r->>'source'), '') is not null then 'declared' else 'unknown' end, auth.uid());
        v_created := v_created + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      report := report || jsonb_build_object('row', i, 'status', 'error', 'message', sqlerrm);
    end;
  end loop;

  insert into public.crm_imports(tenant_id, entity, file_name, total_rows, created_rows, updated_rows, skipped_rows, error_rows, report, options, created_by)
  values (p_tenant_id, p_entity, p_file_name, i, v_created, v_updated, v_skipped, v_errors, report, p_options, auth.uid())
  returning id into v_import;

  return jsonb_build_object('import_id', v_import, 'total', i, 'created', v_created, 'updated', v_updated,
                            'skipped', v_skipped, 'errors', v_errors, 'report', report);
end;
$$;
grant execute on function public.crm_import(uuid, text, jsonb, jsonb, text) to authenticated;
-- crm_imports é escrita pela função (invoker): libera insert para quem pode escrever
drop policy if exists crm_imports_insert on public.crm_imports;
create policy crm_imports_insert on public.crm_imports for insert to authenticated with check (idx_private.crm_can(tenant_id, 'write'));
grant insert on public.crm_imports to authenticated;

-- Mesclagem manual de contatos duplicados (move tudo para o principal)
create or replace function public.crm_merge_contacts(p_keep uuid, p_merge uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare k record; m record;
begin
  select * into k from public.crm_contacts where id = p_keep;
  select * into m from public.crm_contacts where id = p_merge;
  if k.id is null or m.id is null or k.tenant_id <> m.tenant_id or k.id = m.id then
    raise exception 'Contatos inválidos para mesclagem.' using errcode = '22023';
  end if;
  if not idx_private.crm_can(k.tenant_id, 'delete') then
    raise exception 'Somente administradores e gestores podem mesclar contatos.' using errcode = '42501';
  end if;
  update public.crm_deals set contact_id = k.id where contact_id = m.id;
  update public.crm_tasks set contact_id = k.id where contact_id = m.id;
  update public.crm_orders set contact_id = k.id where contact_id = m.id;
  update public.crm_samples set contact_id = k.id where contact_id = m.id;
  update public.crm_onboardings set contact_id = k.id where contact_id = m.id;
  update public.crm_service_requests set contact_id = k.id where contact_id = m.id;
  update public.crm_timeline set contact_id = k.id where contact_id = m.id;
  update public.crm_campaign_members set contact_id = k.id where contact_id = m.id
    and not exists (select 1 from public.crm_campaign_members x where x.campaign_id = crm_campaign_members.campaign_id and x.contact_id = k.id);
  update public.whatsapp_contacts set crm_contact_id = k.id where crm_contact_id = m.id;
  delete from public.crm_rfv_scores where contact_id = m.id;
  update public.crm_contacts set
    name = coalesce(k.name, m.name), email = coalesce(k.email, m.email), company_id = coalesce(k.company_id, m.company_id),
    owner_id = coalesce(k.owner_id, m.owner_id), tags = array(select distinct unnest(k.tags || m.tags)),
    source_channel = coalesce(k.source_channel, m.source_channel),
    notes = nullif(concat_ws(E'\n', k.notes, m.notes), '')
  where id = k.id;
  -- o duplicado fica marcado (sem telefone para liberar o índice único), nunca apagado
  update public.crm_contacts set merged_into_id = k.id, phone_raw = coalesce(phone_raw, phone), phone = null, archived_at = now() where id = m.id;
  insert into public.crm_timeline(tenant_id, contact_id, kind, title, metadata, actor_id)
  values (k.tenant_id, k.id, 'merge', 'Contato mesclado: ' || coalesce(m.name, m.phone_raw, m.email, m.id::text),
          jsonb_build_object('merged_contact_id', m.id), auth.uid());
  update public.crm_rfv_settings set dirty = true where tenant_id = k.tenant_id;
end;
$$;
revoke all on function public.crm_merge_contacts(uuid, uuid) from public;
grant execute on function public.crm_merge_contacts(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Endurecimento de privilégios
-- No Supabase, novas tabelas/funções recebem privilégios padrão para anon e
-- authenticated (o RLS é a barreira). Aqui removemos explicitamente o que o
-- CRM não usa, para não depender só do RLS.
-- ---------------------------------------------------------------------------
do $$
declare f record; t text;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'crm\_%'
  loop
    execute format('revoke execute on function %s from anon', f.sig);
  end loop;
  foreach t in array array['crm_deal_stage_history', 'crm_audit_log', 'crm_rfv_scores', 'crm_rfv_history', 'crm_automation_runs'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated, anon', t);
  end loop;
  foreach t in array array['vw_crm_deals', 'vw_crm_contacts', 'vw_crm_timeline', 'vw_crm_contact_ai', 'vw_crm_contact_signals',
                           'vw_crm_sample_conversion', 'vw_crm_campaign_results', 'vw_crm_rfv_customers'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated, anon', t);
  end loop;
end $$;
revoke update, truncate on public.crm_timeline from authenticated;
revoke insert, delete, truncate on public.crm_notifications from authenticated;
revoke update, delete, truncate on public.crm_imports from authenticated;
revoke execute on function public.crm_compute_rfv_all() from authenticated, anon;
revoke execute on function public.crm_run_scheduled_all() from authenticated, anon;
