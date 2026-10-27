#!/usr/bin/env bash
# First deploy and every update, on the server, from the repo directory:
#   scripts/deploy.sh            # pull the current branch, rebuild, restart, health-check
#   scripts/deploy.sh --no-pull  # rebuild and restart what's checked out
# If the new version doesn't become healthy, the previous image is started again.
set -euo pipefail
cd "$(dirname "$0")/.."

PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

die() { echo "deploy: $*" >&2; exit 1; }
[ -f .env ] || die ".env is missing. Copy .env.example to .env and fill it in."
set -a; . ./.env; set +a

# Guard rails: refuse obviously unsafe production settings.
[ "${NODE_ENV:-production}" = "production" ] || die "NODE_ENV must be production on the server."
[ -n "${POSTGRES_PASSWORD:-}" ] && [ "${POSTGRES_PASSWORD}" != "change-me" ] || die "Set a strong POSTGRES_PASSWORD in .env."
[ -n "${ACME_EMAIL:-}" ] || die "Set ACME_EMAIL in .env (Let's Encrypt expiry notices)."
[ -n "${SITE_DOMAIN:-}" ] || die "Set SITE_DOMAIN in .env."
case ",${COMPOSE_PROFILES:-}," in *,prod,*) ;; *) die "Set COMPOSE_PROFILES=prod in .env so Caddy and backups run.";; esac
if [ -z "${BREVO_API_KEY:-}${ZEPTOMAIL_TOKEN:-}${RESEND_API_KEY:-}${GMAIL_SCRIPT_URL:-}${SMTP_HOST:-}" ]; then
  echo "deploy: WARNING: no email provider set; sign-in emails will not be delivered." >&2
fi
mkdir -p "${BACKUP_DIR:-./backups}" && chmod 700 "${BACKUP_DIR:-./backups}"

if [ "$PULL" = 1 ]; then
  git fetch --prune origin
  git merge --ff-only "@{u}" || die "Local changes or a diverged branch; resolve them, then retry."
fi
REV="$(git rev-parse --short HEAD)"

# Keep the running image as :previous for rollback.
if docker image inspect pbat-app:latest > /dev/null 2>&1; then
  docker tag pbat-app:latest pbat-app:previous
fi

echo "deploy: building $REV..."
docker compose build --pull app
docker compose up -d --remove-orphans

wait_healthy() {
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

if wait_healthy; then
  echo "deploy: app $REV is healthy; checking HTTPS through Caddy..."
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 --resolve "${SITE_DOMAIN}:443:127.0.0.1" "https://${SITE_DOMAIN}/readyz" > /dev/null 2>&1; then
      echo "deploy: $REV is live at https://${SITE_DOMAIN}"
      docker image prune -f > /dev/null
      exit 0
    fi
    sleep 3
  done
  # The app itself is fine, so don't roll back; this is almost always DNS, firewall or certificates.
  echo "deploy: WARNING: the app is healthy but https://${SITE_DOMAIN} isn't answering yet." >&2
  echo "deploy: check DNS, ports 80/443 and: docker compose logs caddy" >&2
  exit 2
fi

echo "deploy: health check FAILED for $REV" >&2
docker compose logs --tail 80 app >&2 || true
if docker image inspect pbat-app:previous > /dev/null 2>&1; then
  echo "deploy: rolling back to the previous image" >&2
  docker tag pbat-app:previous pbat-app:latest
  docker compose up -d --no-build app
  wait_healthy && echo "deploy: previous version restored (code checkout is still at $REV)." >&2
fi
exit 1
