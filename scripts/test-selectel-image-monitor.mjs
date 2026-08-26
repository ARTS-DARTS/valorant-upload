import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSelectelImages } from './monitor-selectel-images.mjs';

test('Selectel monitor verifies unique current screenshot URLs and counts bytes', async () => {
  const docs = [
    { data:() => ({ screenshots:['https://bucket.selstorage.ru/a.jpg', 'https://bucket.selstorage.ru/a.jpg'] }) },
    { data:() => ({ screenshot_urls:['https://bucket.selstorage.ru/b.png', 'https://res.cloudinary.com/old.jpg'] }) },
  ];
  const db = { collection:() => ({ select:() => ({ get:async () => ({ docs, size:docs.length }) }) }) };
  const fetchImpl = async url => ({ ok:true, status:200, headers:new Headers({
    'content-type':url.endsWith('.png') ? 'image/png' : 'image/jpeg', 'content-length':'125',
  }) });
  const result = await inspectSelectelImages({ db, fetchImpl, concurrency:2 });
  assert.equal(result.objects, 2);
  assert.equal(result.verified, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.storage_bytes, 250);
});

test('Selectel monitor records inaccessible objects without aborting the audit', async () => {
  const docs = [{ data:() => ({ screenshots:['https://bucket.selstorage.ru/missing.jpg'] }) }];
  const db = { collection:() => ({ select:() => ({ get:async () => ({ docs, size:1 }) }) }) };
  const fetchImpl = async () => ({ ok:false, status:404, headers:new Headers() });
  const result = await inspectSelectelImages({ db, fetchImpl });
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].error, /HTTP 404/);
});
