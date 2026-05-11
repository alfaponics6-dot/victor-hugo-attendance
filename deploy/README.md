# deploy/

Production deployment artifacts for Oracle Cloud (or any Linux VM with nginx
+ systemd). See `DEPLOYMENT.md` for the full walkthrough.

| File | Where it lands on the VM |
|---|---|
| `DEPLOYMENT.md` | Reference doc, no install path |
| `victorhugo-api.service` | `/etc/systemd/system/victorhugo-api.service` |
| `nginx-victorhugo.conf` | `/etc/nginx/conf.d/victorhugo.conf` |
| `backup-cron` | `/etc/cron.d/victorhugo-backup` |
| `logrotate-victorhugo` | `/etc/logrotate.d/victorhugo` |
