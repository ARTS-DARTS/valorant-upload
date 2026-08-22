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
  assert.match(js, /width:400, height:300/);
  assert.match(css, /\.twitch-live-player\{width:400px;transform:none\}/);
});

test('player reads admin configuration and follows live state', () => {
  assert.match(js, /doc\(db, 'settings', 'twitch_streamers'\)/);
  assert.match(js, /Twitch\.Player\.ONLINE/);
  assert.match(js, /Twitch\.Player\.OFFLINE/);
  assert.match(js, /Number\(config\.initial_volume \?\? 1\) \/ 100/);
  assert.match(js, /setTimeout\(scanTwitchLiveChannels, 180000\)/);
});

test('only a confirmed online channel can be shown and autoplayed', () => {
  assert.match(js, /autoplay:config\.autoplay !== false, muted:true/);
  assert.match(js, /if \(!ready \|\| !confirmedOnline \|\| config\.autoplay === false/);
  assert.match(js, /Twitch\.Player\.READY[\s\S]*ready = true;[\s\S]*startLivePlayback\(\)/);
  assert.match(js, /Twitch\.Player\.ONLINE[\s\S]*confirmedOnline = true;[\s\S]*shell\.hidden = false;[\s\S]*startLivePlayback\(\)/);
  assert.match(js, /if \(!selected\) return;/);
  assert.match(css, /\.twitch-live-player\.is-checking\{visibility:visible;opacity:0;pointer-events:none\}/);
  assert.match(js, /setTimeout\(startLivePlayback, 1200\)/);
});

test('viewer can hide and restore the player without a close action', () => {
  assert.doesNotMatch(html, /id="twitch-live-close"/);
  assert.match(js, /activeTwitchPlayer\?\.pause\(\)/);
  assert.match(js, /classList\.add\('minimized'\)/);
  assert.match(js, /classList\.remove\('minimized'\)/);
  assert.match(js, /vlineups:twitch-live-position/);
  assert.match(js, /setPointerCapture/);
  assert.match(js, /function enableTwitchRestoreDrag\(\)/);
  assert.match(js, /suppressClick/);
});

test('Twitch embed remains interactive when autoplay is blocked', () => {
  assert.match(css, /\.twitch-live-embed iframe\{pointer-events:auto\}/);
  assert.match(js, /PLAYBACK_BLOCKED[\s\S]*if \(!confirmedOnline\) return;[\s\S]*setTimeout\(startLivePlayback, 250\)/);
  assert.doesNotMatch(js, /enableTwitchSoundAfterGesture/);
  assert.doesNotMatch(js, /activeTwitchPlayer\.setMuted\(false\)/);
});

test('muted autoplay waits for both Twitch readiness and online confirmation', () => {
  assert.match(js, /Twitch\.Player\.READY/);
  assert.match(js, /const startLivePlayback = \(\) => \{[\s\S]*player\.setMuted\(true\);[\s\S]*player\.play\(\)/);
});
