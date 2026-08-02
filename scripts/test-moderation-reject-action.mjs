import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');
const backendSource = await readFile(new URL('backend/moderation.js', root), 'utf8');
const indexSource = await readFile(new URL('index.html', root), 'utf8');

test('moderator editor exposes rejection and clears its active claim', () => {
  assert.match(indexSource, /id="btn-reject-moderation"[^>]*hidden/);
  assert.match(appSource, /getElementById\('btn-reject-moderation'\).*rejectModeratorDraft\(\)/s);
  assert.match(appSource, /rejectButton\.hidden = !moderatorDraftSourceId/);
  assert.match(appSource, /JSON\.stringify\(\{ lineupId, action:'reject', reason \}\)/);
  assert.match(backendSource, /moderation_lock_uid: FieldValue\.delete\(\)/);
  assert.match(backendSource, /moderator_autosave: FieldValue\.delete\(\)/);
  assert.match(backendSource, /claimSnap\.exists[\s\S]*tx\.delete\(claimRef\)/);
});
