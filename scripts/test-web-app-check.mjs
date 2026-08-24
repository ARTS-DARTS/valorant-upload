import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('web App Check is initialized before Firebase services', () => {
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const init = source.indexOf('await initializePublicAppCheck(app)');
  assert.ok(init > source.indexOf('initializeApp(cfg)'));
  assert.ok(init < source.indexOf('getAuth(app)'));
  assert.ok(init < source.indexOf('getFirestore(app)'));
});

test('public config endpoint is wired and defaults to disabled', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const handler = fs.readFileSync(new URL('../backend/app-check-config.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/app-check-config'/);
  assert.match(handler, /Boolean\(siteKey\)/);
  assert.match(handler, /FIREBASE_APP_CHECK_WEB_SITE_KEY/);
});
