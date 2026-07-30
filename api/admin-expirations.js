import net from 'node:net';
import tls from 'node:tls';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

const ALLOWED_ORIGINS = new Set([
  'https://arts-darts.github.io',
  'http://localhost:3000',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/;
const CATALOG = Object.freeze([
  { id:'domain_vlineups', name:'Домен vlineups.ru', group:'Инфраструктура', kind:'expiry', automatic:'domain', action:'Продлить в REG.RU до остановки делегирования' },
  { id:'tls_vlineups', name:'SSL vlineups.ru', group:'Инфраструктура', kind:'expiry', automatic:'tls', action:'Проверить certbot и автоматическое продление' },
  { id:'vps_onedash', name:'VPS OneDash', group:'Инфраструктура', kind:'expiry', default_expires_at:'2027-01-31T00:00:00+03:00', action:'Пополнить баланс и продлить сервер' },
  { id:'play_signing', name:'Сертификат подписи Google Play', group:'Публикация', kind:'expiry', action:'Проверить срок upload/app-signing certificate' },
  { id:'terms_review', name:'Оферта и условия подписки', group:'Юридическое', kind:'review', default_expires_at:'2027-08-01T00:00:00+03:00', action:'Ежегодно пересмотреть реквизиты, цены и формулировки' },
  { id:'firebase_admin', name:'Firebase service account', group:'Серверные ключи', kind:'rotation', interval_days:365, env:['FIREBASE_SERVICE_ACCOUNT'] },
  { id:'onesignal_rest', name:'OneSignal REST API key', group:'Серверные ключи', kind:'rotation', interval_days:180, env:['ONESIGNAL_REST_KEY'] },
  { id:'yandex_oauth', name:'Яндекс OAuth secret', group:'Серверные ключи', kind:'rotation', interval_days:180, env:['YANDEX_CLIENT_ID','YANDEX_CLIENT_SECRET'] },
  { id:'robokassa_passwords', name:'Пароли Robokassa №1/№2', group:'Платежи', kind:'rotation', interval_days:180, env:['ROBOKASSA_MERCHANT_LOGIN','ROBOKASSA_PASSWORD_1','ROBOKASSA_PASSWORD_2'] },
  { id:'billing_reconcile', name:'Токен reconciliation', group:'Платежи', kind:'rotation', interval_days:180, env:['BILLING_RECONCILIATION_TOKEN'] },
  { id:'deletion_pepper', name:'Account deletion pepper', group:'Серверные ключи', kind:'rotation', interval_days:365, env:['ACCOUNT_DELETION_PEPPER'] },
  { id:'admin_secret_legacy', name:'Legacy ADMIN_SECRET в браузере', group:'Критические', kind:'critical', env:['ADMIN_SECRET'], action:'Убрать x-admin-key из HTML и перевести endpoints на Firebase admin auth' },
  { id:'selectel_s3', name:'Selectel S3 access/secret keys', group:'Firebase Functions', kind:'rotation', interval_days:180, manual_presence:true },
  { id:'google_translation', name:'Google Translation credentials', group:'Firebase Functions', kind:'rotation', interval_days:365, manual_presence:true },
  { id:'identity_toolkit', name:'Identity Toolkit API key', group:'Firebase Functions', kind:'review', interval_days:365, manual_presence:true },
  { id:'github_deploy', name:'GitHub/SSH deploy-доступы', group:'Публикация', kind:'rotation', interval_days:365, manual_presence:true },
]);
const IDS = new Set(CATALOG.map(item => item.id));

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function bearer(req) {
  const value = String(req.headers?.authorization || '');
  if (!value.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  return value.slice(7);
}
function toIso(value) {
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return null;
}
async function requireAdmin(db, auth, req) {
  const decoded = await auth.verifyIdToken(bearer(req), true);
  const user = await db.collection('users').doc(decoded.uid).get();
  if (!user.exists || String(user.data()?.role || '').toLowerCase() !== 'admin') {
    throw fail(403, 'admin_required');
  }
  return decoded;
}
function probeTls(host, timeoutMs = 5000) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port:443, servername:host, rejectUnauthorized:true });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('secureConnect', () => finish(socket.getPeerCertificate()?.valid_to || null));
    socket.once('error', () => finish(null));
  });
}
function probeWhois(domain, timeoutMs = 5000) {
  return new Promise(resolve => {
    const socket = net.connect(43, 'whois.tcinet.ru');
    let response = '';
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('connect', () => socket.write(`${domain}\r\n`));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('end', () => {
      const match = response.match(/^paid-till:\s*(.+)$/mi);
      finish(match?.[1]?.trim() || null);
    });
    socket.once('error', () => finish(null));
  });
}
function dateMillis(value) {
  const result = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(result) ? result : null;
}
function buildItem(item, metadata, automaticDate, env, now) {
  const configured = item.env
    ? item.env.every(name => String(env[name] || '').trim().length > 0)
    : metadata.configured ?? (item.manual_presence ? null : true);
  const lastRotated = toIso(metadata.last_rotated_at);
  let dueAt = automaticDate || toIso(metadata.expires_at) || item.default_expires_at || null;
  if (!dueAt && item.interval_days && lastRotated) {
    dueAt = new Date(new Date(lastRotated).getTime() + item.interval_days * 864e5).toISOString();
  }
  const dueMillis = dateMillis(dueAt);
  const daysLeft = dueMillis === null ? null : Math.ceil((dueMillis - now.getTime()) / 864e5);
  let status = 'ok';
  if (item.kind === 'critical') status = 'critical';
  else if (configured === false) status = 'missing';
  else if (dueMillis === null && ['expiry','rotation','review'].includes(item.kind)) status = 'unknown';
  else if (daysLeft < 0) status = 'expired';
  else if (daysLeft <= 14) status = 'critical';
  else if (daysLeft <= 45) status = 'warning';
  return {
    ...item,
    configured,
    expires_at:dueAt,
    last_rotated_at:lastRotated,
    days_left:daysLeft,
    status,
    notes:String(metadata.notes || '').slice(0, 500),
  };
}

export function createAdminExpirationsHandler({
  db = null,
  auth = null,
  env = process.env,
  now = () => new Date(),
  tlsProbe = () => probeTls('vlineups.ru'),
  domainProbe = () => probeWhois('vlineups.ru'),
} = {}) {
  return async function adminExpirationsHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = String(req.headers?.origin || '');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error:'origin_not_allowed' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const store = db ?? adminFirestore();
      const admin = await requireAdmin(store, auth ?? adminAuth(), req);
      const configRef = store.collection('settings').doc('credential_expirations');
      if (req.method === 'POST') {
        const id = String(req.body?.id || '');
        if (!IDS.has(id)) throw fail(400, 'invalid_item');
        const currentSnap = await configRef.get();
        const currentItems = currentSnap.data()?.items || {};
        const update = { ...(currentItems[id] || {}) };
        for (const key of ['expires_at','last_rotated_at']) {
          const value = req.body?.[key];
          if (value === null || value === '') update[key] = null;
          else if (typeof value === 'string' && DATE_RE.test(value) && dateMillis(value) !== null) update[key] = value;
          else if (value !== undefined) throw fail(400, 'invalid_date');
        }
        if (req.body?.configured !== undefined) update.configured = req.body.configured === true;
        if (req.body?.notes !== undefined) update.notes = String(req.body.notes).slice(0, 500);
        update.updated_at = now().toISOString();
        update.updated_by = admin.uid;
        await configRef.set({ items:{ ...currentItems, [id]:update } }, { merge:true });
      } else if (req.method !== 'GET') {
        return res.status(405).json({ error:'method_not_allowed' });
      }
      const [configSnap, tlsDate, domainDate] = await Promise.all([
        configRef.get(),
        tlsProbe(),
        domainProbe(),
      ]);
      const metadata = configSnap.data()?.items || {};
      const automatic = {
        tls_vlineups:tlsDate ? new Date(tlsDate).toISOString() : null,
        domain_vlineups:domainDate ? new Date(domainDate).toISOString() : null,
      };
      const items = CATALOG.map(item => buildItem(
        item, metadata[item.id] || {}, automatic[item.id] || null, env, now(),
      )).sort((a, b) => {
        const weight = { critical:0, expired:1, missing:2, warning:3, unknown:4, ok:5 };
        return weight[a.status] - weight[b.status] || (a.days_left ?? 99999) - (b.days_left ?? 99999);
      });
      return res.status(200).json({
        checked_at:now().toISOString(),
        counts:items.reduce((result, item) => {
          result[item.status] = (result[item.status] || 0) + 1;
          return result;
        }, {}),
        items,
      });
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('admin-expirations error:', error);
      return res.status(status).json({ error:status >= 500 ? 'expirations_unavailable' : error.message });
    }
  };
}

export default createAdminExpirationsHandler();
