import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

import { buildExpirationSnapshot } from '../backend/admin-expirations.js';
import { adminFirestore } from '../backend/_lib/firebase-admin.js';

dotenv.config();

const ALERT_STATUSES = new Set(['critical', 'expired', 'missing', 'warning']);
const STATUS_LABELS = {
  critical:'срочно',
  expired:'истёк',
  missing:'не настроено',
  warning:'скоро',
};

function clean(value) {
  return String(value || '').trim();
}

export function alertFingerprint(items) {
  return items
    .map(item => [item.id, item.status, item.expires_at || '', item.configured].join(':'))
    .sort()
    .join('|');
}

export function buildAlertText(items) {
  const lines = ['⚠️ VLineups: сроки и доступы требуют внимания', ''];
  for (const item of items) {
    const remaining = Number.isFinite(item.days_left)
      ? item.days_left < 0
        ? `просрочено на ${Math.abs(item.days_left)} дн.`
        : `осталось ${item.days_left} дн.`
      : 'срок не задан';
    lines.push(`• ${item.name} — ${STATUS_LABELS[item.status] || item.status}, ${remaining}`);
  }
  lines.push('', 'Откройте в админке: Система → Сроки');
  return lines.join('\n');
}

export async function sendTelegram(token, chatId, text, { allowMigration = true } = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ chat_id:chatId, text }),
    signal:AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const migratedChatId = clean(payload?.parameters?.migrate_to_chat_id);
    if (allowMigration && migratedChatId) {
      return sendTelegram(token, migratedChatId, text, { allowMigration:false });
    }
    const code = Number(payload.error_code) || response.status || 0;
    const description = clean(payload.description).replace(/[\r\n]+/g, ' ').slice(0, 180);
    throw new Error(`telegram_send_failed:${code}:${description || 'unknown_error'}`);
  }
}

export async function runExpirationAlert({
  db = adminFirestore(),
  env = process.env,
  snapshotBuilder = buildExpirationSnapshot,
  sender = sendTelegram,
} = {}) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chatId) throw new Error('telegram_alerts_not_configured');
  const snapshot = await snapshotBuilder({ store:db, env });
  const actionable = snapshot.items.filter(item => ALERT_STATUSES.has(item.status));
  const fingerprint = alertFingerprint(actionable);
  const stateRef = db.collection('settings').doc('credential_expiration_alerts');
  const state = await stateRef.get();
  if (state.data()?.last_fingerprint === fingerprint) {
    return { sent:false, reason:'unchanged', count:actionable.length };
  }
  if (actionable.length) await sender(token, chatId, buildAlertText(actionable));
  else if (state.exists && state.data()?.last_fingerprint) {
    await sender(token, chatId, '✅ VLineups: срочных сроков и доступов больше нет.');
  }
  await stateRef.set({
    last_fingerprint:fingerprint,
    last_count:actionable.length,
    checked_at:FieldValue.serverTimestamp(),
    notified_at:FieldValue.serverTimestamp(),
  }, { merge:true });
  return { sent:true, count:actionable.length };
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
  runExpirationAlert()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
