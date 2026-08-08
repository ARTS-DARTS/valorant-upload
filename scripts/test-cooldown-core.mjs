import assert from 'node:assert/strict';
import test from 'node:test';
import { cooldownMinutesForPoints, effectiveProgressPoints, entitlementHasCooldownBypass, remainingCooldownMs } from '../cooldown-core.mjs';

test('rank points use the strongest synchronized counter plus bonus', () => {
  assert.equal(effectiveProgressPoints({ publicProfile:{ approved_lineups:3, bonus_lineups:2 }, stats:{ approved_lineups:15, bonus_points:5 }, factualApproved:7 }), 20);
  assert.equal(cooldownMinutesForPoints(20), 15);
});

test('active and grace sponsor entitlement bypass cooldown but expired access does not', () => {
  const base={ schema_version:1, plan_id:'sponsor', valid_from:'2026-08-01T00:00:00Z', capabilities:{ lineup_cooldown_bypass:true } };
  assert.equal(entitlementHasCooldownBypass({ ...base, status:'active', access_until:'2026-09-01T00:00:00Z' }, '2026-08-08T00:00:00Z'), true);
  assert.equal(entitlementHasCooldownBypass({ ...base, status:'grace', access_until:'2026-08-07T00:00:00Z', grace_until:'2026-08-10T00:00:00Z' }, '2026-08-08T00:00:00Z'), true);
  assert.equal(entitlementHasCooldownBypass({ ...base, status:'active', access_until:'2026-08-07T00:00:00Z' }, '2026-08-08T00:00:00Z'), false);
});

test('future timestamp cannot display more than the configured tier', () => {
  const now=Date.parse('2026-08-08T00:00:00Z');
  assert.equal(remainingCooldownMs({ lastSubmittedAt:new Date(now+2*3600_000), cooldownMinutes:60, now }), 3600_000);
});
