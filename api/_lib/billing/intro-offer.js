import { createHmac } from 'node:crypto';

function clean(value) {
  return String(value ?? '').trim();
}

export function loadIntroOfferPepper(env = process.env) {
  const value = clean(env.BILLING_INTRO_PEPPER);
  if (value.length < 32 || value.length > 512) {
    throw Object.assign(new Error('billing_not_configured'), { status: 503 });
  }
  return value;
}

export function introIdentityClaim(decodedToken, pepper) {
  const uid = clean(decodedToken?.uid);
  if (!uid) {
    throw Object.assign(new Error('authentication_required'), { status: 401 });
  }
  const yandexId = clean(decodedToken?.yandex_id);
  const email = clean(decodedToken?.email).toLowerCase();
  const stableIdentity = yandexId
    ? `yandex:${yandexId}`
    : email
      ? `email:${email}`
      : `uid:${uid}`;
  return createHmac('sha256', pepper)
    .update(stableIdentity, 'utf8')
    .digest('hex');
}
