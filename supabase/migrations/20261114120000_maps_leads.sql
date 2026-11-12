-- =============================================================================
-- Busca automática de clientes no Google Maps (API oficial Google Places)
-- -----------------------------------------------------------------------------
-- * "Fontes" salvas: termo (ex.: farmácia) + lista de cidades/bairros. Cada
--   execução pega os próximos locais (rodízio), então todo dia entram clientes
--   NOVOS. Execução manual ("Buscar agora") ou automática (o motor do WhatsApp
--   chama a função maps-leads a cada 10 min; ela roda só as fontes vencidas).
-- * Resultado vai para o Discador (crm_dial_leads) com posição na busca, nota e
--   avaliações; não duplica (place_id ou telefone em qualquer lista), ignora quem
--   pediu SAIR e, opcionalmente, redes/franquias.
-- * Opcional: alimentar um disparo com "alimentação automática" — os novos
--   contatos entram na fila daquele disparo (que segue todas as proteções).
-- * Custo: limite de chamadas por mês (padrão 900, dentro da cota gratuita do
--   Text Search Enterprise) e por execução. Chave da API guardada criptografada
--   (a tela só sabe se existe; nunca lê a chave).
-- Não destrutiva.
-- =============================================================================

-- 1. Discador: dados do Google -------------------------------------------------
alter table public.crm_dial_leads add column if not exists place_id text;
alter table public.crm_dial_leads add column if not exists rating numeric(2,1);
alter table public.crm_dial_leads add column if not exists reviews integer;
alter table public.crm_dial_leads add column if not exists maps_rank integer;
alter table public.crm_dial_leads add column if not exists maps_query text;
alter table public.crm_dial_leads add column if not exists maps_url text;
alter table public.crm_dial_leads add column if not exists website text;
alter table public.crm_dial_leads add column if not exists address text;
alter table public.crm_dial_leads add column if not exists lead_source_id uuid;
create unique index if not exists crm_dial_leads_place_uq on public.crm_dial_leads(tenant_id, place_id) where place_id is not null;
create index if not exists idx_crm_dial_leads_phone_any on public.crm_dial_leads(tenant_id, phone);

-- 2. Disparo com alimentação automática ----------------------------------------
alter table public.wa_campaigns add column if not exists auto_feed boolean not null default false;

-- 3. Configuração e fontes ------------------------------------------------------
create table if not exists public.maps_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  api_key_enc text,                         -- criptografada pela função maps-leads (AES-GCM)
  key_hint text,                            -- últimos 4 caracteres, para a tela
  monthly_call_limit integer not null default 900 check (monthly_call_limit between 0 and 100000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.maps_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month text not null,                      -- 'YYYY-MM'
  calls integer not null default 0,
  primary key (tenant_id, month)
);

create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  query text not null,                      -- ex.: "farmácia"
  locations text[] not null default '{}',   -- ex.: {"Moema, São Paulo SP", "Campinas SP"}
  location_cursor integer not null default 0,
  list_name text not null,                  -- lista do discador de destino
  auto boolean not null default false,      -- roda sozinha
  interval_hours integer not null default 24 check (interval_hours between 1 and 720),
  run_hour integer not null default 7 check (run_hour between 0 and 23),
  locations_per_run integer not null default 5 check (locations_per_run between 1 and 50),
  pages_per_location integer not null default 3 check (pages_per_location between 1 and 3),
  max_new_per_run integer not null default 60 check (max_new_per_run between 1 and 1000),
  exclude_chains boolean not null default true,
  min_rating numeric(2,1),
  campaign_id uuid references public.wa_campaigns(id) on delete set null,
  active boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb,
  running_since timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_sources_due on public.lead_sources(next_run_at) where active and auto;

create table if not exists public.lead_source_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_id uuid not null references public.lead_sources(id) on delete cascade,
  trigger text not null check (trigger in ('manual', 'auto')),
  locations text[],
  api_calls integer not null default 0,
  found integer not null default 0,
  inserted integer not null default 0,
  duplicates integer not null default 0,
  no_phone integer not null default 0,
  chains integer not null default 0,
  low_rating integer not null default 0,
  opted_out integer not null default 0,
  to_campaign integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_lead_source_runs on public.lead_source_runs(source_id, started_at desc);

drop trigger if exists trg_lead_sources_updated on public.lead_sources;
create trigger trg_lead_sources_updated before update on public.lead_sources
for each row execute function idx_private.touch_updated_at();

alter table public.maps_settings enable row level security;   -- só pelas funções
alter table public.maps_usage enable row level security;
alter table public.lead_sources enable row level security;
alter table public.lead_source_runs enable row level security;
drop policy if exists maps_usage_read on public.maps_usage;
create policy maps_usage_read on public.maps_usage for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists lead_sources_read on public.lead_sources;
create policy lead_sources_read on public.lead_sources for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists lead_source_runs_read on public.lead_source_runs;
create policy lead_source_runs_read on public.lead_source_runs for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

-- 4. Regras ------------------------------------------------------------------
-- Redes e franquias (o foco é a farmácia independente; pode ser desligado por fonte)
create or replace function idx_private.maps_is_chain(p_name text)
returns boolean language sql immutable set search_path = pg_temp
as $$
  select coalesce(p_name, '') ~* '(drogasil|droga ?raia|\mraia\M|pague ?menos|drogaria s[aã]o paulo|pacheco|panvel|nissei|ultrafarma|drogarias? venancio|venancio|araujo|drogaria araujo|extrafarma|farm[aá]cias? app|drogal\M|drogaria globo|indiana|tamoio|farmais|big ben|farmagora|drogaleste|onofre|poupafarma|preco popular|pre[cç]o popular|farm[aá]cia do trabalhador|redepharma|santa marta|max ?popular|drogarias? moderna|farmelhor|carrefour|walmart|atacad[aã]o|assa[ií])';
$$;

-- Próxima ocorrência do horário escolhido (hoje, se ainda não passou; senão amanhã)
create or replace function idx_private.lead_source_first(p_tenant uuid, p_hour int)
returns timestamptz language sql stable set search_path = public, pg_temp
as $$
  select case when t > now() then t else t + interval '1 day' end
    from (select ((date_trunc('day', now() at time zone idx_private.crm_tenant_tz(p_tenant)) + make_interval(hours => p_hour))
                  at time zone idx_private.crm_tenant_tz(p_tenant)) as t) x;
$$;

-- Próxima execução: na próxima vez que der o horário escolhido (+ dias extras se o intervalo for maior que 1 dia);
-- intervalos menores que 24 h contam a partir de agora.
create or replace function idx_private.lead_source_next(p_tenant uuid, p_interval int, p_hour int)
returns timestamptz language sql stable set search_path = public, pg_temp
as $$
  select case when p_interval >= 24
              then idx_private.lead_source_first(p_tenant, p_hour) + make_interval(days => p_interval / 24 - 1)
              else now() + make_interval(hours => p_interval) end;
$$;

-- Grava os lugares encontrados. p_places: [{place_id,name,phone,address,city,uf,district,rating,reviews,rank,location,maps_url,website}]
create or replace function idx_private.maps_ingest(p_run uuid, p_places jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  run public.lead_source_runs;
  s public.lead_sources;
  c public.wa_campaigns;
  p jsonb;
  v_phone text;
  v_id uuid;
  v_ins int := 0; v_dup int := 0; v_nophone int := 0; v_chain int := 0; v_low int := 0; v_opt int := 0; v_camp int := 0;
  v_found int := 0;
begin
  select * into run from public.lead_source_runs where id = p_run;
  select * into s from public.lead_sources where id = run.source_id;
  if s.id is null then raise exception 'Fonte não encontrada'; end if;
  if s.campaign_id is not null then
    select * into c from public.wa_campaigns where id = s.campaign_id and status in ('draft', 'running', 'paused') and auto_feed;
  end if;

  for p in select * from jsonb_array_elements(coalesce(p_places, '[]'::jsonb)) loop
    v_found := v_found + 1;
    if v_ins >= s.max_new_per_run then exit; end if;
    v_phone := idx_private.normalize_phone(p->>'phone');
    if v_phone is null then v_nophone := v_nophone + 1; continue; end if;
    if s.exclude_chains and idx_private.maps_is_chain(p->>'name') then v_chain := v_chain + 1; continue; end if;
    if s.min_rating is not null and coalesce((p->>'rating')::numeric, 0) < s.min_rating then v_low := v_low + 1; continue; end if;
    if exists (select 1 from public.wa_optouts where tenant_id = s.tenant_id and phone = v_phone) then v_opt := v_opt + 1; continue; end if;
    if exists (select 1 from public.crm_dial_leads d where d.tenant_id = s.tenant_id
                and (d.phone = v_phone or (p->>'place_id' is not null and d.place_id = p->>'place_id'))) then
      v_dup := v_dup + 1; continue;
    end if;

    insert into public.crm_dial_leads (tenant_id, list_name, name, phone, city, uf, district, source, place_id, rating, reviews,
                                       maps_rank, maps_query, maps_url, website, address, lead_source_id)
    values (s.tenant_id, s.list_name, left(coalesce(nullif(p->>'name', ''), 'Sem nome'), 200), v_phone,
            nullif(p->>'city', ''), nullif(upper(p->>'uf'), ''),
            left(concat_ws(' · ',
                 case when (p->>'rank') is not null then '📍 Nº ' || (p->>'rank') || ' no Google' end,
                 case when (p->>'rating') is not null then '⭐ ' || to_char((p->>'rating')::numeric, 'FM0.0') || coalesce(' (' || (p->>'reviews') || ')', '') end,
                 nullif(p->>'address', '')), 400),
            'google_places', nullif(p->>'place_id', ''), (p->>'rating')::numeric, (p->>'reviews')::int,
            (p->>'rank')::int, left(s.query || ' · ' || coalesce(p->>'location', ''), 200),
            nullif(p->>'maps_url', ''), nullif(p->>'website', ''), nullif(p->>'address', ''), s.id)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then v_dup := v_dup + 1; continue; end if;
    v_ins := v_ins + 1;

    if c.id is not null then
      insert into public.wa_campaign_recipients (tenant_id, campaign_id, phone, name, vars, dial_lead_id, status)
      values (s.tenant_id, c.id, v_phone, left(p->>'name', 200),
              jsonb_strip_nulls(jsonb_build_object('empresa', p->>'name', 'cidade', p->>'city', 'uf', p->>'uf',
                                                   'bairro', p->>'district', 'nota', replace(to_char((p->>'rating')::numeric, 'FM0.0'), '.', ','),
                                                   'avaliacoes', p->>'reviews', 'posicao', p->>'rank')),
              v_id, 'pending')
      on conflict (campaign_id, phone) do nothing;
      if found then v_camp := v_camp + 1; end if;
    end if;
  end loop;

  update public.lead_source_runs lr
     set found = lr.found + v_found, inserted = lr.inserted + v_ins, duplicates = lr.duplicates + v_dup,
         no_phone = lr.no_phone + v_nophone, chains = lr.chains + v_chain, low_rating = lr.low_rating + v_low,
         opted_out = lr.opted_out + v_opt, to_campaign = lr.to_campaign + v_camp
   where lr.id = p_run;
  -- disparo automático parado por falta de contatos volta a enviar sozinho
  if v_camp > 0 then
    update public.wa_campaigns set next_send_at = least(coalesce(next_send_at, now()), now() + interval '1 minute')
     where id = c.id and status = 'running';
  end if;
  return jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'to_campaign', v_camp);
end $$;
revoke all on function idx_private.maps_ingest(uuid, jsonb) from public;
grant execute on function idx_private.maps_ingest(uuid, jsonb) to service_role;

create or replace function public.maps_ingest(p_run uuid, p_places jsonb)
returns jsonb language sql security definer set search_path = public, pg_temp
as $$ select idx_private.maps_ingest(p_run, p_places) $$;
revoke all on function public.maps_ingest(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.maps_ingest(uuid, jsonb) to service_role;

-- Disparo com alimentação automática não "termina" quando a fila zera: espera novos contatos
create or replace function idx_private.wa_campaign_maybe_finish(p_campaign uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_campaigns set status = 'completed', completed_at = now(), next_send_at = null
   where id = p_campaign and status = 'running' and not auto_feed
     and not exists (select 1 from public.wa_campaign_recipients where campaign_id = p_campaign and status in ('pending', 'queued'));
$$;

-- Disparo com alimentação automática pode começar vazio (espera os clientes da busca)
create or replace function public.wa_campaign_action(p_campaign_id uuid, p_action text)
returns public.wa_campaigns
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.wa_campaigns; v_pending int; v_inst public.whatsapp_instances;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id for update;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;

  if p_action in ('start', 'resume') then
    if c.status not in ('draft', 'paused') then raise exception 'Este disparo não pode ser iniciado agora'; end if;
    select count(*) into v_pending from public.wa_campaign_recipients where campaign_id = c.id and status = 'pending';
    if v_pending = 0 and not c.auto_feed then raise exception 'Adicione contatos ao público antes de iniciar (ou ligue a alimentação automática pela busca do Google Maps)'; end if;
    if c.instance_id is null then
      select id into c.instance_id from public.whatsapp_instances
       where tenant_id = c.tenant_id and provider = 'gateway' order by created_at limit 1;
    end if;
    select * into v_inst from public.whatsapp_instances where id = c.instance_id;
    if v_inst.id is null then raise exception 'Conecte o WhatsApp antes de iniciar'; end if;
    update public.wa_campaigns
       set status = 'running', instance_id = c.instance_id, next_send_at = now(), paused_reason = null,
           started_at = coalesce(started_at, now()), started_by = coalesce(started_by, auth.uid()), completed_at = null
     where id = c.id returning * into c;
  elsif p_action = 'pause' then
    if c.status <> 'running' then raise exception 'O disparo não está em andamento'; end if;
    update public.wa_campaigns set status = 'paused', paused_reason = 'Pausado manualmente' where id = c.id returning * into c;
  elsif p_action = 'cancel' then
    if c.status in ('completed', 'canceled') then raise exception 'O disparo já terminou'; end if;
    update public.wa_campaigns set status = 'canceled', completed_at = now() where id = c.id returning * into c;
    update public.wa_campaign_recipients set status = 'skipped', error = 'Disparo cancelado'
     where campaign_id = c.id and status = 'pending';
  elsif p_action = 'archive' then
    if c.status in ('running') then raise exception 'Pause ou cancele antes de excluir'; end if;
    if exists (select 1 from public.wa_campaign_recipients where campaign_id = c.id and status = 'sent') then
      raise exception 'Disparos que já enviaram mensagens ficam no histórico';
    end if;
    delete from public.wa_campaigns where id = c.id;
    return c;
  else
    raise exception 'Ação inválida';
  end if;
  return c;
end $$;


drop function if exists public.wa_campaign_list(uuid);
-- Lista com contadores calculados (sem contadores que possam ficar errados)
create or replace function public.wa_campaign_list(p_tenant_id uuid)
returns table (
  id uuid, name text, status text, messages text[], min_delay_sec int, max_delay_sec int, daily_limit int,
  start_hour int, end_hour int, opt_out_footer boolean, auto_feed boolean, next_send_at timestamptz, paused_reason text,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz, audience jsonb,
  total bigint, pending bigint, sent bigint, failed bigint, invalid bigint, opted_out bigint, skipped bigint, replied bigint,
  sent_today int)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  return query
  select c.id, c.name, c.status, c.messages, c.min_delay_sec, c.max_delay_sec, c.daily_limit,
         c.start_hour, c.end_hour, c.opt_out_footer, c.auto_feed, c.next_send_at, c.paused_reason,
         c.started_at, c.completed_at, c.created_at, c.audience,
         count(r.id), count(r.id) filter (where r.status in ('pending', 'queued')),
         count(r.id) filter (where r.status = 'sent'), count(r.id) filter (where r.status = 'failed'),
         count(r.id) filter (where r.status = 'invalid'), count(r.id) filter (where r.status = 'opted_out'),
         count(r.id) filter (where r.status = 'skipped'), count(r.id) filter (where r.replied_at is not null),
         case when c.instance_id is null then 0
              else idx_private.wa_sent_today(c.instance_id, idx_private.crm_tenant_tz(c.tenant_id)) end
    from public.wa_campaigns c
    left join public.wa_campaign_recipients r on r.campaign_id = c.id
   where c.tenant_id = p_tenant_id
   group by c.id
   order by c.created_at desc;
end $$;

grant execute on function public.wa_campaign_list(uuid) to authenticated;

-- 5. Funções da tela -----------------------------------------------------------
create or replace function public.maps_status(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s public.maps_settings; v_month text := to_char(now(), 'YYYY-MM');
begin
  if not idx_private.crm_can(p_tenant_id, 'read') then raise exception 'Sem permissão'; end if;
  select * into s from public.maps_settings where tenant_id = p_tenant_id;
  return jsonb_build_object(
    'has_key', s.api_key_enc is not null,
    'key_hint', s.key_hint,
    'monthly_call_limit', coalesce(s.monthly_call_limit, 900),
    'calls_this_month', coalesce((select calls from public.maps_usage where tenant_id = p_tenant_id and month = v_month), 0));
end $$;

create or replace function public.maps_set_limit(p_tenant_id uuid, p_limit int)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant_id, 'configure') then raise exception 'Somente gestores'; end if;
  insert into public.maps_settings (tenant_id, monthly_call_limit, updated_by) values (p_tenant_id, p_limit, auth.uid())
  on conflict (tenant_id) do update set monthly_call_limit = excluded.monthly_call_limit, updated_by = auth.uid(), updated_at = now();
end $$;

create or replace function public.lead_source_save(
  p_tenant_id uuid, p_id uuid, p_name text, p_query text, p_locations text[], p_list_name text,
  p_auto boolean default false, p_interval_hours int default 24, p_run_hour int default 7,
  p_locations_per_run int default 5, p_max_new_per_run int default 60, p_exclude_chains boolean default true,
  p_min_rating numeric default null, p_campaign_id uuid default null, p_pages_per_location int default 3)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid := p_id; v_locs text[];
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if coalesce(trim(p_query), '') = '' then raise exception 'Diga o que buscar (ex.: farmácia)'; end if;
  -- mantém a ordem digitada (o rodízio segue essa ordem), sem repetidos
  select coalesce(array_agg(l order by o), '{}') into v_locs
    from (select distinct on (lower(trim(x))) trim(x) as l, o
            from unnest(coalesce(p_locations, '{}')) with ordinality as t(x, o)
           where trim(x) <> '' order by lower(trim(x)), o) d;
  if cardinality(v_locs) = 0 then raise exception 'Informe pelo menos uma cidade ou bairro'; end if;
  if cardinality(v_locs) > 500 then raise exception 'Use no máximo 500 locais'; end if;
  if coalesce(trim(p_list_name), '') = '' then raise exception 'Escolha a lista do discador'; end if;
  if p_campaign_id is not null and not exists (select 1 from public.wa_campaigns where id = p_campaign_id and tenant_id = p_tenant_id) then
    raise exception 'Disparo inválido';
  end if;
  if v_id is null then
    insert into public.lead_sources (tenant_id, name, query, locations, list_name, auto, interval_hours, run_hour, locations_per_run,
                                     max_new_per_run, exclude_chains, min_rating, campaign_id, pages_per_location, created_by, next_run_at)
    values (p_tenant_id, coalesce(nullif(trim(p_name), ''), trim(p_query)), trim(p_query), v_locs, trim(p_list_name), p_auto,
            p_interval_hours, p_run_hour, p_locations_per_run, p_max_new_per_run, p_exclude_chains, p_min_rating, p_campaign_id,
            p_pages_per_location, auth.uid(),
            case when p_auto then idx_private.lead_source_first(p_tenant_id, p_run_hour) end)
    returning id into v_id;
  else
    update public.lead_sources
       set name = coalesce(nullif(trim(p_name), ''), trim(p_query)), query = trim(p_query), locations = v_locs,
           location_cursor = case when locations = v_locs then location_cursor else 0 end,
           list_name = trim(p_list_name), auto = p_auto, interval_hours = p_interval_hours, run_hour = p_run_hour,
           locations_per_run = p_locations_per_run, max_new_per_run = p_max_new_per_run, exclude_chains = p_exclude_chains,
           min_rating = p_min_rating, campaign_id = p_campaign_id, pages_per_location = p_pages_per_location,
           next_run_at = case when not p_auto then null
                              when next_run_at is null or run_hour <> p_run_hour then idx_private.lead_source_first(p_tenant_id, p_run_hour)
                              else next_run_at end
     where id = v_id and tenant_id = p_tenant_id;
    if not found then raise exception 'Fonte não encontrada'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.lead_source_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.lead_sources where id = p_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Sem permissão'; end if;
  delete from public.lead_sources where id = p_id;   -- os contatos já trazidos continuam no discador
end $$;

create or replace function public.wa_campaign_set_auto_feed(p_campaign_id uuid, p_auto boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.wa_campaigns where id = p_campaign_id;
  if v_tenant is null or not idx_private.crm_can(v_tenant, 'write') then raise exception 'Sem permissão'; end if;
  update public.wa_campaigns set auto_feed = p_auto where id = p_campaign_id;
  if not p_auto then perform idx_private.wa_campaign_maybe_finish(p_campaign_id); end if;
end $$;

-- 6. Funções usadas pela função maps-leads (service role) ------------------------
-- Trava a fonte, escolhe os próximos locais (rodízio) e abre o registro da execução
create or replace function public.maps_begin_run(p_source uuid, p_trigger text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s public.lead_sources; v_locs text[]; n int; i int; v_run uuid; v_month text := to_char(now(), 'YYYY-MM');
        v_limit int; v_used int; v_budget int;
begin
  select * into s from public.lead_sources where id = p_source for update;
  if s.id is null then raise exception 'Fonte não encontrada'; end if;
  if s.running_since is not null and s.running_since > now() - interval '10 minutes' then
    raise exception 'Esta busca já está rodando';
  end if;
  select coalesce(monthly_call_limit, 900) into v_limit from public.maps_settings where tenant_id = s.tenant_id;
  v_limit := coalesce(v_limit, 900);
  select coalesce(calls, 0) into v_used from public.maps_usage where tenant_id = s.tenant_id and month = v_month;
  v_used := coalesce(v_used, 0);
  v_budget := v_limit - v_used;
  if v_budget <= 0 then raise exception 'Limite mensal de buscas atingido (% de %). Aumente em Configurações ou aguarde o próximo mês.', v_used, v_limit; end if;

  n := cardinality(s.locations);
  v_locs := '{}';
  for i in 0 .. least(s.locations_per_run, n) - 1 loop
    v_locs := v_locs || s.locations[1 + ((s.location_cursor + i) % n)];
  end loop;
  update public.lead_sources
     set running_since = now(), location_cursor = (location_cursor + cardinality(v_locs)) % greatest(n, 1)
   where id = s.id;
  insert into public.lead_source_runs (tenant_id, source_id, trigger, locations)
  values (s.tenant_id, s.id, p_trigger, v_locs) returning id into v_run;
  return jsonb_build_object('run_id', v_run, 'tenant_id', s.tenant_id, 'query', s.query, 'locations', v_locs,
                            'pages', s.pages_per_location, 'budget', v_budget, 'max_new', s.max_new_per_run);
end $$;

create or replace function public.maps_count_call(p_tenant uuid, p_run uuid)
returns integer language sql security definer set search_path = public, pg_temp
as $$
  with u as (
    insert into public.maps_usage (tenant_id, month, calls) values (p_tenant, to_char(now(), 'YYYY-MM'), 1)
    on conflict (tenant_id, month) do update set calls = public.maps_usage.calls + 1
    returning calls)
  update public.lead_source_runs set api_calls = api_calls + 1 where id = p_run
  returning (select calls from u);
$$;

create or replace function public.maps_end_run(p_run uuid, p_error text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.lead_source_runs; s public.lead_sources;
begin
  update public.lead_source_runs set finished_at = now(), error = left(p_error, 500) where id = p_run returning * into r;
  update public.lead_sources
     set running_since = null, last_run_at = now(),
         last_result = jsonb_build_object('inserted', r.inserted, 'found', r.found, 'duplicates', r.duplicates,
                                          'to_campaign', r.to_campaign, 'error', r.error, 'api_calls', r.api_calls),
         next_run_at = case when auto then idx_private.lead_source_next(tenant_id, interval_hours, run_hour) else null end
   where id = r.source_id returning * into s;
  -- avisa quem criou a fonte
  if s.created_by is not null and (r.inserted > 0 or r.error is not null) then
    insert into public.crm_notifications (tenant_id, user_id, title, body, severity, dedup_key)
    values (s.tenant_id, s.created_by,
            case when r.error is not null then 'Busca no Google Maps falhou: ' || s.name
                 else r.inserted || ' novo(s) cliente(s) do Google Maps' end,
            case when r.error is not null then left(r.error, 200)
                 else s.name || ' → lista “' || s.list_name || '”' ||
                      case when r.to_campaign > 0 then ' e ' || r.to_campaign || ' no disparo' else '' end end,
            case when r.error is not null then 'warning' else 'info' end, 'maps-run-' || r.id)
    on conflict do nothing;
  end if;
  return jsonb_build_object('run_id', r.id, 'inserted', r.inserted, 'found', r.found, 'duplicates', r.duplicates,
    'no_phone', r.no_phone, 'chains', r.chains, 'low_rating', r.low_rating, 'opted_out', r.opted_out,
    'to_campaign', r.to_campaign, 'api_calls', r.api_calls, 'error', r.error);
end $$;

create or replace function public.maps_due_sources(p_limit int default 5)
returns setof uuid language sql security definer set search_path = public, pg_temp
as $$
  select id from public.lead_sources
   where active and auto and next_run_at is not null and next_run_at <= now()
     and (running_since is null or running_since < now() - interval '10 minutes')
   order by next_run_at limit p_limit;
$$;

create or replace function public.maps_store_key(p_tenant uuid, p_enc text, p_hint text, p_user uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into public.maps_settings (tenant_id, api_key_enc, key_hint, updated_by) values (p_tenant, p_enc, p_hint, p_user)
  on conflict (tenant_id) do update set api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint,
                                        updated_by = excluded.updated_by, updated_at = now();
$$;
create or replace function public.maps_get_key(p_tenant uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$ select api_key_enc from public.maps_settings where tenant_id = p_tenant $$;

create or replace function public.maps_budget(p_tenant uuid)
returns integer language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select monthly_call_limit from public.maps_settings where tenant_id = p_tenant), 900)
       - coalesce((select calls from public.maps_usage where tenant_id = p_tenant and month = to_char(now(), 'YYYY-MM')), 0);
$$;

create or replace function public.crm_normalize_phones(p_phones text[])
returns table (raw text, e164 text) language sql immutable set search_path = pg_temp
as $$ select x, idx_private.normalize_phone(x) from unnest(coalesce(p_phones, '{}')) x $$;

-- 7. Permissões --------------------------------------------------------------
grant execute on function public.maps_status(uuid) to authenticated;
grant execute on function public.maps_set_limit(uuid, int) to authenticated;
grant execute on function public.lead_source_save(uuid, uuid, text, text, text[], text, boolean, int, int, int, int, boolean, numeric, uuid, int) to authenticated;
grant execute on function public.lead_source_delete(uuid) to authenticated;
grant execute on function public.wa_campaign_set_auto_feed(uuid, boolean) to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.maps_begin_run(uuid, text)', 'public.maps_count_call(uuid, uuid)', 'public.maps_end_run(uuid, text)',
    'public.maps_due_sources(int)', 'public.maps_store_key(uuid, text, text, uuid)', 'public.maps_get_key(uuid)',
    'public.maps_budget(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
grant execute on function public.crm_normalize_phones(text[]) to authenticated, service_role;
