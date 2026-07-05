# Treinamento de Campanhas Meta Usando IDX

Este material mostra como rodar campanhas no Meta Ads usando Smart Links, CAPI, CRM e públicos automáticos da IDX.

## Princípio

O anúncio não deve mandar o usuário para uma página com fricção. O fluxo recomendado é:

Anúncio -> Smart Link IDX -> WhatsApp -> CRM -> Qualificação/Venda -> CAPI/Audiências -> Otimização.

## Configuração da campanha

1. Escolha objetivo compatível com conversa, lead ou venda.
2. Use criativo claro com oferta local.
3. Direcione o clique para o Smart Link IDX.
4. Garanta UTMs por campanha/criativo.
5. Monitore lead qualificado e venda no painel IDX.

## Padrão de UTM

Use nomes padronizados:

- `utm_source=meta`
- `utm_medium=paid`
- `utm_campaign=segmento-cidade-oferta-mes`
- `utm_content=criativo-angulo-versao`
- `utm_term=publico-ou-conjunto`

Exemplo:

`utm_campaign=autoescola-rio-verao-2026`
`utm_content=video-prova-social-v1`
`utm_term=lookalike-qualificados`

## Eventos enviados

- `Lead`: clique real no Smart Link.
- `ContactedLead`: atendimento avançou para contato.
- `QualifiedLead`: lead bom, entra em remarketing.
- `DisqualifiedLead`: lead ruim.
- `LeadLost`: oportunidade perdida.
- `Purchase`: venda confirmada.

## Como otimizar

Não otimize só por quantidade de WhatsApp. Compare:

- campanha com maior volume;
- campanha com menor custo por qualificado;
- campanha com menos lead ruim;
- campanha com maior venda;
- campanha com maior ROAS.

Se uma campanha gera muitos leads ruins, ajuste criativo, público ou promessa.

## Remarketing

Use o público de qualificados para:

- prova social;
- oferta de retorno;
- depoimentos;
- urgência real;
- conteúdo educativo;
- WhatsApp follow-up.

Use o público de compradores para:

- exclusão de aquisição;
- venda complementar;
- recorrência;
- lookalike quando houver volume suficiente.

## Campanhas locais por segmento

Autoescola:

- oferta de matrícula;
- prova social;
- prazo para começar;
- documentação;
- localização.

Pet shop:

- banho e tosa;
- agenda do dia;
- pacotes;
- retirada/entrega;
- antes e depois.

Clínica:

- avaliação;
- procedimento;
- autoridade;
- antes e depois permitido;
- agenda e localização.

Consultoria:

- diagnóstico;
- reunião;
- estudo de caso;
- dor específica;
- prova de resultado.

## Erros comuns

- Usar link sem UTM.
- Trocar Smart Link sem atualizar anúncio.
- Marcar todo lead como qualificado.
- Não registrar venda no CRM.
- Rodar campanha sem Pixel/CAPI testado.
- Usar público de compradores para aquisição sem excluir compradores atuais.

## Rotina de otimização

1. Puxe gastos no Meta dentro da IDX.
2. Abra Qualidade por campanha.
3. Corte campanhas com custo alto por qualificado.
4. Aumente orçamento onde há qualificados e vendas.
5. Crie variações de criativo para campanhas com bom sinal.
6. Revise atendimento antes de culpar a campanha.

