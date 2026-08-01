import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (!getApps().length) {
    const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
}

function identityId(subject) {
  return `yandex__${String(subject).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const authorization = String(req.headers.authorization || '');
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!idToken) return res.status(401).json({ error: 'authentication_required' });
    initFirebase();
    const decoded = await getAuth().verifyIdToken(idToken, true);
    const userRecord = await getAuth().getUser(decoded.uid);
    const providers = new Set(userRecord.providerData.map(item => item.providerId));
    if (!providers.has('password') && !providers.has('google.com')) {
      return res.status(409).json({ error: 'last_provider' });
    }

    const db = getFirestore();
    const [links, legacy] = await Promise.all([
      db.collection('user_auth_links').doc(decoded.uid).get(),
      db.collection('users').doc(decoded.uid).get(),
    ]);
    const linksData = links.data() || {};
    const legacyData = legacy.data() || {};
    const yandexId = String(linksData.yandex_id || legacyData.yandex_id || '').trim();
    const identityRef = yandexId
      ? db.collection('auth_identities').doc(identityId(yandexId))
      : null;
    await db.runTransaction(async tx => {
      if (identityRef) {
        const identity = await tx.get(identityRef);
        if (identity.exists && identity.get('uid') === decoded.uid) {
          tx.delete(identityRef);
        }
      }
      tx.set(db.collection('users').doc(decoded.uid), {
        yandex_id: FieldValue.delete(),
        yandex_email: FieldValue.delete(),
        auth_provider_linked: FieldValue.delete(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(db.collection('user_auth_links').doc(decoded.uid), {
        uid: decoded.uid,
        yandex_id: FieldValue.delete(),
        yandex_email: FieldValue.delete(),
        yandex_linked: false,
        yandex_unlinked_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        schema_version: 2,
      }, { merge: true });
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Yandex unlink failed:', error?.code || error?.message || 'unknown');
    return res.status(401).json({ error: 'invalid_session' });
  }
}
