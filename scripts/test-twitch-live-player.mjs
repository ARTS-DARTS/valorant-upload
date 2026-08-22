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
  assert.match(js, /width:534, height:300/);
});

test('player reads admin configuration and follows live state', () => {
  assert.match(js, /doc\(db, 'settings', 'twitch_streamers'\)/);
  assert.match(js, /Twitch\.Player\.ONLINE/);
  assert.match(js, /Twitch\.Player\.OFFLINE/);
  assert.match(js, /Number\(config\.initial_volume \?\? 1\) \/ 100/);
  assert.match(js, /setTimeout\(scanTwitchLiveChannels, 180000\)/);
});

test('only a confirmed online channel can be shown and autoplayed', () => {
  assert.match(js, /autoplay:false, muted:true/);
  assert.match(js, /Twitch\.Player\.ONLINE[\s\S]*shell\.hidden = false;[\s\S]*player\.play\(\)/);
  assert.doesNotMatch(js.match(/Twitch\.Player\.READY[\s\S]*?\n\s*}\);/)?.[0] || '', /player\.play\(\)/);
  assert.match(js, /if \(!selected\) return;/);
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

test('compact Twitch embed stays passive on hover', () => {
  assert.match(css, /\.twitch-live-embed iframe\{pointer-events:none\}/);
  assert.match(js, /PLAYBACK_BLOCKED[\s\S]*player\.setMuted\(true\);[\s\S]*player\.play\(\)/);
  assert.match(js, /function enableTwitchSoundAfterGesture\(\)[\s\S]*activeTwitchPlayer\.setMuted\(false\)/);
  assert.match(js, /document\.addEventListener\('pointerdown', enableTwitchSoundAfterGesture, true\)/);
});

test('muted autoplay is reinforced when the Twitch player becomes ready', () => {
  assert.match(js, /Twitch\.Player\.READY/);
  assert.match(js, /Twitch\.Player\.READY[\s\S]*player\.setMuted\(true\);[\s\S]*player\.play\(\)/);
});
