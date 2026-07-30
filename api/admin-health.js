import { adminRequestError, applyAdminCors, requireAdminRequest } from './_lib/admin-auth.js';

function clean(value) {
  return String(value || '').trim();
}

async function checkHttp(url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal:AbortSignal.timeout(8_000) });
    return { ok:response.ok, status:response.status, latency_ms:Date.now() - started };
  } catch {
    return { ok:false, status:null, latency_ms:Date.now() - started };
  }
}

export function createAdminHealthHandler({
  auth,
  db,
  env = process.env,
  httpCheck = checkHttp,
  fetchImpl = fetch,
} = {}) {
  return async function adminHealth(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error:'method_not_allowed' });
      const authorized = await requireAdminRequest(req, { auth, db });
      const store = authorized.db;
      const appId = clean(env.ONESIGNAL_APP_ID);
      const restKey = clean(env.ONESIGNAL_REST_KEY);

      if (req.method === 'POST') {
        if (req.body?.action !== 'push_test') return res.status(400).json({ error:'unsupported_action' });
        if (!appId || !restKey) return res.status(503).json({ error:'onesignal_not_configured' });
        const response = await fetchImpl('https://api.onesignal.com/notifications', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', Authorization:`Key ${restKey}` },
          body:JSON.stringify({
            app_id:appId,
            headings:{ en:'VLineups check', ru:'Проверка VLineups' },
            contents:{ en:'The secure push channel is working.', ru:'Защищённый push-контур работает.' },
            include_aliases:{ external_id:[authorized.decoded.uid] },
            target_channel:'push',
            data:{ type:'admin_health_test' },
          }),
          signal:AbortSignal.timeout(10_000),
        });
        const payload = await response.json().catch(() => ({}));
        return res.status(response.ok ? 200 : 502).json({
          ok:response.ok,
          provider_status:response.status,
          notification_id:payload.id || null,
          recipients:Number(payload.recipients) || 0,
        });
      }

      const [api, oneSignal, alertState] = await Promise.all([
        httpCheck('https://vlineups.ru/ready'),
        appId && restKey
          ? httpCheck(`https://api.onesignal.com/apps/${encodeURIComponent(appId)}`, {
              headers:{ Authorization:`Key ${restKey}` },
            })
          : Promise.resolve({ ok:false, status:null, latency_ms:null }),
        store.collection('settings').doc('credential_expiration_alerts').get(),
      ]);
      const alertData = alertState.data() || {};
      const checks = [
        { id:'api', name:'VPS API', ...api },
        { id:'firebase', name:'Firebase Admin', ok:true, status:200, latency_ms:null },
        { id:'onesignal', name:'OneSignal', ...oneSignal, configured:Boolean(appId && restKey) },
        { id:'yandex', name:'Яндекс OAuth', ok:Boolean(clean(env.YANDEX_CLIENT_ID) && clean(env.YANDEX_CLIENT_SECRET) && clean(env.YANDEX_STATE_SECRET)), configured:true },
        { id:'telegram', name:'Telegram alerts', ok:Boolean(alertData.checked_at), configured:Boolean(clean(env.TELEGRAM_BOT_TOKEN) && clean(env.TELEGRAM_ALERT_CHAT_ID)), last_check:alertData.checked_at?.toDate?.()?.toISOString?.() || null },
        { id:'robokassa', name:'Robokassa', ok:Boolean(clean(env.ROBOKASSA_MERCHANT_LOGIN) && clean(env.ROBOKASSA_PASSWORD_1) && clean(env.ROBOKASSA_PASSWORD_2)), configured:Boolean(clean(env.ROBOKASSA_MERCHANT_LOGIN)) },
      ];
      return res.status(200).json({
        checked_at:new Date().toISOString(),
        ok:checks.filter(item => item.id !== 'robokassa').every(item => item.ok),
        checks,
      });
    } catch (error) {
      return adminRequestError(res, error, 'admin-health');
    }
  };
}

export default createAdminHealthHandler();
