# Stack local de testes (Supabase-compatível)

Usada apenas para testar migrations, RLS e a interface do CRM sem tocar em produção.

Componentes esperados em `$STACK_DIR` (padrão `/opt/stack`):

- Postgres 16 local (`postgres://postgres:postgres@localhost`)
- `auth` (GoTrue) + `auth.env` (JWT secret igual ao do PostgREST)
- `postgrest` + `postgrest.conf` (banco `idx`, roles `anon`/`authenticated`)
- `deno` + `fn_wrapper.ts` para servir as Edge Functions
- `gw/gateway.mjs`: gateway em `127.0.0.1:54321` com as rotas `/auth/v1`, `/rest/v1` e `/functions/v1`; chaves em `gw/keys.json`

Comandos:

```bash
bash scripts/local-stack/reset-db.sh   # recria o banco 'idx' com todas as migrations
bash /opt/stack/start.sh               # sobe PostgREST, GoTrue, Edge Functions e gateway
node tests/crm/seed-local.mjs          # empresas e usuários de teste
```

O Realtime não faz parte desta stack: avisos de WebSocket no console do painel local são esperados.
