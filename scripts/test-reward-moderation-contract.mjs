import test from 'node:test';
import './test-selectel-image-storage.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueSource = readFileSync(new URL('../moderation.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const backendSource = readFileSync(new URL('../backend/moderation.js', import.meta.url), 'utf8');

test('reward eligibility is decided explicitly at final moderation submit', () => {
  assert.match(queueSource, /итоговая оценка появится при завершении проверки/);
  assert.match(appSource, /requestModeratorRewardDecision\(moderationLineupId\)/);
  assert.match(appSource, /name="final-reward-eligible" value="yes"/);
  assert.match(appSource, /name="final-reward-eligible" value="no"/);
  assert.doesNotMatch(appSource, /name="final-reward-eligible" value="(?:yes|no)" checked/);
  assert.match(appSource, /Выбери «Да» или «Нет» для каждого критерия/);
});

test('moderation reward review keeps and validates the existing lineup id', () => {
  assert.match(appSource, /const moderationLineupId = String\(moderatorDraftSourceId \|\| ''\)\.trim\(\)/);
  assert.match(appSource, /getDoc\(doc\(db, 'lineups', moderationLineupId\)\)/);
  assert.match(appSource, /lineup_id: moderationLineupId \|\| lineupId/);
  assert.match(appSource, /moderation\.complete lineup review/);
});

test('quality bonus cannot be selected for an ineligible lineup', () => {
  assert.match(appSource, /eligibleChoice === 'no' && qualityChoice === 'yes'/);
});

test('automatic deficit and task criteria are shown separately from moderator choices', () => {
  assert.match(appSource, /reward-review-auto/);
  assert.match(appSource, /Общий дефицит/);
  assert.match(appSource, /Дефицит активного маппула/);
  assert.match(appSource, /Автозадание рынка/);
});

test('reward review is saved before the moderator lineup completion request', () => {
  const branch = appSource.match(/const rewardReviewRequired = currentLineup\.data\(\)\?\.reward_program_opt_in === true[\s\S]*?const token = await currentUser\.getIdToken\(\);/)?.[0] || '';
  assert.match(branch, /if \(rewardReviewRequired\)/);
  assert.match(branch, /saveModeratorRewardDecision/);
  assert.match(branch, /const token = await currentUser\.getIdToken/);
});

test('reward review participation is read from the current server lineup', () => {
  assert.match(appSource, /const currentLineup = await getDoc\(doc\(db, 'lineups', moderationLineupId\)\)/);
  assert.match(appSource, /currentLineup\.data\(\)\?\.reward_program_opt_in === true\s*\|\| moderatorRewardOptIn === true/);
  assert.doesNotMatch(appSource, /if \(moderatorRewardOptIn\) \{[\s\S]*?requestModeratorRewardDecision/);
});

test('moderator reward indicator mirrors the stored participation flag', () => {
  assert.match(appSource, /else if \(moderationActive\) input\.checked = moderatorRewardOptIn === true/);
  assert.match(appSource, /moderatorRewardOptIn = d\.moderatorRewardOptIn === true;[\s\S]*?updateRewardSubmitOptIn\(\)/);
});

test('moderator can persist reward participation before completing review', () => {
  assert.match(appSource, /action:'set_reward_participation'/);
  assert.match(appSource, /moderatorRewardOptIn = enabled/);
  assert.match(backendSource, /action === 'set_reward_participation'/);
  assert.match(backendSource, /reward_program_opt_in:enabled/);
  assert.match(backendSource, /reward_terms_version:enabled \? termsVersion : FieldValue\.delete\(\)/);
});

test('reward review falls back to the moderation database when callable cannot find lineup', () => {
  assert.match(appSource, /context_unavailable:true/);
  assert.match(appSource, /saveModeratorRewardDecision\(moderationLineupId, rewardDecision\)/);
  assert.match(appSource, /action:'save_reward_review'/);
  assert.match(backendSource, /action === 'save_reward_review'/);
  assert.match(backendSource, /db\.collection\('reward_lineup_reviews'\)\.doc\(lineupId\)/);
  assert.match(backendSource, /moderation_fallback:true/);
});
