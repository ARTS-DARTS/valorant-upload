import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sendPushHandler from './backend/send-push.js';
import notifyAgentSubscribersHandler from './backend/notify-agent-subscribers.js';
import valorantProxyHandler from './backend/valorant-proxy.js';
import yandexCallbackHandler from './backend/yandex-callback.js';
import yandexStartHandler from './backend/yandex-start.js';
import yandexUnlinkHandler from './backend/yandex-unlink.js';
import moderatorApplicationHandler from './backend/moderator-application.js';
import moderationHandler from './backend/moderation.js';
import sitePresenceHandler from './backend/site-presence.js';
import siteVersionHandler from './backend/site-version.js';
import appVersionHandler from './backend/app-version.js';
import pushConfigHandler from './backend/push-config.js';
import { notifySiteUpdateOnce } from './backend/site-update-notifier.js';
import { finalizeExpiredDuels } from './backend/duel-finalizer.js';
import billingMeHandler from './backend/billing-me.js';
import readinessHandler, { firebaseReadiness } from './backend/readiness.js';
import engagementHandler from './backend/engagement.js';
import billingPlansHandler from './backend/billing-plans.js';
import billingCheckoutHandler from './backend/billing-checkout.js';
import billingOrderStatusHandler from './backend/billing-order-status.js';
import billingRefundRequestHandler from './backend/billing-refund-request.js';
import adminBillingHandler from './backend/admin-billing.js';
import accountDeleteHandler, { deleteAccountData } from './backend/account-delete.js';
import { finalizeDueAccountDeletions } from './backend/account-deletion-workflow.js';
import adminExpirationsHandler from './backend/admin-expirations.js';
import adminHealthHandler from './backend/admin-health.js';
import adminConfigBackupHandler from './backend/admin-config-backup.js';
import adminCloudinaryUsageHandler from './backend/admin-cloudinary-usage.js';
import robokassaWebhookHandler from './backend/billing-webhook-robokassa.js';
import robokassaReconciliationHandler from './backend/billing-reconcile-robokassa.js';
import clientErrorHandler from './backend/client-error.js';
import lineupsAccessHandler from './backend/lineups-access.js';
import yandexAdStatsHandler, { syncYandexAdStats } from './backend/yandex-ad-stats.js';
import partnerInquiriesHandler from './backend/partner-inquiries.js';
import appCheckConfigHandler from './backend/app-check-config.js';

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
app.get('/api/app-check-config', appCheckConfigHandler);
app.all('/api/billing/me', billingMeHandler);
app.all('/api/billing/plans', billingPlansHandler);
app.post(
  '/api/billing/webhook/robokassa',
  express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 50 }),
  robokassaWebhookHandler,
);
app.post('/api/internal/billing/reconcile/robokassa', robokassaReconciliationHandler);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.all('/api/billing/refund-request', billingRefundRequestHandler);

app.all('/api/engagement/:action', engagementHandler);
app.all('/api/billing/checkout', billingCheckoutHandler);
app.all('/api/billing/order-status', billingOrderStatusHandler);
app.all('/api/lineups', lineupsAccessHandler);
app.all('/api/lineups/playback-token', lineupsAccessHandler);
app.all('/api/lineups/video', lineupsAccessHandler);
app.all('/api/admin/billing', adminBillingHandler);
app.all('/api/account/delete', accountDeleteHandler);
app.all('/api/admin/expirations', adminExpirationsHandler);
app.all('/api/admin/health', adminHealthHandler);
app.all('/api/admin/config-backup', adminConfigBackupHandler);
app.all('/api/admin/cloudinary-usage', adminCloudinaryUsageHandler);
app.all('/api/admin/yandex-ad-stats', yandexAdStatsHandler);
app.all('/api/partner-inquiries', partnerInquiriesHandler);
app.post('/api/client-error', clientErrorHandler);

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
app.all('/api/app-version', appVersionHandler);
app.all('/api/push-config', pushConfigHandler);

app.get(['/lineups', '/lineups/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'lineups', 'index.html'));
});

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

app.get(['/rewards', '/rewards/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'rewards', 'index.html'));
});

app.get(['/offer', '/offer/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'offer.html'));
});

app.get(['/payment/success', '/payment/success/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'payment-success.html'));
});

app.get(['/payment/fail', '/payment/fail/'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'payment-fail.html'));
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

if (!process.env.VERCEL_RUNTIME) {
  app.listen(port, '127.0.0.1', () => {
    console.log(`Valorant upload site listening on http://127.0.0.1:${port}`);
    if (typeof process.send === 'function') process.send('ready');
    const runDuelFinalizer = () => finalizeExpiredDuels().then(results => {
      const finalized = results.filter(item => item && !item.tie && !item.alreadyFinalized).length;
      if (finalized) console.log(`Finalized duels: ${finalized}`);
    }).catch(error => console.error('duel finalizer:', error));
    setTimeout(runDuelFinalizer, 15000);
    setInterval(runDuelFinalizer, 60000);
    const runAccountDeletionFinalizer = () => finalizeDueAccountDeletions({ deleteAccountData })
      .then(results => {
        if (results.length) console.log(`Account deletion jobs: ${JSON.stringify(results)}`);
      })
      .catch(error => console.error('account deletion finalizer:', error));
    setTimeout(runAccountDeletionFinalizer, 20000);
    setInterval(runAccountDeletionFinalizer, 60000);
    setTimeout(() => notifySiteUpdateOnce()
      .then(result => console.log('Site update push:', result))
      .catch(error => console.error('site update push:', error)), 25000);
    const syncAdRevenue = () => syncYandexAdStats({ days:60 })
      .then(result => console.log(`Yandex ad statistics synced: ${result.rows.length} days`))
      .catch(error => console.error('Yandex ad statistics sync:', error.message));
    setTimeout(syncAdRevenue, 45000);
    setInterval(syncAdRevenue, 3 * 60 * 60 * 1000);
  });
}

export default app;
