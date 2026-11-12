-- =============================================================================
-- Conector MCP do CRO (Model Context Protocol) — para usar o CRO dentro do Claude
-- e de outras IAs, como os conectores oficiais (Meta, Google etc.).
-- -----------------------------------------------------------------------------
-- * Token pessoal por usuário e empresa (cro_…), criado em Configurações → IA (MCP).
--   O banco guarda só o sha256; o token aparece uma única vez.
-- * Permissão "leitura" ou "leitura e ações". Cada ferramenta roda COMO o dono do
--   token (auth.uid() = usuário), então valem as mesmas permissões do CRM.
-- * Toda chamada fica registrada em mcp_calls (auditoria).
-- * Ações sensíveis (enviar WhatsApp, iniciar disparo) apenas colocam na fila e
--   seguem as mesmas proteções da tela (SAIR, horário, limite diário…).
-- Não destrutiva.
-- =============================================================================

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,                 -- "cro_ab12…" para reconhecer na lista
  scope text not null default 'read' check (scope in ('read', 'write')),
  last_used_at timestamptz,
  calls integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_mcp_tokens_user on public.mcp_tokens(user_id, tenant_id);

create table if not exists public.mcp_calls (
  id bigint generated always as identity primary key,
  token_id uuid references public.mcp_tokens(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid,
  tool text not null,
  ok boolean not null,
  error text,
  args jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_mcp_calls_tenant on public.mcp_calls(tenant_id, created_at desc);

alter table public.mcp_tokens enable row level security;
alter table public.mcp_calls enable row level security;
drop policy if exists mcp_tokens_own on public.mcp_tokens;
create policy mcp_tokens_own on public.mcp_tokens for select to authenticated using (user_id = auth.uid());
drop policy if exists mcp_calls_read on public.mcp_calls;
create policy mcp_calls_read on public.mcp_calls for select to authenticated
  using (user_id = auth.uid() or idx_private.crm_can(tenant_id, 'audit'));

-- Busca manual pedida pela IA/tela: roda na próxima passada do motor (até 10 min)
create or replace function public.maps_due_sources(p_limit int default 5)
returns setof uuid language sql security definer set search_path = public, pg_temp
as $$
  select id from public.lead_sources
   where active and next_run_at is not null and next_run_at <= now()
     and (running_since is null or running_since < now() - interval '10 minutes')
   order by next_run_at limit p_limit;
$$;

-- -----------------------------------------------------------------------------
-- Tokens (tela)
-- -----------------------------------------------------------------------------
create or replace function public.mcp_token_create(p_tenant_id uuid, p_name text, p_scope text default 'read', p_days int default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_token text; v_id uuid;
begin
  if auth.uid() is null or not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  if p_scope not in ('read', 'write') then raise exception 'Permissão inválida'; end if;
  if p_scope = 'write' and not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Seu perfil só permite tokens de leitura'; end if;
  if (select count(*) from public.mcp_tokens where user_id = auth.uid() and revoked_at is null) >= 20 then
    raise exception 'Limite de 20 tokens ativos — revogue algum antes';
  end if;
  v_token := 'cro_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.mcp_tokens (user_id, tenant_id, name, token_hash, token_prefix, scope, expires_at)
  values (auth.uid(), p_tenant_id, coalesce(nullif(trim(p_name), ''), 'Claude'),
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(v_token, 10), p_scope,
          case when p_days is not null then now() + make_interval(days => p_days) end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token);   -- única vez que o token aparece
end $$;

create or replace function public.mcp_token_revoke(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.mcp_tokens set revoked_at = now()
   where id = p_id and revoked_at is null
     and (user_id = auth.uid() or idx_private.crm_can(tenant_id, 'configure'));
  if not found then raise exception 'Token não encontrado'; end if;
end $$;

-- -----------------------------------------------------------------------------
-- Execução das ferramentas (chamado só pela função cro-mcp, com service role)
-- -----------------------------------------------------------------------------
create or replace function idx_private.mcp_auth(p_token text)
returns public.mcp_tokens
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t public.mcp_tokens;
begin
  select * into t from public.mcp_tokens
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if t.id is null or t.revoked_at is not null or (t.expires_at is not null and t.expires_at < now()) then
    raise exception 'mcp_unauthorized';
  end if;
  -- o usuário ainda precisa ter acesso à empresa
  if not exists (select 1 from public.tenant_users tu where tu.tenant_id = t.tenant_id and tu.user_id = t.user_id and tu.status = 'active')
     and not exists (select 1 from public.platform_users pu where pu.user_id = t.user_id and pu.status = 'active') then
    raise exception 'mcp_unauthorized';
  end if;
  -- age como o dono do token: auth.uid() e as permissões do CRM passam a valer para ele
  perform set_config('request.jwt.claim.sub', t.user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.user_id, 'role', 'authenticated')::text, true);
  return t;
end $$;

create or replace function public.mcp_whoami(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare t public.mcp_tokens;
begin
  t := idx_private.mcp_auth(p_token);
  return jsonb_build_object('tenant_id', t.tenant_id, 'tenant', (select name from public.tenants where id = t.tenant_id),
    'user', (select email from auth.users where id = t.user_id), 'scope', t.scope,
    'access', public.crm_my_access(t.tenant_id));
end $$;

create or replace function public.mcp_call(p_token text, p_tool text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t public.mcp_tokens;
  a jsonb := coalesce(p_args, '{}'::jsonb);
  tid uuid;
  r jsonb;
  v_id uuid;
  v_txt text;
  v_lim int;
  v_days int;
  v_company uuid;
  v_writes text[] := array['criar_contato', 'criar_tarefa', 'concluir_tarefa', 'adicionar_nota', 'registrar_ligacao',
                           'enviar_whatsapp', 'controlar_disparo', 'rodar_busca_google_maps'];
begin
  t := idx_private.mcp_auth(p_token);
  tid := t.tenant_id;
  v_lim := least(greatest(coalesce((a->>'limite')::int, 20), 1), 100);

  begin
    if p_tool = any(v_writes) then
      if t.scope <> 'write' then raise exception 'Este token é só de leitura. Crie um token com “leitura e ações” no CRO.'; end if;
      if not idx_private.crm_can(tid, 'write') then raise exception 'Seu perfil no CRM não permite alterações'; end if;
    elsif not idx_private.crm_can(tid, 'read') then
      raise exception 'Sem acesso ao CRM desta empresa';
    end if;

    case p_tool
    -- ===================== leitura =====================
    when 'resumo_comercial' then
      v_days := least(greatest(coalesce((a->>'dias')::int, 30), 1), 365);
      r := jsonb_build_object(
        'empresa', (select name from public.tenants where id = tid),
        'periodo_dias', v_days,
        'indicadores', public.crm_kpis(tid, now() - make_interval(days => v_days), now(), null),
        'discador', public.crm_dial_overview(tid, null),
        'tarefas', jsonb_build_object(
          'atrasadas', (select count(*) from public.crm_tasks where tenant_id = tid and status = 'open' and due_at < now()),
          'hoje', (select count(*) from public.crm_tasks where tenant_id = tid and status = 'open'
                    and (due_at at time zone idx_private.crm_tenant_tz(tid))::date = (now() at time zone idx_private.crm_tenant_tz(tid))::date),
          'minhas_abertas', (select count(*) from public.crm_tasks where tenant_id = tid and status = 'open' and owner_id = t.user_id)),
        'negociacoes_abertas', (select jsonb_build_object('quantidade', count(*), 'valor', coalesce(sum(value), 0))
                                  from public.crm_deals where tenant_id = tid and status = 'open' and archived_at is null),
        'whatsapp', jsonb_build_object(
          'conectado', exists (select 1 from public.whatsapp_instances where tenant_id = tid and provider = 'gateway' and status = 'connected'),
          'conversas_nao_lidas', (select count(*) from public.whatsapp_conversations where tenant_id = tid and unread_count > 0)),
        'disparos', (select coalesce(jsonb_agg(jsonb_build_object('nome', name, 'status', status, 'enviados', sent, 'total', total, 'responderam', replied)), '[]')
                       from public.wa_campaign_list(tid) where status in ('running', 'paused', 'draft')));

    when 'buscar_contatos' then
      v_txt := trim(coalesce(a->>'busca', ''));
      select coalesce(jsonb_agg(x), '[]') into r from (
        select c.id, c.name as nome, c.phone as telefone, c.email, c.city as cidade, c.lifecycle_stage as etapa,
               co.name as empresa, c.last_interaction_at as ultima_interacao
          from public.crm_contacts c left join public.crm_companies co on co.id = c.company_id
         where c.tenant_id = tid and c.merged_into_id is null and c.archived_at is null
           and (v_txt = '' or c.name ilike '%' || v_txt || '%' or c.email ilike '%' || v_txt || '%' or co.name ilike '%' || v_txt || '%'
                or (v_txt ~ '^[0-9 ()+.-]+$' and length(regexp_replace(v_txt, '\D', '', 'g')) >= 4
                    and c.phone like '%' || regexp_replace(v_txt, '\D', '', 'g') || '%'))
         order by c.last_interaction_at desc nulls last, c.created_at desc limit v_lim) x;

    when 'ver_contato' then
      v_id := (a->>'contato_id')::uuid;
      if not exists (select 1 from public.crm_contacts where id = v_id and tenant_id = tid) then raise exception 'Contato não encontrado'; end if;
      select jsonb_build_object(
        'contato', (select to_jsonb(x) from (select c.id, c.name as nome, c.phone as telefone, c.whatsapp, c.email, c.city as cidade,
                      c.state as uf, c.lifecycle_stage as etapa, c.source_channel as origem, c.lead_score, c.tags, c.notes as observacoes,
                      c.do_not_contact as nao_contatar, co.name as empresa, c.created_at as criado_em
                      from public.crm_contacts c left join public.crm_companies co on co.id = c.company_id where c.id = v_id) x),
        'negociacoes', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'titulo', d.title, 'valor', d.value, 'status', d.status,
                          'etapa', s.name, 'previsao', d.expected_close_date)), '[]')
                          from public.crm_deals d left join public.crm_stages s on s.id = d.stage_id
                         where d.tenant_id = tid and d.contact_id = v_id and d.archived_at is null),
        'tarefas_abertas', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'titulo', k.title, 'tipo', k.task_type, 'vence', k.due_at) order by k.due_at), '[]')
                              from public.crm_tasks k where k.tenant_id = tid and k.contact_id = v_id and k.status = 'open'),
        'historico', (select coalesce(jsonb_agg(jsonb_build_object('tipo', h.kind, 'titulo', h.title, 'texto', left(h.body, 400), 'quando', h.occurred_at) order by h.occurred_at desc), '[]')
                        from (select * from public.crm_timeline where tenant_id = tid and contact_id = v_id order by occurred_at desc limit 15) h),
        'whatsapp', (select coalesce(jsonb_agg(jsonb_build_object('direcao', m.direction, 'texto', left(m.body, 300), 'quando', m."timestamp") order by m."timestamp" desc), '[]')
                       from (select m.* from public.whatsapp_messages m
                               join public.whatsapp_conversations cv on cv.id = m.conversation_id
                               join public.whatsapp_contacts wc on wc.id = cv.contact_id
                              where m.tenant_id = tid and wc.crm_contact_id = v_id
                              order by m."timestamp" desc limit 10) m))
        into r;

    when 'listar_negociacoes' then
      select coalesce(jsonb_agg(x), '[]') into r from (
        select d.id, d.title as titulo, d.value as valor, d.status, s.name as etapa, c.name as contato, c.id as contato_id,
               d.expected_close_date as previsao, d.last_activity_at as ultima_atividade, d.next_activity_at as proxima_atividade
          from public.crm_deals d left join public.crm_stages s on s.id = d.stage_id left join public.crm_contacts c on c.id = d.contact_id
         where d.tenant_id = tid and d.archived_at is null and d.status = coalesce(nullif(a->>'status', ''), 'open')
         order by d.value desc nulls last, d.created_at desc limit v_lim) x;

    when 'listar_tarefas' then
      select coalesce(jsonb_agg(x), '[]') into r from (
        select k.id, k.title as titulo, k.task_type as tipo, k.due_at as vence, k.description as descricao, k.priority as prioridade,
               c.name as contato, c.phone as telefone, k.contact_id as contato_id
          from public.crm_tasks k left join public.crm_contacts c on c.id = k.contact_id
         where k.tenant_id = tid and k.status = 'open'
           and (coalesce((a->>'so_minhas')::boolean, true) = false or k.owner_id = t.user_id)
           and case coalesce(a->>'filtro', 'hoje')
                 when 'atrasadas' then k.due_at < now()
                 when 'hoje' then (k.due_at at time zone idx_private.crm_tenant_tz(tid))::date <= (now() at time zone idx_private.crm_tenant_tz(tid))::date
                 when 'semana' then k.due_at < now() + interval '7 days'
                 else true end
         order by k.due_at nulls last limit v_lim) x;

    when 'discador' then
      r := jsonb_build_object(
        'resumo', public.crm_dial_overview(tid, nullif(a->>'lista', '')),
        'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'nome', l.name, 'telefone', l.phone, 'cidade', l.city, 'uf', l.uf,
                    'google', l.district, 'status', l.status, 'resultado', l.outcome, 'lista', l.list_name, 'ligacoes', l.call_count)), '[]')
                  from (select * from public.crm_dial_leads l
                         where l.tenant_id = tid
                           and (nullif(a->>'lista', '') is null or l.list_name = a->>'lista')
                           and l.status = coalesce(nullif(a->>'status', ''), 'pending')
                           and (nullif(a->>'uf', '') is null or l.uf = upper(a->>'uf'))
                           and (nullif(a->>'busca', '') is null or l.name ilike '%' || (a->>'busca') || '%' or l.city ilike '%' || (a->>'busca') || '%')
                         order by l.maps_rank nulls last, l.name limit v_lim) l));

    when 'listar_disparos' then
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.name, 'status', c.status, 'total', c.total, 'pendentes', c.pending,
               'enviados', c.sent, 'responderam', c.replied, 'sem_whatsapp', c.invalid, 'pediram_sair', c.opted_out, 'falhas', c.failed,
               'enviados_hoje', c.sent_today, 'limite_diario', c.daily_limit, 'horario', c.start_hour || 'h–' || c.end_hour || 'h',
               'alimentacao_automatica', c.auto_feed, 'proximo_envio', c.next_send_at, 'mensagem', c.messages[1])), '[]')
        into r from public.wa_campaign_list(tid) c;

    when 'ver_disparo' then
      v_id := (a->>'disparo_id')::uuid;
      if not exists (select 1 from public.wa_campaigns where id = v_id and tenant_id = tid) then raise exception 'Disparo não encontrado'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('nome', x.name, 'telefone', x.phone, 'status', x.status, 'enviado_em', x.sent_at,
               'respondeu_em', x.replied_at, 'erro', x.error, 'contato_id', x.crm_contact_id)), '[]') into r
        from (select * from public.wa_campaign_recipients
               where campaign_id = v_id
                 and case coalesce(a->>'filtro', 'responderam')
                       when 'responderam' then replied_at is not null
                       when 'enviados' then status = 'sent'
                       when 'falhas' then status in ('failed', 'invalid')
                       when 'pendentes' then status in ('pending', 'queued')
                       else true end
               order by replied_at desc nulls last, sent_at desc nulls last limit v_lim) x;

    when 'conversas_whatsapp' then
      select coalesce(jsonb_agg(x), '[]') into r from (
        select cv.id as conversa_id, coalesce(wc.push_name, wc.phone) as nome, wc.phone as telefone, cv.unread_count as nao_lidas,
               cv.last_message_at as ultima_mensagem_em, wc.crm_contact_id as contato_id,
               (select jsonb_build_object('direcao', m.direction, 'texto', left(m.body, 300))
                  from public.whatsapp_messages m where m.conversation_id = cv.id order by m."timestamp" desc limit 1) as ultima
          from public.whatsapp_conversations cv join public.whatsapp_contacts wc on wc.id = cv.contact_id
         where cv.tenant_id = tid and (coalesce((a->>'nao_lidas')::boolean, false) = false or cv.unread_count > 0)
         order by cv.last_message_at desc nulls last limit v_lim) x;

    when 'buscas_google_maps' then
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name, 'busca', s.query, 'locais', cardinality(s.locations),
               'proximo_local', s.locations[1 + s.location_cursor % greatest(cardinality(s.locations), 1)], 'lista', s.list_name,
               'automatica', s.auto, 'proxima_execucao', s.next_run_at, 'ultima_execucao', s.last_run_at, 'ultimo_resultado', s.last_result)), '[]')
        into r from public.lead_sources s where s.tenant_id = tid and s.active;

    -- ===================== ações =====================
    when 'criar_contato' then
      if coalesce(trim(a->>'nome'), '') = '' and coalesce(trim(a->>'telefone'), '') = '' then raise exception 'Informe nome ou telefone'; end if;
      select id into v_id from public.crm_contacts
       where tenant_id = tid and merged_into_id is null and phone = idx_private.normalize_phone(a->>'telefone') limit 1;
      if v_id is not null then
        r := jsonb_build_object('contato_id', v_id, 'ja_existia', true);
      else
        insert into public.crm_contacts (tenant_id, name, phone, email, city, owner_id, source_channel, acquisition_basis, notes, created_by)
        values (tid, nullif(trim(a->>'nome'), ''), nullif(trim(a->>'telefone'), ''), nullif(trim(a->>'email'), ''),
                nullif(trim(a->>'cidade'), ''), t.user_id, 'manual', 'unknown', nullif(trim(a->>'observacoes'), ''), t.user_id)
        returning id into v_id;
        if nullif(trim(a->>'empresa'), '') is not null then
          select id into v_company from public.crm_companies where tenant_id = tid and lower(name) = lower(trim(a->>'empresa')) and archived_at is null limit 1;
          if v_company is null then
            insert into public.crm_companies (tenant_id, name, owner_id, created_by) values (tid, trim(a->>'empresa'), t.user_id, t.user_id)
            returning id into v_company;
          end if;
          update public.crm_contacts set company_id = v_company where id = v_id;
        end if;
        r := jsonb_build_object('contato_id', v_id, 'ja_existia', false);
      end if;

    when 'criar_tarefa' then
      if coalesce(trim(a->>'titulo'), '') = '' then raise exception 'Informe o título da tarefa'; end if;
      if (a->>'contato_id') is not null and not exists (select 1 from public.crm_contacts where id = (a->>'contato_id')::uuid and tenant_id = tid) then
        raise exception 'Contato não encontrado';
      end if;
      insert into public.crm_tasks (tenant_id, task_type, title, description, owner_id, contact_id, due_at, priority, created_by)
      values (tid, coalesce(nullif(a->>'tipo', ''), 'task'), trim(a->>'titulo'), nullif(a->>'descricao', ''), t.user_id,
              (a->>'contato_id')::uuid, coalesce((a->>'vencimento')::timestamptz, now() + interval '1 hour'),
              coalesce(nullif(a->>'prioridade', ''), 'normal'), t.user_id)
      returning id into v_id;
      r := jsonb_build_object('tarefa_id', v_id);

    when 'concluir_tarefa' then
      update public.crm_tasks set status = 'done', completed_at = now(), completed_by = t.user_id, outcome = nullif(a->>'resultado', '')
       where id = (a->>'tarefa_id')::uuid and tenant_id = tid and status = 'open' returning id into v_id;
      if v_id is null then raise exception 'Tarefa aberta não encontrada'; end if;
      r := jsonb_build_object('ok', true);

    when 'adicionar_nota' then
      v_id := (a->>'contato_id')::uuid;
      if not exists (select 1 from public.crm_contacts where id = v_id and tenant_id = tid) then raise exception 'Contato não encontrado'; end if;
      if coalesce(trim(a->>'texto'), '') = '' then raise exception 'Escreva a nota'; end if;
      insert into public.crm_timeline (tenant_id, contact_id, kind, title, body, actor_id, metadata)
      values (tid, v_id, 'note', 'Nota', left(trim(a->>'texto'), 4000), t.user_id, jsonb_build_object('via', 'mcp'));
      r := jsonb_build_object('ok', true);

    when 'registrar_ligacao' then
      if not exists (select 1 from public.crm_dial_leads where id = (a->>'lead_id')::uuid and tenant_id = tid) then raise exception 'Lead não encontrado'; end if;
      r := to_jsonb(public.crm_dial_set_outcome((a->>'lead_id')::uuid, a->>'resultado', a->>'observacao',
                                                (a->>'retorno_em')::timestamptz, a->>'objecao'));
      r := jsonb_build_object('ok', true, 'lead', r - 'notes');

    when 'enviar_whatsapp' then
      v_id := public.wa_send_message(tid, a->>'mensagem', nullif(a->>'telefone', ''), (a->>'conversa_id')::uuid);
      r := jsonb_build_object('na_fila', true, 'envio_id', v_id,
             'aviso', 'Mensagem colocada na fila do WhatsApp do CRO; sai em segundos se o número estiver conectado.');

    when 'controlar_disparo' then
      if (a->>'acao') not in ('pausar', 'retomar', 'iniciar', 'cancelar') then raise exception 'Ação deve ser pausar, retomar, iniciar ou cancelar'; end if;
      if not exists (select 1 from public.wa_campaigns where id = (a->>'disparo_id')::uuid and tenant_id = tid) then raise exception 'Disparo não encontrado'; end if;
      perform public.wa_campaign_action((a->>'disparo_id')::uuid,
        case a->>'acao' when 'pausar' then 'pause' when 'retomar' then 'resume' when 'iniciar' then 'start' else 'cancel' end);
      r := jsonb_build_object('ok', true, 'status', (select status from public.wa_campaigns where id = (a->>'disparo_id')::uuid));

    when 'rodar_busca_google_maps' then
      update public.lead_sources set next_run_at = now()
       where id = (a->>'busca_id')::uuid and tenant_id = tid and active returning id into v_id;
      if v_id is null then raise exception 'Busca não encontrada'; end if;
      r := jsonb_build_object('agendada', true, 'aviso', 'A busca roda na próxima passada do motor (em até 10 minutos). Os novos clientes aparecem no discador.');

    else
      raise exception 'Ferramenta desconhecida: %', p_tool;
    end case;

  end;
  update public.mcp_tokens set last_used_at = now(), calls = calls + 1 where id = t.id;
  insert into public.mcp_calls (token_id, tenant_id, user_id, tool, ok, args)
  values (t.id, tid, t.user_id, p_tool, true, case when p_tool = any(v_writes) then a end);
  return coalesce(r, 'null'::jsonb);
end $$;

-- Falhas são gravadas numa chamada separada (a da ferramenta é desfeita inteira)
create or replace function public.mcp_log_error(p_token text, p_tool text, p_error text, p_args jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare t public.mcp_tokens;
begin
  select * into t from public.mcp_tokens where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if t.id is null then return; end if;
  insert into public.mcp_calls (token_id, tenant_id, user_id, tool, ok, error, args)
  values (t.id, t.tenant_id, t.user_id, left(p_tool, 60), false, left(p_error, 300), p_args);
end $$;

revoke all on function idx_private.mcp_auth(text) from public;
revoke all on function public.mcp_call(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.mcp_whoami(text) from public, anon, authenticated;
grant execute on function public.mcp_call(text, text, jsonb) to service_role;
grant execute on function public.mcp_whoami(text) to service_role;
revoke all on function public.mcp_log_error(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mcp_log_error(text, text, text, jsonb) to service_role;
grant execute on function public.mcp_token_create(uuid, text, text, int) to authenticated;
grant execute on function public.mcp_token_revoke(uuid) to authenticated;
