-- Disparos de e-mail (aba Disparos): só e-mail, ou junto com um disparo de WhatsApp.
-- O e-mail é uma mensagem única explicando a oferta — sem automação/follow-up.
-- Envio pelo Resend (função email-dispatch), com limite por minuto e por dia, e link
-- "não quero mais receber" em todo e-mail (lista de descadastro por empresa).

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  wa_campaign_id uuid references public.wa_campaigns(id) on delete set null,   -- disparo de WhatsApp junto
  name text not null check (length(trim(name)) between 1 and 120),
  subject text not null default '' check (length(subject) <= 200),
  body text not null default '' check (length(body) <= 20000),
  reply_to text check (reply_to is null or reply_to ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  button_label text check (button_label is null or length(button_label) <= 60),
  button_url text check (button_url is null or button_url ~* '^https://'),
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed', 'canceled')),
  per_minute integer not null default 20 check (per_minute between 1 and 120),
  daily_limit integer not null default 500 check (daily_limit between 1 and 5000),
  paused_reason text,
  created_by uuid references auth.users(id) on delete set null,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_email_campaigns_tenant on public.email_campaigns(tenant_id, created_at desc);
create index if not exists idx_email_campaigns_running on public.email_campaigns(status) where status = 'running';
create index if not exists idx_email_campaigns_wa on public.email_campaigns(wa_campaign_id) where wa_campaign_id is not null;

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),   -- também é o código do link de descadastro
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  email text not null,
  name text,
  vars jsonb not null default '{}'::jsonb,
  crm_contact_id uuid references public.crm_contacts(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'invalid', 'opted_out')),
  provider_id text,
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, email)
);
create index if not exists idx_email_recipients_queue on public.email_campaign_recipients(campaign_id, status, created_at);
create index if not exists idx_email_recipients_sent on public.email_campaign_recipients(campaign_id, sent_at) where status = 'sent';

create table if not exists public.email_optouts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  source text not null default 'link' check (source in ('link', 'manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, email)
);

drop trigger if exists trg_email_campaigns_updated on public.email_campaigns;
create trigger trg_email_campaigns_updated before update on public.email_campaigns
for each row execute function idx_private.touch_updated_at();

alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_optouts enable row level security;
drop policy if exists email_campaigns_read on public.email_campaigns;
create policy email_campaigns_read on public.email_campaigns for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists email_recipients_read on public.email_campaign_recipients;
create policy email_recipients_read on public.email_campaign_recipients for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));
drop policy if exists email_optouts_read on public.email_optouts;
create policy email_optouts_read on public.email_optouts for select to authenticated using (idx_private.crm_can(tenant_id, 'read'));

-- e-mail válido e normalizado (minúsculas, sem espaços); null se inválido
create or replace function idx_private.email_norm(p text)
returns text language sql immutable set search_path = pg_temp
as $$
  select case when lower(trim(coalesce(p, ''))) ~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
              then lower(trim(p)) end;
$$;

-- Criar / editar --------------------------------------------------------------
create or replace function public.email_campaign_save(
  p_tenant_id uuid, p_id uuid, p_name text, p_subject text, p_body text, p_reply_to text default null,
  p_button_label text default null, p_button_url text default null, p_per_minute int default 20,
  p_daily_limit int default 500, p_wa_campaign_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; c public.email_campaigns;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'Escreva o assunto do e-mail'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Escreva o texto do e-mail'; end if;
  if nullif(trim(coalesce(p_reply_to, '')), '') is not null and idx_private.email_norm(p_reply_to) is null then
    raise exception 'E-mail para respostas inválido';
  end if;
  if nullif(trim(coalesce(p_button_url, '')), '') is not null and trim(p_button_url) !~* '^https://' then
    raise exception 'O link do botão precisa começar com https://';
  end if;
  if p_wa_campaign_id is not null and not exists (
    select 1 from public.wa_campaigns w where w.id = p_wa_campaign_id and w.tenant_id = p_tenant_id) then
    raise exception 'Disparo de WhatsApp não encontrado';
  end if;
  if p_id is null then
    insert into public.email_campaigns (tenant_id, wa_campaign_id, name, subject, body, reply_to, button_label, button_url,
                                        per_minute, daily_limit, created_by)
    values (p_tenant_id, p_wa_campaign_id, left(trim(p_name), 120), left(trim(p_subject), 200), left(p_body, 20000),
            idx_private.email_norm(p_reply_to), nullif(left(trim(coalesce(p_button_label, '')), 60), ''),
            nullif(trim(coalesce(p_button_url, '')), ''), greatest(1, least(120, coalesce(p_per_minute, 20))),
            greatest(1, least(5000, coalesce(p_daily_limit, 500))), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  select * into c from public.email_campaigns where id = p_id and tenant_id = p_tenant_id;
  if c.id is null then raise exception 'Disparo não encontrado'; end if;
  if c.status not in ('draft', 'paused') then raise exception 'Pause o disparo antes de editar'; end if;
  update public.email_campaigns
     set name = left(trim(p_name), 120), subject = left(trim(p_subject), 200), body = left(p_body, 20000),
         reply_to = idx_private.email_norm(p_reply_to), button_label = nullif(left(trim(coalesce(p_button_label, '')), 60), ''),
         button_url = nullif(trim(coalesce(p_button_url, '')), ''),
         per_minute = greatest(1, least(120, coalesce(p_per_minute, 20))),
         daily_limit = greatest(1, least(5000, coalesce(p_daily_limit, 500))),
         wa_campaign_id = coalesce(p_wa_campaign_id, wa_campaign_id)
   where id = c.id;
  return c.id;
end $$;

-- Público ---------------------------------------------------------------------
-- p_source: 'rows' (colados/CSV: email, nome, empresa, cidade...), 'contacts' (ids do CRM),
--           'wa_campaign' (mesmos contatos do disparo de WhatsApp ligado, quando têm e-mail)
create or replace function public.email_campaign_add_recipients(
  p_campaign_id uuid, p_source text, p_contact_ids uuid[] default null, p_rows jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.email_campaigns;
  v_before int; v_after int; v_candidates int := 0; v_invalid int := 0; v_optout int := 0;
begin
  select * into c from public.email_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if c.status not in ('draft', 'paused', 'running') then raise exception 'Este disparo já terminou'; end if;
  select count(*) into v_before from public.email_campaign_recipients where campaign_id = c.id;

  create temporary table if not exists _em_new (raw text, email text, name text, vars jsonb, contact_id uuid) on commit drop;
  truncate _em_new;

  if p_source = 'rows' then
    insert into _em_new
    select x->>'email', idx_private.email_norm(coalesce(x->>'email', x->>'e-mail', x->>'mail')),
           nullif(trim(coalesce(x->>'nome', x->>'name', '')), ''),
           jsonb_strip_nulls(x - 'email' - 'e-mail' - 'mail'), null
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
     limit 20000;
  elsif p_source = 'contacts' then
    insert into _em_new
    select ct.email, idx_private.email_norm(ct.email), ct.name,
           jsonb_strip_nulls(jsonb_build_object('empresa', co.name, 'cidade', ct.city)), ct.id
      from public.crm_contacts ct left join public.crm_companies co on co.id = ct.company_id
     where ct.tenant_id = c.tenant_id and ct.id = any(coalesce(p_contact_ids, '{}')) and ct.merged_into_id is null;
  elsif p_source = 'wa_campaign' then
    if c.wa_campaign_id is null then raise exception 'Este e-mail não está ligado a um disparo de WhatsApp'; end if;
    insert into _em_new
    select coalesce(ct.email, r.vars->>'email'), idx_private.email_norm(coalesce(ct.email, r.vars->>'email', r.vars->>'e-mail')),
           coalesce(r.name, ct.name), coalesce(r.vars, '{}'::jsonb) - 'email' - 'e-mail', r.crm_contact_id
      from public.wa_campaign_recipients r
      left join public.crm_contacts ct on ct.id = r.crm_contact_id
     where r.campaign_id = c.wa_campaign_id and r.tenant_id = c.tenant_id;
  else
    raise exception 'Origem inválida';
  end if;

  select count(*) filter (where email is not null), count(*) filter (where email is null and coalesce(trim(raw), '') <> '')
    into v_candidates, v_invalid from _em_new;
  -- liga ao contato do CRM com o mesmo e-mail (histórico no contato)
  update _em_new n set contact_id = (
    select ct.id from public.crm_contacts ct
     where ct.tenant_id = c.tenant_id and lower(ct.email) = n.email and ct.merged_into_id is null
     order by ct.created_at limit 1)
   where n.contact_id is null and n.email is not null;
  update _em_new n set name = ct.name from public.crm_contacts ct
   where n.name is null and ct.id = n.contact_id and ct.name is not null;
  select count(*) into v_optout from _em_new n
   where n.email is not null and exists (select 1 from public.email_optouts o where o.tenant_id = c.tenant_id and o.email = n.email);

  insert into public.email_campaign_recipients (tenant_id, campaign_id, email, name, vars, crm_contact_id, status)
  select distinct on (n.email) c.tenant_id, c.id, n.email, n.name, coalesce(n.vars, '{}'::jsonb), n.contact_id,
         case when exists (select 1 from public.email_optouts o where o.tenant_id = c.tenant_id and o.email = n.email)
              then 'opted_out' else 'pending' end
    from _em_new n where n.email is not null
  on conflict (campaign_id, email) do nothing;

  select count(*) into v_after from public.email_campaign_recipients where campaign_id = c.id;
  return jsonb_build_object('added', v_after - v_before, 'total', v_after,
    'duplicates', greatest(0, v_candidates - (v_after - v_before)), 'invalid_email', v_invalid, 'opted_out', v_optout);
end $$;

create or replace function public.email_campaign_clear_recipients(p_campaign_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.email_campaigns; n int;
begin
  select * into c from public.email_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if c.status not in ('draft', 'paused') then raise exception 'Pause o disparo antes de mudar o público'; end if;
  delete from public.email_campaign_recipients where campaign_id = c.id and status in ('pending', 'opted_out');
  get diagnostics n = row_count;
  return n;
end $$;

-- Iniciar / pausar / retomar / cancelar / excluir rascunho ---------------------
create or replace function public.email_campaign_action(p_campaign_id uuid, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c public.email_campaigns;
begin
  select * into c from public.email_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if p_action = 'start' then
    if c.status <> 'draft' then raise exception 'Este disparo já foi iniciado'; end if;
    if not exists (select 1 from public.email_campaign_recipients where campaign_id = c.id and status = 'pending') then
      raise exception 'Adicione quem vai receber antes de iniciar';
    end if;
    update public.email_campaigns set status = 'running', started_at = now(), started_by = auth.uid(), paused_reason = null where id = c.id;
  elsif p_action = 'pause' then
    if c.status <> 'running' then raise exception 'O disparo não está rodando'; end if;
    update public.email_campaigns set status = 'paused', paused_reason = 'Pausado manualmente' where id = c.id;
  elsif p_action = 'resume' then
    if c.status <> 'paused' then raise exception 'O disparo não está pausado'; end if;
    update public.email_campaigns set status = 'running', paused_reason = null where id = c.id;
  elsif p_action = 'cancel' then
    if c.status not in ('running', 'paused') then raise exception 'Só dá para cancelar um disparo em andamento'; end if;
    update public.email_campaigns set status = 'canceled', completed_at = now() where id = c.id;
  elsif p_action = 'archive' then
    if c.status <> 'draft' then raise exception 'Só rascunhos podem ser excluídos'; end if;
    delete from public.email_campaigns where id = c.id;
  else
    raise exception 'Ação inválida';
  end if;
  return p_action;
end $$;

create or replace function public.email_campaign_list(p_tenant_id uuid)
returns table (
  id uuid, wa_campaign_id uuid, name text, subject text, body text, reply_to text, button_label text, button_url text,
  status text, per_minute int, daily_limit int, paused_reason text, created_at timestamptz, started_at timestamptz,
  completed_at timestamptz, total int, pending int, sent int, failed int, invalid int, opted_out int)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.wa_campaign_id, c.name, c.subject, c.body, c.reply_to, c.button_label, c.button_url, c.status,
         c.per_minute, c.daily_limit, c.paused_reason, c.created_at, c.started_at, c.completed_at,
         coalesce(s.total, 0), coalesce(s.pending, 0), coalesce(s.sent, 0), coalesce(s.failed, 0), coalesce(s.invalid, 0), coalesce(s.opted_out, 0)
    from public.email_campaigns c
    left join lateral (
      select count(*)::int total,
             count(*) filter (where r.status in ('pending', 'sending'))::int pending,
             count(*) filter (where r.status = 'sent')::int sent,
             count(*) filter (where r.status = 'failed')::int failed,
             count(*) filter (where r.status = 'invalid')::int invalid,
             count(*) filter (where r.status = 'opted_out')::int opted_out
        from public.email_campaign_recipients r where r.campaign_id = c.id) s on true
   where c.tenant_id = p_tenant_id and idx_private.crm_can(p_tenant_id, 'read')
   order by c.created_at desc;
$$;

create or replace function public.email_optout_set(p_tenant_id uuid, p_email text, p_optout boolean)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v text := idx_private.email_norm(p_email);
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then raise exception 'Sem permissão'; end if;
  if v is null then raise exception 'E-mail inválido'; end if;
  if p_optout then
    insert into public.email_optouts (tenant_id, email, source) values (p_tenant_id, v, 'manual') on conflict do nothing;
    update public.email_campaign_recipients set status = 'opted_out' where tenant_id = p_tenant_id and email = v and status = 'pending';
  else
    delete from public.email_optouts where tenant_id = p_tenant_id and email = v;
  end if;
  return p_optout;
end $$;

-- Motor de envio (só a função email-dispatch, com a chave de serviço) ------------
create or replace function public.email_claim(p_limit int default 50)
returns table (id uuid, tenant_id uuid, tenant_name text, campaign_id uuid, email text, subject text, body text,
               reply_to text, button_label text, button_url text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c record; v_room int; v_left int := greatest(1, least(200, coalesce(p_limit, 50)));
begin
  -- envios presos (função caiu no meio) voltam para a fila
  update public.email_campaign_recipients r set status = 'pending', claimed_at = null
   where r.status = 'sending' and r.claimed_at < now() - interval '10 minutes';

  for c in select * from public.email_campaigns ec where ec.status = 'running' order by ec.started_at for update skip locked loop
    exit when v_left <= 0;
    select least(
             c.per_minute - (select count(*) from public.email_campaign_recipients x
                              where x.campaign_id = c.id and ((x.status = 'sent' and x.sent_at > now() - interval '1 minute')
                                                              or x.status = 'sending')),
             c.daily_limit - (select count(*) from public.email_campaign_recipients x
                               where x.campaign_id = c.id and x.status = 'sent' and x.sent_at > now() - interval '24 hours'))
      into v_room;
    v_room := least(coalesce(v_room, 0), v_left);
    if v_room > 0 then
      return query
      with picked as (
        select r.id from public.email_campaign_recipients r
         where r.campaign_id = c.id and r.status = 'pending'
         order by r.created_at limit v_room for update skip locked
      ), upd as (
        update public.email_campaign_recipients r set status = 'sending', claimed_at = now()
          from picked where r.id = picked.id
        returning r.id, r.tenant_id, r.email, r.name, r.vars
      )
      select u.id, u.tenant_id, (select t.name from public.tenants t where t.id = u.tenant_id), c.id, u.email,
             left(idx_private.wa_render(c.subject, u.name, u.vars), 200), idx_private.wa_render(c.body, u.name, u.vars),
             c.reply_to, c.button_label, c.button_url
        from upd u;
      get diagnostics v_room = row_count;
      v_left := v_left - v_room;
    end if;
    -- terminou: ninguém mais na fila
    if not exists (select 1 from public.email_campaign_recipients x where x.campaign_id = c.id and x.status in ('pending', 'sending')) then
      update public.email_campaigns set status = 'completed', completed_at = now() where email_campaigns.id = c.id;
    end if;
  end loop;
end $$;

create or replace function public.email_result(p_id uuid, p_ok boolean, p_provider_id text default null, p_error text default null, p_invalid boolean default false)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.email_campaign_recipients;
begin
  update public.email_campaign_recipients
     set status = case when p_ok then 'sent' when p_invalid then 'invalid' else 'failed' end,
         provider_id = p_provider_id, error = case when p_ok then null else left(p_error, 300) end,
         sent_at = case when p_ok then now() end
   where id = p_id and status = 'sending'
  returning * into r;
  -- registra no histórico do contato
  if p_ok and r.crm_contact_id is not null then
    begin
      insert into public.crm_timeline (tenant_id, contact_id, kind, title, metadata)
      select r.tenant_id, r.crm_contact_id, 'email_log', left('E-mail enviado: ' || idx_private.wa_render(coalesce(c.subject, ''), r.name, r.vars), 200),
             jsonb_build_object('email_campaign_id', c.id, 'disparo', c.name, 'para', r.email)
        from public.email_campaigns c where c.id = r.campaign_id;
    exception when others then null;   -- histórico é opcional, não trava o envio
    end;
  end if;
end $$;

-- Descadastro pelo link do e-mail (o código é o id do envio)
create or replace function public.email_unsubscribe(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.email_campaign_recipients; v_name text;
begin
  select * into r from public.email_campaign_recipients where id = p_token;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  insert into public.email_optouts (tenant_id, email, source) values (r.tenant_id, r.email, 'link') on conflict do nothing;
  update public.email_campaign_recipients set status = 'opted_out' where tenant_id = r.tenant_id and email = r.email and status = 'pending';
  select name into v_name from public.tenants where id = r.tenant_id;
  return jsonb_build_object('ok', true, 'empresa', v_name);
end $$;

-- Permissões -------------------------------------------------------------------
grant execute on function public.email_campaign_save(uuid, uuid, text, text, text, text, text, text, int, int, uuid) to authenticated;
grant execute on function public.email_campaign_add_recipients(uuid, text, uuid[], jsonb) to authenticated;
grant execute on function public.email_campaign_clear_recipients(uuid) to authenticated;
grant execute on function public.email_campaign_action(uuid, text) to authenticated;
grant execute on function public.email_campaign_list(uuid) to authenticated;
grant execute on function public.email_optout_set(uuid, text, boolean) to authenticated;
do $$
declare f text;
begin
  foreach f in array array['public.email_claim(int)', 'public.email_result(uuid, boolean, text, text, boolean)', 'public.email_unsubscribe(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
