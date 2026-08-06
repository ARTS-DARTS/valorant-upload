import { Timestamp } from 'firebase-admin/firestore';

import { adminFirestore } from '../backend/_lib/firebase-admin.js';

if (process.env.CONFIRM_BILLING_STATS_BACKFILL !== 'YES') {
  throw new Error('Set CONFIRM_BILLING_STATS_BACKFILL=YES to write split totals');
}

const db = adminFirestore();
const snapshot = await db.collection('billing_orders').orderBy('created_at', 'desc').limit(500).get();
if (snapshot.size >= 500) {
  throw new Error('Refusing partial backfill: at least 500 billing orders exist');
}

const totals = {
  live: { purchases_total: 0, gross_minor: 0, reversals_total: 0, refunded_minor: 0, net_minor: 0 },
  test: { purchases_total: 0, gross_minor: 0, reversals_total: 0, refunded_minor: 0, net_minor: 0 },
};
for (const document of snapshot.docs) {
  const order = document.data() || {};
  if (!['succeeded', 'reversed'].includes(order.status)) continue;
  const target = order.test_mode === true ? totals.test : totals.live;
  const amount = Number(order.amount_minor) || 0;
  target.purchases_total += 1;
  target.gross_minor += amount;
  target.net_minor += amount;
  if (order.status === 'reversed') {
    target.reversals_total += 1;
    target.refunded_minor += amount;
    target.net_minor -= amount;
  }
}

const batch = db.batch();
batch.set(db.collection('subscription_stats').doc('overview_live'), {
  ...totals.live, updated_at: Timestamp.now(), backfilled_orders: snapshot.size,
});
batch.set(db.collection('subscription_stats').doc('overview_test'), {
  ...totals.test, updated_at: Timestamp.now(), backfilled_orders: snapshot.size,
});
await batch.commit();
console.log(JSON.stringify({ scanned: snapshot.size, ...totals }));
