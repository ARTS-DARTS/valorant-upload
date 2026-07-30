import { digest } from '../api/_lib/billing/robokassa.js';
import { pathToFileURL } from 'node:url';

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith('--')) result[value.slice(2)] = values[index + 1];
  }
  return result;
}

export function buildRobokassaTestScenarios({
  merchantLogin,
  password2,
  algorithm = 'sha256',
  invoiceId,
  outSum,
  baseUrl = 'https://vlineups.ru',
}) {
  if (!merchantLogin || !password2 || !/^\d{1,18}$/.test(String(invoiceId))) {
    throw new Error('merchantLogin, password2 and numeric invoiceId are required');
  }
  if (!/^\d+\.\d{2}$/.test(String(outSum))) {
    throw new Error('outSum must use the 0.00 format');
  }
  const signature = digest(
    `${outSum}:${invoiceId}:${password2}:Shp_order=${invoiceId}`,
    algorithm,
  );
  const validPayload = {
    OutSum:outSum,
    InvId:String(invoiceId),
    Shp_order:String(invoiceId),
    SignatureValue:signature,
    PaymentMethod:'Test',
  };
  const mismatchOutSum = '0.01';
  const mismatchSignature = digest(
    `${mismatchOutSum}:${invoiceId}:${password2}:Shp_order=${invoiceId}`,
    algorithm,
  );
  return {
    warning:'Use only with ROBOKASSA_TEST_MODE=true and a disposable Firebase account.',
    success_callback:{
      method:'POST',
      url:`${baseUrl}/api/billing/webhook/robokassa`,
      form:validPayload,
      expected:`OK${invoiceId}`,
    },
    duplicate_callback:{
      method:'POST',
      url:`${baseUrl}/api/billing/webhook/robokassa`,
      form:validPayload,
      expected:`OK${invoiceId} without a second ledger entry`,
    },
    invalid_signature:{
      method:'POST',
      url:`${baseUrl}/api/billing/webhook/robokassa`,
      form:{ ...validPayload, SignatureValue:`0${signature.slice(1)}` },
      expected:'HTTP 400 invalid_signature',
    },
    canonical_amount_mismatch:{
      note:'Create a fresh disposable order before this check.',
      method:'POST',
      url:`${baseUrl}/api/billing/webhook/robokassa`,
      form:{
        ...validPayload,
        OutSum:mismatchOutSum,
        SignatureValue:mismatchSignature,
      },
      expected:'HTTP 409 order_mismatch',
    },
    success_redirect:`${baseUrl}/payment/success?InvId=${invoiceId}`,
    fail_redirect:`${baseUrl}/payment/fail?InvId=${invoiceId}`,
    reversal:'Provider state 60 is tested through the disabled reconciliation job, never through a browser redirect.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = buildRobokassaTestScenarios({
    merchantLogin:process.env.ROBOKASSA_MERCHANT_LOGIN,
    password2:process.env.ROBOKASSA_PASSWORD_2,
    algorithm:process.env.ROBOKASSA_HASH_ALGORITHM || 'sha256',
    invoiceId:args.invoice,
    outSum:args.amount,
    baseUrl:args.base || 'https://vlineups.ru',
  });
  process.stdout.write(`${JSON.stringify(scenarios, null, 2)}\n`);
}
