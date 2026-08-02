import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');
const backendSource = await readFile(new URL('backend/moderation.js', root), 'utf8');

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

test('moderator editor exposes rejection and clears its active claim', () => {
  assert.match(appSource, /getElementById\('btn-reject-moderation'\).*rejectModeratorDraft\(\)/s);
  assert.match(appSource, /rejectButton\.hidden = !moderatorDraftSourceId/);
  assert.match(appSource, /JSON\.stringify\(\{ lineupId, action:'reject', reason \}\)/);
  assert.match(backendSource, /moderation_lock_uid: FieldValue\.delete\(\)/);
  assert.match(backendSource, /moderator_autosave: FieldValue\.delete\(\)/);
  assert.match(backendSource, /claimSnap\.exists[\s\S]*tx\.delete\(claimRef\)/);
});
