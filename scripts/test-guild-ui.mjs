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

test('public profiles expose only positive Guild achievements', () => {
  assert.match(social, /publicProfile\.guild_member === true/);
  assert.match(social, /guild_completed_quests/);
  assert.match(social, /guild_best_completion_streak/);
  assert.doesNotMatch(social, /guild_(?:abandoned|expired|penalty|available_vp)/);
});
