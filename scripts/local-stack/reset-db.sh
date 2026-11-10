#!/bin/bash
# Recria o banco LOCAL de testes: auth (GoTrue) + todas as migrations do repositório.
# Requer Postgres local e os binários em $STACK_DIR (ver scripts/local-stack/README.md).
set -euo pipefail
STACK_DIR=${STACK_DIR:-/opt/stack}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PG=${PGADMIN_URL:-postgres://postgres:postgres@localhost}
export PGOPTIONS='-c client_min_messages=warning'
psql "$PG/postgres" -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='idx' and pid <> pg_backend_pid();" >/dev/null
psql "$PG/postgres" -q -c "drop database if exists idx" -c "create database idx"
psql "$PG/idx" -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'authpass'; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin login createrole password 'authpass'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema auth authorization supabase_auth_admin;
grant create on database idx to supabase_auth_admin;
SQL
(cd "$STACK_DIR" && set -a && . ./auth.env && set +a && ./auth migrate >/dev/null)
psql "$PG/idx" -q -c "grant usage on schema auth to authenticated, anon, service_role; grant execute on all functions in schema auth to authenticated, anon, service_role;"
# Reproduz os privilégios padrão do Supabase (tabelas/funções novas liberadas para anon/authenticated/service_role;
# a proteção real é o RLS). Assim os testes locais refletem produção.
psql "$PG/idx" -q <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL
for f in "$REPO"/supabase/migrations/*.sql; do
  psql "$PG/idx" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null || { echo "FALHOU: $f"; exit 1; }
done
echo "banco local recriado com $(ls "$REPO"/supabase/migrations/*.sql | wc -l) migrations"
