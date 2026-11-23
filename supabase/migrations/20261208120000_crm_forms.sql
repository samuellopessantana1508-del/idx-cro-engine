-- Formulários do CRO: questionários públicos (estilo "Cartão" ou "Uma pergunta por tela") que caem direto no CRM.
-- Cada visita vira uma sessão com origem (UTM, fbclid, gclid), aparelho, passos vistos, respostas e cliques;
-- quem envia o formulário vira contato + negociação + registro na linha do tempo, com tudo isso anexado.
-- A página pública usa só a chave publicável: as funções form_public/form_track/form_submit validam tudo no banco.

-- 1. Marca da empresa (logo e cor), usada no menu e nos formulários ------------------------------------------
alter table public.crm_settings add column if not exists logo_url text;
alter table public.crm_settings add column if not exists brand_color text;
alter table public.crm_settings drop constraint if exists crm_settings_logo_url_check;
alter table public.crm_settings add constraint crm_settings_logo_url_check check (logo_url is null or logo_url ~ '^https://');
alter table public.crm_settings drop constraint if exists crm_settings_brand_color_check;
alter table public.crm_settings add constraint crm_settings_brand_color_check check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');

-- 2. Linha do tempo aceita o tipo "form" ---------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.crm_timeline'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'deal_created';
  if c is not null then execute format('alter table public.crm_timeline drop constraint %I', c); end if;
end $$;
alter table public.crm_timeline add constraint crm_timeline_kind_check check (kind in (
  'note', 'call_log', 'meeting_log', 'whatsapp', 'email_log',
  'deal_created', 'stage_change', 'deal_won', 'deal_lost', 'deal_reopened',
  'task_done', 'order', 'payment', 'refund', 'sample', 'ai_insight', 'lifecycle',
  'rfv', 'automation', 'merge', 'import', 'system', 'form'));

-- 3. Tabelas ---------------------------------------------------------------------------------------------------
create table if not exists public.crm_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  style text not null default 'card' check (style in ('card', 'steps')),
  content jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint crm_forms_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  constraint crm_forms_name_check check (length(trim(name)) between 1 and 120),
  constraint crm_forms_content_size check (pg_column_size(content) < 200000),
  unique (tenant_id, id)
);
create unique index if not exists crm_forms_slug_key on public.crm_forms (slug);
create index if not exists idx_crm_forms_tenant on public.crm_forms (tenant_id, updated_at desc);

create table if not exists public.crm_form_sessions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.crm_forms(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_step int not null default 0,
  max_step int not null default 0,
  answers jsonb not null default '{}'::jsonb,
  events jsonb not null default '[]'::jsonb,
  event_count int not null default 0,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  fbclid text, gclid text, ttclid text, fbp text, fbc text,
  referrer text, landing_url text, user_agent text, ip text, device text,
  name text, phone text, email text,
  contact_id uuid, deal_id uuid, tracking_session_id uuid references public.tracking_sessions(id) on delete set null,
  foreign key (tenant_id, contact_id) references public.crm_contacts(tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, deal_id) references public.crm_deals(tenant_id, id) on delete set null (deal_id)
);
create index if not exists idx_crm_form_sessions_form on public.crm_form_sessions (form_id, created_at desc);
create index if not exists idx_crm_form_sessions_ip on public.crm_form_sessions (ip, created_at desc);

alter table public.crm_forms enable row level security;
alter table public.crm_form_sessions enable row level security;
drop policy if exists crm_forms_read on public.crm_forms;
create policy crm_forms_read on public.crm_forms for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists crm_form_sessions_read on public.crm_form_sessions;
create policy crm_form_sessions_read on public.crm_form_sessions for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
revoke all on public.crm_forms, public.crm_form_sessions from anon;
grant select on public.crm_forms, public.crm_form_sessions to authenticated;

-- 4. Utilidades ------------------------------------------------------------------------------------------------
create or replace function idx_private.form_txt(v text, n int)
returns text language sql immutable as $$ select nullif(left(trim(coalesce(v, '')), n), '') $$;

-- cabeçalhos da requisição (PostgREST): IP e navegador de quem abriu o formulário
create or replace function idx_private.form_req_header(h text)
returns text language plpgsql stable as $$
declare v jsonb;
begin
  begin v := current_setting('request.headers', true)::jsonb; exception when others then return null; end;
  return v ->> h;
end $$;

create or replace function idx_private.form_device(ua text)
returns text language sql immutable as $$
  select case when ua is null then null
              when ua ~* '(ipad|tablet)' then 'tablet'
              when ua ~* '(iphone|android.*mobile|mobile)' then 'celular'
              else 'computador' end
$$;

-- 5. Página pública: lê o formulário publicado + a marca da empresa ---------------------------------------------
create or replace function public.form_public(p_slug text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare f public.crm_forms; s public.crm_settings; t public.tenants;
begin
  select * into f from public.crm_forms where slug = lower(trim(p_slug)) and status = 'published';
  if f.id is null then return null; end if;
  select * into s from public.crm_settings where tenant_id = f.tenant_id;
  select * into t from public.tenants where id = f.tenant_id;
  return jsonb_build_object(
    'id', f.id, 'slug', f.slug, 'name', f.name, 'style', f.style, 'content', f.content,
    'pixel_id', f.settings ->> 'pixel_id',
    'brand', jsonb_build_object('name', t.name, 'logo_url', s.logo_url, 'color', s.brand_color));
end $$;

-- 6. Rastreio de cada passo (abre, começa, vê pergunta, responde, volta, clica, envia) ---------------------------
create or replace function public.form_track(p_slug text, p_session uuid, p_event text, p_step int default null,
  p_data jsonb default '{}'::jsonb, p_meta jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  f public.crm_forms; ss public.crm_form_sessions;
  v_ip text := left(coalesce(split_part(idx_private.form_req_header('x-forwarded-for'), ',', 1), idx_private.form_req_header('x-real-ip')), 64);
  v_ua text := left(idx_private.form_req_header('user-agent'), 400);
  v_ev jsonb;
begin
  if p_event not in ('view', 'start', 'step_view', 'answer', 'back', 'click', 'capture_view', 'submit', 'done_click') then
    raise exception 'Evento inválido';
  end if;
  select * into f from public.crm_forms where slug = lower(trim(p_slug)) and status = 'published';
  if f.id is null then raise exception 'Formulário não encontrado'; end if;
  if p_session is not null then
    select * into ss from public.crm_form_sessions where id = p_session and form_id = f.id for update;
  end if;

  if ss.id is null then
    -- proteção simples contra robô: no máximo 60 visitas por IP em 10 minutos
    if v_ip is not null and (select count(*) from public.crm_form_sessions where ip = v_ip and created_at > now() - interval '10 minutes') >= 60 then
      raise exception 'Muitas visitas seguidas. Tente de novo em alguns minutos.';
    end if;
    insert into public.crm_form_sessions (id, form_id, tenant_id, ip, user_agent, device,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, ttclid, fbp, fbc, referrer, landing_url)
    values (coalesce(p_session, gen_random_uuid()), f.id, f.tenant_id, v_ip, v_ua, idx_private.form_device(v_ua),
      idx_private.form_txt(p_meta ->> 'utm_source', 200), idx_private.form_txt(p_meta ->> 'utm_medium', 200),
      idx_private.form_txt(p_meta ->> 'utm_campaign', 200), idx_private.form_txt(p_meta ->> 'utm_content', 200),
      idx_private.form_txt(p_meta ->> 'utm_term', 200), idx_private.form_txt(p_meta ->> 'fbclid', 300),
      idx_private.form_txt(p_meta ->> 'gclid', 300), idx_private.form_txt(p_meta ->> 'ttclid', 300),
      idx_private.form_txt(p_meta ->> 'fbp', 200), idx_private.form_txt(p_meta ->> 'fbc', 400),
      idx_private.form_txt(p_meta ->> 'referrer', 500), idx_private.form_txt(p_meta ->> 'landing_url', 1000))
    returning * into ss;
  end if;
  if ss.event_count >= 400 then return ss.id; end if;   -- limite por visita

  v_ev := jsonb_strip_nulls(jsonb_build_object('t', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'e', p_event, 's', p_step,
    'q', idx_private.form_txt(p_data ->> 'question', 80), 'a', idx_private.form_txt(p_data ->> 'answer', 300),
    'label', idx_private.form_txt(p_data ->> 'label', 120), 'ms', case when (p_data ->> 'ms') ~ '^\d{1,9}$' then (p_data ->> 'ms')::int end));

  update public.crm_form_sessions set
    updated_at = now(),
    started_at = case when p_event in ('start', 'answer') then coalesce(started_at, now()) else started_at end,
    last_step = coalesce(p_step, last_step),
    max_step = greatest(max_step, coalesce(p_step, 0)),
    answers = case when p_event = 'answer' and idx_private.form_txt(p_data ->> 'question', 80) is not null
                   then answers || jsonb_build_object(p_data ->> 'question', left(p_data ->> 'answer', 1000)) else answers end,
    events = events || jsonb_build_array(v_ev),
    event_count = event_count + 1
  where id = ss.id;
  return ss.id;
end $$;

-- 7. Envio: contato + negociação + linha do tempo + aviso ----------------------------------------------------------
create or replace function public.form_submit(p_slug text, p_session uuid, p_answers jsonb, p_contact jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  f public.crm_forms; ss public.crm_form_sessions;
  v_name text := idx_private.form_txt(p_contact ->> 'name', 120);
  v_phone text := idx_private.normalize_phone(p_contact ->> 'phone');
  v_email text := case when (p_contact ->> 'email') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(left(p_contact ->> 'email', 200)) end;
  v_need_phone boolean; v_need_email boolean;
  v_ts uuid; v_contact uuid; v_deal uuid; v_stage public.crm_stages; v_owner uuid;
  v_tags text[]; v_q jsonb; v_lines text := ''; v_answers jsonb := '{}'::jsonb; v_by_id jsonb := '{}'::jsonb; v_title text;
  v_ref text;
begin
  select * into f from public.crm_forms where slug = lower(trim(p_slug)) and status = 'published';
  if f.id is null then raise exception 'Formulário não encontrado'; end if;
  select * into ss from public.crm_form_sessions where id = p_session and form_id = f.id for update;
  if ss.id is null then raise exception 'Visita não encontrada. Recarregue a página.'; end if;
  if ss.completed_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'contact_id', ss.contact_id);
  end if;

  v_need_phone := coalesce((f.content #>> '{capture,fields,phone}')::boolean, true);
  v_need_email := coalesce((f.content #>> '{capture,email_required}')::boolean, false);
  if v_need_phone and v_phone is null then raise exception 'Informe um WhatsApp válido com DDD'; end if;
  if v_need_email and v_email is null then raise exception 'Informe um e-mail válido'; end if;
  if v_phone is null and v_email is null then raise exception 'Informe seu WhatsApp ou e-mail'; end if;

  -- respostas na ordem das perguntas, com o texto da pergunta (o que o vendedor lê)
  for v_q in select * from jsonb_array_elements(coalesce(f.content -> 'questions', '[]'::jsonb)) loop
    if coalesce(p_answers ->> (v_q ->> 'id'), '') <> '' then
      v_answers := v_answers || jsonb_build_object(left(v_q ->> 'title', 200), left(p_answers ->> (v_q ->> 'id'), 1000));
      v_by_id := v_by_id || jsonb_build_object(v_q ->> 'id', left(p_answers ->> (v_q ->> 'id'), 1000));
      v_lines := v_lines || '• ' || left(v_q ->> 'title', 200) || E'\n  ' || left(p_answers ->> (v_q ->> 'id'), 1000) || E'\n';
    end if;
  end loop;

  -- sessão de rastreio (a mesma usada pelos links rastreáveis): leva UTM/fbclid/gclid para o contato
  v_ref := 'f-' || substr(replace(ss.id::text, '-', ''), 1, 10);
  insert into public.tracking_sessions (tenant_id, ref, source_url, request_url, ip, ua, fbc, fbp, fbclid, gclid, ttclid,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, clicked_at, customer_phone, customer_email, customer_name)
  values (f.tenant_id, v_ref, ss.referrer, ss.landing_url, ss.ip, ss.user_agent, ss.fbc, ss.fbp, ss.fbclid, ss.gclid, ss.ttclid,
    ss.utm_source, ss.utm_medium, ss.utm_campaign, ss.utm_content, ss.utm_term, ss.created_at, v_phone, v_email, v_name)
  on conflict (ref) do update set customer_phone = excluded.customer_phone
  returning id into v_ts;

  if v_phone is not null then
    v_contact := idx_private.crm_contact_for_phone(f.tenant_id, v_phone, v_name, v_email, 'formulario', 'declared', v_ts);
  else
    select id into v_contact from public.crm_contacts where tenant_id = f.tenant_id and lower(email) = v_email and merged_into_id is null limit 1;
    if v_contact is null then
      insert into public.crm_contacts (tenant_id, name, email, source_channel, acquisition_basis, acquisition_at, first_tracking_session_id,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, inbound_outbound)
      values (f.tenant_id, v_name, v_email, 'formulario', 'declared', ss.created_at, v_ts,
        ss.utm_source, ss.utm_medium, ss.utm_campaign, ss.utm_content, ss.utm_term, 'inbound')
      returning id into v_contact;
    end if;
  end if;
  if v_contact is null then raise exception 'Não foi possível registrar o contato'; end if;

  v_tags := array['formulário: ' || left(f.name, 60)] ||
            coalesce((select array_agg(left(x, 60)) from jsonb_array_elements_text(coalesce(f.settings -> 'tags', '[]'::jsonb)) x where trim(x) <> ''), '{}');
  update public.crm_contacts c set
    name = coalesce(nullif(c.name, ''), v_name),
    email = coalesce(c.email, v_email),
    tags = (select array_agg(distinct t) from unnest(coalesce(c.tags, '{}') || v_tags) t),
    custom = coalesce(c.custom, '{}'::jsonb) || jsonb_build_object('formulario_' || f.slug, v_answers),
    last_interaction_at = now(),
    updated_at = now()
  where c.id = v_contact
  returning owner_id into v_owner;

  -- negociação: usa a aberta se já existir; senão cria na etapa escolhida (ou na primeira em aberto do funil padrão)
  if (f.settings ->> 'stage_id') ~ '^[0-9a-f-]{36}$' then
    select * into v_stage from public.crm_stages where id = (f.settings ->> 'stage_id')::uuid and tenant_id = f.tenant_id and kind = 'open' and archived_at is null;
  end if;
  v_title := left(coalesce(nullif(f.settings ->> 'deal_title', ''), f.name) || ' · ' || coalesce(v_name, v_phone, v_email), 200);
  -- a sessão de rastreio acabou de gerar a negociação (regra "criar negociação a partir de cliques"):
  -- ela vai para a etapa escolhida no formulário e ganha um título que diz de onde veio
  select id into v_deal from public.crm_deals where tracking_session_id = v_ts and tenant_id = f.tenant_id;
  -- quem já tinha uma negociação aberta (respondeu de novo, ou já era lead) continua nela: sem negociação duplicada
  if v_deal is not null and exists (select 1 from public.crm_deals where tenant_id = f.tenant_id and contact_id = v_contact
                                       and status = 'open' and id <> v_deal) then
    delete from public.crm_deals where id = v_deal;
    v_deal := null;
  end if;
  if v_deal is not null then
    update public.crm_deals set title = v_title, contact_id = coalesce(contact_id, v_contact),
      stage_id = coalesce(v_stage.id, stage_id), pipeline_id = coalesce(v_stage.pipeline_id, pipeline_id)
     where id = v_deal;
  else
    select id into v_deal from public.crm_deals where tenant_id = f.tenant_id and contact_id = v_contact and status = 'open'
     order by created_at desc limit 1;
  end if;
  if v_deal is null and coalesce((f.settings ->> 'create_deal')::boolean, true) then
    if v_stage.id is null then
      select st.* into v_stage from public.crm_stages st
        join public.crm_pipelines p on p.id = st.pipeline_id and p.archived_at is null
       where st.tenant_id = f.tenant_id and st.kind = 'open' and st.archived_at is null
         and (p.id = (select default_pipeline_id from public.crm_settings where tenant_id = f.tenant_id) or not exists (
              select 1 from public.crm_settings cs where cs.tenant_id = f.tenant_id and cs.default_pipeline_id is not null))
       order by p.is_default desc, p.position, st.position limit 1;
    end if;
    if v_stage.id is not null then
      insert into public.crm_deals (tenant_id, pipeline_id, stage_id, contact_id, title, owner_id, source_channel,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, tracking_session_id,
        ad_ids)
      values (f.tenant_id, v_stage.pipeline_id, v_stage.id, v_contact, v_title,
              coalesce(case when (f.settings ->> 'owner_id') ~ '^[0-9a-f-]{36}$' then (f.settings ->> 'owner_id')::uuid end, v_owner),
              'formulario', ss.utm_source, ss.utm_medium, ss.utm_campaign, ss.utm_content, ss.utm_term, v_ts,
              jsonb_strip_nulls(jsonb_build_object('fbclid', ss.fbclid, 'gclid', ss.gclid, 'ttclid', ss.ttclid)))
      returning id into v_deal;
    end if;
  end if;

  insert into public.crm_timeline (tenant_id, contact_id, deal_id, kind, title, body, metadata)
  values (f.tenant_id, v_contact, v_deal, 'form', 'Respondeu o formulário “' || left(f.name, 100) || '”',
    nullif(v_lines, '') ||
      E'\nOrigem: ' || coalesce(nullif(concat_ws(' / ', ss.utm_source, ss.utm_medium, ss.utm_campaign), ''),
                               case when ss.fbclid is not null then 'Facebook/Instagram (fbclid)' when ss.gclid is not null then 'Google (gclid)' end,
                               nullif(ss.referrer, ''), 'acesso direto') ||
      E'\nAparelho: ' || coalesce(ss.device, '?'),
    jsonb_build_object('form_id', f.id, 'form_slug', f.slug, 'session_id', ss.id, 'answers', v_answers,
      'tracking', jsonb_strip_nulls(jsonb_build_object('utm_source', ss.utm_source, 'utm_medium', ss.utm_medium, 'utm_campaign', ss.utm_campaign,
        'utm_content', ss.utm_content, 'utm_term', ss.utm_term, 'fbclid', ss.fbclid, 'gclid', ss.gclid, 'referrer', ss.referrer,
        'landing_url', ss.landing_url, 'device', ss.device)),
      'seconds', extract(epoch from (now() - coalesce(ss.started_at, ss.created_at)))::int));

  insert into public.crm_notifications (tenant_id, user_id, title, body, severity, link_type, link_id)
  select f.tenant_id, u, left('📝 ' || coalesce(v_name, v_phone, v_email) || ' respondeu “' || f.name || '”', 200),
         'Formulário · ' || coalesce(v_phone, v_email), 'info', 'contact', v_contact
    from (select distinct u from unnest(array[
            case when (f.settings ->> 'owner_id') ~ '^[0-9a-f-]{36}$' then (f.settings ->> 'owner_id')::uuid end, v_owner, f.created_by]) u
          where u is not null) x;

  update public.crm_form_sessions set completed_at = now(), updated_at = now(), name = v_name, phone = v_phone, email = v_email,
    answers = answers || v_by_id, contact_id = v_contact, deal_id = v_deal, tracking_session_id = v_ts,
    events = events || jsonb_build_array(jsonb_build_object('t', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'e', 'submit')),
    event_count = event_count + 1
  where id = ss.id;

  return jsonb_build_object('ok', true, 'contact_id', v_contact, 'deal_id', v_deal);
end $$;

-- 8. Gestão (CRO) --------------------------------------------------------------------------------------------------
create or replace function public.form_save(p_tenant_id uuid, p_id uuid, p_name text, p_slug text, p_style text,
  p_content jsonb, p_settings jsonb)
returns public.crm_forms
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.crm_forms; v_slug text := lower(trim(p_slug));
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Sem permissão para editar formulários'; end if;
  if exists (select 1 from public.crm_forms where slug = v_slug and id is distinct from p_id) then
    raise exception 'Esse endereço já está em uso por outro formulário';
  end if;
  if p_id is null then
    insert into public.crm_forms (tenant_id, slug, name, style, content, settings, created_by)
    values (p_tenant_id, v_slug, trim(p_name), coalesce(p_style, 'card'), coalesce(p_content, '{}'), coalesce(p_settings, '{}'), auth.uid())
    returning * into r;
  else
    update public.crm_forms set slug = v_slug, name = trim(p_name), style = coalesce(p_style, style),
      content = coalesce(p_content, content), settings = coalesce(p_settings, settings), updated_at = now()
     where id = p_id and tenant_id = p_tenant_id returning * into r;
    if r.id is null then raise exception 'Formulário não encontrado'; end if;
  end if;
  return r;
end $$;

create or replace function public.form_set_status(p_id uuid, p_status text)
returns public.crm_forms
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.crm_forms;
begin
  select * into r from public.crm_forms where id = p_id;
  if r.id is null or not idx_private.crm_can(r.tenant_id, 'configure') then raise exception 'Formulário não encontrado'; end if;
  if p_status not in ('draft', 'published', 'archived') then raise exception 'Situação inválida'; end if;
  if p_status = 'published' and jsonb_array_length(coalesce(r.content -> 'questions', '[]'::jsonb)) = 0 then
    raise exception 'Adicione ao menos uma pergunta antes de publicar';
  end if;
  update public.crm_forms set status = p_status, updated_at = now(),
    published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end
   where id = p_id returning * into r;
  return r;
end $$;

-- números de cada formulário (visitas, começaram, enviaram) para a lista
create or replace function public.form_list(p_tenant_id uuid, p_days int default 30)
returns table (id uuid, slug text, name text, status text, style text, updated_at timestamptz,
               views bigint, starts bigint, leads bigint, last_lead_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select f.id, f.slug, f.name, f.status, f.style, f.updated_at,
         count(s.id), count(s.started_at), count(s.completed_at), max(s.completed_at)
    from public.crm_forms f
    left join public.crm_form_sessions s on s.form_id = f.id and s.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
   where f.tenant_id = p_tenant_id and idx_private.crm_can(p_tenant_id, 'read') and f.status <> 'archived'
   group by f.id
   order by f.updated_at desc
$$;

-- funil por pergunta: quantas visitas chegaram em cada passo
create or replace function public.form_funnel(p_form_id uuid, p_days int default 30)
returns table (step int, reached bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select st.step, count(s.id)
    from public.crm_forms f
    cross join lateral generate_series(0, jsonb_array_length(coalesce(f.content -> 'questions', '[]'::jsonb)) + 1) as st(step)
    left join public.crm_form_sessions s on s.form_id = f.id and s.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
         and (case when st.step = 0 then true else s.max_step >= st.step or s.completed_at is not null end)
   where f.id = p_form_id and idx_private.crm_can(f.tenant_id, 'read')
   group by st.step order by st.step
$$;

revoke all on function public.form_public(text) from public;
revoke all on function public.form_track(text, uuid, text, int, jsonb, jsonb) from public;
revoke all on function public.form_submit(text, uuid, jsonb, jsonb) from public;
revoke all on function public.form_save(uuid, uuid, text, text, text, jsonb, jsonb) from public, anon;
revoke all on function public.form_set_status(uuid, text) from public, anon;
revoke all on function public.form_list(uuid, int) from public, anon;
revoke all on function public.form_funnel(uuid, int) from public, anon;
grant execute on function public.form_public(text) to anon, authenticated;
grant execute on function public.form_track(text, uuid, text, int, jsonb, jsonb) to anon, authenticated;
grant execute on function public.form_submit(text, uuid, jsonb, jsonb) to anon, authenticated;
grant execute on function public.form_save(uuid, uuid, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.form_set_status(uuid, text) to authenticated;
grant execute on function public.form_list(uuid, int) to authenticated;
grant execute on function public.form_funnel(uuid, int) to authenticated;
