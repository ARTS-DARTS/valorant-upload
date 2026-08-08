import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

import { adminFirestore } from '../backend/_lib/firebase-admin.js';
import { sendTelegram } from './notify-expirations-telegram.mjs';

dotenv.config();

function clean(value) {
  return String(value || '').trim();
}

function millis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function moscowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23',
  }).formatToParts(date);
  const read = type => parts.find(part => part.type === type)?.value || '';
  return { day:`${read('year')}-${read('month')}-${read('day')}`, hour:Number(read('hour') || 0) };
}

export async function expireElapsedLocalOrders({ db, now = () => Date.now() } = {}) {
  const cutoffMillis = now() - 15 * 60_000;
  const snapshot = await db.collection('billing_orders')
    .where('status', '==', 'pending')
    .limit(100)
    .get();
  const elapsed = snapshot.docs.filter(order => {
    const expiresAt = millis(order.data()?.expires_at);
    return expiresAt > 0 && expiresAt <= cutoffMillis;
  });
  if (!elapsed.length) return 0;
  const batch = db.batch();
  for (const order of elapsed) {
    batch.set(order.ref, {
      status:'expired',
      expired_at:FieldValue.serverTimestamp(),
      updated_at:FieldValue.serverTimestamp(),
      expiration_reason:'checkout_window_elapsed',
      last_reconcile_action:'expired_local_order',
    }, { merge:true });
  }
  await batch.commit();
  return elapsed.length;
}

export async function collectOperationalProblems({
  db,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const problems = [];
  try {
    const response = await fetchImpl('https://vlineups.ru/ready', {
      signal:AbortSignal.timeout(10_000),
      cache:'no-store',
    });
    if (!response.ok) problems.push(`API недоступен: HTTP ${response.status}`);
  } catch {
    problems.push('API недоступен: нет ответа');
  }
  const orders = await db.collection('billing_orders')
    .orderBy('created_at', 'desc').limit(100).get();
  const stuck = orders.docs.filter(doc => {
    const data = doc.data() || {};
    return data.test_mode === false && data.status === 'pending' &&
      now() - millis(data.created_at) > 35 * 60_000;
  });
  const review = orders.docs.filter(doc => {
    const data = doc.data() || {};
    return data.test_mode === false && data.status === 'requires_review';
  });
  if (stuck.length) problems.push(`Зависшие платежи: ${stuck.length}`);
  if (review.length) problems.push(`Платежи требуют проверки: ${review.length}`);
  const monitoring = await db.collection('billing_monitoring').doc('robokassa').get();
  const lastError = monitoring.data()?.last_webhook_error_at;
  if (lastError && now() - millis(lastError) < 30 * 60_000) {
    problems.push(`Недавняя ошибка webhook: ${monitoring.data()?.last_webhook_error_code || 'неизвестно'}`);
  }
  const recentErrors = await db.collection('app_errors')
    .where('timestamp', '>=', new Date(now() - 15 * 60_000)).count().get().catch(() => null);
  const errorCount = Number(recentErrors?.data()?.count || 0);
  if (errorCount >= 5) problems.push(`Всплеск ошибок приложения: ${errorCount} за 15 минут`);

  const cron = await db.collection('cron_logs').orderBy('run_at', 'desc').limit(3).get().catch(() => null);
  const latestCron = cron?.docs?.[0]?.data?.() || null;
  if (latestCron?.ok === false && now() - millis(latestCron.run_at) < 6 * 60 * 60_000) {
    problems.push(`Cron cleanup_bots завершился с ошибками: ${Number(latestCron.stats?.errors || 0)}`);
  } else if (!latestCron || now() - millis(latestCron.run_at) > 30 * 60 * 60_000) {
    problems.push('Cron cleanup_bots не запускался более 30 часов');
  }

  const moscow = moscowParts(new Date(now()));
  if (moscow.hour >= 9) {
    const yesterday = moscowParts(new Date(now() - 86400000)).day;
    const adStats = await db.collection('ad_stats_daily').doc(yesterday).get();
    if (!adStats.exists) problems.push(`Нет рекламного агрегата за ${yesterday}`);
  }
  return problems;
}

export async function runOperationalMonitor({
  db = adminFirestore(),
  env = process.env,
  collector = collectOperationalProblems,
  sender = sendTelegram,
} = {}) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chatId) throw new Error('telegram_alerts_not_configured');
  await expireElapsedLocalOrders({ db });
  const problems = await collector({ db });
  const fingerprint = problems.sort().join('|');
  const stateRef = db.collection('settings').doc('operational_alerts');
  const previous = await stateRef.get();
  if (previous.data()?.last_fingerprint === fingerprint) {
    return { sent:false, reason:'unchanged', count:problems.length };
  }
  if (problems.length) {
    await sender(token, chatId, ['🚨 VLineups: требуется внимание', '', ...problems.map(value => `• ${value}`)].join('\n'));
  } else if (previous.exists && previous.data()?.last_fingerprint) {
    await sender(token, chatId, '✅ VLineups: операционный мониторинг снова в норме.');
  }
  await stateRef.set({
    last_fingerprint:fingerprint,
    last_count:problems.length,
    checked_at:FieldValue.serverTimestamp(),
  }, { merge:true });
  return { sent:true, count:problems.length };
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
  runOperationalMonitor()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
