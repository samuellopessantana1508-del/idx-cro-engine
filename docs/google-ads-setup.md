# Google Ads no IDX CRO Engine

## Etapas da integração

O painel mostra em que etapa a empresa está (`credentials.stage` da Edge Function `google-ads`):

| Etapa | Significado | Próximo passo |
| --- | --- | --- |
| `not_connected` | Google não autorizado | Conectar Google Ads |
| `needs_account` | Google autorizado, nenhuma conta Ads vinculada | Escolher conta Google Ads |
| `account_selected` | Conta vinculada, ainda sem sincronização | Sincronizar agora |
| `synced` | Campanhas importadas | Sincronizar quando quiser |
| `needs_attention` | Token, permissão ou API impedem o acesso | Ver a mensagem e corrigir |

Autorizar o Google não é o mesmo que ter o Google Ads conectado: a conta só
conta como conectada depois de vinculada, e os dados só aparecem depois da
primeira sincronização.

## Como as contas são encontradas

1. `customers:listAccessibleCustomers` lista as contas que o login acessa diretamente.
2. Para cada MCC, `customer_client` lista as contas clientes ativas abaixo dela.
3. Ao vincular, a conta é validada de novo e a MCC fica salva em
   `manager_customer_id`. Ela vai no cabeçalho `login-customer-id` de todas as
   consultas dessa empresa.

Se o login acessar uma única conta, ela é vinculada sozinha no retorno do OAuth.

## Sincronização

- `searchStream` com métricas diárias por campanha: impressões, cliques, custo,
  CTR, CPC médio, conversões, valor de conversão e custo por conversão. O payload
  completo fica em `google_campaign_insights.raw`.
- Upsert pela chave `(tenant_id, customer_id, campaign_id, date)`: sincronizar
  de novo atualiza os números do dia, sem duplicar.
- Métricas de outra conta (vínculo antigo) são removidas, para o relatório
  da empresa não somar duas contas.
- Período: 7 a 90 dias pelo painel; a API aceita até 365 dias, ou `since`/`until`.
- O retorno separa "conta sem campanhas" de "campanhas sem dados no período".

## Secrets (Supabase → Edge Functions → Secrets)

| Secret | Obrigatório | Valor |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | sim | Cliente OAuth do projeto IDX CRO Engine |
| `GOOGLE_CLIENT_SECRET` | sim | Chave do mesmo cliente |
| `GOOGLE_REDIRECT_URI` | sim | `https://tykeycwworjtfpssjevw.supabase.co/functions/v1/google-oauth` |
| `GOOGLE_DEVELOPER_TOKEN` | sim | Developer token da MCC com acesso Básico ou Padrão |
| `GOOGLE_ADS_API_VERSION` | não | Padrão `v25`; trocar quando o Google desativar |

No projeto Google Cloud, a **Google Ads API** precisa estar ativada.

Nenhuma migration é necessária: as tabelas da migration
`20261016150000_google_ads_integration.sql` já existem em produção.

## Erros mostrados no painel

| Código | Causa |
| --- | --- |
| `developer_token_missing` | `GOOGLE_DEVELOPER_TOKEN` não configurado |
| `developer_token_not_approved` | Developer token só com acesso de teste |
| `ads_api_disabled` | Google Ads API desativada no projeto Google Cloud |
| `permission_denied` | O login não tem acesso à conta ou à MCC |
| `google_token_invalid` | Autorização expirada ou revogada: reconectar |
| `quota_exceeded` | Limite da API: tentar de novo depois |
| `ads_api_version_unsupported` | Versão da API desativada: atualizar `GOOGLE_ADS_API_VERSION` |
