-- ============================================================================
-- Leads reais + integração WhatsApp (Evolution API) + vendas detectadas por IA
-- ----------------------------------------------------------------------------
-- Problema: o painel contava TODO clique no Smart Link como lead (migration
-- 20260724180000). Entravam na conta: cliques repetidos da mesma pessoa,
-- quem clicou e não mandou mensagem, previews e robôs. Por isso o número de
-- leads no painel ficava muito acima do que a empresa recebia no WhatsApp.
--
-- Agora:
--   clique  = toda sessão do Smart Link que não é repetição (duplicate_of null)
--   lead    = sessão com lead_confirmed_at preenchido:
--             - com WhatsApp conectado (Evolution API): quando a PRIMEIRA
--               MENSAGEM da pessoa chega no WhatsApp da empresa;
--             - sem WhatsApp conectado: quando a página de passagem confirma
--               que o navegador saiu para o WhatsApp.
-- ============================================================================

alter table public.tracking_sessions
  add column if not exists lead_confirmed_at timestamptz,
  add column if not exists lead_source text,
  add column if not exists duplicate_of uuid references public.tracking_sessions(id) on delete set null,
  add column if not exists whatsapp_conversation_id uuid,
  add column if not exists sale_source text;

alter table public.tracking_sessions drop constraint if exists tracking_sessions_lead_source_check;
alter table public.tracking_sessions add constraint tracking_sessions_lead_source_check
  check (lead_source is null or lead_source in ('page_confirm', 'whatsapp_message', 'manual'));

alter table public.tracking_sessions drop constraint if exists tracking_sessions_sale_source_check;
alter table public.tracking_sessions add constraint tracking_sessions_sale_source_check
  check (sale_source is null or sale_source in ('manual', 'ai'));

-- Backfill honesto. A migration 20260723120000 preencheu whatsapp_opened_at
-- com o horário do clique em TODO o histórico, então esse campo não prova nada
-- para sessões antigas. Só vira lead quem tem evidência real:
--   - confirmação de verdade (whatsapp_opened_at diferente do horário do clique);
--   - ou o atendente já mexeu no lead / registrou contato.
update public.tracking_sessions
set
  lead_confirmed_at = coalesce(whatsapp_opened_at, last_crm_activity_at, clicked_at),
  lead_source = case
    when whatsapp_opened_at is not null
     and whatsapp_opened_at <> coalesce(redirected_at, clicked_at) then 'page_confirm'
    else 'manual'
  end
where lead_confirmed_at is null
  and (
    (whatsapp_opened_at is not null and whatsapp_opened_at <> coalesce(redirected_at, clicked_at))
    or lead_status <> 'new'
    or customer_phone is not null
    or customer_email is not null
  );

create index if not exists idx_tracking_sessions_lead_confirmed
  on public.tracking_sessions (tenant_id, lead_confirmed_at desc)
  where lead_confirmed_at is not null;

create index if not exists idx_tracking_sessions_dedup
  on public.tracking_sessions (tenant_id, ip, clicked_at desc);

create index if not exists idx_tracking_sessions_customer_phone
  on public.tracking_sessions (tenant_id, customer_phone)
  where customer_phone is not null;

-- ---------------------------------------------------------------------------
-- Integração WhatsApp por empresa (Evolution API). Só service_role lê: a API
-- key nunca vai para o navegador. O painel usa a Edge Function `whatsapp`.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_whatsapp_integrations (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  provider text not null default 'evolution' check (provider in ('evolution')),
  api_url text not null,
  instance_name text not null,
  api_key text not null,
  webhook_secret text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  enabled boolean not null default true,
  connection_state text,
  integration_status text not null default 'pending'
    check (integration_status in ('pending', 'connected', 'needs_attention')),
  last_event_at timestamptz,
  last_error text,
  ai_enabled boolean not null default true,
  ai_auto_confirm boolean not null default true,
  ai_min_confidence numeric(3,2) not null default 0.85
    check (ai_min_confidence >= 0.5 and ai_min_confidence <= 1),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_whatsapp_integrations enable row level security;

create policy tenant_whatsapp_integrations_service_only
on public.tenant_whatsapp_integrations for all
to service_role
using (true)
with check (true);

grant select, insert, update, delete on public.tenant_whatsapp_integrations to service_role;

-- ---------------------------------------------------------------------------
-- Conversas e mensagens recebidas pelo webhook da Evolution API.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  remote_jid text not null,
  phone text,
  contact_name text,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  match_method text not null default 'none'
    check (match_method in ('ref', 'phone', 'time_window', 'none', 'manual')),
  first_message_at timestamptz,
  first_inbound_at timestamptz,
  last_message_at timestamptz,
  message_count int not null default 0,
  needs_analysis boolean not null default false,
  last_analyzed_at timestamptz,
  last_analysis jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, remote_jid)
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  external_id text not null,
  from_me boolean not null,
  message_type text,
  body text,
  sent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

alter table public.tracking_sessions
  drop constraint if exists tracking_sessions_whatsapp_conversation_fk;
alter table public.tracking_sessions
  add constraint tracking_sessions_whatsapp_conversation_fk
  foreign key (whatsapp_conversation_id) references public.whatsapp_conversations(id) on delete set null;

create index if not exists idx_whatsapp_conversations_tenant_last
  on public.whatsapp_conversations (tenant_id, last_message_at desc);
create index if not exists idx_whatsapp_conversations_pending
  on public.whatsapp_conversations (tenant_id, last_message_at)
  where needs_analysis;
create index if not exists idx_whatsapp_conversations_session
  on public.whatsapp_conversations (tracking_session_id);
create index if not exists idx_whatsapp_messages_conversation
  on public.whatsapp_messages (conversation_id, sent_at desc);

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;

create policy whatsapp_conversations_select_member
on public.whatsapp_conversations for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy whatsapp_conversations_service
on public.whatsapp_conversations for all
to service_role
using (true)
with check (true);

create policy whatsapp_messages_select_member
on public.whatsapp_messages for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy whatsapp_messages_service
on public.whatsapp_messages for all
to service_role
using (true)
with check (true);

grant select on public.whatsapp_conversations to authenticated;
grant select on public.whatsapp_messages to authenticated;
grant select, insert, update, delete on public.whatsapp_conversations to service_role;
grant select, insert, update, delete on public.whatsapp_messages to service_role;

-- ---------------------------------------------------------------------------
-- Vendas detectadas pela IA na conversa.
--   auto_confirmed: confiança acima do mínimo da empresa -> venda lançada sozinha
--   pending:        IA achou venda, mas pede confirmação do atendente
--   confirmed / dismissed: decisão do atendente
-- ---------------------------------------------------------------------------
create table if not exists public.sale_detections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'auto_confirmed', 'confirmed', 'dismissed')),
  confidence numeric(3,2) not null,
  sale_value numeric(12,2),
  product text,
  customer_name text,
  customer_phone text,
  evidence text[] not null default '{}',
  summary text,
  model text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sale_detections_tenant_status
  on public.sale_detections (tenant_id, status, created_at desc);
create unique index if not exists idx_sale_detections_one_open_per_conversation
  on public.sale_detections (conversation_id)
  where status in ('pending', 'auto_confirmed', 'confirmed');

alter table public.sale_detections enable row level security;

create policy sale_detections_select_member
on public.sale_detections for select
to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy sale_detections_service
on public.sale_detections for all
to service_role
using (true)
with check (true);

grant select on public.sale_detections to authenticated;
grant select, insert, update, delete on public.sale_detections to service_role;

create or replace view public.vw_sale_detections
with (security_invoker = true) as
select
  d.id,
  d.tenant_id,
  d.status,
  d.confidence,
  d.sale_value,
  d.product,
  coalesce(d.customer_name, c.contact_name) as customer_name,
  coalesce(d.customer_phone, c.phone) as customer_phone,
  d.evidence,
  d.summary,
  d.created_at,
  d.reviewed_at,
  d.conversation_id,
  d.tracking_session_id,
  ts.ref,
  ts.utm_campaign,
  ts.utm_content,
  c.match_method,
  c.last_message_at
from public.sale_detections d
join public.whatsapp_conversations c on c.id = d.conversation_id
left join public.tracking_sessions ts on ts.id = d.tracking_session_id;

grant select on public.vw_sale_detections to authenticated;

-- ---------------------------------------------------------------------------
-- Views do painel: lead = lead_confirmed_at, clique = sessão não duplicada.
-- ---------------------------------------------------------------------------
drop view if exists public.vw_crm_pipeline;

create or replace view public.vw_lead_queue
with (security_invoker = true) as
select
  ts.id,
  ts.tenant_id,
  ts.ref,
  ts.lead_status,
  ts.clicked_at,
  ts.sold_at,
  ts.lost_at,
  ts.qualified_at,
  ts.bad_at,
  ts.next_follow_up_at,
  ts.lead_score,
  ts.tags,
  ts.last_crm_activity_at,
  ts.revenue,
  ts.customer_phone,
  ts.utm_source,
  ts.utm_medium,
  ts.utm_campaign,
  sl.name as link_name,
  sl.code as link_code,
  o.name as offer_name,
  o.category,
  ts.customer_name,
  ts.customer_email,
  ts.utm_content,
  ts.utm_term,
  ts.lead_confirmed_at,
  ts.lead_source,
  ts.sale_source,
  ts.whatsapp_conversation_id
from public.tracking_sessions ts
left join public.smart_links sl on sl.id = ts.smart_link_id
left join public.offers o on o.id = ts.offer_id
where ts.lead_confirmed_at is not null
  and ts.duplicate_of is null;

create or replace view public.vw_crm_pipeline
with (security_invoker = true) as
with activity as (
  select tracking_session_id, count(*) as activity_count, max(created_at) as last_activity_at
  from public.crm_activities
  group by tracking_session_id
)
select
  q.*,
  coalesce(a.activity_count, 0) as activity_count,
  a.last_activity_at,
  (q.lead_status = 'qualified') as is_remarketing
from public.vw_lead_queue q
left join activity a on a.tracking_session_id = q.id;

grant select on public.vw_lead_queue to authenticated;
grant select on public.vw_crm_pipeline to authenticated;

create or replace view public.vw_smart_link_performance
with (security_invoker = true) as
select
  sl.id,
  sl.tenant_id,
  sl.code,
  sl.name,
  sl.status,
  o.name as offer_name,
  o.category,
  count(ts.id) filter (where ts.duplicate_of is null) as clicks,
  count(ts.id) filter (where ts.lead_status in ('contacted','qualified','bad','sold','lost')) as handled,
  count(ts.id) filter (where ts.lead_status = 'qualified') as qualified,
  count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
  count(ts.id) filter (where ts.lead_status = 'sold') as sales,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case
    when count(ts.id) filter (where ts.lead_confirmed_at is not null and ts.duplicate_of is null) = 0 then 0
    else round((count(ts.id) filter (where ts.lead_status = 'sold'))::numeric
      / count(ts.id) filter (where ts.lead_confirmed_at is not null and ts.duplicate_of is null) * 100, 1)
  end as conversion_rate,
  count(ts.id) filter (where ts.lead_confirmed_at is not null and ts.duplicate_of is null) as leads
from public.smart_links sl
left join public.offers o on o.id = sl.offer_id
left join public.tracking_sessions ts on ts.smart_link_id = sl.id
group by sl.id, sl.tenant_id, sl.code, sl.name, sl.status, o.name, o.category;

create or replace view public.vw_lead_quality_report
with (security_invoker = true) as
with real_leads as (
  select ts.*
  from public.tracking_sessions ts
  where ts.lead_confirmed_at is not null and ts.duplicate_of is null
)
select
  ts.tenant_id,
  coalesce(ts.utm_campaign, 'sem-campanha') as campaign_key,
  max(coalesce(sl.name, 'Sem link')) as link_name,
  count(ts.id) as leads,
  count(ts.id) filter (where ts.lead_status = 'new') as new_leads,
  count(ts.id) filter (where ts.lead_status = 'contacted') as contacted_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as qualified_leads,
  count(ts.id) filter (where ts.lead_status = 'qualified') as remarketing_leads,
  count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
  count(ts.id) filter (where ts.lead_status = 'sold') as sales,
  count(ts.id) filter (where ts.lead_status = 'lost') as lost_leads,
  coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue,
  case when count(ts.id) = 0 then 0 else round(count(ts.id) filter (where ts.lead_status = 'qualified')::numeric / count(ts.id) * 100, 1) end as quality_rate,
  case when count(ts.id) = 0 then 0 else round(count(ts.id) filter (where ts.lead_status = 'bad')::numeric / count(ts.id) * 100, 1) end as bad_rate,
  max(ts.clicked_at) as last_lead_at
from real_leads ts
left join public.smart_links sl on sl.id = ts.smart_link_id
group by ts.tenant_id, coalesce(ts.utm_campaign, 'sem-campanha');

create or replace view public.vw_tenant_report
with (security_invoker = true) as
with sessions as (
  select
    tenant_id,
    count(*) filter (where duplicate_of is null) as clicks,
    count(*) filter (where duplicate_of is not null) as duplicate_clicks,
    count(*) filter (where lead_confirmed_at is not null and duplicate_of is null) as leads,
    count(*) filter (where lead_status = 'qualified') as remarketing_leads,
    count(*) filter (where lead_status = 'sold') as sales,
    count(*) filter (where lead_status = 'sold' and sale_source = 'ai') as ai_sales,
    coalesce(sum(revenue) filter (where lead_status = 'sold'), 0) as revenue,
    max(clicked_at) as last_click_at,
    max(sold_at) as last_sale_at
  from public.tracking_sessions
  group by tenant_id
),
conversations as (
  select
    tenant_id,
    count(*) filter (where first_inbound_at is not null) as whatsapp_conversations,
    count(*) filter (where first_inbound_at is not null and match_method = 'none') as unattributed_conversations
  from public.whatsapp_conversations
  group by tenant_id
),
detections as (
  select tenant_id, count(*) as ai_pending_sales
  from public.sale_detections
  where status = 'pending'
  group by tenant_id
)
select
  t.id as tenant_id,
  t.name as tenant_name,
  coalesce(s.clicks, 0) as clicks,
  coalesce(s.leads, 0) as whatsapp_leads,
  coalesce(s.remarketing_leads, 0) as remarketing_leads,
  coalesce(s.sales, 0) as sales,
  coalesce(s.revenue, 0) as revenue,
  case when coalesce(s.leads, 0) = 0 then 0 else round(s.sales::numeric / s.leads * 100, 1) end as conversion_rate,
  s.last_click_at,
  s.last_sale_at,
  coalesce(s.duplicate_clicks, 0) as duplicate_clicks,
  coalesce(c.whatsapp_conversations, 0) as whatsapp_conversations,
  coalesce(c.unattributed_conversations, 0) as unattributed_conversations,
  coalesce(s.ai_sales, 0) as ai_sales,
  coalesce(d.ai_pending_sales, 0) as ai_pending_sales
from public.tenants t
left join sessions s on s.tenant_id = t.id
left join conversations c on c.tenant_id = t.id
left join detections d on d.tenant_id = t.id;

grant select on public.vw_tenant_report to authenticated;

create or replace view public.vw_meta_campaign_roi
with (security_invoker = true) as
with meta as (
  select tenant_id, campaign_id, max(campaign_name) as campaign_name, sum(spend) as spend,
    sum(impressions) as impressions, sum(reach) as reach, sum(clicks) as clicks,
    min(date_start) as date_start, max(date_stop) as date_stop
  from public.meta_campaign_insights
  group by tenant_id, campaign_id
),
tracked as (
  select ts.tenant_id, coalesce(m.meta_campaign_id, ts.utm_campaign) as campaign_key,
    count(ts.id) filter (where ts.lead_confirmed_at is not null and ts.duplicate_of is null) as leads,
    count(ts.id) filter (where ts.lead_status = 'qualified') as qualified_leads,
    count(ts.id) filter (where ts.lead_status = 'bad') as bad_leads,
    count(ts.id) filter (where ts.lead_status = 'sold') as sales,
    coalesce(sum(ts.revenue) filter (where ts.lead_status = 'sold'), 0) as revenue
  from public.tracking_sessions ts
  left join public.meta_campaign_mappings m
    on m.tenant_id = ts.tenant_id and lower(m.utm_campaign) = lower(ts.utm_campaign)
  group by ts.tenant_id, coalesce(m.meta_campaign_id, ts.utm_campaign)
),
matched as (
  select meta.tenant_id, meta.campaign_id, sum(t.leads) as leads, sum(t.qualified_leads) as qualified_leads,
    sum(t.bad_leads) as bad_leads, sum(t.sales) as sales, sum(t.revenue) as revenue
  from meta
  join tracked t on t.tenant_id = meta.tenant_id
   and lower(t.campaign_key) in (lower(meta.campaign_id), lower(meta.campaign_name))
  group by meta.tenant_id, meta.campaign_id
)
select meta.tenant_id, meta.campaign_id, meta.campaign_name, meta.date_start, meta.date_stop,
  meta.spend, meta.impressions, meta.reach, meta.clicks as meta_clicks,
  coalesce(matched.leads, 0)::bigint as idx_leads,
  coalesce(matched.qualified_leads, 0)::bigint as idx_qualified,
  coalesce(matched.bad_leads, 0)::bigint as idx_bad,
  coalesce(matched.sales, 0)::bigint as idx_sales,
  coalesce(matched.revenue, 0) as idx_revenue,
  case when coalesce(matched.leads, 0) = 0 then null else round(meta.spend / matched.leads, 2) end as cpl,
  case when coalesce(matched.qualified_leads, 0) = 0 then null else round(meta.spend / matched.qualified_leads, 2) end as cost_per_qualified,
  case when coalesce(matched.leads, 0) = 0 then 0 else round(matched.qualified_leads::numeric / matched.leads * 100, 1) end as quality_rate,
  case when meta.spend = 0 then null else round(coalesce(matched.revenue, 0) / meta.spend, 2) end as roas
from meta
left join matched on matched.tenant_id = meta.tenant_id and matched.campaign_id = meta.campaign_id;

grant select on public.vw_meta_campaign_roi to authenticated;
