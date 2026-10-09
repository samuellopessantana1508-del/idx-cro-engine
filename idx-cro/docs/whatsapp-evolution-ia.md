# WhatsApp (Evolution API) + IA de vendas

Esta integração resolve duas coisas:

1. **Leads reais.** O lead só conta quando a primeira mensagem da pessoa chega no
   WhatsApp da empresa. Clique repetido, robô e quem abriu o WhatsApp e não mandou
   nada deixam de contar.
2. **Venda lançada automaticamente.** A IA lê a conversa, identifica se houve venda,
   quem comprou e o valor, e lança a venda no CRM (com `Purchase` para o Meta).

## Por que os números estavam errados antes

| Causa | O que acontecia | Como ficou |
| --- | --- | --- |
| Toda sessão do link contava como lead (migration `20260724180000`) | 1 clique = 1 lead no CRM e nos relatórios | Lead = `lead_confirmed_at` preenchido |
| Mesma pessoa clicando várias vezes | Cada clique virava um lead novo | Clique repetido (mesmo IP e navegador em 30 min) aponta para o original (`duplicate_of`) e não conta |
| Previews e robôs (WhatsApp, Telegram, verificadores, scripts) | Viravam sessão | Filtrados no `go` (`isGenericBot`) |
| Painel somava só os últimos 100 registros | Vendas e receita subcontadas com volume | Totais vêm de `vw_tenant_report` e `vw_lead_quality_report` |
| Confirmação chegava antes da sessão ser gravada | Lead perdido | `go/confirm` tenta de novo por alguns segundos |
| Histórico | O backfill antigo marcou todo clique como "entrou no WhatsApp" | Só vira lead quem tem evidência: confirmação real, atendimento no CRM ou contato salvo |

**Depois de aplicar a migration, o número de leads do histórico vai cair.** Isso é a
correção, não perda de dados: os cliques continuam registrados.

## Como o lead é ligado à campanha

Quando a primeira mensagem chega, o sistema procura o clique de origem, nesta ordem:

1. **Ref no texto** (`Ref: a7k9-p2m4`, vem na mensagem pronta do Smart Link). Exato.
2. **Telefone** já salvo num lead aberto dos últimos 30 dias.
3. **Janela de tempo**: se a pessoa apagou a ref, liga ao clique que abriu o WhatsApp
   nos 10 minutos anteriores, **só se houver exatamente um** candidato.
4. Se nada bater, a conversa fica **sem origem rastreada** (orgânico, indicação,
   mensagem editada). Ela aparece no relatório como conversa, mas não é atribuída
   a nenhuma campanha.

O `Lead` enviado ao Meta passa a levar o telefone (hash), o que melhora o casamento
de eventos.

## Como a IA decide a venda

- Analisa a conversa quando chega mensagem com sinal de fechamento (pix,
  comprovante, fechado, pedido...) e, pelo agendamento, quando a conversa fica
  parada 15 minutos com mensagem nova.
- Conta como venda: cliente confirmou E houve pagamento, ou a empresa confirmou
  pedido/matrícula/agendamento com valor e o cliente aceitou. Pedido de preço,
  "vou pensar" e negociação sem fechamento não contam.
- **Confiança ≥ mínimo da empresa (padrão 85%) e valor identificado:** venda
  lançada sozinha (`sale_source = ai`) e `Purchase` enviado ao Meta.
- **Confiança entre 50% e o mínimo, ou sem valor:** fica em "Vendas detectadas pela
  IA" para o atendente confirmar (pode ajustar o valor) ou descartar.
- Conversa sem origem rastreada também pode virar venda: o sistema cria uma sessão
  "sem origem rastreada" para a receita entrar no faturamento.
- Limitações: áudio não é transcrito (aparece como "[áudio sem transcrição]") e a
  imagem do comprovante não é lida, só a legenda. Venda fechada só por áudio
  tende a cair em "aguardando revisão" ou não ser detectada.

## Implantação

1. Aplique a migration e publique as funções:

   ```bash
   supabase db push
   supabase functions deploy go --no-verify-jwt
   supabase functions deploy convert
   supabase functions deploy whatsapp --no-verify-jwt
   supabase functions deploy whatsapp-webhook --no-verify-jwt
   ```

2. Configure a chave da IA:

   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   # opcional, para reduzir custo: claude-sonnet-5-5 ou claude-haiku-5-5
   supabase secrets set ANTHROPIC_MODEL=claude-opus-5-5
   ```

3. Na Evolution API, crie uma instância por empresa e conecte o WhatsApp dela pelo
   QR Code.

4. No painel IDX, em **Integrações > WhatsApp (Evolution API)**, informe a URL da
   Evolution, o nome da instância e a API key, e clique em **Salvar e conectar**.
   O painel registra o webhook sozinho (`MESSAGES_UPSERT` e `CONNECTION_UPDATE`)
   e mostra "Conectado" quando a instância está com o WhatsApp aberto.

5. Agende a análise das conversas paradas (Supabase > SQL Editor). Precisa das
   extensões `pg_cron` e `pg_net` ativas em Database > Extensions:

   ```sql
   select cron.schedule(
     'idx-analisar-vendas-whatsapp',
     '*/15 * * * *',
     $$
     select net.http_post(
       url := 'https://SEU-PROJETO.supabase.co/functions/v1/whatsapp',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer SUA_SERVICE_ROLE_KEY'
       ),
       body := '{"action":"analyze_pending"}'::jsonb
     );
     $$
   );
   ```

   Sem o agendamento, a análise ainda roda quando chega mensagem com sinal de
   fechamento e pelo botão **Analisar agora**.

## Teste de ponta a ponta

1. Abra um Smart Link da empresa no celular e envie a mensagem pronta.
2. Em até alguns segundos o lead aparece em **Atendimentos** com a tag
   "entrou no whatsapp", e um `Lead` aparece em **CAPI**.
3. Responda pelo WhatsApp da empresa simulando um fechamento ("Fechado, R$ 150.
   Pode mandar o pix", e o cliente "Pix feito, segue o comprovante").
4. Clique em **Analisar agora**. A venda deve aparecer como "Lançada pela IA" ou
   "Aguardando revisão", com o trecho da conversa como evidência.

## Privacidade

As mensagens ficam salvas em `whatsapp_messages`, isoladas por empresa (RLS). A API
key da Evolution e o segredo do webhook só são lidos pelas Edge Functions. O texto
das conversas é enviado à API da Anthropic para a análise; inclua isso no contrato
e na política de privacidade do cliente.
