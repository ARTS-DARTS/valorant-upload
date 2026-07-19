import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const project = 'valorant-linemaps';
const root = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const refreshToken = config.tokens?.refresh_token;
if (!refreshToken) throw new Error('Firebase CLI refresh token is not available');

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }),
});
const tokenBody = await tokenResponse.json();
if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description || 'Firebase CLI authorization failed');
const headers = { Authorization: `Bearer ${tokenBody.access_token}` };

async function listCollection(collection, masks = []) {
  const documents = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '300' });
    if (pageToken) query.set('pageToken', pageToken);
    masks.forEach(field => query.append('mask.fieldPaths', field));
    const response = await fetch(`${root}/${collection}?${query}`, { headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Failed to list ${collection}`);
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return documents;
}

async function runLimited(items, worker, size = 20) {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(worker));
  }
}

const lockFields = ['moderation_lock_uid', 'moderation_lock_name', 'moderation_lock_expires_at'];
const lineups = await listCollection('lineups');
const locked = lineups.filter(doc => lockFields.some(field => doc.fields?.[field]));
let claims = [];
try {
  claims = await listCollection('moderation_claims');
} catch (error) {
  if (!String(error.message).includes('NOT_FOUND')) throw error;
}

console.log(`Lineup locks found: ${locked.length}`);
console.log(`Moderator claim records found: ${claims.length}`);
if (!apply) {
  console.log('Dry run only. Pass --apply to clear these lock fields.');
  process.exit(0);
}

await runLimited(locked, async doc => {
  const query = new URLSearchParams();
  lockFields.forEach(field => query.append('updateMask.fieldPaths', field));
  const response = await fetch(`https://firestore.googleapis.com/v1/${doc.name}?${query}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {} }),
  });
  if (!response.ok) throw new Error((await response.json()).error?.message || `Failed to clear ${doc.name}`);
});
await runLimited(claims, async doc => {
  const response = await fetch(`https://firestore.googleapis.com/v1/${doc.name}`, { method: 'DELETE', headers });
  if (!response.ok && response.status !== 404) throw new Error((await response.json()).error?.message || `Failed to delete ${doc.name}`);
});

console.log(`Cleared lineup locks: ${locked.length}`);
console.log(`Deleted moderator claim records: ${claims.length}`);
