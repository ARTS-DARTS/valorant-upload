export const ENTITLEMENT_SCHEMA_VERSION = 1;
const MAX_DATE_MILLIS = 8_640_000_000_000_000;

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
    return validTimestampMillis(millis);
  }
  if (value instanceof Date) return validTimestampMillis(value.getTime());
  if (typeof value === 'number') return validTimestampMillis(value);
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return validTimestampMillis(millis);
  }
  const seconds = Number(value?._seconds ?? value?.seconds);
  const nanoseconds = Number(value?._nanoseconds ?? value?.nanoseconds ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return 0;
  return validTimestampMillis(
    seconds * 1000 + Math.floor(nanoseconds / 1_000_000),
  );
}

function validTimestampMillis(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_DATE_MILLIS
    ? value
    : 0;
}

function isoOrNull(millis) {
  return millis > 0 ? new Date(millis).toISOString() : null;
}

export function capabilitiesForPlan(planId) {
  const normalized = Object.hasOwn(PLAN_CAPABILITIES, planId) ? planId : 'free';
  return { ...PLAN_CAPABILITIES[normalized] };
}

export function planTier(planId) {
  const normalized = cleanLower(planId);
  return Object.hasOwn(PLAN_ORDER, normalized) ? PLAN_ORDER[normalized] : 0;
}

function isCapabilityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeCapabilities(planId, rawCapabilities) {
  const maximum = PLAN_CAPABILITIES[planId];
  return Object.fromEntries(
    Object.entries(maximum).map(([key, maxValue]) => {
      const value = Object.hasOwn(rawCapabilities, key)
        ? rawCapabilities[key]
        : undefined;
      if (typeof maxValue === 'boolean') {
        return [key, maxValue && value === true];
      }
      return [key, maxValue === 2 && value === 2 ? 2 : 1];
    }),
  );
}

export function normalizeEntitlement(rawValue, { now = Date.now() } = {}) {
  const raw = rawValue && typeof rawValue === 'object' ? rawValue : {};
  const nowMillis = timestampMillis(now) || Date.now();
  const requestedPlan = cleanLower(raw.plan_id);
  const schemaVersion = raw.schema_version;
  const schemaValid =
    typeof schemaVersion === 'number' &&
    Number.isSafeInteger(schemaVersion) &&
    schemaVersion === ENTITLEMENT_SCHEMA_VERSION;
  const knownPlan = Object.hasOwn(PLAN_ORDER, requestedPlan) ? requestedPlan : 'free';
  const storedStatus = cleanLower(raw.status);
  const validFromMillis = timestampMillis(raw.valid_from);
  const accessUntilMillis = timestampMillis(raw.access_until);
  const graceUntilMillis = timestampMillis(raw.grace_until);
  const revokedAtMillis = timestampMillis(raw.revoked_at);
  const capabilitiesValid = isCapabilityMap(raw.capabilities);
  const graceUntilPresent =
    Object.hasOwn(raw, 'grace_until') &&
    raw.grace_until !== null &&
    raw.grace_until !== undefined;
  const graceUntilValid = !graceUntilPresent || graceUntilMillis > 0;
  const revokedAtPresent =
    Object.hasOwn(raw, 'revoked_at') &&
    raw.revoked_at !== null &&
    raw.revoked_at !== undefined;
  const revokedAtValid = !revokedAtPresent || revokedAtMillis > 0;
  const startsNow = validFromMillis > 0 && validFromMillis <= nowMillis;
  const notExplicitlyRevoked =
    revokedAtValid && (revokedAtMillis === 0 || revokedAtMillis > nowMillis);
  const hasPaidWindow = startsNow && accessUntilMillis > nowMillis;
  const hasGraceWindow =
    startsNow &&
    accessUntilMillis > validFromMillis &&
    accessUntilMillis <= nowMillis &&
    graceUntilMillis > accessUntilMillis &&
    graceUntilMillis > nowMillis;

  let active = false;
  let effectiveStatus = 'free';
  if (
    schemaValid &&
    knownPlan !== 'free' &&
    capabilitiesValid &&
    graceUntilValid &&
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
  const capabilities = active
    ? sanitizeCapabilities(planId, raw.capabilities)
    : capabilitiesForPlan('free');
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
    capabilities,
  };
}
