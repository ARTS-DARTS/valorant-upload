import dotenv from 'dotenv';
import { FieldValue } from 'firebase-admin/firestore';

import { adminFirestore } from '../backend/_lib/firebase-admin.js';

dotenv.config();

const SELECTEL_IMAGE_HOST = /^[^.]+\.selstorage\.ru$/i;

function imageUrls(data = {}) {
  return [...(data.screenshots || []), ...(data.screenshot_urls || [])]
    .map(value => String(value || '').trim())
    .filter(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && SELECTEL_IMAGE_HOST.test(url.hostname);
      } catch {
        return false;
      }
    });
}

export async function inspectSelectelImages({ db, fetchImpl = fetch, concurrency = 16 } = {}) {
  const snapshot = await db.collection('lineups').select('screenshots', 'screenshot_urls').get();
  const urls = [...new Set(snapshot.docs.flatMap(doc => imageUrls(doc.data() || {})))];
  const failures = [];
  let cursor = 0;
  let verified = 0;
  let storageBytes = 0;

  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const response = await fetchImpl(url, {
          method:'HEAD', redirect:'follow', signal:AbortSignal.timeout(10_000),
        });
        const contentType = String(response.headers.get('content-type') || '');
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (!response.ok || !contentType.startsWith('image/') || contentLength < 1) {
          throw new Error(`HTTP ${response.status}; ${contentType || 'unknown'}; ${contentLength} bytes`);
        }
        verified += 1;
        storageBytes += contentLength;
      } catch (error) {
        failures.push({ url, error:String(error?.message || error).slice(0, 240) });
      }
    }
  }

  await Promise.all(Array.from({ length:Math.max(1, Math.min(32, concurrency)) }, worker));
  return {
    documents:snapshot.size,
    objects:urls.length,
    verified,
    failed:failures.length,
    storage_bytes:storageBytes,
    failures:failures.slice(0, 20),
  };
}

export async function runSelectelImageMonitor({
  db = adminFirestore(), fetchImpl = fetch,
  budgetBytes = Number(process.env.SELECTEL_IMAGE_BUDGET_BYTES || 10 * 1024 ** 3),
} = {}) {
  const result = await inspectSelectelImages({ db, fetchImpl });
  const usageRatio = budgetBytes > 0 ? result.storage_bytes / budgetBytes : null;
  const record = {
    ...result,
    budget_bytes:budgetBytes > 0 ? budgetBytes : null,
    usage_ratio:usageRatio,
    ok:result.failed === 0 && (usageRatio == null || usageRatio < 0.9),
    checked_at:FieldValue.serverTimestamp(),
  };
  await db.collection('storage_monitoring').doc('selectel_images').set(record, { merge:false });
  return record;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
  runSelectelImageMonitor()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
