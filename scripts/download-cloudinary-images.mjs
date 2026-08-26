import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function isCloudinaryImage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /(^|\.)res\.cloudinary\.com$/i.test(url.hostname) && /\/image\/upload\//.test(url.pathname);
  } catch (_) { return false; }
}

function extension(contentType) {
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  return '.jpg';
}

async function main() {
  const credentials = path.resolve(argument('credentials'));
  const output = path.resolve(argument('output', '../private-backups/cloudinary-images-2026-08-26'));
  const concurrency = Math.max(1, Math.min(12, Number(argument('concurrency', '6')) || 6));
  if (!argument('credentials')) throw new Error('--credentials is required');
  const serviceAccount = JSON.parse(await fs.readFile(credentials, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const snapshot = await getFirestore().collection('lineups').select('screenshots', 'screenshot_urls').get();
  const sourceMap = new Map();
  snapshot.docs.forEach((document) => {
    const data = document.data() || {};
    const urls = [...(Array.isArray(data.screenshots) ? data.screenshots : []), ...(Array.isArray(data.screenshot_urls) ? data.screenshot_urls : [])];
    urls.filter(isCloudinaryImage).forEach((url) => {
      if (!sourceMap.has(url)) sourceMap.set(url, new Set());
      sourceMap.get(url).add(document.id);
    });
  });
  await fs.mkdir(path.join(output, 'files'), { recursive: true });
  const manifestPath = path.join(output, 'manifest.json');
  let manifest = { exported_at: new Date().toISOString(), total: sourceMap.size, completed: {}, failures: {} };
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (_) {}
  const queue = [...sourceMap.entries()].filter(([url]) => !manifest.completed[url]);
  let cursor = 0;
  let finishedSinceSave = 0;
  let savePromise = Promise.resolve();

  function save() {
    savePromise = savePromise.then(async () => {
      const temporary = `${manifestPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, manifestPath);
      finishedSinceSave = 0;
    });
    return savePromise;
  }

  async function worker() {
    while (cursor < queue.length) {
      const [url, lineupIds] = queue[cursor++];
      try {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const contentType = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0];
        if (!contentType.startsWith('image/') || !bytes.length) throw new Error(`invalid ${contentType} ${bytes.length}`);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const file = `${digest}${extension(contentType)}`;
        await fs.writeFile(path.join(output, 'files', file), bytes);
        manifest.completed[url] = { file, sha256: digest, size_bytes: bytes.length, content_type: contentType, lineup_ids: [...lineupIds] };
        delete manifest.failures[url];
      } catch (error) {
        manifest.failures[url] = String(error?.message || error);
      }
      finishedSinceSave += 1;
      if (finishedSinceSave >= 20) await save();
      if ((Object.keys(manifest.completed).length + Object.keys(manifest.failures).length) % 100 === 0) {
        console.log(`processed=${Object.keys(manifest.completed).length} failed=${Object.keys(manifest.failures).length} total=${sourceMap.size}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  manifest.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ total: sourceMap.size, completed: Object.keys(manifest.completed).length, failed: Object.keys(manifest.failures).length, output }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
