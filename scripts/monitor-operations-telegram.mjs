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
    return data.status === 'pending' && now() - millis(data.created_at) > 35 * 60_000;
  });
  const review = orders.docs.filter(doc => doc.data()?.status === 'requires_review');
  if (stuck.length) problems.push(`Зависшие платежи: ${stuck.length}`);
  if (review.length) problems.push(`Платежи требуют проверки: ${review.length}`);
  const monitoring = await db.collection('billing_monitoring').doc('robokassa').get();
  const lastError = monitoring.data()?.last_webhook_error_at;
  if (lastError && now() - millis(lastError) < 30 * 60_000) {
    problems.push(`Недавняя ошибка webhook: ${monitoring.data()?.last_webhook_error_code || 'неизвестно'}`);
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
    await sender(token, chatId, '✅ VLineups: API и платёжный контур снова в норме.');
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
