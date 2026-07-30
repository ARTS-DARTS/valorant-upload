import { createHash } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import { loadBillingCatalog } from './_lib/billing/catalog.js';
import { normalizeEntitlement } from './_lib/billing/entitlements.js';
import { buildRobokassaCheckout, loadRobokassaConfig } from './_lib/billing/robokassa.js';
import { createPreAuthLimiter } from './billing-me.js';

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,96}$/;
const ALLOWED_ORIGINS = new Set(['https://vlineups.ru', 'https://www.vlineups.ru', 'http://localhost:3000']);
const AUTH_TIMEOUT_MS = 10_000;
const RATE_MAX_KEYS = 10_000;
const preAuthLimiter = createPreAuthLimiter({ requestLimit: 30, globalConcurrencyLimit: 32 });
const uidWindows = new Map();

function fail(status, code) { return Object.assign(new Error(code), { status }); }
function clean(value) { return String(value ?? '').trim(); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

async function authorize(req, verifyIdToken, timeoutMs = AUTH_TIMEOUT_MS) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  let timeout;
  try {
    return await Promise.race([
      verifyIdToken(header.slice(7).trim()),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(fail(503, 'authentication_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function rateCheck(uid, now = Date.now()) {
  if (uidWindows.size >= RATE_MAX_KEYS) {
    for (const [key, value] of uidWindows) {
      if (now - value.startedAt >= 60_000) uidWindows.delete(key);
    }
  }
  const current = uidWindows.get(uid);
  if (!current || now - current.startedAt >= 60_000) {
    if (!current && uidWindows.size >= RATE_MAX_KEYS) throw fail(429, 'too_many_requests');
    uidWindows.set(uid, { startedAt: now, count: 1 });
    return;
  }
  if (++current.count > 10) throw fail(429, 'too_many_requests');
}

export async function createCheckout({ db, uid, input, idempotencyKey, catalog, provider, now }) {
  const plan = catalog.plans[input.planId];
  if (!plan || input.period !== 'P30D' || input.termsVersion !== catalog.terms_version) {
    throw fail(400, 'invalid_plan_or_terms');
  }
  const bodyHash = sha(JSON.stringify(input));
  const intentRef = db.collection('billing_checkout_intents').doc(sha(`${uid}\0${idempotencyKey}`));
  const entitlementRef = db.collection('account_entitlements').doc(uid);
  const sequenceRef = db.collection('billing_sequences').doc('robokassa');

  return db.runTransaction(async tx => {
    const [intentSnap, entitlementSnap, sequenceSnap] = await Promise.all([
      tx.get(intentRef), tx.get(entitlementRef), tx.get(sequenceRef),
    ]);
    if (intentSnap.exists) {
      const intent = intentSnap.data() || {};
      if (intent.uid !== uid || intent.body_hash !== bodyHash) throw fail(409, 'idempotency_key_reused');
      return { ...intent.response, reused: true };
    }
    const entitlement = normalizeEntitlement(
      entitlementSnap.exists ? entitlementSnap.data() : null,
      { now },
    );
    if (entitlement.active && entitlement.plan_id !== input.planId) {
      throw fail(409, 'plan_change_not_supported');
    }
    const previousInvoice = Number(sequenceSnap.data()?.last_invoice_id ?? (provider.invoiceStart - 1));
    if (!Number.isSafeInteger(previousInvoice) || previousInvoice < 0 || previousInvoice >= 9_007_199_254_740_000) {
      throw fail(503, 'billing_unavailable');
    }
    const invoiceId = previousInvoice + 1;
    const payment = buildRobokassaCheckout({ config: provider, plan, invoiceId });
    const orderRef = db.collection('billing_orders').doc(String(invoiceId));
    const createdAt = Timestamp.fromDate(now);
    const response = {
      provider: 'robokassa',
      order_id: String(invoiceId),
      checkout_url: payment.checkout_url,
      amount_minor: plan.amount_minor,
      currency: 'RUB',
      plan_id: plan.plan_id,
      period: 'P30D',
      terms_version: catalog.terms_version,
    };
    tx.set(sequenceRef, { last_invoice_id: invoiceId, updated_at: createdAt }, { merge: true });
    tx.create(orderRef, {
      uid,
      provider: 'robokassa',
      provider_invoice_id: String(invoiceId),
      status: 'pending',
      plan_id: plan.plan_id,
      period: 'P30D',
      period_days: 30,
      amount_minor: plan.amount_minor,
      currency: 'RUB',
      terms_version: catalog.terms_version,
      catalog_version: catalog.catalog_version,
      receipt_name: plan.receipt_name,
      tax: plan.tax,
      test_mode: provider.testMode,
      created_at: createdAt,
      updated_at: createdAt,
    });
    tx.create(intentRef, {
      uid,
      body_hash: bodyHash,
      order_id: String(invoiceId),
      status: 'pending',
      response,
      created_at: createdAt,
      expires_at: Timestamp.fromMillis(now.getTime() + 24 * 60 * 60 * 1000),
    });
    return { ...response, reused: false };
  });
}

export function createBillingCheckoutHandler({
  verifyIdToken = token => adminAuth().verifyIdToken(token, true),
  db = null,
  loadCatalog = loadBillingCatalog,
  loadProvider = loadRobokassaConfig,
  preAuthCheck = req => preAuthLimiter(req.ip || req.socket?.remoteAddress || 'unknown'),
  checkRate = rateCheck,
  now = () => new Date(),
  authTimeoutMs = AUTH_TIMEOUT_MS,
} = {}) {
  return async function billingCheckoutHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = clean(req.headers.origin);
    if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    let release = () => {};
    try {
      const acquired = preAuthCheck(req);
      if (typeof acquired === 'function') release = acquired;
      const decoded = await authorize(req, verifyIdToken, authTimeoutMs);
      checkRate(decoded.uid);
      const idempotencyKey = clean(req.headers['idempotency-key']);
      if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw fail(400, 'invalid_idempotency_key');
      const input = {
        planId: clean(req.body?.planId),
        period: clean(req.body?.period),
        termsVersion: clean(req.body?.termsVersion),
      };
      const result = await createCheckout({
        db: db ?? adminFirestore(), uid: decoded.uid, input, idempotencyKey,
        catalog: loadCatalog(), provider: loadProvider(), now: now(),
      });
      return res.status(result.reused ? 200 : 201).json(result);
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('billing-checkout error:', error);
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({ error: status >= 500 ? 'billing_unavailable' : error.message });
    } finally {
      release();
    }
  };
}

export default createBillingCheckoutHandler();
