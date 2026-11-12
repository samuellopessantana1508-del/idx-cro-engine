#!/bin/bash
# Publica o site do CRO na VPS a partir do branch claude/crm-revops, com backup da versão atual.
# Não mexe em outros containers: o idx-cro-web serve a pasta web/dist.
set -euo pipefail
cd /opt/idx/idx-cro-engine
TS=$(date +%Y%m%d%H%M%S)
mkdir -p /opt/idx/backups
cp -a web/dist "/opt/idx/backups/idx-dist-pre-${1:-deploy}-$TS"
echo "BACKUP=$TS"
git fetch -q origin claude/crm-revops
rm -rf /opt/idx/crm-build; git worktree prune
git worktree add -f --detach /opt/idx/crm-build FETCH_HEAD
cp web/.env.local /opt/idx/crm-build/web/.env.local
docker run --rm -v /opt/idx/crm-build:/repo -w /repo/web node:22-alpine sh -c "npm ci --no-audit --no-fund && npm run build" | tail -3
test -f /opt/idx/crm-build/web/dist/index.html
find web/dist -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a /opt/idx/crm-build/web/dist/. web/dist/
git checkout -q -B claude/crm-revops FETCH_HEAD
git worktree remove --force /opt/idx/crm-build
curl -s -o /dev/null -w "HTTP %{http_code}\n" 127.0.0.1:8091
echo FIM
