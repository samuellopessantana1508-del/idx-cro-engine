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

## Cadências, metas, assistente por voz e extensão do WhatsApp Web (nov/2026)

**Cadências** (`CRM → Cadências`): sequência de passos (ligar, WhatsApp, e-mail, tarefa) com "esperar N dias".
Cada passo vira uma tarefa no dia certo (9h, fuso da empresa). WhatsApp **nunca é enviado automaticamente**:
a tarefa traz o texto pronto (`{primeiro_nome}`, `{nome}`, `{empresa}`, `{cidade}`) e o botão "Abrir WhatsApp"
abre a conversa para o vendedor conferir e enviar. A inscrição para sozinha quando o contato responde no
WhatsApp (trigger em `whatsapp_messages`), quando a negociação é ganha/perdida, ou se a tarefa for cancelada.
Gestor cria/edita; vendedor inscreve contatos. Tabelas: `crm_cadences`, `crm_cadence_steps`, `crm_cadence_enrollments`.

**Metas** (`Inteligência → Metas`): receita ganha, vendas, reuniões marcadas, ligações e negociações abertas,
por empresa ou vendedor, semanal/mensal/trimestral. `crm_goals_progress` devolve realizado, % e ritmo esperado.
Ligações e reuniões vêm de `crm_activity_events` (discador + tarefas de ligação/reunião), sem contagem dupla.

**Assistente (voz/texto)**: botão "Registrar" (tecla V), "Contar como foi" no Discador e "Registrar" no contato.
O ditado usa o reconhecimento de voz do próprio navegador (pt-BR). A função `crm-assistant` monta um plano
(IA configurada em `AI_PROVIDER`/`AI_API_KEY`; sem IA, regras em `_shared/assistant-rules.ts`) e **não grava**;
o usuário confere e `crm_assistant_apply` grava com RLS. Nunca marca venda ganha/perdida e reaproveita contato
(telefone) e negociação aberta.

**Extensão do WhatsApp Web** (`extension/whatsapp-crm`, empacotada no build em `/extensao/idx-crm-whatsapp.zip`):
painel ao lado da conversa com cliente, negociação (etapas em andamento), tarefas, histórico, "Registrar com IA",
retorno rápido e cadência. Login com o usuário do painel (sessão no `chrome.storage`), só chave pública;
o build recusa chave service role/secret. Instalação: Configurações do CRM → Extensão WhatsApp.

Testes: `tests/crm/cadences-goals.test.mjs`, `tests/crm/assistant-fn.test.mjs`, `tests/fn/assistant-rules.test.ts` (Deno),
`tests/crm/revops-ui.mjs`, `tests/ext/extension-ui.mjs`.

## Disparos de WhatsApp (FlowZap dentro do CRO)

O antigo FlowZap (sistema separado, Next.js + SQLite) virou um módulo do CRO:

- **Motor único de WhatsApp** (`services/wa-gateway`, Baileys — mesma base do FlowZap): conexão por QR, envio,
  recebimento e status de leitura. Grava em `whatsapp_contacts / conversations / messages`, então **Caixa de entrada,
  CRM, cadências (param quando o cliente responde) e Disparos usam a mesma conexão** — não há duas sessões brigando
  pelo mesmo número. Roda na VPS como container sem porta exposta; usa a chave pública + `GATEWAY_TOKEN`
  (no banco só o sha256, em `wa_gateway_tokens`). Não usa service role.
- **Fila única** `wa_outbox`: respostas manuais (caixa de entrada, "Enviar pelo CRO" em tarefas/contatos) e mensagens
  de campanha. Manuais têm prioridade. Nada sai sem clique de uma pessoa.
- **Disparos** (`wa_campaigns`, `wa_campaign_recipients`): público da lista do discador (com filtros; ignora
  "sem interesse"/"inválido"), CSV/colar ou contatos do CRM; até 5 variações + `{a|b}`; variáveis
  `{nome} {primeiro_nome} {empresa} {cidade}` e colunas extras.
- **Proteções no banco** (`wa_gw_claim`, não dá para pular pela tela): intervalo aleatório (mín. 15 s, padrão 25–60 s),
  limite diário por número (padrão 200, máx. 500), janela de horário no fuso da empresa (padrão 8h–20h), rodapé
  "responda SAIR", descadastro automático por SAIR/PARAR/STOP (`wa_optouts`) respeitado em tudo, envio interrompido
  nunca é reenviado sozinho (evita duplicar), número inexistente vira "Sem WhatsApp" (checa com e sem o 9º dígito).
- Resposta a um disparo: marca "respondeu", avisa quem iniciou (sino) e cria contato + negociação em "Novo lead" (1ª etapa do funil padrão) se ainda não houver uma aberta. Quem pediu SAIR não vira lead.
- Discador: "Conversou", "Retornar" e "Reunião" criam contato + negociação em "Novo lead" (uma por contato). "Não atendeu", "Sem interesse" e "Número inválido" não criam negociação.

Correções em relação ao FlowZap original: reconexão não desiste após 3 tentativas; checagem do número antes de enviar
(9º dígito); mensagens enviadas pelo celular entram no histórico; conversas com ID oculto (`@lid`) usam o número
alternativo; intervalo fixo de 10 s substituído por aleatório + limites; retomada segura após reinício.

Testes: `tests/crm/wa-dispatch.test.mjs` (regras no banco), `services/wa-gateway/test` (motor com WhatsApp simulado),
`tests/crm/dispatch-ui.mjs` (telas).

## Busca automática de clientes (Google Maps → Discador → Disparos)

- Usa a **API oficial Google Places (New) – Text Search** (não raspa o site). A chave é colada pelo gestor em
  Disparos → Buscar clientes → Configurar; a função `maps-leads` guarda criptografada (`maps_settings`, AES-GCM com
  `ENCRYPTION_KEY`) e a tela só vê os 4 últimos caracteres.
- **Fontes salvas** (`lead_sources`): termo + cidades/bairros (ordem mantida). Cada execução usa os próximos
  `locations_per_run` locais (rodízio), até 3 páginas (60 resultados) por local.
- Entram no discador (`crm_dial_leads`) com posição na busca, nota, avaliações, endereço, link e site
  (`source = google_places`). Não entram: duplicados (place_id ou telefone em qualquer lista), sem telefone,
  fechados, quem pediu SAIR, redes/franquias (opcional) e abaixo da nota mínima (opcional).
- **Automático**: o motor de WhatsApp chama `maps-leads {action:"cron"}` a cada 10 min com seu token; só rodam as
  fontes vencidas (diário/2 dias/3 dias/semanal, no horário escolhido, fuso da empresa).
- **Alimentar disparo**: a fonte pode apontar para um disparo com *alimentação automática* (`wa_campaigns.auto_feed`);
  os novos clientes entram na fila dele (com variáveis `{empresa} {cidade} {bairro} {nota} {avaliacoes} {posicao}`)
  e o disparo não “termina” quando a fila zera — espera os próximos. Todas as proteções de envio continuam valendo.
- **Custo**: limite mensal de chamadas (padrão 900) em `maps_usage`; a execução para ao atingir o limite.
- Testes: `tests/crm/maps-leads.test.mjs` (Places simulado), `tests/crm/maps-ui.mjs`.

## Conector MCP do CRO (Claude e outras IAs)

- Função `cro-mcp` (Model Context Protocol, transporte Streamable HTTP/JSON; testada com o SDK oficial de cliente).
- Tokens pessoais `cro_…` criados em **Claude e IA (MCP)** (por usuário e empresa; “somente consultar” ou
  “consultar e agir”). Só o sha256 fica no banco; revogação imediata; registro de todas as chamadas em `mcp_calls`.
- Cada ferramenta roda **como o dono do token** (`idx_private.mcp_auth` define `auth.uid()`), então valem as mesmas
  permissões e o mesmo isolamento por empresa do CRM. Lógica em `public.mcp_call` (service role apenas).
- Ferramentas de leitura: `resumo_comercial`, `buscar_contatos`, `ver_contato`, `listar_negociacoes`, `listar_tarefas`,
  `discador`, `listar_disparos`, `ver_disparo`, `conversas_whatsapp`, `buscas_google_maps`.
- Ações (token “consultar e agir”): `criar_contato`, `criar_tarefa`, `concluir_tarefa`, `adicionar_nota`,
  `registrar_ligacao`, `enviar_whatsapp`, `controlar_disparo`, `rodar_busca_google_maps` — passam pelas mesmas
  proteções (SAIR, fila, horário, limites). A IA é instruída a pedir confirmação antes de enviar/alterar.
- Prompts prontos: `rotina_do_dia`, `analisar_disparos`, `prospectar_farmacias`.
- Conexão: Claude.ai → Conectores → personalizado com `…/functions/v1/cro-mcp/<token>`; Claude Code
  `claude mcp add --transport http cro <url> --header "Authorization: Bearer <token>"`; outros clientes via cabeçalho.
- Testes: `tests/crm/mcp.test.mjs` (SDK oficial), `tests/crm/mcp-ui.mjs`.

## Rotinas automáticas e saúde do sistema

- O projeto não tem `pg_cron`; antes, as automações agendadas do CRM só rodavam quando alguém abria o CRM.
  Agora o motor (`idx-wa-gateway`, sempre ligado) chama:
  - a cada 10 min `maps-leads {action:"cron"}` (buscas no Google Maps vencidas);
  - de hora em hora `cro-cron`: `crm_run_scheduled_all()` (negociação parada, tarefas, RFV), `cro_ops_notifications()`
    (aviso aos donos/admins: acesso da Meta vencendo em ≤14 dias ou vencido, Meta/Google com erro, WhatsApp do CRO
    desconectado há >30 min) e sincronização diária dos gastos da Meta (7 dias, empresas conectadas, ~1x/20 h).
- Sincronização da Meta extraída para `_shared/meta-sync.ts` e agora lê **todas as páginas** (antes parava em 500 linhas)
  e não grava o token no `last_error`.
- `cro_jobs` guarda a última execução de cada rotina; **Configurações do CRM → Saúde do sistema** mostra motor,
  rotinas, WhatsApp, Meta (com dias até vencer), Google Ads, Google Maps e processos ligados.
- O painel lembra a última empresa escolhida no navegador.
- Testes: `tests/crm/cro-cron.test.mjs` (Meta simulada), `tests/crm/health-ui.mjs`.

## Automações de WhatsApp (editor visual, estilo FlowZap/Kommo/n8n)

- **Onde**: menu *Automações WhatsApp* (`?section=crm-app&crm=flows`). Lista com modelos prontos (boas-vindas com menu, fora do horário, resposta de disparo, qualificação, recuperar lead frio, atendimento com IA) e editor visual (`web/src/crm/flows/*`, `@xyflow/react`, carregado sob demanda).
- **Núcleo único**: `supabase/functions/_shared/flow-core.ts` (puro TS) roda no servidor (Edge Function `cro-flows`) e no **simulador** do editor — o que se testa no navegador é exatamente o que roda de verdade. Testes: `tests/flows/flow-core.test.ts`.
- **Blocos**: gatilho (palavra-chave inteligente com erro de digitação/sinônimos, primeira mensagem, qualquer mensagem, respondeu disparo, etiqueta, etapa do funil, manual, webhook), mensagem (variações e `{a|b}`), mídia por link, menu numerado, pergunta que salva resposta, resposta com IA, esperar, aguardar resposta, horário comercial, condição, teste A/B, etiqueta, negociação no funil (nunca marca ganho/perda), tarefa, distribuir (rodízio), avisar equipe, salvar dado, marco (não é venda), webhook de saída, passar para atendente, SAIR, fim.
- **Banco** (`20261117120000_wa_flows.sql`): `wa_flows`, `wa_flow_runs` (uma execução aberta por contato/fluxo), `wa_flow_events` (números por bloco), `wa_flow_queue` (mensagens recebidas, etiquetas, etapas, inícios manuais/webhook). Mensagens saem pela fila única `wa_outbox` (source `flow`, com mídia), pela mesma conexão do CRO.
- **Motor**: o serviço `wa-gateway` chama `cro-flows` logo após cada mensagem recebida e a cada 30 s (esperas vencidas). Proteções: SAIR nunca recebe; robô para quando atendente assume (`bot_mode = human`) ou respondeu há < 30 min; reentrada configurável; início manual espaçado 25–60 s; máximo 200 por vez.
- **Webhook de entrada**: `POST {SUPABASE_URL}/functions/v1/cro-flows/hook/<id>/<segredo>` com `{"telefone": "...", "nome": "...", ...}`; o segredo fica em `wa_flow_hooks` (sem acesso pela API) e aparece só para gestores no editor. Campos extras viram `{var.trigger.campo}`.
- Testes: `tests/flows/flows-integration.test.mjs` (ponta a ponta com a Edge Function), `tests/flows/flows-ui.mjs` (interface).

## Extratores de clientes e atendimento em equipe

- **Disparos → Buscar clientes**: *Busca automática* — o mesmo extrator do FlowZap original (`_shared/flowzap-auto-extract.ts`, ação `auto_extract` de `maps-leads`): ramo + cidade → 7 variações de busca × até 3 páginas, até 120 clientes com telefone; para sozinha antes do limite de tempo da função e avisa (`partial`), *Colar números* (acha telefones/nomes em qualquer texto) e *Grupos do WhatsApp* (lista os grupos do número conectado e importa participantes com número visível; exige aceitar o aviso de risco; só gestores). Tudo vai para Contatos com etiqueta (`crm_contacts_tag_import`) e, se escolhido, para uma lista do discador. Migração `20261118120000_lead_extractors.sql`; os pedidos de grupos são executados pelo motor (`wa_group_jobs`).
- **Disparos → Quem vai receber → Contatos com etiqueta**.
- **Caixa de entrada**: responsável por conversa (transferir avisa a pessoa), concluir/reabrir (volta sozinha quando o cliente escreve), filtros Abertas/Minhas/Sem responsável/Concluídas, robô x atendente e respostas rápidas (digite `/`). Migração `20261119120000_inbox_team_hooks.sql`.


## Atribuição de campanha → WhatsApp → venda

1. O clique em `/go/<código>` grava a sessão (`tracking_sessions`, com `ref` `xxxx-xxxx`, UTMs e IDs de anúncio) e abre o WhatsApp com a mensagem pronta contendo `Ref: xxxx-xxxx`.
2. A página de redirecionamento confirma a entrada (`/go/confirm`), que é atômica: o Lead (CAPI) vai uma vez só. A confirmação tenta de novo por alguns segundos se o clique ainda não foi gravado.
3. Quando a mensagem chega, o motor (gateway) também chama `/go/confirm` com o código lido do texto — o Lead vai mesmo se o navegador não avisou.
4. O gatilho `trg_wa_link_tracking_ref` (migração `20261121120000_audit_fixes.sql`) lê o código da mensagem recebida e liga conversa, contato (origem `known`, UTMs, primeira sessão) e negócio aberto à campanha — sem criar negócio duplicado — e grava o telefone na sessão.
5. Venda confirmada por telefone (`convert`, `n8n-webhook`) aceita o número em qualquer formato (com/sem 55, com/sem o 9º dígito — `_shared/phone-variants.ts`). Falha do Meta ao atualizar públicos nunca derruba a confirmação da venda.


## Conexão única do WhatsApp

Uma conexão por empresa (QR Code do próprio CRO, motor `wa-gateway`) atende tudo: caixa de entrada e respostas, disparos, automações, cadências e a leitura das conversas pela IA.
- Todas as escolhas de conexão (conectar, enviar, criar/iniciar disparo, automações, saúde) usam a mesma ordem: conectada e ligada primeiro.
- A leitura pela IA que antes só acontecia pelo fluxo antigo (Evolution + n8n) agora roda para a conexão do CRO: `cro-flows` pega as conversas com mensagens novas do cliente (`wa_ai_claim`, janela de 8 s, últimos 2 dias), chama `ai-analyze` e, se houver sinal de venda, `sale-confirm` (`auto_process`). Chamadas internas usam a chave de serviço (nunca no navegador).
- Evolution API, n8n e chaves de webhook ficaram em "Integrações avançadas" na tela WhatsApp → Conexão (só para quem já usa).


## Duas conexões do WhatsApp: QR Code ou API oficial da Meta

Cada empresa escolhe em **WhatsApp → Conexão** qual conexão usa para enviar (`wa_channel_settings.active_provider`):
- **QR Code** (`gateway`): motor do CRO na VPS (Baileys). Lê grupos e extrai contatos; não é oficial.
- **API oficial** (`cloud_api`): Meta WhatsApp Cloud API, função `wa-cloud`.

Tudo que envia (respostas, disparos, automações, cadências) usa a conexão ativa (`idx_private.wa_active_instance`). As duas recebem mensagens na mesma caixa de entrada, com automações, IA de vendas e atribuição (`Ref:`).

API oficial (`supabase/functions/wa-cloud`, regras puras em `_shared/wa-cloud-core.ts`):
- Configuração: Phone Number ID, WABA ID, token permanente e (recomendado) a chave secreta do app. Token e chave ficam criptografados (`wa_cloud_credentials`, sem acesso pelo navegador). "Salvar e testar" confere o número na Meta, liga o app à conta (`subscribed_apps`) e baixa os modelos aprovados (`wa_templates`).
- Webhook: `/functions/v1/wa-cloud/webhook/<id>` com o token de verificação mostrado na tela; assinatura `X-Hub-Signature-256` conferida quando há chave secreta. Mensagens entram por `wa_gw_ingest`; status (entregue/lido/falhou) por `wa_cloud_status`.
- Envio: a fila `wa_outbox` é enviada por `wa-cloud` (logo após cada envio pela tela, após mensagens recebidas e a cada rodada de 30 s do motor). Usa `wa_gw_claim`/`wa_gw_result` com a chave de serviço e token nulo — as mesmas regras de horário, limite diário e SAIR.
- Janela de 24 h: fora dela só modelo aprovado. A caixa de entrada troca a resposta por "Enviar modelo"; disparos exigem um modelo (`wa_campaign_set_template`, variáveis `{nome}`, `{empresa}`…).
- Erros da Meta viram mensagens claras (janela de 24 h, número sem WhatsApp, limite, token vencido).


## E-mails de acesso (Resend)

Convites, "Receber link no email", "Esqueci minha senha" e confirmação do primeiro acesso saem pelo Resend (`_shared/email.ts`). O envio padrão do Supabase só entrega para a equipe do projeto (2 por hora), por isso os convites não chegavam.

- Segredos das Edge Functions: `RESEND_API_KEY`, `RESEND_FROM` (remetente de domínio verificado no Resend, ex.: `IDX CRO <acesso@sanmarfidelize.com>`), opcional `RESEND_REPLY_TO`. `APP_URL` define para onde o link leva.
- Supabase Auth → URL Configuration: Site URL = endereço do painel e o mesmo endereço em Redirect URLs (senão o link leva para outro lugar).
- `tenant-admin` `invite_user` / `resend_invite`: cria o acesso (ou acha a conta existente — antes dava erro para quem já tinha conta em outra empresa), vincula à empresa e manda o e-mail com o link (gerado por `auth.admin.generateLink`, sempre `…/auth/v1/verify`). A situação do envio fica em `tenant_invites.email_status/email_error/email_sent_at` e aparece na lista de acessos com o botão "Reenviar acesso".
- `auth-email` (público): link de acesso e nova senha; só envia para quem tem conta, sempre responde igual (não revela quem tem acesso), limite de 3 pedidos por e-mail e 10 por origem por hora (`auth_email_requests`, só hashes).
- Quem entra pelo link do convite ou de nova senha vê "Crie a sua senha" (`user_metadata.password_set`).


### Conectar WhatsApp Oficial (cadastro incorporado da Meta)

Botão "Conectar WhatsApp Oficial" em WhatsApp → Conexão → API oficial (Embedded Signup da Meta):
1. A tela carrega o SDK do Facebook e abre `FB.login` com `config_id` (`WA_EMBEDDED_CONFIG_ID`), `response_type: code` e `sessionInfoVersion: 3`. A janela da Meta devolve o código e (por mensagem `WA_EMBEDDED_SIGNUP`) a conta (WABA), o número e o Business Manager escolhidos pelo cliente.
2. `wa-cloud` `embedded_connect`: troca o código pelo token da empresa (`META_APP_ID`/`META_APP_SECRET`), descobre conta/número pelo `debug_token` se a janela não informou, guarda tudo criptografado (`wa_cloud_credentials.source = 'embedded'`), registra o número (`/register` com PIN de 6 dígitos guardado criptografado; "já registrado" não é erro), liga o webhook da conta ao endereço da empresa (`subscribed_apps` com `override_callback_uri` + `verify_token`), confere o número e baixa os modelos.
3. A assinatura do webhook usa a chave do app da IDX.

Configuração no app da Meta (uma vez): produto WhatsApp + Facebook Login for Business; em Login for Business → Configurações, criar uma configuração do tipo "Cadastro incorporado do WhatsApp" com as permissões `whatsapp_business_management` e `whatsapp_business_messaging` (e `business_management`); o ID dela vai no segredo `WA_EMBEDDED_CONFIG_ID`. O domínio do painel precisa estar em "Domínios permitidos para o SDK JavaScript". Para clientes fora do Business Manager da IDX, o app precisa de acesso avançado a essas permissões (análise da Meta / Tech Provider).


## Douratto Buffet: automações do Kommo recriadas

`scripts/douratto/flows.mjs` recria os salesbots do Kommo da Douratto (lidos da conta dourattobuffet):
- **Douratto - Escolas - Fim de Ano 2026** (sondagem): gatilho "respondeu o disparo" com o modelo `douratto_escolas_sondagem_2026`. "Já planejamos" → botões "Quero receber / Agora não" → PDF; "Ainda avaliando" → botões "Quero conhecer / Agora não" → PDF; "Não vamos realiza" → agradecimento. Etapas "Contato feito" e "Apresentação enviada"; outras respostas avisam a equipe.
- **FIM DE ANO - ESCOLAS** (qualificação): gatilho "respondeu o disparo" com o modelo `douratto_escola_proposta` ({{1}} primeiro nome, {{2}} escola). "Quero ver" → mensagem + PDF → "Apresentação enviada" → Nº de pessoas → Data pretendida (campos `numero_pessoas` e `data_pretendida`) → "Qualificado" + tarefa "Montar proposta". 24 h sem resposta → tarefa, sem insistir. Pedido para parar → confirmação, etiqueta "opt-out marketing", tarefa e descadastro.
- Funil "Confraternização Fim de Ano 2026" com as mesmas etapas do Kommo. Automação não marca ganho/perda (regra do CRO): o opt-out vira tarefa em vez de "Venda perdida".

Recursos novos usados: menu com **botões de resposta** (API oficial; no QR Code sai numerado), negociação **criar ou mover**, **arquivo do computador** no bloco de mídia (função `flow-media`, link público, até 16 MB) e **confirmação automática do SAIR** (texto em `wa_channel_settings.optout_reply`). Teste: `tests/flows/douratto.test.mjs`.
