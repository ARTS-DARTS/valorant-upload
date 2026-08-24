import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');

test('lineup guide automatically opens once after the lineup category is chosen', () => {
  assert.match(appSource, /LINEUP_FORM_GUIDE_FIRST_VIEW_KEY\s*=\s*'vl_lineup_form_guide_b8c491d_seen'/);
  assert.match(appSource, /function showLineupFormGuideOnFirstCategoryChoice\(\)/);
  assert.match(appSource, /localStorage\.getItem\(LINEUP_FORM_GUIDE_FIRST_VIEW_KEY\)/);
  assert.match(appSource, /localStorage\.setItem\(LINEUP_FORM_GUIDE_FIRST_VIEW_KEY, '1'\)/);
  assert.match(appSource, /openCategoryFormGuide\(\{ autoplay: true \}\)/);
  assert.match(
    appSource,
    /updateCategoryTrainingGate\(\);\s*showLineupFormGuideOnFirstCategoryChoice\(\);/,
  );
});

test('automatic guide playback is requested from the category click flow', () => {
  assert.match(appSource, /function openCategoryFormGuide\(\{ autoplay = false \} = \{\}\)/);
  assert.match(appSource, /video\.addEventListener\('canplay',[\s\S]*?video\.play\(\)/);
});

test('mandatory training never overlaps the optional form guide', () => {
  assert.match(
    appSource,
    /if \(categoryTrainingGateActive \|\| !hasCategoryTraining\('lineup'\)\) return;/,
  );
  assert.match(
    appSource,
    /categoryTrainingGateActive = Boolean\([\s\S]*?if \(categoryTrainingGateActive\) closeCategoryFormGuide\(\);/,
  );
});
