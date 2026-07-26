import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const project = 'valorant-linemaps';
const databaseRoot =
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)`;
const configPath = path.join(
  os.homedir(),
  '.config',
  'configstore',
  'firebase-tools.json',
);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const refreshToken = config.tokens?.refresh_token;
if (!refreshToken) {
  throw new Error('Firebase CLI refresh token is not available');
}

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    client_id:
      '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }),
});
const tokenBody = await tokenResponse.json();
if (!tokenResponse.ok || !tokenBody.access_token) {
  throw new Error(
    tokenBody.error_description || 'Firebase CLI authorization failed',
  );
}
const headers = {Authorization: `Bearer ${tokenBody.access_token}`};

function value(fields, key) {
  const field = fields?.[key];
  return field?.stringValue ?? field?.booleanValue ?? null;
}

function profileState(document) {
  const fields = document.fields || {};
  const name = String(
    value(fields, 'name') ||
      value(fields, 'username') ||
      value(fields, 'displayName') ||
      '',
  ).trim();
  const lower = String(value(fields, 'name_lower') || '').trim();
  const yandexId = String(value(fields, 'yandex_id') || '').trim();
  const provider = String(
    value(fields, 'auth_provider') ||
      value(fields, 'primary_provider') ||
      '',
  ).toLowerCase();
  const nicknameSetAt = fields.nickname_set_at;
  const hasYandexIdentity = Boolean(yandexId || provider === 'yandex');
  const hasUsableNickname = Boolean(name && lower);
  const legacyGenerated = /^Игрок\d{4}$/.test(name);
  const incomplete =
    !nicknameSetAt &&
    hasYandexIdentity &&
    (!hasUsableNickname || legacyGenerated);
  return {
    incomplete,
    alreadyMarked: value(fields, 'needs_nickname') === true,
    displayName:
      name || String(value(fields, 'yandex_name') || '').trim() || '—',
  };
}

async function loadYandexProfiles() {
  const response = await fetch(`${databaseRoot}/documents:runQuery`, {
    method: 'POST',
    headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      structuredQuery: {
        from: [{collectionId: 'users'}],
        where: {
          fieldFilter: {
            field: {fieldPath: 'yandex_id'},
            op: 'GREATER_THAN',
            value: {stringValue: ''},
          },
        },
        select: {
          fields: [
            'name',
            'username',
            'displayName',
            'name_lower',
            'yandex_name',
            'yandex_id',
            'auth_provider',
            'primary_provider',
            'needs_nickname',
            'nickname_set_at',
          ].map(fieldPath => ({fieldPath})),
        },
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message || 'Failed to query Yandex profiles');
  }
  return body.map(item => item.document).filter(Boolean);
}

async function markNeedsNickname(document) {
  const query = new URLSearchParams({
    'updateMask.fieldPaths': 'needs_nickname',
  });
  const response = await fetch(
    `https://firestore.googleapis.com/v1/${document.name}?${query}`,
    {
      method: 'PATCH',
      headers: {...headers, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        fields: {needs_nickname: {booleanValue: true}},
      }),
    },
  );
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error?.message || `Failed to update ${document.name}`);
  }
}

const profiles = await loadYandexProfiles();
const incomplete = profiles.filter(document => profileState(document).incomplete);
const candidates = incomplete.filter(
  document => !profileState(document).alreadyMarked,
);
console.log(`Yandex profiles checked: ${profiles.length}`);
console.log(`Profiles without a user-selected nickname: ${incomplete.length}`);
console.log(
  `Already marked needs_nickname=true: ${incomplete.length - candidates.length}`,
);
console.log(`Profiles requiring migration: ${candidates.length}`);
for (const document of candidates.slice(0, 20)) {
  const uid = document.name.split('/').at(-1);
  console.log(`- ${uid}: ${profileState(document).displayName}`);
}
if (candidates.length > 20) {
  console.log(`... and ${candidates.length - 20} more`);
}

if (!apply) {
  console.log('Dry run only. Pass --apply to mark needs_nickname=true.');
  process.exit(0);
}

for (let offset = 0; offset < candidates.length; offset += 20) {
  await Promise.all(candidates.slice(offset, offset + 20).map(markNeedsNickname));
}
console.log(`Updated profiles: ${candidates.length}`);
