import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilitiesForPlan } from '../api/_lib/billing/entitlements.js';
import { parseBillingCatalog, publicBillingCatalog } from '../api/_lib/billing/catalog.js';
import {
  amountMinorToOutSum,
  buildRobokassaOpStateUrl,
  buildRobokassaCheckout,
  digest,
  outSumToAmountMinor,
  parseRobokassaOpStateXml,
  verifyRobokassaResult,
} from '../api/_lib/billing/robokassa.js';
import { createBillingCheckoutHandler, createCheckout } from '../api/billing-checkout.js';
import { reconcileRobokassaOrder } from '../api/billing-reconcile-robokassa.js';
import {
  applyRobokassaPayment,
  applyRobokassaReversal,
} from '../api/billing-webhook-robokassa.js';

const now = new Date('2026-07-30T12:00:00.000Z');
const provider = Object.freeze({
  merchantLogin: 'merchant', password1: 'password-one', password2: 'password-two',
  algorithm: 'sha256', invoiceStart: 700_000, testMode: true,
});
const catalog = parseBillingCatalog(JSON.stringify({
  terms_version: '2026-08-01', catalog_version: 'v1', period: 'P30D',
  plans: {
    ad_free: { active: true, display_name: 'Без рекламы', receipt_name: 'Подписка Без рекламы — 30 дней', amount_minor: 19900, tax: 'none' },
    plus: { active: true, display_name: 'Плюс', receipt_name: 'Подписка Плюс — 30 дней', amount_minor: 29900, tax: 'none' },
    sponsor: { active: true, display_name: 'Спонсор', receipt_name: 'Подписка Спонсор — 30 дней', amount_minor: 49900, tax: 'none' },
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
  assert.equal(catalog.plans.sponsor.amount_minor, 49900);
  assert.equal(catalog.plans.sponsor.capabilities.duel_vote_weight, 2);
  const publicValue = publicBillingCatalog(catalog);
  assert.equal(publicValue.plans[2].receipt_name, undefined);
  assert.equal(publicValue.plans[2].tax, undefined);
  assert.throws(() => parseBillingCatalog('{}'), error => error?.status === 503);
  assert.throws(() => parseBillingCatalog(JSON.stringify({
    terms_version: 'v', catalog_version: 'v', period: 'P30D',
    plans: { sponsor: { active: true, display_name: 'x', receipt_name: 'x', amount_minor: 0, tax: 'none' } },
  })), error => error?.status === 503);
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
    `merchant:499.00:700000:${encodedReceipt}:password-one:Shp_order=700000`,
    'sha256',
  );
  assert.equal(url.searchParams.get('SignatureValue'), expectedCheckout);
  assert.equal(url.searchParams.get('IsTest'), '1');

  const outSum = '499.000000';
  const signature = digest(`${outSum}:700000:password-two:Shp_order=700000`, 'sha256');
  const verified = verifyRobokassaResult({
    config: provider,
    payload: { OutSum: outSum, InvId: '700000', Shp_order: '700000', SignatureValue: signature.toUpperCase() },
  });
  assert.equal(verified.amount_minor, 49900);
  assert.equal(verifyRobokassaResult({
    config: provider,
    payload: { OutSum: outSum, InvId: '700000', Shp_order: '700001', SignatureValue: signature },
  }), null);
});

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
  const input = { planId: 'sponsor', period: 'P30D', termsVersion: '2026-08-01' };
  const first = await createCheckout({
    db, uid: 'user-1', input, idempotencyKey: 'abcdefghijklmnop', catalog, provider, now,
  });
  const second = await createCheckout({
    db, uid: 'user-1', input, idempotencyKey: 'abcdefghijklmnop', catalog, provider, now,
  });
  assert.equal(first.order_id, '700000');
  assert.equal(second.order_id, first.order_id);
  assert.equal(second.reused, true);
  assert.equal(db.docs.get('billing_orders/700000').amount_minor, 49900);
  assert.equal(db.docs.get('billing_sequences/robokassa').last_invoice_id, 700000);
  assert.equal(
    new URL(first.checkout_url).searchParams.get('ExpirationDate'),
    '2026-07-30T12:30',
  );
  await assert.rejects(createCheckout({
    db,
    uid: 'user-1',
    input,
    idempotencyKey: 'different_key_1234',
    catalog,
    provider,
    now,
  }), error => error?.status === 409 && error?.message === 'checkout_in_progress');
});

test('verified payment writes one ledger entry and one bounded entitlement', async () => {
  const db = new MemoryDb({
    'billing_orders/700000': {
      uid: 'user-1', provider: 'robokassa', provider_invoice_id: '700000', status: 'pending',
      plan_id: 'sponsor', period: 'P30D', period_days: 30, amount_minor: 49900,
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
      plan_id: 'sponsor', period: 'P30D', period_days: 30, amount_minor: 49900,
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
      plan_id: 'plus', period: 'P30D', period_days: 30, amount_minor: 29900,
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
    plan_id: 'sponsor', period: 'P30D', period_days: 30, amount_minor: 49900,
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
      plan_id: 'sponsor', period: 'P30D', period_days: 30, amount_minor: 49900,
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
