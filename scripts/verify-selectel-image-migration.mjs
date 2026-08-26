import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
}

async function main() {
  const credentialsArgument = argument('credentials');
  if (!credentialsArgument) throw new Error('--credentials is required');
  const credentials = path.resolve(credentialsArgument);
  initializeApp({ credential: cert(JSON.parse(await fs.readFile(credentials, 'utf8'))) });
  const snapshot = await getFirestore().collection('lineups').select('screenshots', 'screenshot_urls', 'cloudinary_screenshot_archive').get();
  const current = new Set();
  const archived = new Set();
  snapshot.docs.forEach((document) => {
    const data = document.data() || {};
    [...(data.screenshots || []), ...(data.screenshot_urls || [])].forEach((url) => {
      if (/^https:\/\/[^/]+\.selstorage\.ru\//i.test(String(url || ''))) current.add(url);
    });
    (data.cloudinary_screenshot_archive || []).forEach((url) => archived.add(url));
  });
  const urls = [...current];
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = String(response.headers.get('content-type') || '');
        const length = Number(response.headers.get('content-length') || 0);
        if (!contentType.startsWith('image/') || length < 1) throw new Error(`invalid ${contentType} ${length}`);
      } catch (error) {
        failures.push({ url, error: String(error?.message || error) });
      }
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  console.log(JSON.stringify({ selectel_images: current.size, archived_cloudinary_images: archived.size, verified: current.size - failures.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
