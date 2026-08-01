import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function clean(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/п»ї/g, '').trim();
}

export function ensureFirebaseAdmin() {
  if (!getApps().length) {
    const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
}

export function adminAuth() {
  ensureFirebaseAdmin();
  return getAuth();
}

export function adminFirestore() {
  ensureFirebaseAdmin();
  return getFirestore();
}

export async function validateFirebaseAdminServices({
  auth = adminAuth(),
  firestore = adminFirestore(),
  timeoutMs = 10_000,
} = {}) {
  const validation = Promise.all([
    auth.listUsers(1),
    firestore.collection('account_entitlements').limit(1).get(),
  ]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await validation;
    return;
  }

  let timeout;
  try {
    await Promise.race([
      validation,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(Object.assign(
            new Error('Firebase readiness validation timed out'),
            { code: 'firebase/readiness-timeout' },
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
