import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');

test('site contains a compliant 400 by 300 Twitch player surface', () => {
  assert.match(html, /id="twitch-live-player"/);
  assert.match(html, /id="twitch-live-embed"/);
  assert.match(js, /width:400, height:300/);
  assert.match(css, /\.twitch-live-embed\{width:400px;height:300px/);
});

test('player reads admin configuration and follows live state', () => {
  assert.match(js, /doc\(db, 'settings', 'twitch_streamers'\)/);
  assert.match(js, /Twitch\.Player\.ONLINE/);
  assert.match(js, /Twitch\.Player\.OFFLINE/);
  assert.match(js, /Number\(config\.initial_volume \?\? 1\) \/ 100/);
  assert.match(js, /setTimeout\(scanTwitchLiveChannels, 180000\)/);
});

test('viewer can minimize and close the player', () => {
  assert.match(js, /vlineups:twitch-live-closed/);
  assert.match(js, /classList\.add\('minimized'\)/);
  assert.match(js, /classList\.remove\('minimized'\)/);
});
