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

test('new author statistics start before optional account services', async () => {
  const source = await read('app.js');
  const authStart = source.indexOf('onAuthStateChanged(auth');
  const statsPosition = source.indexOf('_subscribeStats(user.uid);', authStart);
  const rewardsPosition = source.indexOf('await loadRewardDashboard();', authStart);
  assert.ok(statsPosition > authStart, 'statistics subscription must be started');
  assert.ok(rewardsPosition > statsPosition, 'statistics must not wait for rewards dashboard');
  assert.match(source, /_statsFallbackTimer = setTimeout\([\s\S]*?element\.textContent = '0'/);
});

test('chat sends cannot erase text typed while the request is pending', async () => {
  const app = await read('app.js');
  const social = await read('social-communication.mjs');
  for (const source of [app, social]) {
    assert.match(source, /const submittedValue = input\?\.value \|\| '';/);
    assert.match(source, /input\.value = '';[\s\S]*?await/);
    assert.match(source, /if \(input\.value === ''\) input\.value = submittedValue;/);
  }
});
