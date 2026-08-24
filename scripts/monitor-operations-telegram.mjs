import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

import { adminFirestore } from '../backend/_lib/firebase-admin.js';
import { sendTelegram } from './notify-expirations-telegram.mjs';

dotenv.config();

function clean(value) {
  return String(value || '').trim();
}

const SENSITIVE_ERROR_KEYS = /(?:token|secret|password|authorization|cookie|api[_-]?key)/i;

function reportValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 12_000);
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => reportValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
      key,
      SENSITIVE_ERROR_KEYS.test(key) ? '[redacted]' : reportValue(item, depth + 1),
    ]));
  }
  return String(value).slice(0, 12_000);
}

export function buildErrorsReport(errorDocs, { generatedAt = new Date() } = {}) {
  const errors = errorDocs.map(doc => ({ id:clean(doc.id), ...reportValue(doc.data?.() || {}) }));
  return JSON.stringify({
    report:'Vlineups application errors',
    generated_at:generatedAt.toISOString(),
    period_minutes:15,
    events_in_file:errors.length,
    errors,
  }, null, 2);
}

export async function loadRecentErrorDocs(db, { now = () => Date.now(), limit = 100 } = {}) {
  const snapshot = await db.collection('app_errors')
    .where('timestamp', '>=', new Date(now() - 15 * 60_000))
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs;
}

export async function sendTelegramDocument(token, chatId, contents, filename, { fetchImpl = fetch, allowMigration = true } = {}) {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('caption', 'Ошибки приложения за последние 15 минут');
  form.set('document', new Blob([contents], { type:'application/json;charset=utf-8' }), filename);
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, {
    method:'POST', body:form, signal:AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const migratedChatId = clean(payload?.parameters?.migrate_to_chat_id);
    if (allowMigration && migratedChatId) {
      return sendTelegramDocument(token, migratedChatId, contents, filename, { fetchImpl, allowMigration:false });
    }
    const description = clean(payload.description).replace(/[\r\n]+/g, ' ').slice(0, 180);
    throw new Error(`telegram_document_failed:${Number(payload.error_code) || response.status || 0}:${description || 'unknown_error'}`);
  }
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
  return { problems, errorCount };
}

export async function runOperationalMonitor({
  db = adminFirestore(),
  env = process.env,
  collector = collectOperationalProblems,
  sender = sendTelegram,
  documentSender = sendTelegramDocument,
  errorLoader = loadRecentErrorDocs,
  now = () => Date.now(),
} = {}) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chatId) throw new Error('telegram_alerts_not_configured');
  await expireElapsedLocalOrders({ db });
  const collected = await collector({ db, now });
  const problems = Array.isArray(collected) ? collected : collected.problems;
  const errorCount = Array.isArray(collected) ? 0 : Number(collected.errorCount || 0);
  const fingerprint = problems.sort().join('|');
  const stateRef = db.collection('settings').doc('operational_alerts');
  const previous = await stateRef.get();
  const previousData = previous.data() || {};
  const textAlreadySent = previousData.last_fingerprint === fingerprint;
  const documentAlreadySent = previousData.last_document_fingerprint === fingerprint;
  if (textAlreadySent && (errorCount < 5 || documentAlreadySent)) {
    return { sent:false, reason:'unchanged', count:problems.length };
  }
  if (problems.length) {
    if (!textAlreadySent) {
      await sender(token, chatId, ['🚨 VLineups: требуется внимание', '', ...problems.map(value => `• ${value}`)].join('\n'));
    }
    let documentSent = documentAlreadySent;
    let documentError = null;
    if (errorCount >= 5 && !documentAlreadySent) {
      const errorDocs = await errorLoader(db, { now, limit:100 });
      const generatedAt = new Date(now());
      const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
      try {
        await documentSender(token, chatId, buildErrorsReport(errorDocs, { generatedAt }), `vlineups-errors-${timestamp}.json`);
        documentSent = true;
      } catch (error) {
        documentError = clean(error?.message || error).slice(0, 300);
      }
    }
    await stateRef.set({
      last_fingerprint:fingerprint,
      last_count:problems.length,
      last_document_fingerprint:documentSent ? fingerprint : previousData.last_document_fingerprint || null,
      last_document_error:documentError,
      checked_at:FieldValue.serverTimestamp(),
    }, { merge:true });
    return { sent:!textAlreadySent, documentSent, documentError, count:problems.length };
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

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/monitor-operations-telegram.mjs')) {
  runOperationalMonitor()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
