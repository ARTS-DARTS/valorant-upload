export const ENTITLEMENT_SCHEMA_VERSION = 1;

const PLAN_ORDER = Object.freeze({
  free: 0,
  ad_free: 1,
  plus: 2,
  sponsor: 3,
});

const FREE_CAPABILITIES = Object.freeze({
  ads_disabled: false,
  rewarded_unlock_bypass: false,
  plus_tools: false,
  lineup_cooldown_bypass: false,
  lineup_like_weight: 1,
  lineup_relevance_weight: 1,
  poll_vote_weight: 1,
  duel_vote_weight: 1,
  subscriber_badge_eligible: false,
  sponsor_badge_eligible: false,
});

const PLAN_CAPABILITIES = Object.freeze({
  free: FREE_CAPABILITIES,
  ad_free: Object.freeze({
    ...FREE_CAPABILITIES,
    ads_disabled: true,
    rewarded_unlock_bypass: true,
    subscriber_badge_eligible: true,
  }),
  plus: Object.freeze({
    ...FREE_CAPABILITIES,
    ads_disabled: true,
    rewarded_unlock_bypass: true,
    plus_tools: true,
    subscriber_badge_eligible: true,
  }),
  sponsor: Object.freeze({
    ...FREE_CAPABILITIES,
    ads_disabled: true,
    rewarded_unlock_bypass: true,
    plus_tools: true,
    lineup_cooldown_bypass: true,
    lineup_like_weight: 2,
    lineup_relevance_weight: 2,
    poll_vote_weight: 2,
    duel_vote_weight: 2,
    subscriber_badge_eligible: true,
    sponsor_badge_eligible: true,
  }),
});

const ACTIVE_STATUSES = new Set(['active', 'comped']);
const GRACE_STATUSES = new Set(['grace', 'past_due']);
const REVOKED_STATUSES = new Set(['revoked', 'refunded', 'chargeback']);

function cleanLower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function timestampMillis(value) {
  if (value == null) return 0;
  if (typeof value?.toMillis === 'function') {
    const millis = Number(value.toMillis());
    return Number.isFinite(millis) ? millis : 0;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : 0;
  }
  const seconds = Number(value?._seconds ?? value?.seconds);
  const nanoseconds = Number(value?._nanoseconds ?? value?.nanoseconds ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return 0;
  return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
}

function isoOrNull(millis) {
  return millis > 0 ? new Date(millis).toISOString() : null;
}

export function capabilitiesForPlan(planId) {
  const normalized = Object.hasOwn(PLAN_CAPABILITIES, planId) ? planId : 'free';
  return { ...PLAN_CAPABILITIES[normalized] };
}

export function normalizeEntitlement(rawValue, { now = Date.now() } = {}) {
  const raw = rawValue && typeof rawValue === 'object' ? rawValue : {};
  const nowMillis = timestampMillis(now) || Date.now();
  const requestedPlan = cleanLower(raw.plan_id);
  const knownPlan = Object.hasOwn(PLAN_ORDER, requestedPlan) ? requestedPlan : 'free';
  const storedStatus = cleanLower(raw.status);
  const validFromMillis = timestampMillis(raw.valid_from);
  const accessUntilMillis = timestampMillis(raw.access_until);
  const graceUntilMillis = timestampMillis(raw.grace_until);
  const revokedAtMillis = timestampMillis(raw.revoked_at);
  const startsNow = validFromMillis === 0 || validFromMillis <= nowMillis;
  const notExplicitlyRevoked = revokedAtMillis === 0 || revokedAtMillis > nowMillis;
  const hasPaidWindow = startsNow && accessUntilMillis > nowMillis;
  const hasGraceWindow = startsNow && graceUntilMillis > nowMillis;

  let active = false;
  let effectiveStatus = 'free';
  if (
    knownPlan !== 'free' &&
    notExplicitlyRevoked &&
    !REVOKED_STATUSES.has(storedStatus)
  ) {
    if (ACTIVE_STATUSES.has(storedStatus) && hasPaidWindow) {
      active = true;
      effectiveStatus = storedStatus;
    } else if (GRACE_STATUSES.has(storedStatus) && hasGraceWindow) {
      active = true;
      effectiveStatus = 'grace';
    } else if (storedStatus === 'active' || storedStatus === 'comped' || storedStatus === 'expired') {
      effectiveStatus = 'expired';
    }
  } else if (REVOKED_STATUSES.has(storedStatus) || !notExplicitlyRevoked) {
    effectiveStatus = 'revoked';
  }

  const planId = active ? knownPlan : 'free';
  const entitlementVersion = Number(raw.entitlement_version);
  return {
    schema_version: ENTITLEMENT_SCHEMA_VERSION,
    plan_id: planId,
    tier: PLAN_ORDER[planId],
    status: effectiveStatus,
    active,
    valid_from: isoOrNull(validFromMillis),
    access_until: isoOrNull(accessUntilMillis),
    grace_until: isoOrNull(graceUntilMillis),
    cancel_at_period_end: active && raw.cancel_at_period_end === true,
    entitlement_version:
      Number.isSafeInteger(entitlementVersion) && entitlementVersion >= 0
        ? entitlementVersion
        : 0,
    capabilities: capabilitiesForPlan(planId),
  };
}
