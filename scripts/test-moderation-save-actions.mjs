import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');
const backendSource = await readFile(new URL('backend/moderation.js', root), 'utf8');
const moderationSource = await readFile(new URL('moderation.js', root), 'utf8');
const htmlSource = await readFile(new URL('index.html', root), 'utf8');

test('moderation queue can be filtered by authors present in the queue', () => {
  assert.match(htmlSource, /id="moderation-author-filter"/);
  assert.match(backendSource, /const authors = \[\.\.\.categoryQueue\.reduce/);
  assert.match(backendSource, /categoryQueue\.filter\(item => queueAuthorKey\(item\) === requestedAuthor\)/);
  assert.match(backendSource, /authors, active_claim \}/);
  assert.match(moderationSource, /queueQuery\.set\('author', selectedAuthorKey\)/);
  assert.match(moderationSource, /queueAuthors = Array\.isArray\(body\.authors\)/);
});

test('moderation tasks and submitted lineups can be filtered independently', () => {
  assert.match(htmlSource, /id="moderation-work-filter"/);
  assert.match(htmlSource, /value="tasks">Задания/);
  assert.match(htmlSource, /value="lineups">Лайнапы/);
  assert.match(backendSource, /guild_assignment_id: clean\(d\.guild_assignment_id\)/);
  assert.match(backendSource, /moderation_work_kind: clean\(d\.moderation_work_kind\)/);
  assert.match(backendSource, /if \(item\?\.moderation_work_kind === 'task'\) return 'tasks'/);
  assert.match(backendSource, /if \(item\?\.moderation_work_kind === 'lineup'\) return 'lineups'/);
  assert.match(backendSource, /const moderatorTask = item\?\.task_kind === 'metadata' \|\| item\?\.media_recovery_task === true/);
  assert.match(backendSource, /return moderatorTask \? 'tasks' : 'lineups'/);
  assert.match(backendSource, /const ACTION_LIMIT = 120/);
  assert.match(moderationSource, /\[502, 503, 504\]\.includes\(response\.status\)/);
  assert.match(backendSource, /function queueWorkCategory\(item\)/);
  assert.match(backendSource, /queue\.filter\(item => queueWorkCategory\(item\) === requestedCategory\)/);
  assert.match(moderationSource, /queueQuery\.set\('category', selectedWorkCategory\)/);
  assert.match(moderationSource, /workFilter\?\.addEventListener\('change', handleWorkFilterChange\)/);
});

test('an active claim remains discoverable when queue filters hide its card', () => {
  assert.match(backendSource, /activeClaimItem = queue\.find/);
  assert.match(backendSource, /authors, active_claim/);
  assert.match(moderationSource, /activeClaimSummary = body\.active_claim/);
  assert.match(moderationSource, /data-active-claim-category/);
  assert.match(moderationSource, /selectedWorkCategory = button\.dataset\.activeClaimCategory/);
});

test('expired and inconsistent moderation claims repair themselves safely', () => {
  assert.match(backendSource, /async function cleanupExpiredClaims\(db\)/);
  assert.match(backendSource, /where\('expires_at', '<=', new Date\(now\)\)/);
  assert.match(backendSource, /action: 'claim_expired_cleanup'/);
  assert.match(backendSource, /const previousLockValid = previousSnap\.exists/);
  assert.match(backendSource, /action: 'stale_claim_replaced'/);
  assert.match(backendSource, /await cleanupExpiredClaims\(db\)/);
});

test('moderator save and completion use different API actions', () => {
  const saveClickHandler = appSource.match(
    /getElementById\('btn-save-draft'\)[\s\S]*?saveCurrentDraftSnapshot\(\);/,
  )?.[0] || '';
  assert.match(saveClickHandler, /saveModeratorProgress\(\)/);
  assert.doesNotMatch(saveClickHandler, /getElementById\('btn-submit'\).*\.click\(\)/);
  assert.match(appSource, /action:'save_progress'/);
  assert.match(appSource, /action:\s*'save_draft'/);
});

test('save_progress keeps the moderation task incomplete', () => {
  assert.match(
    backendSource,
    /action === 'save_progress'\) return saveDraft\(req, res, moderator, \{ complete:false \}\)/,
  );
  assert.match(
    backendSource,
    /if \(complete\) \{[\s\S]*?status: 'pending', moderator_only: false,[\s\S]*?moderator_template_completed: true/,
  );
  assert.match(
    backendSource,
    /action: complete \? 'complete_lineup' : 'save_progress'/,
  );
});

test('moderator autosave never nests Firestore delete sentinels', () => {
  const autosaveDraft = backendSource.slice(
    backendSource.indexOf('async function autosaveDraft'),
    backendSource.indexOf('function queueAuthorKey'),
  );
  assert.match(autosaveDraft, /spike_usage: clean\(data\.spike_usage\)/);
  assert.doesNotMatch(autosaveDraft, /FieldValue\.delete\(\)/);
  assert.match(autosaveDraft, /expiresAt = new Date\(Date\.now\(\) \+ MODERATION_LOCK_MS\)/);
});

test('active moderator claim is renewed before its lease expires', () => {
  assert.match(moderationSource, /action: 'renew_claim'/);
  assert.match(moderationSource, /claimHeartbeatTimer = setInterval\(\(\) => renewClaim\(lineupId\), 2 \* 60_000\)/);
  assert.match(moderationSource, /claimExpiresAt = Number\(claim\.expires_at\)/);
});

test('moderator editor exposes rejection and clears its active claim', () => {
  assert.match(appSource, /getElementById\('btn-reject-moderation'\).*rejectModeratorDraft\(\)/s);
  assert.match(appSource, /rejectButton\.hidden = !moderatorDraftSourceId/);
  assert.match(appSource, /JSON\.stringify\(\{ lineupId, action:'reject', reason \}\)/);
  assert.match(backendSource, /moderation_lock_uid: FieldValue\.delete\(\)/);
  assert.match(backendSource, /moderator_autosave: FieldValue\.delete\(\)/);
  assert.match(backendSource, /claimSnap\.exists[\s\S]*tx\.delete\(claimRef\)/);
});
