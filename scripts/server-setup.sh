#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 Linode, run as root. Safe to re-run.
#
#   curl -fsSLO https://raw.githubusercontent.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027/main/scripts/server-setup.sh
#   (or copy this file over with scp), then:
#   bash server-setup.sh
#
# What it does:
#   1. installs updates and base packages; turns on automatic security updates (unattended-upgrades)
#   2. creates user1 (normal sudo: asks for user1's password), copies root's SSH keys to it
#   3. installs Docker Engine + the compose plugin from Docker's official apt repository;
#      adds user1 to the docker group
#   4. firewall (ufw): allow 22, 80, 443 (tcp) and 443/udp (HTTP/3); deny everything else inbound
#   5. adds 2 GB swap on small plans
#   6. creates /opt/pbatdoor2door (owned by user1), clones the repo there, creates .env
#      with a generated database password
#
# Optional final step, ONLY after you have confirmed `ssh user1@<server>` + `sudo -v` work:
#   DISABLE_ROOT_SSH=1 bash server-setup.sh     # turns off root and password SSH logins
#
# Settings (environment variables): APP_USER (user1), APP_DIR (/opt/pbatdoor2door),
# REPO_HTTPS, REPO_SSH, BRANCH (main).
set -euo pipefail

APP_USER="${APP_USER:-user1}"
APP_DIR="${APP_DIR:-/opt/pbatdoor2door}"
REPO_HTTPS="${REPO_HTTPS:-https://github.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027.git}"
REPO_SSH="${REPO_SSH:-git@github.com:PBAT-DOOR-2-DOOR/pbatdoor2door2027.git}"
BRANCH="${BRANCH:-main}"
DISABLE_ROOT_SSH="${DISABLE_ROOT_SSH:-0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
[ "$(id -u)" = 0 ] || { echo "Run this as root." >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "This script is written for Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})."
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------------------------
if [ "$DISABLE_ROOT_SSH" = 1 ]; then
  say "Optional hardening: disabling root and password SSH logins"
  home="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
  if [ -z "$home" ] || [ ! -s "$home/.ssh/authorized_keys" ]; then
    echo "Refusing: $APP_USER has no SSH keys, you would lock yourself out." >&2; exit 1
  fi
  id -nG "$APP_USER" | grep -qw sudo || { echo "Refusing: $APP_USER is not in the sudo group." >&2; exit 1; }
  cat > /etc/ssh/sshd_config.d/00-pbat-hardening.conf <<'EOF'
# Written by server-setup.sh (DISABLE_ROOT_SSH=1). sshd uses the first value it reads, so 00- wins.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
  sshd -t
  systemctl reload ssh
  sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication) '
  echo "Done. Keep this session open and test a NEW login: ssh $APP_USER@<server>. The Linode LISH console still works if needed."
  exit 0
fi

# ---------------------------------------------------------------------------------------------
say "1. Updates, base packages and automatic security updates"
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install ca-certificates curl git gnupg ufw unattended-upgrades openssl sudo openssh-client
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades 2>/dev/null || true

# ---------------------------------------------------------------------------------------------
say "2. User $APP_USER"
if ! id "$APP_USER" > /dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
fi
usermod -aG sudo "$APP_USER"
home="$(getent passwd "$APP_USER" | cut -d: -f6)"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
if [ -s /root/.ssh/authorized_keys ]; then
  # Merge root's keys in, without duplicates.
  cat "$home/.ssh/authorized_keys" /root/.ssh/authorized_keys | awk 'NF && !seen[$0]++' > "$home/.ssh/authorized_keys.new"
  mv "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"
else
  warn "/root/.ssh/authorized_keys is empty; add $APP_USER's public key to $home/.ssh/authorized_keys yourself."
fi
chown "$APP_USER:$APP_USER" "$home/.ssh/authorized_keys"; chmod 600 "$home/.ssh/authorized_keys"
# sudo asks for the user's password, so the account needs one.
if passwd -S "$APP_USER" | awk '{exit ($2 == "P") ? 0 : 1}'; then
  echo "$APP_USER already has a password (used for sudo)."
elif [ -t 0 ]; then
  echo "Choose a password for $APP_USER (sudo will ask for it; SSH logins use keys):"
  until passwd "$APP_USER"; do :; done
else
  warn "$APP_USER has no password yet, so it can't use sudo. Run: passwd $APP_USER"
fi

# ---------------------------------------------------------------------------------------------
say "3. Docker Engine and the compose plugin (Docker's official repository)"
install -m 0755 -d /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg -s "$pkg" > /dev/null 2>&1; then apt-get -y -q remove "$pkg"; fi
done
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
  systemctl restart docker 2>/dev/null || true
fi
systemctl enable --now docker 2>/dev/null || true
usermod -aG docker "$APP_USER"
docker --version; docker compose version

# ---------------------------------------------------------------------------------------------
say "4. Firewall (ufw): 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (redirects, certificates)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable
ufw status verbose

# ---------------------------------------------------------------------------------------------
say "5. Swap"
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$(swapon --noheadings | wc -l)" = 0 ] && [ "$mem_mb" -lt 4096 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Added 2 GB swap (RAM: ${mem_mb} MB)."
else
  echo "Swap not needed or already present."
fi

# ---------------------------------------------------------------------------------------------
say "6. App directory $APP_DIR and the code"
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
as_user() { sudo -u "$APP_USER" -H env GIT_TERMINAL_PROMPT=0 "$@"; }
if [ ! -d "$APP_DIR/.git" ]; then
  if as_user git clone --branch "$BRANCH" "$REPO_HTTPS" "$APP_DIR" 2>/dev/null; then
    echo "Cloned $REPO_HTTPS"
  else
    # Private repository: use a read-only deploy key for this server.
    key="$home/.ssh/pbat_deploy"
    [ -f "$key" ] || as_user ssh-keygen -q -t ed25519 -N "" -C "pbatdoor2door-server" -f "$key"
    if ! grep -q 'pbat_deploy' "$home/.ssh/config" 2>/dev/null; then
      printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$key" >> "$home/.ssh/config"
      chown "$APP_USER:$APP_USER" "$home/.ssh/config"; chmod 600 "$home/.ssh/config"
    fi
    grep -q '^github.com ' "$home/.ssh/known_hosts" 2>/dev/null \
      || ssh-keyscan -t ed25519 github.com 2>/dev/null | as_user tee -a "$home/.ssh/known_hosts" > /dev/null
    if as_user git clone --branch "$BRANCH" "$REPO_SSH" "$APP_DIR" 2>/dev/null; then
      echo "Cloned $REPO_SSH with the deploy key"
    else
      warn "Could not clone the repository (it is private)."
      echo "Add this public key on GitHub: repo Settings > Deploy keys > Add deploy key (read-only):"
      echo; cat "$key.pub"; echo
      echo "Then re-run: bash $0"
      exit 0
    fi
  fi
else
  echo "Repository already present."
fi

if [ ! -f "$APP_DIR/.env" ]; then
  as_user cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  pw="$(openssl rand -hex 32)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/" "$APP_DIR/.env"
  sed -i "s/^BACKUP_UID=.*/BACKUP_UID=$(id -u "$APP_USER")/; s/^BACKUP_GID=.*/BACKUP_GID=$(id -g "$APP_USER")/" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env with a generated POSTGRES_PASSWORD."
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/backups"

say "Server ready"
cat <<EOF
Next, as $APP_USER (log in again so the docker group applies):
  ssh $APP_USER@<server>
  cd $APP_DIR
  nano .env              # set ACME_EMAIL, MAIL_FROM, BREVO_API_KEY (and any phone settings)
  scripts/deploy.sh

Optional, once 'ssh $APP_USER@<server>' and 'sudo -v' work:
  DISABLE_ROOT_SSH=1 bash $0
EOF
