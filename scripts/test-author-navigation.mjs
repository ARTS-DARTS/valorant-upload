import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('rewards page returns to the author cabinet, not training', async () => {
  const html = await read('rewards/index.html');
  assert.match(html, /<a href="\/">Кабинет автора →<\/a>/);
  assert.doesNotMatch(html, /href="\/author-training\/?">Кабинет автора/);
});

test('training page contains only training content', async () => {
  const html = await read('author-training/index.html');
  assert.doesNotMatch(html, /7–12 VP за каждый одобренный лайнап/);
  assert.doesNotMatch(html, /rewards-widget\.js/);
});

test('own profile uses account and stats fallbacks', async () => {
  const source = await read('social-communication.mjs');
  assert.match(source, /getDoc\(doc\(db, 'users', normalized\)\)/);
  assert.match(source, /getDoc\(doc\(db, 'user_stats', normalized\)\)/);
  assert.match(source, /Мой публичный профиль/);
});
