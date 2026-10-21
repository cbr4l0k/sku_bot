#!/usr/bin/env bash
# Sends this checkout to the VDS and rebuilds the stack there.
#
#   scripts/deploy.sh              check, sync, rebuild, show the logs
#   scripts/deploy.sh --dry-run    show what rsync would change; touch nothing
#   scripts/deploy.sh --skip-checks
#
# Everything goes through the local HTTP proxy at DEPLOY_PROXY (127.0.0.1:10808 unless
# set); the server is not reliably reachable without it. DEPLOY_PROXY= connects directly.
#
# The server keeps what only it should have: .env, caddy/ (the shared Caddy's site
# file) and the sku_data volume with the database. rsync never sends or deletes those.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@46.224.207.135}"
DIR="${DEPLOY_DIR:-/opt/apps/sku_bot}"
DRY_RUN=0
CHECKS=1
# Fail fast on a dead link instead of hanging; keep long builds alive.
SSH=(ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
PROXY="${DEPLOY_PROXY-127.0.0.1:10808}"
if [[ -n $PROXY ]]; then
  SSH+=(-o "ProxyCommand=nc -X connect -x $PROXY %h %p")
fi
# rsync splits -e on spaces but keeps single-quoted words whole, so the proxy command survives.
RSYNC_SSH=$(printf "'%s' " "${SSH[@]}")

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-checks) CHECKS=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ $CHECKS -eq 1 && $DRY_RUN -eq 0 ]]; then
  echo "==> Typecheck and tests"
  bun run typecheck
  bun test
fi

echo "==> Checking $HOST:$DIR"
"${SSH[@]}" "$HOST" "test -f '$DIR/.env'" || { echo "No $DIR/.env on the server. Create it first (see .env.example)." >&2; exit 1; }
"${SSH[@]}" "$HOST" "docker network inspect web >/dev/null" || { echo "The shared 'web' network is missing on the server." >&2; exit 1; }

echo "==> Syncing files"
rsync -az --no-owner --no-group --delete -e "$RSYNC_SSH" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run --itemize-changes) \
  --exclude '.git' --exclude '.jj' --exclude '.claude' --exclude '.agents' --exclude '.codex' \
  --exclude 'node_modules' --exclude 'dist' --exclude 'docs' --exclude 'data' --exclude '*.db' \
   --exclude '.env' --exclude '.env.production' --exclude 'PLAN.md' \
   --exclude '/caddy/' \
  ./ "$HOST:$DIR/"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run: nothing was changed on the server."
  exit 0
fi

# Only the app; the shared Caddy serves it, and this file's own caddy is standalone-only.
echo "==> Building and restarting"
"${SSH[@]}" "$HOST" "cd '$DIR' && docker compose up -d --build app && docker compose ps app"

echo "==> Last log lines"
"${SSH[@]}" "$HOST" "cd '$DIR' && sleep 5 && docker compose logs --tail=40 app"
