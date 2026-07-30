import { createHash, timingSafeEqual } from 'node:crypto';

const HASH_ALGORITHMS = Object.freeze({
  md5: 'md5',
  sha1: 'sha1',
  sha256: 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
});

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw Object.assign(new Error(`missing_${name}`), { status: 503 });
  return result;
}

export function loadRobokassaConfig(env = process.env) {
  const algorithmName = String(env.ROBOKASSA_HASH_ALGORITHM ?? '').trim().toLowerCase();
  const algorithm = HASH_ALGORITHMS[algorithmName];
  const invoiceStart = Number(env.ROBOKASSA_INVOICE_START);
  if (!algorithm || !Number.isSafeInteger(invoiceStart) || invoiceStart < 1) {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  return Object.freeze({
    merchantLogin: required(env.ROBOKASSA_MERCHANT_LOGIN, 'merchant_login'),
    password1: required(env.ROBOKASSA_PASSWORD_1, 'password_1'),
    password2: required(env.ROBOKASSA_PASSWORD_2, 'password_2'),
    algorithm,
    invoiceStart,
    testMode: String(env.ROBOKASSA_TEST_MODE).trim().toLowerCase() === 'true',
  });
}

export function amountMinorToOutSum(amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new Error('invalid_amount');
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`;
}

export function outSumToAmountMinor(value) {
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/.exec(String(value ?? '').trim());
  if (!match) throw Object.assign(new Error('invalid_amount'), { status: 400 });
  const fraction = (match[2] ?? '').padEnd(6, '0');
  if (fraction.slice(2) !== '0000') throw Object.assign(new Error('invalid_amount'), { status: 400 });
  const result = Number(match[1]) * 100 + Number(fraction.slice(0, 2));
  if (!Number.isSafeInteger(result) || result < 1) throw Object.assign(new Error('invalid_amount'), { status: 400 });
  return result;
}

export function digest(value, algorithm) {
  return createHash(algorithm).update(value, 'utf8').digest('hex');
}

function shpSuffix(shp = {}) {
  return Object.keys(shp)
    .filter(key => /^Shp_[A-Za-z0-9_]{1,40}$/.test(key))
    .sort()
    .map(key => `:${key}=${String(shp[key])}`)
    .join('');
}

export function buildRobokassaCheckout({ config, plan, invoiceId }) {
  const outSum = amountMinorToOutSum(plan.amount_minor);
  const receipt = JSON.stringify({
    items: [{
      name: plan.receipt_name,
      quantity: 1,
      sum: plan.amount_minor / 100,
      payment_method: 'full_payment',
      payment_object: 'service',
      tax: plan.tax,
    }],
  });
  const encodedReceipt = encodeURIComponent(receipt);
  const shp = { Shp_order: String(invoiceId) };
  const signatureBase = `${config.merchantLogin}:${outSum}:${invoiceId}:${encodedReceipt}:${config.password1}${shpSuffix(shp)}`;
  const params = new URLSearchParams({
    MerchantLogin: config.merchantLogin,
    OutSum: outSum,
    InvId: String(invoiceId),
    Description: plan.receipt_name.slice(0, 100),
    SignatureValue: digest(signatureBase, config.algorithm),
    Culture: 'ru',
    Encoding: 'utf-8',
    Receipt: encodedReceipt,
    ...shp,
  });
  if (config.testMode) params.set('IsTest', '1');
  return {
    checkout_url: `https://auth.robokassa.ru/Merchant/Index.aspx?${params}`,
    out_sum: outSum,
    receipt,
  };
}

export function verifyRobokassaResult({ config, payload }) {
  const outSum = String(payload.OutSum ?? '').trim();
  const invoiceId = String(payload.InvId ?? payload.InvID ?? '').trim();
  const supplied = String(payload.SignatureValue ?? '').trim().toLowerCase();
  if (!/^\d{1,19}$/.test(invoiceId) || !/^[a-f0-9]{16,128}$/.test(supplied)) {
    return null;
  }
  const shp = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key.startsWith('Shp_')),
  );
  const expected = digest(`${outSum}:${invoiceId}:${config.password2}${shpSuffix(shp)}`, config.algorithm);
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return {
    invoice_id: invoiceId,
    amount_minor: outSumToAmountMinor(outSum),
    out_sum: outSum,
    shp,
  };
}
