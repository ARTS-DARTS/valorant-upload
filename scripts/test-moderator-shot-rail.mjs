import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');

test('moderator screenshot rail starts at the map editor', () => {
  const visibilityBlock = appSource.match(
    /function updateModeratorScreenshotRailVisibility\(\)[\s\S]*?function renderModeratorScreenshotRail/,
  )?.[0] || '';
  assert.match(
    visibilityBlock,
    /document\.querySelector\('\.map-editor-shell'\)/,
  );
  assert.match(
    visibilityBlock,
    /editorRect\.top < window\.innerHeight \* \.58/,
  );
  assert.doesNotMatch(visibilityBlock, /lineup-copy-editor/);
});

test('moderator screenshot rail remains available through the rest of the form', () => {
  const visibilityBlock = appSource.match(
    /function updateModeratorScreenshotRailVisibility\(\)[\s\S]*?function renderModeratorScreenshotRail/,
  )?.[0] || '';
  assert.match(visibilityBlock, /formRect\.bottom > 82/);
  assert.doesNotMatch(visibilityBlock, /editorRect\.bottom > 82/);
});

test('moderator screenshot rail supports persistent reordering', () => {
  assert.match(appSource, /draggable="true" data-moderator-shot/);
  assert.match(appSource, /function bindModeratorScreenshotSorting\(list\)/);
  assert.match(appSource, /screenshots\.splice\(fromIndex, 1\)/);
  assert.match(appSource, /screenshots\.splice\(toIndex, 0, entry\)/);
  assert.match(appSource, /renderScreenshots\(\);\s*_saveDraft\(\)/);
});
