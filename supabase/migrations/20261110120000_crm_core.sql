-- ============================================================================
-- CRM IDX — Núcleo (contatos, empresas, funis, negociações, tarefas, histórico)
-- ----------------------------------------------------------------------------
-- Migration ADITIVA. Não remove nem reescreve tabelas existentes.
--   * tracking_sessions, whatsapp_*, crm_activities (legado), offers continuam
--     funcionando como antes. O vínculo com o CRM novo é feito em migrations
--     seguintes (crm_integration).
--   * Todo registro novo pertence a um tenant. FKs compostas (tenant_id, id)
--     impedem que uma negociação de uma empresa aponte para o contato de outra.
--   * Permissões reais no banco (RLS) via idx_private.crm_can().
-- Reversão: ver supabase/rollback/20261110_crm_rollback.sql
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 0. Papéis de CRM
-- ---------------------------------------------------------------------------
-- tenant_users.role continua sendo o nível de acesso legado
-- (owner/admin/operator/viewer) e segue protegendo as telas antigas.
-- crm_role refina o papel funcional do usuário dentro do CRM.
alter table public.tenant_users
  add column if not exists crm_role text;

alter table public.tenant_users drop constraint if exists tenant_users_crm_role_check;
alter table public.tenant_users
  add constraint tenant_users_crm_role_check
  check (crm_role is null or crm_role in ('manager', 'sales', 'marketing', 'service', 'success'));

comment on column public.tenant_users.crm_role is
  'Papel funcional no CRM. owner/admin => administrador da empresa; viewer => somente leitura; operator => crm_role (padrão: sales).';

-- Papel efetivo no CRM para o usuário atual.
create or replace function idx_private.crm_role(check_tenant_id uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(
    (
      select case when pu.role in ('owner', 'admin', 'support') then 'admin' else 'viewer' end
      from public.platform_users pu
      where pu.user_id = (select auth.uid()) and pu.status = 'active'
      order by case when pu.role in ('owner', 'admin', 'support') then 0 else 1 end
      limit 1
    ),
    (
      select case
        when tu.role in ('owner', 'admin') then 'admin'
        when tu.role = 'viewer' then 'viewer'
        else coalesce(tu.crm_role, 'sales')
      end
      from public.tenant_users tu
      where tu.tenant_id = check_tenant_id
        and tu.user_id = (select auth.uid())
        and tu.status = 'active'
      limit 1
    )
  );
$$;

-- Matriz de permissões do CRM.
--   read      : qualquer membro ativo
--   write     : criar/editar registros comerciais
--   configure : funis, etapas, campos, RFV, automações
--   finance   : registrar pedidos/vendas/pagamentos
--   delete    : excluir registros
--   export    : exportar dados
--   audit     : ler trilha de auditoria
create or replace function idx_private.crm_can(check_tenant_id uuid, perm text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(
    case perm
      when 'read' then r is not null
      when 'write' then r in ('admin', 'manager', 'sales', 'marketing', 'service', 'success')
      when 'configure' then r in ('admin', 'manager')
      when 'finance' then r in ('admin', 'manager', 'sales', 'success')
      when 'delete' then r in ('admin', 'manager')
      when 'export' then r in ('admin', 'manager', 'marketing')
      when 'audit' then r in ('admin', 'manager')
      else false
    end,
    false)
  from (select idx_private.crm_role(check_tenant_id) as r) x;
$$;

revoke all on function idx_private.crm_role(uuid) from public;
revoke all on function idx_private.crm_can(uuid, text) from public;
grant execute on function idx_private.crm_role(uuid) to authenticated;
grant execute on function idx_private.crm_can(uuid, text) to authenticated;

-- Função pública para o painel saber o que mostrar (a segurança real é o RLS).
create or replace function public.crm_my_access(p_tenant_id uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select jsonb_build_object(
    'role', idx_private.crm_role(p_tenant_id),
    'read', idx_private.crm_can(p_tenant_id, 'read'),
    'write', idx_private.crm_can(p_tenant_id, 'write'),
    'configure', idx_private.crm_can(p_tenant_id, 'configure'),
    'finance', idx_private.crm_can(p_tenant_id, 'finance'),
    'delete', idx_private.crm_can(p_tenant_id, 'delete'),
    'export', idx_private.crm_can(p_tenant_id, 'export'),
    'audit', idx_private.crm_can(p_tenant_id, 'audit'),
    'user_id', auth.uid()
  );
$$;
revoke all on function public.crm_my_access(uuid) from public;
grant execute on function public.crm_my_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Utilitários
-- ---------------------------------------------------------------------------
-- Normaliza telefone para dígitos E.164 (sem '+'). Retorna null se não parecer
-- um telefone (ex.: IDs internos do WhatsApp, grupos, textos).
create or replace function idx_private.normalize_phone(raw text)
returns text
language plpgsql
immutable
set search_path = pg_temp
as $$
declare
  d text;
begin
  if raw is null then return null; end if;
  -- remove sufixos de JID do WhatsApp; grupos e LIDs não são telefones
  if raw ~ '@g\.us$' or raw ~ '@lid$' or raw ~ '@broadcast$' then return null; end if;
  d := regexp_replace(regexp_replace(raw, '@.*$', ''), '\D', '', 'g');
  if d = '' then return null; end if;
  if d like '00%' then d := substr(d, 3); end if;
  -- número nacional brasileiro com zero de tronco (0 + DDD + número)
  if length(d) in (11, 12) and d like '0%' and d not like '00%' then d := substr(d, 2); end if;
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(d) < 10 or length(d) > 15 then return null; end if;
  return d;
end;
$$;

-- Chave de conciliação: para celulares brasileiros, ignora o 9º dígito
-- (o WhatsApp às vezes entrega números antigos sem ele). Usada SOMENTE para
-- sugerir duplicidade / vincular quando houver um único candidato.
create or replace function idx_private.phone_match_key(e164 text)
returns text
language sql
immutable
set search_path = pg_temp
as $$
  select case
    when e164 is null then null
    when e164 like '55%' and length(e164) = 13 and substr(e164, 5, 1) = '9'
      then substr(e164, 1, 4) || substr(e164, 6)
    else e164
  end;
$$;

grant execute on function idx_private.normalize_phone(text) to authenticated, service_role;
grant execute on function idx_private.phone_match_key(text) to authenticated, service_role;

create or replace function public.crm_normalize_phone(raw text)
returns text language sql immutable set search_path = pg_temp
as $$ select idx_private.normalize_phone(raw) $$;
grant execute on function public.crm_normalize_phone(text) to authenticated, service_role;

create or replace function idx_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Usuário pertence à empresa? (para validar responsáveis)
create or replace function idx_private.is_tenant_member(check_tenant_id uuid, check_user_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select check_user_id is null
    or exists (select 1 from public.tenant_users tu
               where tu.tenant_id = check_tenant_id and tu.user_id = check_user_id and tu.status = 'active')
    or exists (select 1 from public.platform_users pu
               where pu.user_id = check_user_id and pu.status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- 2. Catálogo: offers passa a ser também o catálogo de produtos e serviços.
--    (Smart Links já usam offers — evita um segundo cadastro desconectado.)
-- ---------------------------------------------------------------------------
alter table public.offers
  add column if not exists description text,
  add column if not exists kind text not null default 'product',
  add column if not exists sku text,
  add column if not exists cost numeric(12,2),
  add column if not exists is_recurring boolean not null default false,
  add column if not exists billing_interval text,
  add column if not exists commercial_terms text;

alter table public.offers drop constraint if exists offers_kind_check;
alter table public.offers add constraint offers_kind_check check (kind in ('product', 'service'));
alter table public.offers drop constraint if exists offers_billing_interval_check;
alter table public.offers add constraint offers_billing_interval_check
  check (billing_interval is null or billing_interval in ('weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'));

create unique index if not exists offers_tenant_id_id_key on public.offers(tenant_id, id);

-- ---------------------------------------------------------------------------
-- 3. Configurações e estrutura da empresa
-- ---------------------------------------------------------------------------
create table if not exists public.crm_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  currency text not null default 'BRL',
  -- 'all': vendedores veem todas as negociações; 'own': só as próprias e as sem responsável
  seller_visibility text not null default 'all' check (seller_visibility in ('all', 'own')),
  stale_deal_days int not null default 7 check (stale_deal_days between 1 and 365),
  auto_deal_from_clicks boolean not null default true,
  auto_deal_from_whatsapp boolean not null default false,
  default_pipeline_id uuid,
  icp jsonb not null default '{}'::jsonb,
  scoring jsonb not null default '{"mql_threshold": 50, "rules": []}'::jsonb,
  lifecycle_definitions jsonb not null default '{
    "lead": "Contato identificado, ainda sem qualificação.",
    "mql": "Pontuação de lead acima do limite definido pela empresa (critério automático).",
    "sal": "Vendas aceitou trabalhar o lead (decisão manual do vendedor).",
    "sql": "Vendedor confirmou necessidade, orçamento e momento de compra.",
    "opportunity": "Existe negociação aberta.",
    "customer": "Possui ao menos uma compra válida registrada.",
    "inactive": "Cliente sem compras dentro do ciclo esperado ou descartado."
  }'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'unit' check (kind in ('unit', 'branch', 'brand', 'team')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists public.crm_custom_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity text not null check (entity in ('contact', 'company', 'deal')),
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'select', 'boolean', 'money')),
  options text[] not null default '{}',
  required boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, entity, field_key)
);

-- ---------------------------------------------------------------------------
-- 4. Empresas-clientes e contatos
-- ---------------------------------------------------------------------------
create table if not exists public.crm_companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid,
  name text not null check (length(trim(name)) > 0),
  document text,
  domain text,
  segment text,
  size text,
  city text,
  state text,
  phone text,
  owner_id uuid references auth.users(id) on delete set null,
  tags text[] not null default '{}',
  notes text,
  custom jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references public.crm_units(tenant_id, id) on delete set null (unit_id)
);

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid,
  company_id uuid,
  name text,
  phone text,                       -- E.164 (dígitos), normalizado por trigger
  phone_raw text,                   -- como foi informado
  phone_match_key text,             -- conciliação (9º dígito BR)
  whatsapp text,                    -- E.164 do WhatsApp, quando diferente do telefone
  email text,
  job_title text,
  city text,
  state text,
  lifecycle_stage text not null default 'lead'
    check (lifecycle_stage in ('lead', 'mql', 'sal', 'sql', 'opportunity', 'customer', 'inactive')),
  lifecycle_source text not null default 'manual' check (lifecycle_source in ('manual', 'auto', 'import')),
  owner_id uuid references auth.users(id) on delete set null,
  tags text[] not null default '{}',
  notes text,
  custom jsonb not null default '{}'::jsonb,
  -- Aquisição (origem primária). acquisition_basis separa origem conhecida de inferida.
  source_channel text,              -- meta_ads, google_ads, whatsapp, form, landing_page, referral, outbound, import, manual, organic
  source_detail text,
  acquisition_basis text not null default 'unknown' check (acquisition_basis in ('known', 'inferred', 'declared', 'unknown')),
  acquisition_campaign text,
  acquisition_at timestamptz,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  ad_ids jsonb not null default '{}'::jsonb,   -- {fbclid, gclid, campaign_id, adset_id, ad_id}
  first_tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  inbound_outbound text check (inbound_outbound is null or inbound_outbound in ('inbound', 'outbound')),
  -- Qualificação (lead scoring é independente de RFV e de health score)
  lead_score int not null default 0,
  lead_score_details jsonb not null default '[]'::jsonb,
  qualification jsonb not null default '{}'::jsonb, -- segment, size, region, interest, budget, need, urgency
  disqualification_reason text,
  -- Privacidade / LGPD
  marketing_consent text not null default 'unknown' check (marketing_consent in ('unknown', 'granted', 'denied')),
  consent_updated_at timestamptz,
  do_not_contact boolean not null default false,
  communication_preferences jsonb not null default '{}'::jsonb,
  -- Duplicidade
  merged_into_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_interaction_at timestamptz,
  archived_at timestamptz,
  unique (tenant_id, id),
  check (name is not null or phone is not null or email is not null),
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete set null (company_id),
  foreign key (tenant_id, unit_id) references public.crm_units(tenant_id, id) on delete set null (unit_id),
  foreign key (tenant_id, merged_into_id) references public.crm_contacts(tenant_id, id) on delete set null (merged_into_id)
);

-- Um telefone por empresa (entre contatos ativos). Evita duplicar a mesma pessoa
-- quando o WhatsApp e o Smart Link chegam ao mesmo tempo.
create unique index if not exists crm_contacts_tenant_phone_key
  on public.crm_contacts(tenant_id, phone)
  where phone is not null and merged_into_id is null;
create index if not exists idx_crm_contacts_match_key on public.crm_contacts(tenant_id, phone_match_key) where phone_match_key is not null;
create index if not exists idx_crm_contacts_email on public.crm_contacts(tenant_id, lower(email)) where email is not null;
create index if not exists idx_crm_contacts_owner on public.crm_contacts(tenant_id, owner_id);
create index if not exists idx_crm_contacts_lifecycle on public.crm_contacts(tenant_id, lifecycle_stage);
create index if not exists idx_crm_contacts_source on public.crm_contacts(tenant_id, source_channel);
create index if not exists idx_crm_contacts_company on public.crm_contacts(tenant_id, company_id);
create index if not exists idx_crm_contacts_tags on public.crm_contacts using gin(tags);
create index if not exists idx_crm_contacts_name on public.crm_contacts(tenant_id, lower(name));
create index if not exists idx_crm_companies_name on public.crm_companies(tenant_id, lower(name));

create or replace function idx_private.crm_contact_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.phone is distinct from old.phone then
    if new.phone is not null and trim(new.phone) <> '' then
      new.phone_raw := coalesce(nullif(new.phone_raw, ''), new.phone);
      new.phone := idx_private.normalize_phone(new.phone);
      if new.phone is null then
        raise exception 'Telefone inválido: informe DDD e número (ex.: 11 99999-9999).' using errcode = '22023';
      end if;
    else
      new.phone := null;
    end if;
  end if;
  new.phone_match_key := idx_private.phone_match_key(new.phone);
  if new.whatsapp is not null then
    new.whatsapp := idx_private.normalize_phone(new.whatsapp);
  end if;
  if new.email is not null then
    new.email := nullif(lower(trim(new.email)), '');
    if new.email is not null and new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'E-mail inválido: %', new.email using errcode = '22023';
    end if;
  end if;
  new.name := nullif(trim(new.name), '');
  if new.merged_into_id = new.id then
    raise exception 'Um contato não pode ser mesclado nele mesmo.' using errcode = '22023';
  end if;
  if not idx_private.is_tenant_member(new.tenant_id, new.owner_id) then
    raise exception 'O responsável precisa ser usuário desta empresa.' using errcode = '42501';
  end if;
  if new.marketing_consent is distinct from coalesce(case when tg_op = 'UPDATE' then old.marketing_consent end, 'unknown') then
    new.consent_updated_at := now();
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_contacts_before_write on public.crm_contacts;
create trigger trg_crm_contacts_before_write
before insert or update on public.crm_contacts
for each row execute function idx_private.crm_contact_before_write();

create or replace function idx_private.crm_owner_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not idx_private.is_tenant_member(new.tenant_id, new.owner_id) then
    raise exception 'O responsável precisa ser usuário desta empresa.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_companies_before_write on public.crm_companies;
create trigger trg_crm_companies_before_write
before insert or update on public.crm_companies
for each row execute function idx_private.crm_owner_check();

-- ---------------------------------------------------------------------------
-- 5. Funis e etapas
-- ---------------------------------------------------------------------------
create table if not exists public.crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  position int not null default 0,
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index if not exists crm_pipelines_one_default
  on public.crm_pipelines(tenant_id) where is_default and archived_at is null;

create table if not exists public.crm_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  position int not null default 0,
  probability int not null default 10 check (probability between 0 and 100),
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  -- Correspondência com tracking_sessions.lead_status (histórico legado + CAPI por etapa)
  legacy_status text check (legacy_status is null or legacy_status in ('new', 'contacted', 'qualified', 'bad', 'sold', 'lost')),
  color text,
  entry_criteria text,
  exit_criteria text,
  rotting_days int check (rotting_days is null or rotting_days between 1 and 365),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, pipeline_id) references public.crm_pipelines(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_stages_pipeline on public.crm_stages(pipeline_id, position);
create unique index if not exists crm_stages_legacy_per_pipeline
  on public.crm_stages(pipeline_id, legacy_status) where legacy_status is not null and archived_at is null;

alter table public.crm_settings drop constraint if exists crm_settings_default_pipeline_fk;
alter table public.crm_settings
  add constraint crm_settings_default_pipeline_fk
  foreign key (tenant_id, default_pipeline_id) references public.crm_pipelines(tenant_id, id) on delete set null (default_pipeline_id);

create table if not exists public.crm_loss_reasons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- 6. Negociações
-- ---------------------------------------------------------------------------
create table if not exists public.crm_deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid,
  pipeline_id uuid not null,
  stage_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  contact_id uuid,
  company_id uuid,
  owner_id uuid references auth.users(id) on delete set null,
  value numeric(14,2) not null default 0 check (value >= 0),
  currency text not null default 'BRL',
  probability int check (probability is null or probability between 0 and 100),
  expected_close_date date,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  won_at timestamptz,
  lost_at timestamptz,
  loss_reason_id uuid,
  loss_note text,
  stage_entered_at timestamptz not null default now(),
  position double precision not null default 0,
  last_activity_at timestamptz,
  next_activity_at timestamptz,
  -- Origem (copiada da evidência; nunca inventada)
  source_channel text,
  attribution_basis text not null default 'unknown' check (attribution_basis in ('known', 'inferred', 'declared', 'unknown')),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  ad_ids jsonb not null default '{}'::jsonb,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  tags text[] not null default '{}',
  custom jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, pipeline_id) references public.crm_pipelines(tenant_id, id),
  foreign key (tenant_id, stage_id) references public.crm_stages(tenant_id, id),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete set null (company_id),
  foreign key (tenant_id, loss_reason_id) references public.crm_loss_reasons(tenant_id, id) on delete set null (loss_reason_id),
  foreign key (tenant_id, unit_id) references public.crm_units(tenant_id, id) on delete set null (unit_id)
);
-- Um lead legado (tracking_session) gera no máximo uma negociação.
create unique index if not exists crm_deals_tracking_session_key on public.crm_deals(tracking_session_id) where tracking_session_id is not null;
create index if not exists idx_crm_deals_board on public.crm_deals(tenant_id, pipeline_id, stage_id, position) where archived_at is null;
create index if not exists idx_crm_deals_contact on public.crm_deals(tenant_id, contact_id);
create index if not exists idx_crm_deals_owner on public.crm_deals(tenant_id, owner_id, status);
create index if not exists idx_crm_deals_status on public.crm_deals(tenant_id, status, updated_at desc);
create index if not exists idx_crm_deals_conversation on public.crm_deals(conversation_id) where conversation_id is not null;
create index if not exists idx_crm_deals_source on public.crm_deals(tenant_id, source_channel);

create or replace function idx_private.crm_deal_visible(check_tenant_id uuid, deal_owner uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select case
    when idx_private.crm_role(check_tenant_id) is null then false
    when idx_private.crm_role(check_tenant_id) <> 'sales' then true
    when coalesce((select seller_visibility from public.crm_settings s where s.tenant_id = check_tenant_id), 'all') = 'all' then true
    else deal_owner is null or deal_owner = (select auth.uid())
  end;
$$;
revoke all on function idx_private.crm_deal_visible(uuid, uuid) from public;
grant execute on function idx_private.crm_deal_visible(uuid, uuid) to authenticated;

create table if not exists public.crm_deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  deal_id uuid not null,
  pipeline_id uuid,
  from_stage_id uuid,
  to_stage_id uuid not null,
  from_status text,
  to_status text,
  seconds_in_previous bigint,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_stage_history_deal on public.crm_deal_stage_history(deal_id, changed_at desc);
create index if not exists idx_crm_stage_history_tenant on public.crm_deal_stage_history(tenant_id, changed_at desc);

create table if not exists public.crm_deal_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  deal_id uuid not null,
  offer_id uuid,
  name text not null,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  total numeric(14,2) generated always as (greatest(round(quantity * unit_price - discount, 2), 0)) stored,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, offer_id) references public.offers(tenant_id, id) on delete set null (offer_id)
);
create index if not exists idx_crm_deal_items_deal on public.crm_deal_items(deal_id);

create table if not exists public.crm_quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  deal_id uuid not null,
  number int not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  valid_until date,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  terms text,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 7. Tarefas / agenda e linha do tempo
-- ---------------------------------------------------------------------------
create table if not exists public.crm_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_type text not null default 'task'
    check (task_type in ('call', 'meeting', 'follow_up', 'callback', 'task', 'proposal', 'email', 'whatsapp', 'visit', 'other')),
  title text not null check (length(trim(title)) > 0),
  description text,
  owner_id uuid references auth.users(id) on delete set null,
  contact_id uuid,
  deal_id uuid,
  company_id uuid,
  due_at timestamptz,
  duration_minutes int check (duration_minutes is null or duration_minutes between 5 and 1440),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'done', 'canceled')),
  outcome text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  automation_rule_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_tasks_owner_due on public.crm_tasks(tenant_id, owner_id, status, due_at);
create index if not exists idx_crm_tasks_deal on public.crm_tasks(deal_id) where deal_id is not null;
create index if not exists idx_crm_tasks_contact on public.crm_tasks(contact_id) where contact_id is not null;
create index if not exists idx_crm_tasks_due on public.crm_tasks(tenant_id, status, due_at);

create table if not exists public.crm_timeline (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid,
  deal_id uuid,
  company_id uuid,
  kind text not null check (kind in (
    'note', 'call_log', 'meeting_log', 'whatsapp', 'email_log',
    'deal_created', 'stage_change', 'deal_won', 'deal_lost', 'deal_reopened',
    'task_done', 'order', 'payment', 'refund', 'sample', 'ai_insight', 'lifecycle',
    'rfv', 'automation', 'merge', 'import', 'system')),
  title text not null,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, company_id) references public.crm_companies(tenant_id, id) on delete cascade
);
create index if not exists idx_crm_timeline_contact on public.crm_timeline(contact_id, occurred_at desc) where contact_id is not null;
create index if not exists idx_crm_timeline_deal on public.crm_timeline(deal_id, occurred_at desc) where deal_id is not null;
create index if not exists idx_crm_timeline_tenant on public.crm_timeline(tenant_id, occurred_at desc);

create table if not exists public.crm_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  link_type text check (link_type is null or link_type in ('deal', 'contact', 'task', 'company')),
  link_id uuid,
  dedup_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_notifications_user on public.crm_notifications(user_id, tenant_id, read_at, created_at desc);
create unique index if not exists crm_notifications_dedup on public.crm_notifications(tenant_id, user_id, dedup_key) where dedup_key is not null;

create table if not exists public.crm_saved_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null check (entity in ('deals', 'contacts', 'tasks', 'companies')),
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  shared boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_saved_views on public.crm_saved_views(tenant_id, entity);

create table if not exists public.crm_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity text not null check (entity in ('contacts', 'deals')),
  file_name text,
  total_rows int not null default 0,
  created_rows int not null default 0,
  updated_rows int not null default 0,
  skipped_rows int not null default 0,
  error_rows int not null default 0,
  report jsonb not null default '[]'::jsonb,
  options jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.crm_audit_log (
  id bigserial primary key,
  tenant_id uuid not null, -- sem FK: a trilha sobrevive à exclusão do registro/empresa
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  changes jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_audit_record on public.crm_audit_log(table_name, record_id, created_at desc);
create index if not exists idx_crm_audit_tenant on public.crm_audit_log(tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. Auditoria genérica (somente campos alterados; nunca segredos)
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb;
  n jsonb;
  diff jsonb := '{}'::jsonb;
  k text;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
    insert into public.crm_audit_log(tenant_id, table_name, record_id, action, changes, actor_id)
    values (new.tenant_id, tg_table_name, new.id, 'insert', n - 'custom' - 'raw_payload', auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old);
    n := to_jsonb(new);
    for k in select jsonb_object_keys(n) loop
      if k in ('updated_at', 'position', 'last_activity_at', 'next_activity_at', 'phone_match_key', 'last_interaction_at') then continue; end if;
      if (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', n -> k));
      end if;
    end loop;
    if diff <> '{}'::jsonb then
      insert into public.crm_audit_log(tenant_id, table_name, record_id, action, changes, actor_id)
      values (new.tenant_id, tg_table_name, new.id, 'update', diff, auth.uid());
    end if;
    return new;
  else
    insert into public.crm_audit_log(tenant_id, table_name, record_id, action, changes, actor_id)
    values (old.tenant_id, tg_table_name, old.id, 'delete', to_jsonb(old) - 'custom', auth.uid());
    return old;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Regras de negociação: etapa ↔ status, histórico, próxima atividade
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_deal_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  st record;
begin
  select s.pipeline_id, s.kind, s.archived_at into st
  from public.crm_stages s where s.id = new.stage_id and s.tenant_id = new.tenant_id;
  if not found then
    raise exception 'Etapa inexistente para esta empresa.' using errcode = '23503';
  end if;
  if st.pipeline_id <> new.pipeline_id then
    -- mover de funil: a etapa manda
    new.pipeline_id := st.pipeline_id;
  end if;
  if not idx_private.is_tenant_member(new.tenant_id, new.owner_id) then
    raise exception 'O responsável precisa ser usuário desta empresa.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.stage_entered_at := now();
    new.status := st.kind;
  end if;

  if new.status = 'won' then
    new.won_at := coalesce(new.won_at, now());
    new.lost_at := null;
  elsif new.status = 'lost' then
    new.lost_at := coalesce(new.lost_at, now());
    new.won_at := null;
  else
    new.won_at := null;
    new.lost_at := null;
  end if;

  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_deals_before_write on public.crm_deals;
create trigger trg_crm_deals_before_write
before insert or update on public.crm_deals
for each row execute function idx_private.crm_deal_before_write();

create or replace function idx_private.crm_deal_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  from_name text;
  to_name text;
begin
  if tg_op = 'INSERT' then
    insert into public.crm_deal_stage_history(tenant_id, deal_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, changed_by, changed_at)
    values (new.tenant_id, new.id, new.pipeline_id, null, new.stage_id, null, new.status, auth.uid(), new.created_at);
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, company_id, kind, title, metadata, actor_id, occurred_at)
    values (new.tenant_id, new.contact_id, new.id, new.company_id, 'deal_created',
            'Negociação criada: ' || new.title,
            jsonb_build_object('value', new.value, 'source_channel', new.source_channel), auth.uid(), new.created_at);
    if new.contact_id is not null then
      update public.crm_contacts set lifecycle_stage = 'opportunity', lifecycle_source = 'auto'
      where id = new.contact_id and lifecycle_stage in ('lead', 'mql', 'sal', 'sql');
    end if;
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    select name into from_name from public.crm_stages where id = old.stage_id;
    select name into to_name from public.crm_stages where id = new.stage_id;
    insert into public.crm_deal_stage_history(tenant_id, deal_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, seconds_in_previous, changed_by)
    values (new.tenant_id, new.id, new.pipeline_id, old.stage_id, new.stage_id, old.status, new.status,
            extract(epoch from (now() - old.stage_entered_at))::bigint, auth.uid());
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, company_id, kind, title, metadata, actor_id)
    values (new.tenant_id, new.contact_id, new.id, new.company_id,
            case when new.status = 'won' and old.status <> 'won' then 'deal_won'
                 when new.status = 'lost' and old.status <> 'lost' then 'deal_lost'
                 when new.status = 'open' and old.status <> 'open' then 'deal_reopened'
                 else 'stage_change' end,
            coalesce(from_name, '?') || ' → ' || coalesce(to_name, '?'),
            jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id, 'deal_title', new.title), auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_deals_after_write on public.crm_deals;
create trigger trg_crm_deals_after_write
after insert or update on public.crm_deals
for each row execute function idx_private.crm_deal_after_write();

-- Recalcula próxima atividade / última atividade da negociação e do contato
create or replace function idx_private.crm_refresh_deal_activity(p_deal_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.crm_deals d
     set next_activity_at = (select min(t.due_at) from public.crm_tasks t where t.deal_id = d.id and t.status = 'open'),
         last_activity_at = greatest(
           d.last_activity_at,
           (select max(t.completed_at) from public.crm_tasks t where t.deal_id = d.id and t.status = 'done'),
           (select max(tl.occurred_at) from public.crm_timeline tl where tl.deal_id = d.id and tl.kind in ('note', 'call_log', 'meeting_log', 'whatsapp', 'email_log')))
   where d.id = p_deal_id;
$$;

create or replace function idx_private.crm_task_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not idx_private.is_tenant_member(new.tenant_id, new.owner_id) then
    raise exception 'O responsável precisa ser usuário desta empresa.' using errcode = '42501';
  end if;
  -- herda contato/empresa da negociação para aparecer no histórico certo
  if new.deal_id is not null and (new.contact_id is null or new.company_id is null) then
    select coalesce(new.contact_id, d.contact_id), coalesce(new.company_id, d.company_id)
      into new.contact_id, new.company_id
    from public.crm_deals d where d.id = new.deal_id and d.tenant_id = new.tenant_id;
  end if;
  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, now());
    new.completed_by := coalesce(new.completed_by, auth.uid());
  elsif new.status = 'open' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_tasks_before_write on public.crm_tasks;
create trigger trg_crm_tasks_before_write
before insert or update on public.crm_tasks
for each row execute function idx_private.crm_task_before_write();

create or replace function idx_private.crm_task_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.deal_id is not null then perform idx_private.crm_refresh_deal_activity(old.deal_id); end if;
    return old;
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    insert into public.crm_timeline(tenant_id, contact_id, deal_id, company_id, kind, title, body, metadata, actor_id)
    values (new.tenant_id, new.contact_id, new.deal_id, new.company_id, 'task_done',
            'Concluída: ' || new.title, new.outcome,
            jsonb_build_object('task_id', new.id, 'task_type', new.task_type), auth.uid());
    if new.contact_id is not null then
      update public.crm_contacts set last_interaction_at = greatest(coalesce(last_interaction_at, new.completed_at), new.completed_at)
      where id = new.contact_id;
    end if;
  end if;
  if new.deal_id is not null then perform idx_private.crm_refresh_deal_activity(new.deal_id); end if;
  if tg_op = 'UPDATE' and old.deal_id is not null and old.deal_id is distinct from new.deal_id then
    perform idx_private.crm_refresh_deal_activity(old.deal_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_tasks_after_write on public.crm_tasks;
create trigger trg_crm_tasks_after_write
after insert or update or delete on public.crm_tasks
for each row execute function idx_private.crm_task_after_write();

create or replace function idx_private.crm_timeline_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind in ('note', 'call_log', 'meeting_log', 'whatsapp', 'email_log') then
    if new.deal_id is not null then
      update public.crm_deals set last_activity_at = greatest(coalesce(last_activity_at, new.occurred_at), new.occurred_at)
      where id = new.deal_id;
    end if;
    if new.contact_id is not null then
      update public.crm_contacts set last_interaction_at = greatest(coalesce(last_interaction_at, new.occurred_at), new.occurred_at)
      where id = new.contact_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_timeline_after_insert on public.crm_timeline;
create trigger trg_crm_timeline_after_insert
after insert on public.crm_timeline
for each row execute function idx_private.crm_timeline_after_insert();

-- Auditoria nas entidades principais
do $$
declare t text;
begin
  foreach t in array array['crm_contacts', 'crm_companies', 'crm_deals', 'crm_tasks', 'crm_pipelines', 'crm_stages'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_%s_audit on public.%I', t, t);
      execute format('create trigger trg_%s_audit after insert or update or delete on public.%I for each row execute function idx_private.crm_audit()', t, t);
    end if;
  end loop;
end $$;

drop trigger if exists trg_crm_pipelines_touch on public.crm_pipelines;
create trigger trg_crm_pipelines_touch before update on public.crm_pipelines
for each row execute function idx_private.touch_updated_at();
drop trigger if exists trg_crm_quotes_touch on public.crm_quotes;
create trigger trg_crm_quotes_touch before update on public.crm_quotes
for each row execute function idx_private.touch_updated_at();
drop trigger if exists trg_crm_settings_touch on public.crm_settings;
create trigger trg_crm_settings_touch before update on public.crm_settings
for each row execute function idx_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Funil padrão por empresa (mapeia as classificações legadas)
-- ---------------------------------------------------------------------------
create or replace function idx_private.crm_ensure_defaults(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline uuid;
begin
  insert into public.crm_settings(tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;

  select id into v_pipeline from public.crm_pipelines
  where tenant_id = p_tenant_id and is_default and archived_at is null limit 1;

  if v_pipeline is null then
    select id into v_pipeline from public.crm_pipelines
    where tenant_id = p_tenant_id and archived_at is null order by position, created_at limit 1;
  end if;

  if v_pipeline is null then
    insert into public.crm_pipelines(tenant_id, name, description, position, is_default)
    values (p_tenant_id, 'Funil comercial', 'Funil padrão. Etapas mapeadas a partir das classificações do IDX.', 0, true)
    returning id into v_pipeline;

    insert into public.crm_stages(tenant_id, pipeline_id, name, position, probability, kind, legacy_status, color, entry_criteria, exit_criteria, rotting_days) values
      (p_tenant_id, v_pipeline, 'Novo lead',          0, 10,  'open', 'new',       '#64748b', 'Contato chegou (Smart Link, WhatsApp, formulário ou cadastro).', 'Primeiro contato feito pelo vendedor.', 1),
      (p_tenant_id, v_pipeline, 'Contato realizado',  1, 20,  'open', 'contacted', '#0ea5e9', 'Vendedor falou com o lead.', 'Necessidade e interesse confirmados.', 3),
      (p_tenant_id, v_pipeline, 'Qualificação',       2, 40,  'open', 'qualified', '#8b5cf6', 'Interesse real e perfil compatível (bom lead / remarketing).', 'Proposta ou orçamento enviado.', 5),
      (p_tenant_id, v_pipeline, 'Proposta enviada',   3, 60,  'open', null,        '#f59e0b', 'Proposta/orçamento enviado ao cliente.', 'Cliente respondeu e iniciou negociação.', 5),
      (p_tenant_id, v_pipeline, 'Negociação',         4, 80,  'open', null,        '#f97316', 'Ajustes de preço, prazo ou condições.', 'Venda confirmada com evidência ou perda.', 7),
      (p_tenant_id, v_pipeline, 'Venda ganha',        5, 100, 'won',  'sold',      '#16a34a', 'Venda confirmada com evidência (pagamento, contrato ou pedido).', null, null),
      (p_tenant_id, v_pipeline, 'Venda perdida',      6, 0,   'lost', 'lost',      '#dc2626', 'Cliente desistiu ou escolheu outra opção.', null, null),
      (p_tenant_id, v_pipeline, 'Lead ruim',          7, 0,   'lost', 'bad',       '#71717a', 'Fora do perfil, contato inválido ou sem interesse.', null, null);

    insert into public.crm_loss_reasons(tenant_id, name, position) values
      (p_tenant_id, 'Preço', 0), (p_tenant_id, 'Sem resposta', 1), (p_tenant_id, 'Comprou com concorrente', 2),
      (p_tenant_id, 'Sem orçamento', 3), (p_tenant_id, 'Fora do perfil', 4), (p_tenant_id, 'Prazo / momento', 5),
      (p_tenant_id, 'Lead ruim (classificação legada)', 6), (p_tenant_id, 'Outro', 7)
    on conflict (tenant_id, name) do nothing;
  end if;

  update public.crm_settings set default_pipeline_id = v_pipeline
  where tenant_id = p_tenant_id and default_pipeline_id is null;

  return v_pipeline;
end;
$$;

-- Chamado pelo painel na primeira abertura do CRM de uma empresa.
create or replace function public.crm_setup_tenant(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  return idx_private.crm_ensure_defaults(p_tenant_id);
end;
$$;
revoke all on function public.crm_setup_tenant(uuid) from public;
grant execute on function public.crm_setup_tenant(uuid) to authenticated;

-- Novas empresas já nascem com o funil padrão.
create or replace function idx_private.crm_tenant_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform idx_private.crm_ensure_defaults(new.id);
  return new;
end;
$$;
drop trigger if exists trg_tenants_crm_defaults on public.tenants;
create trigger trg_tenants_crm_defaults after insert on public.tenants
for each row execute function idx_private.crm_tenant_after_insert();

-- Reordenação de etapas em uma única transação
create or replace function public.crm_reorder_stages(p_pipeline_id uuid, p_stage_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  i int;
begin
  for i in 1 .. coalesce(array_length(p_stage_ids, 1), 0) loop
    update public.crm_stages set position = i - 1
    where id = p_stage_ids[i] and pipeline_id = p_pipeline_id;
  end loop;
end;
$$;
grant execute on function public.crm_reorder_stages(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Duplicidades e mesclagem segura (sempre manual)
-- ---------------------------------------------------------------------------
create or replace function public.crm_find_duplicates(p_tenant_id uuid, p_phone text default null, p_email text default null, p_exclude uuid default null)
returns table (id uuid, name text, phone text, email text, match_reason text)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  with k as (
    select idx_private.normalize_phone(p_phone) as phone,
           idx_private.phone_match_key(idx_private.normalize_phone(p_phone)) as mkey,
           nullif(lower(trim(p_email)), '') as email
  )
  select c.id, c.name, c.phone, c.email,
         case when c.phone = k.phone then 'telefone idêntico'
              when c.phone_match_key = k.mkey then 'telefone equivalente (9º dígito)'
              else 'mesmo e-mail' end
  from public.crm_contacts c, k
  where c.tenant_id = p_tenant_id
    and c.merged_into_id is null
    and (p_exclude is null or c.id <> p_exclude)
    and ((k.phone is not null and (c.phone = k.phone or c.phone_match_key = k.mkey))
      or (k.email is not null and c.email = k.email))
  limit 20;
$$;
grant execute on function public.crm_find_duplicates(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. RLS
-- ---------------------------------------------------------------------------
alter table public.crm_settings enable row level security;
alter table public.crm_units enable row level security;
alter table public.crm_custom_fields enable row level security;
alter table public.crm_companies enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_pipelines enable row level security;
alter table public.crm_stages enable row level security;
alter table public.crm_loss_reasons enable row level security;
alter table public.crm_deals enable row level security;
alter table public.crm_deal_stage_history enable row level security;
alter table public.crm_deal_items enable row level security;
alter table public.crm_quotes enable row level security;
alter table public.crm_tasks enable row level security;
alter table public.crm_timeline enable row level security;
alter table public.crm_notifications enable row level security;
alter table public.crm_saved_views enable row level security;
alter table public.crm_imports enable row level security;
alter table public.crm_audit_log enable row level security;

-- Configuração: leitura para membros, escrita para admin/gestor
do $$
declare t text;
begin
  foreach t in array array['crm_settings', 'crm_units', 'crm_custom_fields', 'crm_pipelines', 'crm_stages', 'crm_loss_reasons'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for select to authenticated using (idx_private.crm_can(tenant_id, ''read''))', t || '_select', t);
    execute format('create policy %I on public.%I for all to authenticated using (idx_private.crm_can(tenant_id, ''configure'')) with check (idx_private.crm_can(tenant_id, ''configure''))', t || '_write', t);
  end loop;
end $$;

-- Registros comerciais compartilhados (contatos, empresas)
do $$
declare t text;
begin
  foreach t in array array['crm_contacts', 'crm_companies'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (idx_private.crm_can(tenant_id, ''read''))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (idx_private.crm_can(tenant_id, ''write''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (idx_private.crm_can(tenant_id, ''write'')) with check (idx_private.crm_can(tenant_id, ''write''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (idx_private.crm_can(tenant_id, ''delete''))', t || '_delete', t);
  end loop;
end $$;

-- Negociações: respeitam a visibilidade por responsável
drop policy if exists crm_deals_select on public.crm_deals;
drop policy if exists crm_deals_insert on public.crm_deals;
drop policy if exists crm_deals_update on public.crm_deals;
drop policy if exists crm_deals_delete on public.crm_deals;
create policy crm_deals_select on public.crm_deals for select to authenticated
  using (idx_private.crm_deal_visible(tenant_id, owner_id));
create policy crm_deals_insert on public.crm_deals for insert to authenticated
  with check (idx_private.crm_can(tenant_id, 'write') and idx_private.crm_deal_visible(tenant_id, owner_id));
create policy crm_deals_update on public.crm_deals for update to authenticated
  using (idx_private.crm_can(tenant_id, 'write') and idx_private.crm_deal_visible(tenant_id, owner_id))
  with check (idx_private.crm_can(tenant_id, 'write') and idx_private.crm_deal_visible(tenant_id, owner_id));
create policy crm_deals_delete on public.crm_deals for delete to authenticated
  using (idx_private.crm_can(tenant_id, 'delete'));

-- Dados filhos de negociações
drop policy if exists crm_deal_stage_history_select on public.crm_deal_stage_history;
create policy crm_deal_stage_history_select on public.crm_deal_stage_history for select to authenticated
  using (exists (select 1 from public.crm_deals d where d.id = deal_id));

drop policy if exists crm_deal_items_select on public.crm_deal_items;
drop policy if exists crm_deal_items_write on public.crm_deal_items;
create policy crm_deal_items_select on public.crm_deal_items for select to authenticated
  using (exists (select 1 from public.crm_deals d where d.id = deal_id));
create policy crm_deal_items_write on public.crm_deal_items for all to authenticated
  using (idx_private.crm_can(tenant_id, 'write') and exists (select 1 from public.crm_deals d where d.id = deal_id))
  with check (idx_private.crm_can(tenant_id, 'write') and exists (select 1 from public.crm_deals d where d.id = deal_id));

drop policy if exists crm_quotes_select on public.crm_quotes;
drop policy if exists crm_quotes_write on public.crm_quotes;
create policy crm_quotes_select on public.crm_quotes for select to authenticated
  using (exists (select 1 from public.crm_deals d where d.id = deal_id));
create policy crm_quotes_write on public.crm_quotes for all to authenticated
  using (idx_private.crm_can(tenant_id, 'write') and exists (select 1 from public.crm_deals d where d.id = deal_id))
  with check (idx_private.crm_can(tenant_id, 'write') and exists (select 1 from public.crm_deals d where d.id = deal_id));

-- Tarefas: visíveis se a negociação for visível (ou se for do próprio usuário)
drop policy if exists crm_tasks_select on public.crm_tasks;
drop policy if exists crm_tasks_insert on public.crm_tasks;
drop policy if exists crm_tasks_update on public.crm_tasks;
drop policy if exists crm_tasks_delete on public.crm_tasks;
create policy crm_tasks_select on public.crm_tasks for select to authenticated
  using (idx_private.crm_can(tenant_id, 'read') and (
    owner_id = (select auth.uid()) or deal_id is null
    or exists (select 1 from public.crm_deals d where d.id = deal_id)));
create policy crm_tasks_insert on public.crm_tasks for insert to authenticated
  with check (idx_private.crm_can(tenant_id, 'write'));
create policy crm_tasks_update on public.crm_tasks for update to authenticated
  using (idx_private.crm_can(tenant_id, 'write') and (
    owner_id = (select auth.uid()) or deal_id is null
    or exists (select 1 from public.crm_deals d where d.id = deal_id)))
  with check (idx_private.crm_can(tenant_id, 'write'));
create policy crm_tasks_delete on public.crm_tasks for delete to authenticated
  using (idx_private.crm_can(tenant_id, 'delete') or (idx_private.crm_can(tenant_id, 'write') and created_by = (select auth.uid())));

-- Linha do tempo: inserção manual só de anotações/registros; eventos de sistema vêm de triggers
drop policy if exists crm_timeline_select on public.crm_timeline;
drop policy if exists crm_timeline_insert on public.crm_timeline;
drop policy if exists crm_timeline_delete on public.crm_timeline;
create policy crm_timeline_select on public.crm_timeline for select to authenticated
  using (idx_private.crm_can(tenant_id, 'read') and (deal_id is null or exists (select 1 from public.crm_deals d where d.id = deal_id)));
create policy crm_timeline_insert on public.crm_timeline for insert to authenticated
  with check (idx_private.crm_can(tenant_id, 'write')
    and kind in ('note', 'call_log', 'meeting_log', 'email_log', 'sample')
    and actor_id = (select auth.uid()));
create policy crm_timeline_delete on public.crm_timeline for delete to authenticated
  using (idx_private.crm_can(tenant_id, 'delete') and kind in ('note', 'call_log', 'meeting_log', 'email_log'));

drop policy if exists crm_notifications_own on public.crm_notifications;
create policy crm_notifications_own on public.crm_notifications for select to authenticated
  using (user_id = (select auth.uid()) and idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_notifications_update_own on public.crm_notifications;
create policy crm_notifications_update_own on public.crm_notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists crm_saved_views_select on public.crm_saved_views;
drop policy if exists crm_saved_views_write on public.crm_saved_views;
create policy crm_saved_views_select on public.crm_saved_views for select to authenticated
  using (idx_private.crm_can(tenant_id, 'read') and (user_id = (select auth.uid()) or shared));
create policy crm_saved_views_write on public.crm_saved_views for all to authenticated
  using (user_id = (select auth.uid()) and idx_private.crm_can(tenant_id, 'read'))
  with check (user_id = (select auth.uid()) and idx_private.crm_can(tenant_id, 'read'));

drop policy if exists crm_imports_select on public.crm_imports;
create policy crm_imports_select on public.crm_imports for select to authenticated
  using (idx_private.crm_can(tenant_id, 'write'));

drop policy if exists crm_audit_log_select on public.crm_audit_log;
create policy crm_audit_log_select on public.crm_audit_log for select to authenticated
  using (idx_private.crm_can(tenant_id, 'audit'));

-- Grants
grant select, insert, update, delete on
  public.crm_settings, public.crm_units, public.crm_custom_fields, public.crm_companies, public.crm_contacts,
  public.crm_pipelines, public.crm_stages, public.crm_loss_reasons, public.crm_deals, public.crm_deal_items,
  public.crm_quotes, public.crm_tasks, public.crm_saved_views
to authenticated;
grant select, insert, delete on public.crm_timeline to authenticated;
grant select on public.crm_deal_stage_history, public.crm_imports, public.crm_audit_log to authenticated;
grant select, update on public.crm_notifications to authenticated;
-- tabelas internas nunca ficam expostas ao anon
revoke all on
  public.crm_settings, public.crm_units, public.crm_custom_fields, public.crm_companies, public.crm_contacts,
  public.crm_pipelines, public.crm_stages, public.crm_loss_reasons, public.crm_deals, public.crm_deal_items,
  public.crm_quotes, public.crm_tasks, public.crm_saved_views, public.crm_timeline, public.crm_deal_stage_history,
  public.crm_imports, public.crm_audit_log, public.crm_notifications
from anon;
grant all on
  public.crm_settings, public.crm_units, public.crm_custom_fields, public.crm_companies, public.crm_contacts,
  public.crm_pipelines, public.crm_stages, public.crm_loss_reasons, public.crm_deals, public.crm_deal_items,
  public.crm_quotes, public.crm_tasks, public.crm_saved_views, public.crm_timeline, public.crm_deal_stage_history,
  public.crm_imports, public.crm_audit_log, public.crm_notifications
to service_role;
grant usage, select on sequence public.crm_audit_log_id_seq to service_role;

-- Funil padrão para as empresas já existentes
do $$
declare r record;
begin
  for r in select id from public.tenants loop
    perform idx_private.crm_ensure_defaults(r.id);
  end loop;
end $$;
