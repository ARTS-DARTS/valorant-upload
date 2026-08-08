import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

import { adminFirestore } from '../backend/_lib/firebase-admin.js';
import { sendTelegram } from './notify-expirations-telegram.mjs';

dotenv.config();

function clean(value) { return String(value || '').trim(); }
function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(date);
  const read = type => parts.find(part => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}
function shiftedDay(days) { return dayKey(new Date(Date.now() - days * 86400000)); }
function number(data, path) {
  return path.split('.').reduce((value, key) => value?.[key], data) || 0;
}
function percent(value, total) { return total > 0 ? `${(value / total * 100).toFixed(1)}%` : '—'; }
function rub(minor) { return `${(Number(minor || 0) / 100).toFixed(2)} ₽`; }

async function readDays(db, collectionName, days) {
  const snapshots = await db.getAll(...days.map(day => db.collection(collectionName).doc(day)));
  return snapshots.map(snapshot => snapshot.data() || {});
}

export async function buildAnalyticsReport({ db, period = 'daily', now = new Date() }) {
  const daysCount = period === 'weekly' ? 7 : 1;
  const days = Array.from({ length:daysCount }, (_, index) => shiftedDay(index + 1));
  const since = new Date(now.getTime() - daysCount * 86400000);
  const [users, dau, wau, mau, errors, activity, funnel, billing, ads, cohorts] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('users').where('last_seen', '>=', new Date(now.getTime() - 86400000)).count().get(),
    db.collection('users').where('last_seen', '>=', new Date(now.getTime() - 7 * 86400000)).count().get(),
    db.collection('users').where('last_seen', '>=', new Date(now.getTime() - 30 * 86400000)).count().get(),
    db.collection('app_errors').where('timestamp', '>=', since).count().get().catch(() => null),
    readDays(db, 'activity_daily', days),
    readDays(db, 'product_funnel_daily', days),
    readDays(db, 'subscription_stats_daily_live', days),
    readDays(db, 'ad_stats_daily', days),
    readDays(db, 'retention_cohorts', [shiftedDay(1), shiftedDay(7), shiftedDay(30)]),
  ]);
  const sum = (rows, path) => rows.reduce((total, row) => total + Number(number(row, path) || 0), 0);
  const totalUsers = Number(users.data().count || 0);
  const dauValue = Number(dau.data().count || 0);
  const wauValue = Number(wau.data().count || 0);
  const mauValue = Number(mau.data().count || 0);
  const views = sum(funnel, 'unique_users.lineup_viewed');
  const likes = sum(funnel, 'unique_users.lineup_liked');
  const favorites = sum(funnel, 'unique_users.lineup_favorited');
  const submissions = sum(funnel, 'unique_users.lineup_submitted');
  const purchases = sum(billing, 'purchases');
  const gross = sum(billing, 'gross_minor');
  const adShown = sum(ads, 'total_shown');
  const rewarded = sum(ads, 'rewarded_shown');
  const completed = sum(ads, 'rewarded_completed');
  // Some legacy clients recorded completion without the matching shown event.
  // A completion proves that a rewarded ad was shown, so it is the safe floor.
  const effectiveRewarded = Math.max(rewarded, completed);
  const returns = [1, 7, 30].map((day, index) => {
    const cohort = cohorts[index] || {};
    return `через ${day} ${day === 1 ? 'день' : 'дней'}: ${percent(Number(cohort[`returned_d${day}`] || 0), Number(cohort.registrations || 0))}`;
  }).join(' · ');
  const title = period === 'weekly' ? '📊 VLineups: недельный отчёт' : '📈 VLineups: ежедневный отчёт';
  return [
    title,
    `Период: ${days.at(-1)} — ${days[0]}`,
    '',
    `👥 Всего пользователей: ${totalUsers}`,
    `Активны: за сутки ${dauValue} · за 7 дней ${wauValue} · за 30 дней ${mauValue}`,
    `Доля активных за сутки среди активных за месяц: ${percent(dauValue, mauValue)}`,
    `Вернулись после регистрации: ${returns}`,
    '',
    `🧭 Действия пользователей: просмотры ${views} → лайки ${likes} → избранное ${favorites} → отправки ${submissions} → покупки ${purchases}`,
    `От просмотров: лайки ${percent(likes, views)} · избранное ${percent(favorites, views)}`,
    `💳 Выручка: ${rub(gross)}`,
    `📢 Реклама: ${adShown} показов · rewarded ${completed}/${effectiveRewarded} (${percent(completed, effectiveRewarded)})`,
    `⚠️ Ошибки: ${Number(errors?.data()?.count || 0)}`,
    '',
    'Возвраты считаются только для пользователей, зарегистрировавшихся после запуска нового счётчика.',
  ].join('\n');
}

export async function runAnalyticsReport({ db = adminFirestore(), env = process.env, period = process.argv.includes('--weekly') ? 'weekly' : 'daily' } = {}) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chatId) throw new Error('telegram_alerts_not_configured');
  const reportKey = period === 'weekly'
    ? `${period}_${shiftedDay(7)}_${shiftedDay(1)}`
    : `${period}_${shiftedDay(1)}`;
  const deliveryRef = db.collection('telegram_report_deliveries').doc(reportKey);
  const claimed = await db.runTransaction(async tx => {
    const current = await tx.get(deliveryRef);
    if (['sending', 'sent'].includes(current.data()?.status)) return false;
    tx.set(deliveryRef, {
      period,
      report_key:reportKey,
      status:'sending',
      attempted_at:FieldValue.serverTimestamp(),
    }, { merge:true });
    return true;
  });
  if (!claimed) return { sent:false, period, reason:'already_sent' };
  try {
    const text = await buildAnalyticsReport({ db, period });
    await sendTelegram(token, chatId, text);
    await deliveryRef.set({ status:'sent', sent_at:FieldValue.serverTimestamp() }, { merge:true });
    return { sent:true, period };
  } catch (error) {
    await deliveryRef.set({ status:'failed', error:String(error.message || error).slice(0, 180) }, { merge:true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
  runAnalyticsReport().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
