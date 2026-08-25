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

test('guild quests use the familiar agent, map and side demand-board flow', () => {
  assert.match(guild, /data-guild-filter-agent/);
  assert.match(guild, /data-guild-filter-map/);
  assert.match(guild, /1 · АГЕНТ · ПО ПРИОРИТЕТУ ЗАДАНИЙ/);
  assert.match(guild, /2 · КАРТА · ПРИОРИТЕТНЫЕ ПЕРВЫМИ/);
  assert.match(guild, /3 · СПОСОБНОСТЬ И НЕДОСТАЮЩИЕ ЗОНЫ/);
  assert.match(css, /\.guild-demand-side-columns/);
  assert.match(css, /\.guild-demand-task--claimed/);
  assert.match(css, /@media\(max-width:700px\).*\.guild-demand-task/s);
});

test('the former rewards card opens the Guild board while VP payout remains separate', () => {
  assert.match(html, /<small>ГИЛЬДИЯ<\/small><strong id="author-reward-balance">Открыть доску заданий<\/strong>/);
  assert.match(app, /author-reward-open'\)\?\.addEventListener\('click', \(\)=>switchWorkspaceTab\('guild'\)\)/);
  assert.match(app, /cabinet-vp-open'\)\?\.addEventListener\('click'.*setRewardModalOpen\(true\)/);
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
