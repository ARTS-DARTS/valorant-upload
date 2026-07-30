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
