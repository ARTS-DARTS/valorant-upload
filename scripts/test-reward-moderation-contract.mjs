import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueSource = readFileSync(new URL('../moderation.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

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
  assert.match(appSource, /Дефицит маппула/);
  assert.match(appSource, /Активное задание/);
});

test('reward review is saved before the moderator lineup completion request', () => {
  const branch = appSource.match(/const rewardReviewRequired = currentLineup\.data\(\)\?\.reward_program_opt_in === true;[\s\S]*?const token = await currentUser\.getIdToken\(\);/)?.[0] || '';
  assert.match(branch, /if \(rewardReviewRequired\)/);
  assert.match(branch, /staffReviewRewardLineup/);
  assert.match(branch, /const token = await currentUser\.getIdToken/);
});

test('reward review participation is read from the current server lineup', () => {
  assert.match(appSource, /const currentLineup = await getDoc\(doc\(db, 'lineups', moderationLineupId\)\)/);
  assert.match(appSource, /currentLineup\.data\(\)\?\.reward_program_opt_in === true/);
  assert.doesNotMatch(appSource, /if \(moderatorRewardOptIn\) \{[\s\S]*?requestModeratorRewardDecision/);
});
