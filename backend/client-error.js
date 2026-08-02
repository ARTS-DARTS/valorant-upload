import { FieldValue } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

const rateBuckets = new Map();
const MAX_REPORTS_PER_MINUTE = 30;

function clean(value, limit = 1000) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().slice(0, limit);
}

function safeContext(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === 'string') return clean(value, 1000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeContext(item, depth + 1));
  if (typeof value !== 'object') return clean(value, 200);
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
    clean(key, 80),
    safeContext(item, depth + 1),
  ]));
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(clean(req.headers?.authorization, 10000));
  return match?.[1] || '';
}

function takeRateSlot(uid, now = Date.now()) {
  const current = rateBuckets.get(uid);
  if (!current || now - current.startedAt >= 60_000) {
    rateBuckets.set(uid, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REPORTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

export function createClientErrorHandler({ auth = adminAuth(), db = adminFirestore() } = {}) {
  return async function clientErrorHandler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error:'auth_required' });
    let user;
    try {
      user = await auth.verifyIdToken(token);
    } catch (error) {
      console.warn('client-error auth:', error?.message || error);
      return res.status(401).json({ error:'invalid_auth' });
    }
    if (!takeRateSlot(user.uid)) return res.status(429).json({ error:'rate_limited' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      await db.collection('app_errors').add({
        type:'web',
        source:clean(body.source || 'upload_site', 80),
        message:clean(body.message || 'Unknown client error', 1000),
        code:clean(body.code, 100),
        stack:clean(body.stack, 4000),
        context:safeContext(body.context || {}),
        uid:user.uid,
        user_id:user.uid,
        user_name:clean(body.user_name || user.name, 120),
        user_email:clean(body.user_email || user.email, 200),
        platform:'web',
        appVersion:clean(body.appVersion || 'upload-site', 80),
        url:clean(body.url, 1000),
        userAgent:clean(body.userAgent || req.headers?.['user-agent'], 1000),
        ip:clean(req.ip || req.socket?.remoteAddress, 120),
        timestamp:FieldValue.serverTimestamp(),
        received_via:'same_origin_backend',
      });
      return res.status(201).json({ ok:true });
    } catch (error) {
      console.error('client-error:', error);
      return res.status(500).json({ error:'store_failed' });
    }
  };
}

let defaultHandler = null;
export default function clientErrorHandler(req, res) {
  if (!defaultHandler) defaultHandler = createClientErrorHandler();
  return defaultHandler(req, res);
}
