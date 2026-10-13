-- ============================================================
-- Fase 1: Fundacao WhatsApp
-- Tabelas para instancias, contatos, conversas, mensagens,
-- webhook events e chaves de API para n8n.
-- Migration ADITIVA: nao altera tabelas existentes.
-- ============================================================

-- ------------------------------------
-- whatsapp_instances
-- ------------------------------------
create table public.whatsapp_instances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_name text not null,
  phone_number text,
  provider text not null default 'evolution' check (provider in ('evolution', 'cloud_api')),
  status text not null default 'disconnected' check (status in ('disconnected', 'connecting', 'connected', 'banned')),
  api_url text,
  api_key_hash text,
  qr_code_data text,
  last_seen_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, instance_name)
);

create index idx_wa_instances_tenant on public.whatsapp_instances(tenant_id, status);

-- ------------------------------------
-- whatsapp_contacts
-- ------------------------------------
create table public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid not null references public.whatsapp_instances(id) on delete cascade,
  wa_id text not null,
  phone text,
  push_name text,
  profile_pic_url text,
  is_business boolean not null default false,
  tags text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, wa_id)
);

create index idx_wa_contacts_tenant on public.whatsapp_contacts(tenant_id);
create index idx_wa_contacts_phone on public.whatsapp_contacts(tenant_id, phone) where phone is not null;

-- ------------------------------------
-- whatsapp_conversations
-- ------------------------------------
create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  instance_id uuid not null references public.whatsapp_instances(id) on delete cascade,
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived', 'spam')),
  last_message_at timestamptz,
  unread_count int not null default 0,
  ai_summary text,
  ai_intent text,
  ai_sentiment text check (ai_sentiment is null or ai_sentiment in ('positive', 'neutral', 'negative')),
  ai_purchase_probability numeric(3,2) check (ai_purchase_probability is null or (ai_purchase_probability >= 0 and ai_purchase_probability <= 1)),
  ai_analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, instance_id, contact_id)
);

create index idx_wa_conversations_tenant on public.whatsapp_conversations(tenant_id, last_message_at desc);
create index idx_wa_conversations_tracking on public.whatsapp_conversations(tracking_session_id) where tracking_session_id is not null;

-- ------------------------------------
-- whatsapp_messages
-- ------------------------------------
create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  wa_message_id text,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender_phone text,
  content_type text not null default 'text' check (content_type in ('text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'sticker', 'reaction', 'unknown')),
  body text,
  media_url text,
  media_mime text,
  quoted_message_id text,
  "timestamp" timestamptz not null default now(),
  status text not null default 'sent' check (status in ('sent', 'delivered', 'read', 'failed', 'pending')),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);

create index idx_wa_messages_conversation on public.whatsapp_messages(conversation_id, "timestamp" desc);
create index idx_wa_messages_tenant_ts on public.whatsapp_messages(tenant_id, "timestamp" desc);

-- ------------------------------------
-- webhook_events (audit + reprocessamento)
-- ------------------------------------
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source text not null default 'n8n' check (source in ('n8n', 'evolution', 'cloud_api', 'manual')),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'retrying')),
  error_message text,
  attempts int not null default 1,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_webhook_events_tenant on public.webhook_events(tenant_id, created_at desc);
create index idx_webhook_events_status on public.webhook_events(status, created_at) where status in ('failed', 'retrying');

-- ------------------------------------
-- tenant_webhook_keys
-- ------------------------------------
create table public.tenant_webhook_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key_hash text not null,
  label text not null default 'default',
  last_used_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now()
);

create index idx_webhook_keys_tenant on public.tenant_webhook_keys(tenant_id, status);

-- ============================================================
-- RLS policies
-- ============================================================

alter table public.whatsapp_instances enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.webhook_events enable row level security;
alter table public.tenant_webhook_keys enable row level security;

-- whatsapp_instances: leitura para membros, escrita para admin+
create policy wa_instances_select_member
on public.whatsapp_instances for select to authenticated
using (idx_private.has_tenant_role(tenant_id));

create policy wa_instances_write_admin
on public.whatsapp_instances for all to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

-- whatsapp_contacts: leitura para membros
create policy wa_contacts_select_member
on public.whatsapp_contacts for select to authenticated
using (idx_private.has_tenant_role(tenant_id));

-- whatsapp_conversations: leitura para membros
create policy wa_conversations_select_member
on public.whatsapp_conversations for select to authenticated
using (idx_private.has_tenant_role(tenant_id));

-- whatsapp_messages: leitura para membros
create policy wa_messages_select_member
on public.whatsapp_messages for select to authenticated
using (idx_private.has_tenant_role(tenant_id));

-- webhook_events: somente service_role
create policy webhook_events_service_only
on public.webhook_events for all to service_role
using (true) with check (true);

-- tenant_webhook_keys: leitura admin+, escrita admin+
create policy webhook_keys_select_admin
on public.tenant_webhook_keys for select to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

create policy webhook_keys_write_admin
on public.tenant_webhook_keys for all to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

-- service_role full access on new tables for edge functions
create policy wa_contacts_service
on public.whatsapp_contacts for all to service_role
using (true) with check (true);

create policy wa_conversations_service
on public.whatsapp_conversations for all to service_role
using (true) with check (true);

create policy wa_messages_service
on public.whatsapp_messages for all to service_role
using (true) with check (true);

create policy wa_instances_service
on public.whatsapp_instances for all to service_role
using (true) with check (true);

-- ============================================================
-- Grants
-- ============================================================

grant select on public.whatsapp_instances to authenticated;
grant select on public.whatsapp_contacts to authenticated;
grant select on public.whatsapp_conversations to authenticated;
grant select on public.whatsapp_messages to authenticated;
grant select on public.tenant_webhook_keys to authenticated;

grant select, insert, update, delete on public.whatsapp_instances to service_role;
grant select, insert, update, delete on public.whatsapp_contacts to service_role;
grant select, insert, update, delete on public.whatsapp_conversations to service_role;
grant select, insert, update, delete on public.whatsapp_messages to service_role;
grant select, insert, update, delete on public.webhook_events to service_role;
grant select, insert, update, delete on public.tenant_webhook_keys to service_role;

-- Revoke anon access
revoke all on public.whatsapp_instances from anon;
revoke all on public.whatsapp_contacts from anon;
revoke all on public.whatsapp_conversations from anon;
revoke all on public.whatsapp_messages from anon;
revoke all on public.webhook_events from anon;
revoke all on public.tenant_webhook_keys from anon;
