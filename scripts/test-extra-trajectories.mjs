import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('primary ability can only be added as one extra trajectory', () => {
  assert.match(app, /const abilities = selectedAgentAbilities\(\);/);
  assert.match(app, /function limitPrimaryAbilityExtras/);
  assert.match(app, /primaryCopies <= 1/);
  assert.match(app, /Для основной способности доступна только одна дополнительная траектория/);
  assert.match(app, /extraAbilityTrajectories\.length >= 2/);
  assert.match(html, /Для основной способности можно добавить одну дополнительную траекторию/);
});

test('each Sova extra trajectory keeps independent charge and bounces', () => {
  assert.match(app, /data-extra-sova-charge/);
  assert.match(app, /data-extra-sova-bounce/);
  assert.match(app, /closest\('\.sova-charge-slider'\)\?\.classList\.toggle\('is-max', item\.sova_charge >= 3\)/);
  assert.match(html, /id="extra-sova-shot-panels"/);
  assert.match(app, /sovaPanels\.innerHTML = extraAbilityTrajectories/);
  assert.doesNotMatch(app, /\$\{extraSovaParametersHtml\(item, idx\)\}\s*<\/div>/);
  assert.match(app, /sova_charge:item\.sova_charge, sova_bounces:item\.sova_bounces/);
  assert.match(app, /ПАРАМЕТРЫ · ДОП\. \$\{index \+ 1\}/);
  assert.match(app, /heading\.textContent = '🏹 ПАРАМЕТРЫ · ОСНОВНАЯ'/);
  assert.match(css, /grid-template-columns:185px minmax\(240px,1fr\) 70px/);
});

test('extra trajectory handlers stay inside the extra trajectory renderer', () => {
  const watcherStart = app.indexOf('function initGlobalSiteVersionWatcher()');
  const watcherEnd = app.indexOf("window.addEventListener('pagehide'", watcherStart);
  const watcher = app.slice(watcherStart, watcherEnd);
  assert.doesNotMatch(watcher, /data-extra-sova-(?:charge|bounce)/);

  const rendererStart = app.indexOf('function renderExtraAbilityPanel()');
  const rendererEnd = app.indexOf('function addExtraAbilityByName', rendererStart);
  const renderer = app.slice(rendererStart, rendererEnd);
  assert.match(renderer, /sovaPanels\?\.querySelectorAll\('\[data-extra-sova-charge\]'\)/);
  assert.match(renderer, /sovaPanels\?\.querySelectorAll\('\[data-extra-sova-bounce\]'\)/);
});
