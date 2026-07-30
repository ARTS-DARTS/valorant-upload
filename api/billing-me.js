import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import { normalizeEntitlement } from './_lib/billing/entitlements.js';
import {
  introIdentityClaim,
  loadIntroOfferPepper,
} from './_lib/billing/intro-offer.js';

const ALLOWED_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);
const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 60;
const REQUEST_MAX_KEYS = 10_000;
const PRE_AUTH_WINDOW_MS = 60_000;
const PRE_AUTH_REQUEST_LIMIT = 120;
const PRE_AUTH_PER_IP_CONCURRENCY_LIMIT = 8;
const PRE_AUTH_GLOBAL_CONCURRENCY_LIMIT = 64;
const PRE_AUTH_MAX_KEYS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;
const requestWindows = new Map();

function clean(value) {
  return String(value ?? '').replace(/п»ї/g, '').trim();
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
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

function tooManyRequests() {
  return Object.assign(new Error('Too many requests'), { status: 429 });
}

function normalizeIp(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return 'unknown';
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

function requestIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress);
}

export function createPreAuthLimiter({
  windowMs = PRE_AUTH_WINDOW_MS,
  requestLimit = PRE_AUTH_REQUEST_LIMIT,
  perIpConcurrencyLimit = PRE_AUTH_PER_IP_CONCURRENCY_LIMIT,
  globalConcurrencyLimit = PRE_AUTH_GLOBAL_CONCURRENCY_LIMIT,
  maxKeys = PRE_AUTH_MAX_KEYS,
  now = Date.now,
} = {}) {
  const windows = new Map();
  let globalInFlight = 0;

  function cleanupExpired(nowMillis) {
    for (const [key, value] of windows) {
      if (
        value.inFlight === 0 &&
        nowMillis - value.startedAt >= windowMs
      ) {
        windows.delete(key);
      }
    }
  }

  return function acquire(ipValue) {
    const measuredNow = Number(now());
    const nowMillis = Number.isFinite(measuredNow) ? measuredNow : Date.now();
    const key = normalizeIp(ipValue);
    let current = windows.get(key);

    if (!current) {
      if (windows.size >= maxKeys) cleanupExpired(nowMillis);
      if (windows.size >= maxKeys) throw tooManyRequests();
      current = { startedAt: nowMillis, count: 0, inFlight: 0 };
      windows.set(key, current);
    } else if (nowMillis - current.startedAt >= windowMs) {
      current.startedAt = nowMillis;
      current.count = 0;
    }

    current.count += 1;
    if (
      current.count > requestLimit ||
      current.inFlight >= perIpConcurrencyLimit ||
      globalInFlight >= globalConcurrencyLimit
    ) {
      throw tooManyRequests();
    }

    current.inFlight += 1;
    globalInFlight += 1;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      current.inFlight = Math.max(0, current.inFlight - 1);
      globalInFlight = Math.max(0, globalInFlight - 1);
      const releaseNow = Number(now());
      if (
        current.inFlight === 0 &&
        Number.isFinite(releaseNow) &&
        releaseNow - current.startedAt >= windowMs &&
        windows.get(key) === current
      ) {
        windows.delete(key);
      }
    };
  };
}

const preAuthLimiter = createPreAuthLimiter();

function checkPreAuthRequest(req) {
  return preAuthLimiter(requestIp(req));
}

async function authorize(req, verifyIdToken, timeoutMs) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith('Bearer ')) {
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
  let timeout;
  try {
    return await Promise.race([
      verifyIdToken(header.slice(7).trim()),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(Object.assign(new Error('Authentication timed out'), {
            status: 503,
            code: 'auth/timeout',
          }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function checkRate(uid) {
  const now = Date.now();
  if (requestWindows.size >= REQUEST_MAX_KEYS) {
    for (const [key, value] of requestWindows) {
      if (now - value.startedAt >= WINDOW_MS) requestWindows.delete(key);
    }
  }
  const current = requestWindows.get(uid);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    if (!current && requestWindows.size >= REQUEST_MAX_KEYS) {
      throw tooManyRequests();
    }
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
  loadCustomer = async (uid) => {
    const snapshot = await adminFirestore()
      .collection('billing_customers')
      .doc(uid)
      .get();
    return snapshot.exists ? snapshot.data() : null;
  },
  loadIntroClaim = async (claimId) => {
    const snapshot = await adminFirestore()
      .collection('billing_intro_claims')
      .doc(claimId)
      .get();
    return snapshot.exists ? snapshot.data() : null;
  },
  loadIntroPepper = loadIntroOfferPepper,
  deriveIntroClaim = introIdentityClaim,
  preAuthCheck = checkPreAuthRequest,
  rateCheck = checkRate,
  now = () => new Date(),
  authTimeoutMs = AUTH_TIMEOUT_MS,
} = {}) {
  return async function billingMeHandler(req, res) {
    setHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (rejectForeignOrigin(req, res)) return;
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    let releasePreAuth = () => {};
    try {
      const release = preAuthCheck(req);
      if (typeof release === 'function') releasePreAuth = release;
      const decoded = await authorize(req, verifyIdToken, authTimeoutMs);
      rateCheck(decoded.uid);
      const serverNow = now();
      const introClaimId = deriveIntroClaim(decoded, loadIntroPepper());
      const [raw, customer, introClaim] = await Promise.all([
        loadEntitlement(decoded.uid),
        loadCustomer(decoded.uid),
        loadIntroClaim(introClaimId),
      ]);
      const entitlement = normalizeEntitlement(raw, { now: serverNow });
      return res.status(200).json({
        entitlement,
        intro_offer_eligible:
          customer?.intro_offer_redeemed !== true &&
          introClaim?.redeemed !== true &&
          timestampMillis(introClaim?.reserved_until) <= serverNow.getTime(),
        server_time: serverNow.toISOString(),
      });
    } catch (error) {
      const status =
        Number(error.status) ||
        (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('billing-me error:', error);
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({
        error: status >= 500 ? 'Internal server error' : error.message,
      });
    } finally {
      releasePreAuth();
    }
  };
}

export default createBillingMeHandler();
