import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function stateSecret() {
  const value = String(
    process.env.YANDEX_STATE_SECRET ||
    process.env.YANDEX_CLIENT_SECRET ||
    '',
  ).replace(/^\uFEFF/, '').trim();
  if (!value) throw new Error('Yandex state signing secret is not configured');
  return value;
}

function signature(payload) {
  return createHmac('sha256', stateSecret()).update(payload).digest('base64url');
}

export function createYandexLinkState(uid, ttlSeconds = 600, kind = 'link') {
  if (!['link', 'reauth'].includes(kind)) throw new Error('Unsupported Yandex OAuth state kind');
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${kind}.${uid}.${expiresAt}.${nonce}`;
  return `${payload}.${signature(payload)}`;
}

export function verifyYandexLinkState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 5 || !['link', 'reauth'].includes(parts[0])) return null;
  const [kind, uid, expiresRaw, nonce, received] = parts;
  const expiresAt = Number(expiresRaw);
  if (!uid || !nonce || !Number.isInteger(expiresAt)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt < now || expiresAt > now + 900) return null;
  const payload = `${kind}.${uid}.${expiresAt}.${nonce}`;
  const expected = signature(payload);
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { kind, uid, expiresAt, nonce };
}
