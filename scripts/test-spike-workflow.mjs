import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const moderation = readFileSync(new URL('../backend/moderation.js', import.meta.url), 'utf8');

test('attack lineup requires an explicit Spike decision', () => {
  assert.match(html, /id="mode-spike"/);
  assert.match(html, /id="spike-not-used"/);
  assert.match(app, /Укажи Spike на карте или выбери «Не используется»/);
  assert.match(app, /spike_usage:'placed', spike_x:spikeX, spike_y:spikeY/);
  assert.match(app, /spike_usage:'not_used'/);
});

test('Spike uses the game-shaped marker at reduced map size', () => {
  assert.match(html, /\/assets\/spike-standard\.svg/);
  assert.match(css, /\.spike-map-marker\{[^}]*width:20px;height:20px/);
});

test('moderation preserves and validates Spike metadata', () => {
  assert.match(moderation, /missing\.push\('spike_usage'\)/);
  assert.match(moderation, /spike_usage: clean\(data\.spike_usage\)/);
  assert.match(moderation, /spike_x:finite01\(data\.spike_x\)/);
  assert.match(moderation, /spike_y:finite01\(data\.spike_y\)/);
});
