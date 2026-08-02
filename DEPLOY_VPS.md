# Deploy to VPS

## Current production state

As of 2026-08-02, `https://vlineups.ru` runs on the paid Russian VPS at
`212.15.49.68` behind Nginx and PM2. This VPS is the production source of
truth.

The Vercel project's GitHub integration is disconnected and `vlineups.ru` is
no longer attached to Vercel. Do not use Vercel for production deployments.
The Vercel project and `vlineups.tech` are temporarily retained only as a
rollback path; remove them only after a separate stability decision.

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

## App

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/ARTS-DARTS/valorant-upload.git
cd valorant-upload
npm ci
cp .env.example .env
nano .env
```

Fill all values in `.env`.

Install the release deployer and perform the first start through it. The
deployer injects the exact commit SHA required by `/ready`:

```bash
install -o root -g root -m 0750 \
  /var/www/valorant-upload/ops/deploy-valorant-upload.sh \
  /usr/local/bin/deploy-valorant-upload.sh
/usr/local/bin/deploy-valorant-upload.sh
pm2 startup
```

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

```bash
/usr/local/bin/deploy-valorant-upload.sh
tail -n 80 /var/log/valorant-upload-deploy.log
```

Do not update production with raw `git pull`, `npm ci`, or `pm2 restart`.
The deployer builds an isolated release, atomically switches the runtime, and
rolls back to the last confirmed release if readiness fails.

## Automatic update

The systemd timer must remain disabled and inactive until the release/rollback
scenarios have been verified on the VPS:

```bash
systemctl disable --now valorant-upload-autodeploy.timer
systemctl is-enabled valorant-upload-autodeploy.timer
systemctl is-active valorant-upload-autodeploy.timer
```

The canonical script is versioned at `ops/deploy-valorant-upload.sh`. It fetches
`origin/main`, runs syntax and billing tests in an isolated archive, creates an
immutable SHA release, atomically switches `/var/www/valorant-upload-current`,
and accepts the release only when `/ready` returns that exact SHA. The prior
release remains available through `/var/www/valorant-upload-last-good`.

Install or update the deploy script:

```bash
install -o root -g root -m 0750 \
  /var/www/valorant-upload/ops/deploy-valorant-upload.sh \
  /usr/local/bin/deploy-valorant-upload.sh
```

If the deploy script itself changed, reinstall it from the synced control
checkout before the next manual deployment:

```bash
install -o root -g root -m 0750 \
  /var/www/valorant-upload/ops/deploy-valorant-upload.sh \
  /usr/local/bin/deploy-valorant-upload.sh
```

After every runtime push, run the safe update script above and verify that
`/ready` reports the expected Git SHA, then verify the live asset:

```bash
curl -fsSL "https://vlineups.ru/site-version.json?$(date +%s)"
curl -fsSL "https://vlineups.ru/ready?$(date +%s)"
curl -fsSL "https://vlineups.ru/app.js?$(date +%s)" | grep "EXPECTED_NEW_STRING"
```
