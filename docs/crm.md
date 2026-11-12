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
- Resposta a um disparo: marca "respondeu" e avisa quem iniciou (sino).

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
