import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const SNAPSHOT_VERSION = 1;
const COLLECTION = 'lineups';
const INCLUDED_FIELDS = [
  'title', 'name', 'category', 'content_type', 'map', 'agent', 'ability',
  'round_side', 'side', 'difficulty', 'video_url', 'video_thumbnail_url',
  'screenshots', 'screenshot_urls', 'spike_usage', 'spike_x', 'spike_y',
  'status', 'created_at', 'updated_at', 'published_at',
];

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function serialize(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return String(value);
}

function mediaUrls(record) {
  return [
    record.video_url,
    record.video_thumbnail_url,
    ...(Array.isArray(record.screenshots) ? record.screenshots : []),
    ...(Array.isArray(record.screenshot_urls) ? record.screenshot_urls : []),
  ].filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
}

function encryptJson(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('VLMEDIA1\n'), iv, tag, ciphertext]);
}

async function main() {
  const credentialsPath = argument('credentials', process.env.GOOGLE_APPLICATION_CREDENTIALS || '');
  const outputDirectory = path.resolve(argument('output', 'backups/media-recovery'));
  const keyDirectory = path.resolve(argument('key-output', '../private-backups'));
  const label = argument('label', new Date().toISOString().slice(0, 10));
  if (!credentialsPath) throw new Error('Pass --credentials=PATH or GOOGLE_APPLICATION_CREDENTIALS.');

  const serviceAccount = JSON.parse(await fs.readFile(path.resolve(credentialsPath), 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const snapshot = await db.collection(COLLECTION).select(...INCLUDED_FIELDS).get();
  const records = snapshot.docs.map((document) => {
    const source = document.data();
    const fields = Object.fromEntries(
      INCLUDED_FIELDS.filter((field) => source[field] !== undefined)
        .map((field) => [field, serialize(source[field])]),
    );
    return { lineup_id: document.id, ...fields };
  });
  const urls = records.flatMap(mediaUrls);
  const cloudinaryUrls = urls.filter((url) => /(^|\.)cloudinary\.com$/i.test(new URL(url).hostname));
  const payload = {
    snapshot_version: SNAPSHOT_VERSION,
    firebase_project: serviceAccount.project_id,
    collection: COLLECTION,
    exported_at: new Date().toISOString(),
    included_fields: INCLUDED_FIELDS,
    excluded_data: ['user ids', 'names', 'emails', 'moderation notes', 'payments', 'secrets'],
    records,
  };
  const key = crypto.randomBytes(32);
  const encrypted = encryptJson(payload, key);
  const digest = crypto.createHash('sha256').update(encrypted).digest('hex');
  const baseName = `lineups-media-${label}`;
  const encryptedPath = path.join(outputDirectory, `${baseName}.json.enc`);
  const summaryPath = path.join(outputDirectory, `${baseName}.summary.json`);
  const keyPath = path.join(keyDirectory, `${baseName}.key.txt`);
  const summary = {
    snapshot_version: SNAPSHOT_VERSION,
    exported_at: payload.exported_at,
    collection: COLLECTION,
    documents: records.length,
    media_urls: new Set(urls).size,
    cloudinary_urls: new Set(cloudinaryUrls).size,
    encrypted_file: path.basename(encryptedPath),
    sha256: digest,
    privacy: 'Encrypted snapshot contains no user identity, email, payment, moderation-note, or secret fields.',
  };

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.mkdir(keyDirectory, { recursive: true });
  await fs.writeFile(encryptedPath, encrypted);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(keyPath, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ encryptedPath, summaryPath, keyPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
