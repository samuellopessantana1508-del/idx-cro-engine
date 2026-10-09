# Treinamento do Atendimento - CRM IDX

Este material é para a pessoa que atende o lead no WhatsApp e movimenta o CRM da empresa.

## Objetivo

O CRM da IDX existe para transformar conversas de WhatsApp em dados úteis para venda, remarketing e otimização de campanha. Cada clique no Smart Link cria um lead real com ref, UTM, campanha, criativo e horário. O atendimento usa esse lead para registrar contato, qualificação, venda, perda ou lead ruim.

## Regra mais importante

Nunca marque um lead como qualificado ou vendido se você não tiver certeza de que nome, telefone ou email pertencem àquela conversa.

O sistema envia sinais para o Meta via CAPI e pode colocar o contato em público automático. Se o contato for salvo no lead errado, a campanha errada pode receber crédito.

## Etapas do pipeline

- Novo: clique chegou ao WhatsApp, mas ainda não teve avanço no atendimento.
- Contato: a equipe respondeu ou iniciou conversa.
- Remarketing: lead qualificado. É o mesmo grupo usado para público de remarketing.
- Ruim: lead sem perfil, fora da região, sem interesse real ou contato inválido.
- Venda: cliente comprou ou fechou contrato.
- Perdido: lead tinha potencial, mas não fechou.

## Como operar cada lead

1. Abra a aba CRM.
2. Procure pelo nome, telefone, ref ou campanha.
3. Confira oferta, campanha e horário do clique.
4. Preencha telefone, nome e email quando o WhatsApp não trouxe esses dados automaticamente.
5. Escreva uma nota curta sobre a conversa.
6. Defina próximo follow-up quando houver retorno combinado.
7. Use Contato, Qualificar, Vender, Ruim ou Perdido conforme o caso.

## Quando qualificar

Marque como Remarketing/Qualificado quando o lead tem potencial real de compra, demonstrou interesse e deve continuar sendo trabalhado. Essa ação dispara o evento `QualifiedLead` e tenta sincronizar o contato no público de qualificados do Meta.

Exemplos:

- Autoescola: pessoa pediu valores, documentos ou prazo para começar.
- Pet shop: pessoa perguntou agenda, banho, pacote ou retirada.
- Clínica: pessoa pediu avaliação, preço, disponibilidade ou procedimento.
- Consultoria: pessoa explicou contexto e quer proposta ou reunião.

## Quando marcar ruim

Use Ruim quando o contato não deve ensinar o Meta como bom lead.

Exemplos:

- Número inválido.
- Pessoa fora da região atendida.
- Curioso sem intenção.
- Mensagem sem relação com a oferta.
- Spam.

## Quando vender

Marque Venda apenas quando o fechamento aconteceu. Informe valor real da venda. O sistema dispara `Purchase` via CAPI e tenta sincronizar o contato no público de compradores.

Se você tiver a ref do lead, use a ref. Se não tiver, use telefone e nome. O sistema tenta localizar pelo contato, mas a responsabilidade final é conferir se aquele contato pertence à conversa certa.

## Proteção contra erro humano

O CRM mostra aviso quando o telefone já aparece em outro lead. Se isso acontecer:

1. Clique em Abrir lead.
2. Compare horário, campanha e conversa.
3. Salve a ação somente no lead correto.

Se você alterar nome, telefone ou email antes de qualificar ou vender, o sistema pede confirmação. Confirme somente se os dados pertencem exatamente àquele atendimento.

## Rotina diária

- Começo do dia: filtre Follow-up e responda pendências.
- Durante o dia: mova leads novos para Contato após responder.
- Depois de conversas boas: marque Remarketing/Qualificado.
- Depois de fechamento: marque Venda com valor real.
- Fim do dia: revise Sem contato e Ruim para limpar a base.

## O que não fazer

- Não inventar telefone ou email.
- Não qualificar todo mundo.
- Não vender sem valor real.
- Não usar dados de outro cliente no lead atual.
- Não apagar contexto importante da nota.

## Como saber se o lead certo converteu

A melhor atribuição acontece quando a mensagem do WhatsApp preserva a ref do Smart Link. Quando a ref não existe, o sistema usa telefone/email para localizar o lead mais provável. Por isso o atendimento deve sempre conferir campanha, horário e contexto antes de confirmar venda.

