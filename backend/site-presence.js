import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const ALLOWED_ORIGINS = new Set(['https://vlineups.ru', 'https://www.vlineups.ru', 'https://arts-darts.github.io', 'http://localhost:3000']);
function clean(value) { return String(value ?? '').replace(/п»ї/g, '').trim(); }
function initFirebase() { if (getApps().length) return; const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT); if (!raw) throw new Error('Firebase service account env is empty'); initializeApp({ credential: cert(JSON.parse(raw)) }); }
function headers(req, res) { const origin = clean(req.headers.origin); if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); }
function requestIp(req) { return clean(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress).split(',')[0]; }
function ipHash(req) { const salt = clean(process.env.PRESENCE_HASH_SALT || process.env.FIREBASE_SERVICE_ACCOUNT).slice(0, 128); return crypto.createHash('sha256').update(`${salt}|${requestIp(req)}`).digest('hex').slice(0, 24); }
function moscowDayKey(date = new Date()) { const parts = new Intl.DateTimeFormat('en', { timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date); const value = type => parts.find(part => part.type === type)?.value || ''; return `${value('year')}-${value('month')}-${value('day')}`; }
async function authorize(req) { const header = clean(req.headers.authorization); if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { status:401 }); initFirebase(); return getAuth().verifyIdToken(header.slice(7), true); }
function short(value, max = 80) { return clean(value).slice(0, max); }
async function heartbeat(req, res, decoded) {
  const db = getFirestore();
  const activityDay = moscowDayKey();
  const presenceRef = db.collection('site_presence').doc(decoded.uid);
  const dailyRef = db.collection('site_activity_daily').doc(activityDay);
  const sessionRef = db.collection('user_sessions').doc(`${activityDay}_web_${decoded.uid}`);
  const payload = {
    uid:decoded.uid,
    page:short(req.body?.page || 'upload', 40),
    activity_day:activityDay,
    ip_hash:ipHash(req),
    last_seen:FieldValue.serverTimestamp(),
    updated_at:FieldValue.serverTimestamp(),
  };
  let changed = false;
  await db.runTransaction(async tx => {
    const snap = await tx.get(presenceRef);
    changed = clean(snap.data()?.activity_day) !== activityDay;
    let canonicalName = '';
    if (changed || clean(snap.data()?.display_name_source) !== 'profile_v2') {
      const profile = await tx.get(db.collection('users').doc(decoded.uid));
      const profileData = profile.data() || {};
      canonicalName = short(
        profileData.display_name ||
        profileData.name ||
        profileData.nickname ||
        profileData.username ||
        decoded.name ||
        decoded.email?.split('@')[0] ||
        'Пользователь',
      );
    }
    if (canonicalName) {
      payload.display_name = canonicalName;
      payload.display_name_source = 'profile_v2';
    }
    tx.set(presenceRef, payload, { merge:true });
    if (changed) {
      tx.set(dailyRef, { day:activityDay, unique_users:FieldValue.increment(1), updated_at:FieldValue.serverTimestamp() }, { merge:true });
      tx.set(sessionRef, {
        uid:decoded.uid,
        date:activityDay,
        platform:'web',
        app_version:short(req.body?.app_version || 'upload-site', 40),
        ts:FieldValue.serverTimestamp(),
        schema_version:2,
      }, { merge:false });
    }
  });
  res.status(200).json({ ok:true, changed, activity_day:activityDay });
}
async function onlineCount(res, decoded) {
  const db = getFirestore();
  const user = await db.collection('users').doc(decoded.uid).get();
  if (clean(user.data()?.role).toLowerCase() !== 'admin') return res.status(403).json({ error:'Admin access required' });
  const activityDay = moscowDayKey();
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  const [dailySnap, liveSnap, todaySnap] = await Promise.all([
    db.collection('site_activity_daily').doc(activityDay).get(),
    db.collection('site_presence').where('last_seen', '>=', cutoff).orderBy('last_seen', 'desc').limit(100).get(),
    db.collection('site_presence').where('activity_day', '==', activityDay).limit(100).get(),
  ]);
  const users = liveSnap.docs.map(doc => {
    const data = doc.data() || {};
    return {
      uid:doc.id,
      display_name:short(data.display_name || 'Пользователь'),
      page:short(data.page || 'upload', 40),
      last_seen:data.last_seen?.toMillis?.() || 0,
    };
  });
  const todayRows = todaySnap.docs.map(doc => ({ id:doc.id, data:doc.data() || {} }));
  const unresolvedNames = todayRows.filter(row => short(row.data.display_name_source) !== 'profile_v2');
  if (unresolvedNames.length) {
    const profiles = await db.getAll(...unresolvedNames.map(row => db.collection('users').doc(row.id)));
    const batch = db.batch();
    profiles.forEach((profile, index) => {
      const data = profile.data() || {};
      const displayName = short(data.display_name || data.name || data.nickname || data.username || data.email || 'Пользователь');
      unresolvedNames[index].data.display_name = displayName;
      unresolvedNames[index].data.display_name_source = 'profile_v2';
      batch.set(db.collection('site_presence').doc(unresolvedNames[index].id), {
        display_name:displayName,
        display_name_source:'profile_v2',
      }, { merge:true });
    });
    await batch.commit();
  }
  const todayNameByUid = new Map(todayRows.map(row => [row.id, short(row.data.display_name || 'Пользователь')]));
  users.forEach(userItem => {
    userItem.display_name = todayNameByUid.get(userItem.uid) || userItem.display_name;
  });
  const liveIds = new Set(users.map(item => item.uid));
  const todayUsers = todayRows.map(row => ({
    uid:row.id,
    display_name:short(row.data.display_name || 'Пользователь'),
    page:short(row.data.page || 'upload', 40),
    last_seen:row.data.last_seen?.toMillis?.() || 0,
    online:liveIds.has(row.id),
  })).sort((left, right) => right.last_seen - left.last_seen);
  res.status(200).json({
    online:users.length,
    active_today:Number(dailySnap.data()?.unique_users || 0),
    users,
    today_users:todayUsers,
    activity_day:activityDay,
    presence_window_seconds:180,
    update_mode:'heartbeat',
  });
}
export default async function handler(req, res) { headers(req, res); if (req.method === 'OPTIONS') return res.status(204).end(); if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error:'Method not allowed' }); try { const decoded = await authorize(req); return req.method === 'POST' ? await heartbeat(req, res, decoded) : await onlineCount(res, decoded); } catch (error) { const status = Number(error.status) || (error.code?.startsWith('auth/') ? 401 : 500); if (status >= 500) console.error('site-presence error:', error); return res.status(status).json({ error:status >= 500 ? 'Internal server error' : error.message }); } }
