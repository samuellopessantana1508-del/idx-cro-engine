# IDX — Sistema Operacional v2

Módulo operacional publicado em `https://sistemaidx.idxparasuaempresa.com.br/`.

## Escopo

- gestão de clientes;
- atividades com responsável, prioridade e prazo;
- POPs de análise e otimização;
- processos diários, semanais e mensais por cliente;
- persistência no projeto Supabase já utilizado pelo módulo.

## Melhorias desta versão

- identidade visual monocromática em branco, cinza e preto;
- nova aba **Atividades** dentro de cada cliente;
- visão de atividades abertas, previstas para hoje, atrasadas e cobertura de POP;
- modelos IDX para análise diária, otimização diária, revisão semanal e plano mensal;
- verificação automática dos sete critérios mínimos de qualidade do POP;
- fluxo padrão visível: analisar, diagnosticar, otimizar e documentar;
- filtros globais por status, cliente, responsável e tipo;
- processos recorrentes reescritos com decisões baseadas em evidências;
- avisos explícitos quando uma atividade fica salva apenas no navegador.

## Publicação

O módulo é um arquivo HTML estático e independente do painel React localizado em `web/`.
Publique o conteúdo desta pasta no diretório configurado para o subdomínio
`sistemaidx.idxparasuaempresa.com.br` na Hostinger.

Não substitua o `index.html` da raiz do repositório nem o build de `web/`: eles pertencem
ao IDX CRO Engine hospedado no domínio principal.

## Banco de dados

O esquema completo reconstruído está em
`supabase/migrations/20260822020000_create_idx_operational_database.sql`. Ele cria as
10 tabelas consumidas pelo módulo, índices, relacionamentos, validações e políticas
RLS para que apenas membros autorizados da equipe acessem os dados.

Análises e otimizações exigem cliente e POP com os sete critérios mínimos antes do
salvamento. Demais tipos de atividade continuam aceitando POP opcional.

O primeiro usuário criado no Auth torna-se administrador. Usuários posteriores só
recebem acesso quando o administrador registra previamente o e-mail pela função
`invite_idx_member`; criar uma conta no Auth, por si só, não libera os dados.

Tokens de acesso do Meta não ficam mais em tabela pública nem são enviados ao
navegador. O sistema grava a credencial pela função `save_client_meta_account`, e a
leitura fica restrita à integração server-side com papel `service_role`.

## Demonstração local

Para validar a interface interna sem usar dados reais, sirva esta pasta localmente e
acesse `/?preview=activities`. O modo de demonstração só é habilitado quando o hostname
é `127.0.0.1` ou `localhost`; no domínio de produção ele permanece desativado.
