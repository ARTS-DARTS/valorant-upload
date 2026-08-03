import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilitiesForPlan } from '../backend/_lib/billing/entitlements.js';
import { introIdentityClaim } from '../backend/_lib/billing/intro-offer.js';
import { parseBillingCatalog, publicBillingCatalog } from '../backend/_lib/billing/catalog.js';
import {
  amountMinorToOutSum,
  buildRobokassaOpStateUrl,
  buildRobokassaCheckout,
  digest,
  outSumToAmountMinor,
  parseRobokassaOpStateXml,
  verifyRobokassaResult,
} from '../backend/_lib/billing/robokassa.js';
import { createBillingCheckoutHandler, createCheckout } from '../backend/billing-checkout.js';
import { reconcileRobokassaOrder } from '../backend/billing-reconcile-robokassa.js';
import {
  applyRobokassaPayment,
  applyRobokassaReversal,
} from '../backend/billing-webhook-robokassa.js';

const now = new Date('2026-07-30T12:00:00.000Z');
const provider = Object.freeze({
  merchantLogin: 'merchant', password1: 'password-one', password2: 'password-two',
  algorithm: 'sha256', invoiceStart: 700_000, testMode: true,
});
const catalog = parseBillingCatalog(JSON.stringify({
  terms_version: '2026-08-01', catalog_version: 'v1', period: 'P30D',
  term_discounts_bps: {
    1: 0, 2: 300, 3: 500, 4: 700, 5: 1000, 6: 1200,
    7: 1500, 8: 1700, 9: 2000, 10: 2200, 11: 2500, 12: 3000,
  },
  intro_offer: { active: true, months: 1, discount_bps: 3000 },
  plans: {
    ad_free: { active: true, display_name: 'Без рекламы', receipt_name: 'Подписка Без рекламы', monthly_amount_minor: 9900, tax: 'none' },
    plus: { active: true, display_name: 'Плюс', receipt_name: 'Подписка Плюс', monthly_amount_minor: 16900, tax: 'none' },
    sponsor: { active: true, display_name: 'Спонсор', receipt_name: 'Подписка Спонсор', monthly_amount_minor: 34900, tax: 'none' },
  },
}));

class Ref {
  constructor(db, path) { this.db = db; this.path = path; }
  collection(name) { return new Collection(this.db, `${this.path}/${name}`); }
}
class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`); }
}
class Snap {
  constructor(ref, data) { this.ref = ref; this.value = data; this.exists = data !== undefined; }
  data() { return this.value; }
}
class MemoryDb {
  constructor(seed = {}) { this.docs = new Map(Object.entries(seed)); }
  collection(name) { return new Collection(this, name); }
  async runTransaction(callback) {
    const staged = new Map(this.docs);
    const tx = {
      get: async ref => new Snap(ref, staged.get(ref.path)),
      create: (ref, data) => {
        if (staged.has(ref.path)) throw new Error('already-exists');
        staged.set(ref.path, data);
      },
      set: (ref, data, options) => staged.set(
        ref.path,
        options?.merge ? { ...(staged.get(ref.path) || {}), ...data } : data,
      ),
      update: (ref, data) => {
        if (!staged.has(ref.path)) throw new Error('not-found');
        staged.set(ref.path, { ...staged.get(ref.path), ...data });
      },
    };
    const result = await callback(tx);
    this.docs = staged;
    return result;
  }
}

function response() {
  return {
    statusCode: 200, body: null, headers: new Map(),
    setHeader(name, value) { this.headers.set(name, value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

test('catalog is strictly server-priced and exposes no receipt internals', () => {
  assert.equal(catalog.plans.sponsor.amount_minor, 34900);
  assert.equal(catalog.plans.sponsor.offers[11].amount_minor, 293160);
  assert.equal(catalog.plans.sponsor.intro_amount_minor, 24430);
  assert.equal(catalog.plans.sponsor.capabilities.duel_vote_weight, 2);
  const publicValue = publicBillingCatalog(catalog);
  assert.equal(publicValue.plans[2].receipt_name, undefined);
  assert.equal(publicValue.plans[2].tax, undefined);
  assert.equal(publicValue.plans[2].offers.length, 12);
  assert.throws(() => parseBillingCatalog('{}'), error => error?.status === 503);
  assert.throws(() => parseBillingCatalog(JSON.stringify({
    terms_version: 'v', catalog_version: 'v', period: 'P30D',
    plans: { sponsor: { active: true, display_name: 'x', receipt_name: 'x', amount_minor: 0, tax: 'none' } },
  })), error => error?.status === 503);
});

test('intro identity is stable without storing the source identity', () => {
  const pepper = 'p'.repeat(32);
  const first = introIdentityClaim(
    { uid: 'uid-1', email: ' Player@Example.com ' },
    pepper,
  );
  const recreated = introIdentityClaim(
    { uid: 'uid-2', email: 'player@example.com' },
    pepper,
  );
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, recreated);
  assert.notEqual(
    first,
    introIdentityClaim({ uid: 'uid-1', email: 'other@example.com' }, pepper),
  );
});

test('money conversion rejects fractional kopecks and preserves provider formatting', () => {
  assert.equal(amountMinorToOutSum(19900), '199.00');
  assert.equal(outSumToAmountMinor('199.000000'), 19900);
  assert.equal(outSumToAmountMinor('199.50'), 19950);
  assert.throws(() => outSumToAmountMinor('199.000001'));
  assert.throws(() => outSumToAmountMinor('1e3'));
});

test('checkout signs the encoded receipt and ResultURL uses password 2', () => {
  const checkout = buildRobokassaCheckout({ config: provider, plan: catalog.plans.sponsor, invoiceId: 700000 });
  const url = new URL(checkout.checkout_url);
  const encodedReceipt = url.searchParams.get('Receipt');
  assert.deepEqual(JSON.parse(decodeURIComponent(encodedReceipt)), JSON.parse(checkout.receipt));
  const expectedCheckout = digest(
    `merchant:349.00:700000:${encodedReceipt}:password-one:Shp_order=700000`,
    'sha256',
  );
  assert.equal(url.searchParams.get('SignatureValue'), expectedCheckout);
  assert.equal(url.searchParams.get('IsTest'), '1');

  const outSum = '349.000000';
  const signature = digest(`${outSum}:700000:password-two:Shp_order=700000`, 'sha256');
  const verified = verifyRobokassaResult({
    config: provider,
    payload: { OutSum: outSum, InvId: '700000', Shp_order: '700000', SignatureValue: signature.toUpperCase() },
  });
  assert.equal(verified.amount_minor, 34900);
  assert.equal(verifyRobokassaResult({
    config: provider,
    payload: { OutSum: outSum, InvId: '700000', Shp_order: '700001', SignatureValue: signature },
  }), null);
});
const introClaimId = 'a'.repeat(64);

test('OpStateExt request and namespaced XML bind state to the canonical order', () => {
  const url = new URL(buildRobokassaOpStateUrl({ config: provider, invoiceId: '700000' }));
  assert.equal(url.searchParams.get('MerchantLogin'), 'merchant');
  assert.equal(url.searchParams.get('InvoiceID'), '700000');
  assert.equal(
    url.searchParams.get('Signature'),
    digest('merchant:700000:password-two', 'sha256'),
  );
  const state = parseRobokassaOpStateXml(`<?xml version="1.0"?>
    <OperationStateResponse xmlns="http://merchant.roboxchange.com/WebService/">
      <Result><Code>0</Code></Result>
      <State><Code>100</Code></State>
      <Info>
        <OutSum>499.000000</OutSum>
        <OpKey>operation-key</OpKey>
        <PaymentMethod><Code>BankCard</Code></PaymentMethod>
      </Info>
      <UserFields>
        <Field><Name>Shp_order</Name><Value>700000</Value></Field>
      </UserFields>
    </OperationStateResponse>`);
  assert.equal(state.state_code, 100);
  assert.equal(state.amount_minor, 49900);
  assert.equal(state.op_key, 'operation-key');
  assert.equal(state.payment_method, 'BankCard');
  assert.equal(state.shp.Shp_order, '700000');
  assert.deepEqual(
    parseRobokassaOpStateXml('<x><Result><Code>3</Code></Result></x>'),
    { result_code: 3, state_code: null },
  );
});

test('checkout idempotency creates exactly one server-priced order', async () => {
  const db = new MemoryDb();
  const input = {
    planId: 'sponsor',
    months: 12,
    expectedAmountMinor: 293160,
    termsVersion: '2026-08-01',
  };
  const first = await createCheckout({
    db, uid: 'user-1', introClaimId, input,
    idempotencyKey: 'abcdefghijklmnop', catalog, provider, now,
  });
  const second = await createCheckout({
    db, uid: 'user-1', introClaimId, input,
    idempotencyKey: 'abcdefghijklmnop', catalog, provider, now,
  });
  assert.equal(first.order_id, '700000');
  assert.equal(second.order_id, first.order_id);
  assert.equal(second.reused, true);
  assert.equal(db.docs.get('billing_orders/700000').amount_minor, 293160);
  assert.equal(db.docs.get('billing_orders/700000').period_days, 360);
  assert.equal(db.docs.get('billing_orders/700000').discount_bps, 3000);
  assert.equal(db.docs.get('billing_sequences/robokassa').last_invoice_id, 700000);
  assert.equal(
    new URL(first.checkout_url).searchParams.get('ExpirationDate'),
    '2026-07-30T15:30',
  );
  await assert.rejects(createCheckout({
    db,
    uid: 'user-1',
    introClaimId,
    input,
    idempotencyKey: 'different_key_1234',
    catalog,
    provider,
    now,
  }), error => error?.status === 409 && error?.message === 'checkout_in_progress');
});

test('checkout expiry is formatted in Moscow time across the UTC day boundary', () => {
  const checkout = buildRobokassaCheckout({
    config: provider,
    plan: catalog.plans.ad_free,
    invoiceId: 700001,
    expiresAt: new Date('2026-08-03T21:45:00.000Z'),
  });
  assert.equal(
    new URL(checkout.checkout_url).searchParams.get('ExpirationDate'),
    '2026-08-04T00:45',
  );
});

test('intro offer is limited to the first one-month payment', async () => {
  const db = new MemoryDb();
  const introInput = {
    planId: 'ad_free',
    months: 1,
    expectedAmountMinor: 6930,
    termsVersion: '2026-08-01',
  };
  const checkout = await createCheckout({
    db,
    uid: 'intro-user',
    introClaimId,
    input: introInput,
    idempotencyKey: 'intro_checkout_0001',
    catalog,
    provider,
    now,
  });
  assert.equal(checkout.intro_offer_applied, true);
  assert.equal(checkout.discount_bps, 3000);
  assert.equal(db.docs.get('billing_orders/700000').amount_minor, 6930);

  await applyRobokassaPayment({
    db,
    verified: {
      invoice_id: '700000',
      amount_minor: 6930,
      out_sum: '69.30',
      shp: { Shp_order: '700000' },
    },
    provider,
    now,
  });
  assert.equal(db.docs.get('billing_customers/intro-user').intro_offer_redeemed, true);

  const renewal = await createCheckout({
    db,
    uid: 'intro-user',
    introClaimId,
    input: { ...introInput, expectedAmountMinor: 9900 },
    idempotencyKey: 'intro_checkout_0002',
    catalog,
    provider,
    now: new Date('2026-07-30T12:31:00.000Z'),
  });
  assert.equal(renewal.intro_offer_applied, false);
  assert.equal(renewal.amount_minor, 9900);
});

test('a successful longer first purchase consumes the intro offer', async () => {
  const db = new MemoryDb();
  await createCheckout({
    db,
    uid: 'long-term-user',
    introClaimId,
    input: {
      planId: 'sponsor',
      months: 2,
      expectedAmountMinor: 67706,
      termsVersion: '2026-08-01',
    },
    idempotencyKey: 'long_checkout_0001',
    catalog,
    provider,
    now,
  });
  await applyRobokassaPayment({
    db,
    verified: {
      invoice_id: '700000',
      amount_minor: 67706,
      out_sum: '677.06',
      shp: { Shp_order: '700000' },
    },
    provider,
    now,
  });
  assert.equal(
    db.docs.get('billing_customers/long-term-user').intro_offer_redeemed,
    true,
  );
  const renewal = await createCheckout({
    db,
    uid: 'long-term-user',
    introClaimId,
    input: {
      planId: 'sponsor',
      months: 1,
      expectedAmountMinor: 34900,
      termsVersion: '2026-08-01',
    },
    idempotencyKey: 'long_checkout_0002',
    catalog,
    provider,
    now: new Date('2026-07-30T12:31:00.000Z'),
  });
  assert.equal(renewal.intro_offer_applied, false);
  assert.equal(renewal.amount_minor, 34900);
});

test('an active billing plan can be extended or upgraded, but not downgraded', async () => {
  const sourceEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const entitlement = {
    uid: 'upgrade-user', schema_version: 1, plan_id: 'ad_free', tier: 1,
    status: 'active', valid_from: new Date('2026-07-01T00:00:00.000Z'),
    access_until: sourceEnd, grace_until: null, revoked_at: null,
    capabilities: capabilitiesForPlan('ad_free'), entitlement_version: 7,
    source: 'billing', latest_order_id: 'previous-order',
  };
  const db = new MemoryDb({
    'account_entitlements/upgrade-user': entitlement,
    'billing_customers/upgrade-user': { uid: 'upgrade-user', intro_offer_redeemed: true },
    [`billing_intro_claims/${introClaimId}`]: { redeemed: true },
  });
  const upgrade = await createCheckout({
    db,
    uid: 'upgrade-user',
    introClaimId,
    input: {
      planId: 'plus', months: 1, expectedAmountMinor: 16900,
      termsVersion: '2026-08-01',
    },
    idempotencyKey: 'upgrade_checkout_001',
    catalog,
    provider,
    now,
  });
  const expectedCreditMs = Number(
    BigInt(9900) * BigInt(30 * 24 * 60 * 60 * 1000) / BigInt(16900),
  );
  assert.deepEqual(upgrade.upgrade, {
    from_plan_id: 'ad_free',
    credit_minor: 9900,
    credit_duration_seconds: Math.floor(expectedCreditMs / 1000),
  });
  assert.equal(upgrade.intro_offer_applied, false);
  assert.equal(db.docs.get('billing_orders/700000').upgrade.credit_duration_ms, expectedCreditMs);

  const payment = await applyRobokassaPayment({
    db,
    verified: {
      invoice_id: '700000', amount_minor: 16900, out_sum: '169.00',
      shp: { Shp_order: '700000' },
    },
    provider,
    now,
  });
  assert.equal(payment.requiresReview, false);
  assert.equal(payment.upgraded, true);
  const upgraded = db.docs.get('account_entitlements/upgrade-user');
  assert.equal(upgraded.plan_id, 'plus');
  assert.equal(
    upgraded.access_until.toMillis(),
    now.getTime() + expectedCreditMs + 30 * 24 * 60 * 60 * 1000,
  );
  assert.equal(db.docs.get('billing_orders/700000').upgrade_applied, true);

  const reversed = await applyRobokassaReversal({
    db, invoiceId: '700000', providerState: 60, now,
  });
  assert.equal(reversed.entitlementAdjusted, true);
  assert.equal(reversed.reviewRequired, false);
  const restored = db.docs.get('account_entitlements/upgrade-user');
  assert.equal(restored.plan_id, 'ad_free');
  assert.equal(restored.access_until.toMillis(), sourceEnd.getTime());

  const downgradeDb = new MemoryDb({
    'account_entitlements/downgrade-user': {
      ...entitlement,
      uid: 'downgrade-user',
      plan_id: 'plus',
      tier: 2,
      capabilities: capabilitiesForPlan('plus'),
    },
    'billing_customers/downgrade-user': { uid: 'downgrade-user', intro_offer_redeemed: true },
    [`billing_intro_claims/${introClaimId}`]: { redeemed: true },
  });
  await assert.rejects(createCheckout({
    db: downgradeDb,
    uid: 'downgrade-user',
    introClaimId,
    input: {
      planId: 'ad_free', months: 1, expectedAmountMinor: 9900,
      termsVersion: '2026-08-01',
    },
    idempotencyKey: 'downgrade_check_001',
    catalog,
    provider,
    now,
  }), error => error?.status === 409 && error?.message === 'plan_change_not_supported');
});

test('an upgrade whose entitlement snapshot changed is held for review', async () => {
  const sourceEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const db = new MemoryDb({
    'account_entitlements/stale-upgrade-user': {
      uid: 'stale-upgrade-user', schema_version: 1, plan_id: 'ad_free', tier: 1,
      status: 'active', valid_from: new Date('2026-07-01T00:00:00.000Z'),
      access_until: sourceEnd, grace_until: null, revoked_at: null,
      capabilities: capabilitiesForPlan('ad_free'), entitlement_version: 2,
      source: 'billing',
    },
    'billing_customers/stale-upgrade-user': {
      uid: 'stale-upgrade-user', intro_offer_redeemed: true,
    },
    [`billing_intro_claims/${introClaimId}`]: { redeemed: true },
  });
  await createCheckout({
    db,
    uid: 'stale-upgrade-user',
    introClaimId,
    input: {
      planId: 'plus', months: 1, expectedAmountMinor: 16900,
      termsVersion: '2026-08-01',
    },
    idempotencyKey: 'stale_upgrade_0001',
    catalog,
    provider,
    now,
  });
  db.docs.set('account_entitlements/stale-upgrade-user', {
    ...db.docs.get('account_entitlements/stale-upgrade-user'),
    entitlement_version: 3,
  });
  const result = await applyRobokassaPayment({
    db,
    verified: {
      invoice_id: '700000', amount_minor: 16900, out_sum: '169.00',
      shp: { Shp_order: '700000' },
    },
    provider,
    now,
  });
  assert.equal(result.requiresReview, true);
  assert.equal(result.upgraded, false);
  assert.equal(db.docs.get('billing_orders/700000').status, 'requires_review');
  assert.equal(db.docs.get('account_entitlements/stale-upgrade-user').plan_id, 'ad_free');
});

test('verified payment writes one ledger entry and one bounded entitlement', async () => {
  const db = new MemoryDb({
    'billing_orders/700000': {
      uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'pending',
      intro_claim_id: introClaimId,
      plan_id: 'sponsor', months: 1, period: 'P30D', period_days: 30, amount_minor: 49900,
      currency: 'RUB', test_mode: true,
    },
  });
  const verified = {
    invoice_id: '700000', amount_minor: 49900, out_sum: '499.000000',
    shp: { Shp_order: '700000' }, payment_method: 'BankCard',
  };
  const first = await applyRobokassaPayment({ db, verified, provider, now });
  const duplicate = await applyRobokassaPayment({ db, verified, provider, now });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const entitlement = db.docs.get('account_entitlements/user-1');
  assert.equal(entitlement.plan_id, 'sponsor');
  assert.deepEqual(entitlement.capabilities, capabilitiesForPlan('sponsor'));
  assert.equal(entitlement.access_until.toDate().toISOString(), '2026-08-29T12:00:00.000Z');
  assert.equal([...db.docs.keys()].filter(key => key.startsWith('billing_ledger/')).length, 1);
  assert.equal(db.docs.get('billing_orders/700000').status, 'succeeded');
});

test('valid provider signature still cannot override canonical order amount', async () => {
  const db = new MemoryDb({
    'billing_orders/700000': {
      uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'pending',
      intro_claim_id: introClaimId,
      plan_id: 'sponsor', months: 1, period: 'P30D', period_days: 30, amount_minor: 49900,
      currency: 'RUB', test_mode: true,
    },
  });
  await assert.rejects(applyRobokassaPayment({
    db,
    verified: { invoice_id: '700000', amount_minor: 100, shp: { Shp_order: '700000' } },
    provider,
    now,
  }), error => error?.status === 409 && error?.message === 'order_mismatch');
  assert.equal(db.docs.has('account_entitlements/user-1'), false);
});

test('a late conflicting plan payment is audited without replacing active rights', async () => {
  const db = new MemoryDb({
    'billing_orders/700000': {
      uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'pending',
      intro_claim_id: introClaimId,
      plan_id: 'plus', months: 1, period: 'P30D', period_days: 30, amount_minor: 29900,
      currency: 'RUB', test_mode: true,
    },
    'billing_customers/user-1': {
      uid: 'user-1', open_order_id: '700000',
      open_order_expires_at: new Date('2026-07-30T12:30:00.000Z'),
    },
    'account_entitlements/user-1': {
      uid: 'user-1', schema_version: 1, plan_id: 'sponsor', tier: 3, status: 'active',
      valid_from: new Date('2026-07-01T00:00:00.000Z'),
      access_until: new Date('2026-08-15T00:00:00.000Z'),
      grace_until: null, revoked_at: null,
      capabilities: capabilitiesForPlan('sponsor'), entitlement_version: 4, source: 'billing',
    },
  });
  const result = await applyRobokassaPayment({
    db,
    verified: {
      invoice_id: '700000', amount_minor: 29900, out_sum: '299.00',
      shp: { Shp_order: '700000' },
    },
    provider,
    now,
  });
  assert.equal(result.requiresReview, true);
  assert.equal(db.docs.get('billing_orders/700000').status, 'requires_review');
  assert.equal(db.docs.get('account_entitlements/user-1').plan_id, 'sponsor');
  assert.equal(db.docs.get('account_entitlements/user-1').entitlement_version, 4);
  assert.equal(db.docs.get('billing_customers/user-1').open_order_id, null);
  const payment = [...db.docs.entries()]
    .find(([key]) => key.startsWith('billing_payments/'))?.[1];
  assert.equal(payment.status, 'requires_review');
});

test('reconciliation restores a missed verified payment but rejects order mismatch', async () => {
  const order = {
    uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'pending',
    intro_claim_id: introClaimId,
    plan_id: 'sponsor', months: 1, period: 'P30D', period_days: 30, amount_minor: 49900,
    currency: 'RUB', test_mode: false,
  };
  const productionProvider = { ...provider, testMode: false };
  const db = new MemoryDb({ 'billing_orders/700000': order });
  const paid = await reconcileRobokassaOrder({
    db,
    order,
    provider: productionProvider,
    now,
    providerState: {
      result_code: 0, state_code: 100, amount_minor: 49900, out_sum: '499.000000',
      op_key: 'operation-key', payment_method: 'BankCard', shp: { Shp_order: '700000' },
    },
  });
  assert.equal(paid.action, 'paid');
  assert.equal(db.docs.get('billing_payments/robokassa__bbce68c972781f645c57245c19d0e0c5990e221ac9a1e70afbadd82609c87fce').provider_operation_key, 'operation-key');

  const mismatchDb = new MemoryDb({ 'billing_orders/700000': order });
  const mismatch = await reconcileRobokassaOrder({
    db: mismatchDb,
    order,
    provider: productionProvider,
    now,
    providerState: {
      result_code: 0, state_code: 100, amount_minor: 100, out_sum: '1.00',
      shp: { Shp_order: '700000' },
    },
  });
  assert.equal(mismatch.action, 'mismatch');
  assert.equal(mismatchDb.docs.has('account_entitlements/user-1'), false);
});

test('a verified reversal is idempotent and removes only its 30-day access window', async () => {
  const paymentTime = new Date('2026-07-20T12:00:00.000Z');
  const periodEnd = new Date('2026-09-18T12:00:00.000Z');
  const hash = 'bbce68c972781f645c57245c19d0e0c5990e221ac9a1e70afbadd82609c87fce';
  const db = new MemoryDb({
    'billing_orders/700000': {
      uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'succeeded',
      intro_claim_id: introClaimId,
      plan_id: 'sponsor', months: 1, period: 'P30D', period_days: 30, amount_minor: 49900,
      currency: 'RUB', test_mode: false, period_end: periodEnd,
    },
    [`billing_payments/robokassa__${hash}`]: {
      order_id: '700000', status: 'succeeded', amount_minor: 49900,
    },
    'account_entitlements/user-1': {
      uid: 'user-1', schema_version: 1, plan_id: 'sponsor', tier: 3, status: 'active',
      valid_from: paymentTime, access_until: periodEnd, grace_until: null, revoked_at: null,
      capabilities: capabilitiesForPlan('sponsor'), entitlement_version: 2, source: 'billing',
    },
    'billing_customers/user-1': {
      uid: 'user-1', intro_offer_redeemed: true, first_purchase_order_id: '700000',
    },
  });
  const first = await applyRobokassaReversal({
    db, invoiceId: '700000', providerState: 60, now,
  });
  const duplicate = await applyRobokassaReversal({
    db, invoiceId: '700000', providerState: 60, now,
  });
  assert.equal(first.entitlementAdjusted, true);
  assert.equal(first.entitlementActive, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    db.docs.get('account_entitlements/user-1').access_until.toDate().toISOString(),
    '2026-08-19T12:00:00.000Z',
  );
  assert.equal(db.docs.get(`billing_ledger/robokassa__${hash}__reversal`).amount_minor, -49900);
  assert.equal(db.docs.get('billing_orders/700000').status, 'reversed');
  assert.equal(db.docs.get('billing_customers/user-1').intro_offer_redeemed, true);
});

test('checkout bounds authentication time and releases pre-auth capacity', async () => {
  let releases = 0;
  const handler = createBillingCheckoutHandler({
    verifyIdToken: async () => new Promise(() => {}),
    preAuthCheck: () => () => { releases += 1; },
    checkRate: () => {},
    authTimeoutMs: 5,
  });
  const res = response();
  await handler({
    method: 'POST', headers: { authorization: 'Bearer stalled-token' }, body: {},
  }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'billing_unavailable');
  assert.equal(releases, 1);
});
