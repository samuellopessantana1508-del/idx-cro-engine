-- ============================================================================
-- CRM IDX — Receita, pedidos, amostras, onboarding/CS, campanhas e RFV
-- ----------------------------------------------------------------------------
-- Regras financeiras (aplicadas no banco, não só na tela):
--   * Só "compra válida" alimenta receita e RFV:
--       status em (confirmed, paid, partially_refunded), is_free = false,
--       net_amount > 0.
--   * pending  = venda declarada/aguardando evidência → NÃO conta.
--   * cancelled/refunded → NÃO conta. Devoluções reduzem net_amount.
--   * Parcelas são pagamentos de UM pedido (crm_payments), não vários pedidos.
--   * Amostras grátis ficam em crm_samples (marketing), nunca em pedidos.
--   * Negociação ganha NÃO cria receita sozinha: o pedido precisa ser registrado
--     com evidência (evidence_type).
-- ============================================================================

-- Gancho de automações (substituído em 20261110120200_crm_automations.sql)
create or replace function idx_private.crm_fire_event(p_tenant_id uuid, p_event text, p_record_type text, p_record_id uuid, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$ begin return; end; $$;

-- ---------------------------------------------------------------------------
-- 1. Pedidos / vendas
-- ---------------------------------------------------------------------------
create table if not exists public.crm_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid,
  contact_id uuid,
  company_id uuid,
  deal_id uuid,
  owner_id uuid references auth.users(id) on delete set null,
  order_number text,
  order_date timestamptz not null default now(),
  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'paid', 'partially_refunded', 'refunded', 'cancelled')),
  order_kind text not null default 'one_time' check (order_kind in ('one_time', 'recurring_cycle')),
  gross_amount numeric(14,2) not null default 0 check (gross_amount >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  refunded_amount numeric(14,2) not null default 0 check (refunded_amount >= 0),
  net_amount numeric(14,2) generated always as (greatest(gross_amount - discount_amount - refunded_amount, 0)) stored,
  currency text not null default 'BRL',
  installments int not null default 1 check (installments between 1 and 120),
  is_free boolean not null default false,
  payment_method text,
  evidence_type text not null default 'manual_confirmation'
    check (evidence_type in ('payment', 'contract', 'invoice', 'pos', 'manual_confirmation', 'legacy_confirmation', 'ai_signal_reviewed', 'ai_auto_unreviewed', 'import')),
  evidence_note text,
  source text not null default 'manual' check (source in ('manual', 'deal', 'legacy_tracking', 'sale_signal', 'import', 'recurring')),
  source_ref text,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  sale_signal_id uuid references public.sale_signals(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (discount_amount <= gross_amount),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete set null (company_id),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, unit_id) references public.crm_units(tenant_id, id) on delete set null (unit_id)
);
-- Idempotência: a mesma origem nunca gera dois pedidos.
create unique index if not exists crm_orders_source_key on public.crm_orders(tenant_id, source, source_ref) where source_ref is not null;
create index if not exists idx_crm_orders_contact on public.crm_orders(tenant_id, contact_id, order_date desc);
create index if not exists idx_crm_orders_date on public.crm_orders(tenant_id, order_date desc);
create index if not exists idx_crm_orders_deal on public.crm_orders(deal_id) where deal_id is not null;

create table if not exists public.crm_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null,
  offer_id uuid,
  name text not null,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  total numeric(14,2) generated always as (greatest(round(quantity * unit_price - discount, 2), 0)) stored,
  unit_cost numeric(14,2),
  foreign key (tenant_id, order_id) references public.crm_orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, offer_id) references public.offers(tenant_id, id) on delete set null (offer_id)
);
create index if not exists idx_crm_order_items_order on public.crm_order_items(order_id);
create index if not exists idx_crm_order_items_offer on public.crm_order_items(tenant_id, offer_id);

create table if not exists public.crm_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null,
  kind text not null default 'payment' check (kind in ('payment', 'refund', 'chargeback')),
  amount numeric(14,2) not null check (amount > 0),
  installment_number int,
  method text,
  paid_at timestamptz not null default now(),
  external_ref text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.crm_orders(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_payments_order on public.crm_payments(order_id);
create unique index if not exists crm_payments_external_key on public.crm_payments(tenant_id, external_ref) where external_ref is not null;

create or replace function idx_private.crm_is_valid_purchase(p_status text, p_is_free boolean, p_net numeric)
returns boolean language sql immutable set search_path = pg_temp
as $$ select p_status in ('confirmed', 'paid', 'partially_refunded') and not p_is_free and coalesce(p_net, 0) > 0 $$;

create or replace function idx_private.crm_order_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not idx_private.is_tenant_member(new.tenant_id, new.owner_id) then
    raise exception 'O responsável precisa ser usuário desta empresa.' using errcode = '42501';
  end if;
  if new.is_free and new.gross_amount > 0 then
    raise exception 'Pedido gratuito não pode ter valor. Para amostras use o registro de amostras.' using errcode = '22023';
  end if;
  -- herda contato/empresa da negociação
  if new.deal_id is not null and (new.contact_id is null or new.company_id is null) then
    select coalesce(new.contact_id, d.contact_id), coalesce(new.company_id, d.company_id)
      into new.contact_id, new.company_id
    from public.crm_deals d where d.id = new.deal_id and d.tenant_id = new.tenant_id;
  end if;
  if new.status in ('confirmed', 'paid', 'partially_refunded') then
    new.confirmed_at := coalesce(new.confirmed_at, now());
    new.confirmed_by := coalesce(new.confirmed_by, auth.uid());
  end if;
  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists trg_crm_orders_before_write on public.crm_orders;
create trigger trg_crm_orders_before_write before insert or update on public.crm_orders
for each row execute function idx_private.crm_order_before_write();

create or replace function idx_private.crm_order_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  was_valid boolean := false;
  is_valid boolean;
  prior_valid int;
begin
  if tg_op = 'DELETE' then
    update public.crm_rfv_settings set dirty = true where tenant_id = old.tenant_id;
    return old;
  end if;
  is_valid := idx_private.crm_is_valid_purchase(new.status, new.is_free, new.net_amount);
  if tg_op = 'UPDATE' then
    was_valid := idx_private.crm_is_valid_purchase(old.status, old.is_free, old.net_amount);
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status or new.net_amount is distinct from old.net_amount then
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, company_id, kind, title, metadata, actor_id, occurred_at)
    values (new.tenant_id, new.contact_id, new.deal_id, new.company_id,
            case when new.status in ('refunded', 'partially_refunded') then 'refund' else 'order' end,
            case
              when tg_op = 'INSERT' and is_valid then 'Venda registrada'
              when tg_op = 'INSERT' and new.status = 'pending' then 'Venda declarada (aguardando confirmação)'
              when tg_op = 'INSERT' then 'Pedido registrado'
              when new.status = 'cancelled' then 'Pedido cancelado'
              when new.status = 'refunded' then 'Pedido estornado'
              when new.status = 'partially_refunded' then 'Devolução parcial'
              when is_valid and not was_valid then 'Venda confirmada'
              else 'Pedido atualizado' end,
            jsonb_build_object('order_id', new.id, 'status', new.status, 'net_amount', new.net_amount,
                               'evidence_type', new.evidence_type, 'source', new.source),
            auth.uid(), case when tg_op = 'INSERT' then new.order_date else now() end);
  end if;

  if is_valid and new.contact_id is not null then
    update public.crm_contacts set lifecycle_stage = 'customer', lifecycle_source = 'auto',
           last_interaction_at = greatest(coalesce(last_interaction_at, new.order_date), new.order_date)
    where id = new.contact_id and lifecycle_stage <> 'customer';
    if not was_valid then
      select count(*) into prior_valid from public.crm_orders o
      where o.contact_id = new.contact_id and o.id <> new.id
        and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount);
      perform idx_private.crm_fire_event(new.tenant_id, case when prior_valid = 0 then 'first_purchase' else 'repeat_purchase' end,
        'order', new.id, jsonb_build_object('contact_id', new.contact_id, 'net_amount', new.net_amount));
    end if;
  end if;

  update public.crm_rfv_settings set dirty = true where tenant_id = new.tenant_id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Pagamentos, parcelas, estornos
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_payment_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  oid uuid := coalesce(new.order_id, old.order_id);
  paid numeric;
  refunded numeric;
  o record;
begin
  select coalesce(sum(amount) filter (where kind = 'payment'), 0),
         coalesce(sum(amount) filter (where kind in ('refund', 'chargeback')), 0)
    into paid, refunded
  from public.crm_payments where order_id = oid;
  select * into o from public.crm_orders where id = oid;
  if not found then return coalesce(new, old); end if;
  update public.crm_orders set
    refunded_amount = least(refunded, gross_amount - discount_amount),
    status = case
      when status in ('cancelled') then status
      when refunded > 0 and refunded >= gross_amount - discount_amount then 'refunded'
      when refunded > 0 then 'partially_refunded'
      when paid >= gross_amount - discount_amount and gross_amount > 0 then 'paid'
      when status in ('refunded', 'partially_refunded') then 'confirmed'
      else status end
  where id = oid;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Amostras / experimentação (marketing, nunca compra)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_samples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null,
  offer_id uuid,
  product_name text not null,
  delivered_at timestamptz not null default now(),
  campaign text,
  channel text,
  feedback text,
  rating int check (rating is null or rating between 1 and 5),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, offer_id) references public.offers(tenant_id, id) on delete set null (offer_id)
);
create index if not exists idx_crm_samples_contact on public.crm_samples(tenant_id, contact_id, delivered_at);

create or replace view public.vw_crm_sample_conversion
with (security_invoker = true) as
select
  s.id, s.tenant_id, s.contact_id, c.name as contact_name, s.product_name, s.offer_id, s.campaign, s.channel,
  s.delivered_at, s.rating, s.feedback,
  fp.order_date as first_purchase_after_at,
  case when fp.order_date is null then null else round(extract(epoch from fp.order_date - s.delivered_at) / 86400.0, 1) end as days_to_first_purchase,
  coalesce(rev.revenue_after, 0) as revenue_after,
  coalesce(rev.orders_after, 0) as orders_after
from public.crm_samples s
join public.crm_contacts c on c.id = s.contact_id
left join lateral (
  select o.order_date from public.crm_orders o
  where o.contact_id = s.contact_id and o.order_date >= s.delivered_at
    and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
  order by o.order_date limit 1
) fp on true
left join lateral (
  select sum(o.net_amount) as revenue_after, count(*) as orders_after from public.crm_orders o
  where o.contact_id = s.contact_id and o.order_date >= s.delivered_at
    and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
) rev on true;

-- ---------------------------------------------------------------------------
-- 4. Onboarding, Customer Success e atendimento
-- ---------------------------------------------------------------------------
create table if not exists public.crm_onboardings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid,
  company_id uuid,
  deal_id uuid,
  order_id uuid,
  owner_id uuid references auth.users(id) on delete set null,
  title text not null,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'active', 'at_risk', 'churned', 'completed')),
  promised text,                       -- o que foi prometido na venda (handoff)
  handoff_notes text,
  success_plan text,
  checklist jsonb not null default '[]'::jsonb,  -- [{id,label,done,done_at}]
  started_at timestamptz not null default now(),
  activated_at timestamptz,
  first_value_at timestamptz,
  first_value_note text,
  renewal_date date,
  nps int check (nps is null or nps between 0 and 10),
  csat int check (csat is null or csat between 1 and 5),
  health text check (health is null or health in ('good', 'attention', 'critical')),
  risk_notes text,
  expansion_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete set null (company_id),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, order_id) references public.crm_orders(tenant_id, id) on delete set null (order_id)
);
create index if not exists idx_crm_onboardings_tenant on public.crm_onboardings(tenant_id, status);
create unique index if not exists crm_onboardings_deal_key on public.crm_onboardings(deal_id) where deal_id is not null;

create table if not exists public.crm_service_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid,
  onboarding_id uuid,
  subject text not null,
  description text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  owner_id uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  first_response_at timestamptz,
  resolved_at timestamptz,
  satisfaction int check (satisfaction is null or satisfaction between 1 and 5),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, onboarding_id) references public.crm_onboardings(tenant_id, id) on delete set null (onboarding_id)
);
create index if not exists idx_crm_service_requests on public.crm_service_requests(tenant_id, status, opened_at desc);

-- ---------------------------------------------------------------------------
-- 5. Campanhas (aquisição, retenção, reativação, amostras)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  kind text not null default 'retention' check (kind in ('acquisition', 'retention', 'reactivation', 'sampling', 'upsell', 'referral')),
  channel text,
  segment_filter jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'finished', 'archived')),
  starts_at date,
  ends_at date,
  budget numeric(14,2),
  attribution_window_days int not null default 60 check (attribution_window_days between 1 and 365),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table if not exists public.crm_campaign_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  segment_at_entry text,
  added_at timestamptz not null default now(),
  contacted_at timestamptz,
  responded_at timestamptz,
  unique (campaign_id, contact_id),
  foreign key (tenant_id, campaign_id) references public.crm_campaigns(tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade
);

-- Resultado por campanha: compras válidas DEPOIS da entrada, dentro da janela.
create or replace view public.vw_crm_campaign_results
with (security_invoker = true) as
select
  c.id as campaign_id, c.tenant_id, c.name, c.kind, c.status, c.attribution_window_days,
  count(distinct m.contact_id) as members,
  count(distinct m.contact_id) filter (where m.responded_at is not null) as responded,
  count(distinct o.contact_id) as converted,
  coalesce(sum(o.net_amount), 0) as revenue,
  count(distinct o.contact_id) filter (where m.segment_at_entry in ('hibernating', 'lost', 'at_risk', 'high_value_at_risk')) as reactivated,
  coalesce(sum(o.net_amount) filter (where m.segment_at_entry in ('hibernating', 'lost', 'at_risk', 'high_value_at_risk')), 0) as revenue_recovered
from public.crm_campaigns c
left join public.crm_campaign_members m on m.campaign_id = c.id
left join public.crm_orders o on o.contact_id = m.contact_id
  and o.order_date >= m.added_at
  and o.order_date < m.added_at + make_interval(days => c.attribution_window_days)
  and idx_private.crm_is_valid_purchase(o.status, o.is_free, o.net_amount)
group by c.id;

-- ---------------------------------------------------------------------------
-- 6. RFV
-- ---------------------------------------------------------------------------
create table if not exists public.crm_rfv_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  preset text not null default 'general',
  method text not null default 'auto' check (method in ('auto', 'quintile', 'manual')),
  -- Recência (dias desde a última compra válida), limites para notas 5,4,3,2 (acima => 1)
  r_thresholds int[] not null default array[30, 60, 120, 240],
  -- Frequência (nº de compras válidas) mínimos para notas 2,3,4,5
  f_thresholds int[] not null default array[2, 3, 5, 8],
  -- Valor (receita líquida) mínimos para notas 2,3,4,5
  m_thresholds numeric[] not null default array[200, 500, 1500, 5000],
  window_days int check (window_days is null or window_days between 30 and 3650),
  lost_after_days int not null default 365 check (lost_after_days between 30 and 3650),
  count_recurring_cycles boolean not null default true,
  min_customers_quintile int not null default 30 check (min_customers_quintile >= 10),
  rule_version int not null default 1,
  dirty boolean not null default true,
  last_computed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (array_length(r_thresholds, 1) = 4 and array_length(f_thresholds, 1) = 4 and array_length(m_thresholds, 1) = 4)
);

create table if not exists public.crm_rfv_scores (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null,
  r_score int check (r_score between 1 and 5),
  f_score int check (f_score between 1 and 5),
  m_score int check (m_score between 1 and 5),
  segment text not null check (segment in ('champions', 'loyal', 'high_value_at_risk', 'at_risk', 'new', 'potential', 'hibernating', 'lost', 'no_purchase')),
  previous_segment text,
  segment_changed_at timestamptz,
  days_since_last int,
  first_purchase_at timestamptz,
  last_purchase_at timestamptz,
  purchase_count int not null default 0,
  net_revenue numeric(14,2) not null default 0,
  avg_ticket numeric(14,2),
  avg_interval_days numeric(10,1),
  expected_next_purchase_at timestamptz,
  overdue_days int,
  method_used text,
  rule_version int,
  window_start timestamptz,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, contact_id),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_rfv_segment on public.crm_rfv_scores(tenant_id, segment);

create table if not exists public.crm_rfv_history (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null,
  r_score int, f_score int, m_score int,
  segment text not null,
  previous_segment text,
  net_revenue numeric(14,2),
  purchase_count int,
  rule_version int,
  method_used text,
  computed_at timestamptz not null default now(),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_rfv_history on public.crm_rfv_history(tenant_id, contact_id, computed_at desc);
create index if not exists idx_crm_rfv_history_tenant on public.crm_rfv_history(tenant_id, computed_at desc);

create or replace function idx_private.crm_rfv_settings_bump()
returns trigger language plpgsql set search_path = pg_temp
as $$
begin
  if (new.r_thresholds, new.f_thresholds, new.m_thresholds, new.method, new.window_days, new.lost_after_days, new.count_recurring_cycles, new.min_customers_quintile)
     is distinct from
     (old.r_thresholds, old.f_thresholds, old.m_thresholds, old.method, old.window_days, old.lost_after_days, old.count_recurring_cycles, old.min_customers_quintile) then
    if not (new.r_thresholds[1] < new.r_thresholds[2] and new.r_thresholds[2] < new.r_thresholds[3] and new.r_thresholds[3] < new.r_thresholds[4]
        and new.f_thresholds[1] < new.f_thresholds[2] and new.f_thresholds[2] < new.f_thresholds[3] and new.f_thresholds[3] < new.f_thresholds[4]
        and new.m_thresholds[1] < new.m_thresholds[2] and new.m_thresholds[2] < new.m_thresholds[3] and new.m_thresholds[3] < new.m_thresholds[4]
        and new.f_thresholds[1] >= 2 and new.r_thresholds[1] >= 1) then
      raise exception 'As faixas RFV precisam ser crescentes (ex.: 30 < 60 < 120 < 240).' using errcode = '22023';
    end if;
    new.rule_version := old.rule_version + 1;
    new.dirty := true;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_crm_rfv_settings_bump on public.crm_rfv_settings;
create trigger trg_crm_rfv_settings_bump before update on public.crm_rfv_settings
for each row execute function idx_private.crm_rfv_settings_bump();

-- Presets por modelo de negócio (ciclos de recompra diferentes)
create or replace function public.crm_rfv_apply_preset(p_tenant_id uuid, p_preset text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.crm_rfv_settings(tenant_id) values (p_tenant_id) on conflict do nothing;
  update public.crm_rfv_settings set
    preset = p_preset,
    r_thresholds = case p_preset
      when 'pharmacy' then array[30, 45, 75, 120]
      when 'perfumery' then array[45, 90, 150, 240]
      when 'events' then array[365, 540, 730, 1095]
      when 'recurring_services' then array[35, 65, 95, 180]
      when 'clinic' then array[90, 180, 270, 365]
      when 'b2b_agency' then array[35, 65, 120, 240]
      else array[30, 60, 120, 240] end,
    f_thresholds = case p_preset
      when 'pharmacy' then array[2, 4, 6, 10]
      when 'events' then array[2, 3, 4, 5]
      when 'recurring_services' then array[3, 6, 12, 24]
      when 'b2b_agency' then array[3, 6, 12, 24]
      else array[2, 3, 5, 8] end,
    m_thresholds = case p_preset
      when 'pharmacy' then array[150, 400, 900, 2000]::numeric[]
      when 'perfumery' then array[200, 500, 1200, 3000]::numeric[]
      when 'events' then array[3000, 8000, 15000, 30000]::numeric[]
      when 'recurring_services' then array[1000, 3000, 8000, 20000]::numeric[]
      when 'clinic' then array[300, 900, 2500, 6000]::numeric[]
      when 'b2b_agency' then array[3000, 9000, 24000, 60000]::numeric[]
      else array[200, 500, 1500, 5000]::numeric[] end,
    lost_after_days = case p_preset
      when 'pharmacy' then 240 when 'perfumery' then 365 when 'events' then 1825
      when 'recurring_services' then 270 when 'clinic' then 540 when 'b2b_agency' then 365 else 365 end
  where tenant_id = p_tenant_id;
end;
$$;
grant execute on function public.crm_rfv_apply_preset(uuid, text) to authenticated;

-- Cálculo RFV de uma empresa. Idempotente; pode rodar a qualquer momento
-- (após compras/estornos e periodicamente, pela passagem do tempo).
create or replace function public.crm_compute_rfv(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    avg_interval = case when cnt > 1 then round((extract(epoch from last_at - first_at) / 86400.0 / (cnt - 1))::numeric, 1) end;

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
               when revenue >= cfg.m_thresholds[2] then 3 when revenue >= cfg.m_thresholds[1] then 2 else 1 end;
  end if;
  -- Frequência sempre por faixas: "1 compra" nunca vira nota alta por causa de empate em quintil
  update _rfv set f = case when cnt >= cfg.f_thresholds[4] then 5 when cnt >= cfg.f_thresholds[3] then 4
                           when cnt >= cfg.f_thresholds[2] then 3 when cnt >= cfg.f_thresholds[1] then 2 else 1 end;

  -- Segmentação: regras em ordem de prioridade => um único segmento por cliente.
  update _rfv set segment = case
    when days_since > cfg.lost_after_days then 'lost'
    when r <= 2 and m >= 4 then 'high_value_at_risk'
    when r >= 4 and f >= 4 and m >= 4 then 'champions'
    when r >= 3 and f >= 4 then 'loyal'
    when r >= 4 and cnt = 1 then 'new'
    when r >= 3 then 'potential'
    when r = 2 then 'at_risk'
    else 'hibernating' end;

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
$$;
revoke all on function public.crm_compute_rfv(uuid) from public;
grant execute on function public.crm_compute_rfv(uuid) to authenticated, service_role;

-- Recalcula todas as empresas (para agendamento diário via n8n/cron com service_role)
create or replace function public.crm_compute_rfv_all()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare t record; n int := 0;
begin
  for t in select id from public.tenants where status = 'active' loop
    perform public.crm_compute_rfv(t.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.crm_compute_rfv_all() from public, authenticated;
grant execute on function public.crm_compute_rfv_all() to service_role;

-- Clientes em risco, priorizados (alto valor em risco primeiro, depois maior receita)
create or replace view public.vw_crm_rfv_customers
with (security_invoker = true) as
select s.*, c.name, c.phone, c.email, c.owner_id, c.unit_id, c.source_channel, c.do_not_contact, c.marketing_consent,
  case s.segment
    when 'high_value_at_risk' then 1 when 'at_risk' then 2 when 'hibernating' then 3 when 'new' then 4
    when 'potential' then 5 when 'loyal' then 6 when 'champions' then 7 when 'lost' then 8 else 9 end as priority_rank
from public.crm_rfv_scores s
join public.crm_contacts c on c.id = s.contact_id;

-- ---------------------------------------------------------------------------
-- 7. Triggers dependentes
-- ---------------------------------------------------------------------------
drop trigger if exists trg_crm_orders_after_write on public.crm_orders;
create trigger trg_crm_orders_after_write after insert or update or delete on public.crm_orders
for each row execute function idx_private.crm_order_after_write();
drop trigger if exists trg_crm_payments_after_write on public.crm_payments;
create trigger trg_crm_payments_after_write after insert or update or delete on public.crm_payments
for each row execute function idx_private.crm_payment_after_write();
drop trigger if exists trg_crm_orders_audit on public.crm_orders;
create trigger trg_crm_orders_audit after insert or update or delete on public.crm_orders
for each row execute function idx_private.crm_audit();
drop trigger if exists trg_crm_onboardings_touch on public.crm_onboardings;
create trigger trg_crm_onboardings_touch before update on public.crm_onboardings
for each row execute function idx_private.touch_updated_at();
drop trigger if exists trg_crm_service_requests_touch on public.crm_service_requests;
create trigger trg_crm_service_requests_touch before update on public.crm_service_requests
for each row execute function idx_private.touch_updated_at();

create or replace function idx_private.crm_sample_after_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.crm_timeline(tenant_id, contact_id, kind, title, body, metadata, actor_id, occurred_at)
  values (new.tenant_id, new.contact_id, 'sample', 'Amostra entregue: ' || new.product_name, new.feedback,
          jsonb_build_object('sample_id', new.id, 'campaign', new.campaign), auth.uid(), new.delivered_at);
  return new;
end;
$$;
drop trigger if exists trg_crm_samples_after_insert on public.crm_samples;
create trigger trg_crm_samples_after_insert after insert on public.crm_samples
for each row execute function idx_private.crm_sample_after_insert();

-- defaults RFV para empresas existentes e novas
insert into public.crm_rfv_settings(tenant_id) select id from public.tenants on conflict do nothing;
create or replace function idx_private.crm_tenant_after_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform idx_private.crm_ensure_defaults(new.id);
  insert into public.crm_rfv_settings(tenant_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------
alter table public.crm_orders enable row level security;
alter table public.crm_order_items enable row level security;
alter table public.crm_payments enable row level security;
alter table public.crm_samples enable row level security;
alter table public.crm_onboardings enable row level security;
alter table public.crm_service_requests enable row level security;
alter table public.crm_campaigns enable row level security;
alter table public.crm_campaign_members enable row level security;
alter table public.crm_rfv_settings enable row level security;
alter table public.crm_rfv_scores enable row level security;
alter table public.crm_rfv_history enable row level security;

-- Financeiro: leitura para membros, escrita só para quem pode registrar vendas
do $$
declare t text;
begin
  foreach t in array array['crm_orders', 'crm_order_items', 'crm_payments'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (idx_private.crm_can(tenant_id, ''read''))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (idx_private.crm_can(tenant_id, ''finance''))', t || '_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (idx_private.crm_can(tenant_id, ''finance'')) with check (idx_private.crm_can(tenant_id, ''finance''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (idx_private.crm_can(tenant_id, ''delete''))', t || '_delete', t);
  end loop;
  foreach t in array array['crm_samples', 'crm_onboardings', 'crm_service_requests', 'crm_campaigns', 'crm_campaign_members'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (idx_private.crm_can(tenant_id, ''read''))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (idx_private.crm_can(tenant_id, ''write''))', t || '_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (idx_private.crm_can(tenant_id, ''write'')) with check (idx_private.crm_can(tenant_id, ''write''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (idx_private.crm_can(tenant_id, ''delete''))', t || '_delete', t);
  end loop;
end $$;

drop policy if exists crm_rfv_settings_select on public.crm_rfv_settings;
drop policy if exists crm_rfv_settings_write on public.crm_rfv_settings;
create policy crm_rfv_settings_select on public.crm_rfv_settings for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
create policy crm_rfv_settings_write on public.crm_rfv_settings for all to authenticated
  using (idx_private.crm_can(tenant_id, 'configure')) with check (idx_private.crm_can(tenant_id, 'configure'));
drop policy if exists crm_rfv_scores_select on public.crm_rfv_scores;
create policy crm_rfv_scores_select on public.crm_rfv_scores for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_rfv_history_select on public.crm_rfv_history;
create policy crm_rfv_history_select on public.crm_rfv_history for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

grant select, insert, update, delete on public.crm_orders, public.crm_order_items, public.crm_payments, public.crm_samples,
  public.crm_onboardings, public.crm_service_requests, public.crm_campaigns, public.crm_campaign_members to authenticated;
grant select, insert, update on public.crm_rfv_settings to authenticated;
grant select on public.crm_rfv_scores, public.crm_rfv_history to authenticated;
grant select on public.vw_crm_sample_conversion, public.vw_crm_campaign_results, public.vw_crm_rfv_customers to authenticated;
revoke all on public.crm_orders, public.crm_order_items, public.crm_payments, public.crm_samples, public.crm_onboardings,
  public.crm_service_requests, public.crm_campaigns, public.crm_campaign_members, public.crm_rfv_settings,
  public.crm_rfv_scores, public.crm_rfv_history, public.vw_crm_sample_conversion, public.vw_crm_campaign_results,
  public.vw_crm_rfv_customers from anon;
grant all on public.crm_orders, public.crm_order_items, public.crm_payments, public.crm_samples, public.crm_onboardings,
  public.crm_service_requests, public.crm_campaigns, public.crm_campaign_members, public.crm_rfv_settings,
  public.crm_rfv_scores, public.crm_rfv_history to service_role;
grant usage, select on sequence public.crm_rfv_history_id_seq to service_role;
grant execute on function idx_private.crm_is_valid_purchase(text, boolean, numeric) to authenticated, service_role;
