import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length) || '';
}

function needsSpikeReview(data = {}) {
  const type = String(data.content_type || data.category || 'lineup').trim().toLowerCase();
  const side = String(data.round_side || '').trim().toLowerCase();
  const usage = String(data.spike_usage || '').trim().toLowerCase();
  if (type !== 'lineup' || side !== 'attack') return false;
  if (!['placed', 'not_used'].includes(usage)) return true;
  return usage === 'placed' && (!Number.isFinite(Number(data.spike_x)) || !Number.isFinite(Number(data.spike_y)));
}

async function main() {
  const credentialsArgument = argument('credentials');
  if (!credentialsArgument) throw new Error('--credentials is required');
  const apply = process.argv.includes('--apply') && process.argv.includes('--confirm-production');
  const serviceAccount = JSON.parse(await fs.readFile(path.resolve(credentialsArgument), 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const database = getFirestore();
  const snapshot = await database.collection('lineups').where('status', '==', 'approved').get();
  const targets = snapshot.docs.filter(document => needsSpikeReview(document.data()));
  const alreadyQueued = targets.filter(document => document.data()?.metadata_review_required === true).length;
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', approved: snapshot.size, spike_tasks: targets.length, already_queued: alreadyQueued }, null, 2));
  if (!apply) return;
  for (let offset = 0; offset < targets.length; offset += 400) {
    const batch = database.batch();
    targets.slice(offset, offset + 400).forEach(document => batch.update(document.ref, {
      metadata_review_required: true,
      spike_review_queued_at: FieldValue.serverTimestamp(),
    }));
    await batch.commit();
  }
  await database.collection('settings').doc('spike_metadata_backfill_v1').set({
    queued: targets.length,
    scanned: snapshot.size,
    completed: true,
    completed_at: FieldValue.serverTimestamp(),
  });
  console.log(JSON.stringify({ queued: targets.length, scanned: snapshot.size }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
