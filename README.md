# IDX — repositório de produtos

Este repositório guarda dois produtos diferentes. Cada um tem a sua pasta e o seu README.

| Pasta | Produto | O que é |
| --- | --- | --- |
| [`idx-cro/`](idx-cro/README.md) | **IDX CRO Engine** | Software de otimização de campanhas: Smart Link → WhatsApp, integração Meta (CAPI + Ads Insights), CRM e relatório de quais campanhas trouxeram resultado. |
| [`sistema-operacional-v2/`](sistema-operacional-v2/README.md) | Sistema Operacional IDX | Gestão interna da agência (clientes, atividades, POPs). Não faz parte do CRO. |

Situação atual do CRO e o que falta para ficar pronto: [`idx-cro/docs/status-e-pendencias.md`](idx-cro/docs/status-e-pendencias.md).

## Arquivos de deploy na raiz (não editar à mão)

`index.html`, `404.html`, `assets/`, `privacy.html`, `terms.html`, `data-deletion.html`,
`meta-oauth-callback*`, `.htaccess`, `.nojekyll` e `CNAME` são uma **cópia antiga do build
do painel CRO** (gerada em 09/07/2026), deixada aqui para hospedagens que publicam a raiz
do repositório. O código-fonte de verdade está em `idx-cro/web/`. O GitHub Pages publica
`idx-cro/web/dist` pelo workflow `.github/workflows/deploy-pages.yml`.

## Testes

```bash
cd idx-cro/web && npm ci && npm run build && npm run test:edge   # CRO
node --test tests/sistema-operacional-v2.test.mjs                # Sistema Operacional
```
