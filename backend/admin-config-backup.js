import { adminRequestError, applyAdminCors, requireAdminRequest } from './_lib/admin-auth.js';

export function createAdminConfigBackupHandler({ auth, db, env = process.env } = {}) {
  return async function adminConfigBackup(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (req.method !== 'GET') return res.status(405).json({ error:'method_not_allowed' });
      const { db:store } = await requireAdminRequest(req, { auth, db });
      const expiry = await store.collection('settings').doc('credential_expirations').get();
      const envNames = [
        'FIREBASE_SERVICE_ACCOUNT', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_KEY',
        'YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'YANDEX_STATE_SECRET',
        'ROBOKASSA_MERCHANT_LOGIN', 'ROBOKASSA_PASSWORD_1', 'ROBOKASSA_PASSWORD_2',
        'BILLING_RECONCILIATION_TOKEN', 'ACCOUNT_DELETION_PEPPER',
        'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERT_CHAT_ID',
      ];
      res.setHeader('Content-Disposition', `attachment; filename="vlineups-config-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.status(200).json({
        schema_version:1,
        created_at:new Date().toISOString(),
        credential_expirations:expiry.data() || {},
        environment_presence:Object.fromEntries(envNames.map(name => [name, Boolean(String(env[name] || '').trim())])),
        notice:'Secret values are intentionally excluded.',
      });
    } catch (error) {
      return adminRequestError(res, error, 'admin-config-backup');
    }
  };
}

export default createAdminConfigBackupHandler();
