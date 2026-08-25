import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, app, css, guild, social] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../guild-ui.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../social-communication.mjs', import.meta.url), 'utf8'),
]);

test('guild is a dedicated author workspace with responsive quest board', () => {
  assert.match(html, /data-workspace-tab="guild"/);
  assert.match(html, /id="workspace-guild"/);
  assert.match(html, /id="guild-workspace"/);
  assert.match(css, /\.guild-quest-grid/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /guild-quest--claimed/);
  assert.match(guild, /fulfilled">Пирожки \/ награда выдана/);
  assert.match(css, /guild-legend \.fulfilled::before/);
});

test('Guild status labels sit to the left of the algorithm board', () => {
  assert.match(guild, /guild-section-head guild-section-head--board/);
  assert.match(guild, /guild-quests-layout[\s\S]*guild-legend[\s\S]*guild-quests/);
  assert.match(css, /guild-quests-layout\{display:grid;grid-template-columns:210px minmax\(0,920px\)/);
});

test('guild quests use the familiar agent, map and side demand-board flow', () => {
  assert.match(guild, /data-guild-filter-agent/);
  assert.match(guild, /data-guild-filter-map/);
  assert.match(guild, /1 · АГЕНТ · ПО ПРИОРИТЕТУ И ПОДПИСКАМ/);
  assert.match(guild, /2 · ВЕСЬ АКТИВНЫЙ МАППУЛ · ПРИОРИТЕТНЫЕ КАРТЫ ПЕРВЫМИ/);
  assert.match(guild, /3 · СПОСОБНОСТЬ И НЕДОСТАЮЩИЕ ЗОНЫ/);
  assert.match(guild, /market_zone_coverage/);
  assert.match(guild, /data-guild-action="take-demand"/);
  assert.match(guild, /ensureGuildDemandQuest/);
  assert.match(guild, /guildKey\(row\.category \|\| row\.content_type \|\| 'lineup'\) === 'lineup'/);
  assert.match(css, /\.guild-demand-side-columns/);
  assert.match(css, /\.guild-demand-ability\.claimed/);
  assert.match(css, /@media\(max-width:700px\).*\.guild-demand-ability/s);
});

test('Guild demand selection is explicit, stable and case-insensitive', () => {
  assert.match(guild, /function guildUniqueLabels\(values\)/);
  assert.match(guild, /const key = guildKey\(label\)/);
  assert.match(guild, /data-guild-select-zone/);
  assert.match(guild, /disabled>Выбери плент<\/button>/);
  assert.match(guild, /confirmAction\(\{[\s\S]*?title:`Взять задание на плент \$\{plant\}\?/);
  assert.match(guild, /function demandScrollState\(\)/);
  assert.match(guild, /restoreDemandScroll\(scrollState\)/);
});

test('Guild loading, assignment actions and rewards UI are separated safely', () => {
  assert.match(guild, /if \(loading && loadPromise\) return loadPromise/);
  assert.match(guild, /modal\.className = 'guild-confirm'/);
  assert.doesNotMatch(guild, /confirm\(`Взять задание/);
  assert.match(guild, /guild-button--abandon/);
  assert.match(guild, /guild-demand-rewards/);
  assert.match(guild, /globalDeficitCount/);
  assert.match(app, /function renderRewardDemand\(deficits\) \{\s*return '';/);
  assert.match(app, /ДЕЙСТВИЯ С ЗАДАНИЕМ ГИЛЬДИИ/);
  assert.match(app, /switchWorkspaceTab\('guild'\)/);
});

test('Guild guide uses an isolated fake assignment and closes it safely', () => {
  assert.match(guild, /function trainingPanel\(\)/);
  assert.match(guild, /VP и слот не затрагиваются/);
  assert.match(guild, /startTraining\(\)/);
  assert.match(guild, /stopTraining\(\)/);
  assert.match(app, /guildWebsite\.stopTraining\?\.\(\)/);
  assert.match(app, /trainingStage:'taken'/);
  assert.match(app, /trainingStage:'canceled'/);
  assert.match(css, /\.guild-training/);
});

test('the former rewards card opens the Guild board while VP payout remains separate', () => {
  assert.match(html, /<small>ГИЛЬДИЯ<\/small><strong id="author-reward-balance">Открыть доску заданий<\/strong>/);
  assert.match(app, /author-reward-open'\)\?\.addEventListener\('click', \(\)=>switchWorkspaceTab\('guild'\)\)/);
  assert.match(app, /cabinet-vp-open'\)\?\.addEventListener\('click', openRewardExchange\)/);
  assert.match(app, /openVpExchange:openRewardExchange/);
  assert.match(guild, /data-guild-action="exchange">Обменять<\/button>/);
  assert.match(guild, /if \(action === 'exchange'\) return openVpExchange\(\)/);
});

test('Guild release has a one-time introduction and a replayable contextual tour', () => {
  assert.match(html, /id="guild-update-intro"/);
  assert.match(html, /id="guild-tour"/);
  assert.match(app, /const GUILD_UPDATE_INTRO_VERSION/);
  assert.match(app, /function showGuildUpdateIntro\(uid\)/);
  assert.match(app, /query\.get\('assignment'\).*query\.get\('lineup'\).*activeWorkspaceTab === 'moderation'/s);
  assert.match(app, /function guildTourDefinitions\(\)/);
  assert.match(app, /async function startGuildTour\(\)/);
  assert.match(app, /showGuildUpdateIntro\(user\.uid\)/);
  assert.match(app, /guildIntro && !guildIntro\.hidden/);
  assert.match(guild, /data-guild-action="tour">Как это работает\?<\/button>/);
  assert.match(guild, /data-guild-action="tour">Короткая экскурсия<\/button>/);
  assert.match(guild, /if \(action === 'tour'\) return startTour\(\)/);
  assert.match(css, /\.guild-tour-focus\{[^}]*box-shadow:0 0 0 9999px/);
  assert.match(css, /@media\(max-width:700px\).*\.guild-tour-card/s);
});

test('Guild tour fades the current step out before revealing the next one', () => {
  assert.match(app, /async function changeGuildTourStep\(nextIndex\)/);
  assert.match(app, /tour\.classList\.add\('is-switching'\)[\s\S]*renderGuildTourStep\(\)[\s\S]*tour\.classList\.remove\('is-switching'\)/);
  assert.match(css, /\.guild-tour\.is-switching \.guild-tour-card\{opacity:0/);
  assert.match(css, /prefers-reduced-motion:reduce[^\n]*\.guild-tour-card\{transition:none/);
});

test('reward-program history is visibly distinguished from new Guild work', () => {
  assert.match(guild, /imported_from_reward_program/);
  assert.match(guild, /ПЕРЕНЕСЕНО ИЗ АКЦИИ VP/);
  assert.match(guild, /Ранее выдано/);
  assert.match(css, /\.guild-assignment-row--imported/);
});

test('Guild history avoids duplicate final status and scrolls after seven rows', () => {
  assert.match(guild, /const resultNote = imported/);
  assert.doesNotMatch(guild, /deadline \? remainingLabel\(deadline\) : statusCopy\(item\.status\)/);
  assert.match(guild, /function sizeGuildHistory\(host\)/);
  assert.match(guild, /data-visible-guild-history-rows="7"/);
  assert.match(guild, /list\.style\.maxHeight = 'none'/);
  assert.match(guild, /sizeGuildHistory\(host\)/);
  assert.doesNotMatch(guild, /filter\(item => !active\.includes\(item\)\)\.slice/);
  assert.match(css, /\.guild-assignment-list--history\{max-height:594px;overflow-y:auto/);
});

test('guild dashboard keeps separate XP, slots, labels and Pirozhki state', () => {
  assert.match(guild, /Guild XP/);
  assert.match(guild, /СЛОТЫ ЗАДАНИЙ/);
  assert.match(guild, /В «Пирожках»/);
  assert.match(guild, /Активный бонус/);
  assert.match(guild, /Взято авантюристом/);
  assert.match(guild, /function rankLabel/);
  assert.match(guild, /best_completion_streak_days/);
});

test('guild submission is linked to one server assignment and cannot join normal rewards', () => {
  assert.match(app, /doc\(db, 'lineups', guildDraftLineupId\)/);
  assert.match(app, /guild_assignment_id:guildAssignmentId/);
  assert.match(app, /reward_program_opt_in:\s*guildAssignmentId \? false/);
  assert.match(app, /const active = canSubmitForRewards\(rewardDashboard\) && !guildAssignmentId/);
});

test('saving a Guild assignment draft resets the upload form to an ordinary lineup', () => {
  const branch = app.match(/if \(guildAssignmentId\) \{\s*_saveDraft\(\);[\s\S]*?\n\s*return;\s*\}/)?.[0] || '';
  assert.match(branch, /resetUploadForm\(\)/);
  assert.doesNotMatch(branch, /switchWorkspaceTab\('guild'\)/);
  assert.match(branch, /try \{ renderDrafts\(\); \}/);
  assert.ok(
    branch.indexOf('resetUploadForm()') < branch.indexOf('renderDrafts()'),
    'the Guild context must be cleared before refreshing draft cards',
  );
});

test('missing plant cells are gold and the selected plant overrides them in cyan', () => {
  assert.match(css, /\.reward-demand-zones \.missing\{border-color:#b77b18/);
  const missingRule = css.indexOf('.reward-demand-zones .missing{');
  const selectedRule = css.indexOf('.reward-demand-zones button.selected{', missingRule);
  assert.ok(missingRule >= 0 && selectedRule > missingRule, 'selected cyan rule must override the gold missing-zone rule');
});

test('covered plant cells remain selectable and reduce the displayed VP reward', () => {
  assert.match(guild, /const zoneStates = zones\.map\(\(\[zone, count\]\) => \(\{ zone, count,/);
  assert.match(guild, /if \(state === 'claimed'\) return/);
  assert.match(guild, /const rewardVp = coverage === 0 \? base : Math\.min\(base, 7\)/);
  assert.match(guild, /const bonusVp = coverage === 0 \? bonus : 0/);
  assert.match(css, /\.reward-demand-zones button\.filled:hover/);
});

test('Guild demand cards keep readable text and ability icons on desktop and mobile', () => {
  assert.match(css, /\.guild-demand-ability\{[^}]*grid-template-columns:38px 38px/);
  assert.match(css, /\.guild-demand-ability-icon img\{width:31px;height:31px\}/);
  assert.match(css, /\.guild-demand-copy strong\{[^}]*font-size:16px/);
  assert.match(css, /@media\(max-width:700px\)[^\n]*\.guild-demand-ability\{grid-template-columns:34px 34px/);
});

test('available Guild task frames are gold and their particle snakes share one page-clock phase', () => {
  assert.match(css, /\.guild-demand-ability\{[^}]*--guild-frame-color:#b77b18[^}]*position:relative[^}]*border-color:var\(--guild-frame-color\)/);
  assert.match(css, /@keyframes guild-border-particle\{to\{offset-distance:100%\}\}/);
  assert.match(guild, /class="guild-border-snake"[^>]*>(?:<i[^>]*><\/i>){8}<\/span>/);
  assert.doesNotMatch(guild, /--snake-lag:-/);
  assert.match(css, /\.guild-border-snake i\{[^}]*animation-delay:calc\(var\(--guild-particle-delay,0s\) \+ var\(--snake-lag,0s\)\)/);
  assert.match(css, /\.guild-border-snake i:nth-child\(8\)\{[^}]*opacity:\.18/);
  assert.match(guild, /const GUILD_PARTICLE_CYCLE_MS = 6000/);
  assert.match(guild, /performance\.now\(\) % GUILD_PARTICLE_CYCLE_MS/);
  assert.match(guild, /syncGuildDemandParticles\(host\)/);
  assert.match(css, /\.guild-demand-ability\.selected\{--guild-frame-color:#55e7ff/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\).*\.guild-border-snake/s);
});

test('guild assignment enforces the mandatory template fields before submission', () => {
  assert.match(app, /guildAssignmentSnapshot\?\.requirements/);
  assert.match(app, /Загрузи обязательное видео для задания Гильдии/);
  assert.match(app, /Заполни обязательное описание задания/);
  assert.match(app, /Нарисуй обязательную траекторию задания/);
});

test('resetting a guild draft retains the assignment and locked snapshot', () => {
  assert.match(app, /if \(guildAssignmentId\) \{/);
  assert.match(app, /Само задание и закреплённые поля останутся на месте/);
  assert.match(app, /guildAssignmentSnapshot,/);
  assert.match(app, /Задание и его заготовка сохранены/);
});

test('mobile app deep link opens the exact active guild assignment', () => {
  assert.match(app, /query\.get\('assignment'\)/);
  assert.match(app, /guildWebsite\.openAssignment\(guildDeepLink\.assignmentId\)/);
  assert.match(guild, /async openAssignment\(assignmentId\)/);
  assert.match(guild, /\['active', 'revision_required'\]\.includes\(assignment\.status\)/);
  assert.match(guild, /recordGuildQuestOpened/);
});

test('an adventurer can appeal an applied penalty from Guild history', () => {
  assert.match(guild, /data-guild-action="appeal"/);
  assert.match(guild, /createGuildPenaltyAppeal/);
  assert.match(guild, /appealReason\.length < 10/);
});

test('server-side return or expiry preserves the linked local draft and tells the user where it is', () => {
  assert.match(guild, /function preserveReturnedDrafts/);
  assert.match(guild, /\['abandoned', 'expired', 'revision_failed', 'canceled'\]/);
  assert.match(guild, /Кабинет автора → Черновики/);
  assert.match(app, /return saved;/);
});

test('public profiles expose only positive Guild achievements', () => {
  assert.match(social, /publicProfile\.guild_member === true/);
  assert.match(social, /guild_completed_quests/);
  assert.match(social, /guild_best_completion_streak/);
  assert.doesNotMatch(social, /guild_(?:abandoned|expired|penalty|available_vp)/);
});
