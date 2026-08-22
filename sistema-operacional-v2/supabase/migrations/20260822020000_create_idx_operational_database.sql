begin;

-- IDX Sistema Operacional v2
-- Fresh database reconstructed from every Supabase call made by the application.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nome text not null,
  role text not null default 'colaborador'
    check (role in ('admin', 'colaborador')),
  configuracoes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(btrim(nome)) > 0),
  nicho text not null default '',
  fee_mensal numeric(14,2) not null default 0 check (fee_mensal >= 0),
  data_inicio date,
  email text not null default '',
  telefone text not null default '',
  responsavel text not null default '',
  plataformas text[] not null default '{}'::text[],
  cpa_meta numeric(14,2) not null default 0 check (cpa_meta >= 0),
  cpm_meta numeric(14,2) not null default 0 check (cpm_meta >= 0),
  ctr_meta numeric(10,4) not null default 0 check (ctr_meta >= 0),
  cpc_meta numeric(14,2) not null default 0 check (cpc_meta >= 0),
  observacoes text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.client_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clientes(id) on delete cascade,
  titulo text not null check (length(btrim(titulo)) > 0),
  tipo text not null default 'demanda'
    check (tipo in (
      'demanda', 'subir_anuncio', 'nova_campanha', 'ligar_cliente',
      'relatorio', 'reuniao', 'otimizacao', 'criativo', 'outro'
    )),
  responsavel text,
  prioridade text not null default 'media'
    check (prioridade in ('urgente', 'alta', 'media', 'baixa')),
  prazo date,
  descricao text,
  pop_content text,
  concluida boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tipo <> 'otimizacao' or client_id is not null),
  check (tipo <> 'otimizacao' or length(btrim(coalesce(pop_content, ''))) > 0)
);

create table public.rotina_cliente_execucoes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clientes(id) on delete cascade,
  tipo text not null check (tipo in ('diario', 'semanal', 'mensal')),
  periodo text not null check (length(btrim(periodo)) > 0),
  item_key text not null check (length(btrim(item_key)) > 0),
  concluido boolean not null default false,
  concluido_em timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, tipo, periodo, item_key),
  check ((concluido and concluido_em is not null) or not concluido)
);

create table public.estrategias_cliente (
  id text primary key,
  client_id uuid not null references public.clientes(id) on delete cascade,
  titulo text not null default '',
  conteudo text not null default '',
  status text not null default 'ativa'
    check (status in ('ativa', 'pausada', 'arquivada')),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.diario_cliente (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clientes(id) on delete cascade,
  titulo text not null check (length(btrim(titulo)) > 0),
  tipo text not null default 'nota'
    check (tipo in ('nota', 'acao', 'alerta', 'insight', 'reuniao')),
  data_entrada date not null default current_date,
  conteudo text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.metricas_mensais (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clientes(id) on delete cascade,
  mes smallint not null check (mes between 1 and 12),
  ano smallint not null check (ano between 2020 and 2200),
  investimento numeric(16,2) not null default 0 check (investimento >= 0),
  contatos integer not null default 0 check (contatos >= 0),
  cpa_real numeric(14,2) not null default 0 check (cpa_real >= 0),
  ctr_medio numeric(10,4) not null default 0 check (ctr_medio >= 0),
  cpm_medio numeric(14,2) not null default 0 check (cpm_medio >= 0),
  inv_mes numeric(16,2) not null default 0 check (inv_mes >= 0),
  cpc_medio numeric(14,2) not null default 0 check (cpc_medio >= 0),
  contatos_mes integer not null default 0 check (contatos_mes >= 0),
  obs text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ano, mes)
);

create table public.client_benchmarks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clientes(id) on delete cascade,
  nicho_ref text not null default '',
  meta_cpm numeric(14,2),
  meta_cpc numeric(14,2),
  meta_ctr numeric(10,4),
  meta_hook_rate numeric(10,4),
  meta_connect_rate numeric(10,4),
  meta_cpa_whats numeric(14,2),
  meta_cpa_lead numeric(14,2),
  meta_freq_max numeric(10,4),
  meta_taxa_conv_lp numeric(10,4),
  meta_roas numeric(10,4),
  obs text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    coalesce(meta_cpm, 0) >= 0 and
    coalesce(meta_cpc, 0) >= 0 and
    coalesce(meta_ctr, 0) >= 0 and
    coalesce(meta_hook_rate, 0) >= 0 and
    coalesce(meta_connect_rate, 0) >= 0 and
    coalesce(meta_cpa_whats, 0) >= 0 and
    coalesce(meta_cpa_lead, 0) >= 0 and
    coalesce(meta_freq_max, 0) >= 0 and
    coalesce(meta_taxa_conv_lp, 0) >= 0 and
    coalesce(meta_roas, 0) >= 0
  )
);

create table public.checklist_execucoes (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('diario', 'semanal', 'mensal')),
  periodo text not null check (length(btrim(periodo)) > 0),
  secao_key text not null check (length(btrim(secao_key)) > 0),
  item_key text not null check (length(btrim(item_key)) > 0),
  concluido boolean not null default false,
  concluido_em timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tipo, periodo, secao_key, item_key),
  check ((concluido and concluido_em is not null) or not concluido)
);

-- Public account metadata is readable by the team. Tokens live in a private table.
create table public.client_meta_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clientes(id) on delete cascade,
  ad_account_id text not null check (length(btrim(ad_account_id)) > 0),
  ad_account_name text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.client_meta_credentials (
  client_id uuid primary key references public.clientes(id) on delete cascade,
  access_token text not null check (length(btrim(access_token)) > 0),
  updated_at timestamptz not null default now()
);

create table private.idx_member_invites (
  email text primary key,
  role text not null default 'colaborador'
    check (role in ('admin', 'colaborador')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_profiles_touch_updated_at
before update on public.user_profiles
for each row execute function private.touch_updated_at();

create trigger clientes_touch_updated_at
before update on public.clientes
for each row execute function private.touch_updated_at();

create trigger client_tasks_touch_updated_at
before update on public.client_tasks
for each row execute function private.touch_updated_at();

create trigger rotina_cliente_execucoes_touch_updated_at
before update on public.rotina_cliente_execucoes
for each row execute function private.touch_updated_at();

create trigger estrategias_cliente_touch_updated_at
before update on public.estrategias_cliente
for each row execute function private.touch_updated_at();

create trigger diario_cliente_touch_updated_at
before update on public.diario_cliente
for each row execute function private.touch_updated_at();

create trigger metricas_mensais_touch_updated_at
before update on public.metricas_mensais
for each row execute function private.touch_updated_at();

create trigger client_benchmarks_touch_updated_at
before update on public.client_benchmarks
for each row execute function private.touch_updated_at();

create trigger checklist_execucoes_touch_updated_at
before update on public.checklist_execucoes
for each row execute function private.touch_updated_at();

create trigger client_meta_accounts_touch_updated_at
before update on public.client_meta_accounts
for each row execute function private.touch_updated_at();

create trigger client_meta_credentials_touch_updated_at
before update on private.client_meta_credentials
for each row execute function private.touch_updated_at();

create or replace function private.is_idx_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.user_profiles up
      where up.id = (select auth.uid())
    );
$$;

create or replace function private.is_idx_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles up
    where up.id = (select auth.uid())
      and up.role = 'admin'
  );
$$;

revoke all on function private.is_idx_member() from public, anon;
revoke all on function private.is_idx_admin() from public, anon;
grant execute on function private.is_idx_member() to authenticated;
grant execute on function private.is_idx_admin() to authenticated;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_role text;
begin
  perform pg_advisory_xact_lock(hashtext('idx-operational-first-admin'));

  if not exists (select 1 from public.user_profiles) then
    assigned_role := 'admin';
  else
    select i.role into assigned_role
    from private.idx_member_invites i
    where lower(i.email) = lower(coalesce(new.email, ''));

    -- A valid Auth account is not automatically an IDX member. This keeps
    -- public email sign-up from granting access to client data.
    if assigned_role is null then
      return new;
    end if;
  end if;

  insert into public.user_profiles (id, email, nome, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Usuário IDX'
    ),
    assigned_role
  )
  on conflict (id) do nothing;

  delete from private.idx_member_invites
  where lower(email) = lower(coalesce(new.email, ''));

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_idx_operational on auth.users;
create trigger on_auth_user_created_idx_operational
after insert on auth.users
for each row execute function private.handle_new_auth_user();

-- Also covers the safe case where the first admin was created before migration.
with first_user as (
  select
    u.id,
    coalesce(u.email, '') as email,
    coalesce(
      nullif(u.raw_user_meta_data ->> 'full_name', ''),
      nullif(u.raw_user_meta_data ->> 'name', ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Usuário IDX'
    ) as nome
  from auth.users u
  order by u.created_at, u.id
  limit 1
)
insert into public.user_profiles (id, email, nome, role)
select id, email, nome, 'admin'
from first_user
on conflict (id) do nothing;

create or replace function public.invite_idx_member(
  p_email text,
  p_role text default 'colaborador'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_idx_admin() then
    raise exception 'Apenas administradores podem convidar membros.'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'E-mail é obrigatório.' using errcode = '22023';
  end if;

  if p_role not in ('admin', 'colaborador') then
    raise exception 'Perfil inválido.' using errcode = '22023';
  end if;

  insert into private.idx_member_invites (email, role, invited_by)
  values (lower(btrim(p_email)), p_role, (select auth.uid()))
  on conflict (email) do update set
    role = excluded.role,
    invited_by = excluded.invited_by,
    created_at = now();
end;
$$;

create or replace function public.save_client_meta_account(
  p_client_id uuid,
  p_ad_account_id text,
  p_ad_account_name text,
  p_access_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row_id uuid;
  normalized_account_id text;
begin
  if not private.is_idx_admin() then
    raise exception 'Apenas administradores podem configurar credenciais Meta.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or nullif(btrim(coalesce(p_ad_account_id, '')), '') is null
     or nullif(btrim(coalesce(p_access_token, '')), '') is null then
    raise exception 'Cliente, conta de anúncios e token são obrigatórios.'
      using errcode = '22023';
  end if;

  normalized_account_id := case
    when left(btrim(p_ad_account_id), 4) = 'act_' then btrim(p_ad_account_id)
    else 'act_' || btrim(p_ad_account_id)
  end;

  insert into public.client_meta_accounts (
    client_id,
    ad_account_id,
    ad_account_name,
    ativo
  )
  values (
    p_client_id,
    normalized_account_id,
    coalesce(nullif(btrim(p_ad_account_name), ''), normalized_account_id),
    true
  )
  on conflict (client_id) do update set
    ad_account_id = excluded.ad_account_id,
    ad_account_name = excluded.ad_account_name,
    ativo = true
  returning id into account_row_id;

  insert into private.client_meta_credentials (client_id, access_token)
  values (p_client_id, btrim(p_access_token))
  on conflict (client_id) do update set
    access_token = excluded.access_token;

  return account_row_id;
end;
$$;

create or replace function public.get_client_meta_credentials(p_client_id uuid)
returns table (ad_account_id text, access_token text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Função restrita ao serviço de integração.'
      using errcode = '42501';
  end if;

  return query
  select a.ad_account_id, c.access_token
  from public.client_meta_accounts a
  join private.client_meta_credentials c on c.client_id = a.client_id
  where a.client_id = p_client_id
    and a.ativo = true;
end;
$$;

revoke all on function public.save_client_meta_account(uuid, text, text, text) from public, anon;
grant execute on function public.save_client_meta_account(uuid, text, text, text) to authenticated;
revoke all on function public.invite_idx_member(text, text) from public, anon;
grant execute on function public.invite_idx_member(text, text) to authenticated;
revoke all on function public.get_client_meta_credentials(uuid) from public, anon, authenticated;
grant execute on function public.get_client_meta_credentials(uuid) to service_role;

alter table public.user_profiles enable row level security;
alter table public.clientes enable row level security;
alter table public.client_tasks enable row level security;
alter table public.rotina_cliente_execucoes enable row level security;
alter table public.estrategias_cliente enable row level security;
alter table public.diario_cliente enable row level security;
alter table public.metricas_mensais enable row level security;
alter table public.client_benchmarks enable row level security;
alter table public.checklist_execucoes enable row level security;
alter table public.client_meta_accounts enable row level security;
alter table private.client_meta_credentials enable row level security;

create policy user_profiles_read_self_or_admin
on public.user_profiles
for select
to authenticated
using (id = (select auth.uid()) or private.is_idx_admin());

create policy user_profiles_update_admin
on public.user_profiles
for update
to authenticated
using (private.is_idx_admin())
with check (private.is_idx_admin());

create policy clientes_member_access
on public.clientes
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy client_tasks_member_access
on public.client_tasks
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy rotina_cliente_execucoes_member_access
on public.rotina_cliente_execucoes
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy estrategias_cliente_member_access
on public.estrategias_cliente
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy diario_cliente_member_access
on public.diario_cliente
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy metricas_mensais_member_access
on public.metricas_mensais
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy client_benchmarks_member_access
on public.client_benchmarks
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy checklist_execucoes_member_access
on public.checklist_execucoes
for all
to authenticated
using (private.is_idx_member())
with check (private.is_idx_member());

create policy client_meta_accounts_read_member
on public.client_meta_accounts
for select
to authenticated
using (private.is_idx_member());

create index clientes_ativo_nome_idx
on public.clientes (ativo, nome);

create index client_tasks_open_deadline_idx
on public.client_tasks (concluida, prazo, client_id);

create index client_tasks_responsavel_idx
on public.client_tasks (responsavel)
where concluida = false;

create index rotina_cliente_periodo_idx
on public.rotina_cliente_execucoes (client_id, periodo, tipo);

create index estrategias_cliente_updated_idx
on public.estrategias_cliente (client_id, updated_at desc);

create index diario_cliente_data_idx
on public.diario_cliente (client_id, data_entrada desc);

create index metricas_mensais_periodo_idx
on public.metricas_mensais (client_id, ano desc, mes desc);

create index checklist_execucoes_periodo_idx
on public.checklist_execucoes (periodo, tipo);

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.clientes from anon, authenticated;
revoke all on public.client_tasks from anon, authenticated;
revoke all on public.rotina_cliente_execucoes from anon, authenticated;
revoke all on public.estrategias_cliente from anon, authenticated;
revoke all on public.diario_cliente from anon, authenticated;
revoke all on public.metricas_mensais from anon, authenticated;
revoke all on public.client_benchmarks from anon, authenticated;
revoke all on public.checklist_execucoes from anon, authenticated;
revoke all on public.client_meta_accounts from anon, authenticated;
revoke all on private.client_meta_credentials from public, anon, authenticated;
revoke all on private.idx_member_invites from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

grant select, update on public.user_profiles to authenticated;
grant select, insert, update, delete on public.clientes to authenticated;
grant select, insert, update, delete on public.client_tasks to authenticated;
grant select, insert, update, delete on public.rotina_cliente_execucoes to authenticated;
grant select, insert, update, delete on public.estrategias_cliente to authenticated;
grant select, insert, update, delete on public.diario_cliente to authenticated;
grant select, insert, update, delete on public.metricas_mensais to authenticated;
grant select, insert, update, delete on public.client_benchmarks to authenticated;
grant select, insert, update, delete on public.checklist_execucoes to authenticated;
grant select on public.client_meta_accounts to authenticated;

comment on schema private is 'Internal IDX data that is never exposed directly through the Data API.';
comment on table public.client_tasks is 'Client activities, including standardized POPs for analysis and optimization.';
comment on table public.rotina_cliente_execucoes is 'Daily, weekly, and monthly process execution by client.';
comment on table private.client_meta_credentials is 'Meta access tokens; only service-role integration functions may read this table.';

commit;
