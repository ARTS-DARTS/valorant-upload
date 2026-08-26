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
  assert.match(backendSource, /authors \}/);
  assert.match(moderationSource, /queueQuery\.set\('author', selectedAuthorKey\)/);
  assert.match(moderationSource, /queueAuthors = Array\.isArray\(body\.authors\)/);
});

test('moderation tasks and submitted lineups can be filtered independently', () => {
  assert.match(htmlSource, /id="moderation-work-filter"/);
  assert.match(htmlSource, /value="tasks">Задания/);
  assert.match(htmlSource, /value="lineups">Лайнапы/);
  assert.match(backendSource, /guild_assignment_id: clean\(d\.guild_assignment_id\)/);
  assert.match(backendSource, /const moderatorTask = item\?\.task_kind === 'metadata'/);
  assert.match(backendSource, /return moderatorTask \? 'tasks' : 'lineups'/);
  assert.match(backendSource, /const ACTION_LIMIT = 120/);
  assert.match(moderationSource, /\[502, 503, 504\]\.includes\(response\.status\)/);
  assert.match(backendSource, /function queueWorkCategory\(item\)/);
  assert.match(backendSource, /queue\.filter\(item => queueWorkCategory\(item\) === requestedCategory\)/);
  assert.match(moderationSource, /queueQuery\.set\('category', selectedWorkCategory\)/);
  assert.match(moderationSource, /workFilter\?\.addEventListener\('change', handleWorkFilterChange\)/);
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
