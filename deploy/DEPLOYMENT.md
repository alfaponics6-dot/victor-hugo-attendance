# Victor Hugo - Oracle Cloud production deployment

This is the step-by-step for putting Victor Hugo on an Oracle Cloud Ampere A1
(Always Free tier, ARM64) VM with HTTPS, automatic restarts, daily backups,
and the concurrency guarantees the load test verified.

Tested target: **Oracle Linux 9 (ARM64)**. Ubuntu 22.04 LTS works with the same
commands; `dnf` becomes `apt`.

---

## 1. Provision the VM

In Oracle Cloud:

1. Compute → Instances → Create instance.
2. Image: Oracle Linux 9 (or Canonical Ubuntu 22.04).
3. Shape: VM.Standard.A1.Flex (Always Free) - 2 OCPU, 12 GB is plenty.
4. Networking:
   - Public IP: yes.
   - Open ingress in the VCN security list for TCP 80 and 443.
5. Add your SSH public key.

After it boots, SSH in: `ssh opc@<public-ip>`.

## 2. System packages

```bash
# Oracle Linux 9
sudo dnf install -y git nginx certbot python3-certbot-nginx
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

# (Ubuntu 22.04 alternative)
# sudo apt update && sudo apt install -y git nginx certbot python3-certbot-nginx
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
# sudo apt install -y nodejs
```

Verify: `node --version` → v20.x, `nginx -v`, `certbot --version`.

## 3. Service account + directories

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin victorhugo
sudo mkdir -p /opt/victorhugo
sudo chown victorhugo:victorhugo /opt/victorhugo
```

## 4. Pull the code

```bash
sudo -u victorhugo git clone <your-repo-url> /opt/victorhugo
# or: rsync the project tree into /opt/victorhugo from your laptop
```

You should now have `/opt/victorhugo/server`, `/opt/victorhugo/client`,
`/opt/victorhugo/data`, `/opt/victorhugo/deploy`.

## 5. Server install + .env

```bash
cd /opt/victorhugo/server
sudo -u victorhugo npm ci --omit=dev   # production deps only

sudo -u victorhugo cp .env.example .env
sudo -u victorhugo $EDITOR .env
```

Fill in:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (matches the nginx upstream) |
| `CORS_ORIGINS` | `https://attendance.yourdomain.org` (your real domain, comma-separate multiples) |
| `JWT_SECRET` | `$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")` |
| `JWT_EXPIRES_IN` | `8h` |
| `LEADER_ACCESS_CODE` | a memorable code you'll share with leaders in person |
| `TRUST_PROXY` | `true` (nginx terminates TLS in front of the API) |
| `LOGIN_RATE_LIMIT` | `30` (default; bump to 50-60 if many leaders share one campus IP) |

Lock down the file: `sudo chmod 600 /opt/victorhugo/server/.env`.

## 6. Seed the database

The very first server start auto-imports projects + leaders from
`data/EF_IC_Cuatrimestre_2026F.xlsx`. Confirm the seed file exists:

```bash
ls /opt/victorhugo/data/EF_IC_Cuatrimestre_2026F.xlsx
# If your spreadsheet has a different name, set SEED_EXCEL_PATH in .env.
```

Boot the server in the foreground so you can see the seed log line, then
stop it with `Ctrl+C` (clean SIGINT — the new shutdown handler drains
in-flight requests and closes the DB):

```bash
cd /opt/victorhugo/server
sudo -u victorhugo node src/index.js
# Wait for: "Seeded DB from spreadsheet: 7 projects, 16 leaders"
# Then Ctrl+C.

sudo -u victorhugo node scripts/reset-admin-password.js 'YourStrongPassword!'
```

If you have rotation assignments to import:

```bash
sudo -u victorhugo node scripts/import-rotations.js 2026-05-09  # cuatri start date
```

## 7. Build the client bundle

```bash
cd /opt/victorhugo/client
sudo -u victorhugo npm ci          # vite is a devDep, so we install everything
sudo -u victorhugo npm run build   # writes /opt/victorhugo/client/dist
```

The static bundle lands in `/opt/victorhugo/client/dist/`. nginx will serve it
directly - we do NOT need the dev `client/server.cjs` proxy in production.

## 8. systemd service for the API

```bash
sudo cp /opt/victorhugo/deploy/victorhugo-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now victorhugo-api
sudo systemctl status victorhugo-api      # should show "active (running)"
sudo journalctl -u victorhugo-api -f      # tail logs
```

If the service crashes, systemd restarts it after 5 seconds; the unit also
applies a hardened sandbox (`NoNewPrivileges`, `ProtectSystem=strict`, etc.)
and caps memory at 1 GB.

## 9. nginx + HTTPS

```bash
sudo cp /opt/victorhugo/deploy/nginx-victorhugo.conf /etc/nginx/conf.d/victorhugo.conf
sudo sed -i 's/attendance.example.org/attendance.yourdomain.org/g' /etc/nginx/conf.d/victorhugo.conf
sudo nginx -t
sudo systemctl reload nginx
```

Point your domain's A record at the VM's public IP, wait for DNS propagation,
then:

```bash
sudo certbot --nginx -d attendance.yourdomain.org
# Pick "redirect HTTP to HTTPS" when asked. certbot edits the nginx config
# in place to install the cert and the 301 redirect.
```

The cert renews automatically via the `certbot.timer` systemd unit (already
installed by the package).

## 10. Firewall

Oracle Cloud has TWO firewalls: the VCN security list (open in step 1) and
the host firewall.

```bash
# Oracle Linux 9 (firewalld)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload

# Ubuntu (ufw) alternative
# sudo ufw allow OpenSSH
# sudo ufw allow 'Nginx Full'
# sudo ufw --force enable
```

## 11. Backups

```bash
sudo cp /opt/victorhugo/deploy/backup-cron /etc/cron.d/victorhugo-backup
sudo cp /opt/victorhugo/deploy/logrotate-victorhugo /etc/logrotate.d/victorhugo
sudo chmod 644 /etc/cron.d/victorhugo-backup
```

This runs `server/scripts/backup.js` every night at 02:30 and keeps the last
30 daily snapshots under `server/backups/`. The log rotates weekly.

### Off-host backup (recommended)

A local backup survives an app crash but not a VM loss. Ship the nightly
snapshot to Oracle Object Storage as well. Install the OCI CLI and configure
a `victorhugo` user with PutObject permission on a bucket:

```bash
# install OCI CLI
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# then append this to the cron job in /etc/cron.d/victorhugo-backup
# (replace BUCKET / NAMESPACE with your values)
30 2 * * * victorhugo cd /opt/victorhugo/server && /usr/bin/node scripts/backup.js && \
  LATEST=$(ls -t backups/attendance_backup_*.db | head -n1) && \
  oci os object put --bucket-name BUCKET --namespace NAMESPACE --file "$LATEST" \
    --name "$(date -u +%Y/%m/%d)-$(basename "$LATEST")" >> /var/log/victorhugo-backup.log 2>&1
```

S3-compatible alternatives (`aws s3 cp`, `rclone copy`) work the same way.
Apply a bucket lifecycle rule to expire objects after 30–90 days so the
remote tier doesn't grow unbounded.

### .env backup

`/opt/victorhugo/server/.env` holds JWT_SECRET and LEADER_ACCESS_CODE -
losing it logs every leader out and invalidates outstanding sessions.
**Do not commit it.** Back it up off-host once, GPG-encrypted:

```bash
sudo cat /opt/victorhugo/server/.env \
  | gpg --symmetric --cipher-algo AES256 -o ~/victorhugo.env.gpg
# then move ~/victorhugo.env.gpg to a password manager attachment or
# encrypted offline drive. Re-do this whenever you rotate the secret.
```

## 12. Smoke tests

```bash
# from your laptop
curl -sS https://attendance.yourdomain.org/api/health
# → {"status":"ok","message":"Server is running"}

# concurrency check from anywhere with node 20+
BASE=https://attendance.yourdomain.org/api LEADER_ACCESS_CODE=... \
  node /path/to/checkout/server/scripts/load-test-attendance.js --date=2027-01-01
# expect: 7 OK + 7 conflict + 0 failed (one OK per project)
```

## 13. Updates

```bash
cd /opt/victorhugo
sudo -u victorhugo git pull --ff-only

cd server && sudo -u victorhugo npm ci --omit=dev
cd ../client && sudo -u victorhugo npm ci && sudo -u victorhugo npm run build

sudo systemctl restart victorhugo-api
sudo systemctl reload nginx
```

A typical restart takes ~3 seconds; in-flight requests are drained by the
SIGTERM handler in `server/src/index.js`.

---

## What's hardened for production

- **Concurrency**: every bulk attendance submission is serialized through a
  JS-level mutex inside `database.js`, with the duplicate-project check
  performed inside the SQLite transaction. The load test confirms 14
  simultaneous submissions produce one success per project and clean 409s for
  the rest with zero 5xx errors.
- **SQLite tuning**: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=10000ms`,
  `cache_size=20MB`. Durable across crashes (only the last few transactions
  may be lost on hard kill); orders of magnitude faster than `synchronous=FULL`.
- **Process supervision**: systemd restarts on crash with 5s backoff.
- **Sandboxing**: the unit forbids new privileges, write paths outside the
  app's data dirs, kernel module loads, and write-executable memory.
- **Memory cap**: 1 GB hard ceiling.
- **TLS**: certbot-managed Let's Encrypt cert with auto-renewal.
- **Auth**: HttpOnly, Secure, SameSite=Strict cookies; rate-limited login
  (30/min by default, configurable via `LOGIN_RATE_LIMIT`); strict CORS
  allowlist.
- **Request limits**: nginx caps body size at 6 MB; bulk attendance route
  caps records at 200 per request.
- **Backups**: daily SQLite snapshot, last 30 kept locally; ship to object
  storage for off-host durability.

## Rolling back

```bash
sudo systemctl stop victorhugo-api
ls -lt /opt/victorhugo/server/backups/ | head        # pick a snapshot
sudo -u victorhugo cp /opt/victorhugo/server/backups/attendance_backup_<ts>.db /opt/victorhugo/server/attendance.db
sudo systemctl start victorhugo-api
```

WAL files (`attendance.db-wal`, `attendance.db-shm`) will be regenerated on
boot - delete them if a backup restore complains about mismatched indices.
