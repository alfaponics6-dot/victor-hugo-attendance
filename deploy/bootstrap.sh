#!/usr/bin/env bash
# Victor Hugo - one-shot bootstrap for a fresh Oracle Cloud Ubuntu/Debian VM.
#
# Assumes you have already:
#   1. SSH'd in as a sudoer user.
#   2. Pulled this repo to /opt/victorhugo (or set REPO_DIR below).
#   3. Set DOMAIN, ADMIN_EMAIL, and (optionally) JWT_SECRET / LEADER_ACCESS_CODE
#      in the environment before running, e.g.:
#         DOMAIN=attendance.example.org ADMIN_EMAIL=ops@example.org \
#           sudo -E ./deploy/bootstrap.sh
#
# The script is idempotent; running it a second time is safe.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/victorhugo}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
JWT_SECRET="${JWT_SECRET:-}"
LEADER_ACCESS_CODE="${LEADER_ACCESS_CODE:-}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "bootstrap.sh must be run as root (use sudo -E)" >&2
    exit 1
  fi
}

require_var() {
  local name="$1"
  local value="${!1}"
  if [[ -z "$value" ]]; then
    echo "Required env var $name is not set" >&2
    exit 1
  fi
}

require_root
require_var DOMAIN
require_var ADMIN_EMAIL

echo "==> Installing system packages"
apt-get update
apt-get install -y curl ca-certificates gnupg lsb-release nginx certbot \
  python3-certbot-nginx sqlite3 build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20 LTS via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Building API"
cd "$REPO_DIR/server"
npm ci --omit=dev

echo "==> Building client"
cd "$REPO_DIR/client"
npm ci
npm run build

ENV_FILE="$REPO_DIR/server/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Writing $ENV_FILE"
  if [[ -z "$JWT_SECRET" ]]; then
    JWT_SECRET="$(openssl rand -hex 48)"
  fi
  if [[ -z "$LEADER_ACCESS_CODE" ]]; then
    LEADER_ACCESS_CODE="$(openssl rand -hex 12)"
    echo "Generated LEADER_ACCESS_CODE: $LEADER_ACCESS_CODE  (give this to leaders)"
  fi
  cat > "$ENV_FILE" <<EOF
PORT=3000
NODE_ENV=production
TRUST_PROXY=true
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=8h
LEADER_ACCESS_CODE=$LEADER_ACCESS_CODE
CORS_ORIGINS=https://$DOMAIN
LOGIN_RATE_LIMIT=30
EOF
  chmod 600 "$ENV_FILE"
fi

echo "==> Installing systemd unit"
sed "s|/opt/victorhugo|$REPO_DIR|g" "$REPO_DIR/deploy/victorhugo-api.service" \
  > /etc/systemd/system/victorhugo-api.service
systemctl daemon-reload
systemctl enable --now victorhugo-api

echo "==> Installing nginx site"
sed "s|attendance\.example\.org|$DOMAIN|g" "$REPO_DIR/deploy/nginx-victorhugo.conf" \
  > /etc/nginx/sites-available/victorhugo
ln -sf /etc/nginx/sites-available/victorhugo /etc/nginx/sites-enabled/victorhugo
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Issuing Let's Encrypt cert via certbot"
certbot --nginx --non-interactive --agree-tos --email "$ADMIN_EMAIL" -d "$DOMAIN"

echo "==> Installing logrotate + backup cron"
cp "$REPO_DIR/deploy/logrotate-victorhugo" /etc/logrotate.d/victorhugo
cp "$REPO_DIR/deploy/backup-cron" /etc/cron.d/victorhugo-backup
chmod 644 /etc/cron.d/victorhugo-backup

echo "==> Done. Smoke check:"
echo "  curl -s https://$DOMAIN/api/health"
echo "  curl -s https://$DOMAIN/api/health/ready"
