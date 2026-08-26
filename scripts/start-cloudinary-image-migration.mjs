import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
}

async function main() {
  const credentialsArgument = argument('credentials');
  if (!credentialsArgument) throw new Error('--credentials is required');
  const credentials = path.resolve(credentialsArgument);
  const serviceAccount = JSON.parse(await fs.readFile(credentials, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const reference = getFirestore().collection('media_migrations').doc('cloudinary_images');
  await reference.set({
    status: 'queued',
    completed: 0,
    requested_at: FieldValue.serverTimestamp(),
    requested_by: 'codex',
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(JSON.stringify({ started: true, document: reference.path }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
