import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminFirestore } from './_lib/firebase-admin.js';
import { capabilitiesForPlan, normalizeEntitlement } from './_lib/billing/entitlements.js';
import { loadRobokassaConfig, verifyRobokassaResult } from './_lib/billing/robokassa.js';

function fail(status, code) { return Object.assign(new Error(code), { status }); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function safeVersion(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

export async function applyRobokassaPayment({ db, verified, provider, now }) {
  const invoiceId = verified.invoice_id;
  if (verified.shp.Shp_order !== invoiceId) throw fail(400, 'invalid_order_binding');
  const orderRef = db.collection('billing_orders').doc(invoiceId);
  const eventRef = db.collection('billing_events').doc(`robokassa__success__${sha(invoiceId)}`);
  const paymentRef = db.collection('billing_payments').doc(`robokassa__${sha(invoiceId)}`);
  const ledgerRef = db.collection('billing_ledger').doc(`robokassa__${sha(invoiceId)}__charge`);
  const nowTimestamp = Timestamp.fromDate(now);

  return db.runTransaction(async tx => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) return { duplicate: true, invoiceId };
    if (!orderSnap.exists) throw fail(404, 'order_not_found');
    const order = orderSnap.data() || {};
    if (
      order.provider !== 'robokassa' || order.provider_invoice_id !== invoiceId ||
      order.status !== 'pending' || typeof order.uid !== 'string' || !order.uid ||
      order.currency !== 'RUB' || order.amount_minor !== verified.amount_minor ||
      order.period !== 'P30D' || order.period_days !== 30 ||
      order.test_mode !== provider.testMode ||
      !['ad_free', 'plus', 'sponsor'].includes(order.plan_id)
    ) {
      throw fail(409, 'order_mismatch');
    }
    const entitlementRef = db.collection('account_entitlements').doc(order.uid);
    const entitlementSnap = await tx.get(entitlementRef);
    const current = normalizeEntitlement(
      entitlementSnap.exists ? entitlementSnap.data() : null,
      { now },
    );
    const currentEnd = timestampMillis(entitlementSnap.data()?.access_until);
    const baseMillis = current.active && current.plan_id === order.plan_id && currentEnd > now.getTime()
      ? currentEnd
      : now.getTime();
    const accessUntil = Timestamp.fromMillis(baseMillis + order.period_days * 24 * 60 * 60 * 1000);
    const entitlementVersion = safeVersion(current.entitlement_version) + 1;
    const capabilities = capabilitiesForPlan(order.plan_id);
    const day = now.toISOString().slice(0, 10);

    tx.create(eventRef, {
      provider: 'robokassa',
      type: 'payment_succeeded',
      provider_invoice_id: invoiceId,
      order_id: invoiceId,
      amount_minor: order.amount_minor,
      currency: 'RUB',
      received_at: nowTimestamp,
      processed_at: nowTimestamp,
    });
    tx.create(paymentRef, {
      provider: 'robokassa',
      provider_payment_id: invoiceId,
      order_id: invoiceId,
      uid: order.uid,
      status: 'succeeded',
      amount_minor: order.amount_minor,
      currency: 'RUB',
      payment_method: String(verified.payment_method ?? '').slice(0, 60),
      succeeded_at: nowTimestamp,
      created_at: nowTimestamp,
    });
    tx.create(ledgerRef, {
      provider: 'robokassa',
      operation: 'charge',
      provider_transaction_id: invoiceId,
      order_id: invoiceId,
      uid: order.uid,
      amount_minor: order.amount_minor,
      currency: 'RUB',
      occurred_at: nowTimestamp,
      immutable: true,
    });
    tx.update(orderRef, {
      status: 'succeeded',
      paid_at: nowTimestamp,
      period_start: Timestamp.fromMillis(baseMillis),
      period_end: accessUntil,
      updated_at: nowTimestamp,
    });
    tx.set(entitlementRef, {
      uid: order.uid,
      schema_version: 1,
      plan_id: order.plan_id,
      tier: { ad_free: 1, plus: 2, sponsor: 3 }[order.plan_id],
      status: 'active',
      valid_from: nowTimestamp,
      access_until: accessUntil,
      grace_until: null,
      revoked_at: null,
      cancel_at_period_end: false,
      capabilities,
      entitlement_version: entitlementVersion,
      source: 'billing',
      latest_order_id: invoiceId,
      updated_at: nowTimestamp,
    });
    tx.set(db.collection('user_public_perks').doc(order.uid), {
      subscriber_badge: true,
      sponsor_badge: order.plan_id === 'sponsor',
      sponsor_until: order.plan_id === 'sponsor' ? accessUntil : null,
      updated_at: nowTimestamp,
    }, { merge: true });
    tx.set(db.collection('subscription_stats').doc('overview'), {
      purchases_total: FieldValue.increment(1),
      gross_minor: FieldValue.increment(order.amount_minor),
      updated_at: nowTimestamp,
    }, { merge: true });
    tx.set(db.collection('subscription_stats_daily').doc(day), {
      purchases: FieldValue.increment(1),
      gross_minor: FieldValue.increment(order.amount_minor),
      currency: 'RUB',
      updated_at: nowTimestamp,
    }, { merge: true });
    return { duplicate: false, invoiceId, accessUntil: accessUntil.toDate() };
  });
}

export function createRobokassaWebhookHandler({
  db = null,
  loadProvider = loadRobokassaConfig,
  now = () => new Date(),
} = {}) {
  return async function robokassaWebhookHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).send('method_not_allowed');
    try {
      const provider = loadProvider();
      const verified = verifyRobokassaResult({ config: provider, payload: req.body || {} });
      if (!verified) throw fail(400, 'invalid_signature');
      verified.payment_method = req.body?.PaymentMethod;
      await applyRobokassaPayment({
        db: db ?? adminFirestore(), verified, provider, now: now(),
      });
      return res.status(200).send(`OK${verified.invoice_id}`);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error('robokassa webhook error:', error);
      return res.status(status).send(status >= 500 ? 'temporary_error' : error.message);
    }
  };
}

export default createRobokassaWebhookHandler();
