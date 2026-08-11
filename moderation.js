let context = null;
let loading = false;
let lockPollTimer = null;
let queuePollTimer = null;
let claimHeartbeatTimer = null;
let claimedLineupId = '';
let claimExpiresAt = 0;
let claimCountdownTimer = null;
let totalQueueItems = 0;
let renderedQueueSignature = '';
let active = false;
let queueLoadAbortController = null;
let lockAbortController = null;
let refreshButton = null;
let moderationList = null;
let authorFilter = null;
let selectedAuthorKey = '';
let queueAuthors = [];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function safeMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const allowedHosts = new Set([
      'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
      'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
      'firebasestorage.googleapis.com',
      'storage.googleapis.com',
      'res.cloudinary.com',
    ]);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

const MODERATION_PRIMARY_PROXY_HOSTS = new Set([
  'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
  'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
]);

function moderationProxyUrl(value) {
  const safe = safeMediaUrl(value);
  return safe ? `/api/valorant-proxy?url=${encodeURIComponent(safe)}` : '';
}

function moderationVideoSourceUrl(value) {
  const safe = safeMediaUrl(value);
  if (!safe) return '';
  try {
    return MODERATION_PRIMARY_PROXY_HOSTS.has(new URL(safe).hostname) ? moderationProxyUrl(safe) : safe;
  } catch (_) {
    return safe;
  }
}

function diagnosticMediaUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.pathname === '/api/valorant-proxy') {
      const target = new URL(url.searchParams.get('url') || '');
      return `${url.origin}${url.pathname}?host=${encodeURIComponent(target.hostname)}&path=${encodeURIComponent(target.pathname)}`;
    }
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return '';
  }
}

function sideLabel(value) {
  return value === 'attack' ? 'Атака' : value === 'defense' ? 'Защита' : value === 'any' ? 'Любая сторона' : 'Сторона не указана';
}

function sovaShotFields(item) {
  const abilities = Array.isArray(item.sova_shot_abilities) ? item.sova_shot_abilities : [];
  const existing = Array.isArray(item.sova_shots) ? item.sova_shots : [];
  return abilities.map((ability, index) => {
    const shot = existing[index] || {};
    const charge = Number.isFinite(Number(shot.charge)) ? Number(shot.charge) : 1.5;
    const bounces = Number.isInteger(Number(shot.bounces)) ? Number(shot.bounces) : 0;
    return `<fieldset data-sova-shot="${index}"><legend>🏹 ${index + 1}-я стрела · ${esc(ability)}</legend>
      <div class="moderation-sova-charge${charge >= 3 ? ' is-max' : ''}" style="--sova-charge-pct:${charge / 3 * 100}%"><input type="range" min="0" max="3" step="0.05" value="${charge}" data-metadata-charge data-shot-index="${index}"><div class="moderation-sova-ticks"><span></span><span></span></div><span class="moderation-sova-caption">ЗАРЯД · ${index + 1}-Я СТРЕЛА</span></div>
      <div class="moderation-sova-bounces" data-metadata-bounces data-shot-index="${index}" data-value="${bounces}"><span>ОТСКОКИ · ${index + 1}-Я СТРЕЛА</span><div><button type="button" data-metadata-bounce="1" aria-label="Первый отскок"><i></i></button><button type="button" data-metadata-bounce="2" aria-label="Второй отскок"><i></i></button></div><small>Не выбирай ромбы, если отскоков нет</small></div>
    </fieldset>`;
  }).join('');
}

function metadataFields(item) {
  const missing = new Set(item.missing_fields || []);
  return `<div class="moderation-metadata-form">
    ${missing.has('difficulty') ? `<fieldset><legend>💪 Сложность</legend><div class="moderation-choice-row">
      <label><input type="radio" name="difficulty-${esc(item.id)}" value="easy"> Легко</label>
      <label><input type="radio" name="difficulty-${esc(item.id)}" value="medium"> Средне</label>
      <label><input type="radio" name="difficulty-${esc(item.id)}" value="hard"> Сложно</label>
    </div></fieldset>` : ''}
    ${missing.has('round_side') ? `<fieldset><legend>⚔ Сторона раунда</legend><div class="moderation-choice-row">
      <label><input type="radio" name="round-side-${esc(item.id)}" value="attack"> Атака</label>
      <label><input type="radio" name="round-side-${esc(item.id)}" value="defense"> Защита</label>
      <label><input type="radio" name="round-side-${esc(item.id)}" value="any"> Любая</label>
    </div></fieldset>` : ''}
    ${missing.has('sova_shots') ? sovaShotFields(item) : ''}
  </div>`;
}

async function api(path = '', options = {}) {
  const token = await context.getToken();
  const response = await fetch(`/api/moderation${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function updateQueueStatus() {
  const status = document.getElementById('moderation-status');
  if (status) status.textContent = `В очереди: ${loadedItems.length} · Всего: ${totalQueueItems}`;
}

function renderAuthorFilter() {
  if (!authorFilter) return;
  const options = ['<option value="">Все авторы</option>', ...queueAuthors.map(author =>
    `<option value="${esc(author.key)}">${esc(author.name)} · ${Number(author.count) || 0}</option>`
  )].join('');
  if (authorFilter.innerHTML !== options) authorFilter.innerHTML = options;
  if (![...authorFilter.options].some(option => option.value === selectedAuthorKey)) selectedAuthorKey = '';
  authorFilter.value = selectedAuthorKey;
  authorFilter.disabled = queueAuthors.length === 0;
}

async function handleAuthorFilterChange() {
  selectedAuthorKey = authorFilter?.value || '';
  renderedQueueSignature = '';
  if (authorFilter) authorFilter.disabled = true;
  await load();
}

function removeQueueItems(ids) {
  const removed = new Set(ids || []);
  if (!removed.size) return;
  let removedCount = 0;
  loadedItems = loadedItems.filter(item => {
    if (!removed.has(item.id)) return true;
    document.querySelector(`[data-moderation-id="${CSS.escape(item.id)}"]`)?.remove();
    removedCount += 1;
    return false;
  });
  totalQueueItems = Math.max(0, totalQueueItems - removedCount);
  updateQueueStatus();
  if (!loadedItems.length) {
    const list = document.getElementById('moderation-list');
    if (list) list.innerHTML = '<div class="moderation-empty"><strong>Очередь пуста</strong><br>Новые лайнапы появятся здесь автоматически.</div>';
  }
}

function queueSignature(items) {
  return JSON.stringify(items.map(item => [
    item.id,
    item.task_kind,
    item.moderation_lock_active,
    item.moderation_lock_owned,
    item.moderation_lock_name,
    item.missing_fields,
  ]));
}

function captureMetadataFormState() {
  const state = new Map();
  document.querySelectorAll('[data-moderation-id]').forEach(card => {
    const id = card.dataset.moderationId;
    const charges = [...card.querySelectorAll('[data-metadata-charge]')];
    const bounces = [...card.querySelectorAll('[data-metadata-bounces]')];
    state.set(id, {
      difficulty: card.querySelector(`input[name="difficulty-${CSS.escape(id)}"]:checked`)?.value || '',
      roundSide: card.querySelector(`input[name="round-side-${CSS.escape(id)}"]:checked`)?.value || '',
      charges: charges.map(input => input.value),
      bounces: bounces.map(picker => picker.dataset.value ?? ''),
    });
  });
  return state;
}

function restoreMetadataFormState(state) {
  state.forEach((values, id) => {
    const card = document.querySelector(`[data-moderation-id="${CSS.escape(id)}"]`);
    if (!card) return;
    if (values.difficulty) {
      const input = card.querySelector(`input[name="difficulty-${CSS.escape(id)}"][value="${CSS.escape(values.difficulty)}"]`);
      if (input) input.checked = true;
    }
    if (values.roundSide) {
      const input = card.querySelector(`input[name="round-side-${CSS.escape(id)}"][value="${CSS.escape(values.roundSide)}"]`);
      if (input) input.checked = true;
    }
    card.querySelectorAll('[data-metadata-charge]').forEach((charge, index) => {
      const stored = values.charges?.[index];
      if (stored === undefined || stored === '') return;
      charge.value = stored;
      const value = Number(stored);
      charge.parentElement?.style.setProperty('--sova-charge-pct', `${value / 3 * 100}%`);
      charge.parentElement?.classList.toggle('is-max', value >= 3);
    });
    card.querySelectorAll('[data-metadata-bounces]').forEach((bounces, index) => {
      const stored = values.bounces?.[index];
      if (stored === undefined || stored === '') return;
      const selected = Number(stored);
      bounces.dataset.value = stored;
      bounces.classList.add('selected');
      bounces.querySelectorAll('[data-metadata-bounce]').forEach(item => {
        const value = Number(item.dataset.metadataBounce);
        item.classList.toggle('active', value === 0 ? selected === 0 : value <= selected);
      });
    });
  });
}

const moderationPreviewObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => entries.forEach(entry => {
      if (!active || !entry.isIntersecting) return;
      moderationPreviewObserver.unobserve(entry.target);
      loadVideoPreviewFrame(entry.target);
    }), { rootMargin: '180px 0px' })
  : null;

function loadVideoPreviewFrame(video) {
  if (!(video instanceof HTMLVideoElement) || video.dataset.previewFrame !== 'pending') return;
  video.dataset.previewFrame = 'loading';
  const seekPreview = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    try { video.currentTime = duration > 0 ? Math.min(0.1, duration / 2) : 0.01; } catch (_) {}
  };
  video.addEventListener('loadedmetadata', seekPreview, { once: true });
  video.addEventListener('seeked', () => { video.dataset.previewFrame = 'ready'; }, { once: true });
  video.addEventListener('play', () => {
    if (video.dataset.previewFrame === 'ready' && video.currentTime <= 0.11) video.currentTime = 0;
  }, { once: true });
  if (video.readyState >= 1) seekPreview();
  video.load();
}

function moderationMediaErrorContext(video, phase) {
  const mediaError = video.error;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    action:'moderation_video_load_failed',
    phase,
    lineup_id:video.closest('[data-moderation-id]')?.dataset.moderationId || '',
    media_error_code:Number(mediaError?.code || 0),
    media_error_message:String(mediaError?.message || ''),
    network_state:Number(video.networkState),
    ready_state:Number(video.readyState),
    current_src:diagnosticMediaUrl(video.currentSrc || video.src),
    original_src:diagnosticMediaUrl(video.dataset.originalSrc),
    proxy_retry:video.dataset.proxyRetry || '0',
    online:navigator.onLine,
    effective_type:String(connection?.effectiveType || ''),
    downlink:Number(connection?.downlink || 0),
    save_data:connection?.saveData === true,
    visibility:document.visibilityState,
  };
}

function showModerationVideoError(video, visible) {
  const errorBox = video.closest('.moderation-video-wrap')?.querySelector('[data-moderation-video-error]');
  if (errorBox) errorBox.hidden = !visible;
}

function bindModerationVideoDiagnostics(video) {
  if (!(video instanceof HTMLVideoElement) || video.dataset.diagnosticsBound === '1') return;
  video.dataset.diagnosticsBound = '1';
  video.addEventListener('loadedmetadata', () => {
    video.dataset.proxyRetry = '0';
    showModerationVideoError(video, false);
  });
  video.addEventListener('error', () => {
    const firstFailure = video.dataset.proxyRetry !== '1';
    const phase = firstFailure ? 'primary' : 'proxy_retry';
    const details = moderationMediaErrorContext(video, phase);
    context?.reportError?.(new Error(`Moderator video failed (${details.media_error_code || 'unknown'})`), details);
    if (firstFailure) {
      const fallback = moderationProxyUrl(video.dataset.originalSrc);
      if (fallback) {
        video.dataset.proxyRetry = '1';
        showModerationVideoError(video, false);
        video.src = `${fallback}&retry=${Date.now()}`;
        video.preload = 'metadata';
        video.load();
        return;
      }
    }
    showModerationVideoError(video, true);
  });
}

function hydrateVideoPreviews() {
  if (!active) return;
  const list = document.getElementById('moderation-list');
  if (!list) return;
  list.querySelectorAll('video.moderation-video').forEach(bindModerationVideoDiagnostics);
  list.querySelectorAll('video[poster]:not([data-poster-checked])').forEach(video => {
    video.dataset.posterChecked = 'loading';
    const probe = new Image();
    probe.onload = () => { video.dataset.posterChecked = 'ready'; };
    probe.onerror = () => {
      video.removeAttribute('poster');
      video.preload = 'metadata';
      video.dataset.posterChecked = 'failed';
      video.dataset.previewFrame = 'pending';
      if (moderationPreviewObserver) moderationPreviewObserver.observe(video);
      else loadVideoPreviewFrame(video);
    };
    probe.src = video.poster;
  });
  list.querySelectorAll('video[data-preview-frame="pending"]').forEach(video => {
    if (moderationPreviewObserver) moderationPreviewObserver.observe(video);
    else loadVideoPreviewFrame(video);
  });
}

function render(items, total = totalQueueItems) {
  if (!active) return;
  // Defensive client-side deduplication in case an older/cached API response
  // contains the same Firestore document through overlapping queue queries.
  items = [...new Map(items.map(item => [item.id, item])).values()];
  // Keep the actual media elements alive across live queue redraws. Recreating
  // a <video> discards its buffered ranges and makes the CDN receive the same
  // range requests again.
  const existingVideos = new Map();
  const metadataFormState = captureMetadataFormState();
  document.querySelectorAll('[data-moderation-id] video').forEach(video => {
    const id = video.closest('[data-moderation-id]')?.dataset.moderationId;
    if (id) existingVideos.set(id, video);
  });
  loadedItems = items;
  renderedQueueSignature = queueSignature(items);
  totalQueueItems = Number.isFinite(Number(total)) ? Number(total) : items.length;
  const list = document.getElementById('moderation-list');
  const status = document.getElementById('moderation-status');
  updateQueueStatus();
  if (!items.length) {
    list.innerHTML = '<div class="moderation-empty"><strong>Очередь пуста</strong><br>Новые лайнапы появятся здесь автоматически.</div>';
    return;
  }
  list.innerHTML = items.map(item => {
    const originalVideo = safeMediaUrl(item.video_url);
    const video = moderationVideoSourceUrl(originalVideo);
    const poster = safeMediaUrl(item.video_thumbnail_url || item.screenshots?.[0]);
    const metadataTask = item.task_kind === 'metadata';
    const ownedByCurrentModerator = item.moderation_lock_owned === true;
    const meta = [item.moderator_only ? 'ЗАГОТОВКА ДЛЯ МОДЕРАЦИИ' : '', item.map, item.agent, item.agent ? item.ability : 'Выбери агента', sideLabel(item.round_side)].filter(Boolean);
    return `<article class="moderation-card" data-moderation-id="${esc(item.id)}">
      <div class="moderation-card-main">
        ${video ? `<div class="moderation-video-wrap"><video class="moderation-video" src="${esc(video)}" data-original-src="${esc(originalVideo)}"${poster ? ` poster="${esc(poster)}" preload="none"` : ' preload="metadata" data-preview-frame="pending"'} controls playsinline></video><div class="moderation-video-error" data-moderation-video-error hidden><strong>Видео заблокировано или недоступно</strong><span>Отключи блокировщик для vlineups.ru и попробуй ещё раз.</span><button type="button" data-moderation-video-retry>Повторить через прокси</button></div></div>` : '<div class="moderation-video moderation-empty">Видео не прикреплено</div>'}
        <div class="moderation-info">
          <div class="moderation-meta">${meta.map(value => `<span class="moderation-chip">${esc(value)}</span>`).join('')}</div>
          <h3 class="moderation-title">${metadataTask ? 'Проверить параметры лайнапа' : esc(item.title || 'Без названия')}</h3>
          ${metadataTask
            ? (ownedByCurrentModerator ? metadataFields(item) : '<p class="moderation-description">Сначала возьми задание в работу. После этого откроются параметры для проверки.</p>')
            : `<p class="moderation-description">${esc(item.description || 'Описание отсутствует')}</p><div class="moderation-author">Автор: ${esc(item.submitted_by || 'не указан')}</div>`}
        </div>
      </div>
      <div class="moderation-lock-status" data-moderation-lock-status></div>
      <div class="moderation-actions">
        <button class="moderation-action moderation-complete" data-moderation-action="${metadataTask ? (ownedByCurrentModerator ? 'complete-metadata' : 'claim-metadata') : 'complete'}" type="button">${metadataTask && ownedByCurrentModerator ? '✅ Подтвердить параметры' : '🔒 Взять в работу'}</button>
        ${metadataTask && ownedByCurrentModerator ? '<button class="moderation-action moderation-reject" data-moderation-action="release-metadata" type="button">✕ Отказаться</button>' : ''}
        ${metadataTask ? '' : '<button class="moderation-action moderation-reject" data-moderation-action="reject" type="button">Отклонить с причиной</button>'}
      </div>
    </article>`;
  }).join('');
  existingVideos.forEach((video, id) => {
    const replacement = document.querySelector(`[data-moderation-id="${CSS.escape(id)}"] video`);
    if (replacement && replacement.src === video.src) replacement.replaceWith(video);
  });
  hydrateVideoPreviews();
  restoreMetadataFormState(metadataFormState);
  items.forEach(item => applyLockToCard(item));
}

function applyLockToCard(item) {
  const card = document.querySelector(`[data-moderation-id="${CSS.escape(item.id)}"]`);
  if (!card) return;
  const isBeingEdited = !!item.moderation_lock_active;
  const lockedByOther = item.moderation_lock_active && !item.moderation_lock_owned;
  const status = card.querySelector('[data-moderation-lock-status]');
  if (status) {
    status.textContent = lockedByOther ? `🔒 Сейчас редактирует: ${item.moderation_lock_name || 'другой модератор'}` : '';
    status.style.display = lockedByOther ? '' : 'none';
  }
  card.classList.toggle('moderation-card-locked', !!lockedByOther);
  card.classList.toggle('moderation-card-editing', isBeingEdited && item.task_kind !== 'metadata');
  card.querySelectorAll('[data-moderation-action]').forEach(button => { button.disabled = !!lockedByOther; });
}

async function refreshLocks() {
  const ids = loadedItems.map(item => item.id);
  if (!active || !ids.length || document.hidden) return;
  lockAbortController?.abort();
  const requestController = new AbortController();
  lockAbortController = requestController;
  try {
    const body = await api(`?locks=${encodeURIComponent(ids.join(','))}`, { signal: requestController.signal });
    if (!active) return;
    removeQueueItems(body.processed);
    let ownershipChanged = false;
    loadedItems.forEach(item => {
      const lock = body.locks?.[item.id];
      const wasOwned = item.moderation_lock_owned === true;
      item.moderation_lock_active = !!lock?.active;
      item.moderation_lock_owned = !!lock?.owned;
      item.moderation_lock_name = lock?.name || '';
      ownershipChanged ||= wasOwned !== item.moderation_lock_owned;
      applyLockToCard(item);
    });
    if (ownershipChanged) render(loadedItems);
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('moderation lock refresh', error?.message || error);
  } finally {
    if (lockAbortController === requestController) lockAbortController = null;
  }
}

function renderClaimTimer() {
  const timer = document.getElementById('moderation-lease-timer');
  const value = document.getElementById('moderation-lease-time');
  if (!timer || !value) return;
  if (!claimedLineupId || !claimExpiresAt) {
    timer.hidden = true;
    timer.classList.remove('expiring');
    return;
  }
  const seconds = Math.max(0, Math.ceil((claimExpiresAt - Date.now()) / 1000));
  value.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  timer.hidden = false;
  timer.classList.toggle('expiring', seconds <= 60);
  if (seconds === 0) clearClaim();
}

function startClaimHeartbeat(lineupId, expiresAt) {
  claimedLineupId = lineupId;
  claimExpiresAt = Number(expiresAt) || (Date.now() + 10 * 60_000);
  clearInterval(claimHeartbeatTimer);
  clearInterval(claimCountdownTimer);
  claimCountdownTimer = setInterval(renderClaimTimer, 1000);
  renderClaimTimer();
}

function clearClaim() {
  claimedLineupId = '';
  claimExpiresAt = 0;
  clearInterval(claimHeartbeatTimer);
  clearInterval(claimCountdownTimer);
  claimHeartbeatTimer = null;
  claimCountdownTimer = null;
  renderClaimTimer();
}

async function load({ silent = false, allowInactive = false, renderQueue = true } = {}) {
  if ((!active && !allowInactive) || loading) return;
  loading = true;
  const status = document.getElementById('moderation-status');
  const requestController = new AbortController();
  queueLoadAbortController?.abort();
  queueLoadAbortController = requestController;
  if (!silent && active && status) status.textContent = 'Загрузка очереди…';
  try {
    if (context.getRole?.() === 'admin' && !sessionStorage.getItem('metadata-review-seeded-v2')) {
      await api('', { method: 'POST', body: JSON.stringify({ action: 'seed_metadata_queue' }), signal: requestController.signal });
      sessionStorage.setItem('metadata-review-seeded-v2', '1');
    }
    const queuePath = selectedAuthorKey ? `?author=${encodeURIComponent(selectedAuthorKey)}` : '';
    const body = await api(queuePath, { signal: requestController.signal });
    if (!active && !allowInactive) return;
    const items = Array.isArray(body.items) ? body.items : [];
    queueAuthors = Array.isArray(body.authors) ? body.authors : [];
    renderAuthorFilter();
    const nextSignature = queueSignature(items);
    if (!active || !renderQueue) {
      loadedItems = items;
      totalQueueItems = Number.isFinite(Number(body.total)) ? Number(body.total) : items.length;
    } else if (nextSignature === renderedQueueSignature) {
      loadedItems = items;
      totalQueueItems = Number.isFinite(Number(body.total)) ? Number(body.total) : items.length;
      updateQueueStatus();
    } else {
      render(items, body.total);
    }
    const owned = items.find(item => item.moderation_lock_owned && item.moderation_lock_expires_at > Date.now());
    if (owned) startClaimHeartbeat(owned.id, owned.moderation_lock_expires_at);
  } catch (error) {
    if (error?.name === 'AbortError' || (!active && !allowInactive)) return;
    if (status) status.textContent = `Не удалось загрузить очередь: ${error.message}`;
    if (active) document.getElementById('moderation-list').innerHTML = '';
  } finally {
    if (queueLoadAbortController === requestController) {
      queueLoadAbortController = null;
      loading = false;
    }
  }
}

async function act(card, action) {
  if (action === 'release-metadata') {
    const item = loadedItems.find(entry => entry.id === card.dataset.moderationId);
    if (!item) return;
    const buttons = card.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      await api('', { method: 'POST', body: JSON.stringify({ lineupId: item.id, action: 'release_claim' }) });
      if (claimedLineupId === item.id) clearClaim();
      item.moderation_lock_active = false;
      item.moderation_lock_owned = false;
      item.moderation_lock_name = '';
      render(loadedItems);
      context.toast('Задание возвращено в очередь', 's');
    } catch (error) {
      context.toast(error.message, 'e');
      buttons.forEach(button => { button.disabled = false; });
    }
    return;
  }
  if (action === 'claim-metadata') {
    const item = loadedItems.find(entry => entry.id === card.dataset.moderationId);
    if (!item) return;
    const buttons = card.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      const claim = await api('', { method: 'POST', body: JSON.stringify({ lineupId: item.id, action: 'claim' }) });
      item.moderation_lock_active = true;
      item.moderation_lock_owned = true;
      item.moderation_lock_expires_at = Number(claim.expires_at) || 0;
      startClaimHeartbeat(item.id, claim.expires_at);
      render(loadedItems);
      await load({ silent: true });
      context.toast('Задание взято в работу', 's');
    } catch (error) {
      context.toast(error.message, 'e');
      buttons.forEach(button => { button.disabled = false; });
      await refreshLocks();
    }
    return;
  }
  if (action === 'complete-metadata') {
    const item = loadedItems.find(entry => entry.id === card.dataset.moderationId);
    if (!item) return;
    const missing = new Set(item.missing_fields || []);
    const data = {};
    if (missing.has('difficulty')) data.difficulty = card.querySelector(`input[name="difficulty-${CSS.escape(item.id)}"]:checked`)?.value || '';
    if (missing.has('round_side')) data.round_side = card.querySelector(`input[name="round-side-${CSS.escape(item.id)}"]:checked`)?.value || '';
    if (missing.has('sova_shots')) data.sova_shots = [...card.querySelectorAll('[data-sova-shot]')].map(shot => ({
      charge: Number(shot.querySelector('[data-metadata-charge]')?.value),
      bounces: Number(shot.querySelector('[data-metadata-bounces]')?.dataset.value || 0),
    }));
    const buttons = card.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
    try {
      await api('', { method: 'POST', body: JSON.stringify({ lineupId: item.id, action: 'complete_metadata', data }) });
      if (claimedLineupId === item.id) clearClaim();
      removeQueueItems([item.id]);
      context.toast('Параметры лайнапа сохранены', 's');
    } catch (error) {
      context.toast(error.message, 'e');
      if (error.status === 404 || error.status === 409) removeQueueItems([item.id]);
      else buttons.forEach(button => { button.disabled = false; });
    }
    return;
  }
  if (action === 'complete') {
    const item = loadedItems.find(entry => entry.id === card.dataset.moderationId);
    if (!item || !context.openDraft) return;
    const buttons = card.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      const claim = await api('', { method: 'POST', body: JSON.stringify({ lineupId: item.id, action: 'claim' }) });
      item.moderation_lock_active = true;
      item.moderation_lock_owned = true;
      startClaimHeartbeat(item.id, claim.expires_at);
      context.openDraft(item);
      await load({ silent: true });
    } catch (error) {
      context.toast(error.message, 'e');
      await refreshLocks();
    } finally {
      if (!item.moderation_lock_active) buttons.forEach(button => { button.disabled = false; });
    }
    return;
  }
  let reason = '';
  if (action === 'reject') {
    reason = prompt('Что автор должен исправить? От 10 до 500 символов.')?.trim() || '';
    if (!reason) return;
    if (reason.length < 10) return context.toast('Напиши более понятную причину — минимум 10 символов', 'e');
  }
  const buttons = card.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    await api('', { method: 'POST', body: JSON.stringify({ lineupId: card.dataset.moderationId, action, reason }) });
    removeQueueItems([card.dataset.moderationId]);
    context.toast('Лайнап отклонён, причина отправлена автору', 's');
  } catch (error) {
    context.toast(error.message, 'e');
    if (error.status === 404 || error.status === 409) removeQueueItems([card.dataset.moderationId]);
    else buttons.forEach(button => { button.disabled = false; });
  }
}

let loadedItems = [];

function handleModerationListClick(event) {
  if (!active) return;
  const videoRetry = event.target.closest('[data-moderation-video-retry]');
  if (videoRetry) {
    const video = videoRetry.closest('.moderation-video-wrap')?.querySelector('video');
    const fallback = moderationProxyUrl(video?.dataset.originalSrc);
    if (video && fallback) {
      video.dataset.proxyRetry = '1';
      showModerationVideoError(video, false);
      video.src = `${fallback}&manual_retry=${Date.now()}`;
      video.load();
    }
    return;
  }
  const actionButton = event.target.closest('[data-moderation-action]');
  const card = actionButton?.closest('[data-moderation-id]');
  if (actionButton && card) act(card, actionButton.dataset.moderationAction);

  const bounceButton = event.target.closest('[data-metadata-bounce]');
  if (!bounceButton) return;
  const picker = bounceButton.closest('[data-metadata-bounces]');
  const requested = Number(bounceButton.dataset.metadataBounce);
  const current = picker.dataset.value === '' ? 0 : Number(picker.dataset.value);
  const next = current === requested ? requested - 1 : requested;
  picker.dataset.value = String(next);
  picker.classList.add('selected');
  picker.querySelectorAll('[data-metadata-bounce]').forEach(item => {
    const value = Number(item.dataset.metadataBounce);
    item.classList.toggle('active', value <= next);
  });
}

function handleModerationListInput(event) {
  if (!active || !event.target.matches('[data-metadata-charge]')) return;
  const wrapper = event.target.parentElement;
  const value = Number(event.target.value);
  wrapper?.style.setProperty('--sova-charge-pct', `${value / 3 * 100}%`);
  wrapper?.classList.toggle('is-max', value >= 3);
}

function startPolling() {
  clearInterval(lockPollTimer);
  clearInterval(queuePollTimer);
  if (!active) return;
  lockPollTimer = setInterval(refreshLocks, 3_000);
  queuePollTimer = setInterval(() => {
    if (active && !document.hidden) load({ silent: true });
  }, 5_000);
}

function activate() {
  if (active) return;
  active = true;
  startPolling();
  renderClaimTimer();
}

function deactivate() {
  active = false;
  clearInterval(lockPollTimer);
  clearInterval(queuePollTimer);
  lockPollTimer = null;
  queuePollTimer = null;
  queueLoadAbortController?.abort();
  lockAbortController?.abort();
  queueLoadAbortController = null;
  lockAbortController = null;
  loading = false;
  moderationPreviewObserver?.disconnect();
  const list = document.getElementById('moderation-list');
  list?.querySelectorAll('video, audio').forEach(media => {
    try { media.pause(); } catch (_) {}
    media.removeAttribute('src');
    try { media.load(); } catch (_) {}
  });
  if (list) list.innerHTML = '';
  renderedQueueSignature = '';
  const status = document.getElementById('moderation-status');
  if (status) status.textContent = 'Открой раздел, чтобы загрузить очередь.';
}

function destroy() {
  deactivate();
  clearClaim();
  refreshButton?.removeEventListener('click', load);
  moderationList?.removeEventListener('click', handleModerationListClick);
  moderationList?.removeEventListener('input', handleModerationListInput);
  authorFilter?.removeEventListener('change', handleAuthorFilterChange);
  refreshButton = null;
  moderationList = null;
  authorFilter = null;
  selectedAuthorKey = '';
  queueAuthors = [];
  loadedItems = [];
  totalQueueItems = 0;
  context = null;
}

export function initModeration(nextContext) {
  context = nextContext;
  refreshButton = document.getElementById('moderation-refresh');
  moderationList = document.getElementById('moderation-list');
  authorFilter = document.getElementById('moderation-author-filter');
  refreshButton?.addEventListener('click', load);
  moderationList?.addEventListener('click', handleModerationListClick);
  moderationList?.addEventListener('input', handleModerationListInput);
  authorFilter?.addEventListener('change', handleAuthorFilterChange);
  async function releaseClaim(lineupId) {
    if (!lineupId) return;
    await api('', { method: 'POST', body: JSON.stringify({ lineupId, action: 'release_claim' }) });
    clearClaim();
    if (active) await load();
  }
  async function resumeDraft(lineupId) {
    if (!lineupId) return false;
    let item = loadedItems.find(entry => entry.id === lineupId);
    if (!item) {
      await load({ silent: true, allowInactive: true, renderQueue: active });
      item = loadedItems.find(entry => entry.id === lineupId);
    }
    if (item?.moderation_lock_owned && item.moderation_lock_expires_at > Date.now()) {
      startClaimHeartbeat(lineupId, item.moderation_lock_expires_at);
    } else {
      const claim = await api('', { method:'POST', body:JSON.stringify({ lineupId, action:'claim' }) });
      startClaimHeartbeat(lineupId, claim.expires_at);
      await load({ silent:true, allowInactive: true, renderQueue: active });
      item = loadedItems.find(entry => entry.id === lineupId);
    }
    if (!item) return false;
    context.openDraft(item);
    return true;
  }
  return { activate, deactivate, destroy, load, clearClaim, releaseClaim, resumeDraft };
}
