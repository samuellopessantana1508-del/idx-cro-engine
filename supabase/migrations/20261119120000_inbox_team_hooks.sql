-- =============================================================================
-- Atendimento multiusuário + respostas rápidas + gatilho por webhook (integrações).
-- =============================================================================

-- 1. Conversa com responsável e "concluída" --------------------------------------
alter table public.whatsapp_conversations add column if not exists assigned_to uuid references auth.users(id) on delete set null;
alter table public.whatsapp_conversations add column if not exists assigned_at timestamptz;
create index if not exists idx_wa_conversations_assigned on public.whatsapp_conversations(tenant_id, assigned_to);

create or replace function public.wa_conversation_assign(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.whatsapp_conversations; v_name text;
begin
  select * into c from public.whatsapp_conversations where id = p_conversation_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Conversa não encontrada'; end if;
  if p_user_id is not null and not exists (select 1 from public.tenant_users where tenant_id = c.tenant_id and user_id = p_user_id and status = 'active') then
    raise exception 'Esta pessoa não faz parte da empresa';
  end if;
  update public.whatsapp_conversations
     set assigned_to = p_user_id, assigned_at = case when p_user_id is null then null else now() end, updated_at = now()
   where id = c.id;
  if p_user_id is not null and p_user_id is distinct from auth.uid() then
    select coalesce(wc.push_name, wc.phone) into v_name from public.whatsapp_contacts wc where wc.id = c.contact_id;
    insert into public.crm_notifications (tenant_id, user_id, title, body, severity)
    values (c.tenant_id, p_user_id, 'Conversa transferida para você: ' || coalesce(v_name, 'WhatsApp'), 'Abra o WhatsApp do CRO para responder', 'info');
  end if;
end $$;
grant execute on function public.wa_conversation_assign(uuid, uuid) to authenticated;

create or replace function public.wa_conversation_close(p_conversation_id uuid, p_closed boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.whatsapp_conversations;
begin
  select * into c from public.whatsapp_conversations where id = p_conversation_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Conversa não encontrada'; end if;
  update public.whatsapp_conversations
     set status = case when p_closed then 'archived' else 'active' end, unread_count = case when p_closed then 0 else unread_count end, updated_at = now()
   where id = c.id and status <> 'spam';
end $$;
grant execute on function public.wa_conversation_close(uuid, boolean) to authenticated;

-- cliente mandou mensagem numa conversa concluída: ela volta para "abertas"
create or replace function idx_private.wa_conversation_reopen()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.direction = 'inbound' then
    update public.whatsapp_conversations set status = 'active' where id = new.conversation_id and status = 'archived';
  end if;
  return null;
exception when others then
  raise warning 'wa_conversation_reopen: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_wa_conversation_reopen on public.whatsapp_messages;
create trigger trg_wa_conversation_reopen after insert on public.whatsapp_messages
for each row execute function idx_private.wa_conversation_reopen();

-- 2. Respostas rápidas --------------------------------------------------------------
create table if not exists public.wa_quick_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 60),
  body text not null check (length(trim(body)) between 1 and 4000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_wa_quick_replies on public.wa_quick_replies(tenant_id, title);
alter table public.wa_quick_replies enable row level security;
drop policy if exists wa_quick_replies_read on public.wa_quick_replies;
create policy wa_quick_replies_read on public.wa_quick_replies for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

create or replace function public.wa_quick_reply_save(p_tenant_id uuid, p_id uuid, p_title text, p_body text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid := p_id;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if v_id is null then
    insert into public.wa_quick_replies (tenant_id, title, body, created_by) values (p_tenant_id, trim(p_title), trim(p_body), auth.uid()) returning id into v_id;
  else
    update public.wa_quick_replies set title = trim(p_title), body = trim(p_body), updated_at = now() where id = v_id and tenant_id = p_tenant_id;
    if not found then raise exception 'Resposta não encontrada'; end if;
  end if;
  return v_id;
end $$;
create or replace function public.wa_quick_reply_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.wa_quick_replies where id = p_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Resposta não encontrada'; end if;
  delete from public.wa_quick_replies where id = p_id;
end $$;
grant execute on function public.wa_quick_reply_save(uuid, uuid, text, text) to authenticated;
grant execute on function public.wa_quick_reply_delete(uuid) to authenticated;

-- 3. Gatilho por webhook (outro sistema inicia a automação) ---------------------------
-- o segredo fica numa tabela sem acesso pela API (só funções)
create table if not exists public.wa_flow_hooks (
  flow_id uuid primary key references public.wa_flows(id) on delete cascade,
  secret text not null,
  created_at timestamptz not null default now()
);
alter table public.wa_flow_hooks enable row level security;
alter table public.wa_flow_queue drop constraint if exists wa_flow_queue_kind_check;
alter table public.wa_flow_queue add constraint wa_flow_queue_kind_check check (kind in ('message', 'tag', 'stage', 'manual', 'webhook'));

create or replace function idx_private.wa_new_secret()
returns text language sql volatile as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

-- endereço secreto do webhook (cria na primeira vez; p_rotate troca e invalida o antigo)
create or replace function public.wa_flow_hook_secret(p_flow_id uuid, p_rotate boolean default false)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare f public.wa_flows; v_secret text;
begin
  select * into f from public.wa_flows where id = p_flow_id;
  if f.id is null or not idx_private.crm_can(f.tenant_id, 'configure') then raise exception 'Automação não encontrada'; end if;
  select secret into v_secret from public.wa_flow_hooks where flow_id = f.id;
  if v_secret is null or p_rotate then
    v_secret := idx_private.wa_new_secret();
    insert into public.wa_flow_hooks (flow_id, secret) values (f.id, v_secret)
    on conflict (flow_id) do update set secret = excluded.secret, created_at = now();
  end if;
  return v_secret;
end $$;
grant execute on function public.wa_flow_hook_secret(uuid, boolean) to authenticated;

-- chamada externa: valida o segredo, aplica limite e entra na fila do motor
create or replace function public.wa_flow_hook_enqueue(p_flow_id uuid, p_secret text, p_phone text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare f public.wa_flows; v_phone text := idx_private.normalize_phone(p_phone); v_today int; v_secret text;
begin
  select * into f from public.wa_flows where id = p_flow_id;
  select secret into v_secret from public.wa_flow_hooks where flow_id = p_flow_id;
  if f.id is null or v_secret is null or p_secret is null or v_secret <> p_secret then
    return jsonb_build_object('ok', false, 'status', 404, 'error', 'Endereço inválido');
  end if;
  if f.status <> 'active' or f.trigger_kind is distinct from 'webhook' then
    return jsonb_build_object('ok', false, 'status', 409, 'error', 'Automação não está ativa com gatilho de webhook');
  end if;
  if v_phone is null then return jsonb_build_object('ok', false, 'status', 400, 'error', 'Informe "telefone" (ou "phone") válido'); end if;
  select count(*) into v_today from public.wa_flow_queue where flow_id = f.id and kind = 'webhook' and created_at > now() - interval '1 day';
  if v_today >= 2000 then return jsonb_build_object('ok', false, 'status', 429, 'error', 'Limite de 2000 chamadas por dia'); end if;
  if exists (select 1 from public.wa_optouts where tenant_id = f.tenant_id and phone = v_phone) then
    return jsonb_build_object('ok', true, 'queued', false, 'reason', 'Contato pediu SAIR');
  end if;
  insert into public.wa_flow_queue (tenant_id, kind, phone, flow_id, payload)
  values (f.tenant_id, 'webhook', v_phone, f.id, coalesce(p_payload, '{}'::jsonb));
  return jsonb_build_object('ok', true, 'queued', true);
end $$;
revoke all on function public.wa_flow_hook_enqueue(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.wa_flow_hook_enqueue(uuid, text, text, jsonb) to service_role;
