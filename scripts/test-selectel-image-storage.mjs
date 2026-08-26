import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('author screenshots upload only through the signed Selectel image endpoint', () => {
  assert.match(app, /createSelectelImageUpload/);
  assert.match(app, /xhr\.open\('PUT', uploadUrl\)/);
  assert.match(app, /resolve\(publicUrl\)/);
  assert.doesNotMatch(app, /api\.cloudinary\.com\/v1_1\/djxgwkbqn\/image\/upload/);
});
