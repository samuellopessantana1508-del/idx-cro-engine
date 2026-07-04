# Meta App - Configuração Avançada

Este guia fica preparado para uma etapa futura. No padrão atual do produto, a
integração recomendada é simples: `Pixel ID + Token CAPI` na tela Integrações.
Isso já permite rodar pilotos e clientes da IDX sem App Review.

## O que dá para deixar pronto no código

Já está implementado:

- botão `Conectar Facebook`;
- página pública `/meta-oauth-callback.html` que encaminha para `meta-oauth`;
- troca de short-lived token por long-lived token;
- armazenamento server-side do token;
- fallback por `Pixel ID + Token CAPI`;
- teste CAPI pelo painel;
- seleção futura de conta/pixel via `meta-assets`.
- importação de campanhas, cliques e gasto via `meta-insights`.

## Quando usar Meta App

Use Meta App quando a IDX for abrir conexão self-service em volume, onde cada
cliente entra com Facebook e escolhe conta/pixel dentro do painel.

Não existe como o código aprovar uma redirect URL sozinho. A redirect URL é uma
configuração dentro da sua Meta App.

### 1. Criar App

1. Acesse `https://developers.facebook.com/apps/`.
2. Crie uma nova App.
3. Use um nome simples, por exemplo `IDX CRO Engine`.
4. Copie:
   - App ID;
   - App Secret.

### 2. Adicionar Login

1. No painel da App, adicione o produto `Facebook Login` ou `Facebook Login for Business`.
2. Abra as configurações de OAuth.
3. Ative:
   - Client OAuth Login;
   - Web OAuth Login;
   - Enforce HTTPS.

### 3. Cadastrar Redirect URL

Cadastre exatamente:

```txt
https://SEU-DOMINIO.com/meta-oauth-callback.html
```

No ambiente atual da IDX, use:

```txt
https://cro.idxparasuaempresa.com.br/meta-oauth-callback.html
```

Essa página estática recebe `code/state` da Meta e redireciona para a Edge
Function `meta-oauth` no Supabase. Se no futuro você expuser as Edge Functions em
domínio próprio, pode trocar o fluxo para usar esse domínio direto.

### 4. Configurar Secrets no Supabase

```bash
supabase secrets set APP_URL=https://app.seudominio.com
supabase secrets set FALLBACK_URL=https://wa.me/5564999999999
supabase secrets set META_GRAPH_VERSION=v25.0
supabase secrets set META_APP_ID=SEU_APP_ID
supabase secrets set META_APP_SECRET=SEU_APP_SECRET
supabase secrets set META_REDIRECT_URI=https://SEU-DOMINIO.com/meta-oauth-callback.html
supabase secrets set META_LOGIN_CONFIG_ID=SEU_FACEBOOK_LOGIN_FOR_BUSINESS_CONFIG_ID
```

Para Facebook Login for Business, crie uma configuração em **Facebook Login for Business > Configurations** e salve o **Configuration ID** em `META_LOGIN_CONFIG_ID`.

### 5. Modo interno recomendado

Enquanto só você usa:

- mantenha a App em modo interno/desenvolvimento se for suficiente para seus testes;
- adicione seu usuário Meta como admin/developer/tester da App;
- use o fallback `Pixel ID + Token CAPI` quando a permissão de listar ativos
  ainda não estiver liberada;
- valide primeiro `Lead` e `Purchase` no Events Manager.

## Quando abrir para volume

Antes de vender como plataforma aberta:

- revisar permissões de `ads_read`, `ads_management` e `business_management`;
- passar por App Review quando necessário;
- fazer Business Verification;
- criar Política de Privacidade e Data Deletion Callback;
- trocar o onboarding técnico por uma experiência 100% self-service;
- adicionar monitoramento de tokens expirados e reconexão.

## Padrão simples para começar hoje

Use este caminho por padrão:

1. Vá em Events Manager.
2. Copie o Pixel ID.
3. Gere um token CAPI.
4. No painel IDX, abra `Integrações`.
5. Cole `Pixel ID + Token CAPI`.
6. Clique `Testar CAPI`.

Esse caminho já permite rodar piloto com Autoescola Vivo sem login OAuth e deve
ser o padrão inicial da operação.

## Checklist para Meta Ads e públicos automáticos

Para liberar importação de gastos, seleção de conta de anúncios e criação de
Custom Audiences:

1. Em Meta Developers, abra a App `IDX CRO Engine`.
2. Em **Facebook Login for Business > Configurations**, crie ou abra uma
   configuração.
3. Confirme que a configuração inclui permissões de marketing como `ads_read`,
   `ads_management` e `business_management`.
   Não inclua `email` no fluxo da IDX; o login de usuários é feito pelo
   Supabase, e o Facebook Login aqui serve para Marketing API.
4. Copie o **Configuration ID**.
5. No Supabase, salve:

```bash
supabase secrets set META_LOGIN_CONFIG_ID=SEU_CONFIGURATION_ID --project-ref tykeycwworjtfpssjevw
```

6. No painel IDX, abra `Integrações`.
7. Clique `Conectar Facebook` e conclua o login com o usuário que tem acesso à
   conta de anúncios.
8. Clique `Buscar ativos Meta`.
9. Selecione conta de anúncios + Pixel e clique `Usar estes ativos`.
10. Rode `Sincronizar Meta Ads` e `Sincronizar públicos`.

Se `Buscar ativos Meta` retornar `Missing Permissions`, o token conectado não
tem permissão para Marketing API. Nesse caso, revise a configuração do Facebook
Login for Business, adicione o usuário à App/Business e refaça o login.
