#!/usr/bin/env bash
#
# Install Victor Hugo onto an EXISTING server that already hosts other apps.
# Unlike deploy/bootstrap.sh (which assumes it owns the whole VM), this:
#
#   * Picks a free internal port (3001/3002/... — never 3000, in case the
#     existing app uses it).
#   * Installs Node only if not already present (idempotent).
#   * Creates its own systemd unit `victorhugo-api.service`.
#   * Adds its own nginx server block keyed on $DOMAIN (does NOT touch
#     existing sites or the default).
#   * Runs certbot for the new domain only (existing certs are unaffected).
#   * Adds the daily backup cron alongside whatever else cron has.
#
# Required env vars when invoked (same as bootstrap.sh):
#   DOMAIN              public hostname (e.g. forestryescenary.com)
#   ADMIN_EMAIL         for Let's Encrypt cert
#   JWT_SECRET          base64, 96 chars
#   LEADER_ACCESS_CODE  shared leader password
#
# Optional:
#   VH_PORT             override port detection (default: first free of 3001..3010)
#   REPO_DIR            checkout location (default /opt/victorhugo)

set -euo pipefail

: "${DOMAIN:?DOMAIN env var required}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL env var required}"
: "${JWT_SECRET:?JWT_SECRET env var required}"
: "${LEADER_ACCESS_CODE:?LEADER_ACCESS_CODE env var required}"

REPO_DIR="${REPO_DIR:-/opt/victorhugo}"
if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: $REPO_DIR doesn't exist. Clone the repo there first." >&2
  exit 1
fi

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Must run as root (use sudo -E)" >&2
    exit 1
  fi
}
require_root

# ----------------------------------------------------------------------
# 1. Pick a free port. Existing apps likely use 3000 — start at 3001 and
#    scan upward to find one that's not bound.
# ----------------------------------------------------------------------
pick_free_port() {
  if [ -n "${VH_PORT:-}" ]; then
    echo "$VH_PORT"
    return
  fi
  for p in 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010; do
    if ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"; then
      echo "$p"
      return
    fi
  done
  echo "ERROR: no free port in 3001..3010" >&2
  exit 1
}
VH_PORT=$(pick_free_port)
echo "==> Victor Hugo will listen on internal port $VH_PORT"

# ----------------------------------------------------------------------
# 2. System packages. nginx + certbot may already be installed; apt is
#    idempotent so this is safe to re-run.
# ----------------------------------------------------------------------
echo "==> Ensuring system packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release nginx certbot \
  python3-certbot-nginx sqlite3 build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "==> Node already installed: $(node --version)"
fi

# ----------------------------------------------------------------------
# 3. Service user. Reuse if it exists; create otherwise.
# ----------------------------------------------------------------------
if ! id victorhugo &>/dev/null; then
  echo "==> Creating victorhugo system user"
  useradd --system --no-create-home --shell /usr/sbin/nologin victorhugo
fi
chown -R victorhugo:victorhugo "$REPO_DIR"

# ----------------------------------------------------------------------
# 4. Build the app.
# ----------------------------------------------------------------------
echo "==> Installing server deps"
cd "$REPO_DIR/server"
sudo -u victorhugo npm ci --omit=dev

echo "==> Building client"
cd "$REPO_DIR/client"
sudo -u victorhugo npm ci
sudo -u victorhugo npm run build

# ----------------------------------------------------------------------
# 5. Server .env (only write if absent — preserve any operator edits).
# ----------------------------------------------------------------------
ENV_FILE="$REPO_DIR/server/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
PORT=$VH_PORT
NODE_ENV=production
TRUST_PROXY=true
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=8h
LEADER_ACCESS_CODE=$LEADER_ACCESS_CODE
CORS_ORIGINS=https://$DOMAIN
LOGIN_RATE_LIMIT=30
EOF
  chmod 600 "$ENV_FILE"
  chown victorhugo:victorhugo "$ENV_FILE"
else
  echo "==> Keeping existing $ENV_FILE (delete it first if you want to regenerate)"
  # If the existing .env had PORT=3000 but we picked another, sync it.
  sed -i "s|^PORT=.*|PORT=$VH_PORT|" "$ENV_FILE"
fi

# ----------------------------------------------------------------------
# 6. systemd unit. We template from deploy/victorhugo-api.service but
#    adjust paths if REPO_DIR differs from the canonical /opt/victorhugo.
# ----------------------------------------------------------------------
echo "==> Installing systemd unit victorhugo-api.service"
sed -e "s|/opt/victorhugo|$REPO_DIR|g" \
    "$REPO_DIR/deploy/victorhugo-api.service" \
    > /etc/systemd/system/victorhugo-api.service
systemctl daemon-reload
systemctl enable --now victorhugo-api
sleep 2
if ! systemctl is-active --quiet victorhugo-api; then
  echo "ERROR: victorhugo-api failed to start. Last log lines:" >&2
  journalctl -u victorhugo-api -n 30 --no-pager >&2 || true
  exit 1
fi

# ----------------------------------------------------------------------
# 7. nginx site config — additive, never touches existing sites.
# ----------------------------------------------------------------------
echo "==> Installing nginx site for $DOMAIN"
NGINX_SITE="/etc/nginx/sites-available/victorhugo"
cat > "$NGINX_SITE" <<NGINX_EOF
# Victor Hugo - nginx site (added by install-side-by-side.sh)
upstream victorhugo_api {
    server 127.0.0.1:$VH_PORT;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # certbot fills in ssl_certificate / ssl_certificate_key after issuance.

    add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    client_max_body_size 6m;
    client_body_timeout 30s;
    client_header_timeout 15s;
    send_timeout 30s;
    keepalive_timeout 75s;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml font/woff2;
    gzip_min_length 1024;
    gzip_proxied any;

    root $REPO_DIR/client/dist;
    index index.html;

    location ~* ^/assets/.*\.(?:js|css|woff2?|ttf|otf|eot|svg)$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files \$uri =404;
    }
    location ~* \.(?:png|jpg|jpeg|gif|ico|webp|svg)$ {
        add_header Cache-Control "public, max-age=86400";
        try_files \$uri =404;
    }

    location /api/ {
        proxy_pass http://victorhugo_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    location / {
        try_files \$uri /index.html;
        add_header Cache-Control "no-cache";
    }

    location ~ /\.(env|git|ht) {
        deny all;
    }
}
NGINX_EOF

# Enable our site (idempotent), but DO NOT remove sites-enabled/default
# or any other site — that's the whole point of side-by-side.
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/victorhugo

# Make sure the certbot well-known dir exists.
mkdir -p /var/www/certbot

if ! nginx -t; then
  echo "ERROR: nginx config invalid. Inspect /etc/nginx/sites-available/victorhugo." >&2
  exit 1
fi
systemctl reload nginx

# ----------------------------------------------------------------------
# 8. TLS via certbot. Non-fatal if DNS isn't pointed yet — the user can
#    re-run `sudo certbot --nginx -d $DOMAIN` after fixing DNS without
#    re-running this whole installer. Skipped if cert already exists.
# ----------------------------------------------------------------------
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "==> Cert for $DOMAIN already present; skipping issuance"
elif ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  echo "==> Skipping certbot — $DOMAIN does not resolve yet."
  echo "    Once DNS is set: sudo certbot --nginx -d $DOMAIN --email $ADMIN_EMAIL --agree-tos"
else
  echo "==> Issuing Let's Encrypt cert for $DOMAIN"
  if ! certbot --nginx --non-interactive --agree-tos --email "$ADMIN_EMAIL" -d "$DOMAIN"; then
    echo "==> [WARN] certbot failed. The app is up on HTTP only; re-run this once DNS propagates:"
    echo "       sudo certbot --nginx -d $DOMAIN --email $ADMIN_EMAIL --agree-tos"
  fi
fi

# ----------------------------------------------------------------------
# 9. Daily backup cron (additive — uses /etc/cron.d, not the default
#    crontab, so it doesn't clobber anything).
# ----------------------------------------------------------------------
if [ -f "$REPO_DIR/deploy/backup-cron" ] && [ ! -f /etc/cron.d/victorhugo-backup ]; then
  echo "==> Installing daily backup cron"
  sed "s|/opt/victorhugo|$REPO_DIR|g" "$REPO_DIR/deploy/backup-cron" \
    > /etc/cron.d/victorhugo-backup
  chmod 644 /etc/cron.d/victorhugo-backup
fi

if [ -f "$REPO_DIR/deploy/logrotate-victorhugo" ] && [ ! -f /etc/logrotate.d/victorhugo ]; then
  cp "$REPO_DIR/deploy/logrotate-victorhugo" /etc/logrotate.d/victorhugo
fi

# ----------------------------------------------------------------------
# 10. Smoke check.
# ----------------------------------------------------------------------
echo
echo "==> Smoke test"
sleep 2
if curl -fsS "http://127.0.0.1:$VH_PORT/api/health" >/dev/null; then
  echo "    [OK] API healthy on localhost:$VH_PORT"
else
  echo "    [WARN] API not yet healthy; check 'sudo journalctl -u victorhugo-api -n 50'"
fi
echo
echo "============================================================"
echo " Victor Hugo installed alongside existing services"
echo "============================================================"
echo " Domain          : https://$DOMAIN"
echo " Internal port   : $VH_PORT"
echo " Service         : victorhugo-api.service"
echo " Files           : $REPO_DIR"
echo " systemctl       : sudo systemctl {status,restart,stop} victorhugo-api"
echo " Logs            : sudo journalctl -u victorhugo-api -n 100"
echo "============================================================"
