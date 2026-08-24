# Deploy to VPS

## Current production state

As of 2026-08-25, `https://vlineups.ru` runs on the paid Russian VPS at
`212.15.49.68` behind Nginx and PM2. This VPS is the production source of
truth.

Production is updated directly from a committed local checkout. Do not use
GitHub, Vercel, a server-side `git pull`, or a mutable working tree as a
release source.

This site needs Node.js because it serves two API routes:

- `/api/yandex-callback`
- `/api/send-push`

The static files are served by the same Node app behind Nginx.

## Server

Recommended minimum:

- Ubuntu 24.04 LTS
- 1 vCPU
- 1 GB RAM
- 15 GB NVMe/SSD

## DNS

Point `vlineups.ru` to the VPS public IPv4:

```text
A  @    VPS_IP
A  www  VPS_IP
```

## Install packages

```bash
apt update
apt install -y nginx git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
```

## App bootstrap

```bash
install -d -m 0750 /var/www/valorant-upload
cd /var/www/valorant-upload
cp .env.example .env
nano .env
```

Fill all values in `.env`.

Transfer the initial control files and protected `.env` through the
operator-approved bootstrap process. Never put `.env` in a release archive.

From the committed Windows checkout, install the protected control-plane once
and deploy the exact local commit:

```powershell
.\install_vps_deployer.ps1
.\deploy_vps_local.ps1
```

The installer creates immutable
`/usr/local/sbin/valorant-upload-deployer`. The old
`/usr/local/bin/deploy-valorant-upload.sh` entrypoint is intentionally
replaced by a blocker that exits with code 64. Run `pm2 startup` separately
on the VPS when boot persistence is first configured.

Check:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

## Nginx

Create `/etc/nginx/sites-available/vlineups.ru`:

```nginx
server {
    listen 80;
    server_name vlineups.ru www.vlineups.ru;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```bash
ln -s /etc/nginx/sites-available/vlineups.ru /etc/nginx/sites-enabled/vlineups.ru
nginx -t
systemctl reload nginx
```

## HTTPS

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d vlineups.ru -d www.vlineups.ru
```

## Yandex OAuth

In the Yandex OAuth app, keep or set the callback URL:

```text
https://vlineups.ru/api/yandex-callback
```

## Safe update

From a clean committed local checkout:

```powershell
.\deploy_vps_local.ps1
```

Do not update production with raw `git pull`, `npm ci`, or `pm2 restart`.
The client verifies that the live SHA is an ancestor of the candidate, uploads
a content-addressed archive, and sends the expected live SHA. The immutable
deployer verifies the archive digest, paths, entry types, and embedded source
marker before running any package code. It then builds an isolated release,
atomically switches the runtime, and rolls back to the last confirmed release
if readiness fails.

An intentional rollback requires an explicit operator action:

```powershell
.\deploy_vps_local.ps1 -AllowRollback
```

## Automatic update

The systemd timer must remain disabled and inactive until the release/rollback
scenarios have been verified on the VPS:

```bash
systemctl disable --now valorant-upload-autodeploy.timer
systemctl is-enabled valorant-upload-autodeploy.timer
systemctl is-active valorant-upload-autodeploy.timer
```

The canonical runtime script is versioned at
`ops/deploy-valorant-upload.sh`, but deployments never execute that mutable
copy. If the control-plane changes, increment `DEPLOYER_API_VERSION`, commit
the change, and install it transactionally before the runtime deployment:

```powershell
.\install_vps_deployer.ps1
.\deploy_vps_local.ps1
```

The installer holds both install and runtime locks, refuses downgrades or a
same-version/different-digest replacement, stages both entrypoints before
mutation, and restores the previous files plus immutable attributes on any
failure.

After every deployment, verify that
`/ready` reports the expected Git SHA, then verify the live asset:

```bash
curl -fsSL "https://vlineups.ru/site-version.json?$(date +%s)"
curl -fsSL "https://vlineups.ru/ready?$(date +%s)"
curl -fsSL "https://vlineups.ru/app.js?$(date +%s)" | grep "EXPECTED_NEW_STRING"
```
