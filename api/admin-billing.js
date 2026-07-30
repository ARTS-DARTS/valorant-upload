import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

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
} = {}) {
  return async function adminBillingHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const store = db ?? adminFirestore();
      await requireAdmin(store, auth ?? adminAuth(), req);
      const limit = Math.min(Math.max(Number(req.query?.limit) || 40, 1), 100);
      const status = String(req.query?.status || 'all').trim();
      let ordersQuery = store.collection('billing_orders').orderBy('created_at', 'desc');
      if (status !== 'all') {
        if (!['pending', 'succeeded', 'failed', 'requires_review', 'reversed'].includes(status)) {
          throw fail(400, 'invalid_status');
        }
      }
      const [ordersSnap, overviewSnap] = await Promise.all([
        ordersQuery.limit(status === 'all' ? limit : 100).get(),
        store.collection('subscription_stats').doc('overview').get(),
      ]);
      const orders = ordersSnap.docs
        .map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
        .filter(order => status === 'all' || order.status === status)
        .slice(0, limit);
      const userIds = [...new Set(orders.map(order => order.uid).filter(Boolean))];
      const refs = userIds.map(uid => store.collection('users').doc(uid));
      const userSnaps = refs.length ? await store.getAll(...refs) : [];
      const users = new Map(userSnaps.map(snap => [snap.id, snap.data() || {}]));
      const entitlementRefs = userIds.map(uid => store.collection('account_entitlements').doc(uid));
      const entitlementSnaps = entitlementRefs.length ? await store.getAll(...entitlementRefs) : [];
      const entitlements = new Map(entitlementSnaps.map(snap => [snap.id, snap.data() || {}]));

      return res.status(200).json({
        overview: overviewSnap.exists ? (overviewSnap.data() || {}) : {},
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
            entitlement_status: String(entitlement.status || ''),
            entitlement_plan_id: String(entitlement.plan_id || ''),
            access_until: toIso(entitlement.access_until),
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
