import { capabilitiesForPlan } from './entitlements.js';

const PLAN_IDS = Object.freeze(['ad_free', 'plus', 'sponsor']);
const TERM_MONTHS = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 1));
const TAX_VALUES = new Set([
  'none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22',
  'vat105', 'vat107', 'vat110', 'vat120', 'vat122',
]);

function text(value, maxLength) {
  const result = String(value ?? '').trim();
  return result && result.length <= maxLength ? result : '';
}

function billingUnavailable() {
  return Object.assign(new Error('billing_not_configured'), { status: 503 });
}

function parseDiscounts(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    throw billingUnavailable();
  }
  const discounts = {};
  let previous = -1;
  for (const months of TERM_MONTHS) {
    const discount = Number(rawValue[String(months)]);
    if (
      !Number.isSafeInteger(discount) ||
      discount < 0 ||
      discount > 5_000 ||
      discount < previous ||
      (months === 1 && discount !== 0)
    ) {
      throw billingUnavailable();
    }
    discounts[months] = discount;
    previous = discount;
  }
  return Object.freeze(discounts);
}

function discountedAmount(monthlyAmountMinor, months, discountBps) {
  const undiscounted = monthlyAmountMinor * months;
  const amount = Math.round(undiscounted * (10_000 - discountBps) / 10_000);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1_200_000_000) {
    throw billingUnavailable();
  }
  return amount;
}

export function parseBillingCatalog(rawValue) {
  let raw;
  try {
    raw = JSON.parse(String(rawValue ?? ''));
  } catch {
    throw billingUnavailable();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw billingUnavailable();
  }
  const termsVersion = text(raw.terms_version, 40);
  const catalogVersion = text(raw.catalog_version, 40);
  if (!termsVersion || !catalogVersion || raw.period !== 'P30D') {
    throw billingUnavailable();
  }
  const termDiscountsBps = parseDiscounts(raw.term_discounts_bps);
  const introOffer = raw.intro_offer;
  const introDiscountBps = Number(introOffer?.discount_bps);
  const introMonths = Number(introOffer?.months);
  if (
    !introOffer ||
    introOffer.active !== true ||
    introMonths !== 1 ||
    !Number.isSafeInteger(introDiscountBps) ||
    introDiscountBps !== 3_000
  ) {
    throw billingUnavailable();
  }
  const plans = {};
  for (const planId of PLAN_IDS) {
    const plan = raw.plans?.[planId];
    if (!plan || plan.active !== true) continue;
    const displayName = text(plan.display_name, 60);
    const receiptName = text(plan.receipt_name, 128);
    const monthlyAmountMinor = Number(plan.monthly_amount_minor);
    const tax = text(plan.tax, 16);
    if (
      !displayName || !receiptName ||
      !Number.isSafeInteger(monthlyAmountMinor) ||
      monthlyAmountMinor < 100 ||
      monthlyAmountMinor > 100_000_000 ||
      !TAX_VALUES.has(tax)
    ) {
      throw billingUnavailable();
    }
    const offers = TERM_MONTHS.map(months => {
      const discountBps = termDiscountsBps[months];
      const periodDays = months * 30;
      return Object.freeze({
        months,
        period: `P${periodDays}D`,
        period_days: periodDays,
        standard_amount_minor: monthlyAmountMinor * months,
        amount_minor: discountedAmount(monthlyAmountMinor, months, discountBps),
        discount_bps: discountBps,
      });
    });
    plans[planId] = Object.freeze({
      plan_id: planId,
      display_name: displayName,
      receipt_name: receiptName,
      monthly_amount_minor: monthlyAmountMinor,
      amount_minor: monthlyAmountMinor,
      currency: 'RUB',
      period: 'P30D',
      period_days: 30,
      tax,
      offers: Object.freeze(offers),
      intro_amount_minor: discountedAmount(monthlyAmountMinor, 1, introDiscountBps),
      capabilities: capabilitiesForPlan(planId),
    });
  }
  if (!Object.keys(plans).length) {
    throw billingUnavailable();
  }
  return Object.freeze({
    terms_version: termsVersion,
    catalog_version: catalogVersion,
    period: 'P30D',
    term_discounts_bps: termDiscountsBps,
    intro_offer: Object.freeze({
      active: true,
      months: introMonths,
      discount_bps: introDiscountBps,
    }),
    plans: Object.freeze(plans),
  });
}

export function publicBillingCatalog(catalog) {
  return {
    terms_version: catalog.terms_version,
    catalog_version: catalog.catalog_version,
    period: catalog.period,
    currency: 'RUB',
    term_discounts_bps: catalog.term_discounts_bps,
    intro_offer: catalog.intro_offer,
    plans: Object.values(catalog.plans).map(plan => ({
      plan_id: plan.plan_id,
      display_name: plan.display_name,
      monthly_amount_minor: plan.monthly_amount_minor,
      amount_minor: plan.amount_minor,
      intro_amount_minor: plan.intro_amount_minor,
      currency: plan.currency,
      period: plan.period,
      offers: plan.offers,
    })),
  };
}

export function loadBillingCatalog(env = process.env) {
  return parseBillingCatalog(env.BILLING_PLAN_CATALOG_JSON);
}
