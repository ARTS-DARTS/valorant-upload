import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilitiesForPlan } from '../api/_lib/billing/entitlements.js';
import { parseBillingCatalog, publicBillingCatalog } from '../api/_lib/billing/catalog.js';
import {
  amountMinorToOutSum,
  buildRobokassaCheckout,
  digest,
  outSumToAmountMinor,
  verifyRobokassaResult,
} from '../api/_lib/billing/robokassa.js';
import { createBillingCheckoutHandler, createCheckout } from '../api/billing-checkout.js';
import { applyRobokassaPayment } from '../api/billing-webhook-robokassa.js';

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
