# Banco único multiempresa

## Decisão

O banco de dados é da IDX. Cada pet shop, autoescola, clínica ou negócio local é
uma camada dentro do mesmo Supabase, identificada por `tenant_id`.

O cliente local não cria projeto Supabase, não recebe token de banco e não executa
SQL. Ele acessa apenas o painel.

## Camadas

- `platform_users`: gestores da IDX que podem criar e operar clientes.
- `tenants`: empresas/clientes locais.
- `tenant_users`: usuários vinculados a uma empresa.
- Tabelas operacionais com `tenant_id`: ofertas, links, leads, CRM, CAPI e Meta Ads.
- `tenant_meta_credentials`: credenciais Meta por empresa, lidas apenas no servidor.

## Isolamento

O isolamento acontece em três níveis:

1. Todas as tabelas operacionais carregam `tenant_id`.
2. RLS usa `idx_private.has_tenant_role(...)`.
3. Edge Functions validam usuário e tenant antes de escrever dados sensíveis.

Gestores da IDX em `platform_users` conseguem operar todos os tenants. Usuários de
cliente veem apenas tenants nos quais existem em `tenant_users`.

## Bootstrap do gestor IDX

Use uma das opções:

```sql
insert into public.platform_users (user_id, role, status)
values ('AUTH_USER_ID', 'owner', 'active')
on conflict (user_id) do update
set role = excluded.role,
    status = excluded.status,
    updated_at = now();
```

Ou configure:

```bash
supabase secrets set PLATFORM_OWNER_EMAILS=seu-email@empresa.com
```

Em produção, mantenha:

```bash
supabase secrets set REQUIRE_PLATFORM_ADMIN_FOR_TENANT_CREATE=true
```

## Regra comercial

O cliente compra uma solução de CRO local da IDX. A infraestrutura é nossa. Isso
permite escalar dezenas ou centenas de empresas no mesmo produto sem virar uma
coleção de bancos separados difíceis de manter.
