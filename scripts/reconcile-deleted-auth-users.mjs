import 'dotenv/config';

import { adminAuth, adminFirestore } from '../backend/_lib/firebase-admin.js';

const apply = process.argv.includes('--apply');
const db = adminFirestore();
const auth = adminAuth();
const legacySources = new Set(['admin_panel', 'flutter_admin']);
const snapshot = await db.collection('deleted_accounts').get();
const candidates = snapshot.docs.filter(document => legacySources.has(String(document.data()?.source || '')));
const existing = [];

for (const document of candidates) {
  try {
    await auth.getUser(document.id);
    existing.push(document.id);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
}

console.log(JSON.stringify({ mode:apply ? 'apply' : 'dry-run', legacyMarkers:candidates.length, orphanAuthUsers:existing.length }));
if (apply) {
  for (const uid of existing) await auth.deleteUser(uid);
  console.log(JSON.stringify({ deletedAuthUsers:existing.length }));
}
