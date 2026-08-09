import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('primary ability can also be used for both extra trajectories', () => {
  assert.match(app, /const abilities = selectedAgentAbilities\(\);/);
  assert.doesNotMatch(app, /filter\(ab => ab\.ability !== selectedAbility\)/);
  assert.doesNotMatch(app, /Основная абилка уже выбрана выше/);
  assert.match(app, /extraAbilityTrajectories\.length >= 2/);
  assert.match(html, /Одну абилку можно добавить дважды/);
});
