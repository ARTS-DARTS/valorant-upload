import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const ALLOWED_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);
const ACTION_WINDOW_MS = 60_000;
const ACTION_LIMIT = 20;
const actionWindows = new Map();

function clean(value) {
  return String(value ?? '').replace(/п»ї/g, '').trim();
}

function initFirebase() {
  if (getApps().length) return;
  const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!raw) throw new Error('Firebase service account env is empty');
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

function setSecurityHeaders(req, res) {
  const origin = clean(req.headers.origin);
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function rejectForeignOrigin(req, res) {
  const origin = clean(req.headers.origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'Origin is not allowed' });
    return true;
  }
  return false;
}

async function authorize(req) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { status: 401 });
  initFirebase();
  const decoded = await getAuth().verifyIdToken(header.slice(7), true);
  const user = await getFirestore().collection('users').doc(decoded.uid).get();
  const role = clean(user.data()?.role).toLowerCase();
  if (!['moderator', 'admin'].includes(role)) {
    throw Object.assign(new Error('Moderator access required'), { status: 403 });
  }
  return {
    uid: decoded.uid,
    role,
    name: clean(user.data()?.display_name || user.data()?.name || decoded.name || 'Moderator').slice(0, 80),
  };
}

function checkActionRate(uid) {
  const now = Date.now();
  const current = actionWindows.get(uid);
  if (!current || now - current.startedAt >= ACTION_WINDOW_MS) {
    actionWindows.set(uid, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > ACTION_LIMIT) throw Object.assign(new Error('Too many moderation actions'), { status: 429 });
}

function timestampMillis(value) {
  return typeof value?.toMillis === 'function' ? value.toMillis() : 0;
}

function safeLineup(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    title: clean(d.title).slice(0, 100),
    description: clean(d.description).slice(0, 1000),
    map: clean(d.map || d.mapName).slice(0, 40),
    agent: clean(d.agent).slice(0, 40),
    ability: clean(d.ability).slice(0, 80),
    difficulty: clean(d.difficulty).slice(0, 20),
    round_side: clean(d.round_side).slice(0, 20),
    content_type: clean(d.content_type || d.category).slice(0, 20),
    moderator_only: d.moderator_only === true,
    submitted_by: clean(d.submitted_by || d.author).slice(0, 80),
    video_url: clean(d.video_url).slice(0, 1000),
    screenshots: Array.isArray(d.screenshots) ? d.screenshots.slice(0, 8).map(x => clean(x).slice(0, 1000)) : [],
    submitted_at: timestampMillis(d.submitted_at || d.created_at),
  };
}

async function listQueue(res) {
  const db = getFirestore();
  const [pendingSnap, moderatorSnap] = await Promise.all([
    db.collection('lineups').where('status', '==', 'pending').orderBy('submitted_at', 'desc').limit(30).get(),
    db.collection('lineups').where('moderator_only', '==', true).limit(50).get(),
  ]);
  const items = [...pendingSnap.docs, ...moderatorSnap.docs.filter(doc => doc.data()?.status === 'moderator_draft')]
    .map(safeLineup)
    .sort((a, b) => b.submitted_at - a.submitted_at)
    .slice(0, 50);
  res.status(200).json({ items });
}

async function moderate(req, res, moderator) {
  checkActionRate(moderator.uid);
  const lineupId = clean(req.body?.lineupId);
  const action = clean(req.body?.action);
  const reason = clean(req.body?.reason);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  if (!['promote', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (action === 'reject' && (reason.length < 10 || reason.length > 500)) {
    return res.status(400).json({ error: 'Причина должна содержать от 10 до 500 символов' });
  }

  const db = getFirestore();
  const ref = db.collection('lineups').doc(lineupId);
  let authorUid = '';
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error('Lineup not found'), { status: 404 });
    const data = snap.data() || {};
    if (!['pending', 'moderator_draft'].includes(data.status)) throw Object.assign(new Error('Лайнап уже обработан другим модератором'), { status: 409 });
    authorUid = clean(data.user_id || data.uid || data.author_uid);
    const update = action === 'promote'
      ? { status: 'hot', moderated_at: FieldValue.serverTimestamp(), moderated_by_uid: moderator.uid }
      : {
          status: 'rejected',
          rejection_reason: reason,
          rejected_at: FieldValue.serverTimestamp(),
          rejected_by_uid: moderator.uid,
          rejected_by_name: moderator.name,
        };
    tx.update(ref, update);
    tx.create(db.collection('moderator_logs').doc(), {
      lineup_id: lineupId,
      action,
      reason: action === 'reject' ? reason : '',
      moderator_uid: moderator.uid,
      moderator_role: moderator.role,
      created_at: FieldValue.serverTimestamp(),
    });
    if (action === 'reject' && authorUid) {
      tx.create(db.collection('notifications').doc(authorUid).collection('items').doc(), {
        type: 'lineup_rejected',
        lineup_id: lineupId,
        title: 'Ваш лайнап отклонён',
        body: reason.slice(0, 120),
        reason,
        is_read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    }
  });
  res.status(200).json({ ok: true, status: action === 'promote' ? 'hot' : 'rejected' });
}

export default async function handler(req, res) {
  setSecurityHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (rejectForeignOrigin(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const moderator = await authorize(req);
    if (req.method === 'GET') return await listQueue(res);
    return await moderate(req, res, moderator);
  } catch (error) {
    const status = Number(error.status) || (error.code?.startsWith('auth/') ? 401 : 500);
    if (status >= 500) console.error('moderation error:', error);
    return res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  }
}
