#!/usr/bin/env bash
# Builds and starts the full production stack (Postgres, app, Caddy with HTTPS, backups) with a
# mock email/SMS provider, then runs the end-to-end tests through Caddy:
#   1. unit tests, 2. full user flows, 3. restart the app and check state survived,
#   4. take a backup, restore it with scripts/restore.sh, check again.
# Needs Docker and free ports 80, 443, 3000 and 8025 on this machine. Tears everything down after
# (set KEEP=1 to leave it running).
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=pbat-test
COMPOSE=(docker compose --env-file deploy/test/test.env -f docker-compose.yml -f deploy/test/docker-compose.test.yml)
STATE=/tmp/pbat-e2e-state.json
NODE_RUN=(docker run --rm --network host -v "$PWD:/w:ro" -v /tmp:/tmp -w /w
  --add-host pbat.test:127.0.0.1 --add-host www.pbat.test:127.0.0.1
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e STATE_FILE="$STATE")
NODE_IMAGE=node:22-alpine

cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true; rm -rf backups-test; fi
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

step "unit tests"
"${NODE_RUN[@]}" "$NODE_IMAGE" sh -c 'cp -r /w /tmp/unit && cd /tmp/unit && npm ci --omit=dev --no-audit --no-fund --silent && node --test "test/unit/*.test.js"'

step "starting the stack"
"${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
mkdir -p backups-test && chmod 700 backups-test
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 180
"${COMPOSE[@]}" ps

e2e() { "${NODE_RUN[@]}" -e PHASE="$1" "$NODE_IMAGE" node --test --test-reporter=spec test/e2e/stack.test.js; }

step "end-to-end: main flows"
e2e main

step "restarting the app"
"${COMPOSE[@]}" restart app
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 app
e2e after-restart

step "backup and restore"
"${COMPOSE[@]}" exec -T backup sh /scripts/backup-once.sh
dump="$(ls -1t backups-test/daily/pbat-*.dump | head -n 1)"
echo "restoring $dump"
echo restore | env COMPOSE_FILE=docker-compose.yml:deploy/test/docker-compose.test.yml \
  BACKUP_DIR=./backups-test APP_PORT=3000 bash -c 'set -a; . deploy/test/test.env; set +a; scripts/restore.sh "$0"' "$dump"
"${COMPOSE[@]}" up -d --wait --wait-timeout 120
e2e after-restart

step "all stack tests passed"
