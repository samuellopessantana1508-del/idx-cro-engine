# Análise de conversas (IA) — regras anti-invenção

## O que causava o erro

- O prompt citava literalmente "João Silva", "Corte de cabelo" e "Achei caro" como
  exemplos proibidos. Modelos pequenos (qwen2.5:1.5b) copiam o que aparece no prompt.
- A análise anterior era reenviada à IA com a ordem "não descarte dados anteriores":
  um erro passava para todas as análises seguintes.
- O resumo livre da IA ia direto para o painel; só um texto igual a um placeholder era bloqueado.
- `messages_analyzed_count` somava a cada execução (2 mensagens lidas duas vezes = "4 mensagens").
- Em conversas longas, a análise lia as 80 mensagens mais antigas e ignorava as novas.

## Como funciona agora (`supabase/functions/_shared/ai-grounding.ts`)

1. O prompt não tem nenhum exemplo de dado e leva só esta conversa, desta empresa,
   com o nome do cliente registrado no WhatsApp/CRM e o segmento informado.
2. A resposta da IA é validada campo a campo contra as mensagens:
   - nome: só se estiver escrito na conversa (o nome exibido é o do WhatsApp/CRM);
   - produto: precisa aparecer na conversa; sem produto → "produto não identificado";
   - objeção: precisa estar escrita pelo cliente;
   - valor: o número precisa estar na conversa;
   - sinal de venda: o trecho citado precisa existir e a etapa precisa ser sustentada pelas regras.
3. A etapa comercial sai de regras sobre as mensagens do cliente:
   interesse → intenção forte → negociação → compra declarada → venda confirmada
   (só com confirmação escrita pela EMPRESA) / desistência.
4. O resumo é escrito a partir dos fatos validados, nunca do texto livre da IA.
5. Se a IA falhar ou devolver JSON inválido, a análise sai só das regras.

Exemplo (Rede Sanmar): mensagens "Eu estou interessado" e "Quero comprar" →
"Arthur IDX demonstrou interesse em comprar, mas ainda não informou qual produto
ou serviço deseja. Nenhuma objeção foi identificada."

## Reprocessar análises antigas

Edge Function `ai-analyze` (dono/admin da empresa ou chave de webhook da empresa):

```json
{"action": "reprocess_tenant", "tenant_id": "<id>"}                 // só as contaminadas
{"action": "reprocess_tenant", "tenant_id": "<id>", "all": true}    // todas
{"action": "reprocess_conversation", "tenant_id": "<id>", "conversation_id": "<id>"}
```

Mensagens e conversas não são apagadas. Sinais `detected` sem trecho real na conversa
viram `rejected`; sinais `confirmed`/`converted` não são alterados. No painel, o botão
"Reanalisar" (rodapé da análise da conversa) faz o mesmo para uma conversa.

## Isolamento entre empresas

- Todas as consultas da análise filtram `tenant_id` + `conversation_id`.
- A ingestão (`n8n-webhook`) recusa (`instance_tenant_mismatch`) mensagens de uma
  instância do WhatsApp já registrada em outra empresa.
- Em mensagens enviadas pela empresa (`fromMe`), o `pushName` (nome do WhatsApp da
  empresa) não substitui mais o nome do cliente.
