import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAdminBillingHandler } from '../backend/admin-billing.js';
import { createAdminExpirationsHandler } from '../backend/admin-expirations.js';
import { createAdminHealthHandler } from '../backend/admin-health.js';
import { createAdminConfigBackupHandler } from '../backend/admin-config-backup.js';
import { createModeratorApplicationHandler } from '../backend/moderator-application.js';
import { createNotifyAgentSubscribersHandler } from '../backend/notify-agent-subscribers.js';
import { createSendPushHandler } from '../backend/send-push.js';
import { createBillingOrderStatusHandler } from '../backend/billing-order-status.js';
import {
  createAccountDeleteHandler,
  deletedSubjectId,
} from '../backend/account-delete.js';
import { buildRobokassaTestScenarios } from './generate-robokassa-test-scenarios.mjs';
import {
  alertFingerprint,
  buildAlertText,
  runExpirationAlert,
} from './notify-expirations-telegram.mjs';
import { runOperationalMonitor } from './monitor-operations-telegram.mjs';

class Ref {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').at(-1); }
  async get() { return new Snap(this, this.db.docs.get(this.path)); }
  async set(value, options = {}) {
    const current = this.db.docs.get(this.path) || {};
    this.db.docs.set(this.path, options.merge ? { ...current, ...value } : value);
  }
}

class Snap {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.value = value;
    this.exists = value !== undefined;
  }
  data() { return this.value; }
}

class Query {
  constructor(db, path, options = {}) {
    this.db = db;
    this.path = path;
    this.options = options;
  }
  orderBy(field, direction) {
    return new Query(this.db, this.path, { ...this.options, orderBy:field, direction });
  }
  startAfter(snapshot) {
    return new Query(this.db, this.path, { ...this.options, startAfter:snapshot.id });
  }
  limit(value) {
    return new Query(this.db, this.path, { ...this.options, limit:value });
  }
  async get() {
    let docs = [...this.db.docs.entries()]
      .filter(([key]) => key.startsWith(`${this.path}/`) && !key.slice(this.path.length + 1).includes('/'))
      .map(([key, value]) => new Snap(new Ref(this.db, key), value));
    if (this.options.orderBy) {
      const direction = this.options.direction === 'desc' ? -1 : 1;
      docs.sort((a, b) => {
        const left = Number(a.data()?.[this.options.orderBy]?.toMillis?.() || 0);
        const right = Number(b.data()?.[this.options.orderBy]?.toMillis?.() || 0);
        return (left - right) * direction || a.id.localeCompare(b.id) * direction;
      });
    }
    if (this.options.startAfter) {
      const index = docs.findIndex(doc => doc.id === this.options.startAfter);
      docs = index >= 0 ? docs.slice(index + 1) : [];
    }
    if (this.options.limit) docs = docs.slice(0, this.options.limit);
    return { docs, size:docs.length, empty:docs.length === 0 };
  }
}

class Collection extends Query {
  doc(id = `auto-${this.db.docs.size + 1}`) { return new Ref(this.db, `${this.path}/${id}`); }
}

class MemoryDb {
  constructor(seed = {}) { this.docs = new Map(Object.entries(seed)); }
  collection(name) { return new Collection(this, name); }
  async getAll(...refs) { return Promise.all(refs.map(ref => ref.get())); }
}

function timestamp(iso) {
  const millis = new Date(iso).getTime();
  return { toMillis:() => millis, toDate:() => new Date(millis) };
}

function response() {
  return {
    statusCode:200, body:null, headers:new Map(),
    setHeader(name, value) { this.headers.set(name, value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

const authFor = uid => ({ verifyIdToken:async token => {
  if (token !== 'valid-token') throw Object.assign(new Error('bad token'), { code:'auth/id-token-revoked' });
  return { uid };
} });

test('payment result pages always provide an order-bound app return', () => {
  const successHtml = readFileSync(new URL('../payment-success.html', import.meta.url), 'utf8');
  const successJs = readFileSync(new URL('../payment-result.js', import.meta.url), 'utf8');
  const appLinkJs = readFileSync(new URL('../payment-app-link.js', import.meta.url), 'utf8');
  const failHtml = readFileSync(new URL('../payment-fail.html', import.meta.url), 'utf8');
  assert.match(successHtml, /id="open-app"/);
  assert.match(successHtml, /payment-app-link\.js/);
  assert.match(appLinkJs, /vlineupapp:\/\/billing\/\$\{outcome\}\?orderId=/);
  assert.match(successJs, /Вернись в приложение/);
  assert.match(failHtml, /id="open-app"/);
  assert.match(failHtml, /payment-app-link\.js/);
  assert.match(appLinkJs, /\^\\d\{1,18\}\$/);
});

test('order status returns only the authenticated owner order', async () => {
  const db = new MemoryDb({
    'billing_orders/700001': {
      uid:'owner', status:'succeeded', plan_id:'plus', months:1,
      amount_minor:16900, currency:'RUB', created_at:timestamp('2026-07-30T10:00:00Z'),
    },
    'account_entitlements/owner': {
      plan_id:'plus', status:'active', access_until:timestamp('2026-08-29T10:00:00Z'),
      latest_order_id:'700001',
    },
  });
  const handler = createBillingOrderStatusHandler({ db, auth:authFor('owner') });
  const res = response();
  await handler({
    method:'GET', headers:{ authorization:'Bearer valid-token' }, query:{ orderId:'700001' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.id, '700001');
  assert.equal(res.body.entitlement.plan_id, 'plus');

  const foreign = response();
  await createBillingOrderStatusHandler({ db, auth:authFor('other') })({
    method:'GET', headers:{ authorization:'Bearer valid-token' }, query:{ orderId:'700001' },
  }, foreign);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.body.error, 'order_not_found');
});

test('admin billing enforces role and exact browser origin', async () => {
  const db = new MemoryDb({
    'users/admin': { role:'admin' },
    'users/user': { role:'user' },
  });
  const denied = response();
  await createAdminBillingHandler({ db, auth:authFor('user') })({
    method:'GET', headers:{ authorization:'Bearer valid-token' }, query:{},
  }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, 'admin_required');

  const originDenied = response();
  await createAdminBillingHandler({ db, auth:authFor('admin') })({
    method:'GET',
    headers:{ authorization:'Bearer valid-token', origin:'https://evil.example' },
    query:{},
  }, originDenied);
  assert.equal(originDenied.statusCode, 403);

  const preflight = response();
  await createAdminBillingHandler({ db, auth:authFor('admin') })({
    method:'OPTIONS', headers:{ origin:'https://arts-darts.github.io' }, query:{},
  }, preflight);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://arts-darts.github.io');
});

test('admin expirations reports only metadata and preserves sibling records on update', async () => {
  const db = new MemoryDb({
    'users/admin': { role:'admin' },
    'settings/credential_expirations': {
      items:{
        onesignal_rest:{
          configured:true,
          last_rotated_at:'2026-07-01',
          notes:'сменён после аудита',
        },
        selectel_s3:{ configured:true, notes:'не потерять' },
      },
    },
  });
  const options = {
    db,
    auth:authFor('admin'),
    env:{
      UNUSED_TEST_SECRET:'super-secret-value',
      UNUSED_SECOND_SECRET:'another-secret-value',
      CREDENTIAL_PRESENCE_OVERRIDES:'onesignal_rest',
    },
    now:() => new Date('2026-07-30T12:00:00Z'),
    tlsProbe:async () => 'Sep 29 18:20:17 2026 GMT',
    domainProbe:async () => '2027-06-28T13:19:50Z',
  };
  const handler = createAdminExpirationsHandler(options);
  const first = response();
  await handler({
    method:'GET',
    headers:{ authorization:'Bearer valid-token', origin:'https://arts-darts.github.io' },
  }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.items.find(item => item.id === 'domain_vlineups').days_left, 334);
  assert.equal(first.body.items.find(item => item.id === 'tls_vlineups').status, 'ok');
  assert.equal(first.body.items.find(item => item.id === 'onesignal_rest').configured, true);
  assert.equal(first.body.items.find(item => item.id === 'admin_secret_legacy').status, 'ok');
  assert.equal(JSON.stringify(first.body).includes('super-secret-value'), false);
  assert.equal(JSON.stringify(first.body).includes('another-secret-value'), false);

  const saved = response();
  await handler({
    method:'POST',
    headers:{ authorization:'Bearer valid-token' },
    body:{ id:'onesignal_rest', last_rotated_at:'2026-07-30', notes:'плановая ротация' },
  }, saved);
  assert.equal(saved.statusCode, 200);
  const stored = db.docs.get('settings/credential_expirations').items;
  assert.equal(stored.onesignal_rest.notes, 'плановая ротация');
  assert.equal(stored.selectel_s3.notes, 'не потерять');
});

test('legacy admin endpoints require Firebase admin authentication and exact origin', async () => {
  const db = new MemoryDb({
    'users/admin': { role:'admin' },
    'users/user': { role:'user' },
  });
  const factories = [
    createSendPushHandler,
    createModeratorApplicationHandler,
    createNotifyAgentSubscribersHandler,
  ];
  for (const createHandler of factories) {
    const missing = response();
    await createHandler({ db, auth:authFor('admin') })({
      method:'POST', headers:{}, body:{},
    }, missing);
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.body.error, 'authentication_required');

    const nonAdmin = response();
    await createHandler({ db, auth:authFor('user') })({
      method:'POST',
      headers:{ authorization:'Bearer valid-token' },
      body:{},
    }, nonAdmin);
    assert.equal(nonAdmin.statusCode, 403);
    assert.equal(nonAdmin.body.error, 'admin_required');

    const wrongOrigin = response();
    await createHandler({ db, auth:authFor('admin') })({
      method:'POST',
      headers:{
        authorization:'Bearer valid-token',
        origin:'https://evil.example',
      },
      body:{},
    }, wrongOrigin);
    assert.equal(wrongOrigin.statusCode, 403);
    assert.equal(wrongOrigin.body.error, 'origin_not_allowed');

    const accepted = response();
    await createHandler({ db, auth:authFor('admin') })({
      method:'POST',
      headers:{
        authorization:'Bearer valid-token',
        origin:'https://arts-darts.github.io',
      },
      body:{},
    }, accepted);
    assert.equal(accepted.statusCode, 400);
    assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), 'https://arts-darts.github.io');
  }
});

test('admin health checks providers and config backup contains presence but no secrets', async () => {
  const db = new MemoryDb({
    'users/admin': { role:'admin' },
    'settings/credential_expiration_alerts': { checked_at:timestamp('2026-07-30T11:00:00Z') },
    'settings/credential_expirations': { items:{ tls:{ expires_at:'2026-09-29' } } },
  });
  const env = {
    ONESIGNAL_APP_ID:'app-id',
    ONESIGNAL_REST_KEY:'rest-secret',
    YANDEX_CLIENT_ID:'client',
    YANDEX_CLIENT_SECRET:'oauth-secret',
    YANDEX_STATE_SECRET:'state-secret',
    TELEGRAM_BOT_TOKEN:'telegram-secret',
    TELEGRAM_ALERT_CHAT_ID:'-1001',
  };
  const health = response();
  await createAdminHealthHandler({
    db,
    auth:authFor('admin'),
    env,
    httpCheck:async () => ({ ok:true, status:200, latency_ms:12 }),
  })({
    method:'GET',
    headers:{ authorization:'Bearer valid-token', origin:'https://arts-darts.github.io' },
  }, health);
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.checks.find(item => item.id === 'onesignal').ok, true);
  assert.equal(health.body.checks.find(item => item.id === 'robokassa').ok, false);

  const backup = response();
  await createAdminConfigBackupHandler({ db, auth:authFor('admin'), env })({
    method:'GET',
    headers:{ authorization:'Bearer valid-token' },
  }, backup);
  assert.equal(backup.statusCode, 200);
  assert.equal(backup.body.environment_presence.ONESIGNAL_REST_KEY, true);
  assert.equal(JSON.stringify(backup.body).includes('rest-secret'), false);
  assert.equal(JSON.stringify(backup.body).includes('telegram-secret'), false);
});

test('expiration Telegram alert sends once per changed risk set without exposing secrets', async () => {
  const db = new MemoryDb();
  const sent = [];
  const riskyItems = [
    { id:'tls', name:'SSL', status:'warning', days_left:20, expires_at:'2026-08-19', configured:true },
    { id:'key', name:'API key', status:'missing', days_left:null, expires_at:null, configured:false },
    { id:'ok', name:'Domain', status:'ok', days_left:300, expires_at:'2027-05-26', configured:true },
  ];
  const options = {
    db,
    env:{ TELEGRAM_BOT_TOKEN:'secret-token', TELEGRAM_ALERT_CHAT_ID:'-100123' },
    snapshotBuilder:async () => ({ items:riskyItems }),
    sender:async (token, chatId, text) => sent.push({ token, chatId, text }),
  };
  const first = await runExpirationAlert(options);
  const second = await runExpirationAlert(options);
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /SSL/);
  assert.match(sent[0].text, /API key/);
  assert.doesNotMatch(sent[0].text, /Domain/);
  assert.equal(alertFingerprint(riskyItems.slice(0, 2)), alertFingerprint([...riskyItems.slice(0, 2)].reverse()));
  assert.match(buildAlertText(riskyItems.slice(0, 1)), /осталось 20 дн/);
});

test('operational Telegram monitor deduplicates API and payment problems', async () => {
  const db = new MemoryDb();
  const sent = [];
  const options = {
    db,
    env:{ TELEGRAM_BOT_TOKEN:'token', TELEGRAM_ALERT_CHAT_ID:'chat' },
    collector:async () => ['API недоступен: нет ответа', 'Зависшие платежи: 1'],
    sender:async (_token, _chat, text) => sent.push(text),
  };
  assert.equal((await runOperationalMonitor(options)).sent, true);
  assert.equal((await runOperationalMonitor(options)).sent, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Зависшие платежи/);
});

test('admin billing paginates bounded orders and diagnoses stuck/review states', async () => {
  const db = new MemoryDb({
    'users/admin': { role:'admin' },
    'users/u1': { name:'Player' },
    'billing_orders/700003': {
      uid:'u1', status:'requires_review', review_reason:'active_plan_conflict',
      plan_id:'plus', amount_minor:16900, created_at:timestamp('2026-07-30T11:00:00Z'),
    },
    'billing_orders/700002': {
      uid:'u1', status:'pending', plan_id:'plus', amount_minor:16900,
      created_at:timestamp('2026-07-30T10:00:00Z'),
    },
    'billing_orders/700001': {
      uid:'u1', status:'succeeded', plan_id:'plus', amount_minor:16900,
      created_at:timestamp('2026-07-30T09:00:00Z'),
    },
    'subscription_stats/overview': { purchases_total:1 },
    'billing_monitoring/robokassa': { result_callbacks_total:2 },
  });
  const handler = createAdminBillingHandler({
    db,
    auth:authFor('admin'),
    now:() => new Date('2026-07-30T12:00:00Z'),
  });
  const first = response();
  await handler({
    method:'GET', headers:{ authorization:'Bearer valid-token' },
    query:{ limit:'2', status:'all' },
  }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.orders.length, 2);
  assert.equal(first.body.next_cursor, '700002');
  assert.equal(first.body.monitoring.stuck_pending, 1);
  assert.equal(first.body.monitoring.requires_review, 1);
  assert.equal(first.body.orders[0].review_reason, 'active_plan_conflict');

  const second = response();
  await handler({
    method:'GET', headers:{ authorization:'Bearer valid-token' },
    query:{ limit:'2', status:'all', cursor:first.body.next_cursor },
  }, second);
  assert.deepEqual(second.body.orders.map(order => order.id), ['700001']);
  assert.equal(second.body.next_cursor, null);
});

test('account deletion identity is stable and endpoint requires confirmation plus recent sign-in', async () => {
  const pepper = 'account-deletion-pepper-value-000000000';
  assert.match(deletedSubjectId('user-1', pepper), /^[a-f0-9]{64}$/);
  assert.equal(
    deletedSubjectId('user-1', pepper),
    deletedSubjectId('user-1', pepper),
  );
  assert.notEqual(
    deletedSubjectId('user-1', pepper),
    deletedSubjectId('user-2', pepper),
  );

  const noConfirmation = response();
  await createAccountDeleteHandler({
    db:new MemoryDb(),
    auth:authFor('user-1'),
    pepper,
  })({
    method:'POST', headers:{ authorization:'Bearer valid-token' }, body:{},
  }, noConfirmation);
  assert.equal(noConfirmation.statusCode, 400);
  assert.equal(noConfirmation.body.error, 'confirmation_required');

  const staleAuth = {
    verifyIdToken:async () => ({ uid:'user-1', auth_time:100 }),
  };
  const stale = response();
  await createAccountDeleteHandler({
    db:new MemoryDb(),
    auth:staleAuth,
    pepper,
    now:() => new Date(1_000_000 * 1000),
  })({
    method:'POST',
    headers:{ authorization:'Bearer valid-token' },
    body:{ confirm:true },
  }, stale);
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.body.error, 'recent_sign_in_required');
});

test('Robokassa scenario generator signs valid, duplicate, invalid and amount-mismatch cases', () => {
  const scenarios = buildRobokassaTestScenarios({
    merchantLogin:'merchant',
    password2:'password-two',
    invoiceId:'700001',
    outSum:'69.30',
  });
  assert.deepEqual(
    scenarios.success_callback.form,
    scenarios.duplicate_callback.form,
  );
  assert.notEqual(
    scenarios.invalid_signature.form.SignatureValue,
    scenarios.success_callback.form.SignatureValue,
  );
  assert.equal(scenarios.canonical_amount_mismatch.form.OutSum, '0.01');
  assert.notEqual(
    scenarios.canonical_amount_mismatch.form.SignatureValue,
    scenarios.success_callback.form.SignatureValue,
  );
});
