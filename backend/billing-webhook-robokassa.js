import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminFirestore } from './_lib/firebase-admin.js';
import {
  capabilitiesForPlan,
  normalizeEntitlement,
  planTier,
} from './_lib/billing/entitlements.js';
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
    const validMonths =
      Number.isSafeInteger(order.months) &&
      order.months >= 1 &&
      order.months <= 12;
    const validPeriod =
      validMonths &&
      order.period_days === order.months * 30 &&
      order.period === `P${order.period_days}D`;
    const validIntroClaim = /^[a-f0-9]{64}$/.test(String(order.intro_claim_id));
    if (
      order.provider !== 'robokassa' || order.provider_invoice_id !== invoiceId ||
      order.status !== 'pending' || typeof order.uid !== 'string' || !order.uid ||
      order.currency !== 'RUB' || order.amount_minor !== verified.amount_minor ||
      !validPeriod || !validIntroClaim ||
      order.test_mode !== provider.testMode ||
      !['ad_free', 'plus', 'sponsor'].includes(order.plan_id)
    ) {
      throw fail(409, 'order_mismatch');
    }
    const entitlementRef = db.collection('account_entitlements').doc(order.uid);
    const customerRef = db.collection('billing_customers').doc(order.uid);
    const introClaimRef = db.collection('billing_intro_claims').doc(order.intro_claim_id);
    const [entitlementSnap, customerSnap, introClaimSnap] = await Promise.all([
      tx.get(entitlementRef), tx.get(customerRef), tx.get(introClaimRef),
    ]);
    const current = normalizeEntitlement(
      entitlementSnap.exists ? entitlementSnap.data() : null,
      { now },
    );
    const rawEntitlement = entitlementSnap.exists ? (entitlementSnap.data() || {}) : {};
    const customer = customerSnap.exists ? (customerSnap.data() || {}) : {};
    const introClaim = introClaimSnap.exists ? (introClaimSnap.data() || {}) : {};
    const currentEnd = timestampMillis(rawEntitlement.access_until);
    const upgrade = order.upgrade;
    const hasUpgrade = upgrade !== null && upgrade !== undefined;
    const upgradeSourceEnd = timestampMillis(upgrade?.from_access_until);
    const orderCreatedAt = timestampMillis(order.created_at);
    const upgradeCreditMs = Number(upgrade?.credit_duration_ms);
    const upgradeCreditMinor = Number(upgrade?.credit_minor);
    const validUpgrade =
      hasUpgrade &&
      upgrade && typeof upgrade === 'object' && !Array.isArray(upgrade) &&
      typeof upgrade.from_plan_id === 'string' &&
      rawEntitlement.source === 'billing' &&
      rawEntitlement.plan_id === upgrade.from_plan_id &&
      safeVersion(rawEntitlement.entitlement_version) === upgrade.from_entitlement_version &&
      upgradeSourceEnd > 0 &&
      currentEnd === upgradeSourceEnd &&
      orderCreatedAt > 0 &&
      planTier(order.plan_id) > planTier(upgrade.from_plan_id) &&
      Number.isSafeInteger(upgradeCreditMs) && upgradeCreditMs >= 0 &&
      upgradeCreditMs <= Math.max(0, upgradeSourceEnd - orderCreatedAt) &&
      Number.isSafeInteger(upgradeCreditMinor) && upgradeCreditMinor >= 0;
    const samePlanExtension =
      current.active && current.plan_id === order.plan_id && currentEnd > now.getTime();
    const baseMillis = validUpgrade
      ? now.getTime() + upgradeCreditMs
      : samePlanExtension
      ? currentEnd
      : now.getTime();
    const accessUntil = Timestamp.fromMillis(baseMillis + order.period_days * 24 * 60 * 60 * 1000);
    const entitlementVersion = safeVersion(rawEntitlement.entitlement_version) + 1;
    const capabilities = capabilitiesForPlan(order.plan_id);
    const day = now.toISOString().slice(0, 10);
    const entitlementConflict = hasUpgrade
      ? !validUpgrade
      : current.active && current.plan_id !== order.plan_id;

    tx.create(eventRef, {
      provider: 'robokassa',
      type: entitlementConflict
        ? 'payment_succeeded_requires_review'
        : validUpgrade
        ? 'payment_succeeded_upgrade'
        : 'payment_succeeded',
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
      status: entitlementConflict ? 'requires_review' : 'succeeded',
      amount_minor: order.amount_minor,
      currency: 'RUB',
      payment_method: String(verified.payment_method ?? '').slice(0, 60),
      provider_operation_key: String(verified.op_key ?? '').slice(0, 200),
      upgrade_from_plan_id: validUpgrade ? upgrade.from_plan_id : null,
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
      status: entitlementConflict ? 'requires_review' : 'succeeded',
      review_reason: entitlementConflict ? 'active_plan_conflict' : null,
      paid_at: nowTimestamp,
      period_start: entitlementConflict ? null : Timestamp.fromMillis(baseMillis),
      period_end: entitlementConflict ? null : accessUntil,
      upgrade_applied: validUpgrade,
      upgrade_effective_at: validUpgrade ? nowTimestamp : null,
      updated_at: nowTimestamp,
    });
    tx.set(customerRef, {
      ...(customer.open_order_id === invoiceId ? {
        open_order_id: null,
        open_order_expires_at: null,
      } : {}),
      intro_offer_redeemed: true,
      intro_offer_redeemed_at: customer.intro_offer_redeemed === true
        ? customer.intro_offer_redeemed_at
        : nowTimestamp,
      first_purchase_order_id: customer.first_purchase_order_id || invoiceId,
      intro_offer_reserved_order_id: null,
      intro_offer_reserved_until: null,
      ...(order.intro_offer_applied === true ? {
          intro_offer_order_id: invoiceId,
      } : {}),
      updated_at: nowTimestamp,
    }, { merge: true });
    tx.set(introClaimRef, {
      redeemed: true,
      redeemed_at: introClaim.redeemed === true
        ? introClaim.redeemed_at
        : nowTimestamp,
      first_purchase_order_id: introClaim.first_purchase_order_id || invoiceId,
      reserved_order_id: null,
      reserved_until: null,
      updated_at: nowTimestamp,
    }, { merge: true });
    if (!entitlementConflict) {
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
    }
    tx.set(db.collection('subscription_stats').doc('overview'), {
      purchases_total: FieldValue.increment(1),
      gross_minor: FieldValue.increment(order.amount_minor),
      net_minor: FieldValue.increment(order.amount_minor),
      updated_at: nowTimestamp,
    }, { merge: true });
    tx.set(db.collection('subscription_stats_daily').doc(day), {
      purchases: FieldValue.increment(1),
      gross_minor: FieldValue.increment(order.amount_minor),
      net_minor: FieldValue.increment(order.amount_minor),
      currency: 'RUB',
      updated_at: nowTimestamp,
    }, { merge: true });
    return {
      duplicate: false,
      invoiceId,
      requiresReview: entitlementConflict,
      upgraded: validUpgrade,
      accessUntil: entitlementConflict ? null : accessUntil.toDate(),
    };
  });
}

export async function applyRobokassaPendingFailure({
  db,
  invoiceId,
  providerState,
  now,
}) {
  const normalizedInvoiceId = String(invoiceId);
  const stateCode = Number(providerState);
  if (![10, 60].includes(stateCode)) throw fail(400, 'invalid_provider_state');
  const orderRef = db.collection('billing_orders').doc(normalizedInvoiceId);
  const eventRef = db.collection('billing_events')
    .doc(`robokassa__failed_${stateCode}__${sha(normalizedInvoiceId)}`);
  const nowTimestamp = Timestamp.fromDate(now);
  return db.runTransaction(async tx => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) return { duplicate: true, invoiceId: normalizedInvoiceId };
    if (!orderSnap.exists) throw fail(404, 'order_not_found');
    const order = orderSnap.data() || {};
    if (
      order.provider !== 'robokassa' ||
      order.provider_invoice_id !== normalizedInvoiceId ||
      order.status !== 'pending'
    ) {
      throw fail(409, 'order_mismatch');
    }
    if (!/^[a-f0-9]{64}$/.test(String(order.intro_claim_id))) {
      throw fail(409, 'order_mismatch');
    }
    const customerRef = db.collection('billing_customers').doc(order.uid);
    const introClaimRef = db.collection('billing_intro_claims').doc(order.intro_claim_id);
    const [customerSnap, introClaimSnap] = await Promise.all([
      tx.get(customerRef), tx.get(introClaimRef),
    ]);
    const customer = customerSnap.exists ? (customerSnap.data() || {}) : {};
    const introClaim = introClaimSnap.exists ? (introClaimSnap.data() || {}) : {};
    tx.create(eventRef, {
      provider: 'robokassa',
      type: stateCode === 10 ? 'payment_cancelled' : 'payment_reversed_before_settlement',
      provider_invoice_id: normalizedInvoiceId,
      order_id: normalizedInvoiceId,
      provider_state_code: stateCode,
      received_at: nowTimestamp,
      processed_at: nowTimestamp,
    });
    tx.update(orderRef, {
      status: 'failed',
      provider_state_code: stateCode,
      failed_at: nowTimestamp,
      updated_at: nowTimestamp,
    });
    if (customer.open_order_id === normalizedInvoiceId) {
      tx.set(customerRef, {
        open_order_id: null,
        open_order_expires_at: null,
        ...(customer.intro_offer_reserved_order_id === normalizedInvoiceId ? {
          intro_offer_reserved_order_id: null,
          intro_offer_reserved_until: null,
        } : {}),
        updated_at: nowTimestamp,
      }, { merge: true });
    }
    if (introClaim.reserved_order_id === normalizedInvoiceId) {
      tx.set(introClaimRef, {
        reserved_order_id: null,
        reserved_until: null,
        updated_at: nowTimestamp,
      }, { merge: true });
    }
    return { duplicate: false, invoiceId: normalizedInvoiceId };
  });
}

export async function applyRobokassaReversal({
  db,
  invoiceId,
  providerState = 60,
  now,
}) {
  const normalizedInvoiceId = String(invoiceId);
  const stateCode = Number(providerState);
  if (stateCode !== 60) throw fail(400, 'invalid_provider_state');
  const suffix = sha(normalizedInvoiceId);
  const orderRef = db.collection('billing_orders').doc(normalizedInvoiceId);
  const eventRef = db.collection('billing_events').doc(`robokassa__reversal__${suffix}`);
  const paymentRef = db.collection('billing_payments').doc(`robokassa__${suffix}`);
  const ledgerRef = db.collection('billing_ledger').doc(`robokassa__${suffix}__reversal`);
  const nowTimestamp = Timestamp.fromDate(now);

  return db.runTransaction(async tx => {
    const [eventSnap, orderSnap, paymentSnap] = await Promise.all([
      tx.get(eventRef), tx.get(orderRef), tx.get(paymentRef),
    ]);
    if (eventSnap.exists) return { duplicate: true, invoiceId: normalizedInvoiceId };
    if (!orderSnap.exists || !paymentSnap.exists) throw fail(404, 'payment_not_found');
    const order = orderSnap.data() || {};
    const payment = paymentSnap.data() || {};
    if (
      order.provider !== 'robokassa' ||
      order.provider_invoice_id !== normalizedInvoiceId ||
      order.status !== 'succeeded' ||
      payment.status !== 'succeeded' ||
      payment.order_id !== normalizedInvoiceId ||
      payment.amount_minor !== order.amount_minor
    ) {
      throw fail(409, 'payment_mismatch');
    }

    const entitlementRef = db.collection('account_entitlements').doc(order.uid);
    const entitlementSnap = await tx.get(entitlementRef);
    const rawEntitlement = entitlementSnap.exists ? (entitlementSnap.data() || {}) : {};
    const current = normalizeEntitlement(rawEntitlement, { now });
    const currentEnd = timestampMillis(rawEntitlement.access_until);
    const currentStart = timestampMillis(rawEntitlement.valid_from);
    const orderEnd = timestampMillis(order.period_end);
    const periodMillis = order.period_days * 24 * 60 * 60 * 1000;
    const upgrade = order.upgrade_applied === true ? order.upgrade : null;
    const upgradeSourceEnd = timestampMillis(upgrade?.from_access_until);
    const isUpgrade =
      upgrade && typeof upgrade === 'object' && !Array.isArray(upgrade) &&
      typeof upgrade.from_plan_id === 'string' &&
      planTier(order.plan_id) > planTier(upgrade.from_plan_id);
    const affectsPurchasedPlan =
      current.active &&
      rawEntitlement.source === 'billing' &&
      current.plan_id === order.plan_id &&
      orderEnd > currentStart &&
      Number.isSafeInteger(periodMillis) &&
      periodMillis > 0;
    const canRestoreUpgrade =
      affectsPurchasedPlan &&
      isUpgrade &&
      rawEntitlement.latest_order_id === normalizedInvoiceId &&
      upgradeSourceEnd > 0;
    const affectsCurrentWindow = isUpgrade
      ? canRestoreUpgrade
      : affectsPurchasedPlan;

    let entitlementActive = current.active;
    let entitlementEnd = currentEnd;
    let entitlementPlanId = current.plan_id;
    if (affectsCurrentWindow) {
      entitlementEnd = canRestoreUpgrade
        ? Math.max(now.getTime(), upgradeSourceEnd)
        : Math.max(now.getTime(), currentEnd - periodMillis);
      entitlementActive = entitlementEnd > now.getTime();
      entitlementPlanId = canRestoreUpgrade ? upgrade.from_plan_id : order.plan_id;
      const entitlementVersion = safeVersion(current.entitlement_version) + 1;
      const capabilities = capabilitiesForPlan(
        entitlementActive ? entitlementPlanId : 'free',
      );
      tx.set(entitlementRef, {
        uid: order.uid,
        schema_version: 1,
        plan_id: entitlementPlanId,
        tier: entitlementActive ? planTier(entitlementPlanId) : 0,
        status: entitlementActive ? 'active' : 'refunded',
        valid_from: canRestoreUpgrade
          ? (order.created_at || rawEntitlement.valid_from || nowTimestamp)
          : (rawEntitlement.valid_from || nowTimestamp),
        access_until: Timestamp.fromMillis(entitlementEnd),
        grace_until: null,
        revoked_at: entitlementActive ? null : nowTimestamp,
        cancel_at_period_end: false,
        capabilities,
        entitlement_version: entitlementVersion,
        source: 'billing',
        latest_order_id: null,
        updated_at: nowTimestamp,
      });
      tx.set(db.collection('user_public_perks').doc(order.uid), {
        subscriber_badge: entitlementActive,
        sponsor_badge: entitlementActive && entitlementPlanId === 'sponsor',
        sponsor_until: entitlementActive && entitlementPlanId === 'sponsor'
          ? Timestamp.fromMillis(entitlementEnd)
          : null,
        updated_at: nowTimestamp,
      }, { merge: true });
    }

    tx.create(eventRef, {
      provider: 'robokassa',
      type: 'payment_reversed',
      provider_invoice_id: normalizedInvoiceId,
      order_id: normalizedInvoiceId,
      amount_minor: order.amount_minor,
      currency: order.currency,
      provider_state_code: stateCode,
      entitlement_adjusted: affectsCurrentWindow,
      review_required: isUpgrade && !canRestoreUpgrade,
      received_at: nowTimestamp,
      processed_at: nowTimestamp,
    });
    tx.update(paymentRef, {
      status: 'reversed',
      reversed_at: nowTimestamp,
      updated_at: nowTimestamp,
    });
    tx.create(ledgerRef, {
      provider: 'robokassa',
      operation: 'reversal',
      provider_transaction_id: normalizedInvoiceId,
      order_id: normalizedInvoiceId,
      uid: order.uid,
      amount_minor: -order.amount_minor,
      currency: order.currency,
      occurred_at: nowTimestamp,
      immutable: true,
    });
    tx.update(orderRef, {
      status: 'reversed',
      provider_state_code: stateCode,
      reversal_review_required: isUpgrade && !canRestoreUpgrade,
      reversed_at: nowTimestamp,
      updated_at: nowTimestamp,
    });
    const day = now.toISOString().slice(0, 10);
    tx.set(db.collection('subscription_stats').doc('overview'), {
      reversals_total: FieldValue.increment(1),
      reversals_minor: FieldValue.increment(order.amount_minor),
      net_minor: FieldValue.increment(-order.amount_minor),
      updated_at: nowTimestamp,
    }, { merge: true });
    tx.set(db.collection('subscription_stats_daily').doc(day), {
      reversals: FieldValue.increment(1),
      reversals_minor: FieldValue.increment(order.amount_minor),
      net_minor: FieldValue.increment(-order.amount_minor),
      currency: order.currency,
      updated_at: nowTimestamp,
    }, { merge: true });
    return {
      duplicate: false,
      invoiceId: normalizedInvoiceId,
      entitlementAdjusted: affectsCurrentWindow,
      entitlementActive,
      reviewRequired: isUpgrade && !canRestoreUpgrade,
    };
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
      const result = await applyRobokassaPayment({
        db: db ?? adminFirestore(), verified, provider, now: now(),
      });
      try {
        const store = db ?? adminFirestore();
        const observedAt = Timestamp.fromDate(now());
        await store.collection('billing_monitoring').doc('robokassa').set({
          result_callbacks_total: FieldValue.increment(1),
          duplicate_callbacks_total: FieldValue.increment(result.duplicate ? 1 : 0),
          last_callback_at: observedAt,
          last_callback_invoice_id: verified.invoice_id,
          updated_at: observedAt,
        }, { merge: true });
      } catch (monitoringError) {
        console.error('robokassa monitoring write error:', monitoringError);
      }
      return res.status(200).send(`OK${verified.invoice_id}`);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) {
        console.error('robokassa webhook error:', error);
        try {
          const store = db ?? adminFirestore();
          await store.collection('billing_monitoring').doc('robokassa').set({
            webhook_errors_total: FieldValue.increment(1),
            last_webhook_error_at: Timestamp.fromDate(now()),
            last_webhook_error_code: String(error.message || 'temporary_error').slice(0, 80),
            updated_at: Timestamp.fromDate(now()),
          }, { merge: true });
        } catch (_) {}
      }
      return res.status(status).send(status >= 500 ? 'temporary_error' : error.message);
    }
  };
}

export default createRobokassaWebhookHandler();
