import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilitiesForPlan,
  normalizeEntitlement,
} from '../api/_lib/billing/entitlements.js';
import { createBillingMeHandler } from '../api/billing-me.js';

const now = Date.parse('2026-07-30T12:00:00.000Z');
const hour = 60 * 60 * 1000;

function mockResponse() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test('missing entitlement fails closed to free', () => {
  const value = normalizeEntitlement(null, { now });
  assert.equal(value.active, false);
  assert.equal(value.plan_id, 'free');
  assert.equal(value.capabilities.ads_disabled, false);
  assert.equal(value.capabilities.lineup_like_weight, 1);
});

test('active sponsor receives the exact server capability set', () => {
  const value = normalizeEntitlement({
    plan_id: 'sponsor',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: new Date(now + hour),
    entitlement_version: 7,
  }, { now });
  assert.equal(value.active, true);
  assert.equal(value.plan_id, 'sponsor');
  assert.equal(value.tier, 3);
  assert.equal(value.capabilities.ads_disabled, true);
  assert.equal(value.capabilities.lineup_cooldown_bypass, true);
  assert.equal(value.capabilities.lineup_like_weight, 2);
  assert.equal(value.capabilities.lineup_relevance_weight, 2);
  assert.equal(value.capabilities.poll_vote_weight, 2);
  assert.equal(value.capabilities.duel_vote_weight, 2);
  assert.equal(value.entitlement_version, 7);
});

test('expired or malformed access never leaves paid capabilities active', () => {
  for (const raw of [
    { plan_id: 'ad_free', status: 'active', access_until: new Date(now - 1) },
    { plan_id: 'sponsor', status: 'active' },
    { plan_id: 'forged-tier', status: 'active', access_until: new Date(now + hour) },
  ]) {
    const value = normalizeEntitlement(raw, { now });
    assert.equal(value.active, false);
    assert.equal(value.plan_id, 'free');
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});

test('grace grants temporary access only inside the absolute grace window', () => {
  const activeGrace = normalizeEntitlement({
    plan_id: 'plus',
    status: 'past_due',
    access_until: new Date(now - hour),
    grace_until: new Date(now + hour),
  }, { now });
  assert.equal(activeGrace.active, true);
  assert.equal(activeGrace.status, 'grace');
  assert.equal(activeGrace.plan_id, 'plus');

  const expiredGrace = normalizeEntitlement({
    plan_id: 'plus',
    status: 'grace',
    grace_until: new Date(now - 1),
  }, { now });
  assert.equal(expiredGrace.active, false);
  assert.equal(expiredGrace.plan_id, 'free');
});

test('refund, chargeback, and explicit revocation override a future period', () => {
  for (const raw of [
    { plan_id: 'sponsor', status: 'refunded', access_until: new Date(now + hour) },
    { plan_id: 'sponsor', status: 'chargeback', access_until: new Date(now + hour) },
    {
      plan_id: 'sponsor',
      status: 'active',
      access_until: new Date(now + hour),
      revoked_at: new Date(now - 1),
    },
  ]) {
    const value = normalizeEntitlement(raw, { now });
    assert.equal(value.active, false);
    assert.equal(value.status, 'revoked');
    assert.equal(value.capabilities.duel_vote_weight, 1);
  }
});

test('Firestore Timestamp-shaped values and cancel-at-period-end are normalized', () => {
  const value = normalizeEntitlement({
    plan_id: 'ad_free',
    status: 'active',
    access_until: { _seconds: (now + hour) / 1000, _nanoseconds: 0 },
    cancel_at_period_end: true,
  }, { now: { seconds: now / 1000, nanoseconds: 0 } });
  assert.equal(value.active, true);
  assert.equal(value.cancel_at_period_end, true);
  assert.equal(value.access_until, '2026-07-30T13:00:00.000Z');
});

test('billing me endpoint authenticates the owner and exposes only normalized fields', async () => {
  let loadedUid = '';
  const handler = createBillingMeHandler({
    verifyIdToken: async token => {
      assert.equal(token, 'valid-token');
      return { uid: 'owner-uid' };
    },
    loadEntitlement: async uid => {
      loadedUid = uid;
      return {
        plan_id: 'sponsor',
        status: 'active',
        access_until: new Date(now + hour),
        entitlement_version: 9,
        provider_customer_id: 'must-not-leak',
      };
    },
    rateCheck: () => {},
    now: () => new Date(now),
  });
  const response = mockResponse();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer valid-token', origin: 'https://vlineups.ru' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(loadedUid, 'owner-uid');
  assert.equal(response.body.entitlement.plan_id, 'sponsor');
  assert.equal(response.body.entitlement.capabilities.duel_vote_weight, 2);
  assert.equal(response.body.entitlement.provider_customer_id, undefined);
  assert.equal(response.body.server_time, '2026-07-30T12:00:00.000Z');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('billing me endpoint rejects missing auth and foreign browser origins', async () => {
  let verifyCalls = 0;
  const handler = createBillingMeHandler({
    verifyIdToken: async () => {
      verifyCalls += 1;
      return { uid: 'owner-uid' };
    },
    loadEntitlement: async () => null,
    rateCheck: () => {},
    now: () => new Date(now),
  });

  const missingAuth = mockResponse();
  await handler({ method: 'GET', headers: {} }, missingAuth);
  assert.equal(missingAuth.statusCode, 401);

  const foreignOrigin = mockResponse();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer token', origin: 'https://evil.example' },
  }, foreignOrigin);
  assert.equal(foreignOrigin.statusCode, 403);
  assert.equal(verifyCalls, 0);
});
