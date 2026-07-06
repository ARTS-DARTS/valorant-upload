import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminKey = req.headers['x-admin-key'];
  const secret = clean(process.env.ADMIN_SECRET);
  if (!adminKey || adminKey !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { uid, action, username = '', email = '' } = req.body || {};
  if (!uid || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'uid and valid action are required' });
  }

  try {
    initFirebase();
    const db = getFirestore();
    const approved = action === 'approve';

    if (approved) {
      await db.collection('users').doc(uid).set({
        uid,
        role: 'moderator',
        email: email || '',
        user_email: email || '',
        displayName: username || '',
        name: username || '',
        name_lower: String(username || '').toLowerCase(),
        moderator_approved_at: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await db.collection('moderator_applications').doc(uid).set({
      status: approved ? 'approved' : 'rejected',
      decided_at: FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.status(200).json({ ok: true, status: approved ? 'approved' : 'rejected' });
  } catch (e) {
    console.error('moderator-application error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
