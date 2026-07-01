# Deploy to VPS

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

Start:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Check:

```bash
curl http://127.0.0.1:3000/health
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

## Update

```bash
cd /var/www/valorant-upload
git pull
npm ci
pm2 restart valorant-upload
```
