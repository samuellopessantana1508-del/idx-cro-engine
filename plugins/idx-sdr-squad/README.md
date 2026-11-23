# idx-sdr-squad

Esquadrão de SDR com IA para a IDX, construído sobre padrões abertos e validados de agentes de vendas e integrado ao CRO (Google Maps, WhatsApp, discador, CRM).

## Agentes
| Agente | Função |
|---|---|
| `sdr-orquestrador` | Lê o funil no CRO e decide a próxima melhor ação |
| `sdr-prospector` | Acha e pontua negócios locais no Google Maps |
| `sdr-qualificador` | BANT adaptado, mini-diagnóstico, prioridade e canal |
| `sdr-redator` | Primeira mensagem, cadência de follow-up, e-mail, roteiro de ligação |
| `sdr-closer` | Classifica a resposta, contorna objeções, agenda a reunião |
| `sdr-analista` | Mede o funil e recomenda experimentos |

## Skills (conhecimento)
`playbook-vendas-idx` · `oferta-idx` · `copy-whatsapp-frio` · `objecoes-trafego-local` · `persuasao-etica` · `sinais-de-compra-local` · `compliance-lgpd-whatsapp`

## Comandos
`/sdr-campanha <nicho> <cidade> [qtd]` · `/sdr-responder <lead ou texto>` · `/sdr-funil`

## Instalar
```
/plugin marketplace add samuellopessantana1508-del/idx-cro-engine
/plugin install idx-sdr-squad@idx-plugins
```
Requer o conector **CRO - IDX** ativo.

## Antes de usar
1. Preencha os campos `PREENCHER` em `skills/oferta-idx/SKILL.md`. Os agentes só afirmam o que está lá.
2. Comece com lotes pequenos e acompanhe sinais de bloqueio no WhatsApp.

## Segurança
Os agentes geram **rascunhos**. Nenhum envio, disparo ou ligação ocorre sem confirmação explícita. Opt-out é permanente. Venda é marcada manualmente no CRO. Detalhes em `skills/compliance-lgpd-whatsapp`.

Créditos e licenças das bases aproveitadas: `THIRD_PARTY_NOTICES.md`.
