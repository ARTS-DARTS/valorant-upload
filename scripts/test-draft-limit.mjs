import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('author drafts are capped at five before a new draft is created', () => {
  assert.match(source, /const MAX_SAVED_DRAFTS = 5;/);
  assert.match(source, /slice\(0, MAX_SAVED_DRAFTS\)/);
  assert.equal((source.match(/getSavedDrafts\(\)\.length >= MAX_SAVED_DRAFTS/g) || []).length, 2);
});
