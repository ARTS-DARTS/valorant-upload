import { Timestamp } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

const ALLOWED_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);
const AUTH_TIMEOUT_MS = 10_000;
const ORDER_ID_RE = /^\d{1,18}$/;
const requestWindows = new Map();

function clean(value) {
  return String(value ?? '').trim();
}

function fail(status, code) {
  return Object.assign(new Error(code), { status });
}

function setHeaders(req, res) {
  const origin = clean(req.headers.origin);
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function authorize(req, verifyIdToken, timeoutMs) {
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

function checkRate(uid, now = Date.now()) {
  const current = requestWindows.get(uid);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(uid, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > 5) throw fail(429, 'too_many_requests');
}

function requesterName(decoded) {
  const value = clean(decoded.name || decoded.email || 'Пользователь');
  return value.slice(0, 50) || 'Пользователь';
}

export function createBillingRefundRequestHandler({
  verifyIdToken = token => adminAuth().verifyIdToken(token, true),
  db = null,
  now = () => new Date(),
  rateCheck = checkRate,
  authTimeoutMs = AUTH_TIMEOUT_MS,
} = {}) {
  return async function billingRefundRequestHandler(req, res) {
    setHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const origin = clean(req.headers.origin);
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    try {
      const decoded = await authorize(req, verifyIdToken, authTimeoutMs);
      rateCheck(decoded.uid);
      const firestore = db ?? adminFirestore();
      const serverNow = now();
      const entitlementRef = firestore.collection('account_entitlements').doc(decoded.uid);

      const result = await firestore.runTransaction(async tx => {
        const entitlementSnap = await tx.get(entitlementRef);
        const entitlement = entitlementSnap.data() || {};
        const orderId = clean(entitlement.latest_order_id);
        if (
          !entitlementSnap.exists ||
          entitlement.source !== 'billing' ||
          !ORDER_ID_RE.test(orderId)
        ) {
          throw fail(409, 'no_refundable_payment');
        }

        const orderRef = firestore.collection('billing_orders').doc(orderId);
        const requestRef = firestore.collection('billing_refund_requests').doc(`${decoded.uid}__${orderId}`);
        const feedbackRef = firestore.collection('feedback').doc(`refund__${orderId}`);
        const usageRef = firestore.collection('subscription_usage_summaries').doc(`${decoded.uid}__${orderId}`);
        const [orderSnap, requestSnap, usageSnap] = await Promise.all([
          tx.get(orderRef),
          tx.get(requestRef),
          tx.get(usageRef),
        ]);

        if (requestSnap.exists) {
          const existing = requestSnap.data() || {};
          return { orderId, status: clean(existing.status) || 'pending', reused: true };
        }

        const order = orderSnap.data() || {};
        if (
          !orderSnap.exists ||
          order.uid !== decoded.uid ||
          order.status !== 'succeeded' ||
          order.test_mode !== false
        ) {
          throw fail(409, 'no_refundable_payment');
        }

        const createdAt = Timestamp.fromDate(serverNow);
        const username = requesterName(decoded);
        tx.create(requestRef, {
          uid: decoded.uid,
          order_id: orderId,
          status: 'pending',
          provider: 'robokassa',
          plan_id: clean(order.plan_id),
          amount_minor: Number(order.amount_minor) || 0,
          currency: clean(order.currency) || 'RUB',
          usage_summary: usageSnap.exists ? usageSnap.data() : null,
          created_at: createdAt,
          updated_at: createdAt,
        });
        tx.create(feedbackRef, {
          text: `Запрос возврата по заказу №${orderId}. Сумма: ${((Number(order.amount_minor) || 0) / 100).toFixed(2)} RUB.`,
          category: 'Возврат платежа',
          username,
          user_id: decoded.uid,
          is_read: false,
          reply: null,
          reply_read: null,
          created_at: createdAt,
          refund_request_id: requestRef.id,
          billing_order_id: orderId,
          admin_unread: true,
          status: 'open',
        });
        return { orderId, status: 'pending', reused: false };
      });

      return res.status(result.reused ? 200 : 201).json({
        ok: true,
        order_id: result.orderId,
        status: result.status,
        reused: result.reused,
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error('billing-refund-request error:', error);
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({
        error: status >= 500 ? 'refund_request_unavailable' : error.message,
      });
    }
  };
}

export default createBillingRefundRequestHandler();
