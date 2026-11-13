-- =============================================================================
-- Automações: botões clicáveis (API oficial) e arquivos enviados pelo computador.
-- =============================================================================

-- botões de resposta do WhatsApp (API oficial); no QR Code o menu sai numerado
alter table public.wa_outbox add column if not exists interactive jsonb;
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_gw_claim(text, uuid)'::regprocedure);
  d := replace(d, '''template'', o.template);', '''template'', o.template, ''interactive'', o.interactive);');
  execute d;
end $$;

-- arquivos das automações (PDF, imagem, áudio, vídeo) servidos por um link público
-- pela função flow-media — o editor aceita arquivo do computador, não só link
create table if not exists public.flow_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  file_name text not null,
  mime text not null,
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 16 * 1024 * 1024),
  data bytea not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.flow_media enable row level security; -- sem políticas: só a função (chave de serviço)
create index if not exists flow_media_tenant_idx on public.flow_media(tenant_id, created_at desc);

-- Quem pede SAIR recebe a confirmação ("Combinado! Não enviaremos mais…"): respostas e
-- automações criadas até 5 minutos depois do pedido ainda saem; depois disso, nada sai.
-- (antes a confirmação era bloqueada junto, porque o SAIR é gravado assim que a mensagem chega)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_gw_claim(text, uuid)'::regprocedure);
  d := replace(d, 'if exists (select 1 from public.wa_optouts where tenant_id = o.tenant_id and phone = o.phone) then',
                  'if exists (select 1 from public.wa_optouts x where x.tenant_id = o.tenant_id and x.phone = o.phone and x.created_at < o.created_at - interval ''5 minutes'') then');
  execute d;
end $$;

-- Confirmação automática do SAIR (como o Kommo fazia): quem pede para sair recebe uma
-- última mensagem confirmando. Texto por empresa; vazio desliga.
alter table public.wa_channel_settings add column if not exists optout_reply text
  default 'Combinado! Registramos o seu pedido e não enviaremos mais mensagens promocionais. Se precisar de algo, é só chamar por aqui.';

create or replace function idx_private.wa_optout_reply(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select optout_reply from public.wa_channel_settings where tenant_id = p_tenant),
                  'Combinado! Registramos o seu pedido e não enviaremos mais mensagens promocionais. Se precisar de algo, é só chamar por aqui.');
$$;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_gw_ingest(text, uuid, jsonb)'::regprocedure);
  d := replace(d, 'insert into public.wa_optouts (tenant_id, phone, source, body) values (v_tenant, v_phone, ''keyword'', left(v_body, 200))
      on conflict do nothing;',
    'insert into public.wa_optouts (tenant_id, phone, source, body) values (v_tenant, v_phone, ''keyword'', left(v_body, 200))
      on conflict do nothing;
      -- confirmação (uma vez, pela mesma conexão; sai mesmo com o SAIR por ter sido criada logo depois)
      if found and coalesce(trim(idx_private.wa_optout_reply(v_tenant)), '''') <> '''' then
        insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, conversation_id)
        values (v_tenant, p_instance, v_phone, idx_private.wa_optout_reply(v_tenant), ''manual'', v_conv);
      end if;
      -- automações em andamento com este contato param na hora
      update public.wa_flow_runs set status = ''cancelled'', last_error = ''Contato pediu SAIR'', finished_at = now()
       where tenant_id = v_tenant and phone = v_phone and status in (''waiting'', ''running'') and not is_test;');
  if d not like '%wa_optout_reply(v_tenant)%' then raise exception 'ingest: trecho do SAIR não encontrado'; end if;
  execute d;
end $$;
