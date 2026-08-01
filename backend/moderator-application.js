import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  adminRequestError,
  applyAdminCors,
  requireAdminRequest,
} from './_lib/admin-auth.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

function clean(value) {
  return (value ?? '').replace(/﻿/g, '').trim();
}

function initFirebase() {
  if (getApps().length) return;
  const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!raw) throw new Error('Firebase service account env is empty');
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

export function createModeratorApplicationHandler({ auth, db } = {}) {
  return async function handler(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
      const authorized = await requireAdminRequest(req, { auth, db });

      const { uid, action, username = '', email = '' } = req.body || {};
      if (!uid || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error:'uid and valid action are required' });
      }

      if (!db) initFirebase();
      const store = authorized.db || getFirestore();
      const approved = action === 'approve';

      if (approved) {
        const batch = store.batch();
        batch.set(store.collection('users').doc(uid), {
        uid,
        role: 'moderator',
        email: email || '',
        user_email: email || '',
        displayName: username || '',
        name: username || '',
        name_lower: String(username || '').toLowerCase(),
        moderator_approved_at: FieldValue.serverTimestamp(),
      }, { merge: true });
        batch.set(store.collection('user_private').doc(uid), {
        uid,
        contact_email: email || '',
        updated_at: FieldValue.serverTimestamp(),
        schema_version: 2,
      }, { merge: true });
        await batch.commit();
      }

      await store.collection('moderator_applications').doc(uid).set({
      status: approved ? 'approved' : 'rejected',
      decided_at: FieldValue.serverTimestamp(),
    }, { merge: true });

      return res.status(200).json({ ok:true, status:approved ? 'approved' : 'rejected' });
    } catch (error) {
      return adminRequestError(res, error, 'moderator-application');
    }
  };
}

export default createModeratorApplicationHandler();
