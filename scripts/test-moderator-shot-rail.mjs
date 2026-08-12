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

test('moderator screenshot rail is available in desktop-width windows and stays open for 30 seconds', () => {
  assert.match(appSource, /MODERATOR_SHOT_RAIL_AUTO_CLOSE_MS\s*=\s*30_000/);
  assert.match(appSource, /MODERATOR_SHOT_RAIL_MIN_VIEWPORT_WIDTH\s*=\s*900/);
  assert.match(appSource, /setTimeout\([\s\S]*?MODERATOR_SHOT_RAIL_AUTO_CLOSE_MS/);
  assert.match(
    appSource,
    /window\.innerWidth\s*>=\s*MODERATOR_SHOT_RAIL_MIN_VIEWPORT_WIDTH/,
  );
});

test('screenshot rail also renders for an author draft without a moderator source id', () => {
  const visibilityBlock = appSource.match(
    /function updateModeratorScreenshotRailVisibility\(\)[\s\S]*?function renderModeratorScreenshotRail/,
  )?.[0] || '';
  const renderBlock = appSource.match(
    /function renderModeratorScreenshotRail\(\)[\s\S]*?function bindModeratorScreenshotSorting/,
  )?.[0] || '';
  assert.match(visibilityBlock, /const visible = screenshots\.length > 0/);
  assert.doesNotMatch(visibilityBlock, /visible = !!moderatorDraftSourceId/);
  assert.match(renderBlock, /if \(!screenshots\.length\)/);
  assert.doesNotMatch(renderBlock, /if \(!moderatorDraftSourceId/);
});
