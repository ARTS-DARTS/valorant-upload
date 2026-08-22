import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');

test('site contains a widescreen Twitch player surface', () => {
  assert.match(html, /id="twitch-live-player"/);
  assert.match(html, /id="twitch-live-embed"/);
  assert.match(js, /iframe\.width = '400'; iframe\.height = '225'/);
  assert.match(css, /\.twitch-live-player\{width:400px;min-height:0;transform:none\}/);
  assert.match(css, /height:225px!important/);
});

test('player reads admin configuration and follows live state', () => {
  assert.match(js, /doc\(db, 'settings', 'twitch_streamers'\)/);
  assert.match(js, /firstOnlineTwitchChannel\(channels\)/);
  assert.match(js, /sort\(\(a,b\) => Number\(a\.priority\|\|0\)-Number\(b\.priority\|\|0\)\)/);
  assert.match(js, /setTimeout\(scanTwitchLiveChannels, 60000\)/);
});

test('only a confirmed online channel can be shown and autoplayed', () => {
  assert.match(js, /vlineups_offline_probe_9f4c2/);
  assert.match(js, /if \(!twitchPreviewMatches\(preview, offline\)\) return streamer/);
  assert.match(js, /autoplay:String\(config\.autoplay !== false\), muted:'true'/);
  assert.match(js, /iframe\.allow = 'autoplay; fullscreen'/);
  assert.doesNotMatch(js, /new Twitch\.Player/);
});

test('viewer can hide and restore the player without a close action', () => {
  assert.doesNotMatch(html, /id="twitch-live-close"/);
  assert.match(js, /classList\.add\('minimized'\)/);
  assert.match(js, /classList\.remove\('minimized'\)/);
  assert.match(js, /vlineups:twitch-live-position/);
  assert.match(js, /setPointerCapture/);
  assert.match(js, /function enableTwitchRestoreDrag\(\)/);
  assert.match(js, /suppressClick/);
});

test('Twitch embed remains interactive when autoplay is blocked', () => {
  assert.match(css, /\.twitch-live-embed iframe\{pointer-events:auto\}/);
  assert.doesNotMatch(js, /activeTwitchPlayer/);
  assert.doesNotMatch(js, /enableTwitchSoundAfterGesture/);
});

test('the active iframe is preserved while the selected channel stays the same', () => {
  assert.match(js, /if \(activeTwitchChannel === streamer\.channel && mount\.querySelector\('iframe'\)\) return/);
});
