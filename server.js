import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sendPushHandler from './api/send-push.js';
import notifyAgentSubscribersHandler from './api/notify-agent-subscribers.js';
import valorantProxyHandler from './api/valorant-proxy.js';
import yandexCallbackHandler from './api/yandex-callback.js';
import yandexStartHandler from './api/yandex-start.js';
import yandexUnlinkHandler from './api/yandex-unlink.js';
import moderatorApplicationHandler from './api/moderator-application.js';
import moderationHandler from './api/moderation.js';
import sitePresenceHandler from './api/site-presence.js';
import siteVersionHandler from './api/site-version.js';
import pushConfigHandler from './api/push-config.js';
import { notifySiteUpdateOnce } from './api/site-update-notifier.js';
import { finalizeExpiredDuels } from './api/duel-finalizer.js';
import billingMeHandler from './api/billing-me.js';
import readinessHandler, { firebaseReadiness } from './api/readiness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/ready', readinessHandler);
app.all('/api/billing/me', billingMeHandler);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  express.static(__dirname, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('app.js') || filePath.endsWith('styles.css')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    },
  }),
);

app.all('/api/send-push', sendPushHandler);
app.all('/api/notify-agent-subscribers', notifyAgentSubscribersHandler);
app.all('/api/valorant-proxy', valorantProxyHandler);
app.all('/api/yandex-start', yandexStartHandler);
app.all('/api/yandex-unlink', yandexUnlinkHandler);
app.all('/api/yandex-callback', yandexCallbackHandler);
app.all('/api/moderator-application', moderatorApplicationHandler);
app.all('/api/moderation', moderationHandler);
app.all('/api/site-presence', sitePresenceHandler);
app.all('/api/site-version', siteVersionHandler);
app.all('/api/push-config', pushConfigHandler);

app.get(['/author-training', '/author-training/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'author-training', 'index.html'));
});

app.get(['/author-training/defense', '/author-training/defense/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'author-training', 'defense', 'index.html'));
});

app.get(['/author-training/lineups', '/author-training/lineups/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'author-training', 'lineups', 'index.html'));
});

app.get(['/author-training/combo', '/author-training/combo/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'author-training', 'combo', 'index.html'));
});

app.get(['/author-training/wallbang', '/author-training/wallbang/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'author-training', 'wallbang', 'index.html'));
});

app.get(['/upload-redesign-preview', '/upload-redesign-preview/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'upload-redesign-preview', 'index.html'));
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

const production = process.env.NODE_ENV === 'production';
if (production) {
  const firebaseReady = await firebaseReadiness.check();
  if (!firebaseReady) {
    throw new Error('Firebase readiness validation failed');
  }
} else {
  void firebaseReadiness.check();
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Valorant upload site listening on http://127.0.0.1:${port}`);
  if (typeof process.send === 'function') process.send('ready');
  const runDuelFinalizer = () => finalizeExpiredDuels().then(results => {
    const finalized = results.filter(item => item && !item.tie && !item.alreadyFinalized).length;
    if (finalized) console.log(`Finalized duels: ${finalized}`);
  }).catch(error => console.error('duel finalizer:', error));
  setTimeout(runDuelFinalizer, 15000);
  setInterval(runDuelFinalizer, 60000);
  setTimeout(() => notifySiteUpdateOnce()
    .then(result => console.log('Site update push:', result))
    .catch(error => console.error('site update push:', error)), 25000);
});
