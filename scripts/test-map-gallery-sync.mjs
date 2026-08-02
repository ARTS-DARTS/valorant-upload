import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const appSource = await readFile(new URL('app.js', root), 'utf8');
const redesignSource = await readFile(
  new URL('workspace-redesign.js', root),
  'utf8',
);

test('programmatic map selection synchronizes the visual gallery', () => {
  assert.match(
    redesignSource,
    /window\.syncProductionMapGallery = syncSelection/,
  );
  assert.match(
    redesignSource,
    /workspace:activate[\s\S]*?syncProductionMapGallery\?\.\(\)/,
  );
  assert.match(
    appSource,
    /sel\.value = d\.map;\s*window\.syncProductionMapGallery\?\.\(\)/,
  );
});

test('reset clears the visual map selection without recentering', () => {
  assert.match(
    appSource,
    /getElementById\('sel-map'\)\.value = '';\s*window\.syncProductionMapGallery\?\.\(\{ reveal: false \}\)/,
  );
});
