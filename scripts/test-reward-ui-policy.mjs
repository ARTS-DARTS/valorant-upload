import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitForRewards,
  rewardActionErrorMessage,
  rewardProgramAccepting,
} from '../reward-ui-policy.mjs';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rewardsPage = readFileSync(new URL('../rewards/index.html', import.meta.url), 'utf8');

test('reward category auto-selects when only one category is open', () => {
  assert.match(app, /openCategories\.length === 1\) rewardDemandCategory = openCategories\[0\]/);
  assert.match(app, /categoryChooser = openCategories\.length === 1 \? ''/);
});

test('public site uses the selected Segoe Interface typography', () => {
  assert.match(styles, /font-family:"Segoe UI Variable Text","Segoe UI",Roboto,Arial,sans-serif!important/);
  assert.match(styles, /small,html body label\{font-size:14px!important/);
  assert.match(styles, /reward-demand-map\.selected[^}]*background:#55e7ff!important/);
  assert.match(styles, /html body \.reward-demand-map\{[^}]*font-size:15px!important/);
  assert.match(styles, /html body \.reward-demand-map small\{[^}]*font-size:10px!important/);
});

test('both pending claims and reward history use a bounded seven-row scroller', () => {
  assert.match(app, /function sizeRewardLists\(host\)/);
  assert.match(app, /dataset\.visibleRewardRows = '7'/);
  assert.match(app, /getBoundingClientRect\(\)\.height/);
  assert.match(app, /list\.style\.maxHeight = 'none'/);
  assert.match(app, /window\.addEventListener\('resize',[\s\S]*?sizeRewardLists\(host\)/);
  assert.match(styles, /reward-list--held,\.reward-list--bounded\{max-height:469px;overflow-y:auto/);
  assert.match(html, /styles\.css\?v=2026-08-25-guild-v11/);
  assert.match(html, /workspace-redesign-fixes\.css\?v=2026-08-25-surgical-v2/);
  assert.match(html, /app\.js\?v=2026-08-25-guild-v11/);
});

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
  assert.match(rewardDialog, /Выбрать купон/);
  assert.match(rewardDialog, /activePayout/);
  assert.doesNotMatch(rewardDialog, /балл(?:ы|ов|а)?/i);
  assert.doesNotMatch(rewardsPage, /балл(?:ы|ов|а)?/i);
  assert.match(html, /7–12 VP/);
});

test('all configured reward coupons stay visible while unavailable ones are disabled', () => {
  assert.match(app, /settings\.denominations\|\|\[475,1000,1520,2050,2575,3650,5350,11000\]/);
  assert.match(app, /data-reward-denomination/);
  assert.match(app, /value<=availableVp/);
  assert.match(app, /VP будут заморожены/);
  assert.match(styles, /\.reward-coupon:disabled/);
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

test('author training card keeps its heading readable', () => {
  assert.match(styles, /reward-demand-ability strong/);
  const workspaceStyles = readFileSync(new URL('../workspace-redesign.css', import.meta.url), 'utf8');
  assert.match(workspaceStyles, /sidebar-training-head\{[^}]*font-size:11px/);
  assert.match(html, /workspace-redesign\.css\?v=2026-08-25-surgical-v2/);
});

test('profile level supporting text stays visually secondary', () => {
  const workspaceStyles = readFileSync(new URL('../workspace-redesign.css', import.meta.url), 'utf8');
  assert.match(workspaceStyles, /profile-level-progress-meta small\{font-size:11px!important/);
});

test('statistics expander uses one centered rotating chevron', () => {
  assert.match(styles, /stats-summary-chevron \{[^}]*border-radius:50%/);
  assert.match(styles, /stats-summary-chevron::before \{[^}]*border-right:2px solid/);
  assert.match(styles, /aria-expanded="true"\] \.stats-summary-chevron::before \{ transform:rotate\(225deg\)/);
  assert.doesNotMatch(styles, /stats-summary-chevron::before \{ content:"⌄"/);
});

test('reward demand starts with an open category and explains setup quotas', () => {
  assert.match(app, /Какая категория интересует\?/);
  assert.match(app, /content_categories/);
  assert.match(app, /data-demand-category/);
  assert.match(app, /Для каждого доступного агента на каждом сайте нужно 5 одобренных сетапов защиты/);
  assert.match(app, /Атака не учитывается/);
  assert.match(app, /row\.agent \|\| 'Агент'/);
  assert.match(app, /const normalizedMap = value/);
  assert.match(app, /mapMissing\(b\)-mapMissing\(a\)/);
  assert.match(app, /rewardDemandIcon\(row\.agent\)/);
  assert.match(app, /БЕЗ ДОП\. VP/);
});

test('legacy defense placeholders never render inside lineup demand', () => {
  assert.match(app, /function rewardDemandCategoryOf\(row\)/);
  assert.match(app, /ability \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'defense setup'/);
  assert.match(app, /belongsToCategory = row => rewardDemandCategoryOf\(row\) === rewardDemandCategory/);
});

test('lineup demand keeps A, B, C and Mid coverage visible after tasks close', () => {
  assert.match(app, /market_zone_coverage/);
  assert.match(app, /zoneCoverageForRow/);
  assert.match(app, /reward-demand-zones/);
  assert.match(app, /Покрытие плентов и мида/);
  assert.match(app, /ВСЕ ЗОНЫ ЕСТЬ/);
  assert.match(app, /ПОКРЫТИЕ ЗОН НЕ РАССЧИТАНО/);
  assert.match(app, /expectedZonesForMap=map=>\['a','b',[\s\S]*?\['c'\][\s\S]*?'mid'\]/);
  assert.match(styles, /\.reward-demand-zones/);
});

test('reward demand keeps primary labels larger than supporting text', () => {
  assert.match(styles, /reward-demand-stage>label[\s\S]*?font-size:12px/);
  assert.match(styles, /reward-demand-mode-note\{[^}]*font-size:10\.5px/);
  assert.match(styles, /reward-demand-ability strong\{[^}]*font-size:13\.5px/);
  assert.match(styles, /reward-demand-ability small\{[^}]*font-size:9px/);
});

test('component typography overrides the global small and label defaults', () => {
  assert.match(styles, /html body \.reward-demand-stage>label,[\s\S]*?font-size:12px!important/);
  assert.match(styles, /html body \.reward-demand-ability strong\{font-size:14px!important/);
  assert.match(styles, /html body \.reward-demand-ability small\{font-size:11px!important/);
  assert.match(styles, /html body \.production-help-copy strong\{font-size:16px!important/);
});

test('ability choices stay balanced instead of wrapping as three plus one', () => {
  const workspaceFixes = readFileSync(new URL('../workspace-redesign-fixes.css', import.meta.url), 'utf8');
  assert.match(workspaceFixes, /abilities-row \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(workspaceFixes, /@media \(max-width: 380px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(workspaceFixes, /abilities-row > \.ability-empty-hint,[\s\S]*?grid-column: 1 \/ -1/);
});

test('reward submission opt-in keeps its title larger than its explanation', () => {
  assert.match(styles, /html body \.reward-submit-optin b\{font-size:14px!important/);
  assert.match(styles, /html body \.reward-submit-optin small\{[^}]*font-size:11px!important/);
});

test('screenshot instructions keep required actions larger than explanations', () => {
  assert.match(html, /class="hint shot-requirement"/);
  assert.match(styles, /html body \.production-shot-help b\{font-size:12px!important/);
  assert.match(styles, /html body \.production-shot-help span\{font-size:11px!important/);
  assert.match(styles, /html body \.shot-requirement b\{[^}]*font-size:16px!important/);
  assert.match(styles, /html body \.shot-requirement span\{font-size:11px!important/);
});

test('author instruction card keeps its action larger than its description', () => {
  assert.match(styles, /html body \.production-help-copy strong\{font-size:16px!important/);
  assert.match(styles, /html body \.production-help-copy small\{font-size:11px!important/);
});

test('reward demand totals place labels above their numbers', () => {
  assert.match(app, /<small>Маппул<\/small><b>\$\{mapRows/);
  assert.match(app, /<small>Общее<\/small><b>\$\{globalRows/);
});

test('reward demand agent and map rails support horizontal mouse-wheel scrolling', () => {
  assert.match(app, /\.reward-demand-agents,\.reward-demand-maps/);
  assert.match(app, /rail\.scrollLeft=Math\.max\(0,Math\.min\(maxScroll,rail\.scrollLeft\+delta\)\)/);
  assert.match(app, /\{passive:false\}/);
});

test('Telegram community link is not duplicated in the author sidebar', () => {
  assert.doesNotMatch(html, /class="sidebar-telegram"/);
  assert.match(html, /class="header-telegram"/);
});
