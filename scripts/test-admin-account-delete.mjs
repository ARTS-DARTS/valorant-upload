import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminAccountDeleteHandler } from '../backend/account-delete.js';

function response() {
  return {
    statusCode:200, body:null, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

function dependencies() {
  const db = { collection:name => ({ doc:uid => {
    if (name === 'users') return { get:async () => ({ exists:true, data:() => ({ role:'admin' }) }) };
    if (name === 'deleted_accounts') return { set:async () => {} };
    throw new Error(`unexpected document ${name}/${uid}`);
  } }) };
  return { db, auth:{ verifyIdToken:async () => ({ uid:'admin-1' }) } };
}

test('admin deletion uses the complete server deletion workflow', async () => {
  const { db, auth } = dependencies();
  let deletion = null;
  const handler = createAdminAccountDeleteHandler({
    db, auth, pepper:'x'.repeat(32),
    deleteData:async input => { deletion = input; return { removed:1, anonymized:2 }; }
  });
  const res = response();
  await handler({ method:'POST', headers:{ authorization:'Bearer valid' }, body:{ uid:'user-1', confirm:true } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(deletion.uid, 'user-1');
  assert.equal(deletion.auth, auth);
});

test('admin deletion rejects a missing target UID', async () => {
  const { db, auth } = dependencies();
  const handler = createAdminAccountDeleteHandler({
    db, auth, pepper:'x'.repeat(32), deleteData:async () => assert.fail('must not delete')
  });
  const res = response();
  await handler({ method:'POST', headers:{ authorization:'Bearer valid' }, body:{ confirm:true } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'target_uid_required');
});
