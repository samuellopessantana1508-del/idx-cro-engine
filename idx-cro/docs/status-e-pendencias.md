# IDX CRO Engine — status e pendências

Análise feita em 09/10/2026 sobre o código desta pasta (`idx-cro/`).
Build (`npm run build`) e testes de contrato (`npm run test:edge`) passam.

## O que é o software

Smart Link → página de passagem (`ir.html`) → WhatsApp. Cada clique vira uma sessão
com UTMs, `fbclid/fbc`, IP e user-agent. O atendente move o lead no CRM e cada etapa
manda um evento para o Meta via CAPI. Os gastos do Meta Ads são importados e cruzados
com leads, qualificados e vendas por campanha.

| Peça | Onde | Situação |
| --- | --- | --- |
| Smart Link + sessão | `supabase/functions/go` | Pronto |
| Confirmação de entrada no WhatsApp + `Lead` CAPI | `go/confirm` + `web/public/ir.html` | Pronto, com 1 bug (P0-6) |
| CRM (pipeline, histórico, follow-up, tags) | `supabase/functions/crm` | Pronto |
| Eventos CAPI por etapa (Contacted, Qualified, Disqualified, Lost, Purchase) | `crm`, `convert` | Pronto, com dedup de `event_id` |
| Públicos automáticos (qualificados, compradores) | `meta-audiences` | Pronto |
| Conexão Meta (manual Pixel+Token ou Facebook Login) | `meta-oauth`, `meta-assets` | Pronto |
| Importação de gasto Meta Ads | `meta-insights` | Só nível campanha, só manual (P0-2, P0-7) |
| ROI por campanha | `vw_meta_campaign_roi` | Funciona, mas os números distorcem (P0-1, P0-3, P0-5) |
| Multiempresa, RLS, convites, papéis | migrations + `tenant-admin` | Pronto |
| Painel | `web/src/App.tsx` | Funciona; KPIs calculados errado com volume (P0-4) |

**Resumo:** a captura e o CRM estão prontos. O que ainda não está confiável é
justamente a promessa central: **dizer com precisão qual campanha, conjunto e anúncio
gerou venda.** São esses os itens P0.

## P0 — sem isso o relatório "qual campanha deu resultado" não é confiável

1. **Atribuição depende de texto livre em `utm_campaign`.**
   A sessão só guarda UTMs. O cruzamento com o Meta acontece quando `utm_campaign`
   é igual ao ID ou ao nome exato da campanha (`vw_meta_campaign_roi`). Se o gestor
   renomear a campanha ou digitar diferente, os leads ficam órfãos. A tabela
   `meta_campaign_mappings` existe para corrigir isso, mas **não há tela no painel**
   para preencher.
   *Fazer:* padronizar o link do anúncio com parâmetros dinâmicos do Meta
   (`utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`, ou
   colunas próprias `meta_campaign_id/adset_id/ad_id` capturadas pelo `go`), gerar
   essa URL pronta no painel e criar a tela de mapeamento manual para casos antigos.

2. **Gasto importado só no nível de campanha.**
   `meta-insights` usa `level=campaign`. Não dá para dizer qual conjunto (público)
   ou qual anúncio (criativo) vendeu.
   *Fazer:* importar também `level=adset` e `level=ad` (tabelas ou coluna `level`)
   e montar o ROI nos três níveis.

3. **ROI mistura períodos.**
   A view soma o gasto da janela sincronizada (30 dias) com os leads e vendas de
   **todo o histórico**. CPL, custo por qualificado e ROAS ficam errados assim que
   a conta tem mais de 30 dias. O painel não tem filtro de período.
   *Fazer:* trocar a view por uma função SQL `campaign_roi(tenant, since, until)` que
   filtra gasto por `date_start` e leads por `clicked_at`, e adicionar seletor de
   período (7/30/90 dias, mês atual, personalizado).

4. **KPIs e "Qualidade por campanha" são calculados com só as últimas 100 sessões.**
   O painel carrega `vw_lead_queue` com `.limit(100)` (`web/src/App.tsx:825`) e calcula
   vendas, receita (`App.tsx:425`) e a tabela de qualidade (`buildQualityRows`,
   `App.tsx:396`) em cima disso. Com volume real, os totais ficam menores do que
   são. As views `vw_lead_quality_report` e `vw_tenant_report` já existem no banco
   e não são usadas.
   *Fazer:* KPIs e relatórios vindos de agregação no banco (views/funções),
   e a lista do CRM com paginação.

5. **Definição de "lead" diferente entre painel e Meta.**
   O `Lead` CAPI só vai quando o `ir.html` confirma a abertura do WhatsApp
   (`whatsapp_opened_at`). Mas a migration `20260724180000_revert_lead_views_to_all_sessions.sql`
   fez as views contarem **todo clique** como lead (foi uma correção de emergência
   quando a confirmação parou de funcionar; depois o `ir.html` voltou). Hoje o
   painel mostra mais leads do que o Meta recebeu.
   *Fazer:* separar `cliques` e `leads` (confirmados) em todas as views e no painel.

6. **Bug: confirmação pode chegar antes da sessão existir.**
   O `go` grava a sessão em segundo plano e redireciona na hora
   (`supabase/functions/go/index.ts:420`). Se o `ir.html` chamar `/go/confirm`
   antes do insert terminar, o update não encontra a linha e aquele `Lead` nunca é
   enviado.
   *Fazer:* no `confirm`, tentar de novo por alguns segundos quando não achar a
   sessão (ou gravar a confirmação pendente e aplicar no insert).

7. **Sincronização de gasto é só manual.**
   Depende de alguém clicar em "Sincronizar Meta Ads". Não existe agendamento.
   *Fazer:* `pg_cron` (ou agendador do Supabase) chamando a sincronização de todas
   as empresas conectadas, 1x por dia.

## P1 — para ser um produto de otimização, não só de medição

- **Recomendações acionáveis.** Hoje o "Resumo executivo" tem 4 regras simples.
  Falta: ranking de campanhas/conjuntos/anúncios por custo por qualificado e ROAS,
  alerta de "gastou X sem nenhum qualificado", sugestão de pausar/escalar com o
  motivo.
- **Aviso de token Meta vencendo.** O token longo é salvo com validade
  (`facebook_token_expires_at`), mas nada lê esse campo. Quando vence, a
  sincronização para em silêncio.
- **Relatório para o cliente.** Exportar PDF/link do relatório do mês.
- **Testes reais.** Hoje só há testes de contrato por texto e 3 testes E2E
  públicos. Falta testar as views de atribuição (dados de exemplo → números
  esperados) e o fluxo clique → confirmação → venda.

## P2 — manutenção

- `web/src/App.tsx` tem 3.700 linhas num arquivo só; dividir por tela.
- URL do Supabase fixa no `web/public/ir.html`; gerar no build.
- Token Meta salvo em texto na tabela (protegida por RLS, só `service_role`);
  considerar Supabase Vault.
- Build antigo do painel na raiz do repositório (09/07/2026) não tem `ir.html`.
  Confirmar qual hospedagem serve `idxparasuaempresa.com.br` (GitHub Pages pelo
  workflow ou Hostinger pela raiz) e apagar a cópia que não é usada.

## Ordem sugerida

1. P0-6 e P0-5 (bug e definição de lead): pequenos, corrigem dados já hoje.
2. P0-4 e P0-3 (números do painel e período): o relatório passa a bater.
3. P0-1 e P0-2 (IDs dinâmicos + nível conjunto/anúncio): passa a apontar o criativo vencedor.
4. P0-7 (sync diário) e aviso de token.
5. Recomendações e relatório para o cliente.
