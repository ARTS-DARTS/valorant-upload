import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createClientErrorHandler } from '../backend/client-error.js';

function responseRecorder() {
  return {
    statusCode:200,
    body:null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('same-origin client error endpoint records authenticated browser failures', async () => {
  let saved = null;
  const handler = createClientErrorHandler({
    auth:{ verifyIdToken:async token => ({ uid:`uid-${token}`, email:'moderator@example.test' }) },
    db:{ collection:() => ({ add:async value => { saved = value; } }) },
  });
  const response = responseRecorder();
  await handler({
    method:'POST',
    headers:{ authorization:'Bearer token', 'user-agent':'Chrome Test' },
    body:{ message:'Moderator video failed', context:{ media_error_code:4 } },
    ip:'127.0.0.1',
  }, response);
  assert.equal(response.statusCode, 201);
  assert.equal(saved.uid, 'uid-token');
  assert.equal(saved.received_via, 'same_origin_backend');
  assert.equal(saved.context.media_error_code, 4);
});

test('moderation videos use proxy retry and report detailed MediaError diagnostics', async () => {
  const root = new URL('../', import.meta.url);
  const [moderation, app, server, css] = await Promise.all([
    readFile(new URL('moderation.js', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('server.js', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8'),
  ]);
  assert.match(moderation, /moderationProxyUrl/);
  assert.match(moderation, /media_error_code/);
  assert.match(moderation, /context\?\.reportError/);
  assert.match(moderation, /data-moderation-video-retry/);
  assert.match(app, /\/api\/client-error/);
  assert.match(server, /clientErrorHandler/);
  assert.match(css, /\.moderation-video-error/);
});
