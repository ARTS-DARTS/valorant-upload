import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const moderation = readFileSync(new URL('../backend/moderation.js', import.meta.url), 'utf8');
const moderationClient = readFileSync(new URL('../moderation.js', import.meta.url), 'utf8');

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

test('map ability icons face down independently from Spike', () => {
  assert.match(app, /rotate\(\$\{-currentMapQuarterTurns\(\) \* 90\} \$\{cx\} \$\{cy\}\)/);
  assert.match(app, /icon\.setAttribute\('width', '18'\)/);
  assert.match(app, /icon\.setAttribute\('height', '18'\)/);
  assert.match(css, /#marker-icon\s*\{[^}]*rotate\(var\(--map-counter-rotation, 0deg\)\)/);
  assert.match(css, /\.spike-map-marker img\{[^}]*\+ 90deg/);
});

test('selecting an extra trajectory keeps the primary ability marker intact', () => {
  assert.match(app, /const iconUrl = ability\?\.displayIcon \|\| '';/);
  assert.match(app, /if \(marker\) marker\.style\.visibility = '';/);
  assert.doesNotMatch(app, /marker\.style\.visibility = extra \? 'hidden'/);
});

test('moderation preserves and validates Spike metadata', () => {
  assert.match(moderation, /missing\.push\('spike_usage'\)/);
  assert.match(moderation, /spike_usage: clean\(data\.spike_usage\)/);
  assert.match(moderation, /spike_x:finite01\(data\.spike_x\)/);
  assert.match(moderation, /spike_y:finite01\(data\.spike_y\)/);
  const restoredDraft = app.slice(
    app.indexOf('function rejectedLineupDraft'),
    app.indexOf('function categoryExtraDetailHtml'),
  );
  assert.match(restoredDraft, /spikeUsage: item\.spike_usage \|\| null/);
  assert.match(restoredDraft, /spikeX: item\.spike_x \?\? null/);
  assert.match(restoredDraft, /spikeY: item\.spike_y \?\? null/);
});

test('moderator metadata task supports an explicit Spike decision and map position', () => {
  assert.match(moderationClient, /data-spike-usage="placed"/);
  assert.match(moderationClient, /data-spike-usage="not_used"/);
  assert.match(moderationClient, /data-spike-map/);
  assert.match(moderationClient, /Указать использование Spike/);
  assert.match(moderationClient, /data\.spike_usage =/);
  assert.match(moderationClient, /data\.spike_x = Number/);
  assert.match(moderationClient, /data\.spike_y = Number/);
  assert.match(moderation, /update\.spike_usage = usage/);
  assert.match(moderation, /update\.spike_x = finite01/);
  assert.match(moderation, /update\.spike_y = finite01/);
});
