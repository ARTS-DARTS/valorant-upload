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
const autosaveWindows = new Map();

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

function checkAutosaveRate(uid) {
  const now = Date.now();
  const current = autosaveWindows.get(uid);
  if (!current || now - current.startedAt >= ACTION_WINDOW_MS) {
    autosaveWindows.set(uid, { startedAt:now, count:1 });
    return;
  }
  current.count += 1;
  if (current.count > 90) throw Object.assign(new Error('Too many autosave requests'), { status:429 });
}

function timestampMillis(value) {
  return typeof value?.toMillis === 'function' ? value.toMillis() : 0;
}

const MODERATION_LOCK_MS = 10 * 60_000;

function isSovaBowAbility(value) {
  return /shock|recon|шок|развед|стрел/.test(clean(value).toLowerCase());
}

function sovaShotAbilities(data = {}) {
  if (!['sova', 'сова'].includes(clean(data.agent).toLowerCase())) return [];
  const extras = Array.isArray(data.extra_abilities) ? data.extra_abilities : [];
  return [data.ability, ...extras.map(item => item?.ability)]
    .map(value => clean(value).slice(0, 80))
    .filter(value => value && isSovaBowAbility(value))
    .slice(0, 3);
}

function normalizedSovaBounces(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 2 ? number : null;
}

function normalizedSovaShots(data = {}) {
  const abilities = sovaShotAbilities(data);
  const raw = Array.isArray(data.sova_shots) ? data.sova_shots : [];
  const usableRaw = raw.filter(item => isSovaBowAbility(item?.ability));
  const shots = abilities.map((ability, index) => {
    const item = usableRaw.find(candidate => clean(candidate?.ability).toLowerCase() === ability.toLowerCase()) || usableRaw[index];
    return {
      order: index + 1,
      ability,
      charge: Number(item?.charge),
      bounces: normalizedSovaBounces(item?.bounces),
    };
  }).filter(item => Number.isFinite(item.charge) && item.charge >= 0 && item.charge <= 3 && item.bounces !== null);
  if (!shots.length && abilities.length && isSovaBowAbility(data.ability) && typeof data.sova_charge === 'number' && data.sova_charge >= 0 && data.sova_charge <= 3) {
    const bounces = normalizedSovaBounces(data.sova_bounces);
    if (bounces !== null) shots.push({ order: 1, ability: abilities[0], charge: data.sova_charge, bounces });
  }
  return shots;
}

function missingMetadata(data = {}) {
  const missing = [];
  if (!['easy', 'medium', 'hard'].includes(clean(data.difficulty))) missing.push('difficulty');
  if (!['attack', 'defense', 'any'].includes(clean(data.round_side))) missing.push('round_side');
  const shotAbilities = sovaShotAbilities(data);
  if (shotAbilities.length && normalizedSovaShots(data).length < shotAbilities.length) missing.push('sova_shots');
  return missing;
}

function isQueuedForModeration(data = {}) {
  if (data.status === 'approved') {
    return data.metadata_review_required === true && missingMetadata(data).length > 0;
  }
  if (data.status === 'moderator_draft') return data.moderator_only === true;
  return data.status === 'pending' &&
    data.moderator_template_completed !== true &&
    !clean(data.edited_by_moderator_uid);
}

function moderatorTemplateKey(data = {}) {
  if (data.status !== 'moderator_draft' || data.moderator_only !== true) return '';
  const rawVideoUrl = clean(data.video_url);
  if (!rawVideoUrl) return '';
  try {
    const url = new URL(rawVideoUrl);
    return `${url.hostname.toLowerCase()}${decodeURIComponent(url.pathname)}`;
  } catch (_) {
    return rawVideoUrl.split('?')[0].toLocaleLowerCase('ru-RU');
  }
}

function safeLineup(doc, viewerUid = '') {
  const stored = doc.data() || {};
  const lockExpiresAt = timestampMillis(stored.moderation_lock_expires_at);
  const lockActive = !!stored.moderation_lock_uid && lockExpiresAt > Date.now();
  const ownsLock = lockActive && clean(stored.moderation_lock_uid) === viewerUid;
  const autosave = ownsLock && stored.moderator_autosave && typeof stored.moderator_autosave === 'object'
    ? stored.moderator_autosave
    : {};
  const d = { ...stored, ...autosave };
  return {
    id: doc.id,
    title: clean(d.title).slice(0, 100),
    description: clean(d.description).slice(0, 1000),
    map: clean(d.map || d.mapName).slice(0, 40),
    agent: clean(d.agent).slice(0, 40),
    ability: clean(d.ability).slice(0, 80),
    difficulty: clean(d.difficulty).slice(0, 20),
    round_side: clean(d.round_side).slice(0, 20),
    sova_charge: typeof d.sova_charge === 'number' ? d.sova_charge : null,
    sova_bounces: normalizedSovaBounces(d.sova_bounces),
    sova_shots: normalizedSovaShots(d),
    sova_shot_abilities: sovaShotAbilities(d),
    task_kind: d.status === 'approved' && d.metadata_review_required === true ? 'metadata' : 'full',
    missing_fields: missingMetadata(d),
    content_type: clean(d.content_type || d.category).slice(0, 20),
    moderator_only: d.moderator_only === true,
    user_id: clean(d.user_id || d.uid || d.author_uid).slice(0, 128),
    submitted_by: clean(d.submitted_by || d.author).slice(0, 80),
    video_url: clean(d.video_url).slice(0, 1000),
    video_thumbnail_url: clean(
      d.video_thumbnail_url || d.thumbnail_url || d.poster_url ||
      (Array.isArray(d.screenshots) ? d.screenshots[0] : ''),
    ).slice(0, 1000),
    screenshots: Array.isArray(d.screenshots) ? d.screenshots.slice(0, 8).map(x => clean(x).slice(0, 1000)) : [],
    position_x: Number(d.position_x ?? 0.5),
    position_y: Number(d.position_y ?? 0.5),
    trajectory: Array.isArray(d.trajectory) ? d.trajectory.slice(0, 30) : [],
    extra_abilities: Array.isArray(d.extra_abilities) ? d.extra_abilities.slice(0, 2) : [],
    target_x: Number(d.target_x ?? 0.5),
    target_y: Number(d.target_y ?? 0.5),
    weapons: Array.isArray(d.weapons) ? d.weapons.slice(0, 20).map(value => clean(value).slice(0, 80)) : [],
    site: clean(d.site).slice(0, 10),
    number: Math.max(1, Math.min(999, Math.trunc(Number(d.number) || 1))),
    zoom_area: d.zoom_area && typeof d.zoom_area === 'object' ? d.zoom_area : null,
    abilities: Array.isArray(d.abilities) ? d.abilities.slice(0, 8) : [],
    submitted_at: timestampMillis(d.submitted_at || d.created_at || d.createdAt),
    moderation_lock_active: lockActive,
    moderation_lock_owned: ownsLock,
    moderation_lock_name: lockActive ? clean(d.moderation_lock_name).slice(0, 80) : '',
    moderation_lock_expires_at: lockActive ? lockExpiresAt : 0,
  };
}

async function searchAuthors(req, res) {
  const q = clean(req.query?.q).slice(0, 80);
  if (q.length < 2) return res.status(200).json({ users: [] });
  const db = getFirestore();
  const snap = await db.collection('users').orderBy('name').startAt(q).endAt(`${q}\uf8ff`).limit(20).get();
  const users = snap.docs.map(doc => ({
    uid: doc.id,
    name: clean(doc.data()?.name || doc.data()?.username || doc.data()?.displayName).slice(0, 80),
  })).filter(user => user.name);
  res.status(200).json({ users });
}

function finite01(value, fallback = 0.5) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function safePoints(raw, limit = 30) {
  return Array.isArray(raw) ? raw.slice(0, limit).map(point => ({ x: finite01(point?.x), y: finite01(point?.y) })) : [];
}

function safeDefenseAbilities(raw) {
  if (!Array.isArray(raw)) return [];
  const allowedKinds = new Set(['circle_area', 'line_segment', 'sensor_rect', 'mesh_burst', 'net_area']);
  return raw.slice(0, 8).map((item, index) => {
    const shapeKind = clean(item?.shape_kind).slice(0, 30);
    const points = Array.isArray(item?.points) ? item.points.slice(0, 8).map(point => ({
      role: clean(point?.role).slice(0, 20),
      x: finite01(point?.x),
      y: finite01(point?.y),
    })) : [];
    return {
      ability: clean(item?.ability).slice(0, 80),
      slot: clean(item?.slot).slice(0, 40),
      icon: clean(item?.icon).slice(0, 1000),
      x: finite01(item?.x),
      y: finite01(item?.y),
      shape_kind: allowedKinds.has(shapeKind) ? shapeKind : 'circle_area',
      shape_radius: Math.max(0, Math.min(.5, Number(item?.shape_radius) || 0)),
      shape_anchor: clean(item?.shape_anchor).slice(0, 30),
      shape_width: Math.max(0, Math.min(1, Number(item?.shape_width) || 0)),
      shape_height: Math.max(0, Math.min(1, Number(item?.shape_height) || 0)),
      shape_rotation: Math.max(-360, Math.min(360, Number(item?.shape_rotation) || 0)),
      points,
      order: index + 1,
    };
  }).filter(item => item.ability);
}

async function saveDraft(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  const data = req.body?.data || {};
  const authorUid = clean(data.user_id).slice(0, 128);
  const authorName = clean(data.submitted_by).slice(0, 80);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  if (!authorUid || !authorName) return res.status(400).json({ error: 'Выбери автора лайнапа' });
  const db = getFirestore();
  const author = await db.collection('users').doc(authorUid).get();
  if (!author.exists) return res.status(400).json({ error: 'Автор не найден' });
  const ref = db.collection('lineups').doc(lineupId);
  const claimRef = db.collection('moderation_claims').doc(moderator.uid);
  await db.runTransaction(async tx => {
    const templatesQuery = db.collection('lineups').where('moderator_only', '==', true);
    const [snap, claimSnap, templatesSnap] = await Promise.all([tx.get(ref), tx.get(claimRef), tx.get(templatesQuery)]);
    if (!snap.exists) throw Object.assign(new Error('Lineup not found'), { status: 404 });
    const currentData = snap.data() || {};
    if (!['pending', 'moderator_draft'].includes(currentData.status)) throw Object.assign(new Error('Лайнап уже обработан'), { status: 409 });
    // An expired lease may be reclaimed by another moderator, but expiration
    // alone must not destroy completed work. The original editor may still
    // save while the lock UID is theirs; once somebody reclaims it, the UID
    // changes atomically and this check safely rejects the old editor.
    if (clean(currentData.moderation_lock_uid) !== moderator.uid) {
      throw Object.assign(new Error('Этот лайнап уже взял другой модератор. Обнови очередь.'), { status: 409 });
    }
    const extras = Array.isArray(data.extra_abilities) ? data.extra_abilities.slice(0, 2).map((item, index) => ({
      ability: clean(item?.ability).slice(0, 80), icon: clean(item?.icon).slice(0, 1000), order: index + 1,
      trajectory: safePoints(item?.trajectory), range_radius: Math.max(0, Math.min(.5, Number(item?.range_radius) || 0)),
      effect_shape: clean(item?.effect_shape || 'circle').slice(0, 30),
    })) : [];
    const contentType = ['lineup', 'combo', 'wallbang', 'defense'].includes(clean(data.content_type || data.category))
      ? clean(data.content_type || data.category)
      : clean(currentData.content_type || currentData.category || 'lineup');
      const update = {
      map: clean(data.map).slice(0, 40), agent: clean(data.agent).slice(0, 40), ability: clean(data.ability).slice(0, 80),
      title: clean(data.title).slice(0, 100), description: clean(data.description).slice(0, 1000),
      difficulty: clean(data.difficulty).slice(0, 20), round_side: clean(data.round_side).slice(0, 20),
      position_x: finite01(data.position_x), position_y: finite01(data.position_y), trajectory: safePoints(data.trajectory),
        extra_abilities: extras, range_radius: Math.max(0, Math.min(.5, Number(data.range_radius) || 0)),
        sova_charge: Math.max(0, Math.min(3, Number(data.sova_charge ?? 3))),
        sova_bounces: Math.max(0, Math.min(2, Math.trunc(Number(data.sova_bounces) || 0))),
      screenshots: Array.isArray(data.screenshots) ? data.screenshots.slice(0, 8).map(value => clean(value).slice(0, 1000)) : [],
      video_url: data.video_remove_requested === true
        ? ''
        : clean(data.video_url || currentData.video_url).slice(0, 1000),
      user_id: authorUid, submitted_by: authorName,
      category: contentType, content_type: contentType, status: 'pending', moderator_only: false,
      edited_by_moderator_uid: moderator.uid, edited_at: FieldValue.serverTimestamp(), submitted_at: FieldValue.serverTimestamp(),
      edited_by_moderator_name: moderator.name,
      moderator_changes_saved: true,
      moderator_change_note: `Изменения сохранены модератором ${moderator.name}`.slice(0, 160),
      moderator_template_completed: true,
      moderator_autosave: FieldValue.delete(), moderator_autosaved_at: FieldValue.delete(),
      moderation_lock_uid: FieldValue.delete(), moderation_lock_name: FieldValue.delete(),
        moderation_lock_expires_at: FieldValue.delete(),
      };
      const sovaArrow = ['sova', 'сова'].includes(clean(data.agent).toLowerCase()) &&
        /shock|recon|шок|развед|стрел/.test(clean(data.ability).toLowerCase());
      if (!sovaArrow) {
        update.sova_charge = FieldValue.delete();
        update.sova_bounces = FieldValue.delete();
      }
    if (contentType === 'defense') {
      const zoom = data.zoom_area || {};
      update.site = clean(data.site).slice(0, 10);
      update.number = Math.max(1, Math.min(999, Math.trunc(Number(data.number) || 1)));
      update.zoom_area = {
        x: finite01(zoom.x), y: finite01(zoom.y),
        width: Math.max(.01, Math.min(1, Number(zoom.width) || .25)),
        height: Math.max(.01, Math.min(1, Number(zoom.height) || .25)),
      };
      update.abilities = safeDefenseAbilities(data.abilities);
      update.position_x = 0;
      update.position_y = 0;
      update.trajectory = [];
    }
    tx.update(ref, update);
    const completedTemplateKey = moderatorTemplateKey(currentData);
    if (completedTemplateKey) {
      templatesSnap.docs.forEach(templateDoc => {
        if (templateDoc.id === lineupId) return;
        const template = templateDoc.data() || {};
        if (moderatorTemplateKey(template) !== completedTemplateKey) return;
        tx.update(templateDoc.ref, {
          status: 'duplicate',
          moderator_only: false,
          moderator_template_completed: true,
          duplicate_of: lineupId,
          duplicate_marked_at: FieldValue.serverTimestamp(),
        });
      });
    }
    if (claimSnap.exists && clean(claimSnap.data()?.lineup_id) === lineupId) tx.delete(claimRef);
  });
  res.status(200).json({ ok: true, id: lineupId, status: 'pending' });
}

async function autosaveDraft(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  const data = req.body?.data || {};
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  const db = getFirestore();
  const ref = db.collection('lineups').doc(lineupId);
  const claimRef = db.collection('moderation_claims').doc(moderator.uid);
  const expiresAt = new Date(Date.now() + MODERATION_LOCK_MS);
  await db.runTransaction(async tx => {
    const [snap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    if (!snap.exists) throw Object.assign(new Error('Lineup not found'), { status: 404 });
    const current = snap.data() || {};
    if (!['pending', 'moderator_draft'].includes(current.status)) throw Object.assign(new Error('Лайнап уже обработан'), { status: 409 });
    if (clean(current.moderation_lock_uid) !== moderator.uid) {
      throw Object.assign(new Error('Бронь лайнапа потеряна. Обнови очередь.'), { status: 409 });
    }
    const contentType = ['lineup', 'combo', 'wallbang', 'defense'].includes(clean(data.content_type || data.category))
      ? clean(data.content_type || data.category)
      : clean(current.content_type || current.category || 'lineup');
    const autosave = {
      map: clean(data.map).slice(0, 40), agent: clean(data.agent).slice(0, 40), ability: clean(data.ability).slice(0, 80),
      title: clean(data.title).slice(0, 100), description: clean(data.description).slice(0, 1000),
      difficulty: clean(data.difficulty).slice(0, 20), round_side: clean(data.round_side).slice(0, 20),
      position_x: finite01(data.position_x), position_y: finite01(data.position_y), trajectory: safePoints(data.trajectory),
      extra_abilities: Array.isArray(data.extra_abilities) ? data.extra_abilities.slice(0, 2).map((item, index) => ({
        ability: clean(item?.ability).slice(0, 80), icon: clean(item?.icon).slice(0, 1000), order: index + 1,
        trajectory: safePoints(item?.trajectory), range_radius: Math.max(0, Math.min(.5, Number(item?.range_radius) || 0)),
        effect_shape: clean(item?.effect_shape || 'circle').slice(0, 30),
      })) : [],
      screenshots: Array.isArray(data.screenshots) ? data.screenshots.slice(0, 8).map(value => clean(value).slice(0, 1000)) : [],
      video_url: data.video_remove_requested === true ? '' : clean(data.video_url || current.video_url).slice(0, 1000),
      user_id: clean(data.user_id || current.user_id || current.uid || current.author_uid).slice(0, 128),
      submitted_by: clean(data.submitted_by || current.submitted_by || current.author).slice(0, 80),
      category: contentType, content_type: contentType,
    };
    if (['sova', 'сова'].includes(autosave.agent.toLowerCase()) && /shock|recon|шок|развед|стрел/.test(autosave.ability.toLowerCase())) {
      autosave.sova_charge = Math.max(0, Math.min(3, Number(data.sova_charge ?? 3)));
      autosave.sova_bounces = Math.max(0, Math.min(2, Math.trunc(Number(data.sova_bounces) || 0)));
    }
    if (contentType === 'defense') {
      const zoom = data.zoom_area || {};
      autosave.site = clean(data.site).slice(0, 10);
      autosave.number = Math.max(1, Math.min(999, Math.trunc(Number(data.number) || 1)));
      autosave.zoom_area = {
        x: finite01(zoom.x), y: finite01(zoom.y),
        width: Math.max(.01, Math.min(1, Number(zoom.width) || .25)),
        height: Math.max(.01, Math.min(1, Number(zoom.height) || .25)),
      };
      autosave.abilities = safeDefenseAbilities(data.abilities);
      autosave.position_x = 0;
      autosave.position_y = 0;
      autosave.trajectory = [];
    }
    if (contentType === 'wallbang') {
      autosave.weapons = Array.isArray(data.weapons) ? data.weapons.slice(0, 20).map(value => clean(value).slice(0, 80)) : [];
      autosave.target_x = finite01(data.target_x);
      autosave.target_y = finite01(data.target_y);
    }
    tx.update(ref, {
      moderator_autosave: autosave,
      moderator_autosaved_at: FieldValue.serverTimestamp(),
      moderation_lock_expires_at: expiresAt,
    });
    tx.set(claimRef, {
      lineup_id: lineupId,
      moderator_name: moderator.name,
      expires_at: expiresAt,
      updated_at: FieldValue.serverTimestamp(),
    });
  });
  res.status(200).json({ ok: true, id: lineupId, expires_at: expiresAt.getTime() });
}

async function listQueue(res, moderator) {
  const db = getFirestore();
  const [pendingSnap, moderatorSnap, metadataSnap, staffCountSnap] = await Promise.all([
    // Admin-created pending lineups can have created_at without submitted_at.
    // orderBy('submitted_at') silently excludes those documents from the queue.
    db.collection('lineups').where('status', '==', 'pending').get(),
    db.collection('lineups').where('moderator_only', '==', true).get(),
    db.collection('lineups').where('metadata_review_required', '==', true).get(),
    // The shared live window contains two tasks per person who can moderate.
    // count() avoids downloading every user document just to size the queue.
    db.collection('users').where('role', 'in', ['admin', 'moderator']).count().get(),
  ]);
  const queueDocs = [
    ...pendingSnap.docs.filter(doc => isQueuedForModeration(doc.data() || {})),
    ...moderatorSnap.docs.filter(doc => doc.data()?.status === 'moderator_draft' && isQueuedForModeration(doc.data() || {})),
    ...metadataSnap.docs.filter(doc => isQueuedForModeration(doc.data() || {})),
  ];
  // Queries intentionally cover overlapping moderation states. A lineup may
  // match more than one query, but it must only appear once in the queue.
  const uniqueQueueDocs = [...new Map(queueDocs.map(doc => [doc.id, doc])).values()];
  const seenTemplateKeys = new Set();
  const queue = uniqueQueueDocs
    .sort((a, b) => timestampMillis(a.data()?.submitted_at || a.data()?.created_at) - timestampMillis(b.data()?.submitted_at || b.data()?.created_at))
    .filter(doc => {
      const key = moderatorTemplateKey(doc.data() || {});
      if (!key) return true;
      if (seenTemplateKeys.has(key)) return false;
      seenTemplateKeys.add(key);
      return true;
    })
    .map(doc => safeLineup(doc, moderator.uid))
    .sort((a, b) => a.submitted_at - b.submitted_at);
  const total = queue.length;
  const staffCount = Number(staffCountSnap.data().count) || 1;
  const capacity = staffCount * 2;
  // Other people's claimed work is not offered as part of the shared window.
  // The owner's task stays visible and atomic claim transactions remain the
  // final protection against two people taking the same lineup simultaneously.
  const items = queue
    .filter(item => !item.moderation_lock_active || item.moderation_lock_owned)
    .slice(0, capacity);
  res.status(200).json({ items, total, capacity, staff_count: staffCount });
}

async function listLocks(req, res, moderator) {
  const ids = clean(req.query?.locks).split(',').filter(id => /^[A-Za-z0-9_-]{6,128}$/.test(id)).slice(0, 50);
  if (!ids.length) return res.status(200).json({ locks: {} });
  const db = getFirestore();
  const refs = ids.map(id => db.collection('lineups').doc(id));
  const snaps = await db.getAll(...refs);
  const locks = {};
  const processed = [];
  snaps.forEach(snap => {
    if (!snap.exists) {
      processed.push(snap.id);
      return;
    }
    const data = snap.data() || {};
    if (!isQueuedForModeration(data)) {
      processed.push(snap.id);
      return;
    }
    const expiresAt = timestampMillis(data.moderation_lock_expires_at);
    if (clean(data.moderation_lock_uid) && expiresAt > Date.now()) {
      locks[snap.id] = {
        active: true,
        owned: clean(data.moderation_lock_uid) === moderator.uid,
        name: clean(data.moderation_lock_name).slice(0, 80),
        expires_at: expiresAt,
      };
    }
  });
  res.status(200).json({ locks, processed });
}

async function claimDraft(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  const db = getFirestore();
  const ref = db.collection('lineups').doc(lineupId);
  const claimRef = db.collection('moderation_claims').doc(moderator.uid);
  const expiresAt = new Date(Date.now() + MODERATION_LOCK_MS);
  await db.runTransaction(async tx => {
    const [snap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    if (!snap.exists) throw Object.assign(new Error('Lineup not found'), { status: 404 });
    const data = snap.data() || {};
    const metadataTask = data.status === 'approved' && data.metadata_review_required === true && missingMetadata(data).length > 0;
    if (!['pending', 'moderator_draft'].includes(data.status) && !metadataTask) {
      throw Object.assign(new Error('Лайнап уже обработан'), { status: 409 });
    }
    const lockUid = clean(data.moderation_lock_uid);
    const lockActive = lockUid && timestampMillis(data.moderation_lock_expires_at) > Date.now();
    if (lockActive && lockUid !== moderator.uid) {
      throw Object.assign(new Error(`Этот лайнап уже редактирует ${clean(data.moderation_lock_name) || 'другой модератор'}`), { status: 409 });
    }
    const currentClaim = claimSnap.data() || {};
    const claimedLineupId = clean(currentClaim.lineup_id);
    const claimedUntil = timestampMillis(currentClaim.expires_at);
    if (claimedLineupId && claimedLineupId !== lineupId && claimedUntil > Date.now()) {
      throw Object.assign(new Error('У тебя уже есть задание в работе. Заверши его или нажми «Отказаться».'), { status: 409 });
    }
    tx.update(ref, {
      moderation_lock_uid: moderator.uid,
      moderation_lock_name: moderator.name,
      moderation_lock_expires_at: expiresAt,
    });
    tx.set(claimRef, {
      lineup_id: lineupId,
      moderator_name: moderator.name,
      expires_at: expiresAt,
      updated_at: FieldValue.serverTimestamp(),
    });
  });
  res.status(200).json({ ok: true, expires_at: expiresAt.getTime() });
}

async function releaseClaim(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  const db = getFirestore();
  const ref = db.collection('lineups').doc(lineupId);
  const claimRef = db.collection('moderation_claims').doc(moderator.uid);
  await db.runTransaction(async tx => {
    const [snap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    if (!snap.exists) return;
    const data = snap.data() || {};
    if (clean(data.moderation_lock_uid) !== moderator.uid) return;
    tx.update(ref, {
      moderation_lock_uid: FieldValue.delete(),
      moderation_lock_name: FieldValue.delete(),
      moderation_lock_expires_at: FieldValue.delete(),
      moderator_autosave: FieldValue.delete(),
      moderator_autosaved_at: FieldValue.delete(),
    });
    if (claimSnap.exists && clean(claimSnap.data()?.lineup_id) === lineupId) tx.delete(claimRef);
  });
  res.status(200).json({ ok: true });
}

async function completeMetadata(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  const input = req.body?.data || {};
  const db = getFirestore();
  const ref = db.collection('lineups').doc(lineupId);
  const claimRef = db.collection('moderation_claims').doc(moderator.uid);
  await db.runTransaction(async tx => {
    const [snap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    if (!snap.exists) throw Object.assign(new Error('Lineup not found'), { status: 404 });
    const current = snap.data() || {};
    if (current.status !== 'approved' || current.metadata_review_required !== true) throw Object.assign(new Error('Задание уже выполнено'), { status: 409 });
    if (clean(current.moderation_lock_uid) !== moderator.uid) throw Object.assign(new Error('Этот лайнап уже взял другой модератор'), { status: 409 });
    const update = {};
    if (!['easy', 'medium', 'hard'].includes(clean(current.difficulty))) {
      const value = clean(input.difficulty);
      if (!['easy', 'medium', 'hard'].includes(value)) throw Object.assign(new Error('Укажи сложность'), { status: 400 });
      update.difficulty = value;
    }
    if (!['attack', 'defense', 'any'].includes(clean(current.round_side))) {
      const value = clean(input.round_side);
      if (!['attack', 'defense', 'any'].includes(value)) throw Object.assign(new Error('Укажи сторону раунда'), { status: 400 });
      update.round_side = value;
    }
    const shotAbilities = sovaShotAbilities(current);
    if (shotAbilities.length && normalizedSovaShots(current).length < shotAbilities.length) {
      const rawShots = Array.isArray(input.sova_shots) ? input.sova_shots : [];
      if (rawShots.length !== shotAbilities.length) throw Object.assign(new Error('Настрой все стрелы по порядку'), { status: 400 });
      const shots = rawShots.map((item, index) => {
        const charge = Number(item?.charge);
        const bounces = normalizedSovaBounces(item?.bounces ?? 0);
        if (!Number.isFinite(charge) || charge < 0 || charge > 3 || bounces === null) {
          throw Object.assign(new Error(`Проверь параметры ${index + 1}-й стрелы`), { status: 400 });
        }
        return { order: index + 1, ability: shotAbilities[index], charge, bounces };
      });
      update.sova_shots = shots;
      update.sova_charge = shots[0].charge;
      update.sova_bounces = shots[0].bounces;
    }
    const merged = { ...current, ...update };
    if (missingMetadata(merged).length) throw Object.assign(new Error('Заполни все недостающие параметры'), { status: 400 });
    Object.assign(update, {
      metadata_review_required: false,
      metadata_review_completed_at: FieldValue.serverTimestamp(),
      metadata_reviewed_by_uid: moderator.uid,
      metadata_reviewed_by_name: moderator.name,
      moderation_lock_uid: FieldValue.delete(), moderation_lock_name: FieldValue.delete(), moderation_lock_expires_at: FieldValue.delete(),
    });
    tx.update(ref, update);
    if (claimSnap.exists && clean(claimSnap.data()?.lineup_id) === lineupId) tx.delete(claimRef);
    tx.create(db.collection('moderator_logs').doc(), { lineup_id: lineupId, action: 'complete_metadata', fields: Object.keys(update), moderator_uid: moderator.uid, moderator_role: moderator.role, created_at: FieldValue.serverTimestamp() });
  });
  res.status(200).json({ ok: true });
}

async function seedMetadataQueue(res, moderator) {
  if (moderator.role !== 'admin') return res.status(403).json({ error: 'Только администратор может сформировать очередь' });
  const db = getFirestore();
  const stateRef = db.collection('settings').doc('metadata_review_backfill_v2');
  const state = await stateRef.get();
  if (state.data()?.completed === true) return res.status(200).json({ ok: true, already_completed: true, queued: Number(state.data()?.queued || 0) });
  const snap = await db.collection('lineups').where('status', '==', 'approved').get();
  const targets = snap.docs.filter(doc => missingMetadata(doc.data()).length > 0);
  for (let offset = 0; offset < targets.length; offset += 400) {
    const batch = db.batch();
    targets.slice(offset, offset + 400).forEach(doc => batch.update(doc.ref, { metadata_review_required: true }));
    await batch.commit();
  }
  await stateRef.set({ completed: true, queued: targets.length, scanned: snap.size, completed_at: FieldValue.serverTimestamp() });
  res.status(200).json({ ok: true, queued: targets.length, scanned: snap.size });
}

async function moderate(req, res, moderator) {
  const lineupId = clean(req.body?.lineupId);
  const action = clean(req.body?.action);
  if (action === 'autosave_draft') {
    checkAutosaveRate(moderator.uid);
    return autosaveDraft(req, res, moderator);
  }
  checkActionRate(moderator.uid);
  if (action === 'save_draft') return saveDraft(req, res, moderator);
  if (action === 'seed_metadata_queue') return seedMetadataQueue(res, moderator);
  if (action === 'complete_metadata') return completeMetadata(req, res, moderator);
  if (action === 'release_claim') return releaseClaim(req, res, moderator);
  if (action === 'claim' || action === 'renew_claim') return claimDraft(req, res, moderator);
  const reason = clean(req.body?.reason);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(lineupId)) return res.status(400).json({ error: 'Invalid lineup id' });
  if (action !== 'reject') return res.status(400).json({ error: 'Модератору недоступна отправка в «Пирожки»' });
  if (reason.length < 10 || reason.length > 500) {
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
    const lockUid = clean(data.moderation_lock_uid);
    if (lockUid && lockUid !== moderator.uid && timestampMillis(data.moderation_lock_expires_at) > Date.now()) {
      throw Object.assign(new Error(`Этот лайнап сейчас редактирует ${clean(data.moderation_lock_name) || 'другой модератор'}`), { status: 409 });
    }
    authorUid = clean(data.user_id || data.uid || data.author_uid);
    const update = {
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
      reason,
      moderator_uid: moderator.uid,
      moderator_role: moderator.role,
      created_at: FieldValue.serverTimestamp(),
    });
    if (authorUid) {
      tx.create(db.collection('notifications').doc(authorUid).collection('items').doc(), {
        type: 'lineup_rejected',
        lineup_id: lineupId,
        title: 'Ваш лайнап отклонён',
        body: `${reason.length > 80 ? `${reason.slice(0, 77)}…` : reason} Нажми, чтобы прочитать полностью. На сайте будет более подробная информация.`,
        reason,
        lineup_title: clean(data.title).slice(0, 100),
        map: clean(data.map).slice(0, 40),
        agent: clean(data.agent).slice(0, 40),
        ability: clean(data.ability).slice(0, 80),
        round_side: clean(data.round_side).slice(0, 20),
        category: clean(data.content_type || data.category).slice(0, 20),
        is_read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    }
  });
  res.status(200).json({ ok: true, status: 'rejected' });
}

export default async function handler(req, res) {
  setSecurityHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (rejectForeignOrigin(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const moderator = await authorize(req);
    if (req.method === 'GET') {
      if (req.query?.q !== undefined) return await searchAuthors(req, res);
      if (req.query?.locks !== undefined) return await listLocks(req, res, moderator);
      return await listQueue(res, moderator);
    }
    return await moderate(req, res, moderator);
  } catch (error) {
    const status = Number(error.status) || (error.code?.startsWith('auth/') ? 401 : 500);
    if (status >= 500) console.error('moderation error:', error);
    return res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  }
}
