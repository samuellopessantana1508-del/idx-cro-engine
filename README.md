# IDX CRO Engine

Software de CRO para negócios locais que vendem pelo WhatsApp.

O núcleo do produto é um Smart Link direto:

```txt
Instagram / Meta Ads -> Smart Link IDX -> WhatsApp
```

O lead não passa por página de produto por padrão. O sistema captura origem, oferta,
campanha, clique e conversão no servidor, envia eventos CAPI para o Meta e mantém
uma fila simples para o atendente confirmar venda.

## Módulos

- `web/`: painel SaaS em React + Vite, visual preto/branco/cinza.
- `supabase/migrations/`: banco multiempresa com RLS, views e grants.
- `supabase/functions/go`: redirect público para WhatsApp + Lead CAPI.
- `supabase/functions/convert`: confirmação de venda/perda + Purchase CAPI.
- `supabase/functions/capi-health`: diagnóstico de eventos CAPI.
- `supabase/functions/crm`: pipeline de leads, histórico e eventos CAPI por etapa.
- `supabase/functions/meta-oauth`: login oficial do Facebook/Meta.
- `supabase/functions/meta-assets`: lista contas/pixels e salva Pixel escolhido.
- `supabase/functions/meta-insights`: importa campanhas, cliques e gasto do Meta Ads.
- `supabase/functions/tenant-admin`: cria clientes, salva Meta manual e convida usuários.
- `supabase/functions/supabase-health`: valida se a instalação Supabase está saudável.
- `docs/`: roteiro de implantação e decisões de produto.

## Banco de dados

O Supabase é único e pertence à IDX. Cada cliente local é uma camada no mesmo
banco, isolada por `tenant_id`, RLS e Edge Functions. O cliente não acessa o
Supabase; ele usa apenas o painel.

Leia: `docs/single-database-multitenant.md`.

## Decisão principal de produto

Não existe página pública obrigatória no caminho do lead.

Isso reduz fricção ao máximo para negócios locais. Quando um cliente precisar de
catálogo/DPA/retargeting por visualização, esse modo pode ser adicionado como
opcional depois, sem mudar o motor de Smart Links.

## Desenvolvimento local

```bash
cd web
npm install
npm run dev
```

O painel abre em modo demo se as variáveis Supabase não forem configuradas.

## Variáveis do painel

Crie `web/.env.local`:

```env
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=SUA_ANON_KEY
VITE_PUBLIC_REDIRECT_BASE=https://SEU-DOMINIO.com
```

## Variáveis das Edge Functions

Configure uma vez no Supabase:

```bash
supabase secrets set APP_URL=https://app.seudominio.com
supabase secrets set PLATFORM_OWNER_EMAILS=seu-email@empresa.com
supabase secrets set REQUIRE_PLATFORM_ADMIN_FOR_TENANT_CREATE=true
supabase secrets set FALLBACK_URL=https://wa.me/5564999999999
supabase secrets set META_GRAPH_VERSION=v25.0

# Opcionais: necessárias apenas para "Conectar Facebook"
supabase secrets set META_APP_ID=SEU_META_APP_ID
supabase secrets set META_APP_SECRET=SEU_META_APP_SECRET
supabase secrets set META_REDIRECT_URI=https://SEU-PROJETO.supabase.co/functions/v1/meta-oauth
```

O padrão inicial do produto é integrar manualmente com `Pixel ID + Token CAPI`
pelo painel, sem SQL. A Meta App fica preparada como opção avançada para quando
a plataforma for distribuída em volume.

No CRM, `lead_status = qualified` é o mesmo segmento de remarketing. Essa etapa
envia `QualifiedLead` via CAPI e alimenta os relatórios de qualidade por campanha.

Arquivos úteis:

- `.env.example`: variáveis do frontend.
- `supabase/.env.secrets.example`: secrets das Edge Functions.
- `docs/meta-app-internal-setup.md`: passo a passo da Meta App para uso interno.

## Publicos Meta automaticos

O CRM cria e sincroniza publicos Meta automaticamente por empresa:

- `qualified`: audiencia `IDX - Leads qualificados`.
- `purchased`: audiencia `IDX - Compradores`.

Quando o lead vira qualificado ou vendido, o sistema tenta enviar telefone
e/ou email hashados para a Custom Audience correta. Se o lead nao tiver
telefone/email, a tentativa fica registrada como `skipped` para o atendente
completar o contato no CRM.

## Email de confirmacao

O cadastro inicial usa o email de confirmacao nativo do Supabase Auth. Em
producao, mantenha a confirmacao de email ativa em `Authentication > Providers`
e cadastre as URLs do painel em `Authentication > URL Configuration`:

- Local: `http://127.0.0.1:5177`
- Producao: URL final do GitHub Pages ou dominio do painel IDX

O painel tambem permite reenviar a confirmacao de cadastro sem abrir o Supabase.
Convites de novos usuarios por empresa sao enviados por email pela Edge Function
`tenant-admin`.

Para envio real a qualquer pessoa, configure SMTP proprio no Supabase Auth. O
provedor padrao do Supabase e limitado; para piloto interno pode funcionar, mas
produto profissional precisa SMTP da Hostinger, Resend, Postmark, Brevo ou AWS
SES. Veja `scripts/configure-supabase-auth-smtp.ps1`.

## Deploy Hostinger

O frontend pode ser hospedado na Hostinger como site estatico dentro de
`public_html`. O backend continua no Supabase. O build inclui `.htaccess` para
SPA/cache.

Leia: `docs/hostinger-deploy.md`.

## Deploy Supabase

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
supabase functions deploy go --no-verify-jwt
supabase functions deploy convert
supabase functions deploy crm
supabase functions deploy capi-health
supabase functions deploy tenant-admin
supabase functions deploy meta-oauth --no-verify-jwt
supabase functions deploy meta-assets
supabase functions deploy meta-insights
supabase functions deploy meta-audiences
supabase functions deploy supabase-health
```

As funções públicas/privadas também estão declaradas em `supabase/config.toml`.

## Testes

```bash
cd web
npm run build
npm run test:edge
```

## Deploy GitHub Pages

O repositório já inclui `.github/workflows/deploy-pages.yml`.

No GitHub, configure Pages como `GitHub Actions` e cadastre:

- Repository variable `VITE_SUPABASE_URL`: URL do projeto Supabase.
- Repository secret `VITE_SUPABASE_ANON_KEY`: chave pública/publishable do Supabase.
- Repository variable `VITE_PUBLIC_REDIRECT_BASE`: URL pública usada nos Smart Links.
- Repository variable `VITE_REDIRECT_PATH_PREFIX`: normalmente `/functions/v1/go`.

Depois disso, qualquer push na branch `main` publica o painel em GitHub Pages.
