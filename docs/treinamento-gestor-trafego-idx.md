# Treinamento do Gestor de Tráfego - IDX CRO Engine

Este material é para a operação IDX ou gestor responsável por criar clientes, configurar integrações, gerar Smart Links e acompanhar qualidade por campanha.

## Papel do gestor

O gestor garante que cada empresa tenha:

- cadastro real;
- WhatsApp com DDI e DDD;
- Pixel ID e token CAPI;
- conta Meta Ads selecionada;
- Smart Links com UTM;
- usuários corretos;
- CRM sendo operado;
- públicos automáticos de qualificados e compradores.

## Criar uma empresa

1. Entre com a conta gestora IDX.
2. Abra Clientes.
3. Cadastre nome, segmento, slug, WhatsApp, cidade, UF e responsável.
4. Depois de criada, copie o Link de acesso em Configurações.
5. Envie o link para dono, atendente ou colaborador.

O link de acesso segue o padrão:

`https://cro.idxparasuaempresa.com.br/nome-da-empresa`

Cada usuário só vê empresas onde foi vinculado. A conta gestora IDX vê todas as empresas autorizadas.

## Onboarding obrigatório

Se uma empresa não tiver dados, o sistema deve mostrar onboarding em vez de dashboard falso. Complete:

- perfil operacional;
- primeiro Smart Link;
- integração Meta;
- primeiro clique real;
- usuários;
- CRM em operação.

O painel só deve ser interpretado depois de existir dado real.

## Criar Smart Links

Na aba Links:

1. Informe oferta.
2. Informe categoria e preço quando existir.
3. Preencha campanha, fonte, mídia, conteúdo e termo.
4. Confira a mensagem do WhatsApp.
5. Crie o link e copie para a campanha.

UTMs mínimas:

- `utm_source=meta`
- `utm_medium=paid`
- `utm_campaign=nome-da-campanha`

Use `utm_content` para criativo/anúncio e `utm_term` para público, palavra ou variação.

## Integração Meta

Existem duas partes:

- Pixel + Token CAPI: envia eventos server-side.
- Facebook Login + conta de anúncios: busca campanhas, gasto e permite públicos automáticos.

O fluxo profissional é:

1. Salvar Pixel ID e Token CAPI.
2. Rodar teste CAPI.
3. Conectar Facebook.
4. Selecionar conta de anúncios e Pixel.
5. Sincronizar gastos.
6. Criar/sincronizar públicos automáticos.

## Públicos automáticos

O sistema trabalha com dois públicos principais:

- Qualificados: leads marcados como Remarketing/Qualificado.
- Compradores: leads marcados como Venda.

Esses públicos usam telefone/email com hash SHA-256 antes do envio ao Meta.

## Leitura de qualidade

Na aba Relatórios, acompanhe:

- gasto por campanha;
- leads IDX;
- qualificados;
- ruins;
- vendas;
- receita;
- CPL;
- custo por qualificado;
- ROAS.

O gestor deve otimizar pelo lead que presta, não só pelo clique ou conversa barata.

## Checklist antes de entregar ao cliente

- Empresa com dados reais.
- Usuário do cliente convidado.
- Smart Link usado no anúncio.
- Pixel/CAPI com evento real.
- Conta Meta Ads conectada.
- Público de qualificados criado.
- Público de compradores criado.
- CRM com pelo menos um movimento real.
- Atendente treinado.

## Rotina semanal

- Segunda: revisar saúde dos clientes.
- Terça: revisar campanhas com muito gasto e pouco qualificado.
- Quarta: revisar CRM e follow-ups.
- Quinta: revisar públicos e remarketing.
- Sexta: enviar resumo executivo para o cliente.

