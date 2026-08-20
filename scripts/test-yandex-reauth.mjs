import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stateSource = readFileSync(new URL('../backend/yandex-link-state.js', import.meta.url), 'utf8');
const startSource = readFileSync(new URL('../backend/yandex-start.js', import.meta.url), 'utf8');
const callbackSource = readFileSync(new URL('../backend/yandex-callback.js', import.meta.url), 'utf8');

test('Yandex reauthentication uses a signed one-time state bound to the current UID', () => {
  assert.match(stateSource, /\['link', 'reauth'\]\.includes\(kind\)/);
  assert.match(startSource, /verifyIdToken\(idToken, true\)/);
  assert.match(startSource, /createYandexLinkState\(decoded\.uid, 600, mode\)/);
  assert.match(callbackSource, /existingUid !== firebaseUid/);
  assert.match(callbackSource, /consumeLinkState\(db, signedState\)/);
});

test('Yandex reauthentication only issues a token for the already linked account', () => {
  const section = callbackSource.match(/if \(signedState\?\.kind === 'reauth'\) \{[\s\S]*?return appRedirect\(res, `\$\{APP_SCHEME\}\?reauth=true/)?.[0] || '';
  assert.match(section, /resolveYandexUid\(db, yandexId\)/);
  assert.match(section, /existingUid !== firebaseUid/);
  assert.match(section, /createCustomToken\(firebaseUid/);
});
