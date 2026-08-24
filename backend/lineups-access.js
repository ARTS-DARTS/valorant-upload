import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import { normalizeEntitlement } from './_lib/billing/entitlements.js';
import { recordSubscriptionUsage } from './_lib/billing/subscription-usage.js';

const MEDIA_HOSTS = new Set([
  'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
  'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
  'res.cloudinary.com',
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
]);
const PLAYBACK_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 10_000;
const sessions = new Map();

function clean(value, max = 240) { return String(value ?? '').trim().slice(0, max); }
function fail(status, code) { return Object.assign(new Error(code), { status }); }
function tokenHash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

async function authorize(req, verifyIdToken) {
  const header = clean(req.headers.authorization, 8192);
  if (!header.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  return verifyIdToken(header.slice(7).trim());
}

function safeVideoUrl(value) {
  try {
    const parsed = new URL(clean(value, 2000));
    return parsed.protocol === 'https:' && MEDIA_HOSTS.has(parsed.hostname) ? parsed : null;
  } catch (_) { return null; }
}

function publicLineup(doc) {
  const value = doc.data() || {};
  return {
    id: doc.id,
    title: clean(value.title || 'Без названия', 120),
    description: clean(value.description, 800),
    map: clean(value.map, 60),
    agent: clean(value.agent, 60),
    ability: clean(value.ability, 80),
    difficulty: clean(value.difficulty, 32),
    category: clean(value.content_type || value.category || 'lineup', 32),
    screenshots: Array.isArray(value.screenshots)
      ? value.screenshots.map(url => clean(url, 1000)).filter(Boolean).slice(0, 6)
      : [],
    has_video: !!safeVideoUrl(value.video_url),
  };
}

function cleanupSessions(now = Date.now()) {
  for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
  if (sessions.size <= MAX_SESSIONS) return;
  const overflow = sessions.size - MAX_SESSIONS;
  [...sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, overflow).forEach(([key]) => sessions.delete(key));
}

function streamVideo(target, req, res, redirects = 0) {
  const headers = { Accept: 'video/*', 'User-Agent': 'vlineups-protected-video/1.0' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  const upstream = https.request(target, { method:'GET', headers }, response => {
    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
      const redirected = new URL(response.headers.location, target);
      response.resume();
      if (!MEDIA_HOSTS.has(redirected.hostname)) return res.status(502).json({ error:'media_redirect_denied' });
      return streamVideo(redirected, req, res, redirects + 1);
    }
    res.status(response.statusCode || 502);
    ['content-type','content-length','content-range','accept-ranges','etag','last-modified'].forEach(name => {
      if (response.headers[name]) res.setHeader(name, response.headers[name]);
    });
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    response.on('error', error => res.destroy(error));
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    response.pipe(res);
  });
  upstream.setTimeout(20_000, () => upstream.destroy(new Error('upstream_timeout')));
  upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error:'media_unavailable' }); });
  upstream.end();
}

export function createLineupsAccessHandler({
  verifyIdToken = token => adminAuth().verifyIdToken(token, true),
  db = adminFirestore,
  now = Date.now,
} = {}) {
  return async function lineupsAccessHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const database = typeof db === 'function' ? db() : db;
      if (req.method === 'GET' && req.path === '/api/lineups/video') {
        cleanupSessions(now());
        const rawToken = clean(req.query?.token, 256);
        const lineupId = clean(req.query?.id, 180);
        const session = sessions.get(tokenHash(rawToken));
        if (!rawToken || !lineupId || !session || session.lineupId !== lineupId || session.expiresAt <= now()) {
          throw fail(403, 'playback_session_expired');
        }
        session.expiresAt = now() + PLAYBACK_TTL_MS;
        const [entitlementSnap, lineupSnap] = await Promise.all([
          database.collection('account_entitlements').doc(session.uid).get(),
          database.collection('lineups').doc(lineupId).get(),
        ]);
        const entitlement = normalizeEntitlement(entitlementSnap.exists ? entitlementSnap.data() : null, { now: new Date(now()) });
        const lineup = lineupSnap.exists ? lineupSnap.data() : null;
        if (!entitlement.capabilities.plus_tools) throw fail(403, 'plus_required');
        if (!lineup || clean(lineup.status).toLowerCase() !== 'approved') throw fail(404, 'lineup_not_found');
        const target = safeVideoUrl(lineup.video_url);
        if (!target) throw fail(404, 'video_not_found');
        return streamVideo(target, req, res);
      }

      if (req.method !== 'GET' && req.method !== 'POST') throw fail(405, 'method_not_allowed');
      const decoded = await authorize(req, verifyIdToken);
      const entitlementSnap = await database.collection('account_entitlements').doc(decoded.uid).get();
      const rawEntitlement = entitlementSnap.exists ? entitlementSnap.data() : {};
      const entitlement = normalizeEntitlement(rawEntitlement, { now: new Date(now()) });
      if (!entitlement.capabilities.plus_tools) throw fail(403, 'plus_required');

      if (req.path === '/api/lineups') {
        const snapshot = await database.collection('lineups').where('status', '==', 'approved').limit(160).get();
        await recordSubscriptionUsage(database, {
          uid:decoded.uid,
          entitlement:rawEntitlement,
          eventType:'site_lineups_opened',
          eventId:`lineups_${new Date(now()).toISOString().slice(0,13)}`,
          occurredAt:new Date(now()),
        });
        return res.status(200).json({ lineups:snapshot.docs.map(publicLineup), server_time:new Date(now()).toISOString() });
      }
      if (req.path === '/api/lineups/playback-token') {
        const lineupId = clean(req.body?.lineupId, 180);
        if (!lineupId) throw fail(400, 'lineup_id_required');
        const lineupSnap = await database.collection('lineups').doc(lineupId).get();
        const lineup = lineupSnap.exists ? lineupSnap.data() : null;
        if (!lineup || clean(lineup.status).toLowerCase() !== 'approved' || !safeVideoUrl(lineup.video_url)) {
          throw fail(404, 'video_not_found');
        }
        cleanupSessions(now());
        const rawToken = randomBytes(32).toString('base64url');
        sessions.set(tokenHash(rawToken), { uid:decoded.uid, lineupId, expiresAt:now() + PLAYBACK_TTL_MS });
        await recordSubscriptionUsage(database, {
          uid:decoded.uid,
          entitlement:rawEntitlement,
          eventType:'site_lineup_video_opened',
          eventId:`video_${lineupId}_${new Date(now()).toISOString().slice(0,13)}`,
          targetId:lineupId,
          occurredAt:new Date(now()),
        });
        return res.status(201).json({ playback_url:`/api/lineups/video?id=${encodeURIComponent(lineupId)}&token=${encodeURIComponent(rawToken)}`, expires_in:Math.floor(PLAYBACK_TTL_MS / 1000), watermark:clean(decoded.email || decoded.name || decoded.uid, 80) });
      }
      throw fail(404, 'not_found');
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('lineups-access error:', error);
      if (!res.headersSent) return res.status(status).json({ error:status >= 500 ? 'lineups_unavailable' : error.message });
      return res.end();
    }
  };
}

export default createLineupsAccessHandler();
