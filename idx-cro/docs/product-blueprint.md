# Product Blueprint

## Produto

IDX CRO Engine é uma camada de crescimento para negócios locais que vendem pelo
WhatsApp. Ele troca a pergunta "quantos cliques eu tive?" por "qual anúncio,
oferta e conversa geraram venda real?".

## Público

- Agências e gestores de tráfego local.
- Autoescolas, pet shops, clínicas, estética, materiais de construção,
  assistência técnica, delivery, restaurantes e serviços locais.

## Fluxo sem fricção

1. A empresa cadastra uma oferta.
2. O sistema gera um Smart Link.
3. O gestor usa esse link no Instagram, bio, anúncio ou criativo.
4. O clique redireciona direto ao WhatsApp.
5. O sistema registra sessão, campanha, oferta e envia `Lead` via CAPI.
6. O atendimento acontece normalmente no WhatsApp.
7. O atendente move o lead no CRM.
8. Lead qualificado vira automaticamente segmento de remarketing.
9. O atendente confirma venda no painel/PWA.
10. O sistema envia `Purchase` via CAPI e atualiza o dashboard.

## Promessa

Transformar WhatsApp em um funil mensurável para CRO local.

## O que o produto evita

- Ler WhatsApp por API não oficial.
- Forçar gateway de pagamento.
- Pedir formulário antes da conversa.
- Criar página intermediária obrigatória.
- Expor token CAPI no navegador.
- Fazer o cliente local operar Supabase ou SQL.

## Núcleo técnico

- Banco único da IDX com multiempresa por `tenant_id`.
- Smart Link server-side.
- UTMs preservadas.
- `fbclid` convertido para `fbc` quando existir.
- IP/user-agent capturados na Edge Function.
- `Lead` e `Purchase` via Meta Conversions API.
- CRM com pipeline visual e histórico por lead.
- `QualifiedLead`, `DisqualifiedLead`, `ContactedLead` e `LeadLost` via CAPI.
- Logs completos de CAPI.
- Multiempresa com RLS.
- Painel operacional clean.

## Banco da IDX

O Supabase é nosso. Cada empresa local é uma camada dentro do mesmo banco, não um
projeto separado. Isso reduz custo operacional, facilita análise cruzada e permite
escalar a operação como SaaS.

O cliente local não acessa Supabase, não recebe service role e não precisa saber o
que é migration. Ele acessa o painel com permissões por tenant.

## CRM como coração

O Smart Link gera o lead. O CRM ensina o Meta quais leads prestam.

No produto, `lead_status = qualified` é a mesma coisa que remarketing. Não existe
um segundo marcador separado para isso. Quando o atendente marca o lead como
qualificado, o sistema:

- adiciona as tags `bom lead` e `remarketing`;
- grava histórico em `crm_activities`;
- envia `QualifiedLead` via CAPI;
- inclui o lead em `vw_remarketing_audience`;
- atualiza relatórios de qualidade por campanha e gasto Meta.

Leads ruins entram como `bad`, geram sinal de desqualificação e ajudam a evitar
otimização cega por volume de conversa.

## Integrações sem fricção

Para o cliente local, o onboarding ideal é:

1. Criar cliente.
2. Colar Pixel ID + Token CAPI do Events Manager.
3. Testar evento CAPI.
4. Criar Smart Link.

Supabase é infraestrutura da IDX. O cliente não precisa entrar no Supabase,
criar tabela, colar SQL ou entender Edge Function.

Facebook Login fica como opção avançada para distribuição em volume. No piloto e
na operação inicial da IDX, o padrão do produto é `Pixel ID + Token CAPI`, porque
é rápido, previsível e não depende de App Review.

## Quando usar página opcional

Somente quando o ganho superar a fricção:

- Catálogo/DPA.
- Oferta complexa.
- Ticket alto.
- Necessidade de pré-qualificação.
- Remarketing por `ViewContent`.

No fluxo padrão, o link é direto para WhatsApp.
