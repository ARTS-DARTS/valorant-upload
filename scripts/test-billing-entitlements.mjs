import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilitiesForPlan,
  normalizeEntitlement,
} from '../api/_lib/billing/entitlements.js';
import { validateFirebaseAdminServices } from '../api/_lib/firebase-admin.js';
import {
  createBillingMeHandler,
  createPreAuthLimiter,
} from '../api/billing-me.js';
import { createFirebaseReadinessController } from '../api/readiness.js';

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
    schema_version: 1,
    plan_id: 'sponsor',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: new Date(now + hour),
    revoked_at: null,
    capabilities: capabilitiesForPlan('sponsor'),
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
    {
      schema_version: 1,
      plan_id: 'ad_free',
      status: 'active',
      valid_from: new Date(now - hour),
      access_until: new Date(now - 1),
    },
    { schema_version: 1, plan_id: 'sponsor', status: 'active' },
    {
      schema_version: 1,
      plan_id: 'forged-tier',
      status: 'active',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
    },
  ]) {
    const value = normalizeEntitlement(raw, { now });
    assert.equal(value.active, false);
    assert.equal(value.plan_id, 'free');
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});

test('grace grants temporary access only inside the absolute grace window', () => {
  const activeGrace = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'plus',
    status: 'past_due',
    valid_from: new Date(now - (2 * hour)),
    access_until: new Date(now - hour),
    grace_until: new Date(now + hour),
    capabilities: capabilitiesForPlan('plus'),
  }, { now });
  assert.equal(activeGrace.active, true);
  assert.equal(activeGrace.status, 'grace');
  assert.equal(activeGrace.plan_id, 'plus');

  const expiredGrace = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'plus',
    status: 'grace',
    valid_from: new Date(now - (2 * hour)),
    access_until: new Date(now - hour),
    grace_until: new Date(now - 1),
  }, { now });
  assert.equal(expiredGrace.active, false);
  assert.equal(expiredGrace.plan_id, 'free');
});

test('grace requires a complete, correctly ordered paid and grace window', () => {
  for (const raw of [
    {
      schema_version: 1,
      plan_id: 'plus',
      status: 'grace',
      valid_from: new Date(now - hour),
      grace_until: new Date(now + hour),
    },
    {
      schema_version: 1,
      plan_id: 'plus',
      status: 'past_due',
      valid_from: new Date(now - hour),
      access_until: new Date(now + 1),
      grace_until: new Date(now + hour),
    },
    {
      schema_version: 1,
      plan_id: 'plus',
      status: 'grace',
      valid_from: new Date(now - hour),
      access_until: new Date(now - (2 * hour)),
      grace_until: new Date(now + hour),
    },
  ]) {
    const value = normalizeEntitlement(raw, { now });
    assert.equal(value.active, false);
    assert.equal(value.plan_id, 'free');
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});

test('refund, chargeback, and explicit revocation override a future period', () => {
  for (const raw of [
    {
      schema_version: 1,
      plan_id: 'sponsor',
      status: 'refunded',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
    },
    {
      schema_version: 1,
      plan_id: 'sponsor',
      status: 'chargeback',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
    },
    {
      schema_version: 1,
      plan_id: 'sponsor',
      status: 'active',
      valid_from: new Date(now - hour),
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

test('a present malformed revocation timestamp fails closed', () => {
  for (const revokedAt of ['', 'not-a-date', {}, 0, 1e100]) {
    const value = normalizeEntitlement({
      schema_version: 1,
      plan_id: 'sponsor',
      status: 'active',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
      revoked_at: revokedAt,
      capabilities: capabilitiesForPlan('sponsor'),
    }, { now });
    assert.equal(value.active, false);
    assert.equal(value.plan_id, 'free');
    assert.equal(value.status, 'revoked');
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});

test('a present malformed grace timestamp fails closed', () => {
  const value = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'ad_free',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: new Date(now + hour),
    grace_until: 'not-a-date',
    capabilities: capabilitiesForPlan('ad_free'),
  }, { now });
  assert.equal(value.active, false);
  assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
});

test('Firestore Timestamp-shaped values and cancel-at-period-end are normalized', () => {
  const value = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'ad_free',
    status: 'active',
    valid_from: { _seconds: (now - hour) / 1000, _nanoseconds: 0 },
    access_until: { _seconds: (now + hour) / 1000, _nanoseconds: 0 },
    cancel_at_period_end: true,
    capabilities: capabilitiesForPlan('ad_free'),
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
        schema_version: 1,
        plan_id: 'sponsor',
        status: 'active',
        valid_from: new Date(now - hour),
        access_until: new Date(now + hour),
        entitlement_version: 9,
        capabilities: capabilitiesForPlan('sponsor'),
        provider_customer_id: 'must-not-leak',
      };
    },
    preAuthCheck: () => () => {},
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
    preAuthCheck: () => () => {},
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

test('pre-auth limiter caps per-IP and global concurrency', () => {
  let clock = 1_000;
  const limiter = createPreAuthLimiter({
    requestLimit: 100,
    perIpConcurrencyLimit: 1,
    globalConcurrencyLimit: 2,
    now: () => clock,
  });
  const releaseOne = limiter('::ffff:192.0.2.1');
  assert.throws(
    () => limiter('192.0.2.1'),
    error => error?.status === 429,
  );
  const releaseTwo = limiter('192.0.2.2');
  assert.throws(
    () => limiter('192.0.2.3'),
    error => error?.status === 429,
  );
  releaseOne();
  releaseTwo();

  const releaseAfterCapacityReturns = limiter('192.0.2.3');
  releaseAfterCapacityReturns();
  clock += 1;
});

test('pre-auth limiter resets its request window', () => {
  let clock = 10_000;
  const limiter = createPreAuthLimiter({
    windowMs: 1_000,
    requestLimit: 2,
    perIpConcurrencyLimit: 5,
    globalConcurrencyLimit: 5,
    now: () => clock,
  });
  limiter('192.0.2.10')();
  limiter('192.0.2.10')();
  assert.throws(
    () => limiter('192.0.2.10'),
    error => error?.status === 429,
  );
  clock += 1_001;
  limiter('192.0.2.10')();
});

test('billing me applies pre-auth limiting before token verification', async () => {
  let verifyCalls = 0;
  const handler = createBillingMeHandler({
    verifyIdToken: async () => {
      verifyCalls += 1;
      return { uid: 'owner-uid' };
    },
    loadEntitlement: async () => null,
    preAuthCheck: () => {
      throw Object.assign(new Error('Too many requests'), { status: 429 });
    },
    rateCheck: () => {},
    now: () => new Date(now),
  });
  const response = mockResponse();
  await handler({
    method: 'GET',
    ip: '192.0.2.20',
    headers: { authorization: 'Bearer valid-token' },
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(verifyCalls, 0);
});

test('billing me releases pre-auth concurrency after auth failure', async () => {
  let releases = 0;
  const handler = createBillingMeHandler({
    verifyIdToken: async () => {
      throw Object.assign(new Error('Invalid token'), {
        code: 'auth/invalid-id-token',
      });
    },
    loadEntitlement: async () => null,
    preAuthCheck: () => () => {
      releases += 1;
    },
    rateCheck: () => {},
    now: () => new Date(now),
  });
  const response = mockResponse();
  await handler({
    method: 'GET',
    ip: '192.0.2.21',
    headers: { authorization: 'Bearer invalid-token' },
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(releases, 1);
});

test('billing me bounds token verification time and releases concurrency', async () => {
  let releases = 0;
  const handler = createBillingMeHandler({
    verifyIdToken: async () => new Promise(() => {}),
    loadEntitlement: async () => null,
    preAuthCheck: () => () => {
      releases += 1;
    },
    rateCheck: () => {},
    now: () => new Date(now),
    authTimeoutMs: 5,
  });
  const response = mockResponse();
  await handler({
    method: 'GET',
    ip: '192.0.2.22',
    headers: { authorization: 'Bearer stalled-token' },
  }, response);

  assert.equal(response.statusCode, 503);
  assert.equal(releases, 1);
  assert.deepEqual(response.body, { error: 'Internal server error' });
});

test('Firebase readiness validates both Auth and Firestore', async () => {
  const calls = [];
  await validateFirebaseAdminServices({
    auth: {
      async listUsers(limit) {
        calls.push(['auth', limit]);
      },
    },
    firestore: {
      collection(name) {
        calls.push(['collection', name]);
        return {
          limit(value) {
            calls.push(['limit', value]);
            return {
              async get() {
                calls.push(['firestore']);
              },
            };
          },
        };
      },
    },
    timeoutMs: 100,
  });
  assert.deepEqual(calls, [
    ['auth', 1],
    ['collection', 'account_entitlements'],
    ['limit', 1],
    ['firestore'],
  ]);
});

test('readiness response never exposes Firebase validation errors and can recover', async () => {
  let shouldFail = true;
  const readiness = createFirebaseReadinessController({
    validate: async () => {
      if (shouldFail) throw new Error('private-key-material-must-not-leak');
    },
  });

  assert.equal(await readiness.check(), false);
  const failedResponse = mockResponse();
  readiness.handler({ method: 'GET' }, failedResponse);
  assert.equal(failedResponse.statusCode, 503);
  assert.deepEqual(failedResponse.body, { ok: false, status: 'not_ready' });
  assert.equal(
    JSON.stringify(failedResponse.body).includes('private-key-material'),
    false,
  );
  assert.equal(failedResponse.headers.get('Cache-Control'), 'no-store');

  shouldFail = false;
  assert.equal(await readiness.check(), true);
  const readyResponse = mockResponse();
  readiness.handler({ method: 'GET' }, readyResponse);
  assert.equal(readyResponse.statusCode, 200);
  assert.deepEqual(readyResponse.body, { ok: true, sha: 'development' });
});

test('production readiness requires an exact deployed commit SHA', async () => {
  let validations = 0;
  const invalid = createFirebaseReadinessController({
    validate: async () => {
      validations += 1;
    },
    deployVersion: 'main',
    requireDeployVersion: true,
  });
  assert.equal(await invalid.check(), false);
  assert.equal(validations, 0);

  const sha = 'a'.repeat(40);
  const valid = createFirebaseReadinessController({
    validate: async () => {
      validations += 1;
    },
    deployVersion: sha,
    requireDeployVersion: true,
  });
  assert.equal(await valid.check(), true);
  const response = mockResponse();
  valid.handler({ method: 'GET' }, response);
  assert.deepEqual(response.body, { ok: true, sha });
  assert.equal(validations, 1);
});

test('unknown schema and missing valid_from fail closed', () => {
  for (const raw of [
    {
      schema_version: 999,
      plan_id: 'sponsor',
      status: 'active',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
      capabilities: capabilitiesForPlan('sponsor'),
    },
    {
      schema_version: '1',
      plan_id: 'sponsor',
      status: 'active',
      valid_from: new Date(now - hour),
      access_until: new Date(now + hour),
      capabilities: capabilitiesForPlan('sponsor'),
    },
    {
      schema_version: 1,
      plan_id: 'sponsor',
      status: 'active',
      access_until: new Date(now + hour),
      capabilities: capabilitiesForPlan('sponsor'),
    },
  ]) {
    const value = normalizeEntitlement(raw, { now });
    assert.equal(value.active, false);
    assert.equal(value.plan_id, 'free');
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});

test('out-of-range timestamps fail closed instead of throwing', () => {
  const value = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'sponsor',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: 1e100,
    capabilities: capabilitiesForPlan('sponsor'),
  }, { now });
  assert.equal(value.active, false);
  assert.equal(value.plan_id, 'free');
  assert.equal(value.access_until, null);
});

test('capabilities are intersected with the plan maximum', () => {
  const value = normalizeEntitlement({
    schema_version: 1,
    plan_id: 'ad_free',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: new Date(now + hour),
    capabilities: {
      ads_disabled: true,
      rewarded_unlock_bypass: false,
      lineup_cooldown_bypass: true,
      lineup_like_weight: 2,
    },
  }, { now });

  assert.equal(value.active, true);
  assert.equal(value.capabilities.ads_disabled, true);
  assert.equal(value.capabilities.rewarded_unlock_bypass, false);
  assert.equal(value.capabilities.lineup_cooldown_bypass, false);
  assert.equal(value.capabilities.lineup_like_weight, 1);
});

test('missing or malformed capability maps fail closed', () => {
  const common = {
    schema_version: 1,
    plan_id: 'sponsor',
    status: 'active',
    valid_from: new Date(now - hour),
    access_until: new Date(now + hour),
  };
  for (const capabilities of [undefined, null, [], 'sponsor']) {
    const value = normalizeEntitlement({ ...common, capabilities }, { now });
    assert.equal(value.active, false);
    assert.deepEqual(value.capabilities, capabilitiesForPlan('free'));
  }
});
