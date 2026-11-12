# Motor de WhatsApp do IDX CRO Engine (wa-gateway)

Conexão por QR (Baileys, mesma base do FlowZap), envio da fila e recebimento de mensagens.
Grava tudo nas tabelas do CRO (`whatsapp_*`), então Caixa de entrada, CRM, cadências e Disparos usam
**uma única conexão por número**.

- Sem service role: usa a chave pública + `GATEWAY_TOKEN` (o banco guarda só o sha256 em `wa_gateway_tokens`).
- Sem porta exposta: só faz conexões de saída (Supabase e WhatsApp).
- As regras de disparo (intervalo, limite diário, horário, SAIR) ficam no banco (`wa_gw_claim`).

## Variáveis
| Variável | |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_ANON_KEY` | chave pública (`sb_publishable_…`) |
| `GATEWAY_TOKEN` | segredo gerado na própria VPS (`openssl rand -hex 32`) |
| `SESSIONS_DIR` | padrão `/data/sessions` (volume) |

## Rodar
```bash
docker build -t idx-wa-gateway services/wa-gateway
docker run -d --name idx-wa-gateway --restart unless-stopped --env-file /opt/idx/wa-gateway.env \
  -v idx-wa-sessions:/data idx-wa-gateway
```
Registrar o token (só o hash vai para o banco):
```sql
insert into wa_gateway_tokens(token_hash, label) values ('<sha256 do token>', 'vps');
```

## Testes
`npm test` (util + integração com WhatsApp simulado contra a stack local; requer `ANON_KEY`).
