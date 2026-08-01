import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppVersionHandler } from '../backend/app-version.js';

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('app version endpoint returns the public version policy', async () => {
  const firestore = () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          data: () => ({
            latest_version: ' 1.0.52 ',
            min_version: '1.0.51',
            internal_note: 'must not leak',
          }),
        }),
      }),
    }),
  });
  const res = response();

  await createAppVersionHandler({ firestore })({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    latest_version: '1.0.52',
    min_version: '1.0.51',
  });
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('app version endpoint rejects non-GET methods', async () => {
  const res = response();

  await createAppVersionHandler()({ method: 'POST' }, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'method_not_allowed' });
});
