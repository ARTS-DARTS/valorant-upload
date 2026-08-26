import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
}

function isCloudinaryImage(value) {
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i.test(String(value || ''));
}

async function main() {
  const credentials = path.resolve(argument('credentials'));
  if (!argument('credentials')) throw new Error('--credentials is required');
  initializeApp({ credential: cert(JSON.parse(await fs.readFile(credentials, 'utf8'))) });
  const database = getFirestore();
  const [stateSnapshot, lineupsSnapshot] = await Promise.all([
    database.collection('media_migrations').doc('cloudinary_images').get(),
    database.collection('lineups').select('screenshots', 'screenshot_urls').get(),
  ]);
  const remaining = new Set();
  const selectel = new Set();
  const migratedSamples = [];
  const replacementSamples = [];
  lineupsSnapshot.docs.forEach((document) => {
    const data = document.data() || {};
    const urls = [...(Array.isArray(data.screenshots) ? data.screenshots : []), ...(Array.isArray(data.screenshot_urls) ? data.screenshot_urls : [])];
    urls.forEach((url) => {
      if (isCloudinaryImage(url)) remaining.add(url);
      if (/(?:selcloud|selstorage)\.ru\//i.test(String(url || ''))) {
        selectel.add(url);
        if (migratedSamples.length < 3) migratedSamples.push(url);
      }
      if (!isCloudinaryImage(url) && /^https:\/\//i.test(String(url || '')) && replacementSamples.length < 3) replacementSamples.push(url);
    });
  });
  console.log(JSON.stringify({ state: stateSnapshot.data() || null, unique_cloudinary_images_remaining: remaining.size, unique_selectel_images: selectel.size, migrated_samples: migratedSamples, replacement_samples: replacementSamples }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
