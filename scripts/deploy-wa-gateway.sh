#!/bin/bash
# Instala/atualiza o motor de WhatsApp do CRO (container idx-wa-gateway) na VPS.
# Não mexe em outros containers, portas ou proxies (o motor não expõe porta).
#   bash deploy-wa-gateway.sh        → só monta a imagem e mostra o hash do token
#   bash deploy-wa-gateway.sh run    → (re)inicia o container
set -euo pipefail
REPO=/opt/idx/idx-cro-engine
DIR=/opt/idx/wa-gateway
ENVF=/opt/idx/wa-gateway.env
cd "$REPO"
git fetch -q origin claude/crm-revops
rm -rf "$DIR.new"; mkdir -p "$DIR.new"
git archive FETCH_HEAD services/wa-gateway | tar -x -C "$DIR.new" --strip-components=2
rm -rf "$DIR"; mv "$DIR.new" "$DIR"
docker build -q -t idx-wa-gateway:latest "$DIR"
if [ ! -f "$ENVF" ]; then
  # URL e chave PÚBLICA do Supabase (as mesmas do painel); o token é gerado aqui e nunca sai da VPS
  val() { grep -E "^$1=" "$REPO/web/.env.local" | head -1 | cut -d= -f2- | tr -d "\"' \r"; }
  umask 077
  printf 'SUPABASE_URL=%s\nSUPABASE_ANON_KEY=%s\nGATEWAY_TOKEN=%s\n' \
    "$(val VITE_SUPABASE_URL)" "$(val VITE_SUPABASE_ANON_KEY)" "$(openssl rand -hex 32)" > "$ENVF"
fi
chmod 600 "$ENVF"
# só o hash vai para o banco (wa_gateway_tokens)
echo "TOKEN_SHA256=$(grep ^GATEWAY_TOKEN= "$ENVF" | cut -d= -f2- | tr -d '\n' | sha256sum | cut -c1-64)"
if [ "${1:-}" = "run" ]; then
  docker rm -f idx-wa-gateway >/dev/null 2>&1 || true
  docker run -d --name idx-wa-gateway --restart unless-stopped --env-file "$ENVF" \
    -v idx-wa-sessions:/data --memory 512m --log-opt max-size=10m --log-opt max-file=3 idx-wa-gateway:latest
  sleep 8
  docker logs --tail 20 idx-wa-gateway 2>&1
fi
echo DONE
