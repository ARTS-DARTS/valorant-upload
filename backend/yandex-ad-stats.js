import { adminFirestore } from './_lib/firebase-admin.js';
import { adminRequestError, applyAdminCors, requireAdminRequest } from './_lib/admin-auth.js';

const API_URL = 'https://partner.yandex.ru/api/statistics2/get.json';
const CACHE_COLLECTION = 'ad_revenue_daily';
const META_PATH = 'admin_stats/yandex_ad_revenue';
const DEFAULT_DAYS = 60;
const MAX_DAYS = 90;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const FORMAT_KEYS = Object.freeze({
  'App: Баннер':'banner',
  'App: Межстраничная реклама':'interstitial',
  'App: С вознаграждением':'rewarded',
});

function clean(value) {
  return String(value || '').trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round((finite(value) + Number.EPSILON) * multiplier) / multiplier;
}

function moscowDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(value);
}

function daysAgo(count) {
  return moscowDay(new Date(Date.now() - Math.max(0, count) * 86400000));
}

function emptyMetrics() {
  return { requests:0, matched:0, visible_impressions:0, impressions:0, revenue_rub:0 };
}

function addMetrics(target, source = {}) {
  target.requests += finite(source.hits);
  target.matched += finite(source.hits_render);
  target.visible_impressions += finite(source.shows);
  target.impressions += finite(source.impressions);
  target.revenue_rub += finite(source.partner_wo_nds);
}

function finalizeMetrics(source) {
  const requests = Math.round(source.requests);
  const matched = Math.round(source.matched);
  const visible = Math.round(source.visible_impressions);
  const impressions = Math.round(source.impressions);
  const revenue = round(source.revenue_rub, 2);
  return {
    requests,
    matched,
    visible_impressions:visible,
    impressions,
    revenue_rub:revenue,
    fill_rate:round(requests ? matched / requests * 100 : 0, 2),
    show_rate:round(matched ? impressions / matched * 100 : 0, 2),
    visibility_rate:round(impressions ? visible / impressions * 100 : 0, 2),
    ecpm_rub:round(impressions ? revenue / impressions * 1000 : 0, 2),
  };
}

export function normalizeYandexAdStats(payload) {
  if (payload?.result !== 'ok' || !Array.isArray(payload?.data?.points)) {
    throw Object.assign(new Error('yandex_statistics_invalid_response'), { status:502 });
  }
  const byDay = new Map();
  for (const point of payload.data.points) {
    const day = Array.isArray(point?.dimensions?.date)
      ? clean(point.dimensions.date[0])
      : clean(point?.dimensions?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const format = FORMAT_KEYS[clean(point?.dimensions?.block_type)] || 'other';
    const measures = Array.isArray(point.measures) ? point.measures[0] : point.measures;
    if (!measures || typeof measures !== 'object') continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        date:day,
        total:emptyMetrics(),
        formats:{ banner:emptyMetrics(), interstitial:emptyMetrics(), rewarded:emptyMetrics(), other:emptyMetrics() },
      });
    }
    const row = byDay.get(day);
    addMetrics(row.total, measures);
    addMetrics(row.formats[format], measures);
  }
  return [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({
      date:row.date,
      currency:'RUB',
      total:finalizeMetrics(row.total),
      formats:Object.fromEntries(Object.entries(row.formats).map(([key, value]) => [key, finalizeMetrics(value)])),
      source:'yandex_partner_statistics_api',
    }));
}

export async function fetchYandexAdStats({ token, days = DEFAULT_DAYS, fetchImpl = fetch } = {}) {
  const secret = clean(token);
  if (!secret) throw Object.assign(new Error('yandex_statistics_token_missing'), { status:503 });
  const safeDays = Math.min(MAX_DAYS, Math.max(1, Number(days) || DEFAULT_DAYS));
  const url = new URL(API_URL);
  url.searchParams.set('lang', 'ru');
  url.searchParams.append('period', daysAgo(safeDays - 1));
  url.searchParams.append('period', moscowDay());
  url.searchParams.set('dimension_field', 'date|day');
  url.searchParams.append('entity_field', 'ad_type');
  url.searchParams.append('entity_field', 'block_type');
  for (const field of ['hits', 'hits_render', 'shows', 'impressions', 'partner_wo_nds']) {
    url.searchParams.append('field', field);
  }
  url.searchParams.set('currency', 'RUB');
  url.searchParams.set('timezone', 'Europe/Moscow');
  url.searchParams.set('limits', JSON.stringify({ limit:5000, offset:0 }));
  const response = await fetchImpl(url, {
    headers:{ Authorization:`OAuth ${secret}`, Accept:'application/json' },
    signal:AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    console.error('Yandex statistics API error:', response.status);
    throw Object.assign(new Error('yandex_statistics_api_unavailable'), { status:502 });
  }
  return normalizeYandexAdStats(await response.json());
}

export async function syncYandexAdStats({
  db = adminFirestore(),
  env = process.env,
  days = DEFAULT_DAYS,
  fetchImpl = fetch,
} = {}) {
  const rows = await fetchYandexAdStats({
    token:env.YANDEX_PARTNER_STATISTICS_TOKEN,
    days,
    fetchImpl,
  });
  const syncedAt = new Date().toISOString();
  let batch = db.batch();
  let operations = 0;
  for (const row of rows) {
    batch.set(db.collection(CACHE_COLLECTION).doc(row.date), { ...row, updated_at:syncedAt });
    operations++;
    if (operations === 400) {
      await batch.commit();
      batch = db.batch();
      operations = 0;
    }
  }
  batch.set(db.doc(META_PATH), {
    updated_at:syncedAt,
    first_date:rows[0]?.date || null,
    last_date:rows.at(-1)?.date || null,
    days:rows.length,
    ok:true,
  }, { merge:true });
  await batch.commit();
  return { rows, updated_at:syncedAt };
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const millis = new Date(value || 0).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

async function readCachedStats(db, days) {
  const snapshot = await db.collection(CACHE_COLLECTION).orderBy('date', 'desc').limit(days).get();
  return snapshot.docs.map(doc => doc.data()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function createYandexAdStatsHandler({ auth, db, env = process.env, fetchImpl = fetch } = {}) {
  return async function yandexAdStatsHandler(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error:'method_not_allowed' });
      const authorized = await requireAdminRequest(req, { auth, db });
      const store = authorized.db;
      const requestedDays = Math.min(MAX_DAYS, Math.max(1, Number(req.query?.days || req.body?.days) || DEFAULT_DAYS));
      const meta = await store.doc(META_PATH).get();
      const stale = Date.now() - timestampMillis(meta.data()?.updated_at) > CACHE_MAX_AGE_MS;
      const force = req.method === 'POST' || req.query?.refresh === '1';
      let result;
      if (force || stale || !meta.exists) {
        result = await syncYandexAdStats({ db:store, env, days:requestedDays, fetchImpl });
      } else {
        result = { rows:await readCachedStats(store, requestedDays), updated_at:meta.data()?.updated_at || null };
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok:true, currency:'RUB', days:result.rows, updated_at:result.updated_at });
    } catch (error) {
      return adminRequestError(res, error, 'yandex-ad-stats');
    }
  };
}

export default createYandexAdStatsHandler();
