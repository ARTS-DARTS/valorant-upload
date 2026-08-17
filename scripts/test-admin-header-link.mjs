import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('author cabinet exposes the admin link only through the admin role gate', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /class="header-admin"[^>]+href="\/admin\/"/);
  assert.match(html, /class="header-admin"[^>]+data-admin-only="true"/);
  assert.match(html, /class="header-admin"[^>]+style="display:none;"/);
});
