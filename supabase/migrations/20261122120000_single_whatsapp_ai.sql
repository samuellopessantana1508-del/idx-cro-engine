-- =============================================================================
-- Conexão única do WhatsApp: a leitura das conversas pela IA (que detecta vendas)
-- também roda para as mensagens que chegam pela conexão do próprio CRO (QR Code).
-- Antes, só o fluxo antigo (Evolution API + n8n) chamava a análise.
-- =============================================================================

alter table public.whatsapp_conversations add column if not exists ai_check_at timestamptz;

-- Conversas da conexão do CRO com mensagens novas do cliente ainda não lidas pela IA.
-- Espera 8 s depois da última mensagem (junta mensagens seguidas, como o n8n fazia) e
-- marca a conversa para não ser pega duas vezes. Só olha os últimos 2 dias (sem varrer histórico).
create or replace function public.wa_ai_claim(p_limit int default 3)
returns table (conversation_id uuid, tenant_id uuid)
language sql security definer set search_path = public as $$
  with pick as (
    select c.id
      from whatsapp_conversations c
      join whatsapp_instances i on i.id = c.instance_id
     where i.provider = 'gateway'
       and c.last_message_at > now() - interval '2 days'
       and c.last_message_at < now() - interval '8 seconds'
       and (c.ai_check_at is null or c.ai_check_at < c.last_message_at or c.ai_check_at < now() - interval '15 minutes')
       and exists (select 1 from whatsapp_messages m
                    where m.conversation_id = c.id and m.direction = 'inbound' and m.ai_analyzed = false)
     order by c.last_message_at
     limit greatest(1, least(p_limit, 10))
     for update of c skip locked
  )
  update whatsapp_conversations c
     set ai_check_at = now()
    from pick
   where c.id = pick.id
  returning c.id, c.tenant_id;
$$;

revoke all on function public.wa_ai_claim(int) from public, anon, authenticated;
grant execute on function public.wa_ai_claim(int) to service_role;

-- Mesma conexão em todo lugar: conectar, criar/iniciar disparo e a tela de saúde escolhem a
-- conexão do mesmo jeito que o envio (conectada e ligada primeiro). Antes pegavam a mais antiga.
do $$
declare r record; d text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and n.nspname = 'public'
       and p.proname in ('wa_gateway_connect', 'wa_campaign_save', 'wa_campaign_action', 'cro_health')
  loop
    d := pg_get_functiondef(r.oid);
    d := replace(d, 'provider = ''gateway'' order by created_at limit 1',
                    'provider = ''gateway'' order by (status = ''connected'' and desired_status = ''connected'') desc, (desired_status = ''connected'') desc, last_seen_at desc nulls last, created_at limit 1');
    execute d;
  end loop;
end $$;
