import { adminAuth, adminFirestore } from './firebase-admin.js';

const ALLOWED_ADMIN_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function applyAdminCors(req, res) {
  const origin = String(req.headers?.origin || '');
  if (origin && !ALLOWED_ADMIN_ORIGINS.has(origin)) throw fail(403, 'origin_not_allowed');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

export async function requireAdminRequest(req, {
  auth = adminAuth(),
  db = adminFirestore(),
} = {}) {
  const authorization = String(req.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  const decoded = await auth.verifyIdToken(authorization.slice(7), true);
  const user = await db.collection('users').doc(decoded.uid).get();
  if (!user.exists || String(user.data()?.role || '').toLowerCase() !== 'admin') {
    throw fail(403, 'admin_required');
  }
  return { decoded, db };
}

export function adminRequestError(res, error, label) {
  const status = Number(error.status)
    || (String(error.code || '').startsWith('auth/') ? 401 : 500);
  if (status >= 500) console.error(`${label} error:`, error);
  return res.status(status).json({
    error:status >= 500 ? 'internal_server_error' : error.message,
  });
}
