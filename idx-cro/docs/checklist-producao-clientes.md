# Checklist de Produção para Clientes IDX

Use este checklist antes de implantar uma nova empresa.

## Produto

- Empresa criada no painel gestor IDX.
- Slug definido e link de acesso testado.
- Usuários convidados por email.
- Dados de empresa preenchidos.
- WhatsApp com DDI e DDD.
- Primeiro Smart Link criado com UTM.
- Link aberto e redirecionando para WhatsApp.

## Supabase

- Migrations aplicadas.
- Edge Functions implantadas.
- Secrets configurados.
- Auth com confirmação de email ativa.
- SMTP próprio configurado para envio confiável.
- Leaked password protection ativado no dashboard quando disponível no plano.
- Security Advisor sem erro crítico.
- Performance Advisor sem erro crítico.

## Meta

- Pixel ID salvo.
- Token CAPI salvo.
- Evento de teste enviado.
- Facebook Login conectado.
- Conta de anúncios selecionada.
- Pixel selecionado.
- Gastos sincronizados.
- Público de qualificados criado.
- Público de compradores criado.

## CRM

- Atendente treinado.
- Pipeline testado com lead real.
- Qualificação dispara `QualifiedLead`.
- Venda dispara `Purchase`.
- Público de qualificados recebe contato com telefone/email.
- Público de compradores recebe contato vendido.

## Campanhas

- Anúncios usam Smart Link IDX.
- UTM obrigatória preenchida.
- Criativos nomeados em `utm_content`.
- Conjuntos ou públicos nomeados em `utm_term`.
- Link testado depois de publicar.

## Entrega

- Dono da empresa recebeu acesso.
- Atendente recebeu treinamento.
- Gestor validou relatório sem dados falsos.
- Primeiro lead real acompanhado no CRM.
- Primeiro evento CAPI confirmado.

## Itens que dependem de painel externo

Alguns pontos não devem ficar hardcoded no repositório:

- variáveis do GitHub Pages (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_REDIRECT_BASE`);
- secrets do Supabase;
- SMTP;
- leaked password protection;
- aprovação/permissões do app Meta quando o produto for aberto para terceiros.

