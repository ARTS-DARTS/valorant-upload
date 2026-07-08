import { initializeApp }                    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth,
         signInWithEmailAndPassword, signInWithCustomToken,
         signOut, onAuthStateChanged }
                                             from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc,
          writeBatch, serverTimestamp, onSnapshot,
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
const SITE_VERSION = '2026-07-08T20:44:59+03:00';
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
    location.reload();
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
let screenshots = [];
let currentUserLineups = [];
let activeWorkspaceTab = 'upload';
let myLineupsStatusFilter = 'all';
let myLineupsSearch = '';

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
  document.getElementById('btn-refresh-workspace')?.addEventListener('click', async () => {
    if (currentUser) {
      await loadCurrentUserProfile(currentUser);
      updateUploadGate();
      renderAuthorWorkspace();
      toast('Кабинет обновлён', 's');
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
        <span class="status-chip ${esc(status)}">${esc(statusLabel(status))}</span>
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
    </div>
    ${rejection ? `<div class="detail-section"><div class="detail-section-title">Причина отклонения</div><div class="detail-warning">${esc(rejection)}</div></div>` : ''}
    <div class="detail-section">
      <div class="detail-section-title">Описание</div>
      <div class="detail-text">${esc(description)}</div>
    </div>
    ${item.video_url ? `<div class="detail-section"><div class="detail-section-title">Видео</div><video class="detail-video" controls preload="metadata" src="${esc(item.video_url)}"></video></div>` : ''}
    ${shots.length ? `<div class="detail-section"><div class="detail-section-title">Скриншоты</div><div class="detail-shots">${shots.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt=""></a>`).join('')}</div></div>` : ''}
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

function closeLineupDetail() {
  const screen = document.getElementById('lineup-detail-screen');
  if (!screen) return;
  screen.style.display = 'none';
  const video = screen.querySelector('video');
  if (video) video.pause();
}

function renderDrafts() {
  const target = document.getElementById('drafts-list');
  if (!target) return;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem('vl_lineup_draft')); } catch (_) {}
  if (!draft || (!draft.title && !draft.map && !draft.agent && !draft.videoUrl && !draft.screenshots?.length)) {
    target.innerHTML = '<div class="empty-state"><strong>Черновиков нет</strong>Начни заполнять форму, и сайт сохранит незавершённый лайнап на этом устройстве.</div>';
    return;
  }
  const meta = [draft.map, draft.agent, draft.ability, difficultyLabel(draft.difficulty), categoryLabel(draft.category)].filter(Boolean);
  target.innerHTML = `
    <article class="lineup-card">
      <div>
        <div class="lineup-title">${esc(firstText(draft.title, 'Черновик лайнапа'))}</div>
        <div class="lineup-meta">
          ${meta.map(value => `<span class="lineup-chip">${esc(value)}</span>`).join('')}
          <span class="lineup-chip">На этом устройстве</span>
        </div>
      </div>
      <span class="status-chip pending">Черновик</span>
    </article>`;
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

dropZone.addEventListener('click', () => vidInput.click());
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleVideoFile(file);
});
vidInput.addEventListener('change', () => { if (vidInput.files[0]) handleVideoFile(vidInput.files[0]); });

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
    toast('Видео загружено ✅', 's');
    validateForm(); _saveDraft();
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
  vidScrubber.value = (vidPlayer.currentTime / vidPlayer.duration) * 100;
  vidTimeEl.textContent = fmtTime(vidPlayer.currentTime) + ' / ' + fmtTime(vidPlayer.duration);
});
vidPlayer.addEventListener('play',  () => { vidPlayBtn.textContent = '⏸'; });
vidPlayer.addEventListener('pause', () => { vidPlayBtn.textContent = '▶'; });
vidScrubber.addEventListener('input', () => {
  vidPlayer.currentTime = (vidScrubber.value / 100) * vidPlayer.duration;
});
vidPlayBtn.addEventListener('click', () => vidPlayer.paused ? vidPlayer.play() : vidPlayer.pause());
document.getElementById('vid-remove-btn').addEventListener('click', () => {
  vidPlayer.src = '';
  videoUrl = null;
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
document.addEventListener('keydown', e => {
  const target = e.target;
  const isTyping = target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
  if (isTyping) return;
  if (e.code === 'Space' || e.key === ' ') {
    const player = document.getElementById('vid-player');
    if (player && player.src && !player.error) {
      e.preventDefault();
      if (player.paused) { player.play(); } else { player.pause(); }
    }
  }
  if (e.code === 'ArrowRight') {
    const player = document.getElementById('vid-player');
    if (player && player.src && !player.error) {
      e.preventDefault();
      player.currentTime = Math.min(player.duration, player.currentTime + 5);
    }
  }
  if (e.code === 'ArrowLeft') {
    const player = document.getElementById('vid-player');
    if (player && player.src && !player.error) {
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
    }
  }
});


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

function _saveDraft() {
  try {
    localStorage.setItem(_DRAFT_KEY, JSON.stringify({
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
      screenshots: screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl),
    }));
  } catch(_) {}
}

function _clearDraft() {
  try { localStorage.removeItem(_DRAFT_KEY); } catch(_) {}
}

function _restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(_DRAFT_KEY)); } catch(_) {}
  if (!d) return;

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
    const dropZ = document.getElementById('drop-zone');
    const wrap  = document.getElementById('vid-player-wrap');
    const vid   = document.getElementById('vid-player');
    if (dropZ) dropZ.style.display = 'none';
    if (wrap)  wrap.style.display = '';
    if (vid)   { vid.crossOrigin = 'anonymous'; vid.src = d.videoUrl; }
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
  try {
    const rateDoc = await getDoc(doc(db, 'rate_limits', uid));
    if (rateDoc.exists()) {
      const lastAt = rateDoc.data()?.last_lineup_at?.toDate?.();
      if (lastAt) {
        const diffMin = (Date.now() - lastAt.getTime()) / 60000;
        const cooldownMin = cooldownMinutesFor(_approvedLineups);
        if (diffMin < cooldownMin) {
          toast(`Подожди ещё ${Math.ceil(cooldownMin - diffMin)} мин.`, 'w');
          return;
        }
      }
    }
  } catch (_) {}

  if (screenshots.some(s => s.uploading)) {
    toast('Подожди — фото ещё загружаются…', 'i'); return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Отправка…';

  try {
    const ability = normalizeAbilityName(selectedAgent, selectedAbility);
    if (!ability) {
      toast('Выбери способность агента', 'e');
      btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
      return;
    }
    const rangeRadius = await getConfiguredRangeRadius(map, selectedAgent, ability, selectedAbilityAliases());
    const submittedBy = authorDisplayName();
    const contentType = normalizeContentCategory(selectedCategory);
    if (!canSubmitContentCategory(contentType)) {
      toast('Эта категория пока закрыта для отправки.', 'e');
      btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
      return;
    }
    const batch = writeBatch(db);

    const lineupRef = doc(collection(db, 'lineups'));
    batch.set(doc(db, 'rate_limits', uid), {
      last_lineup_at: serverTimestamp(),
      last_lineup_id: lineupRef.id,
    }, { merge: true });
    batch.set(lineupRef, {
      map,
      agent:         selectedAgent,
      ability,
      title,
      description:   desc,
      video_url:     videoUrl || null,
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
    });

    await batch.commit();
    showSuccess();
  } catch (e) {
    await logUploadError(e, {
      action: 'submit_lineup',
      map,
      agent: selectedAgent,
      ability: selectedAbility,
      category: selectedCategory,
      lineups_viewed: Number(currentUserProfile?.lineups_viewed || 0),
    });
    toast('Ошибка отправки: ' + toSafeErrorMessage(e), 'e');
    btn.disabled = false; btn.textContent = '⬆ Отправить лайнап';
  }
});

function showSuccess() {
  _clearDraft();
  document.getElementById('success-screen').style.display = 'flex';
  if (currentUser) _updateCooldown(currentUser.uid);
}

window.addEventListener('beforeunload', () => {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
  _clearCooldownTimer();
});

document.getElementById('btn-another').addEventListener('click', () => {
  _clearDraft();
  selectedAgent = null; selectedAbility = null;
  selectedCategory = null; selectedDifficulty = null;
  markerX = null; markerY = null;
  trajectoryPoints = [];
  mapMode = 'position';
  videoUrl = null; screenshots = [];

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
});

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
