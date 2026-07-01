# Deploy na Hostinger

O painel `web/` e um app estatico React/Vite. A Hostinger pode hospedar o
frontend no `public_html`. O backend continua no Supabase: Auth, banco,
Edge Functions, CAPI, CRM e Meta.

## Pacote manual

1. Gere o build:

```powershell
cd web
npm.cmd run build
```

2. Compacte o conteudo de `web/dist`, nao a pasta `dist` inteira.

3. No hPanel da Hostinger, abra `Files > File Manager` e entre em
`public_html`.

4. Envie o zip, extraia no `public_html` e confirme que `index.html`,
`.htaccess` e `assets/` ficaram diretamente dentro de `public_html`.

## Deploy por Git

A Hostinger tambem permite deploy por GitHub no hPanel:

1. `Websites > Dashboard`.
2. `Advanced > Git`.
3. Conecte o GitHub.
4. Escolha o repositorio e branch `main`.
5. Use `public_html` como diretorio de deploy.

Para este projeto, o deploy manual do `dist` e mais simples no piloto. Deploy
por Git exige uma etapa de build no ambiente ou um fluxo que publique o
conteudo gerado.

## Depois de publicar

Atualize no Supabase Auth:

- `site_url`: URL final do painel, por exemplo `https://app.seudominio.com`.
- `uri_allow_list`: inclua `https://app.seudominio.com/**`.

Atualize tambem o secret das Edge Functions:

```powershell
$env:APP_URL="https://app.seudominio.com"
```

Ou use a Management API/CLI para salvar `APP_URL` no projeto Supabase.

## Email 100% em producao

Para enviar confirmacao e convite para qualquer pessoa, configure SMTP proprio
no Supabase Auth. O SMTP pode ser da Hostinger, Resend, Postmark, Brevo, AWS SES
ou outro provedor.

Use o script:

```powershell
$env:SMTP_HOST="smtp.hostinger.com"
$env:SMTP_PORT="587"
$env:SMTP_USER="no-reply@seudominio.com"
$env:SMTP_PASS="SENHA_DO_EMAIL"
$env:SMTP_ADMIN_EMAIL="no-reply@seudominio.com"
$env:SMTP_SENDER_NAME="IDX CRO Engine"

powershell -ExecutionPolicy Bypass -File .\scripts\configure-supabase-auth-smtp.ps1 -AppUrl "https://app.seudominio.com"
```

Nunca comite a senha SMTP.
