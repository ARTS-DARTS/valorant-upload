import { initializeApp }                    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth,
         signInWithEmailAndPassword, signInWithCustomToken,
         signOut, onAuthStateChanged }
                                             from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, deleteDoc, writeBatch,
          serverTimestamp, onSnapshot,
          query, where, getDocs, limit }      from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const cfg = {
  apiKey:            'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww',
  authDomain:        'valorant-linemaps.firebaseapp.com',
  projectId:         'valorant-linemaps',
  storageBucket:     'valorant-linemaps.firebasestorage.app',
  messagingSenderId: '288103111419',
  appId:             '1:288103111419:web:daca10a760282d40996e5e',
};

const app  = initializeApp(cfg);
const auth = getAuth(app);
const db   = getFirestore(app);
const UPLOAD_REQUIRED_VIEWS = 5;
const USER_TRACKING_START = new Date('2026-06-20T00:00:00Z');
const SITE_VERSION = '2026-07-10T21:56:00+03:00';
const SITE_VERSION_POLL_MS = 60 * 1000;

const SEL_ACCESS_KEY = '6eac43cff0e4498c864fc36fdcd27a64';
const SEL_SECRET_KEY = 'e2ffe93a51ba4c05abadc810d9c0edfc';
const SEL_S3_HOST    = 'valorant-lineups-video.s3.ru-3.storage.selcloud.ru';
const SEL_REGION     = 'ru-3';
const SEL_CDN_URL    = 'https://d5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru';

// ── Utils ─────────────────────────────────────────────────────────────────────
function rangeConfigId(map, agent, ability) {
  return (String(map || '') + '__' + String(agent || '') + '__' + String(ability || '')).replace(/[\\/. ]/g, '_');
}

function repairMojibake(value) {
  const s = String(value ?? '').trim();
  if (!s || !/[ÐÑР]/.test(s)) return s;
  try {
    const cp1251 = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–— ™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
    const bytes = [];
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 128) {
        bytes.push(code);
        continue;
      }
      const idx = cp1251.indexOf(ch);
      if (idx < 0) return s;
      bytes.push(0x80 + idx);
    }
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return /[А-Яа-яЁё]/.test(repaired) ? repaired : s;
  } catch (_) {
    return s;
  }
}

function firstText(...values) {
  for (const value of values) {
    const s = repairMojibake(value);
    if (s) return s;
  }
  return '';
}

function normalizeContentCategory(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'smoke') return 'wallbang';
  return raw;
}

const ENABLED_UPLOAD_CONTENT_TYPES = new Set(['lineup']);

function canSubmitContentCategory(value) {
  return ENABLED_UPLOAD_CONTENT_TYPES.has(normalizeContentCategory(value));
}

function toSafeErrorMessage(error) {
  const code = String(error?.code || '').toLowerCase();
  const msg = String(error?.message || error || '');
  if (code.includes('permission-denied') || /permission|permission-denied|insufficient/i.test(msg)) {
    if (!canCurrentUserUpload()) return uploadGateMessage();
    return 'Сервер не принял лайнап. Обнови страницу и попробуй ещё раз. Ошибка уже записана в логи.';
  }
  return msg || 'Неизвестная ошибка';
}

async function logUploadError(error, context = {}) {
  if (!auth.currentUser) return;
  try {
    await setDoc(doc(collection(db, 'app_errors')), {
      type: 'web',
      source: 'upload_site',
      message: String(error?.message || error || 'Unknown upload site error').slice(0, 1000),
      code: String(error?.code || '').slice(0, 100),
      stack: String(error?.stack || '').slice(0, 4000),
      context,
      uid: auth.currentUser.uid,
      user_id: auth.currentUser.uid,
      user_name: currentUserProfile?.name || currentUserProfile?.username || currentUserProfile?.displayName || auth.currentUser.displayName || '',
      user_email: currentUserProfile?.email || currentUserProfile?.user_email || auth.currentUser.email || '',
      platform: 'web',
      appVersion: 'upload-site',
      url: location.href,
      userAgent: navigator.userAgent,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.warn('logUploadError', e.message);
  }
}

function diagnosticTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function userDiagnostics(profile = currentUserProfile || {}) {
  const info = userTrialInfo(profile);
  const role = String(profile.role || 'user');
  return {
    uid: auth.currentUser?.uid || '',
    name: profile.name || profile.username || profile.displayName || auth.currentUser?.displayName || '',
    email: profile.email || profile.user_email || auth.currentUser?.email || '',
    role,
    is_admin_or_moderator: role === 'admin' || role === 'moderator',
    can_upload: role === 'admin' || role === 'moderator' || info.verified,
    gate_message: role === 'admin' || role === 'moderator' || info.verified ? '' : uploadGateMessage(),
    lineups_viewed: info.viewed,
    approved_lineups: Number(profile.approved_lineups || 0),
    bonus_lineups: Number(profile.bonus_lineups || 0),
    verified_not_fake: !!profile.verified_not_fake,
    pre_tracking: info.preTracking,
    created_at: diagnosticTimestamp(profile.created_at),
    last_seen: diagnosticTimestamp(profile.last_seen),
  };
}

function submitFormDiagnostics({ title = '', desc = '', map = '', ability = '', contentType = '' } = {}) {
  const reasons = [];
  if (!currentUser) reasons.push('no_current_user');
  if (!map) reasons.push('missing_map');
  if (!selectedAgent) reasons.push('missing_agent');
  if (!ability) reasons.push('missing_normalized_ability');
  if (!selectedAbility) reasons.push('missing_selected_ability');
  if (!selectedCategory) reasons.push('missing_category');
  if (!canSubmitContentCategory(contentType || selectedCategory)) reasons.push('content_type_closed');
  if (!selectedDifficulty) reasons.push('missing_difficulty');
  if (!title.trim()) reasons.push('missing_title');
  if (title.length > 100) reasons.push('title_too_long');
  if (desc.length > 1000) reasons.push('description_too_long');
  if (markerX === null || markerY === null) reasons.push('missing_marker');
  if (screenshots.some(s => s.uploading)) reasons.push('screenshots_uploading');
  return {
    client_ok: reasons.length === 0,
    client_block_reasons: reasons,
    title_length: title.length,
    description_length: desc.length,
    has_video: !!videoUrl,
    screenshots_total: screenshots.length,
    screenshots_uploaded: screenshots.filter(s => s.cloudUrl).length,
    marker_x: markerX,
    marker_y: markerY,
    trajectory_points: trajectoryPoints.length,
  };
}

function userTrialInfo(u = {}) {
  const viewed = Number(u.lineups_viewed || 0);
  const approved = Number(u.approved_lineups || 0);
  const created = u.created_at?.toDate?.() ?? null;
  const preTracking = created !== null && created < USER_TRACKING_START;
  const verified = !!u.verified_not_fake || viewed >= UPLOAD_REQUIRED_VIEWS || approved > 0 || preTracking;
  return { viewed, approved, verified, preTracking };
}

function uploadGateMessage() {
  const viewed = Number(currentUserProfile?.lineups_viewed || 0);
  const left = Math.max(0, UPLOAD_REQUIRED_VIEWS - viewed);
  if (left <= 0) {
    return 'Просмотры уже выполнены. Обнови страницу и попробуй отправить ещё раз.';
  }
  return `Чтобы выкладывать лайнапы, сначала посмотри ${UPLOAD_REQUIRED_VIEWS} лайнапов в приложении. Осталось: ${left}. Спасибо!`;
}

function canCurrentUserUpload() {
  const role = String(currentUserProfile?.role || 'user');
  return role === 'admin' || role === 'moderator' || userTrialInfo(currentUserProfile || {}).verified;
}

function safePlay(player) {
  const playPromise = player?.play?.();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(error => {
      const msg = String(error?.message || error || '');
      if (/interrupted by a call to pause|interrupted by a new load request|play\(\) request was interrupted/i.test(msg)) {
        return;
      }
      logUploadError(error, { action: 'media_play' });
    });
  }
}

function updateUploadGate() {
  const box = document.getElementById('upload-gate');
  if (!box) return;
  if (!currentUser || canCurrentUserUpload()) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = 'block';
  box.textContent = uploadGateMessage();
}

window.addEventListener('error', event => {
  logUploadError(event.error || event.message, {
    action: 'window_error',
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener('unhandledrejection', event => {
  logUploadError(event.reason || 'Unhandled rejection', { action: 'unhandledrejection' });
});

function showSiteUpdateBanner() {
  document.getElementById('site-update-banner')?.classList.add('show');
}

function hideSiteUpdateBanner() {
  document.getElementById('site-update-banner')?.classList.remove('show');
}

async function checkSiteVersion() {
  try {
    const res = await fetch(`/site-version.json?v=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const liveVersion = String(data.version || '').trim();
    if (liveVersion && liveVersion !== SITE_VERSION) showSiteUpdateBanner();
    else hideSiteUpdateBanner();
  } catch (_) {}
}

function initSiteVersionWatcher() {
  document.getElementById('btn-reload-site')?.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('site_refresh', Date.now().toString());
    window.location.replace(url.toString());
  });
  checkSiteVersion();
  setInterval(checkSiteVersion, SITE_VERSION_POLL_MS);
}

async function getConfiguredRangeRadius(map, agent, ability, abilityAliases = []) {
  if (!map || !agent || !ability) return 0;
  const names = [...new Set([ability, ...abilityAliases].filter(Boolean).map(String))];
  for (const name of names) {
    try {
      const snap = await getDoc(doc(db, 'range_config', rangeConfigId(map, agent, name)));
      const radius = Number(snap.data()?.range_radius || 0);
      if (Number.isFinite(radius) && radius > 0) return radius;
    } catch (e) {
      console.warn('getConfiguredRangeRadius', name, e.message);
    }
  }
  return 0;
}

function toast(msg, type = 'i') {
  const container = document.getElementById('toasts');
  if (container.children.length >= 4) container.firstChild?.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function videoContentType(file) {
  if (file.type) return file.type;
  if (/\.mov$/i.test(file.name)) return 'video/quicktime';
  return 'video/mp4';
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
function compressImage(file) {
  if (file.size < 300 * 1024) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1280;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) { const s = MAX / Math.max(w,h); w = Math.round(w*s); h = Math.round(h*s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => { if (blob) resolve(blob); else reject(new Error('toBlob вернул null')); }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ошибка загрузки изображения')); };
    img.src = url;
  });
}

function uploadToCloudinary(blob, onProgress) {
  const fd = new FormData();
  fd.append('file', blob, 'screenshot.jpg');
  fd.append('upload_preset', '4343242');
  fd.append('folder', 'lineups_screenshots');
  let xhr;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/djxgwkbqn/image/upload');
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).secure_url); }
        catch { reject(new Error('Неверный ответ Cloudinary')); }
      } else { reject(new Error('Cloudinary ' + xhr.status)); }
    };
    xhr.onerror = () => reject(new Error('Сетевая ошибка'));
    xhr.onabort = () => reject(new Error('canceled'));
    xhr.send(fd);
  });
  promise.abort = () => xhr?.abort();
  return promise;
}

// ── AWS4 helpers (SubtleCrypto) ───────────────────────────────────────────────
async function _sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function _hmacSha256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const kObj = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', kObj, d));
}
function _selPadZ(n) { return String(n).padStart(2, '0'); }
function _selAwsDate(d) { return `${d.getUTCFullYear()}${_selPadZ(d.getUTCMonth()+1)}${_selPadZ(d.getUTCDate())}`; }
function _selAwsDateTime(d) { return `${_selAwsDate(d)}T${_selPadZ(d.getUTCHours())}${_selPadZ(d.getUTCMinutes())}${_selPadZ(d.getUTCSeconds())}Z`; }
async function _selSigningKey(dateStamp) {
  let k = await _hmacSha256('AWS4' + SEL_SECRET_KEY, dateStamp);
  k = await _hmacSha256(k, SEL_REGION);
  k = await _hmacSha256(k, 's3');
  k = await _hmacSha256(k, 'aws4_request');
  return k;
}

function uploadVideoToSelectel(file, onProgress) {
  const fileName  = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const objectKey = `lineups_videos/${fileName}`;
  let xhr = null;
  let aborted = false;

  const promise = new Promise(async (resolve, reject) => {
    try {
      const now        = new Date();
      const dateStamp  = _selAwsDate(now);
      const amzDate    = _selAwsDateTime(now);
      const buffer     = await file.arrayBuffer();
      if (aborted) { reject(new Error('canceled')); return; }

      const contentType   = videoContentType(file);
      const payloadHash   = await _sha256Hex(buffer);
      const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
      const canonHeaders  = `content-type:${contentType}\nhost:${SEL_S3_HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
      const canonRequest  = ['PUT', `/${objectKey}`, '', canonHeaders, signedHeaders, payloadHash].join('\n');
      const credScope     = `${dateStamp}/${SEL_REGION}/s3/aws4_request`;
      const strToSign     = ['AWS4-HMAC-SHA256', amzDate, credScope, await _sha256Hex(canonRequest)].join('\n');
      const signingKey    = await _selSigningKey(dateStamp);
      const signature     = (await _hmacSha256(signingKey, strToSign)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
      const auth          = `AWS4-HMAC-SHA256 Credential=${SEL_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

      if (aborted) { reject(new Error('canceled')); return; }

      xhr = new XMLHttpRequest();
      xhr.open('PUT', `https://${SEL_S3_HOST}/${objectKey}`);
      xhr.setRequestHeader('Authorization', auth);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('x-amz-content-sha256', payloadHash);
      xhr.setRequestHeader('x-amz-date', amzDate);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(`${SEL_CDN_URL}/${objectKey}`);
        else reject(new Error('Selectel upload error: ' + xhr.status + ' ' + xhr.responseText));
      };
      xhr.onerror = () => reject(new Error('Сетевая ошибка'));
      xhr.onabort = () => reject(new Error('canceled'));
      xhr.send(buffer);
    } catch (e) { reject(e); }
  });

  promise.abort = () => { aborted = true; xhr?.abort(); };
  return promise;
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser      = null;
let currentUserProfile = null;
let agentsList       = [];
let mapsData         = [];
let selectedAgent    = null;
let selectedAbility  = null;
let selectedCategory = null;
let selectedDifficulty = null;
let markerX = null, markerY = null;
let trajectoryPoints = [];
let mapMode = 'position';
let videoUrl = null;
let videoXhr = null;
let videoEdit = createDefaultVideoEdit();
let screenshots = [];
let currentUserLineups = [];
let authorMaterials = [];
let authorMaterialsLoaded = false;
let authorMaterialsLoading = false;
let authorMaterialsError = '';
let materialEditorId = '';
let materialVideoUploading = false;
let materialVideoUploadSeq = 0;
let activeWorkspaceTab = 'upload';
let myLineupsStatusFilter = 'all';
let myLineupsSearch = '';
let resubmissionSourceId = '';

// ── Stats sidebar ─────────────────────────────────────────────────────────────
let _statsUnsub = null;
let _cooldownInterval = null;
let _profileUnsub = null;

const LEVELS = [
  { min: 0,   name: 'Новобранец', icon: '🎯', color: '#808080', cooldownMinutes: 60 },
  { min: 3,   name: 'Разведчик',  icon: '🔍', color: '#4FC3F7', cooldownMinutes: 45 },
  { min: 7,   name: 'Агент',      icon: '⚡', color: '#66BB6A', cooldownMinutes: 30 },
  { min: 15,  name: 'Специалист', icon: '💎', color: '#AB47BC', cooldownMinutes: 15 },
  { min: 30,  name: 'Ветеран',    icon: '🔥', color: '#FF7043', cooldownMinutes: 5 },
  { min: 50,  name: 'Элита',      icon: '👑', color: '#FFD700', cooldownMinutes: 2 },
  { min: 100, name: 'Легенда',    icon: '🏆', color: '#FF4655', cooldownMinutes: 0 },
];
let _approvedLineups = 0;

function effectiveApprovedLineups(factualApproved = 0) {
  const storedApproved = Number(currentUserProfile?.approved_lineups || 0);
  const bonusLineups = Number(currentUserProfile?.bonus_lineups || 0);
  return Math.max(storedApproved, factualApproved) + bonusLineups;
}

function calculateLevel(approved) {
  return LEVELS.reduce((cur, lv) => approved >= lv.min ? lv : cur, LEVELS[0]);
}

function cooldownMinutesFor(approved) {
  return calculateLevel(approved).cooldownMinutes;
}

function _updateLevelDisplay(approved) {
  _approvedLineups = approved;
  const lv = calculateLevel(approved);
  document.getElementById('level-icon').textContent = lv.icon;
  const nameEl = document.getElementById('level-name');
  nameEl.textContent = lv.name;
  nameEl.style.color = lv.color;
}

function _clearCooldownTimer() {
  if (_cooldownInterval) { clearInterval(_cooldownInterval); _cooldownInterval = null; }
}

function _showCooldownReady() {
  _clearCooldownTimer();
  const badge = document.getElementById('cooldown-badge');
  if (badge) { badge.textContent = '✓ Можно'; badge.style.color = 'var(--green)'; }
}

function _startCooldownTimer(remainMs) {
  _clearCooldownTimer();
  const badge = document.getElementById('cooldown-badge');
  const startTime = Date.now();
  function tick() {
    const rem = remainMs - (Date.now() - startTime);
    if (rem <= 0) { _showCooldownReady(); return; }
    const mins = Math.floor(rem / 60000);
    const secs = Math.floor((rem % 60000) / 1000);
    if (badge) { badge.textContent = `КД: ${mins}:${String(secs).padStart(2, '0')}`; badge.style.color = 'var(--orange)'; }
  }
  tick();
  _cooldownInterval = setInterval(tick, 1000);
}

async function _updateCooldown(uid) {
  try {
    const rateDoc = await getDoc(doc(db, 'rate_limits', uid));
    const lastAt  = rateDoc.data()?.last_lineup_at?.toDate?.();
    if (!lastAt) { _showCooldownReady(); return; }
    const remainMs = cooldownMinutesFor(_approvedLineups) * 60000 - (Date.now() - lastAt.getTime());
    if (remainMs <= 0) { _showCooldownReady(); return; }
    _startCooldownTimer(remainMs);
  } catch { _showCooldownReady(); }
}

function _subscribeStats(uid) {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  const q = query(collection(db, 'lineups'), where('user_id', '==', uid));
  _statsUnsub = onSnapshot(q, snap => {
    let approved = 0, pending = 0, rejected = 0;
    currentUserLineups = [];
    snap.forEach(d => {
      const data = d.data();
      currentUserLineups.push({ id: d.id, ...data });
      const s = data.status;
      if (s === 'approved') approved++;
      else if (s === 'rejected') rejected++;
      else pending++;
    });
    currentUserLineups.sort((a, b) => {
      const at = b.submitted_at?.toMillis?.() || b.created_at?.toMillis?.() || 0;
      const bt = a.submitted_at?.toMillis?.() || a.created_at?.toMillis?.() || 0;
      return at - bt;
    });
    document.getElementById('stat-approved').textContent = approved;
    document.getElementById('stat-pending').textContent  = pending;
    document.getElementById('stat-rejected').textContent = rejected;
    _updateLevelDisplay(effectiveApprovedLineups(approved));
    renderAuthorWorkspace();
    document.getElementById('stats-loader').style.display = 'none';
    document.getElementById('stats-cards').style.display  = 'flex';
  }, () => {
    document.getElementById('stats-loader').textContent = 'Ошибка загрузки';
    renderAuthorWorkspace();
  });
}

function _unsubscribeStats() {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  _clearCooldownTimer();
  document.getElementById('stats-loader').style.display = '';
  document.getElementById('stats-loader').textContent   = 'Загрузка…';
  document.getElementById('stats-cards').style.display  = 'none';
  ['stat-approved', 'stat-pending', 'stat-rejected'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  currentUserLineups = [];
  renderAuthorWorkspace();
  const nameEl = document.getElementById('level-name');
  if (nameEl) { nameEl.textContent = '—'; nameEl.style.color = ''; }
  document.getElementById('level-icon').textContent = '—';
  _showCooldownReady();
}

function _subscribeUserProfile(uid) {
  if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
  _profileUnsub = onSnapshot(doc(db, 'users', uid), snap => {
    currentUserProfile = snap.exists() ? snap.data() : null;
    updateAdminOnlyWorkspace();
    const approvedDocs = currentUserLineups.filter(x => x.status === 'approved').length;
    _updateLevelDisplay(effectiveApprovedLineups(approvedDocs));
    updateUploadGate();
    renderAuthorWorkspace();
    _updateCooldown(uid);
  }, e => console.warn('profile listener', e.message));
}

function _unsubscribeUserProfile() {
  if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
}

// ── Author workspace ─────────────────────────────────────────────────────────
function initWorkspaceTabs() {
  document.querySelectorAll('.workspace-tab').forEach(btn => {
    btn.addEventListener('click', () => switchWorkspaceTab(btn.dataset.workspaceTab || 'upload'));
  });
  document.querySelectorAll('#my-status-filter .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      myLineupsStatusFilter = btn.dataset.status || 'all';
      document.querySelectorAll('#my-status-filter .filter-chip').forEach(chip => {
        chip.classList.toggle('active', chip === btn);
      });
      renderAuthorWorkspace();
    });
  });
  document.getElementById('my-lineups-search')?.addEventListener('input', event => {
    myLineupsSearch = event.target.value.trim().toLowerCase();
    renderAuthorWorkspace();
  });
  document.querySelectorAll('.lineup-list').forEach(list => {
    list.addEventListener('click', event => {
      const deleteBtn = event.target.closest('[data-delete-lineup-id]');
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteRejectedLineup(deleteBtn.dataset.deleteLineupId || '');
        return;
      }
      const card = event.target.closest('.lineup-card[data-lineup-id]');
      if (card) openLineupDetail(card.dataset.lineupId);
    });
    list.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.lineup-card[data-lineup-id]');
      if (!card) return;
      event.preventDefault();
      openLineupDetail(card.dataset.lineupId);
    });
  });
  document.getElementById('detail-close')?.addEventListener('click', closeLineupDetail);
  document.getElementById('lineup-detail-screen')?.addEventListener('click', event => {
    if (event.target.id === 'lineup-detail-screen') closeLineupDetail();
  });
  document.getElementById('copy-lineup-id')?.addEventListener('click', event => {
    const id = event.currentTarget.dataset.lineupId || '';
    if (!id) return;
    navigator.clipboard?.writeText(id).then(() => toast('ID скопирован', 's')).catch(() => toast('Не удалось скопировать ID', 'e'));
  });
  document.getElementById('detail-body')?.addEventListener('click', event => {
    const deleteBtn = event.target.closest('[data-delete-lineup-id]');
    if (deleteBtn) {
      event.preventDefault();
      deleteRejectedLineup(deleteBtn.dataset.deleteLineupId || '');
      return;
    }
    const copyBtn = event.target.closest('[data-copy-lineup-id]');
    if (copyBtn) {
      event.preventDefault();
      createDraftFromLineup(copyBtn.dataset.copyLineupId || '');
      return;
    }
    const resubmitBtn = event.target.closest('[data-resubmit-lineup-id]');
    if (!resubmitBtn) return;
    event.preventDefault();
    startRejectedResubmission(resubmitBtn.dataset.resubmitLineupId || '');
  });
  document.getElementById('resubmit-banner')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-cancel-resubmission]');
    if (!btn) return;
    event.preventDefault();
    cancelResubmissionDraft();
  });
  document.getElementById('btn-save-draft')?.addEventListener('click', event => {
    event.preventDefault();
    saveCurrentDraftSnapshot();
  });
  document.getElementById('drafts-list')?.addEventListener('click', event => {
    const resume = event.target.closest('[data-draft-action="resume"]');
    const remove = event.target.closest('[data-draft-action="delete"]');
    if (resume) {
      event.preventDefault();
      resumeSavedDraft(resume.dataset.draftId || '');
      switchWorkspaceTab('upload');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (remove) {
      event.preventDefault();
      deleteSavedDraft(remove.dataset.draftId || '');
      renderAuthorWorkspace();
      toast('Черновик удалён', 's');
    }
  });
  document.getElementById('btn-refresh-workspace')?.addEventListener('click', async () => {
    if (currentUser) {
      await loadCurrentUserProfile(currentUser);
      if (activeWorkspaceTab === 'materials') {
        await loadAuthorMaterials({ force: true });
      }
      updateUploadGate();
      renderAuthorWorkspace();
      toast('Кабинет обновлён', 's');
    }
  });
  document.getElementById('btn-material-add')?.addEventListener('click', event => {
    event.preventDefault();
    openMaterialForm();
  });
  document.getElementById('material-form-shell')?.addEventListener('click', event => {
    const cancel = event.target.closest('[data-material-cancel]');
    const save = event.target.closest('[data-material-save]');
    if (cancel) {
      event.preventDefault();
      closeMaterialForm();
    }
    if (save) {
      event.preventDefault();
      saveAuthorMaterial();
    }
  });
  document.getElementById('material-form-shell')?.addEventListener('change', event => {
    const input = event.target.closest('#material-video-file');
    if (!input) return;
    const file = input.files?.[0];
    if (file) uploadMaterialVideoFile(file);
  });
  document.getElementById('materials-list')?.addEventListener('click', event => {
    const edit = event.target.closest('[data-material-edit]');
    const remove = event.target.closest('[data-material-delete]');
    const toggle = event.target.closest('[data-material-toggle]');
    if (edit) {
      event.preventDefault();
      openMaterialForm(edit.dataset.materialEdit || '');
    }
    if (remove) {
      event.preventDefault();
      deleteAuthorMaterial(remove.dataset.materialDelete || '');
    }
    if (toggle) {
      event.preventDefault();
      toggleAuthorMaterial(toggle.dataset.materialToggle || '');
    }
  });
}

function switchWorkspaceTab(tab) {
  activeWorkspaceTab = tab || 'upload';
  document.querySelectorAll('.workspace-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.workspaceTab === activeWorkspaceTab);
  });
  document.querySelectorAll('.workspace-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `workspace-${activeWorkspaceTab}`);
  });
  if (activeWorkspaceTab === 'materials') loadAuthorMaterials();
  renderAuthorWorkspace();
}

function statusLabel(status) {
  if (status === 'approved') return 'Одобрен';
  if (status === 'rejected') return 'Отклонён';
  return 'На проверке';
}

function difficultyLabel(value) {
  const labels = { easy: 'Легко', medium: 'Средне', hard: 'Сложно' };
  return labels[String(value || '').toLowerCase()] || firstText(value, '—');
}

function categoryLabel(value) {
  const normalized = normalizeContentCategory(value);
  const labels = {
    lineup: 'Лайнап',
    combo: 'Комбо',
    wallbang: 'Прострел',
    defense: 'Защита',
  };
  return labels[normalized] || firstText(value, '—');
}

function isCurrentUserAdmin() {
  return String(currentUserProfile?.role || '').toLowerCase() === 'admin';
}

function updateAdminOnlyWorkspace() {
  const canManageAdminMaterials = isCurrentUserAdmin();
  document.querySelectorAll('[data-admin-only="true"]').forEach(el => {
    el.style.display = canManageAdminMaterials ? '' : 'none';
  });
  if (!canManageAdminMaterials && materialEditorId) {
    closeMaterialForm();
  }
}

function searchableText(item) {
  return [
    item.title,
    item.map,
    item.agent,
    item.ability,
    difficultyLabel(item.difficulty),
    categoryLabel(item.content_type || item.category),
    statusLabel(item.status),
  ].map(v => String(v || '').toLowerCase()).join(' ');
}

function filteredOwnLineups() {
  return currentUserLineups.filter(item => {
    const status = item.status || 'pending';
    if (myLineupsStatusFilter !== 'all' && status !== myLineupsStatusFilter) return false;
    if (myLineupsSearch && !searchableText(item).includes(myLineupsSearch)) return false;
    return true;
  });
}

function docDate(docData) {
  const date = docData.submitted_at?.toDate?.() || docData.created_at?.toDate?.();
  return date || null;
}

function formatClockDate(docData) {
  const date = docDate(docData);
  if (!date) return { time: '--:--', date: 'без даты' };
  return {
    time: date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    date: date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  };
}

function renderLineupList(targetId, items, emptyTitle, emptyText) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!currentUser) {
    target.innerHTML = `<div class="empty-state"><strong>Войди в аккаунт</strong>Здесь появятся твои материалы.</div>`;
    return;
  }
  if (!items.length) {
    target.innerHTML = `<div class="empty-state"><strong>${esc(emptyTitle)}</strong>${esc(emptyText)}</div>`;
    return;
  }
  target.innerHTML = items.map(item => {
    const status = item.status || 'pending';
    const title = firstText(item.title, 'Без названия');
    const stamp = formatClockDate(item);
    const meta = [
      item.map,
      item.agent,
      item.ability,
      difficultyLabel(item.difficulty),
      categoryLabel(item.content_type || item.category),
      item.resubmitted_from ? 'Повторная отправка' : '',
    ].filter(Boolean);
    return `
      <article class="lineup-card clickable" data-lineup-id="${esc(item.id)}" tabindex="0" role="button" aria-label="Открыть лайнап ${esc(title)}">
        <div>
          <div class="lineup-title">${esc(title)}</div>
          <div class="lineup-meta">
            ${meta.map(value => `<span class="lineup-chip">${esc(value)}</span>`).join('')}
            <span class="lineup-chip lineup-date-chip"><b>${esc(stamp.time)}</b><span>${esc(stamp.date)}</span></span>
          </div>
        </div>
        <div class="lineup-card-actions">
          <span class="status-chip ${esc(status)}">${esc(statusLabel(status))}</span>
          ${status === 'rejected' ? `<button class="copy-id-btn danger" type="button" data-delete-lineup-id="${esc(item.id)}">Удалить</button>` : ''}
        </div>
      </article>`;
  }).join('');
}

function findOwnLineup(id) {
  return currentUserLineups.find(item => item.id === id) || null;
}

function openLineupDetail(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item) {
    toast('Лайнап не найден в списке', 'e');
    return;
  }
  const screen = document.getElementById('lineup-detail-screen');
  const titleEl = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');
  if (!screen || !titleEl || !body) return;

  const title = firstText(item.title, 'Без названия');
  const stamp = formatClockDate(item);
  const description = firstText(item.description, 'Описание не добавлено.');
  const rejection = firstText(item.rejection_reason, item.reject_reason, item.moderation_reason);
  const source = item.resubmitted_from ? findOwnLineup(item.resubmitted_from) : null;
  const shots = Array.isArray(item.screenshots) ? item.screenshots.filter(Boolean) : [];
  const status = item.status || 'pending';

  titleEl.textContent = title;
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-tile"><span>Статус</span><b>${esc(statusLabel(status))}</b></div>
      <div class="detail-tile"><span>Карта</span><b>${esc(firstText(item.map, '—'))}</b></div>
      <div class="detail-tile"><span>Агент</span><b>${esc(firstText(item.agent, '—'))}</b></div>
      <div class="detail-tile"><span>Дата</span><b>${esc(stamp.time)}<br>${esc(stamp.date)}</b></div>
      <div class="detail-tile"><span>Абилка</span><b>${esc(firstText(item.ability, '—'))}</b></div>
      <div class="detail-tile"><span>Сложность</span><b>${esc(difficultyLabel(item.difficulty))}</b></div>
      <div class="detail-tile"><span>Категория</span><b>${esc(categoryLabel(item.content_type || item.category))}</b></div>
      ${item.resubmitted_from ? `<div class="detail-tile"><span>Доработка</span><b>${esc(source ? firstText(source.title, source.id) : item.resubmitted_from)}</b></div>` : ''}
    </div>
    ${rejection ? `<div class="detail-section"><div class="detail-section-title">Причина отклонения</div><div class="detail-warning">${esc(rejection)}</div></div>` : ''}
    <div class="detail-section">
      <div class="detail-section-title">Описание</div>
      <div class="detail-text">${esc(description)}</div>
    </div>
    ${item.video_url ? `<div class="detail-section"><div class="detail-section-title">Видео</div><video class="detail-video" controls preload="metadata" src="${esc(item.video_url)}"></video></div>` : ''}
    ${shots.length ? `<div class="detail-section"><div class="detail-section-title">Скриншоты</div><div class="detail-shots">${shots.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt=""></a>`).join('')}</div></div>` : ''}
    <div class="detail-actions">
      ${status === 'rejected' ? `<button class="copy-id-btn danger" type="button" data-delete-lineup-id="${esc(item.id)}">Удалить</button>` : ''}
      <button class="copy-id-btn" type="button" data-copy-lineup-id="${esc(item.id)}">Создать черновик-копию</button>
      ${status === 'rejected' ? `<button class="btn-primary detail-action-primary" type="button" data-resubmit-lineup-id="${esc(item.id)}">Доработать и отправить заново</button>` : ''}
    </div>
    <div class="detail-id-row">
      <code>ID: ${esc(item.id)}</code>
      <button class="copy-id-btn" id="copy-lineup-id" type="button" data-lineup-id="${esc(item.id)}">Скопировать ID</button>
    </div>
  `;
  body.querySelector('#copy-lineup-id')?.addEventListener('click', event => {
    const id = event.currentTarget.dataset.lineupId || '';
    navigator.clipboard?.writeText(id).then(() => toast('ID скопирован', 's')).catch(() => toast('Не удалось скопировать ID', 'e'));
  });
  screen.style.display = 'flex';
}

async function deleteRejectedLineup(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item || item.status !== 'rejected') {
    toast('Удалить можно только отклонённый лайнап', 'w');
    return;
  }
  if (!confirm('Удалить отклонённый лайнап? Это уберёт его из кабинета автора.')) return;
  try {
    await deleteDoc(doc(db, 'lineups', lineupId));
    if (resubmissionSourceId === lineupId) {
      resubmissionSourceId = '';
      _saveDraft();
      renderResubmissionBanner();
      renderDrafts();
    }
    closeLineupDetail();
    toast('Отклонённый лайнап удалён', 's');
  } catch (e) {
    await logUploadError(e, {
      action: 'delete_rejected_lineup',
      lineup_id: lineupId,
      status: item.status || '',
      user: userDiagnostics(),
    });
    toast('Не удалось удалить лайнап: ' + toSafeErrorMessage(e), 'e');
  }
}

function closeLineupDetail() {
  const screen = document.getElementById('lineup-detail-screen');
  if (!screen) return;
  screen.style.display = 'none';
  const video = screen.querySelector('video');
  if (video) video.pause();
}

function rejectedLineupDraft(item) {
  const shots = Array.isArray(item.screenshots) ? item.screenshots.filter(Boolean) : [];
  return {
    map: item.map || '',
    agent: item.agent || '',
    ability: item.ability || '',
    category: normalizeContentCategory(item.content_type || item.category || 'lineup'),
    difficulty: item.difficulty || '',
    title: item.title || '',
    desc: item.description || '',
    markerX: item.position_x ?? item.marker_x ?? null,
    markerY: item.position_y ?? item.marker_y ?? null,
    mapMode: 'position',
    trajectory: Array.isArray(item.trajectory) ? item.trajectory : [],
    videoUrl: item.video_url || '',
    screenshots: shots,
    resubmissionSourceId: item.id,
  };
}

function lineupCopyDraft(item) {
  return {
    ...rejectedLineupDraft(item),
    title: item.title ? `${item.title} — копия` : '',
    resubmissionSourceId: '',
  };
}

function createDraftFromLineup(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item) {
    toast('Лайнап не найден', 'e');
    return;
  }
  const draft = lineupCopyDraft(item);
  const now = Date.now();
  const saved = {
    ...draft,
    id: `draft_${now}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };
  writeSavedDrafts([saved, ...getSavedDrafts()]);
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, saved.id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(saved));
  } catch (_) {}
  closeLineupDetail();
  resetUploadForm({ keepDraft: true });
  _restoreDraft(saved);
  switchWorkspaceTab('upload');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderAuthorWorkspace();
  toast('Копия лайнапа открыта как черновик', 's');
}

function startRejectedResubmission(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item || item.status !== 'rejected') {
    toast('Повторно отправить можно только отклонённый материал', 'w');
    return;
  }
  try {
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(rejectedLineupDraft(item)));
  } catch (_) {}
  closeLineupDetail();
  resetUploadForm({ keepDraft: true });
  _restoreDraft();
  switchWorkspaceTab('upload');
  toast('Отклонённый лайнап перенесён в форму. Проверь правки и отправь заново.', 's');
}

function renderResubmissionBanner() {
  const banner = document.getElementById('resubmit-banner');
  if (!banner) return;
  if (!resubmissionSourceId) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const source = findOwnLineup(resubmissionSourceId);
  const title = firstText(source?.title, resubmissionSourceId);
  const reason = source ? firstText(source.rejection_reason, source.reject_reason, source.moderation_reason) : '';
  banner.innerHTML = `
    <div>
      <strong>Доработка отклонённого лайнапа</strong>
      <span>${esc(title)}${reason ? ` · ${esc(reason)}` : ''}</span>
    </div>
    <button class="copy-id-btn" type="button" data-cancel-resubmission>Отменить</button>
  `;
  banner.style.display = '';
}

function cancelResubmissionDraft() {
  resubmissionSourceId = '';
  _saveDraft();
  renderResubmissionBanner();
  renderDrafts();
  toast('Связь с отклонённым лайнапом снята', 's');
}

function renderDrafts() {
  const target = document.getElementById('drafts-list');
  if (!target) return;
  const drafts = getSavedDrafts();
  if (!drafts.length) {
    target.innerHTML = '<div class="empty-state"><strong>Черновиков нет</strong>Заполни форму и нажми «Сохранить черновик», чтобы держать несколько заготовок на этом устройстве.</div>';
    return;
  }
  target.innerHTML = drafts.map(draft => {
    const meta = [draft.map, draft.agent, draft.ability, difficultyLabel(draft.difficulty), categoryLabel(draft.category)].filter(Boolean);
    const date = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    return `
    <article class="lineup-card" data-draft-id="${esc(draft.id || '')}">
      <div>
        <div class="lineup-title">${esc(firstText(draft.title, 'Черновик лайнапа'))}</div>
        <div class="lineup-meta">
          ${meta.map(value => `<span class="lineup-chip">${esc(value)}</span>`).join('')}
          <span class="lineup-chip">На этом устройстве</span>
          ${date ? `<span class="lineup-chip">${esc(date)}</span>` : ''}
          ${draft.resubmissionSourceId ? '<span class="lineup-chip">Доработка отклонённого</span>' : ''}
        </div>
      </div>
      <div class="draft-actions">
        <button class="copy-id-btn" type="button" data-draft-action="resume" data-draft-id="${esc(draft.id || '')}">Продолжить</button>
        <button class="copy-id-btn danger" type="button" data-draft-action="delete" data-draft-id="${esc(draft.id || '')}">Удалить</button>
      </div>
    </article>`;
  }).join('');
}

function renderMaterials() {
  const target = document.getElementById('materials-list');
  if (!target) return;
  renderMaterialForm();
  if (authorMaterialsError) {
    target.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить материалы</strong>${esc(authorMaterialsError)}</div>`;
    return;
  }
  if (!authorMaterialsLoaded) {
    if (!authorMaterialsLoading) loadAuthorMaterials();
    target.innerHTML = '<div class="empty-state"><strong>Загрузка материалов…</strong>Сейчас подтянем библиотеку для авторов.</div>';
    return;
  }
  const visibleMaterials = isCurrentUserAdmin()
    ? authorMaterials
    : authorMaterials.filter(item => item.is_published !== false);
  if (!visibleMaterials.length) {
    target.innerHTML = '<div class="empty-state"><strong>Материалов пока нет</strong>Когда администратор добавит материал, он появится здесь.</div>';
    return;
  }
  target.innerHTML = visibleMaterials.map(material => materialCardHtml(material)).join('');
}

function materialTypeLabel(value) {
  const labels = { video: 'Видео', guide: 'Гайд', checklist: 'Чек-лист', example: 'Пример', link: 'Ссылка' };
  return labels[String(value || '').toLowerCase()] || 'Материал';
}

function materialDateValue(item) {
  return item.updated_at?.toMillis?.() || item.created_at?.toMillis?.() || 0;
}

async function loadAuthorMaterials({ force = false } = {}) {
  if (authorMaterialsLoading || (authorMaterialsLoaded && !force)) return;
  authorMaterialsLoading = true;
  authorMaterialsError = '';
  renderMaterials();
  try {
    const q = isCurrentUserAdmin()
      ? query(collection(db, 'author_materials'), limit(80))
      : query(collection(db, 'author_materials'), where('is_published', '==', true), limit(80));
    const snap = await getDocs(q);
    authorMaterials = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    authorMaterials.sort((a, b) => materialDateValue(b) - materialDateValue(a));
    authorMaterialsLoaded = true;
  } catch (e) {
    console.warn('loadAuthorMaterials', e.message);
    authorMaterialsError = 'Обнови раздел или страницу чуть позже.';
  } finally {
    authorMaterialsLoading = false;
    renderMaterials();
  }
}

function materialCardHtml(material) {
  const published = material.is_published !== false;
  const videoUrl = String(material.video_url || '').trim();
  const legacyUrl = String(material.url || '').trim();
  return `
    <article class="material-item" data-material-id="${esc(material.id || '')}">
      <div>
        <div class="material-item-head">
          <span class="material-badge">${esc(materialTypeLabel(material.type))}</span>
          ${published ? '' : '<span class="material-badge hidden">Скрыт</span>'}
          <h3>${esc(firstText(material.title, 'Материал'))}</h3>
        </div>
        ${material.description ? `<div class="material-desc">${esc(material.description)}</div>` : ''}
        ${videoUrl ? `
          <video class="material-video" src="${esc(videoUrl)}" controls preload="metadata"></video>
          <a class="material-link" href="${esc(videoUrl)}" download rel="noopener noreferrer">Скачать видео</a>
        ` : legacyUrl ? `<a class="material-link" href="${esc(legacyUrl)}" target="_blank" rel="noopener noreferrer">Открыть материал</a>` : ''}
      </div>
      ${isCurrentUserAdmin() ? `
        <div class="material-actions">
          <button class="copy-id-btn" type="button" data-material-edit="${esc(material.id || '')}">Изменить</button>
          <button class="copy-id-btn" type="button" data-material-toggle="${esc(material.id || '')}">${published ? 'Скрыть' : 'Опубликовать'}</button>
          <button class="copy-id-btn danger" type="button" data-material-delete="${esc(material.id || '')}">Удалить</button>
        </div>` : ''}
    </article>`;
}

function openMaterialForm(id = '') {
  if (!isCurrentUserAdmin()) return;
  materialVideoUploading = false;
  materialVideoUploadSeq++;
  materialEditorId = id || '__new__';
  renderMaterialForm();
  document.getElementById('material-title')?.focus();
}

function closeMaterialForm() {
  materialEditorId = '';
  materialVideoUploading = false;
  materialVideoUploadSeq++;
  renderMaterialForm();
}

function renderMaterialForm() {
  const shell = document.getElementById('material-form-shell');
  if (!shell) return;
  if (!isCurrentUserAdmin() || !materialEditorId) {
    shell.style.display = 'none';
    shell.innerHTML = '';
    return;
  }
  const material = materialEditorId === '__new__'
    ? { type: 'video', title: '', description: '', video_url: '', video_file_name: '', video_size: 0, is_published: true }
    : authorMaterials.find(item => item.id === materialEditorId) || {};
  const videoUrl = String(material.video_url || '').trim();
  shell.style.display = '';
  shell.innerHTML = `
    <div class="material-form-grid">
      <input class="finput" id="material-title" maxlength="90" placeholder="Название материала" value="${esc(material.title || '')}">
      <input class="finput" id="material-video-file" type="file" accept="video/mp4,video/quicktime,video/*">
    </div>
    <div class="field-group">
      <textarea class="finput" id="material-description" maxlength="1000" placeholder="Короткое описание для авторов">${esc(material.description || '')}</textarea>
    </div>
    <input type="hidden" id="material-video-url" value="${esc(videoUrl)}">
    <input type="hidden" id="material-video-name" value="${esc(material.video_file_name || '')}">
    <input type="hidden" id="material-video-size" value="${esc(material.video_size || 0)}">
    <div class="material-upload-state" id="material-upload-state">
      ${videoUrl ? 'Видео загружено. Можно заменить его новым файлом.' : 'Выбери видеофайл, он загрузится в хранилище автоматически.'}
    </div>
    <div class="material-video-preview" id="material-video-preview">
      ${videoUrl ? `<video class="material-video" src="${esc(videoUrl)}" controls preload="metadata"></video>` : ''}
    </div>
    <label class="lineup-meta" style="margin-bottom:12px;">
      <input type="checkbox" id="material-published" ${material.is_published === false ? '' : 'checked'}>
      <span class="lineup-chip">Показывать пользователям</span>
    </label>
    <div class="material-form-actions">
      <button class="copy-id-btn" type="button" data-material-cancel>Отмена</button>
      <button class="btn-primary detail-action-primary" type="button" data-material-save>${materialEditorId === '__new__' ? 'Добавить' : 'Сохранить'}</button>
    </div>`;
}

function materialFormPayload() {
  const title = document.getElementById('material-title')?.value.trim() || '';
  const description = document.getElementById('material-description')?.value.trim() || '';
  const videoUrl = document.getElementById('material-video-url')?.value.trim() || '';
  const videoFileName = document.getElementById('material-video-name')?.value.trim() || '';
  const videoSize = Number(document.getElementById('material-video-size')?.value || 0);
  const isPublished = !!document.getElementById('material-published')?.checked;
  if (!title) throw new Error('Укажи название материала');
  if (materialVideoUploading) throw new Error('Дождись окончания загрузки видео');
  if (!videoUrl) throw new Error('Загрузи видео для материала');
  return {
    type: 'video',
    title,
    description,
    url: '',
    video_url: videoUrl,
    video_file_name: videoFileName,
    video_size: Number.isFinite(videoSize) ? videoSize : 0,
    is_published: isPublished,
    updated_at: serverTimestamp(),
    updated_by: currentUser?.uid || '',
    updated_by_name: authorDisplayName(),
  };
}

async function uploadMaterialVideoFile(file) {
  if (!isCurrentUserAdmin()) return;
  if (!isVideoFile(file)) { toast('Выбери видеофайл', 'e'); return; }
  if (file.size > 100 * 1024 * 1024) { toast('Видео превышает 100 МБ', 'e'); return; }

  const seq = ++materialVideoUploadSeq;
  materialVideoUploading = true;
  const state = document.getElementById('material-upload-state');
  const preview = document.getElementById('material-video-preview');
  const saveBtn = document.querySelector('[data-material-save]');
  if (saveBtn) saveBtn.disabled = true;
  if (state) state.textContent = 'Загрузка видео: 0%';
  if (preview) preview.innerHTML = '';
  try {
    const url = await uploadVideoToSelectel(file, pct => {
      if (seq !== materialVideoUploadSeq) return;
      if (state) state.textContent = `Загрузка видео: ${Math.round(pct * 100)}%`;
    });
    if (seq !== materialVideoUploadSeq) return;
    document.getElementById('material-video-url').value = url;
    document.getElementById('material-video-name').value = file.name;
    document.getElementById('material-video-size').value = String(file.size);
    if (state) state.textContent = 'Видео загружено. Можно сохранять материал.';
    if (preview) preview.innerHTML = `<video class="material-video" src="${esc(url)}" controls preload="metadata"></video>`;
    toast('Видео загружено', 's');
  } catch (e) {
    if (seq !== materialVideoUploadSeq) return;
    document.getElementById('material-video-url').value = '';
    if (state) state.textContent = 'Не удалось загрузить видео. Попробуй выбрать файл ещё раз.';
    toast('Ошибка загрузки видео: ' + (e.message || e), 'e');
  } finally {
    if (seq === materialVideoUploadSeq) {
      materialVideoUploading = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }
}

async function saveAuthorMaterial() {
  if (!isCurrentUserAdmin() || !materialEditorId) return;
  const btn = document.querySelector('[data-material-save]');
  try {
    const payload = materialFormPayload();
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }
    const isNew = materialEditorId === '__new__';
    const ref = isNew ? doc(collection(db, 'author_materials')) : doc(db, 'author_materials', materialEditorId);
    await setDoc(ref, {
      ...payload,
      ...(isNew ? {
        created_at: serverTimestamp(),
        created_by: currentUser?.uid || '',
        created_by_name: authorDisplayName(),
      } : {}),
    }, { merge: true });
    materialEditorId = '';
    await loadAuthorMaterials({ force: true });
    toast(isNew ? 'Материал добавлен' : 'Материал сохранён', 's');
  } catch (e) {
    toast(e.message || 'Не удалось сохранить материал', 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
  }
}

async function toggleAuthorMaterial(id) {
  if (!isCurrentUserAdmin() || !id) return;
  const material = authorMaterials.find(item => item.id === id);
  if (!material) return;
  try {
    await setDoc(doc(db, 'author_materials', id), {
      is_published: material.is_published === false,
      updated_at: serverTimestamp(),
      updated_by: currentUser?.uid || '',
      updated_by_name: authorDisplayName(),
    }, { merge: true });
    await loadAuthorMaterials({ force: true });
    toast(material.is_published === false ? 'Материал опубликован' : 'Материал скрыт', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  }
}

async function deleteAuthorMaterial(id) {
  if (!isCurrentUserAdmin() || !id) return;
  if (!confirm('Удалить материал? Пользователи больше его не увидят.')) return;
  try {
    await deleteDoc(doc(db, 'author_materials', id));
    if (materialEditorId === id) closeMaterialForm();
    await loadAuthorMaterials({ force: true });
    toast('Материал удалён', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  }
}

function renderCabinetStats() {
  const target = document.getElementById('cabinet-stats-grid');
  if (!target) return;
  const approved = currentUserLineups.filter(x => x.status === 'approved').length;
  const effectiveApproved = effectiveApprovedLineups(approved);
  const bonusLineups = Number(currentUserProfile?.bonus_lineups || 0);
  const rejected = currentUserLineups.filter(x => x.status === 'rejected').length;
  const pending = currentUserLineups.filter(x => x.status !== 'approved' && x.status !== 'rejected').length;
  const viewed = Number(currentUserProfile?.lineups_viewed || 0);
  const lv = calculateLevel(effectiveApproved);
  target.innerHTML = `
    <div class="cabinet-stat"><span>Статус</span><b style="color:${esc(lv.color)}">${esc(lv.icon)} ${esc(lv.name)}</b></div>
    <div class="cabinet-stat"><span>Счётчик</span><b style="color:var(--green)">${effectiveApproved}</b></div>
    <div class="cabinet-stat"><span>На проверке</span><b style="color:var(--orange)">${pending}</b></div>
    <div class="cabinet-stat"><span>Просмотрено</span><b>${viewed}</b></div>
    <div class="cabinet-stat"><span>Отклонено</span><b style="color:var(--red)">${rejected}</b></div>
    <div class="cabinet-stat"><span>Одобрено факт</span><b>${approved}${bonusLineups ? ` +${bonusLineups}` : ''}</b></div>
    <div class="cabinet-stat"><span>Всего отправлено</span><b>${currentUserLineups.length}</b></div>
    <div class="cabinet-stat"><span>КД отправки</span><b>${cooldownMinutesFor(effectiveApproved)}м</b></div>
    <div class="cabinet-stat"><span>Доступ</span><b>${canCurrentUserUpload() ? 'Можно' : `${Math.min(viewed, UPLOAD_REQUIRED_VIEWS)}/${UPLOAD_REQUIRED_VIEWS}`}</b></div>`;
}

function renderAuthorWorkspace() {
  renderLineupList(
    'my-lineups-list',
    filteredOwnLineups(),
    currentUserLineups.length ? 'Ничего не найдено' : 'Лайнапов пока нет',
    currentUserLineups.length ? 'Попробуй другой статус или поисковый запрос.' : 'Отправь первый лайнап, и он появится здесь со статусом проверки.'
  );
  renderLineupList(
    'rejected-lineups-list',
    currentUserLineups.filter(x => x.status === 'rejected'),
    'Отклонённых нет',
    'Если модератор отклонит материал, он появится здесь для будущей доработки.'
  );
  renderDrafts();
  renderCabinetStats();
  renderMaterials();
  renderResubmissionBanner();
}

initWorkspaceTabs();
initSiteVersionWatcher();

// ── Auth ──────────────────────────────────────────────────────────────────────
function authorDisplayName() {
  return firstText(
    currentUserProfile?.name,
    currentUserProfile?.displayName,
    currentUserProfile?.username,
    currentUserProfile?.yandex_name,
    currentUser?.displayName,
    currentUser?.email
  );
}

async function loadCurrentUserProfile(user) {
  currentUserProfile = null;
  if (!user) return null;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    currentUserProfile = snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn('loadCurrentUserProfile', e.message);
    currentUserProfile = null;
  }
  return currentUserProfile;
}

onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('form-screen').style.display = '';
    document.getElementById('success-screen').style.display = 'none'; // hide overlay on auth change
    document.getElementById('header-user').style.display = 'flex';
    await loadCurrentUserProfile(user);
    updateAdminOnlyWorkspace();
    document.getElementById('user-name').textContent = authorDisplayName() || 'Пользователь';
    updateUploadGate();
    _subscribeUserProfile(user.uid);
    _subscribeStats(user.uid);
    _updateCooldown(user.uid);
    const av = document.getElementById('user-avatar');
    if (user.photoURL) { av.src = user.photoURL; av.style.display = ''; }
    if (!agentsList.length) loadAgents();
    loadMaps();
  } else {
    currentUserProfile = null;
    updateAdminOnlyWorkspace();
    updateUploadGate();
    _unsubscribeUserProfile();
    _unsubscribeStats();
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('form-screen').style.display = 'none';
    document.getElementById('success-screen').style.display = 'none'; // hide overlay on auth change
    document.getElementById('header-user').style.display = 'none';
  }
});

document.getElementById('tab-yandex-btn').addEventListener('click', () => {
  document.getElementById('tab-yandex-btn').classList.add('active');
  document.getElementById('tab-email-btn').classList.remove('active');
  document.getElementById('tab-yandex').style.display = '';
  document.getElementById('tab-email').style.display = 'none';
});
document.getElementById('tab-email-btn').addEventListener('click', () => {
  document.getElementById('tab-email-btn').classList.add('active');
  document.getElementById('tab-yandex-btn').classList.remove('active');
  document.getElementById('tab-email').style.display = '';
  document.getElementById('tab-yandex').style.display = 'none';
});

// ── Яндекс (веб-режим) ──────────────────────────────────────────────────────
document.getElementById('btn-yandex').addEventListener('click', () => {
  window.location.href = '/api/yandex-start?state=web';
});

function publicYandexAuthError(code) {
  const key = String(code || '').toLowerCase();
  if (key === 'auth_expired') {
    return 'Сессия входа через Яндекс истекла. Нажми "Войти через Яндекс" ещё раз.';
  }
  if (key === 'service_unavailable' || key === 'token_failed' || key === 'config') {
    return 'Сервис входа через Яндекс сейчас недоступен. Попробуй позже или войди другим способом.';
  }
  if (key === 'web_account_missing') {
    return 'Аккаунт не найден. Сначала войдите в приложение и настройте профиль.';
  }
  if (key === 'web_profile_incomplete') {
    return 'Сначала откройте приложение и придумайте никнейм, потом вход на сайт станет доступен.';
  }
  return 'Не удалось войти через Яндекс. Попробуй позже или войди другим способом.';
}

// При возврате с Яндекса: ?yandex_token=... или ?yandex_error=...
(async () => {
  const p = new URLSearchParams(window.location.search);
  const err = p.get('yandex_error');
  if (err) {
    showAuthErr(publicYandexAuthError(decodeURIComponent(err)));
    history.replaceState(null, '', window.location.pathname);
    return;
  }
  const token = p.get('yandex_token');
  if (token) {
    history.replaceState(null, '', window.location.pathname);
    try {
      await signInWithCustomToken(auth, token);
    } catch (e) {
      showAuthErr('Вход через Яндекс не удался: ' + e.message);
    }
  }
})();

document.getElementById('btn-email-login').addEventListener('click', async () => {
  const login = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-password').value;
  if (!login || !pass) { showAuthErr('Заполни ник/email и пароль'); return; }
  const btn = document.getElementById('btn-email-login');
  btn.disabled = true; btn.textContent = 'Вход…';
  try {
    const email = await resolveLoginToEmail(login);
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    await logUploadError(e, { action: 'login', login: login.includes('@') ? 'email' : 'nickname' });
    showAuthErr(e.code === 'auth/invalid-credential' ? 'Неверный ник/email или пароль' : e.message);
    btn.disabled = false; btn.textContent = 'Войти';
  }
});

async function resolveLoginToEmail(login) {
  if (login.includes('@')) return login;
  const lower = login.toLowerCase().trim();
  const snap = await getDocs(query(collection(db, 'users'), where('name_lower', '==', lower), limit(1)));
  if (snap.empty) throw new Error('Ник не найден. Попробуй email или войди через Яндекс.');
  const u = snap.docs[0].data();
  const email = firstText(u.user_email, u.email, u.yandex_email, u.linked_yandex_email);
  if (!email) throw new Error('У этого ника нет входа по паролю. Попробуй Яндекс.');
  return email;
}

document.getElementById('btn-signout').addEventListener('click', () => signOut(auth));

function showAuthErr(msg) {
  const el = document.getElementById('auth-err');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Valorant API ──────────────────────────────────────────────────────────────
const valorantProxy = url => `/api/valorant-proxy?url=${encodeURIComponent(url)}`;
const proxiedValorantUrl = url =>
  url && /^https:\/\/(valorant-api\.com|media\.valorant-api\.com)\//.test(url)
    ? valorantProxy(url)
    : url;

const ABILITY_NAME_FALLBACKS = {
  'KAY/O': {
    Grenade: 'ФРАГ/мент',
    Flash: 'СВЕТО/вая граната',
    Signature: 'ЭПИ/центр',
    Ultimate: 'NULL/cmd',
    'ZERO/point': 'ЭПИ/центр',
    'FLASH/drive': 'СВЕТО/вая граната',
    'FRAG/ment': 'ФРАГ/мент',
  },
};

function normalizeAbilityName(agentName, abilityName, slot = '') {
  const raw = (abilityName || '').trim();
  const fallback = ABILITY_NAME_FALLBACKS[agentName]?.[raw] || ABILITY_NAME_FALLBACKS[agentName]?.[slot];
  return fallback || raw || slot;
}

async function loadAgents() {
  try {
    const res  = await fetch(valorantProxy('https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=ru-RU'));
    const data = await res.json();
    agentsList = (data.data || []).sort((a, b) => a.displayName.localeCompare(b.displayName));
    renderAgentsGrid();
    _restoreDraft();
  } catch (e) {
    toast('Не удалось загрузить агентов', 'e');
  }
}

async function loadMaps() {
  try {
    const res  = await fetch(valorantProxy('https://valorant-api.com/v1/maps'));
    const data = await res.json();
    mapsData = data.data || [];
  } catch (_) {}
}

function renderAgentsGrid() {
  const grid = document.getElementById('agents-grid');
  grid.innerHTML = agentsList.map(a => `
    <div class="agent-card" data-uuid="${esc(a.uuid)}">
      <img src="${esc(proxiedValorantUrl(a.displayIconSmall || a.displayIcon || ''))}" alt="${esc(a.displayName)}"
           crossorigin="anonymous"
           onerror="this.style.display='none'">
      <span>${esc(a.displayName)}</span>
    </div>`).join('');
  grid.querySelectorAll('.agent-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.agent-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const agent = agentsList.find(a => a.uuid === card.dataset.uuid);
      if (agent) selectAgent(agent);
    });
  });
}

function selectAgent(agent) {
  selectedAgent   = agent.displayName;
  selectedAbility = null;
  const row = document.getElementById('abilities-row');
  const abilities = (agent.abilities || []).filter(ab => ab.displayIcon && ab.slot !== 'Passive');
  if (!abilities.length) {
    row.innerHTML = '<span style="color:var(--text2);font-size:13px;">Нет доступных абилок</span>';
    validateForm();
    return;
  }
  row.innerHTML = abilities.map(ab => `
    <button class="ability-btn" data-key="${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot))}" data-slot="${esc(ab.slot || '')}" title="${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot))}">
      <img src="${esc(ab.displayIcon)}" alt="${esc(ab.displayName || '')}">
      <span>${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot).split(' ')[0])}</span>
    </button>`).join('');
  row.querySelectorAll('.ability-btn').forEach(b => {
    b.addEventListener('click', () => {
      row.querySelectorAll('.ability-btn').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      selectedAbility = b.dataset.key;
      updateMarkerIcon();
      validateForm(); _saveDraft();
    });
  });
  validateForm();
}

// ── Category & Difficulty ─────────────────────────────────────────────────────
document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (b.disabled || b.classList.contains('locked')) {
      toast('Эта категория скоро появится. Пока её заполняют админы.', 'i');
      return;
    }
    document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    selectedCategory = normalizeContentCategory(b.dataset.val);
    if (!canSubmitContentCategory(selectedCategory)) {
      selectedCategory = null;
      b.classList.remove('selected');
      toast('Эта категория пока закрыта для отправки.', 'i');
      validateForm(); _saveDraft();
      return;
    }
    validateForm(); _saveDraft();
  });
});
document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    selectedDifficulty = b.dataset.val;
    validateForm(); _saveDraft();
  });
});

// ── Char counters ─────────────────────────────────────────────────────────────
document.getElementById('inp-title').addEventListener('input', e => {
  document.getElementById('title-count').textContent = e.target.value.length;
  validateForm(); _saveDraft();
});
document.getElementById('inp-desc').addEventListener('input', e => {
  document.getElementById('desc-count').textContent = e.target.value.length;
  _saveDraft();
});
document.getElementById('sel-map').addEventListener('change', () => {
  loadMapMinimap();
  validateForm(); _saveDraft();
});

// ── Video — file tab ──────────────────────────────────────────────────────────
const dropZone    = document.getElementById('drop-zone');
const vidInput    = document.getElementById('vid-file-input');
const vidPlayer   = document.getElementById('vid-player');
const vidScrubber = document.getElementById('vid-scrubber');
const vidTimeEl   = document.getElementById('vid-time');
const vidPlayBtn  = document.getElementById('vid-play-btn');
let activeEditorMode = 'trim';
let timelineDrag = null;
let suppressTimelineClick = false;
let selectedEditorItem = null;
let freezeHoldTimer = null;
let freezeHoldActive = null;
let freezeHoldRenderInterval = null;
let playedFreezeHolds = new Set();
let lastVideoTime = 0;
let timelinePixelsPerSecond = 52;
let timelineMagnetEnabled = true;
let videoEditorHotkeysActive = false;
let timelinePreviewOutputTime = null;
let outputPlaybackActive = false;
let outputPlaybackRaf = null;
let outputPlaybackStartedAt = 0;
let outputPlaybackStartTime = 0;
let outputPlaybackTime = null;
const freezeFrameImages = new Map();
const editorEls = {
  scroll: document.getElementById('timeline-scroll'),
  shell: document.getElementById('timeline-shell'),
  stage: document.getElementById('vid-stage'),
  freezeOverlay: document.getElementById('freeze-frame-overlay'),
  zoomFrame: document.getElementById('zoom-preview-frame'),
  playhead: document.getElementById('timeline-playhead'),
  trimRange: document.getElementById('video-trim-range'),
  markers: document.getElementById('video-markers'),
  effectMarkers: document.getElementById('effect-markers'),
  wave: document.getElementById('audio-wave'),
  timeLabel: document.getElementById('editor-time-label'),
  summary: document.getElementById('editor-summary'),
  hint: document.getElementById('editor-mode-hint'),
  timelineZoom: document.getElementById('timeline-zoom'),
  magnet: document.getElementById('timeline-magnet'),
  trimStart: document.getElementById('edit-trim-start'),
  trimEnd: document.getElementById('edit-trim-end'),
  volume: document.getElementById('edit-volume'),
  muted: document.getElementById('edit-muted'),
  chromaEnabled: document.getElementById('edit-chroma-enabled'),
  chromaStrength: document.getElementById('edit-chroma-strength'),
  zoomScaleX: document.getElementById('edit-zoom-scale-x'),
  zoomScaleY: document.getElementById('edit-zoom-scale-y'),
  zoomPosX: document.getElementById('edit-zoom-pos-x'),
  zoomPosY: document.getElementById('edit-zoom-pos-y'),
  zoomRotation: document.getElementById('edit-zoom-rotation'),
  zoomRotationRange: document.getElementById('edit-zoom-rotation-range'),
  zoomAnchorX: document.getElementById('edit-zoom-anchor-x'),
  zoomAnchorY: document.getElementById('edit-zoom-anchor-y'),
  zoomValue: document.getElementById('edit-zoom-value'),
  zoomPanel: document.getElementById('zoom-panel'),
  effectsPanel: document.getElementById('effects-panel'),
};

function createDefaultVideoEdit() {
  return {
    version: 1,
    trimStart: 0,
    trimEnd: 0,
    splits: [],
    freezeFrames: [],
    zoomKeyframes: [],
    audio: { muted: false, volume: 1 },
    chromaKey: { enabled: false, color: '#00ff00', strength: 0.35 },
    footageOverlays: [],
  };
}

function videoDuration() {
  return Number.isFinite(vidPlayer.duration) ? vidPlayer.duration : 0;
}

function clampTime(value) {
  const duration = videoDuration();
  const n = Number(value || 0);
  if (!duration) return Math.max(0, n);
  return Math.max(0, Math.min(duration, n));
}

function normalizedVideoEdit() {
  const duration = videoDuration();
  const trimStart = clampTime(videoEdit.trimStart);
  const trimEnd = clampTime(videoEdit.trimEnd || duration);
  return {
    ...videoEdit,
    trimStart: Math.min(trimStart, trimEnd),
    trimEnd: Math.max(trimStart, trimEnd),
    splits: [...new Set((videoEdit.splits || []).map(clampTime).filter(t => t > 0 && (!duration || t < duration)))]
      .sort((a, b) => a - b),
    freezeFrames: (videoEdit.freezeFrames || []).map(item => ({
      id: item.id || `freeze_${Math.round(Number(item.at || 0) * 1000)}_${Math.random().toString(36).slice(2, 7)}`,
      at: clampTime(item.at),
      duration: Math.max(0.2, Math.min(10, Number(item.duration || 2))),
    })).sort((a, b) => a.at - b.at),
    zoomKeyframes: (videoEdit.zoomKeyframes || []).map(item => ({
      id: item.id || `zoom_${Math.round(Number(item.at || 0) * 1000)}_${Math.random().toString(36).slice(2, 7)}`,
      at: clampTime(item.at),
      scale: Math.max(1, Math.min(3, Number(item.scale || 1.4))),
      scaleX: Math.max(1, Math.min(4, Number(item.scaleX ?? item.scale ?? 1.4))),
      scaleY: Math.max(1, Math.min(4, Number(item.scaleY ?? item.scale ?? 1.4))),
      posX: Math.max(-100, Math.min(100, Number(item.posX || 0))),
      posY: Math.max(-100, Math.min(100, Number(item.posY || 0))),
      rotation: Math.max(-45, Math.min(45, Number(item.rotation || 0))),
      anchorX: Math.max(0, Math.min(100, Number(item.anchorX ?? 50))),
      anchorY: Math.max(0, Math.min(100, Number(item.anchorY ?? 50))),
      duration: Math.max(0.2, Math.min(10, Number(item.duration || 2))),
    })).sort((a, b) => a.at - b.at),
    audio: {
      muted: !!videoEdit.audio?.muted,
      volume: Math.max(0, Math.min(1, Number(videoEdit.audio?.volume ?? 1))),
    },
    chromaKey: {
      enabled: !!videoEdit.chromaKey?.enabled,
      color: videoEdit.chromaKey?.color || '#00ff00',
      strength: Math.max(0, Math.min(1, Number(videoEdit.chromaKey?.strength ?? 0.35))),
    },
  };
}

function editedOutputDuration() {
  return buildTimelineSegments().reduce((sum, item) => sum + item.duration, 0);
}

function buildTimelineSegments() {
  const duration = videoDuration();
  const end = videoEdit.trimEnd || duration;
  const start = videoEdit.trimStart || 0;
  const segments = [];
  let cursor = start;
  (videoEdit.freezeFrames || [])
    .filter(item => item.at >= start && item.at <= end)
    .sort((a, b) => a.at - b.at)
    .forEach(item => {
      if (item.at > cursor) {
        segments.push({ type: 'video', sourceStart: cursor, sourceEnd: item.at, duration: item.at - cursor });
      }
      segments.push({ type: 'freeze', id: item.id, sourceAt: item.at, duration: Number(item.duration || 2) });
      cursor = item.at;
    });
  if (end > cursor) {
    segments.push({ type: 'video', sourceStart: cursor, sourceEnd: end, duration: end - cursor });
  }
  let outputStart = 0;
  return segments.map(segment => {
    const withOutput = { ...segment, outputStart };
    outputStart += segment.duration;
    return withOutput;
  });
}

function sourceToOutputTime(sourceTime) {
  const source = clampTime(sourceTime);
  let out = Math.max(0, source - (videoEdit.trimStart || 0));
  for (const freeze of videoEdit.freezeFrames || []) {
    if (freeze.at < source) out += Number(freeze.duration || 2);
  }
  return Math.max(0, out);
}

function currentOutputTime() {
  if (outputPlaybackTime !== null) {
    return Math.max(0, Math.min(editedOutputDuration(), outputPlaybackTime));
  }
  if (freezeHoldActive) {
    const elapsed = (performance.now() - freezeHoldActive.startedAt) / 1000;
    return freezeHoldActive.outputStart + Math.min(freezeHoldActive.duration, Math.max(0, elapsed));
  }
  if (timelinePreviewOutputTime !== null && vidPlayer.paused) {
    return Math.max(0, Math.min(editedOutputDuration(), timelinePreviewOutputTime));
  }
  return sourceToOutputTime(vidPlayer.currentTime || 0);
}

function outputToSourceTime(outputTime) {
  const out = Math.max(0, Number(outputTime || 0));
  const segments = buildTimelineSegments();
  for (const segment of segments) {
    const local = out - segment.outputStart;
    if (local < 0 || local > segment.duration) continue;
    if (segment.type === 'freeze') return segment.sourceAt;
    return segment.sourceStart + local;
  }
  return videoEdit.trimEnd || videoDuration();
}

function segmentForOutputTime(outputTime) {
  const out = Math.max(0, Number(outputTime || 0));
  const segments = buildTimelineSegments();
  return segments.find((segment, index) => {
    const end = segment.outputStart + segment.duration;
    return out >= segment.outputStart && (out < end || index === segments.length - 1);
  }) || null;
}

function captureCurrentVideoFrame() {
  if (!vidPlayer.videoWidth || !vidPlayer.videoHeight) return '';
  try {
    const canvas = document.createElement('canvas');
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / vidPlayer.videoWidth);
    canvas.width = Math.max(1, Math.round(vidPlayer.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(vidPlayer.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(vidPlayer, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (error) {
    console.warn('Cannot capture freeze frame', error);
    return '';
  }
}

function setFreezeOverlay(src) {
  if (!editorEls.freezeOverlay) return;
  if (src) {
    if (editorEls.freezeOverlay.src !== src) editorEls.freezeOverlay.src = src;
    editorEls.freezeOverlay.classList.add('show');
  } else {
    editorEls.freezeOverlay.classList.remove('show');
    editorEls.freezeOverlay.removeAttribute('src');
  }
}

function selectedZoomClip() {
  if (selectedEditorItem?.type !== 'zoom') return null;
  return (videoEdit.zoomKeyframes || []).find(item => item.id === selectedEditorItem.id) || null;
}

function activeZoomClipAt(time) {
  return (videoEdit.zoomKeyframes || [])
    .slice()
    .reverse()
    .find(item => time >= item.at && time <= item.at + Number(item.duration || 2)) || null;
}

function syncZoomTransformPanel() {
  const zoom = selectedZoomClip() || activeZoomClipAt(vidPlayer.currentTime || 0);
  const scaleX = Number(zoom?.scaleX ?? zoom?.scale ?? editorEls.zoomScaleX?.value ?? 1.4);
  const scaleY = Number(zoom?.scaleY ?? zoom?.scale ?? editorEls.zoomScaleY?.value ?? 1.4);
  const posX = Number(zoom?.posX ?? editorEls.zoomPosX?.value ?? 0);
  const posY = Number(zoom?.posY ?? editorEls.zoomPosY?.value ?? 0);
  const rotation = Number(zoom?.rotation ?? editorEls.zoomRotation?.value ?? 0);
  const anchorX = Number(zoom?.anchorX ?? editorEls.zoomAnchorX?.value ?? 50);
  const anchorY = Number(zoom?.anchorY ?? editorEls.zoomAnchorY?.value ?? 50);
  if (editorEls.zoomScaleX) editorEls.zoomScaleX.value = scaleX.toFixed(2);
  if (editorEls.zoomScaleY) editorEls.zoomScaleY.value = scaleY.toFixed(2);
  if (editorEls.zoomPosX) editorEls.zoomPosX.value = posX.toFixed(0);
  if (editorEls.zoomPosY) editorEls.zoomPosY.value = posY.toFixed(0);
  if (editorEls.zoomRotation) editorEls.zoomRotation.value = rotation.toFixed(0);
  if (editorEls.zoomRotationRange) editorEls.zoomRotationRange.value = rotation.toFixed(0);
  if (editorEls.zoomAnchorX) editorEls.zoomAnchorX.value = anchorX.toFixed(0);
  if (editorEls.zoomAnchorY) editorEls.zoomAnchorY.value = anchorY.toFixed(0);
  if (editorEls.zoomValue) editorEls.zoomValue.textContent = `${scaleX.toFixed(2)}x / ${scaleY.toFixed(2)}x`;
}

function updateSelectedZoomTransform(patch) {
  const zoom = selectedZoomClip();
  if (!zoom) return;
  Object.assign(zoom, patch);
  zoom.scale = Math.max(Number(zoom.scaleX || 1), Number(zoom.scaleY || 1));
  saveVideoEdit();
}

function stopOutputPlayback({ keepPreview = true } = {}) {
  if (outputPlaybackRaf) {
    cancelAnimationFrame(outputPlaybackRaf);
    outputPlaybackRaf = null;
  }
  const currentOut = outputPlaybackTime;
  outputPlaybackActive = false;
  outputPlaybackStartedAt = 0;
  outputPlaybackStartTime = 0;
  outputPlaybackTime = null;
  if (keepPreview && currentOut !== null) timelinePreviewOutputTime = currentOut;
  setFreezeOverlay('');
  if (!vidPlayer.paused) vidPlayer.pause();
  if (vidPlayBtn) vidPlayBtn.textContent = '▶';
  renderVideoEditor();
}

function showOutputFrame(outputTime) {
  const total = editedOutputDuration();
  const out = Math.max(0, Math.min(total, Number(outputTime || 0)));
  const segment = segmentForOutputTime(out);
  if (!segment) return;
  outputPlaybackTime = out;
  if (segment.type === 'freeze') {
    if (!vidPlayer.paused) vidPlayer.pause();
    if (Math.abs((vidPlayer.currentTime || 0) - segment.sourceAt) > 0.03) {
      vidPlayer.currentTime = segment.sourceAt;
    }
    setFreezeOverlay(freezeFrameImages.get(segment.id) || '');
  } else {
    setFreezeOverlay('');
    const local = Math.max(0, Math.min(segment.duration, out - segment.outputStart));
    const sourceTime = segment.sourceStart + local;
    if (Math.abs((vidPlayer.currentTime || 0) - sourceTime) > 0.12) {
      vidPlayer.currentTime = sourceTime;
    }
    if (vidPlayer.paused && outputPlaybackActive) safePlay(vidPlayer);
  }
  renderVideoEditor();
}

function tickOutputPlayback() {
  if (!outputPlaybackActive) return;
  const out = outputPlaybackStartTime + (performance.now() - outputPlaybackStartedAt) / 1000;
  const total = editedOutputDuration();
  if (out >= total) {
    showOutputFrame(total);
    stopOutputPlayback({ keepPreview: true });
    return;
  }
  showOutputFrame(out);
  outputPlaybackRaf = requestAnimationFrame(tickOutputPlayback);
}

function startOutputPlayback(startOutput = null) {
  if (!videoDuration()) return;
  clearFreezeHold();
  playedFreezeHolds.clear();
  timelinePreviewOutputTime = null;
  outputPlaybackStartTime = startOutput === null
    ? (outputPlaybackTime ?? currentOutputTime())
    : Math.max(0, Math.min(editedOutputDuration(), startOutput));
  outputPlaybackStartedAt = performance.now();
  outputPlaybackActive = true;
  if (vidPlayBtn) vidPlayBtn.textContent = '⏸';
  showOutputFrame(outputPlaybackStartTime);
  outputPlaybackRaf = requestAnimationFrame(tickOutputPlayback);
}

function toggleEditorPlayback() {
  if (outputPlaybackActive) {
    stopOutputPlayback({ keepPreview: true });
    return;
  }
  if ((videoEdit.freezeFrames || []).length) {
    startOutputPlayback(timelinePreviewOutputTime);
    return;
  }
  timelinePreviewOutputTime = null;
  setFreezeOverlay('');
  vidPlayer.paused ? safePlay(vidPlayer) : vidPlayer.pause();
}

function renderVideoTransport() {
  const sourceDuration = videoDuration();
  const outputDuration = editedOutputDuration() || sourceDuration;
  const outputTime = currentOutputTime();
  const displayDuration = outputDuration || sourceDuration || 0;
  if (outputPlaybackActive || timelinePreviewOutputTime !== null || (videoEdit.freezeFrames || []).length) {
    if (vidScrubber && displayDuration) vidScrubber.value = String(Math.max(0, Math.min(100, outputTime / displayDuration * 100)));
    if (vidTimeEl) vidTimeEl.textContent = `${fmtTime(outputTime)} / ${fmtTime(displayDuration)}`;
    return;
  }
  if (vidScrubber && sourceDuration) vidScrubber.value = String((vidPlayer.currentTime / sourceDuration) * 100);
  if (vidTimeEl) vidTimeEl.textContent = fmtTime(vidPlayer.currentTime) + ' / ' + fmtTime(sourceDuration);
}

function renderVideoEditor() {
  const duration = videoDuration();
  videoEdit = normalizedVideoEdit();
  const end = videoEdit.trimEnd || duration;
  const outputDuration = editedOutputDuration();
  if (editorEls.shell && duration) {
    editorEls.shell.style.width = `${Math.max(900, Math.round(outputDuration * timelinePixelsPerSecond))}px`;
  }
  if (editorEls.trimStart) editorEls.trimStart.value = videoEdit.trimStart.toFixed(1);
  if (editorEls.trimEnd) editorEls.trimEnd.value = (end || 0).toFixed(1);
  if (editorEls.volume) editorEls.volume.value = String(videoEdit.audio.volume);
  if (editorEls.muted) editorEls.muted.checked = videoEdit.audio.muted;
  if (editorEls.chromaEnabled) editorEls.chromaEnabled.checked = videoEdit.chromaKey.enabled;
  if (editorEls.chromaStrength) editorEls.chromaStrength.value = String(videoEdit.chromaKey.strength);
  vidPlayer.muted = videoEdit.audio.muted;
  vidPlayer.volume = videoEdit.audio.volume;

  const pct = outputDuration ? (value) => Math.max(0, Math.min(100, value / outputDuration * 100)) : () => 0;
  const sourcePct = duration ? (value) => Math.max(0, Math.min(100, value / duration * 100)) : () => 0;
  const currentPct = pct(currentOutputTime());
  if (editorEls.playhead) editorEls.playhead.style.left = `${currentPct}%`;
  if (editorEls.trimRange) {
    editorEls.trimRange.style.left = '0%';
    editorEls.trimRange.style.width = '100%';
    editorEls.trimRange.innerHTML = '<span class="trim-handle start" data-trim-handle="start"></span><span class="trim-handle end" data-trim-handle="end"></span>';
  }
  if (editorEls.markers) {
    const clipHtml = buildTimelineSegments().map(segment => segment.type === 'video'
      ? `<span class="timeline-video-clip" style="left:${pct(segment.outputStart)}%;width:${pct(segment.duration)}%" title="Видео ${fmtTime(segment.sourceStart)}-${fmtTime(segment.sourceEnd)}"></span>`
      : '').join('');
    const splitHtml = videoEdit.splits.map(t => `<span class="timeline-marker split ${selectedEditorItem?.type === 'split' && Math.abs(selectedEditorItem.at - t) < 0.11 ? 'selected' : ''}" data-split-at="${t}" title="Разрез ${fmtTime(t)}" style="left:${pct(sourceToOutputTime(t))}%"></span>`).join('');
    const freezeHtml = videoEdit.freezeFrames.map(f => {
      const freezeSegment = buildTimelineSegments().find(segment => segment.type === 'freeze' && segment.id === f.id);
      const outputStart = freezeSegment?.outputStart ?? sourceToOutputTime(f.at);
      return `
      <span class="timeline-freeze-block ${selectedEditorItem?.type === 'freeze' && selectedEditorItem.id === f.id ? 'selected' : ''}"
        data-freeze-id="${esc(f.id)}"
        title="Стоп-кадр ${fmtTime(f.duration)} на ${fmtTime(f.at)}"
        style="left:${pct(outputStart)}%;width:${Math.max(2.5, pct(f.duration))}%">
        <span class="freeze-resize start" data-freeze-edge="start"></span>
        +${Number(f.duration || 2).toFixed(1)}с
        <span class="freeze-resize end" data-freeze-edge="end"></span>
      </span>`;
    }).join('');
    editorEls.markers.innerHTML = clipHtml + splitHtml + freezeHtml;
  }
  if (editorEls.effectMarkers) {
    const zoomHtml = videoEdit.zoomKeyframes.map(z => `
      <span class="timeline-zoom-block ${selectedEditorItem?.type === 'zoom' && selectedEditorItem.id === z.id ? 'selected' : ''}"
        data-zoom-id="${esc(z.id)}"
        title="Зум ${Number(z.scale || 1).toFixed(1)}x, ${fmtTime(z.duration)}"
        style="left:${pct(sourceToOutputTime(z.at))}%;width:${Math.max(2.5, pct(z.duration))}%">
        <span class="zoom-resize start" data-zoom-edge="start"></span>
        ${Number(z.scale || 1).toFixed(1)}x
        <span class="zoom-resize end" data-zoom-edge="end"></span>
      </span>`).join('');
    editorEls.effectMarkers.innerHTML = zoomHtml;
  }
  if (editorEls.timeLabel) editorEls.timeLabel.textContent = `${fmtTime(vidPlayer.currentTime || 0)} / ${fmtTime(duration)} · итог ${fmtTime(outputDuration)}`;
  renderVideoTransport();
  syncZoomTransformPanel();
  applyVideoEditPreview();
  if (editorEls.summary) {
    const parts = [];
    if (videoEdit.trimStart > 0 || (duration && end < duration)) parts.push(`обрезка ${fmtTime(videoEdit.trimStart)}-${fmtTime(end)}`);
    if (videoEdit.splits.length) parts.push(`разрезов: ${videoEdit.splits.length}`);
    if (videoEdit.freezeFrames.length) parts.push(`стоп-кадров: ${videoEdit.freezeFrames.length} (+${fmtTime(videoEdit.freezeFrames.reduce((s, f) => s + Number(f.duration || 2), 0))})`);
    if (videoEdit.zoomKeyframes.length) parts.push(`зумов: ${videoEdit.zoomKeyframes.length}`);
    if (videoEdit.audio.muted) parts.push('звук выключен');
    if (videoEdit.chromaKey.enabled) parts.push('хромакей');
    if (parts.length) parts.push(`итог: ${fmtTime(editedOutputDuration())}`);
    editorEls.summary.textContent = parts.length ? parts.join(' · ') : 'Видео без правок';
  }
}

function setEditorMode(mode) {
  activeEditorMode = mode || 'trim';
  document.querySelectorAll('[data-editor-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editorMode === activeEditorMode);
  });
  editorEls.effectsPanel?.classList.toggle('open', activeEditorMode === 'effects');
  editorEls.zoomPanel?.classList.toggle('open', activeEditorMode === 'zoom');
  const hints = {
    trim: 'Клик или drag по таймлайну только перематывает. Для обрезки тяни белые края зелёного отрезка или жми “Поставить старт/конец”.',
    split: 'Перемотай на нужное место и нажми “Разрезать тут”. Обычный клик по таймлайну больше не добавляет разрез.',
    freeze: 'Перемотай на кадр и нажми “Добавить стоп-кадр 2с”. Появится фиолетовый клип, его можно двигать, тянуть за край и удалить.',
    zoom: 'Выбери силу зума и нажми “Добавить зум”. Зелёный клип на дорожке эффектов можно двигать, растягивать и удалить.',
    effects: 'Футаж сейчас сохраняет настройки звука и хромакея в заявке. Финальный рендер делает модерация/обработка.',
  };
  if (editorEls.hint) editorEls.hint.textContent = hints[activeEditorMode] || hints.trim;
}

function applyVideoEditPreview() {
  const time = vidPlayer.currentTime || 0;
  const activeZoom = activeZoomClipAt(time);
  const scaleX = activeZoom ? Number(activeZoom.scaleX ?? activeZoom.scale ?? 1) : 1;
  const scaleY = activeZoom ? Number(activeZoom.scaleY ?? activeZoom.scale ?? 1) : 1;
  const posX = activeZoom ? Number(activeZoom.posX || 0) : 0;
  const posY = activeZoom ? Number(activeZoom.posY || 0) : 0;
  const rotation = activeZoom ? Number(activeZoom.rotation || 0) : 0;
  const anchorX = activeZoom ? Number(activeZoom.anchorX ?? 50) : 50;
  const anchorY = activeZoom ? Number(activeZoom.anchorY ?? 50) : 50;
  const transformOrigin = `${anchorX}% ${anchorY}%`;
  const transform = `translate(${posX}px, ${posY}px) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`;
  vidPlayer.style.transformOrigin = transformOrigin;
  vidPlayer.style.transform = transform;
  if (editorEls.freezeOverlay) {
    editorEls.freezeOverlay.style.transformOrigin = transformOrigin;
    editorEls.freezeOverlay.style.transform = transform;
  }
  vidPlayer.style.filter = videoEdit.chromaKey?.enabled ? `saturate(${1 + videoEdit.chromaKey.strength}) contrast(1.08)` : '';
  editorEls.zoomFrame?.classList.toggle('show', scaleX > 1.01 || scaleY > 1.01 || activeEditorMode === 'zoom');
  if (editorEls.zoomFrame) editorEls.zoomFrame.textContent = activeZoom ? `${scaleX.toFixed(2)}x/${scaleY.toFixed(2)}x` : 'Зум';
}

function timeFromTimelineEvent(event) {
  const duration = videoDuration();
  if (!duration || !editorEls.shell) return 0;
  const rect = editorEls.shell.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return outputToSourceTime(ratio * editedOutputDuration());
}

function outputTimeFromTimelineEvent(event) {
  if (!editorEls.shell) return 0;
  const rect = editorEls.shell.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return ratio * editedOutputDuration();
}

function timelineSnapPoints() {
  const outputDuration = editedOutputDuration();
  const points = new Set([0, outputDuration]);
  buildTimelineSegments().forEach(segment => {
    points.add(segment.outputStart);
    points.add(segment.outputStart + segment.duration);
  });
  (videoEdit.splits || []).forEach(time => points.add(sourceToOutputTime(time)));
  (videoEdit.freezeFrames || []).forEach(freeze => {
    const segment = buildTimelineSegments().find(item => item.type === 'freeze' && item.id === freeze.id);
    const start = segment?.outputStart ?? sourceToOutputTime(freeze.at);
    points.add(start);
    points.add(start + Number(freeze.duration || 2));
  });
  (videoEdit.zoomKeyframes || []).forEach(zoom => {
    const start = sourceToOutputTime(zoom.at);
    points.add(start);
    points.add(start + Number(zoom.duration || 2));
  });
  return [...points].filter(Number.isFinite).sort((a, b) => a - b);
}

function snapOutputTime(outputTime) {
  const outputDuration = editedOutputDuration();
  const raw = Math.max(0, Math.min(outputDuration, Number(outputTime || 0)));
  if (!timelineMagnetEnabled) return raw;
  const threshold = Math.max(0.07, Math.min(0.28, 12 / Math.max(1, timelinePixelsPerSecond)));
  let best = raw;
  let bestDistance = threshold;
  timelineSnapPoints().forEach(point => {
    const distance = Math.abs(point - raw);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  });
  return Math.max(0, Math.min(outputDuration, best));
}

function timelineTimesFromEvent(event) {
  const outputTime = snapOutputTime(outputTimeFromTimelineEvent(event));
  return { outputTime, sourceTime: clampTime(outputToSourceTime(outputTime)) };
}

function autoScrollTimelineWhileDragging(event) {
  if (!editorEls.scroll || !timelineDrag) return;
  const maxScroll = editorEls.scroll.scrollWidth - editorEls.scroll.clientWidth;
  if (maxScroll <= 0) return;
  const rect = editorEls.scroll.getBoundingClientRect();
  const edge = 46;
  let delta = 0;
  if (event.clientX > rect.right - edge) {
    delta = Math.min(32, edge - (rect.right - event.clientX));
  } else if (event.clientX < rect.left + edge) {
    delta = -Math.min(32, edge - (event.clientX - rect.left));
  }
  if (!delta) return;
  editorEls.scroll.scrollLeft = Math.max(0, Math.min(maxScroll, editorEls.scroll.scrollLeft + delta));
}

function syncMagnetButton() {
  editorEls.magnet?.classList.toggle('active', timelineMagnetEnabled);
  editorEls.magnet?.setAttribute('aria-pressed', timelineMagnetEnabled ? 'true' : 'false');
  if (editorEls.magnet) editorEls.magnet.title = timelineMagnetEnabled
    ? 'Магнит включён: прилипает к стыкам клипов'
    : 'Магнит выключен';
}

function applyTimelineTool(time, outputTime = null) {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  vidPlayer.pause();
  const segment = outputTime === null ? null : segmentForOutputTime(outputTime);
  setFreezeOverlay(segment?.type === 'freeze' ? (freezeFrameImages.get(segment.id) || '') : '');
  timelinePreviewOutputTime = outputTime === null ? sourceToOutputTime(time) : Math.max(0, Math.min(editedOutputDuration(), outputTime));
  vidPlayer.currentTime = clampTime(time);
  renderVideoEditor();
}

function addUniqueTime(list, time) {
  const t = Math.round(clampTime(time) * 10) / 10;
  if (!t && t !== 0) return list;
  if (list.some(v => Math.abs(v - t) < 0.11)) return list.filter(v => Math.abs(v - t) >= 0.11);
  return [...list, t].sort((a, b) => a - b);
}

function saveVideoEdit() {
  videoEdit = normalizedVideoEdit();
  renderVideoEditor();
  _saveDraft();
}

function resetVideoEdit() {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  timelinePreviewOutputTime = null;
  freezeFrameImages.clear();
  setFreezeOverlay('');
  videoEdit = createDefaultVideoEdit();
  videoEdit.trimEnd = videoDuration();
  saveVideoEdit();
}

function clearFreezeHold() {
  if (freezeHoldTimer) {
    clearTimeout(freezeHoldTimer);
    freezeHoldTimer = null;
  }
  if (freezeHoldRenderInterval) {
    clearInterval(freezeHoldRenderInterval);
    freezeHoldRenderInterval = null;
  }
  freezeHoldActive = null;
}

dropZone.addEventListener('click', () => vidInput.click());
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleVideoFile(file);
});
vidInput.addEventListener('change', () => { if (vidInput.files[0]) handleVideoFile(vidInput.files[0]); });
document.querySelectorAll('[data-editor-mode]').forEach(btn => {
  btn.addEventListener('click', () => setEditorMode(btn.dataset.editorMode || 'trim'));
});
editorEls.shell?.addEventListener('click', event => {
  if (suppressTimelineClick) {
    suppressTimelineClick = false;
    return;
  }
  const { outputTime, sourceTime } = timelineTimesFromEvent(event);
  applyTimelineTool(sourceTime, outputTime);
});
editorEls.shell?.addEventListener('pointerdown', event => {
  const duration = videoDuration();
  if (!duration) return;
  const splitMarker = event.target.closest('[data-split-at]');
  if (splitMarker) {
    selectedEditorItem = { type: 'split', at: Number(splitMarker.dataset.splitAt || 0) };
    suppressTimelineClick = true;
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const zoomBlock = event.target.closest('[data-zoom-id]');
  if (zoomBlock) {
    const id = zoomBlock.dataset.zoomId || '';
    const edge = event.target.closest('[data-zoom-edge]')?.dataset.zoomEdge || '';
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === id);
    selectedEditorItem = { type: 'zoom', id };
    setEditorMode('zoom');
    timelineDrag = edge
      ? { kind: 'zoom-resize', edge, id, moved: false, startAt: Number(zoom?.at || 0), startDuration: Number(zoom?.duration || 2) }
      : { kind: 'zoom', id, moved: false, offset: zoom ? timeFromTimelineEvent(event) - zoom.at : 0 };
    suppressTimelineClick = true;
    editorEls.shell.setPointerCapture?.(event.pointerId);
    editorEls.shell.classList.add('dragging');
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const freezeBlock = event.target.closest('[data-freeze-id]');
  if (freezeBlock) {
    const id = freezeBlock.dataset.freezeId || '';
    const edge = event.target.closest('[data-freeze-edge]')?.dataset.freezeEdge || '';
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === id);
    selectedEditorItem = { type: 'freeze', id };
    timelineDrag = edge
      ? { kind: 'freeze-resize', edge, id, moved: false, startX: event.clientX, startAt: Number(freeze?.at || 0), startDuration: Number(freeze?.duration || 2) }
      : { kind: 'freeze', id, moved: false, offset: freeze ? timeFromTimelineEvent(event) - freeze.at : 0 };
    suppressTimelineClick = true;
    editorEls.shell.setPointerCapture?.(event.pointerId);
    editorEls.shell.classList.add('dragging');
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const handle = event.target.closest('[data-trim-handle]');
  timelineDrag = { kind: handle?.dataset.trimHandle || 'playhead', moved: false };
  editorEls.shell.setPointerCapture?.(event.pointerId);
  editorEls.shell.classList.add('dragging');
  event.preventDefault();
});
editorEls.shell?.addEventListener('pointermove', event => {
  if (!timelineDrag) return;
  timelineDrag.moved = true;
  autoScrollTimelineWhileDragging(event);
  const rawTime = clampTime(timeFromTimelineEvent(event));
  const { outputTime, sourceTime } = timelineTimesFromEvent(event);
  const time = sourceTime;
  if (timelineDrag.kind === 'start') {
    videoEdit.trimStart = Math.min(time, videoEdit.trimEnd || videoDuration());
  } else if (timelineDrag.kind === 'end') {
    videoEdit.trimEnd = Math.max(time, videoEdit.trimStart);
  } else if (timelineDrag.kind === 'freeze') {
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === timelineDrag.id);
    if (freeze) {
      const rawStart = clampTime(rawTime - (timelineDrag.offset || 0));
      freeze.at = clampTime(outputToSourceTime(snapOutputTime(sourceToOutputTime(rawStart))));
    }
  } else if (timelineDrag.kind === 'freeze-resize') {
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === timelineDrag.id);
    if (freeze) {
      const delta = (event.clientX - timelineDrag.startX) / timelinePixelsPerSecond;
      if (timelineDrag.edge === 'start') {
        const nextAt = clampTime(timelineDrag.startAt + delta);
        const endAt = timelineDrag.startAt + timelineDrag.startDuration;
        freeze.at = Math.min(nextAt, Math.max(0, endAt - 0.2));
        freeze.duration = Math.max(0.2, Math.min(10, endAt - freeze.at));
      } else {
        freeze.duration = Math.max(0.2, Math.min(10, timelineDrag.startDuration + delta));
      }
    }
  } else if (timelineDrag.kind === 'zoom') {
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === timelineDrag.id);
    if (zoom) {
      const rawStart = clampTime(rawTime - (timelineDrag.offset || 0));
      zoom.at = clampTime(outputToSourceTime(snapOutputTime(sourceToOutputTime(rawStart))));
    }
  } else if (timelineDrag.kind === 'zoom-resize') {
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === timelineDrag.id);
    if (zoom) {
      if (timelineDrag.edge === 'start') {
        const maxStart = Math.max(0, timelineDrag.startAt + timelineDrag.startDuration - 0.2);
        const nextStart = Math.min(maxStart, clampTime(time));
        zoom.at = nextStart;
        zoom.duration = Math.max(0.2, Math.min(10, timelineDrag.startAt + timelineDrag.startDuration - nextStart));
      } else {
        zoom.duration = Math.max(0.2, Math.min(10, clampTime(time) - zoom.at));
      }
    }
  } else {
    stopOutputPlayback({ keepPreview: false });
    clearFreezeHold();
    vidPlayer.pause();
    timelinePreviewOutputTime = outputTime;
    const segment = segmentForOutputTime(outputTime);
    setFreezeOverlay(segment?.type === 'freeze' ? (freezeFrameImages.get(segment.id) || '') : '');
    vidPlayer.currentTime = time;
  }
  renderVideoEditor();
});
editorEls.shell?.addEventListener('pointerup', event => {
  if (!timelineDrag) return;
  const wasTrim = timelineDrag.kind === 'start' || timelineDrag.kind === 'end';
  const wasFreeze = timelineDrag.kind === 'freeze' || timelineDrag.kind === 'freeze-resize';
  const wasZoom = timelineDrag.kind === 'zoom' || timelineDrag.kind === 'zoom-resize';
  editorEls.shell.releasePointerCapture?.(event.pointerId);
  editorEls.shell.classList.remove('dragging');
  const moved = timelineDrag.moved;
  timelineDrag = null;
  suppressTimelineClick = moved || wasFreeze || wasZoom;
  if ((wasTrim || wasFreeze || wasZoom) && moved) saveVideoEdit();
});
editorEls.shell?.addEventListener('pointercancel', () => {
  timelineDrag = null;
  editorEls.shell.classList.remove('dragging');
});
editorEls.trimStart?.addEventListener('change', event => {
  videoEdit.trimStart = clampTime(event.target.value);
  if (videoEdit.trimEnd && videoEdit.trimStart > videoEdit.trimEnd) videoEdit.trimEnd = videoEdit.trimStart;
  saveVideoEdit();
});
editorEls.trimEnd?.addEventListener('change', event => {
  videoEdit.trimEnd = clampTime(event.target.value);
  if (videoEdit.trimEnd < videoEdit.trimStart) videoEdit.trimStart = videoEdit.trimEnd;
  saveVideoEdit();
});
editorEls.volume?.addEventListener('input', event => {
  videoEdit.audio.volume = Number(event.target.value || 1);
  saveVideoEdit();
});
editorEls.muted?.addEventListener('change', event => {
  videoEdit.audio.muted = !!event.target.checked;
  saveVideoEdit();
});
editorEls.chromaEnabled?.addEventListener('change', event => {
  videoEdit.chromaKey.enabled = !!event.target.checked;
  saveVideoEdit();
});
editorEls.chromaStrength?.addEventListener('input', event => {
  videoEdit.chromaKey.strength = Number(event.target.value || 0.35);
  saveVideoEdit();
});
function bindZoomTransformInput(el, key, map = value => value) {
  el?.addEventListener('input', event => {
    if (key === 'rotation' && editorEls.zoomRotationRange && event.target === editorEls.zoomRotation) {
      editorEls.zoomRotationRange.value = event.target.value;
    }
    if (key === 'rotation' && editorEls.zoomRotation && event.target === editorEls.zoomRotationRange) {
      editorEls.zoomRotation.value = event.target.value;
    }
    updateSelectedZoomTransform({ [key]: map(Number(event.target.value || 0)) });
  });
}

function clampTransformInputValue(el, value) {
  const min = Number(el?.getAttribute('min'));
  const max = Number(el?.getAttribute('max'));
  let next = Number.isFinite(value) ? value : Number(el?.value || 0);
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function formatTransformInputValue(el, value) {
  const step = String(el?.getAttribute('step') || '1');
  const decimals = step.includes('.') ? step.split('.')[1].length : 0;
  return clampTransformInputValue(el, value).toFixed(decimals);
}

function enterTransformTextEdit(el) {
  if (!el) return;
  el.readOnly = false;
  el.classList.add('editing');
  el.focus();
  requestAnimationFrame(() => el.select());
}

function exitTransformTextEdit(el) {
  if (!el) return;
  el.value = formatTransformInputValue(el, Number(String(el.value).replace(',', '.')));
  el.readOnly = true;
  el.classList.remove('editing');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindTransformDragNumber(el) {
  if (!el) return;
  let drag = null;
  el.addEventListener('dblclick', event => {
    event.preventDefault();
    enterTransformTextEdit(el);
  });
  el.addEventListener('blur', () => exitTransformTextEdit(el));
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      exitTransformTextEdit(el);
      el.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      el.readOnly = true;
      el.classList.remove('editing');
      el.blur();
      syncZoomTransformPanel();
    }
  });
  el.addEventListener('pointerdown', event => {
    if (!el.readOnly || event.button !== 0) return;
    if (event.detail >= 2) {
      enterTransformTextEdit(el);
      event.preventDefault();
      return;
    }
    drag = {
      x: event.clientX,
      start: Number(String(el.value).replace(',', '.')) || 0,
      moved: false,
    };
    el.setPointerCapture?.(event.pointerId);
    el.classList.add('dragging');
    event.preventDefault();
  });
  el.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 2) drag.moved = true;
    if (!drag.moved) return;
    const step = Number(el.getAttribute('step') || 1) || 1;
    const multiplier = event.shiftKey ? 0.2 : event.altKey ? 0.05 : 0.25;
    const next = drag.start + dx * step * multiplier;
    el.value = formatTransformInputValue(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const finishDrag = event => {
    if (!drag) return;
    el.releasePointerCapture?.(event.pointerId);
    el.classList.remove('dragging');
    if (drag.moved) saveVideoEdit();
    drag = null;
  };
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
}

bindZoomTransformInput(editorEls.zoomScaleX, 'scaleX', value => Math.max(1, Math.min(4, value || 1)));
bindZoomTransformInput(editorEls.zoomScaleY, 'scaleY', value => Math.max(1, Math.min(4, value || 1)));
bindZoomTransformInput(editorEls.zoomPosX, 'posX', value => Math.max(-100, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomPosY, 'posY', value => Math.max(-100, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomRotation, 'rotation', value => Math.max(-45, Math.min(45, value)));
bindZoomTransformInput(editorEls.zoomRotationRange, 'rotation', value => Math.max(-45, Math.min(45, value)));
bindZoomTransformInput(editorEls.zoomAnchorX, 'anchorX', value => Math.max(0, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomAnchorY, 'anchorY', value => Math.max(0, Math.min(100, value)));
[
  editorEls.zoomScaleX,
  editorEls.zoomScaleY,
  editorEls.zoomPosX,
  editorEls.zoomPosY,
  editorEls.zoomRotation,
  editorEls.zoomAnchorX,
  editorEls.zoomAnchorY,
].forEach(bindTransformDragNumber);
document.getElementById('edit-zoom-reset')?.addEventListener('click', () => {
  updateSelectedZoomTransform({ scaleX: 1.4, scaleY: 1.4, scale: 1.4, posX: 0, posY: 0, rotation: 0, anchorX: 50, anchorY: 50 });
});
editorEls.timelineZoom?.addEventListener('input', event => {
  timelinePixelsPerSecond = Number(event.target.value || 52);
  renderVideoEditor();
});
editorEls.magnet?.addEventListener('click', () => {
  timelineMagnetEnabled = !timelineMagnetEnabled;
  syncMagnetButton();
  toast(timelineMagnetEnabled ? 'Магнит включён' : 'Магнит выключен', 'i');
});
syncMagnetButton();
document.getElementById('timeline-zoom-in')?.addEventListener('click', () => {
  timelinePixelsPerSecond = Math.min(120, timelinePixelsPerSecond + 8);
  if (editorEls.timelineZoom) editorEls.timelineZoom.value = String(timelinePixelsPerSecond);
  renderVideoEditor();
});
document.getElementById('timeline-zoom-out')?.addEventListener('click', () => {
  timelinePixelsPerSecond = Math.max(28, timelinePixelsPerSecond - 8);
  if (editorEls.timelineZoom) editorEls.timelineZoom.value = String(timelinePixelsPerSecond);
  renderVideoEditor();
});
document.getElementById('edit-set-in')?.addEventListener('click', () => {
  videoEdit.trimStart = clampTime(vidPlayer.currentTime);
  if (videoEdit.trimEnd && videoEdit.trimStart > videoEdit.trimEnd) videoEdit.trimEnd = videoEdit.trimStart;
  saveVideoEdit();
});
document.getElementById('edit-set-out')?.addEventListener('click', () => {
  videoEdit.trimEnd = clampTime(vidPlayer.currentTime);
  if (videoEdit.trimEnd < videoEdit.trimStart) videoEdit.trimStart = videoEdit.trimEnd;
  saveVideoEdit();
});
document.getElementById('edit-split')?.addEventListener('click', () => {
  const at = Math.round(clampTime(vidPlayer.currentTime) * 10) / 10;
  videoEdit.splits = addUniqueTime(videoEdit.splits || [], at);
  selectedEditorItem = (videoEdit.splits || []).some(t => Math.abs(t - at) < 0.11) ? { type: 'split', at } : null;
  saveVideoEdit();
});
document.getElementById('edit-freeze')?.addEventListener('click', () => {
  toggleFreezeAt(vidPlayer.currentTime);
});
function toggleFreezeAt(time) {
  const at = Math.round(clampTime(time) * 10) / 10;
  const freeze = { id: `freeze_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at, duration: 2 };
  const frame = captureCurrentVideoFrame();
  if (frame) freezeFrameImages.set(freeze.id, frame);
  videoEdit.freezeFrames = [...(videoEdit.freezeFrames || []), freeze];
  selectedEditorItem = { type: 'freeze', id: freeze.id };
  toast('Стоп-кадр +2 сек добавлен', 's');
  saveVideoEdit();
}
function deleteSelectedEditorItem() {
  if (!selectedEditorItem) { toast('Сначала выбери блок на таймлайне', 'i'); return; }
  if (selectedEditorItem.type === 'freeze') {
    videoEdit.freezeFrames = (videoEdit.freezeFrames || []).filter(item => item.id !== selectedEditorItem.id);
    freezeFrameImages.delete(selectedEditorItem.id);
    selectedEditorItem = null;
    toast('Стоп-кадр удалён', 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'zoom') {
    videoEdit.zoomKeyframes = (videoEdit.zoomKeyframes || []).filter(item => item.id !== selectedEditorItem.id);
    selectedEditorItem = null;
    toast('Зум удалён', 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'split') {
    videoEdit.splits = (videoEdit.splits || []).filter(t => Math.abs(t - selectedEditorItem.at) >= 0.11);
    selectedEditorItem = null;
    toast('Разрез удалён', 's');
    saveVideoEdit();
  }
}
document.getElementById('edit-delete-selected')?.addEventListener('click', deleteSelectedEditorItem);
document.getElementById('edit-zoom')?.addEventListener('click', () => {
  addZoomAt(vidPlayer.currentTime);
});
function addZoomAt(time) {
  const at = Math.round(clampTime(time) * 10) / 10;
  const scaleX = Math.max(1, Math.min(4, Number(editorEls.zoomScaleX?.value || 1.4)));
  const scaleY = Math.max(1, Math.min(4, Number(editorEls.zoomScaleY?.value || scaleX)));
  const posX = Math.max(-100, Math.min(100, Number(editorEls.zoomPosX?.value || 0)));
  const posY = Math.max(-100, Math.min(100, Number(editorEls.zoomPosY?.value || 0)));
  const rotation = Math.max(-45, Math.min(45, Number(editorEls.zoomRotation?.value || 0)));
  const anchorX = Math.max(0, Math.min(100, Number(editorEls.zoomAnchorX?.value || 50)));
  const anchorY = Math.max(0, Math.min(100, Number(editorEls.zoomAnchorY?.value || 50)));
  const id = `zoom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  videoEdit.zoomKeyframes = [
    ...(videoEdit.zoomKeyframes || []).filter(item => Math.abs(item.at - at) >= 0.11),
    { id, at, scale: Math.max(scaleX, scaleY), scaleX, scaleY, posX, posY, rotation, anchorX, anchorY, duration: 2 },
  ];
  selectedEditorItem = { type: 'zoom', id };
  setEditorMode('zoom');
  vidPlayer.currentTime = at;
  toast(`Зум ${scaleX.toFixed(2)}x/${scaleY.toFixed(2)}x на 2 сек добавлен`, 's');
  saveVideoEdit();
}
document.getElementById('edit-reset')?.addEventListener('click', resetVideoEdit);

function isVideoFile(file) {
  return file && (
    file.type.startsWith('video/') ||
    /\.(mp4|mov)$/i.test(file.name)
  );
}

async function handleVideoFile(file) {
  if (!isVideoFile(file)) { toast('Выбери видеофайл', 'e'); return; }
  if (file.size > 50 * 1024 * 1024) { toast('Видео превышает 50 МБ', 'e'); return; }
  if (videoXhr) { videoXhr.abort(); videoXhr = null; }
  videoUrl = null;
  dropZone.style.display = 'none';
  document.getElementById('vid-player-wrap').style.display = 'none';
  const prog = document.getElementById('vid-upload-progress');
  prog.style.display = '';
  document.getElementById('vid-pct').textContent = '0%';
  document.getElementById('vid-prog').style.width = '0%';

  const upload = uploadVideoToSelectel(file, pct => {
    const p = Math.round(pct * 100);
    document.getElementById('vid-pct').textContent = p + '%';
    document.getElementById('vid-prog').style.width = p + '%';
  });
  videoXhr = upload;

  let _cancelled = false;
  document.getElementById('vid-cancel-btn').onclick = () => {
    _cancelled = true;
    upload.abort();
    prog.style.display = 'none';
    dropZone.style.display = '';
    videoUrl = null; videoXhr = null;
    videoEdit = createDefaultVideoEdit();
    validateForm();
  };

  try {
    const url = await upload;
    if (_cancelled) return;
    videoUrl = url;
    videoXhr = null;
    prog.style.display = 'none';
    vidPlayer.crossOrigin = 'anonymous';
    vidPlayer.src = url;
    document.getElementById('vid-player-wrap').style.display = '';
    videoEdit = createDefaultVideoEdit();
    toast('Видео загружено ✅', 's');
    validateForm(); _saveDraft();
    renderVideoEditor();
  } catch (e) {
    if (e.message === 'canceled') return;
    videoXhr = null;
    prog.style.display = 'none';
    dropZone.style.display = '';
    toast('Ошибка загрузки: ' + e.message, 'e');
  }
}

vidPlayer.addEventListener('timeupdate', () => {
  if (!vidPlayer.duration) return;
  const end = videoEdit.trimEnd || vidPlayer.duration;
  if (vidPlayer.currentTime < videoEdit.trimStart) vidPlayer.currentTime = videoEdit.trimStart;
  if (vidPlayer.currentTime > end) {
    if (outputPlaybackActive) stopOutputPlayback({ keepPreview: true });
    else vidPlayer.pause();
    vidPlayer.currentTime = videoEdit.trimStart;
    playedFreezeHolds.clear();
  }
  renderVideoEditor();
  lastVideoTime = vidPlayer.currentTime;
});
vidPlayer.addEventListener('loadedmetadata', () => {
  if (!videoEdit.trimEnd) videoEdit.trimEnd = videoDuration();
  renderVideoEditor();
});
vidPlayer.addEventListener('play',  () => {
  if ((videoEdit.freezeFrames || []).length && !outputPlaybackActive) {
    vidPlayer.pause();
    startOutputPlayback(timelinePreviewOutputTime ?? sourceToOutputTime(vidPlayer.currentTime || 0));
    return;
  }
  timelinePreviewOutputTime = null;
  if (!outputPlaybackActive) outputPlaybackTime = null;
  vidPlayBtn.textContent = '⏸';
  lastVideoTime = vidPlayer.currentTime;
});
vidPlayer.addEventListener('pause', () => { if (!outputPlaybackActive) vidPlayBtn.textContent = '▶'; });
vidPlayer.addEventListener('seeking', () => { clearFreezeHold(); if (!outputPlaybackActive) outputPlaybackTime = null; lastVideoTime = vidPlayer.currentTime; });
vidScrubber.addEventListener('input', () => {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  playedFreezeHolds.clear();
  const ratio = Number(vidScrubber.value || 0) / 100;
  if ((videoEdit.freezeFrames || []).length) {
    const outputTime = ratio * editedOutputDuration();
    applyTimelineTool(outputToSourceTime(outputTime), outputTime);
  } else {
    timelinePreviewOutputTime = null;
    setFreezeOverlay('');
    vidPlayer.currentTime = ratio * vidPlayer.duration;
  }
});
vidPlayBtn.addEventListener('click', toggleEditorPlayback);
document.getElementById('vid-remove-btn').addEventListener('click', () => {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  timelinePreviewOutputTime = null;
  freezeFrameImages.clear();
  setFreezeOverlay('');
  vidPlayer.src = '';
  videoUrl = null;
  videoEdit = createDefaultVideoEdit();
  document.getElementById('vid-player-wrap').style.display = 'none';
  dropZone.style.display = '';
  vidInput.value = '';
  validateForm(); _saveDraft();
});

// Frame capture — pause first so the frame is stable, set crossOrigin before src
document.getElementById('vid-frame-btn').addEventListener('click', async () => {
  if (!vidPlayer.videoWidth) { toast('Видео ещё не готово', 'i'); return; }
  if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
  const btn = document.getElementById('vid-frame-btn');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    vidPlayer.pause();
    await new Promise(r => setTimeout(r, 50));
    const canvas = document.createElement('canvas');
    canvas.width  = vidPlayer.videoWidth;
    canvas.height = vidPlayer.videoHeight;
    canvas.getContext('2d').drawImage(vidPlayer, 0, 0);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Не удалось захватить кадр');
    const compressed = await compressImage(blob);
    const localUrl = URL.createObjectURL(blob);
    const entry = { localUrl, cloudUrl: null, uploading: true };
    screenshots.push(entry);
    renderScreenshots();
    const url = await uploadToCloudinary(compressed);
    entry.cloudUrl = url; entry.uploading = false;
    renderScreenshots(); _saveDraft();
    toast('Кадр добавлен ✅', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  } finally {
    btn.disabled = false; btn.textContent = '📷 Кадр';
  }
});

// Global keyboard shortcuts for video player
document.addEventListener('pointerdown', event => {
  const wrap = document.getElementById('vid-player-wrap');
  videoEditorHotkeysActive = !!(wrap && wrap.contains(event.target));
}, true);

function hasVideoForHotkeys() {
  const player = document.getElementById('vid-player');
  return !!(player && (player.currentSrc || player.src) && !player.error);
}

function isTextTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return ['text', 'email', 'password', 'search', 'url', 'tel', 'number'].includes(type);
}

function handleVideoEditorSpace(event, shouldToggle) {
  const isSpace = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  if (!isSpace || !hasVideoForHotkeys()) return false;
  const wrap = document.getElementById('vid-player-wrap');
  const insideEditor = !!(wrap && wrap.contains(event.target));
  if (!insideEditor && !videoEditorHotkeysActive) return false;
  if (isTextTypingTarget(event.target) && !insideEditor) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  if (document.activeElement && document.activeElement !== document.body && !isTextTypingTarget(document.activeElement)) {
    document.activeElement.blur?.();
  }
  if (shouldToggle) {
    toggleEditorPlayback();
  }
  return true;
}

['keydown', 'keypress', 'keyup'].forEach(type => {
  window.addEventListener(type, event => {
    handleVideoEditorSpace(event, type === 'keydown');
  }, true);
});

document.addEventListener('keydown', e => {
  const target = e.target;
  const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  const player = document.getElementById('vid-player');
  if (handleVideoEditorSpace(e, true)) return;
  const isTyping = isTextTypingTarget(target);
  if (isTyping) return;
  const wrap = document.getElementById('vid-player-wrap');
  const insideEditor = !!(wrap && wrap.contains(target));
  if ((e.code === 'Delete' || e.code === 'Backspace') && selectedEditorItem && (insideEditor || videoEditorHotkeysActive)) {
    e.preventDefault();
    e.stopPropagation();
    deleteSelectedEditorItem();
    return;
  }
  if (isSpace) {
    if (player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
      toggleEditorPlayback();
    }
  }
  if (e.code === 'ArrowRight') {
    if (player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      player.currentTime = Math.min(player.duration, player.currentTime + 5);
    }
  }
  if (e.code === 'ArrowLeft') {
    if (player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
    }
  }
}, true);


// ── Screenshots ───────────────────────────────────────────────────────────────
document.getElementById('btn-add-shot').addEventListener('click', () => {
  if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
  document.getElementById('shot-file-input').click();
});
document.getElementById('shot-file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  files.forEach(file => {
    if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
    if (!file.type.startsWith('image/')) return;
    const localUrl = URL.createObjectURL(file);
    const entry = { localUrl, cloudUrl: null, uploading: true };
    screenshots.push(entry);
    renderScreenshots();
    compressImage(file).then(blob => uploadToCloudinary(blob)).then(url => {
      entry.cloudUrl = url; entry.uploading = false;
      renderScreenshots(); _saveDraft();
    }).catch(err => {
      toast('Ошибка загрузки фото: ' + err.message, 'e');
      const idx = screenshots.indexOf(entry);
      if (idx !== -1) {
        if (entry.localUrl?.startsWith('blob:')) URL.revokeObjectURL(entry.localUrl);
        screenshots.splice(idx, 1);
      }
      renderScreenshots();
    });
  });
});

function renderScreenshots() {
  const row = document.getElementById('shots-row');
  row.innerHTML = screenshots.map((s, i) => `
    <div class="shot-item">
      <img src="${esc(s.localUrl)}" alt="${s.uploading ? '⏳' : '✓'}" style="opacity:${s.uploading ? 0.5 : 1};">
      <button class="rm" data-idx="${i}">✕</button>
    </div>`).join('');
  if (screenshots.length < 5) {
    row.innerHTML += `<button class="btn-add-shot" id="btn-add-shot">+</button>`;
    document.getElementById('btn-add-shot').addEventListener('click', () => {
      if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
      document.getElementById('shot-file-input').click();
    });
  }
  row.querySelectorAll('.rm').forEach(b => {
    b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.idx);
      if (screenshots[idx].localUrl?.startsWith('blob:')) URL.revokeObjectURL(screenshots[idx].localUrl);
      screenshots.splice(idx, 1);
      renderScreenshots(); _saveDraft();
    });
  });
}

// ── Map minimap ───────────────────────────────────────────────────────────────
const MAP_FALLBACK_URLS = {
  'Haven':    'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/displayicon.png',
  'Bind':     'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/displayicon.png',
  'Ascent':   'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/displayicon.png',
  'Split':    'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/displayicon.png',
  'Icebox':   'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/displayicon.png',
  'Breeze':   'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/displayicon.png',
  'Fracture': 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/displayicon.png',
  'Pearl':    'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/displayicon.png',
  'Lotus':    'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/displayicon.png',
  'Sunset':   'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39eb02e28435/displayicon.png',
  'Abyss':    'https://media.valorant-api.com/maps/224b0a95-48b9-d703-cc5f-3e8e0f488ea8/displayicon.png',
  'Corrode':  'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/displayicon.png',
  'Summit':   'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/displayicon.png',
};

function loadMapMinimap() {
  const mapName = document.getElementById('sel-map').value;
  const img     = document.getElementById('map-img');
  const ph      = document.getElementById('map-placeholder');
  const marker  = document.getElementById('map-marker');
  img.onload = null;
  img.onerror = null;
  if (!mapName) {
    img.style.display = 'none'; ph.style.display = '';
    marker.style.display = 'none';
    markerX = markerY = null; trajectoryPoints = [];
    renderTrajectory();
    return;
  }
  const apiUrl = mapsData.find(m => m.displayName === mapName)?.displayIcon;
  const fallbackUrl = MAP_FALLBACK_URLS[mapName];
  const candidates = [...new Set([
    proxiedValorantUrl(apiUrl),
    proxiedValorantUrl(fallbackUrl),
    fallbackUrl,
  ].filter(Boolean))];
  if (candidates.length) {
    let attempt = 0;
    const fail = () => {
      attempt += 1;
      if (attempt < candidates.length) {
        img.src = candidates[attempt];
        return;
      }
      img.style.display = 'none';
      ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Карта недоступна. Обнови страницу или выбери карту ещё раз.</div>`;
      ph.style.display = '';
    };
    img.crossOrigin = 'anonymous';
    img.onerror = fail;
    img.onload = () => {
      img.style.display = 'block';
      ph.style.display = 'none';
      if (markerX != null && markerY != null) setMarkerPosition(markerX, markerY);
      renderTrajectory();
    };
    img.style.display = 'none';
    ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Загружаем карту…</div>`;
    ph.style.display = '';
    img.src = candidates[0];
    marker.style.display = 'none';
    markerX = markerY = null; trajectoryPoints = [];
    renderTrajectory();
  } else {
    img.style.display = 'none';
    ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Миникарта не найдена</div>`;
    ph.style.display = '';
  }
  validateForm();
}

// Map mode switcher — exposed to window for inline onclick
function setMapMode(mode) {
  mapMode = mode;
  document.getElementById('mode-position').classList.toggle('selected-mode',   mode === 'position');
  document.getElementById('mode-trajectory').classList.toggle('selected-mode', mode === 'trajectory');
  document.getElementById('traj-undo').style.display  = mode === 'trajectory' ? '' : 'none';
  document.getElementById('traj-clear').style.display = mode === 'trajectory' ? '' : 'none';
}
window.setMapMode = setMapMode;
window.undoTraj  = function() { trajectoryPoints.pop(); renderTrajectory(); _saveDraft(); };
window.clearTraj = function() { trajectoryPoints = []; renderTrajectory(); _saveDraft(); };

function mapContentRect() {
  const wrap = document.getElementById('map-wrap');
  const img = document.getElementById('map-img');
  const ww = wrap.clientWidth || 1;
  const wh = wrap.clientHeight || 1;
  const iw = img.naturalWidth || ww;
  const ih = img.naturalHeight || wh;
  const scale = Math.min(ww / iw, wh / ih);
  const width = iw * scale;
  const height = ih * scale;
  return {
    left: (ww - width) / 2,
    top: (wh - height) / 2,
    width,
    height,
    wrapWidth: ww,
    wrapHeight: wh,
  };
}

function eventToMapPoint(e) {
  const wrap = document.getElementById('map-wrap');
  const rect = wrap.getBoundingClientRect();
  const content = mapContentRect();
  const px = e.clientX - rect.left - content.left;
  const py = e.clientY - rect.top - content.top;
  return {
    x: Math.max(0, Math.min(1, px / content.width)),
    y: Math.max(0, Math.min(1, py / content.height)),
  };
}

function setMarkerPosition(x, y) {
  const marker = document.getElementById('map-marker');
  const content = mapContentRect();
  const left = content.left + x * content.width;
  const top = content.top + y * content.height;
  marker.style.display = '';
  marker.style.left = (left / content.wrapWidth * 100) + '%';
  marker.style.top = (top / content.wrapHeight * 100) + '%';
}

function trajectoryFromMarker(points = trajectoryPoints) {
  const clean = (Array.isArray(points) ? points : [])
    .map(p => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (markerX === null || markerY === null || !clean.length) return clean;
  const path = clean.map(p => ({ ...p }));
  path[0] = { x: markerX, y: markerY };
  return path;
}

document.getElementById('map-wrap').addEventListener('click', e => {
  const img = document.getElementById('map-img');
  if (img.style.display === 'none') return;
  const { x, y } = eventToMapPoint(e);

  if (mapMode === 'position') {
    markerX = x; markerY = y;
    if (trajectoryPoints.length) trajectoryPoints[0] = { x, y };
    setMarkerPosition(x, y);
    updateMarkerIcon();
    renderTrajectory();
  } else {
    if (markerX !== null && trajectoryPoints.length === 0) {
      trajectoryPoints.push({ x: markerX, y: markerY });
    }
    trajectoryPoints.push({ x, y });
    renderTrajectory();
  }
  validateForm(); _saveDraft();
});

function renderTrajectory() {
  const container = document.getElementById('traj-container');
  container.innerHTML = '';
  if (trajectoryPoints.length < 2) return;
  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  const content = mapContentRect();
  const path = trajectoryFromMarker();
  const mid = 'ul-arr';
  const defs = document.createElementNS(ns, 'defs');
  const mkr  = document.createElementNS(ns, 'marker');
  mkr.setAttribute('id', mid);
  mkr.setAttribute('markerWidth', '10'); mkr.setAttribute('markerHeight', '8');
  mkr.setAttribute('refX', '10');       mkr.setAttribute('refY', '4');
  mkr.setAttribute('orient', 'auto');   mkr.setAttribute('markerUnits', 'userSpaceOnUse');
  const tri = document.createElementNS(ns, 'polygon');
  tri.setAttribute('points', '0 0, 10 4, 0 8'); tri.setAttribute('fill', '#FF4655');
  mkr.appendChild(tri); defs.appendChild(mkr); svg.appendChild(defs);
  const coords = path.map(p => `${(content.left + p.x*content.width).toFixed(1)},${(content.top + p.y*content.height).toFixed(1)}`).join(' ');
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', coords);
  poly.setAttribute('fill', 'none');   poly.setAttribute('stroke', '#FF4655');
  poly.setAttribute('stroke-opacity', '0.85'); poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linejoin', 'round'); poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('marker-end', `url(#${mid})`);
  svg.appendChild(poly);
  for (let i = 0; i < path.length; i++) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', (content.left + path[i].x*content.width).toFixed(1));
    dot.setAttribute('cy', (content.top + path[i].y*content.height).toFixed(1));
    dot.setAttribute('r', i === 0 ? '5' : '3.5');
    dot.setAttribute('fill', '#FF4655');
    dot.setAttribute('stroke', 'rgba(255,255,255,0.45)'); dot.setAttribute('stroke-width', '0.5');
    svg.appendChild(dot);
  }
  container.appendChild(svg);
}

function updateMarkerIcon() {
  const img = document.getElementById('marker-icon');
  if (!img) return;
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) { img.style.display = 'none'; return; }
  const ability = (agent.abilities || []).find(ab =>
    ab.displayName === selectedAbility ||
    ab.slot === selectedAbility ||
    normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === selectedAbility
  );
  if (ability?.displayIcon) {
    img.src = ability.displayIcon;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }
}

// ── Draft persistence ─────────────────────────────────────────────────────────
const _DRAFT_KEY = 'vl_lineup_draft';
const _DRAFTS_KEY = 'vl_lineup_drafts';
const _ACTIVE_DRAFT_ID_KEY = 'vl_active_lineup_draft_id';
const _DRAFT_MIGRATED_KEY = 'vl_lineup_draft_migrated_v2';

function collectDraftData() {
  return {
    map:        document.getElementById('sel-map')?.value || '',
    agent:      selectedAgent,
    ability:    selectedAbility,
    category:   selectedCategory,
    difficulty: selectedDifficulty,
    title:      document.getElementById('inp-title')?.value || '',
    desc:       document.getElementById('inp-desc')?.value || '',
    markerX, markerY, mapMode,
    trajectory: trajectoryPoints,
    videoUrl,
    videoEdit: videoUrl ? normalizedVideoEdit() : createDefaultVideoEdit(),
    screenshots: screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl),
    resubmissionSourceId,
  };
}

function hasDraftContent(draft) {
  return !!(
    draft &&
    (draft.title || draft.desc || draft.map || draft.agent || draft.ability ||
      draft.videoUrl || draft.markerX != null || draft.trajectory?.length ||
      draft.screenshots?.length || draft.videoEdit?.splits?.length ||
      draft.videoEdit?.freezeFrames?.length || draft.videoEdit?.zoomKeyframes?.length ||
      draft.resubmissionSourceId)
  );
}

function getSavedDrafts() {
  let drafts = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(_DRAFTS_KEY) || '[]');
    if (Array.isArray(parsed)) drafts = parsed;
  } catch (_) {}
  try {
    if (!localStorage.getItem(_DRAFT_MIGRATED_KEY)) {
      const legacy = JSON.parse(localStorage.getItem(_DRAFT_KEY) || 'null');
      if (hasDraftContent(legacy)) {
        const now = Date.now();
        drafts = [{
          ...legacy,
          id: `draft_${now}_legacy`,
          createdAt: now,
          updatedAt: now,
        }, ...drafts];
        localStorage.setItem(_DRAFTS_KEY, JSON.stringify(drafts));
      }
      localStorage.setItem(_DRAFT_MIGRATED_KEY, '1');
    }
  } catch (_) {}
  return drafts.filter(hasDraftContent).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function writeSavedDrafts(drafts) {
  try {
    localStorage.setItem(_DRAFTS_KEY, JSON.stringify(drafts.filter(hasDraftContent).slice(0, 30)));
  } catch (_) {
    toast('Не удалось сохранить черновик: память браузера заполнена', 'e');
  }
}

function saveCurrentDraftSnapshot() {
  const draft = collectDraftData();
  if (!hasDraftContent(draft)) {
    toast('Черновик пустой', 'w');
    return;
  }
  const now = Date.now();
  const id = `draft_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const saved = { ...draft, id, createdAt: now, updatedAt: now };
  writeSavedDrafts([saved, ...getSavedDrafts()]);
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(saved));
  } catch (_) {}
  renderDrafts();
  renderAuthorWorkspace();
  toast('Черновик сохранён', 's');
}

function deleteSavedDraft(id) {
  if (!id) return;
  writeSavedDrafts(getSavedDrafts().filter(draft => draft.id !== id));
  try {
    if (localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) === id) {
      localStorage.removeItem(_ACTIVE_DRAFT_ID_KEY);
      localStorage.removeItem(_DRAFT_KEY);
    }
  } catch (_) {}
}

function deleteActiveSavedDraft() {
  let activeId = '';
  try { activeId = localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) || ''; } catch (_) {}
  if (activeId) deleteSavedDraft(activeId);
}

function resumeSavedDraft(id) {
  const draft = getSavedDrafts().find(item => item.id === id);
  if (!draft) {
    toast('Черновик не найден', 'e');
    return;
  }
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(draft));
  } catch (_) {}
  resetUploadForm({ keepDraft: true });
  _restoreDraft(draft);
  toast('Черновик открыт', 's');
}

function updateActiveSavedDraft(draft) {
  let activeId = '';
  try { activeId = localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) || ''; } catch (_) {}
  if (!activeId) return;
  const drafts = getSavedDrafts();
  const idx = drafts.findIndex(item => item.id === activeId);
  if (idx === -1) return;
  drafts[idx] = { ...drafts[idx], ...draft, id: activeId, updatedAt: Date.now() };
  writeSavedDrafts(drafts);
}

function _saveDraft() {
  try {
    const draft = collectDraftData();
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(draft));
    updateActiveSavedDraft(draft);
  } catch(_) {}
}

function _clearDraft() {
  try { localStorage.removeItem(_DRAFT_KEY); } catch(_) {}
  try { localStorage.removeItem(_ACTIVE_DRAFT_ID_KEY); } catch(_) {}
  resubmissionSourceId = '';
  renderResubmissionBanner();
}

function _restoreDraft(sourceDraft = null) {
  let d = sourceDraft;
  try { if (!d) d = JSON.parse(localStorage.getItem(_DRAFT_KEY)); } catch(_) {}
  if (!d) return;
  resubmissionSourceId = d.resubmissionSourceId || '';
  renderResubmissionBanner();

  // Text fields
  if (d.title) { const el = document.getElementById('inp-title'); if (el) { el.value = d.title; document.getElementById('title-count').textContent = d.title.length; } }
  if (d.desc)  { const el = document.getElementById('inp-desc');  if (el) { el.value = d.desc;  document.getElementById('desc-count').textContent  = d.desc.length;  } }

  // Category & difficulty
  if (d.category) {
    const restoredCategory = normalizeContentCategory(d.category);
    const btn = document.querySelector(`#cat-row .pill-btn[data-val="${restoredCategory}"]`);
    if (btn && !btn.disabled && !btn.classList.contains('locked')) {
      document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedCategory = restoredCategory;
    }
  }
  if (d.difficulty) {
    const btn = document.querySelector(`#diff-row .pill-btn[data-val="${d.difficulty}"]`);
    if (btn) { document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); selectedDifficulty = d.difficulty; }
  }

  // Map + marker (load minimap, then place marker after image loads)
  if (d.map) {
    const sel = document.getElementById('sel-map');
    if (sel) sel.value = d.map;
    const img = document.getElementById('map-img');
    const ph  = document.getElementById('map-placeholder');
    const apiUrl = mapsData.find(m => m.displayName === d.map)?.displayIcon;
    const url    = apiUrl || MAP_FALLBACK_URLS[d.map];
    if (url && img) {
      img.crossOrigin = 'anonymous'; img.src = url; img.style.display = 'block';
      if (ph) ph.style.display = 'none';
      const afterLoad = () => {
        if (d.mapMode) setMapMode(d.mapMode);
        if (d.trajectory?.length) { trajectoryPoints = d.trajectory; renderTrajectory(); }
        if (d.markerX != null) {
          markerX = d.markerX; markerY = d.markerY;
          setMarkerPosition(d.markerX, d.markerY);
          updateMarkerIcon();
        }
        validateForm();
      };
      if (img.complete && img.naturalWidth) afterLoad();
      else img.addEventListener('load', afterLoad, { once: true });
    }
  }

  // Agent
  if (d.agent && agentsList.length) {
    const agent = agentsList.find(a => a.displayName === d.agent);
    if (agent) {
      const card = document.querySelector(`.agent-card[data-uuid="${agent.uuid}"]`);
      if (card) card.classList.add('selected');
      selectAgent(agent);
      if (d.ability) {
        const ability = (agent.abilities || []).find(ab =>
          ab.displayName === d.ability ||
          ab.slot === d.ability ||
          normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === d.ability
        );
        selectedAbility = normalizeAbilityName(agent.displayName, ability?.displayName || d.ability, ability?.slot || d.ability);
        const abilBtn = [...document.querySelectorAll('.ability-btn')].find(btn =>
          btn.dataset.key === selectedAbility || btn.dataset.slot === d.ability
        );
        if (abilBtn) { document.querySelectorAll('.ability-btn').forEach(b => b.classList.remove('selected')); abilBtn.classList.add('selected'); updateMarkerIcon(); }
      }
    }
  }

  // Video
  if (d.videoUrl) {
    videoUrl = d.videoUrl;
    videoEdit = { ...createDefaultVideoEdit(), ...(d.videoEdit || {}) };
    const dropZ = document.getElementById('drop-zone');
    const wrap  = document.getElementById('vid-player-wrap');
    const vid   = document.getElementById('vid-player');
    if (dropZ) dropZ.style.display = 'none';
    if (wrap)  wrap.style.display = '';
    if (vid)   { vid.crossOrigin = 'anonymous'; vid.src = d.videoUrl; }
    renderVideoEditor();
  } else {
    videoEdit = createDefaultVideoEdit();
  }

  // Screenshots (already uploaded — use cloud URL for display)
  if (d.screenshots?.length) {
    screenshots = d.screenshots.map(url => ({ localUrl: url, cloudUrl: url, uploading: false }));
    renderScreenshots();
  }

  validateForm();
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateForm() {
  const ok =
    document.getElementById('sel-map').value &&
    selectedAgent &&
    selectedAbility &&
    selectedCategory &&
    canSubmitContentCategory(selectedCategory) &&
    selectedDifficulty &&
    document.getElementById('inp-title').value.trim().length > 0 &&
    markerX !== null;
  document.getElementById('btn-submit').disabled = !ok;
}

function selectedAbilityAliases() {
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) return [selectedAbility];
  const ability = (agent.abilities || []).find(ab =>
    ab.displayName === selectedAbility ||
    ab.slot === selectedAbility ||
    normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === selectedAbility
  );
  return [
    ability?.displayName,
    ability?.slot,
    selectedAbility,
    ability ? normalizeAbilityName(agent.displayName, ability.displayName, ability.slot) : null,
  ];
}

// ── Submit ────────────────────────────────────────────────────────────────────
document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!currentUser) { toast('Войди в аккаунт', 'e'); return; }
  await loadCurrentUserProfile(currentUser);
  updateUploadGate();
  if (!canCurrentUserUpload()) {
    updateUploadGate();
    toast(uploadGateMessage(), 'w');
    return;
  }

  const title = document.getElementById('inp-title').value.trim();
  const desc  = document.getElementById('inp-desc').value.trim();
  const map   = document.getElementById('sel-map').value;

  if (!map || !selectedAgent || !selectedAbility || !selectedCategory || !selectedDifficulty) {
    toast('Заполни все обязательные поля', 'e'); return;
  }
  if (!canSubmitContentCategory(selectedCategory)) {
    toast('Эта категория пока закрыта для отправки.', 'e'); return;
  }
  if (!title) { toast('Введи название', 'e'); return; }
  if (title.length > 100) { toast('Название слишком длинное', 'e'); return; }
  if (desc.length > 1000) { toast('Описание слишком длинное', 'e'); return; }
  if (markerX === null) { toast('Поставь метку на карте', 'e'); return; }

  const uid = currentUser.uid;
  let rateLimitDiagnostics = { read: false };
  try {
    const rateDoc = await getDoc(doc(db, 'rate_limits', uid));
    rateLimitDiagnostics = {
      read: true,
      exists: rateDoc.exists(),
      last_lineup_at: diagnosticTimestamp(rateDoc.data()?.last_lineup_at),
      last_lineup_id: rateDoc.data()?.last_lineup_id || '',
      cooldown_minutes: cooldownMinutesFor(_approvedLineups),
      approved_for_cooldown: _approvedLineups,
    };
    if (rateDoc.exists()) {
      const lastAt = rateDoc.data()?.last_lineup_at?.toDate?.();
      if (lastAt) {
        const diffMin = (Date.now() - lastAt.getTime()) / 60000;
        const cooldownMin = cooldownMinutesFor(_approvedLineups);
        rateLimitDiagnostics.minutes_since_last_lineup = Math.floor(diffMin * 10) / 10;
        rateLimitDiagnostics.remaining_minutes = Math.max(0, Math.ceil(cooldownMin - diffMin));
        if (diffMin < cooldownMin) {
          toast(`Подожди ещё ${Math.ceil(cooldownMin - diffMin)} мин.`, 'w');
          return;
        }
      }
    }
  } catch (rateError) {
    rateLimitDiagnostics = {
      read: false,
      error_code: String(rateError?.code || ''),
      error_message: String(rateError?.message || rateError || '').slice(0, 500),
    };
  }

  if (screenshots.some(s => s.uploading)) {
    toast('Подожди — фото ещё загружаются…', 'i'); return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Отправка…';

  let normalizedAbility = '';
  let contentType = '';
  let rangeRadius = null;
  let lineupId = '';
  let submitStage = 'prepare';
  let submittedPayloadDiagnostics = {};
  try {
    submitStage = 'normalize_ability';
    normalizedAbility = normalizeAbilityName(selectedAgent, selectedAbility);
    if (!normalizedAbility) {
      toast('Выбери способность агента', 'e');
      btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
      return;
    }
    submitStage = 'load_range_radius';
    rangeRadius = await getConfiguredRangeRadius(map, selectedAgent, normalizedAbility, selectedAbilityAliases());
    const submittedBy = authorDisplayName();
    contentType = normalizeContentCategory(selectedCategory);
    if (!canSubmitContentCategory(contentType)) {
      toast('Эта категория пока закрыта для отправки.', 'e');
      btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
      return;
    }
    const lineupRef = doc(collection(db, 'lineups'));
    lineupId = lineupRef.id;
    submittedPayloadDiagnostics = {
      lineup_id: lineupId,
      map,
      agent: selectedAgent,
      selected_ability: selectedAbility,
      normalized_ability: normalizedAbility,
      ability_aliases: selectedAbilityAliases(),
      category: selectedCategory,
      content_type: contentType,
      difficulty: selectedDifficulty,
      range_radius: rangeRadius,
      user_id: uid,
      submitted_by: submittedBy,
      submitted_at: 'serverTimestamp()',
      rate_limit_last_lineup_at: 'serverTimestamp()',
      resubmitted_from: resubmissionSourceId || '',
      source: 'web',
      schema_version: 1,
      has_video_edit: !!videoUrl,
      ...submitFormDiagnostics({ title, desc, map, ability: normalizedAbility, contentType }),
    };
    submitStage = 'lineup_create_batch';
    const batch = writeBatch(db);
    batch.set(lineupRef, {
      map,
      agent:         selectedAgent,
      ability:       normalizedAbility,
      title,
      description:   desc,
      video_url:     videoUrl || null,
      video_edit:    videoUrl ? normalizedVideoEdit() : null,
      screenshots:   screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl),
      position_x: markerX,
      position_y: markerY,
      trajectory: trajectoryFromMarker(),
      range_radius:  rangeRadius,
      category:      contentType,
      content_type:  contentType,
      schema_version: 1,
      difficulty:    selectedDifficulty,
      status:        'pending',
      submitted_at:  serverTimestamp(),
      user_id:       uid,
      submitted_by:  submittedBy,
      patch_version: null,
      reputation_up: 0, reputation_down: 0,
      is_outdated:   false,
      likes_count:   0,
      source:        'web',
      ...(resubmissionSourceId ? { resubmitted_from: resubmissionSourceId } : {}),
    });
    batch.set(doc(db, 'rate_limits', uid), {
      last_lineup_at: serverTimestamp(),
      last_lineup_id: lineupRef.id,
    }, { merge: true });
    await batch.commit();

    showSuccess();
  } catch (e) {
    await logUploadError(e, {
      action: 'submit_lineup',
      stage: submitStage,
      map,
      agent: selectedAgent,
      ability: selectedAbility,
      normalized_ability: normalizedAbility,
      category: selectedCategory,
      content_type: contentType,
      lineup_id: lineupId,
      user: userDiagnostics(),
      rate_limit: rateLimitDiagnostics,
      payload: submittedPayloadDiagnostics,
      rules_expectation: {
        isValidLineupData_expected: !!submittedPayloadDiagnostics.client_ok,
        userCanCreateLineup_expected: !!userDiagnostics().can_upload,
        lineupNotOnCooldown_expected: !rateLimitDiagnostics.remaining_minutes,
      },
    });
    toast('Ошибка отправки: ' + toSafeErrorMessage(e), 'e');
    btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
  }
});

function showSuccess() {
  deleteActiveSavedDraft();
  _clearDraft();
  document.getElementById('success-screen').style.display = 'flex';
  if (currentUser) _updateCooldown(currentUser.uid);
}

function resetUploadForm({ keepDraft = false } = {}) {
  if (!keepDraft) _clearDraft();
  selectedAgent = null; selectedAbility = null;
  selectedCategory = null; selectedDifficulty = null;
  markerX = null; markerY = null;
  trajectoryPoints = [];
  mapMode = 'position';
  videoUrl = null; videoEdit = createDefaultVideoEdit(); screenshots = [];

  document.getElementById('sel-map').value = '';
  document.querySelectorAll('.agent-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('abilities-row').innerHTML = '<span style="color:var(--text2);font-size:13px;">Сначала выбери агента</span>';
  document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('inp-title').value = '';
  document.getElementById('inp-desc').value = '';
  document.getElementById('title-count').textContent = '0';
  document.getElementById('desc-count').textContent = '0';
  document.getElementById('drop-zone').style.display = '';
  document.getElementById('vid-player-wrap').style.display = 'none';
  document.getElementById('vid-upload-progress').style.display = 'none';
  document.getElementById('map-img').style.display = 'none';
  document.getElementById('map-placeholder').style.display = '';
  document.getElementById('map-marker').style.display = 'none';
  document.getElementById('traj-container').innerHTML = '';
  document.getElementById('map-hint').textContent = 'Выбери режим и кликни на карту';
  setMapMode('position');
  renderScreenshots();
  document.getElementById('success-screen').style.display = 'none';
  document.getElementById('btn-submit').disabled = true;
  document.getElementById('btn-submit').textContent = '⬆ Отправить лайнап';
  window.scrollTo(0, 0);
}

window.addEventListener('beforeunload', () => {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
  _clearCooldownTimer();
});

document.getElementById('btn-another').addEventListener('click', () => resetUploadForm());

// ── Moderator application ─────────────────────────────────────────────────────
// Firestore: moderator_applications/{uid} { username, reason, status, created_at }
// Заявки проверяются в admin_panel.html (вкладка "Заявки").
const modScreen = document.getElementById('mod-screen');

document.getElementById('btn-become-mod').addEventListener('click', openModApplication);
document.getElementById('mod-close').addEventListener('click', () => { modScreen.style.display = 'none'; });
modScreen.addEventListener('click', e => { if (e.target === modScreen) modScreen.style.display = 'none'; });

async function openModApplication() {
  if (!currentUser) { toast('Войди в аккаунт', 'e'); return; }
  modScreen.style.display = 'flex';
  const body = document.getElementById('mod-body');
  body.innerHTML = '<div style="color:var(--text2);padding:20px 0;text-align:center;">Загрузка…</div>';

  // Уже модератор?
  let role = 'user';
  try {
    const uDoc = await getDoc(doc(db, 'users', currentUser.uid));
    role = uDoc.data()?.role || 'user';
  } catch (_) {}
  if (role === 'moderator' || role === 'admin') {
    body.innerHTML = `<div style="padding:14px 0;color:var(--green);font-size:14px;">✅ У тебя уже есть роль <b>${esc(role)}</b>.</div>`;
    return;
  }

  // Существующая заявка?
  let app = null;
  try {
    const aDoc = await getDoc(doc(db, 'moderator_applications', currentUser.uid));
    if (aDoc.exists()) app = aDoc.data();
  } catch (_) {}

  if (app && app.status === 'pending') {
    body.innerHTML = `<div style="padding:14px 0;">
      <div style="color:var(--primary);font-size:15px;font-weight:700;margin-bottom:8px;">⏳ Заявка на рассмотрении</div>
      <div style="color:var(--text2);font-size:13px;">Ожидай решения администратора. Мы пришлём уведомление.</div>
    </div>`;
    return;
  }

  const rejected = app && app.status === 'rejected';
  body.innerHTML = `
    ${rejected ? '<div style="color:var(--red);font-size:13px;margin-bottom:10px;">Прошлая заявка отклонена. Можешь подать повторно.</div>' : ''}
    <div style="color:var(--text2);font-size:13px;margin-bottom:12px;">Расскажи, почему хочешь стать модератором и чем поможешь сообществу.</div>
    <textarea id="mod-reason" rows="5" maxlength="500" placeholder="Минимум 50 символов…"
      style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r);padding:11px 13px;font-size:14px;resize:vertical;box-sizing:border-box;"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
      <span id="mod-count" style="font-size:11px;color:var(--text2);">0 / мин. 50</span>
    </div>
    <button class="btn-primary" id="mod-submit" style="margin-top:14px;" disabled>Отправить заявку</button>`;

  const ta = document.getElementById('mod-reason');
  const cnt = document.getElementById('mod-count');
  const sub = document.getElementById('mod-submit');
  ta.addEventListener('input', () => {
    const len = ta.value.trim().length;
    cnt.textContent = `${len} / мин. 50`;
    cnt.style.color = len >= 50 ? 'var(--green)' : 'var(--text2)';
    sub.disabled = len < 50;
  });
  sub.addEventListener('click', submitModApplication);
}

async function submitModApplication() {
  const reason = document.getElementById('mod-reason').value.trim();
  if (reason.length < 50) { toast('Минимум 50 символов', 'e'); return; }
  const sub = document.getElementById('mod-submit');
  sub.disabled = true; sub.textContent = 'Отправка…';
  try {
    const username = currentUser.displayName || currentUser.email || 'Аноним';
    await setDoc(doc(db, 'moderator_applications', currentUser.uid), {
      username, reason, status: 'pending',
      user_email: currentUser.email || '',
      created_at: serverTimestamp(),
    });
    document.getElementById('mod-body').innerHTML =
      `<div style="padding:18px 0;text-align:center;">
        <div style="font-size:34px;">✅</div>
        <div style="color:var(--green);font-size:16px;font-weight:700;margin-top:8px;">Заявка отправлена!</div>
        <div style="color:var(--text2);font-size:13px;margin-top:6px;">Ожидай решения администратора.</div>
      </div>`;
    toast('Заявка на модератора отправлена', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
    sub.disabled = false; sub.textContent = 'Отправить заявку';
  }
}
