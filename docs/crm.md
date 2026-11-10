# CRM do IDX CRO Engine

CRM multiempresa integrado ao IDX: contatos, empresas, funis, negociações, tarefas e agenda,
produtos e propostas, vendas com evidência, RFV, onboarding/CS, automações internas, indicadores
de Revenue Operations e importação/exportação. Tudo dentro do mesmo painel (`web/`) e do mesmo
banco Supabase, isolado por `tenant_id` com RLS.

## Onde está cada coisa

| Parte | Arquivo |
|---|---|
| Núcleo (contatos, empresas, funis, etapas, negociações, tarefas, timeline, permissões, RLS) | `supabase/migrations/20261110120000_crm_core.sql` |
| Pedidos, pagamentos, amostras, RFV, onboarding, campanhas | `supabase/migrations/20261110120100_crm_revenue_rfv.sql` |
| Automações (gatilho → condição → ação interna) e notificações | `supabase/migrations/20261110120200_crm_automations.sql` |
| Integração com o IDX: WhatsApp, Smart Links/rastreamento, vendas do Atender, sinais da IA, migração dos status antigos | `supabase/migrations/20261110120300_crm_integration.sql` |
| Views, KPIs com fórmula/fonte, importação CSV, mesclagem, privilégios | `supabase/migrations/20261110120400_crm_views_kpis.sql` |
| Lead scoring configurável (MQL automático) | `supabase/migrations/20261110120500_crm_lead_scoring.sql` |
| Interface | `web/src/crm/*` + `web/src/styles/crm.css`; entrada em `web/src/App.tsx` (seção `crm-app`) |
| Testes | `tests/crm/` |

## Regras de negócio garantidas pelo banco

- **Isolamento**: toda tabela operacional tem `tenant_id`, FKs compostas `(tenant_id, id)` e RLS. Um usuário só lê/escreve nas empresas em que é membro ativo.
- **Papéis** (`tenant_users.crm_role`): administrador (dono/admin do IDX), gestor, vendedor, marketing, atendimento, CS, leitura. Vendedor pode ser limitado às próprias negociações (`crm_settings.seller_visibility = 'own'`).
- **Venda ≠ interesse**: venda marcada automaticamente pela IA vira pedido **pendente** e não conta como receita até alguém confirmar a evidência. Purchase para o Meta continua saindo somente pelo fluxo auditado do IDX (Edge Function `crm`/`sale-confirm`), com deduplicação.
- **RFV**: só pedidos confirmados/pagos, não gratuitos e com valor líquido > 0. Cancelados e estornos totais saem; devoluções parciais reduzem o valor; parcelas são uma compra; amostras nunca contam.
- **Origem**: `known` (rastreio/UTM/ID de anúncio), `declared` (informada), `inferred` (sugestão), `unknown`. Nada é atribuído a campanha sem evidência.
- **Automações** só executam ações internas (tarefa, notificação, tag, responsável, onboarding). Disparo externo é recusado pelo banco. Execuções ficam em `crm_automation_runs` com deduplicação.
- **Duplicidade**: telefone normalizado com DDI (`55…`) e chave de correspondência; e-mail em minúsculas; duplicados são bloqueados ou sinalizados, nunca mesclados automaticamente.
- Status antigos do IDX (Novo, Contato, Qualificado/Remarketing, Ruim, Perdido, Venda) são mapeados para etapas pelo campo `crm_stages.legacy_status`.

## Rodar localmente (sem tocar em produção)

1. Postgres local + binários GoTrue/PostgREST/Deno em `/opt/stack` (ver `scripts/local-stack/README.md`).
2. `bash scripts/local-stack/reset-db.sh && bash /opt/stack/start.sh`
3. `SUPABASE_URL=http://127.0.0.1:54321 SERVICE_KEY=… node tests/crm/seed-local.mjs`
4. Testes de banco/permissões: `SUPABASE_URL=… ANON_KEY=… node --test tests/crm/rls-isolation.test.mjs tests/crm/integration.test.mjs`
5. Painel: `cd web && npx vite --host 127.0.0.1` com `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) apontando para a stack local.
6. Teste de interface ponta a ponta: `node tests/crm/e2e-ui.mjs` (logins de teste em `tests/crm/seed-local.mjs`, senha `Teste@12345`).

Os testes de integração assumem banco recém-criado: rode `reset-db.sh` + seed antes de repetir.

## Publicar (requer autorização)

1. Backup do banco de produção.
2. `supabase db push` aplica as 6 migrations novas. Elas são aditivas (tabelas novas e colunas `if not exists`), e cada empresa recebe o funil padrão e o mapeamento dos status antigos na primeira abertura do CRM (`crm_setup_tenant`).
3. Agendar `select public.crm_run_scheduled_all();` (ex.: a cada hora via `pg_cron` ou n8n) para negociações paradas, tarefas atrasadas e recálculo do RFV com a passagem do tempo.
4. Build do painel (`cd web && npm run build`) e deploy como hoje.
5. Validar com um usuário de cada papel e duas empresas antes de liberar.
