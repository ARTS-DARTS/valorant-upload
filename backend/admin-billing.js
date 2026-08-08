import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

const ALLOWED_ORIGINS = new Set([
  'https://arts-darts.github.io',
  'http://localhost:3000',
]);

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

async function requireAdmin(store, auth, req) {
  const decoded = await auth.verifyIdToken(bearerToken(req), true);
  const userSnap = await store.collection('users').doc(decoded.uid).get();
  if (!userSnap.exists || String(userSnap.data()?.role || '').toLowerCase() !== 'admin') {
    throw fail(403, 'admin_required');
  }
  return decoded;
}

export function createAdminBillingHandler({
  db = null,
  auth = null,
  now = () => new Date(),
} = {}) {
  return async function adminBillingHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = String(req.headers?.origin || '');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const store = db ?? adminFirestore();
      await requireAdmin(store, auth ?? adminAuth(), req);
      const limit = Math.min(Math.max(Number(req.query?.limit) || 40, 1), 100);
      const status = String(req.query?.status || 'all').trim();
      const mode = String(req.query?.mode || 'live').trim();
      if (!['live', 'test'].includes(mode)) throw fail(400, 'invalid_mode');
      const testMode = mode === 'test';
      const cursor = String(req.query?.cursor || '').trim();
      let ordersQuery = store.collection('billing_orders')
        .where('test_mode', '==', testMode)
        .orderBy('created_at', 'desc');
      if (status !== 'all') {
        if (!['pending', 'succeeded', 'failed', 'expired', 'requires_review', 'reversed'].includes(status)) {
          throw fail(400, 'invalid_status');
        }
      }
      if (cursor) {
        if (!/^\d{1,18}$/.test(cursor)) throw fail(400, 'invalid_cursor');
        const cursorSnap = await store.collection('billing_orders').doc(cursor).get();
        if (!cursorSnap.exists) throw fail(400, 'invalid_cursor');
        if (cursorSnap.data()?.test_mode !== testMode) throw fail(400, 'invalid_cursor');
        ordersQuery = ordersQuery.startAfter(cursorSnap);
      }
      const scanLimit = status === 'all' ? limit + 1 : 100;
      const [ordersSnap, liveOverviewSnap, testOverviewSnap, monitoringSnap] = await Promise.all([
        ordersQuery.limit(scanLimit).get(),
        store.collection('subscription_stats').doc('overview_live').get(),
        store.collection('subscription_stats').doc('overview_test').get(),
        store.collection('billing_monitoring').doc('robokassa').get(),
      ]);
      const scannedDocs = ordersSnap.docs;
      const matchingOrders = scannedDocs
        .map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
        .filter(order => status === 'all' || order.status === status);
      const orders = matchingOrders.slice(0, limit);
      const hasMore = status === 'all'
        ? scannedDocs.length > limit
        : scannedDocs.length === scanLimit;
      const cursorDoc = status === 'all'
        ? scannedDocs[Math.min(limit, scannedDocs.length) - 1]
        : scannedDocs.at(-1);
      const userIds = [...new Set(orders.map(order => order.uid).filter(Boolean))];
      const refs = userIds.map(uid => store.collection('users').doc(uid));
      const userSnaps = refs.length ? await store.getAll(...refs) : [];
      const users = new Map(userSnaps.map(snap => [snap.id, snap.data() || {}]));
      const entitlementRefs = userIds.map(uid => store.collection('account_entitlements').doc(uid));
      const entitlementSnaps = entitlementRefs.length ? await store.getAll(...entitlementRefs) : [];
      const entitlements = new Map(entitlementSnaps.map(snap => [snap.id, snap.data() || {}]));
      const currentMillis = now().getTime();
      const recentOrders = scannedDocs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
      const pending = recentOrders.filter(order => order.status === 'pending');
      const stuckPending = pending.filter(order => {
        const created = typeof order.created_at?.toMillis === 'function'
          ? order.created_at.toMillis()
          : new Date(order.created_at || 0).getTime();
        return Number.isFinite(created) && currentMillis - created > 35 * 60 * 1000;
      });
      const requiresReview = recentOrders.filter(order => order.status === 'requires_review');
      const monitoringRaw = monitoringSnap.exists ? (monitoringSnap.data() || {}) : {};
      const successfulRecent = recentOrders.filter(order => order.status === 'succeeded');
      const testSuccessful = successfulRecent.filter(order => order.test_mode === true);
      const liveSuccessful = successfulRecent.filter(order => order.test_mode !== true);

      return res.status(200).json({
        mode,
        overview: {
          live: liveOverviewSnap.exists ? (liveOverviewSnap.data() || {}) : {},
          test: testOverviewSnap.exists ? (testOverviewSnap.data() || {}) : {},
        },
        monitoring: {
          ...monitoringRaw,
          last_callback_at:toIso(monitoringRaw.last_callback_at),
          last_webhook_error_at:toIso(monitoringRaw.last_webhook_error_at),
          updated_at:toIso(monitoringRaw.updated_at),
          pending_recent: pending.length,
          stuck_pending: stuckPending.length,
          requires_review: requiresReview.length,
          oldest_stuck_order_id: stuckPending.at(-1)?.id || '',
          scanned_orders: recentOrders.length,
        },
        payment_totals: {
          scanned_orders: recentOrders.length,
          test_purchases: testSuccessful.length,
          test_gross_minor: testSuccessful.reduce(
            (sum, order) => sum + (Number(order.amount_minor) || 0), 0),
          live_purchases: liveSuccessful.length,
          live_gross_minor: liveSuccessful.reduce(
            (sum, order) => sum + (Number(order.amount_minor) || 0), 0),
        },
        next_cursor: hasMore && cursorDoc ? cursorDoc.id : null,
        orders: orders.map(order => {
          const user = users.get(order.uid) || {};
          const entitlement = entitlements.get(order.uid) || {};
          return {
            id: order.id,
            uid: order.uid,
            user_name: String(user.name || user.username || user.displayName || ''),
            user_email: String(user.email || user.user_email || ''),
            status: String(order.status || 'pending'),
            plan_id: String(order.plan_id || ''),
            months: Number(order.months) || 0,
            amount_minor: Number(order.amount_minor) || 0,
            currency: String(order.currency || 'RUB'),
            test_mode: order.test_mode === true,
            created_at: toIso(order.created_at),
            paid_at: toIso(order.paid_at),
            reversed_at: toIso(order.reversed_at),
            review_reason: String(order.review_reason || ''),
            entitlement_status: String(entitlement.status || ''),
            entitlement_plan_id: String(entitlement.plan_id || ''),
            access_until: toIso(entitlement.access_until),
            order_access_until: toIso(order.period_end),
          };
        }),
      });
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('admin-billing error:', error);
      return res.status(status).json({
        error: status >= 500 ? 'billing_unavailable' : error.message,
      });
    }
  };
}

export default createAdminBillingHandler();
