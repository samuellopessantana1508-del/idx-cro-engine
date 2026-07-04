# Deployment e Onboarding

## 1. Criar projeto Supabase

1. Crie um projeto no Supabase.
2. Rode as migrations.
3. Crie usuários no Auth.
4. Cadastre seu usuário gestor em `platform_users` ou configure `PLATFORM_OWNER_EMAILS`.
5. Crie clientes pelo painel. Cada cliente vira um `tenant` no banco único da IDX.

## 2. Configurar Edge Functions

```bash
supabase functions deploy go --no-verify-jwt
supabase functions deploy convert
supabase functions deploy crm
supabase functions deploy capi-health
supabase functions deploy tenant-admin
supabase functions deploy meta-oauth --no-verify-jwt
supabase functions deploy meta-assets
supabase functions deploy meta-insights
supabase functions deploy supabase-health
```

Configure os secrets:

```bash
supabase secrets set APP_URL=https://app.seudominio.com
supabase secrets set PLATFORM_OWNER_EMAILS=seu-email@empresa.com
supabase secrets set REQUIRE_PLATFORM_ADMIN_FOR_TENANT_CREATE=true
supabase secrets set FALLBACK_URL=https://wa.me/5564999999999
supabase secrets set META_GRAPH_VERSION=v25.0
supabase secrets set META_APP_ID=SEU_META_APP_ID
supabase secrets set META_APP_SECRET=SEU_META_APP_SECRET
supabase secrets set META_REDIRECT_URI=https://SEU-DOMINIO.com/meta-oauth-callback.html
supabase secrets set META_LOGIN_CONFIG_ID=SEU_FACEBOOK_LOGIN_FOR_BUSINESS_CONFIG_ID
```

`META_REDIRECT_URI` precisa ser exatamente a mesma URL cadastrada em **Valid OAuth
Redirect URIs** na Meta App. No frontend atual, use a página
`/meta-oauth-callback.html` do domínio público do painel; ela encaminha o retorno
para a Edge Function `meta-oauth`.

`META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` e `META_LOGIN_CONFIG_ID` são opcionais nesta fase.
O padrão inicial do produto é usar a integração manual pelo painel com
`Pixel ID + Token CAPI`.

Para preparar a App Meta, siga `docs/meta-app-internal-setup.md`.

O modelo de banco está documentado em `docs/single-database-multitenant.md`.

## 3. Configurar credenciais Meta

As credenciais CAPI ficam em `tenant_meta_credentials`, uma tabela sem acesso para
usuários comuns. Apenas a Edge Function com service role lê esse token.

```sql
insert into tenant_meta_credentials (
  tenant_id,
  pixel_id,
  access_token,
  graph_version,
  enabled
) values (
  'TENANT_ID',
  'PIXEL_ID',
  'EAA...',
  'v25.0',
  true
);
```

## 4. Criar primeiro cliente

Para o piloto Autoescola Vivo, use o arquivo `docs/autoescola-vivo-pilot.sql`
e substitua `AUTH_USER_ID`, `PIXEL_ID` e `CAPI_TOKEN`.

Antes disso, marque seu usuário como gestor IDX:

```sql
insert into platform_users (user_id, role, status)
values ('AUTH_USER_ID', 'owner', 'active')
on conflict (user_id) do update
set role = excluded.role,
    status = excluded.status,
    updated_at = now();
```

```sql
insert into tenants (slug, name, whatsapp_number, timezone)
values ('autoescola-vivo', 'Autoescola Vivo', '5564999999999', 'America/Sao_Paulo');

insert into tenant_users (tenant_id, user_id, role)
values ('TENANT_ID', 'AUTH_USER_ID', 'owner');
```

## 5. Criar Smart Links

No painel:

1. Acesse `Links`.
2. Crie uma oferta.
3. Defina campanha e mensagem.
4. Copie o link gerado.
5. Use o link no anúncio do Meta.

## 6. Validar Meta CAPI

1. Faça um clique real no Smart Link.
2. Veja o lead chegar no WhatsApp.
3. Confirme a venda no painel.
4. Confira `Lead` e `Purchase` no Events Manager.
5. Marque um lead como qualificado no `CRM`.
6. Confira `QualifiedLead` no Events Manager.
7. Verifique `CAPI Health` no painel.

## 7. Validar CRM e remarketing

No painel:

1. Abra `CRM`.
2. Mova um lead para `Qualificar + remarketing`.
3. Confira o histórico do lead.
4. Abra `Relatórios`.
5. Veja qualidade por campanha, custo por qualificado e receita.

Regra de produto: lead qualificado é remarketing. A audiência técnica fica em
`vw_remarketing_audience` e o evento enviado ao Meta é `QualifiedLead`.

## Fluxo sem programador

Depois do deploy inicial, o uso diário fica no painel:

1. `Clientes` -> criar empresa.
2. `Integrações` -> salvar Pixel ID + Token CAPI.
3. `Integrações` -> testar CAPI.
4. `Links` -> criar Smart Link.
5. Copiar link e usar no anúncio.
6. `CRM` -> qualificar, marcar ruim ou perdido.
7. `Atendimentos` -> confirmar venda.
8. `Integrações` -> sincronizar Meta Ads quando usar Facebook Login.
9. `Relatórios` -> acompanhar CRO e qualidade por campanha.
