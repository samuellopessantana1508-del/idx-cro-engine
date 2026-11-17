-- Caixa de entrada: enviar arquivos (PDF, imagem, vídeo, áudio, Office) pela conversa.
-- Usa a mesma fila (wa_outbox, source 'manual') e a mesma conexão ativa das respostas de texto;
-- o arquivo é enviado antes pela função flow-media, que devolve um link público que o WhatsApp baixa.
-- O histórico passa a guardar o link do arquivo enviado (media_url), para a equipe ver/ouvir pelo CRO.

create or replace function public.wa_send_media(
  p_tenant_id uuid, p_media_url text, p_media_type text, p_file_name text default null, p_caption text default null,
  p_phone text default null, p_conversation_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_instance uuid;
  v_conv uuid := p_conversation_id;
  v_id uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão para enviar mensagens'; end if;
  if coalesce(p_media_type, '') not in ('image', 'video', 'audio', 'document') then raise exception 'Tipo de arquivo inválido'; end if;
  if coalesce(p_media_url, '') !~ '^(https://|http://(127\.0\.0\.1|localhost)(:[0-9]+)?/)' or length(p_media_url) > 2000 then raise exception 'Envie o arquivo antes'; end if;

  if v_conv is not null then
    select coalesce(c.phone, c.wa_id), cv.instance_id into v_phone, v_instance
      from public.whatsapp_conversations cv join public.whatsapp_contacts c on c.id = cv.contact_id
     where cv.id = v_conv and cv.tenant_id = p_tenant_id;
    if v_phone is null then raise exception 'Conversa não encontrada'; end if;
    if not exists (select 1 from public.whatsapp_instances where id = v_instance and provider = idx_private.wa_active_provider(p_tenant_id)) then
      v_instance := null;
    end if;
  else
    v_phone := p_phone;
  end if;

  v_phone := idx_private.normalize_phone(v_phone);
  if v_phone is null then raise exception 'Telefone inválido'; end if;
  if exists (select 1 from public.wa_optouts where tenant_id = p_tenant_id and phone = v_phone) then
    raise exception 'Este contato pediu para não receber mensagens (SAIR)';
  end if;

  if v_instance is null then
    select id into v_instance from public.whatsapp_instances
     where tenant_id = p_tenant_id and provider = idx_private.wa_active_provider(p_tenant_id)
     order by (status = 'connected' and desired_status = 'connected') desc, (desired_status = 'connected') desc, last_seen_at desc nulls last, created_at limit 1;
  end if;
  if v_instance is null then raise exception 'Conecte o WhatsApp em WhatsApp → Conexão antes de enviar'; end if;

  insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, conversation_id, created_by, media_url, media_type, file_name)
  values (p_tenant_id, v_instance, v_phone,
          case when p_media_type = 'audio' then '' else left(coalesce(trim(p_caption), ''), 1024) end,
          'manual', v_conv, auth.uid(), p_media_url, p_media_type, left(nullif(trim(p_file_name), ''), 200))
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.wa_send_media(uuid, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.wa_send_media(uuid, text, text, text, text, text, uuid) to authenticated;

-- Histórico: guarda o link do arquivo enviado e, sem legenda, mostra o nome do documento.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.wa_gw_result(text,uuid,boolean,text,text,text,boolean,boolean)'::regprocedure);
  n := replace(d, $q$'body', nullif(o.body, ''), 'type', coalesce(o.media_type, 'text'),$q$,
                  $q$'body', coalesce(nullif(o.body, ''), case when o.media_type = 'document' then o.file_name end), 'type', coalesce(o.media_type, 'text'), 'media_url', o.media_url,$q$);
  if n = d then raise exception 'wa_gw_result: trecho esperado não encontrado'; end if;
  execute n;

  for d in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname = 'wa_gw_ingest' loop
    n := replace(d, 'body, media_mime, quoted_message_id', 'body, media_mime, media_url, quoted_message_id');
    n := replace(n, $q$v_body, p_msg->>'mime', p_msg->>'quoted_id'$q$, $q$v_body, p_msg->>'mime', nullif(p_msg->>'media_url', ''), p_msg->>'quoted_id'$q$);
    if n = d or position('media_url, quoted_message_id' in n) = 0 or position($q$nullif(p_msg->>'media_url', '')$q$ in n) = 0 then
      raise exception 'wa_gw_ingest: trecho esperado não encontrado';
    end if;
    execute n;
  end loop;
end $$;

notify pgrst, 'reload schema';
