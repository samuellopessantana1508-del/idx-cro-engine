-- WhatsApp em tempo real no painel.
--
-- O painel já assina postgres_changes, mas as tabelas não estavam na publicação
-- supabase_realtime: nenhum evento chegava e era preciso dar F5.
-- O Realtime respeita o RLS existente (select só para membros da empresa), então
-- cada empresa recebe apenas os próprios eventos.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['whatsapp_messages', 'whatsapp_conversations', 'whatsapp_contacts', 'conversation_insights', 'sale_signals'] loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Marcar conversa como lida. O painel só tem SELECT em whatsapp_conversations,
-- então o UPDATE direto falhava em silêncio e o contador nunca zerava.
create or replace function public.mark_whatsapp_conversation_read(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.whatsapp_conversations
     set unread_count = 0
   where id = p_conversation_id
     and unread_count <> 0
     and idx_private.has_tenant_role(tenant_id);
$$;

revoke all on function public.mark_whatsapp_conversation_read(uuid) from public;
grant execute on function public.mark_whatsapp_conversation_read(uuid) to authenticated;
