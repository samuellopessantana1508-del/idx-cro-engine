-- UTM Central & Campaign Attribution
-- Adds a materialized-like view for campaign attribution reports
-- and indexes for efficient UTM grouping queries.

-- Index for campaign grouping on tracking_sessions
create index if not exists idx_tracking_sessions_utm_campaign
  on public.tracking_sessions(tenant_id, utm_campaign, utm_source, utm_medium);

-- Index for source/medium grouping
create index if not exists idx_tracking_sessions_utm_source
  on public.tracking_sessions(tenant_id, utm_source, utm_medium);

-- View: campaign attribution joining tracking_sessions with sale_signals
-- Uses a CTE to pre-aggregate signals per session, avoiding row fan-out
-- that inflates revenue when multiple conversations/signals exist per session.
create or replace view public.vw_campaign_attribution
with (security_invoker = true) as
with session_signals as (
  select
    wc.tracking_session_id,
    count(ss.id) filter (where ss.signal_type in ('interest', 'high_intent', 'negotiation', 'declared_purchase', 'confirmed_sale')) as ai_signals,
    count(ss.id) filter (where ss.signal_type = 'confirmed_sale' or (ss.signal_type in ('declared_purchase', 'confirmed_sale') and ss.status in ('confirmed', 'converted'))) as ai_confirmed_sales
  from public.whatsapp_conversations wc
  inner join public.sale_signals ss on ss.conversation_id = wc.id and ss.tenant_id = wc.tenant_id
  where wc.tracking_session_id is not null
  group by wc.tracking_session_id
)
select
  ts.tenant_id,
  coalesce(ts.utm_campaign, 'desconhecido') as campaign,
  coalesce(ts.utm_source, 'desconhecido') as source,
  coalesce(ts.utm_medium, 'desconhecido') as medium,
  count(distinct ts.id) as clicks,
  count(distinct ts.id) filter (where ts.lead_status in ('contacted', 'qualified', 'sold', 'lost')) as leads,
  count(distinct ts.id) filter (where ts.lead_status = 'qualified') as qualified,
  count(distinct ts.id) filter (where ts.lead_status = 'sold') as sales,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  coalesce(sum(sig.ai_signals), 0) as ai_signals,
  coalesce(sum(sig.ai_confirmed_sales), 0) as ai_confirmed_sales,
  min(ts.clicked_at) as first_click_at,
  max(ts.clicked_at) as last_click_at
from public.tracking_sessions ts
left join session_signals sig on sig.tracking_session_id = ts.id
group by ts.tenant_id, coalesce(ts.utm_campaign, 'desconhecido'), coalesce(ts.utm_source, 'desconhecido'), coalesce(ts.utm_medium, 'desconhecido');

grant select on public.vw_campaign_attribution to authenticated;
