---
name: sinais-de-compra-local
description: Catálogo de sinais observáveis (Google Maps, perfil, site, anúncios) que indicam dor e momento de compra em negócio local, e como transformar cada um em primeira linha de mensagem sem inventar fatos.
---

# Sinais de compra em negócio local

Adaptado do `signal_playbook` do Franco (MIT). Mensagem com sinal real recebe várias vezes mais resposta que mensagem genérica. **O sinal é o motivo de você escrever hoje. Diga em uma frase, como observação.**

## Regra central
Todo fato na mensagem vem de um sinal verificado ou de dado do CRO. Um fato errado é pior que uma generalidade honesta. Sem sinal, use a dor típica do nicho e diga que é típica.

## Sinais e ângulos
| Sinal observável | Ângulo | Exemplo (trocar pelo fato) |
|---|---|---|
| Nota alta, poucas avaliações | Prova social subutilizada | "4,9 no Google, mas só 11 avaliações. Quem pesquisa ainda confia pouco." |
| Nota baixa ou avaliações sem resposta | Reputação e atendimento | "Vi 3 avaliações recentes sem resposta no Google." |
| Poucas fotos, fotos antigas | Perfil abandonado | "O perfil tem 4 fotos, nenhuma recente." |
| Sem site ou link no perfil | Falta de destino | "No perfil não achei site nem link de WhatsApp." |
| Horário ou telefone desatualizado | Perda de cliente por erro | "O horário no Google está diferente do que vi no Instagram." |
| Concorrente aparece acima nas buscas do nicho | Posição local | "Buscando 'dentista infantil em [bairro]' vocês aparecem depois de X." |
| Está rodando anúncio sem WhatsApp ou sem rastreio (Biblioteca de Anúncios) | Anúncio sem retorno medido | "Vi que vocês anunciam no Instagram. Sabem quantas vendas vieram?" |
| Negócio novo (poucas avaliações, abriu há pouco) | Primeiros clientes | "Vi que vocês abriram há pouco. Como estão trazendo os primeiros clientes?" |
| Contratando atendente ou vendedor | Está crescendo e precisa de demanda | "Vi a vaga de atendente aberta. Demanda está sobrando ou faltando?" |
| Sazonalidade do nicho | Preparação de temporada | "Falta pouco para a alta do seu setor." |

## Qual vence quando há vários
Contratação ou anúncio rodando (momento de compra) > concorrente à frente (urgência) > perfil fraco (dor concreta) > sinal de reputação > nenhum sinal.

## Como observar (sem scraping agressivo)
Use os dados do Google Maps já coletados pelo CRO (`buscas_google_maps`), a Biblioteca de Anúncios da Meta (`ads_library_search`, quando disponível) e a pesquisa manual do perfil. Não colete dado pessoal além do necessário.

## Proibido
Dizer "vi seu post" se não viu. Citar número que não conferiu. Elogio vazio ("parabéns pelo trabalho!"). Listar tudo que você sabe sobre ele (parece vigilância): use **um** fato.
