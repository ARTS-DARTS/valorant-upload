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

export function buildRobokassaCheckout({ config, plan, invoiceId, expiresAt = null }) {
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
  if (expiresAt instanceof Date && Number.isFinite(expiresAt.getTime())) {
    params.set('ExpirationDate', expiresAt.toISOString().slice(0, 16));
  }
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

function decodeXmlText(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim();
}

function xmlTag(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return match ? decodeXmlText(match[1].replace(/<[^>]*>/g, '')) : '';
}

export function buildRobokassaOpStateUrl({ config, invoiceId }) {
  const normalizedInvoiceId = String(invoiceId ?? '').trim();
  if (!/^\d{1,19}$/.test(normalizedInvoiceId)) {
    throw Object.assign(new Error('invalid_invoice_id'), { status: 400 });
  }
  const signature = digest(
    `${config.merchantLogin}:${normalizedInvoiceId}:${config.password2}`,
    config.algorithm,
  );
  const params = new URLSearchParams({
    MerchantLogin: config.merchantLogin,
    InvoiceID: normalizedInvoiceId,
    Signature: signature,
  });
  return `https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt?${params}`;
}

export function parseRobokassaOpStateXml(xmlValue) {
  const xml = String(xmlValue ?? '');
  if (!xml || xml.length > 256 * 1024) {
    throw Object.assign(new Error('invalid_provider_response'), { status: 502 });
  }
  const resultBlock = /<Result(?:\s[^>]*)?>([\s\S]*?)<\/Result>/i.exec(xml)?.[1] ?? '';
  const resultCode = Number(xmlTag(resultBlock, 'Code'));
  if (!Number.isSafeInteger(resultCode) || resultCode < 0) {
    throw Object.assign(new Error('invalid_provider_response'), { status: 502 });
  }
  if (resultCode !== 0) {
    return Object.freeze({ result_code: resultCode, state_code: null });
  }
  const stateBlock = /<State(?:\s[^>]*)?>([\s\S]*?)<\/State>/i.exec(xml)?.[1] ?? '';
  const infoBlock = /<Info(?:\s[^>]*)?>([\s\S]*?)<\/Info>/i.exec(xml)?.[1] ?? '';
  const stateCode = Number(xmlTag(stateBlock, 'Code'));
  if (![5, 10, 20, 50, 60, 80, 100].includes(stateCode)) {
    throw Object.assign(new Error('invalid_provider_response'), { status: 502 });
  }
  const userFields = {};
  const userFieldsBlock = /<UserFields(?:\s[^>]*)?>([\s\S]*?)<\/UserFields>/i.exec(xml)?.[1] ?? '';
  for (const fieldMatch of userFieldsBlock.matchAll(/<Field(?:\s[^>]*)?>([\s\S]*?)<\/Field>/gi)) {
    const name = xmlTag(fieldMatch[1], 'Name');
    if (/^Shp_[A-Za-z0-9_]{1,40}$/.test(name)) {
      userFields[name] = xmlTag(fieldMatch[1], 'Value').slice(0, 200);
    }
  }
  const outSum = xmlTag(infoBlock, 'OutSum');
  return Object.freeze({
    result_code: resultCode,
    state_code: stateCode,
    out_sum: outSum,
    amount_minor: outSum ? outSumToAmountMinor(outSum) : null,
    op_key: xmlTag(infoBlock, 'OpKey').slice(0, 200),
    payment_method: xmlTag(
      /<PaymentMethod(?:\s[^>]*)?>([\s\S]*?)<\/PaymentMethod>/i.exec(infoBlock)?.[1] ?? '',
      'Code',
    ).slice(0, 60),
    shp: Object.freeze(userFields),
  });
}

export async function fetchRobokassaOpState({
  config,
  invoiceId,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  if (config.testMode) {
    throw Object.assign(new Error('reconciliation_unavailable_in_test_mode'), { status: 503 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildRobokassaOpStateUrl({ config, invoiceId }), {
      method: 'GET',
      headers: { Accept: 'application/xml, text/xml' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error('provider_unavailable'), { status: 502 });
    }
    return parseRobokassaOpStateXml(await response.text());
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('provider_timeout'), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
