export const COOLDOWN_LEVELS = Object.freeze([
  Object.freeze({ min: 0, cooldownMinutes: 60 }),
  Object.freeze({ min: 3, cooldownMinutes: 45 }),
  Object.freeze({ min: 7, cooldownMinutes: 30 }),
  Object.freeze({ min: 15, cooldownMinutes: 15 }),
  Object.freeze({ min: 30, cooldownMinutes: 5 }),
  Object.freeze({ min: 50, cooldownMinutes: 2 }),
  Object.freeze({ min: 100, cooldownMinutes: 0 }),
]);

const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const millis = value => {
  if (typeof value?.toMillis === 'function') return number(value.toMillis());
  if (value instanceof Date) return number(value.getTime());
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export function effectiveProgressPoints({ publicProfile = {}, stats = {}, factualApproved = 0 } = {}) {
  const approved = Math.max(
    number(factualApproved), number(publicProfile.approved_lineups), number(publicProfile.approved_lineups_count),
    number(stats.approved_lineups), number(stats.approved_lineups_count),
  );
  const bonus = Math.max(
    number(publicProfile.bonus_lineups), number(stats.bonus_lineups), number(stats.bonus_points),
  );
  return approved + bonus;
}

export function cooldownMinutesForPoints(points) {
  return COOLDOWN_LEVELS.reduce((value, level) => number(points) >= level.min ? level.cooldownMinutes : value, 60);
}

export function entitlementHasCooldownBypass(raw = {}, now = Date.now()) {
  const nowMs = millis(now) || Date.now();
  const status = String(raw.status || '').trim().toLowerCase();
  const activeWindow = ['active', 'comped'].includes(status) && millis(raw.valid_from) <= nowMs && millis(raw.access_until) > nowMs;
  const graceWindow = ['grace', 'past_due'].includes(status) && millis(raw.valid_from) <= nowMs && millis(raw.grace_until) > nowMs;
  return raw.schema_version === 1
    && String(raw.plan_id || '').trim().toLowerCase() === 'sponsor'
    && raw.capabilities?.lineup_cooldown_bypass === true
    && (activeWindow || graceWindow)
    && (!raw.revoked_at || millis(raw.revoked_at) > nowMs);
}

export function remainingCooldownMs({ lastSubmittedAt, cooldownMinutes, now = Date.now() } = {}) {
  const cooldownMs = number(cooldownMinutes) * 60_000;
  const lastMs = millis(lastSubmittedAt);
  if (!cooldownMs || !lastMs) return 0;
  return Math.max(0, Math.min(cooldownMs, lastMs + cooldownMs - millis(now)));
}
