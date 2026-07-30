import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import { normalizeEntitlement } from './_lib/billing/entitlements.js';

const ALLOWED_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);
const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 60;
const requestWindows = new Map();

function clean(value) {
  return String(value ?? '').replace(/п»ї/g, '').trim();
}

function setHeaders(req, res) {
  const origin = clean(req.headers.origin);
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function rejectForeignOrigin(req, res) {
  const origin = clean(req.headers.origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'Origin is not allowed' });
    return true;
  }
  return false;
}

async function authorize(req, verifyIdToken) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith('Bearer ')) {
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
  return verifyIdToken(header.slice(7).trim());
}

function checkRate(uid) {
  const now = Date.now();
  const current = requestWindows.get(uid);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(uid, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > REQUEST_LIMIT) {
    throw Object.assign(new Error('Too many requests'), { status: 429 });
  }
}

export function createBillingMeHandler({
  verifyIdToken = (token) => adminAuth().verifyIdToken(token, true),
  loadEntitlement = async (uid) => {
    const snapshot = await adminFirestore()
      .collection('account_entitlements')
      .doc(uid)
      .get();
    return snapshot.exists ? snapshot.data() : null;
  },
  rateCheck = checkRate,
  now = () => new Date(),
} = {}) {
  return async function billingMeHandler(req, res) {
    setHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (rejectForeignOrigin(req, res)) return;
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const decoded = await authorize(req, verifyIdToken);
      rateCheck(decoded.uid);
      const serverNow = now();
      const raw = await loadEntitlement(decoded.uid);
      const entitlement = normalizeEntitlement(raw, { now: serverNow });
      return res.status(200).json({
        entitlement,
        server_time: serverNow.toISOString(),
      });
    } catch (error) {
      const status =
        Number(error.status) ||
        (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('billing-me error:', error);
      return res.status(status).json({
        error: status >= 500 ? 'Internal server error' : error.message,
      });
    }
  };
}

export default createBillingMeHandler();
