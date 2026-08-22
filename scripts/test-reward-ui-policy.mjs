import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitForRewards,
  rewardActionErrorMessage,
  rewardProgramAccepting,
} from '../reward-ui-policy.mjs';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rewardsPage = readFileSync(new URL('../rewards/index.html', import.meta.url), 'utf8');

test('reward actions require an explicitly enabled program', () => {
  assert.equal(rewardProgramAccepting({ enabled:true }), true);
  assert.equal(rewardProgramAccepting({ enabled:false }), false);
  assert.equal(rewardProgramAccepting({}), false);
});

test('submission opt-in requires program, membership and current terms', () => {
  const valid = { settings:{ enabled:true }, membership:{ status:'active', terms_current:true } };
  assert.equal(canSubmitForRewards(valid), true);
  assert.equal(canSubmitForRewards({ ...valid, settings:{ enabled:false } }), false);
  assert.equal(canSubmitForRewards({ ...valid, membership:{ status:'active', terms_current:false } }), false);
});

test('reward errors never expose a technical stack', () => {
  assert.equal(rewardActionErrorMessage({
    code:'functions/failed-precondition',
    message:'Rewards program is not accepting participants.\n#0 stack',
  }), 'Программа наград пока не принимает участников');
  assert.equal(rewardActionErrorMessage(new Error('Ошибка\n#0 stack')), 'Ошибка');
});

test('reward currency is consistently presented as VP', () => {
  const start = app.indexOf('function renderRewardDialog()');
  const end = app.indexOf('async function loadRewardDashboard', start);
  const rewardDialog = app.slice(start, end);
  assert.match(rewardDialog, /Запросить код/);
  assert.match(rewardDialog, /activePayout/);
  assert.doesNotMatch(rewardDialog, /балл(?:ы|ов|а)?/i);
  assert.doesNotMatch(rewardsPage, /балл(?:ы|ов|а)?/i);
  assert.match(html, /7–12 VP/);
});

test('author statistics keeps a server-backed VP summary', () => {
  assert.match(html, /id="cabinet-vp-grid"/);
  assert.match(app, /function renderCabinetVpStats/);
  assert.match(app, /balance\.available_vp/);
  assert.match(app, /balance\.earned_vp/);
  assert.match(app, /balance\.reserved_vp/);
  assert.match(app, /balance\.paid_vp/);
  assert.match(app, /Награждено лайнапов/);
});

test('reward demand starts with an open category and explains setup quotas', () => {
  assert.match(app, /Какая категория интересует\?/);
  assert.match(app, /content_categories/);
  assert.match(app, /data-demand-category/);
  assert.match(app, /Для каждого доступного агента на каждом сайте нужно 5 одобренных сетапов защиты/);
  assert.match(app, /Атака не учитывается/);
  assert.match(app, /row\.agent \|\| 'Агент'/);
  assert.match(app, /БЕЗ ДОП\. VP/);
});

test('Telegram community link is not duplicated in the author sidebar', () => {
  assert.doesNotMatch(html, /class="sidebar-telegram"/);
  assert.match(html, /class="header-telegram"/);
});
