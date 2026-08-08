import { adminRequestError, applyAdminCors, requireAdminRequest } from './_lib/admin-auth.js';

function clean(value) {
  return String(value || '').trim();
}

function millis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function moscowDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(value);
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

      const yesterday = moscowDay(new Date(Date.now() - 86400000));
      const [api, oneSignal, alertState, cronSnap, analyticsSnap, reportSnap, billingSnap] = await Promise.all([
        httpCheck('https://vlineups.ru/ready'),
        appId && restKey
          ? httpCheck(`https://api.onesignal.com/apps/${encodeURIComponent(appId)}`, {
              headers:{ Authorization:`Key ${restKey}` },
            })
          : Promise.resolve({ ok:false, status:null, latency_ms:null }),
        store.collection('settings').doc('credential_expiration_alerts').get(),
        store.collection('cron_logs').orderBy('run_at', 'desc').limit(1).get().catch(() => null),
        store.collection('activity_daily').doc(yesterday).get().catch(() => null),
        store.collection('telegram_report_deliveries').doc(`daily_${yesterday}`).get().catch(() => null),
        store.collection('billing_monitoring').doc('robokassa').get().catch(() => null),
      ]);
      const alertData = alertState.data() || {};
      const cronData = cronSnap?.docs?.[0]?.data?.() || {};
      const cronAge = Date.now() - millis(cronData.run_at);
      const analyticsData = analyticsSnap?.data?.() || {};
      const reportData = reportSnap?.data?.() || {};
      const billingData = billingSnap?.data?.() || {};
      const robokassaConfigured = Boolean(clean(env.ROBOKASSA_MERCHANT_LOGIN) && clean(env.ROBOKASSA_PASSWORD_1) && clean(env.ROBOKASSA_PASSWORD_2));
      const checks = [
        { id:'api', name:'VPS API', ...api },
        { id:'firebase', name:'Firebase Admin', ok:true, status:200, latency_ms:null },
        { id:'onesignal', name:'OneSignal', ...oneSignal, configured:Boolean(appId && restKey) },
        { id:'yandex', name:'Яндекс OAuth', ok:Boolean(clean(env.YANDEX_CLIENT_ID) && clean(env.YANDEX_CLIENT_SECRET) && clean(env.YANDEX_STATE_SECRET)), configured:true },
        { id:'telegram', name:'Telegram-уведомления', ok:Boolean(alertData.checked_at), configured:Boolean(clean(env.TELEGRAM_BOT_TOKEN) && clean(env.TELEGRAM_ALERT_CHAT_ID)), last_check:alertData.checked_at?.toDate?.()?.toISOString?.() || null },
        { id:'cron', name:'Ежедневная очистка', ok:Boolean(cronData.run_at) && cronData.ok !== false && cronAge <= 30 * 60 * 60_000, status:cronData.ok === false ? 500 : 200, last_check:cronData.run_at?.toDate?.()?.toISOString?.() || null },
        { id:'analytics', name:'Данные за вчера', ok:Boolean(analyticsSnap?.exists), status:analyticsSnap?.exists ? 200 : 404, date:yesterday, users:Number(analyticsData.unique_users) || 0 },
        { id:'daily_report', name:'Ежедневный отчёт', ok:reportData.status === 'sent', status:reportData.status === 'sent' ? 200 : 404, date:yesterday },
        { id:'robokassa', name:'Платежи Robokassa', ok:robokassaConfigured && (!billingData.last_webhook_error_at || Date.now() - millis(billingData.last_webhook_error_at) > 30 * 60_000), configured:robokassaConfigured, last_check:billingData.updated_at?.toDate?.()?.toISOString?.() || null },
      ];
      return res.status(200).json({
        checked_at:new Date().toISOString(),
        ok:checks.every(item => item.ok),
        checks,
      });
    } catch (error) {
      return adminRequestError(res, error, 'admin-health');
    }
  };
}

export default createAdminHealthHandler();
