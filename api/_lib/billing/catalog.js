import { capabilitiesForPlan } from './entitlements.js';

const PLAN_IDS = Object.freeze(['ad_free', 'plus', 'sponsor']);
const TAX_VALUES = new Set([
  'none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22',
  'vat105', 'vat107', 'vat110', 'vat120', 'vat122',
]);

function text(value, maxLength) {
  const result = String(value ?? '').trim();
  return result && result.length <= maxLength ? result : '';
}

export function parseBillingCatalog(rawValue) {
  let raw;
  try {
    raw = JSON.parse(String(rawValue ?? ''));
  } catch {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  const termsVersion = text(raw.terms_version, 40);
  const catalogVersion = text(raw.catalog_version, 40);
  if (!termsVersion || !catalogVersion || raw.period !== 'P30D') {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  const plans = {};
  for (const planId of PLAN_IDS) {
    const plan = raw.plans?.[planId];
    if (!plan || plan.active !== true) continue;
    const displayName = text(plan.display_name, 60);
    const receiptName = text(plan.receipt_name, 128);
    const amountMinor = Number(plan.amount_minor);
    const tax = text(plan.tax, 16);
    if (
      !displayName || !receiptName ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > 100_000_000 ||
      !TAX_VALUES.has(tax)
    ) {
      throw Object.assign(new Error('billing_not_configured'), { status: 503 });
    }
    plans[planId] = Object.freeze({
      plan_id: planId,
      display_name: displayName,
      receipt_name: receiptName,
      amount_minor: amountMinor,
      currency: 'RUB',
      period: 'P30D',
      period_days: 30,
      tax,
      capabilities: capabilitiesForPlan(planId),
    });
  }
  if (!Object.keys(plans).length) {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  return Object.freeze({
    terms_version: termsVersion,
    catalog_version: catalogVersion,
    period: 'P30D',
    plans: Object.freeze(plans),
  });
}

export function publicBillingCatalog(catalog) {
  return {
    terms_version: catalog.terms_version,
    catalog_version: catalog.catalog_version,
    period: catalog.period,
    currency: 'RUB',
    plans: Object.values(catalog.plans).map(plan => ({
      plan_id: plan.plan_id,
      display_name: plan.display_name,
      amount_minor: plan.amount_minor,
      currency: plan.currency,
      period: plan.period,
    })),
  };
}

export function loadBillingCatalog(env = process.env) {
  return parseBillingCatalog(env.BILLING_PLAN_CATALOG_JSON);
}
