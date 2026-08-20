import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../moderation.js', import.meta.url), 'utf8');

test('reward eligibility requires an explicit moderator choice', () => {
  assert.match(source, /data-reward-eligible/);
  assert.doesNotMatch(source, /data-reward-eligible checked/);
  assert.match(source, /Выбери «Да» или «Нет» для каждого ручного критерия/);
});

test('quality bonus cannot be selected for an ineligible lineup', () => {
  assert.match(source, /!eligible && qualityClear/);
});

test('automatic deficit and task criteria are shown separately from moderator choices', () => {
  assert.match(source, /data-reward-auto/);
  assert.match(source, /Общий дефицит/);
  assert.match(source, /Дефицит маппула/);
  assert.match(source, /Активное задание/);
});
