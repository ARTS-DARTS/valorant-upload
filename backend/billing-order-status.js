import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

const ORDER_ID_RE = /^\d{1,18}$/;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  return header.slice(7);
}

function toIso(value) {
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function createBillingOrderStatusHandler({
  db = null,
  auth = null,
} = {}) {
  return async function billingOrderStatusHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const orderId = String(req.query?.orderId || req.query?.InvId || '').trim();
      if (!ORDER_ID_RE.test(orderId)) throw fail(400, 'invalid_order_id');
      const decoded = await (auth ?? adminAuth()).verifyIdToken(bearerToken(req), true);
      const store = db ?? adminFirestore();
      const [orderSnap, entitlementSnap] = await Promise.all([
        store.collection('billing_orders').doc(orderId).get(),
        store.collection('account_entitlements').doc(decoded.uid).get(),
      ]);
      if (!orderSnap.exists) throw fail(404, 'order_not_found');
      const order = orderSnap.data() || {};
      if (order.uid !== decoded.uid) throw fail(404, 'order_not_found');
      const entitlement = entitlementSnap.exists ? (entitlementSnap.data() || {}) : {};
      return res.status(200).json({
        order: {
          id: orderId,
          status: String(order.status || 'pending'),
          plan_id: String(order.plan_id || ''),
          months: Number(order.months) || 0,
          amount_minor: Number(order.amount_minor) || 0,
          currency: String(order.currency || 'RUB'),
          created_at: toIso(order.created_at),
          paid_at: toIso(order.paid_at),
          period_end: toIso(order.period_end),
        },
        entitlement: {
          plan_id: String(entitlement.plan_id || 'free'),
          status: String(entitlement.status || 'expired'),
          access_until: toIso(entitlement.access_until),
          latest_order_id: String(entitlement.latest_order_id || ''),
        },
      });
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('billing-order-status error:', error);
      return res.status(status).json({
        error: status >= 500 ? 'billing_unavailable' : error.message,
      });
    }
  };
}

export default createBillingOrderStatusHandler();
