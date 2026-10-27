#!/usr/bin/env bash
# Rewrites deploy/caddy/proxy-cloudflare.caddy with Cloudflare's current IP ranges.
# Only needed with PROXY_MODE=cloudflare. Afterwards: docker compose restart caddy
set -euo pipefail
cd "$(dirname "$0")/.."
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
ranges="$(printf '%s\n%s\n' "$v4" "$v6" | grep -E '^[0-9a-f:.]+/[0-9]+$' | tr '\n' ' ')"
[ -n "$ranges" ] || { echo "Could not fetch Cloudflare ranges." >&2; exit 1; }
cat > deploy/caddy/proxy-cloudflare.caddy <<EOF
# PROXY_MODE=cloudflare: requests come through Cloudflare's proxy.
# Cloudflare's published ranges (https://www.cloudflare.com/ips/, fetched $(date -u +%Y-%m-%d)).
# Refresh with scripts/update-cloudflare-ips.sh if Cloudflare announces changes.
servers {
	trusted_proxies static ${ranges% }
	client_ip_headers CF-Connecting-IP
}
EOF
echo "Updated deploy/caddy/proxy-cloudflare.caddy"
