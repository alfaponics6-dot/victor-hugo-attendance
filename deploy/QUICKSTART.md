# Quickstart — first deploy to Oracle Cloud (copy-paste)

Read [DEPLOYMENT.md](DEPLOYMENT.md) first for full context; this file is the
minimum command set, in order. Replace `<DOMAIN>` and `<EMAIL>` where you see
them.

## Prereqs

You need: an Oracle Cloud account with Always-Free tier available, a
domain you control, and your laptop.

### Option A — provision via Cloud Shell (recommended, all-CLI)

1. Open the Oracle Cloud console → **Developer Tools → Cloud Shell** (the
   `>_` button top-right). The `oci` CLI is preauthenticated for you.

2. Paste this into Cloud Shell (replace `<DOMAIN>` first):

   ```bash
   curl -sLO https://raw.githubusercontent.com/alfaponics6-dot/victor-hugo-attendance/main/deploy/cloud-shell-launch.sh
   chmod +x cloud-shell-launch.sh
   DOMAIN=<DOMAIN> SHAPE=A1 ./cloud-shell-launch.sh
   ```

   Use `SHAPE=MICRO` for the 1 OCPU / 1 GB E2.1.Micro Always Free shape.
   The script creates: VCN, internet gateway, route table, security list
   (22/80/443), subnet, and the VM. Idempotent — safe to re-run; it reuses
   any resource matching by name. Outputs the public IP at the end.

3. Point your domain's A record at the printed public IP. Verify with
   `dig +short <DOMAIN>` from anywhere — it should return the IP within
   1-5 minutes of the DNS change.

### Option B — provision via console (clicks, slower)

1. **Compute → Instances → Create instance**, shape VM.Standard.A1.Flex,
   2 OCPU + 12 GB, Ubuntu 22.04 image, paste SSH key, attach to a subnet
   with public-IP enabled.
2. **Networking → VCN security list** — open ingress for TCP 22, 80, 443.
3. Point DNS as in Option A step 3.

## On the VM (SSH in: `ssh opc@<public-ip>` or `ubuntu@<public-ip>`)

```bash
# 1. Become root for the rest.
sudo -i

# 2. Pull the code.
mkdir -p /opt && cd /opt
git clone https://github.com/alfaponics6-dot/victor-hugo-attendance.git victorhugo
cd victorhugo

# 4. Create the .env (use the production template).
cp server/.env.production.example server/.env
nano server/.env        # edit CORS_ORIGINS=https://<DOMAIN> ; rotate JWT_SECRET if you want
chmod 600 server/.env

# 5. Run the bootstrap (installs Node, builds client+server, sets up nginx,
#    systemd, certbot, logrotate, backup cron). Idempotent.
DOMAIN=<DOMAIN> ADMIN_EMAIL=<EMAIL> ./deploy/bootstrap.sh

# 6. Smoke test from the VM itself.
curl -sS https://<DOMAIN>/api/health
curl -sS https://<DOMAIN>/api/health/ready
# → both should return JSON {"status":"...","db":"up"}
```

## From your laptop after the cert is issued

```bash
# 7. Open the SPA — log in as Carly (leader id=3) with the LEADER_ACCESS_CODE
#    you set in .env to sanity-check that auth flows end-to-end.
open "https://<DOMAIN>"   # mac
# or: start https://<DOMAIN>   on Windows

# 8. Concurrency smoke (optional but recommended on first deploy).
git clone <YOUR-REPO-URL> /tmp/vh-test
cd /tmp/vh-test
BASE=https://<DOMAIN>/api LEADER_ACCESS_CODE=<your-code> \
  node server/scripts/load-test-attendance.js --date=2027-01-15
# → expected: 7 OK + 7 conflict + 0 failed
```

## What systemd will do on reboot

- `victorhugo-api.service` auto-starts ([deploy/victorhugo-api.service](victorhugo-api.service)).
- nginx auto-starts.
- Cron runs `/etc/cron.d/victorhugo-backup` nightly at 02:30 → snapshot into
  `/opt/victorhugo/server/backups/` with 30-day retention.
- Cron renews certbot certs monthly.

## If something breaks

```bash
sudo systemctl status victorhugo-api          # is the API alive?
sudo journalctl -u victorhugo-api -n 100      # last 100 server log lines
sudo nginx -t                                 # is nginx config valid?
sudo systemctl reload nginx                   # apply nginx changes without dropping connections
```

## Rolling forward later

```bash
cd /opt/victorhugo
sudo -u root git pull --ff-only
cd server && sudo -u root npm ci --omit=dev
cd ../client && sudo -u root npm ci && sudo -u root npm run build
sudo systemctl restart victorhugo-api
sudo systemctl reload nginx
```

The SIGTERM handler in `server/src/index.js` drains in-flight requests up to
9 s before forcing exit, so a restart at a busy moment loses at most one wave.
