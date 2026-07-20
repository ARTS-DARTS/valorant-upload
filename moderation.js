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

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function safeMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const allowedHosts = new Set([
      'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
      'firebasestorage.googleapis.com',
      'res.cloudinary.com',
    ]);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) ? url.href : '';
  } catch {
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
      if (!entry.isIntersecting) return;
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

function hydrateVideoPreviews() {
  document.querySelectorAll('video[poster]:not([data-poster-checked])').forEach(video => {
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
  document.querySelectorAll('video[data-preview-frame="pending"]').forEach(video => {
    if (moderationPreviewObserver) moderationPreviewObserver.observe(video);
    else loadVideoPreviewFrame(video);
  });
}

function render(items, total = totalQueueItems) {
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
    const video = safeMediaUrl(item.video_url);
    const poster = safeMediaUrl(item.video_thumbnail_url || item.screenshots?.[0]);
    const metadataTask = item.task_kind === 'metadata';
    const ownedByCurrentModerator = item.moderation_lock_owned === true;
    const meta = [item.moderator_only ? 'ЗАГОТОВКА ДЛЯ МОДЕРАЦИИ' : '', item.map, item.agent, item.agent ? item.ability : 'Выбери агента', sideLabel(item.round_side)].filter(Boolean);
    return `<article class="moderation-card" data-moderation-id="${esc(item.id)}">
      <div class="moderation-card-main">
        ${video ? `<video class="moderation-video" src="${esc(video)}"${poster ? ` poster="${esc(poster)}" preload="none"` : ' preload="metadata" data-preview-frame="pending"'} controls playsinline></video>` : '<div class="moderation-video moderation-empty">Видео не прикреплено</div>'}
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
  if (!ids.length || document.hidden) return;
  try {
    const body = await api(`?locks=${encodeURIComponent(ids.join(','))}`);
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
  } catch (_) {}
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
}

function startClaimHeartbeat(lineupId, expiresAt) {
  claimedLineupId = lineupId;
  claimExpiresAt = Number(expiresAt) || (Date.now() + 10 * 60_000);
  clearInterval(claimHeartbeatTimer);
  clearInterval(claimCountdownTimer);
  claimCountdownTimer = setInterval(renderClaimTimer, 1000);
  renderClaimTimer();
  claimHeartbeatTimer = setInterval(async () => {
    if (!claimedLineupId || document.hidden) return;
    try {
      const result = await api('', { method: 'POST', body: JSON.stringify({ lineupId: claimedLineupId, action: 'renew_claim' }) });
      claimExpiresAt = Number(result.expires_at) || claimExpiresAt;
      renderClaimTimer();
    } catch (error) {
      clearClaim();
      context.toast('Бронь лайнапа потеряна: ' + error.message, 'e');
    }
  }, 30_000);
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

async function load({ silent = false } = {}) {
  if (loading) return;
  loading = true;
  const status = document.getElementById('moderation-status');
  if (!silent) status.textContent = 'Загрузка очереди…';
  try {
    if (context.getRole?.() === 'admin' && !sessionStorage.getItem('metadata-review-seeded-v2')) {
      await api('', { method: 'POST', body: JSON.stringify({ action: 'seed_metadata_queue' }) });
      sessionStorage.setItem('metadata-review-seeded-v2', '1');
    }
    const body = await api();
    const items = Array.isArray(body.items) ? body.items : [];
    const nextSignature = queueSignature(items);
    if (nextSignature === renderedQueueSignature) {
      loadedItems = items;
      totalQueueItems = Number.isFinite(Number(body.total)) ? Number(body.total) : items.length;
      updateQueueStatus();
    } else {
      render(items, body.total);
    }
    const owned = items.find(item => item.moderation_lock_owned && item.moderation_lock_expires_at > Date.now());
    if (owned) startClaimHeartbeat(owned.id, owned.moderation_lock_expires_at);
  } catch (error) {
    status.textContent = `Не удалось загрузить очередь: ${error.message}`;
    document.getElementById('moderation-list').innerHTML = '';
  } finally {
    loading = false;
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

export function initModeration(nextContext) {
  context = nextContext;
  document.getElementById('moderation-refresh')?.addEventListener('click', load);
  document.getElementById('moderation-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-moderation-action]');
    const card = button?.closest('[data-moderation-id]');
    if (button && card) act(card, button.dataset.moderationAction);
  });
  document.getElementById('moderation-list')?.addEventListener('input', event => {
    if (!event.target.matches('[data-metadata-charge]')) return;
    const wrapper = event.target.parentElement;
    const value = Number(event.target.value);
    wrapper?.style.setProperty('--sova-charge-pct', `${value / 3 * 100}%`);
    wrapper?.classList.toggle('is-max', value >= 3);
  });
  document.getElementById('moderation-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-metadata-bounce]');
    if (!button) return;
    const picker = button.closest('[data-metadata-bounces]');
    const requested = Number(button.dataset.metadataBounce);
    const current = picker.dataset.value === '' ? 0 : Number(picker.dataset.value);
    const next = current === requested ? requested - 1 : requested;
    picker.dataset.value = String(next);
    picker.classList.add('selected');
    picker.querySelectorAll('[data-metadata-bounce]').forEach(item => {
      const value = Number(item.dataset.metadataBounce);
      item.classList.toggle('active', value <= next);
    });
  });
  clearInterval(lockPollTimer);
  clearInterval(queuePollTimer);
  lockPollTimer = setInterval(refreshLocks, 3_000);
  queuePollTimer = setInterval(() => {
    if (!document.hidden) load({ silent: true });
  }, 5_000);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (claimedLineupId) {
      try {
        const result = await api('', { method: 'POST', body: JSON.stringify({ lineupId: claimedLineupId, action: 'renew_claim' }) });
        claimExpiresAt = Number(result.expires_at) || claimExpiresAt;
        renderClaimTimer();
      } catch (error) {
        clearClaim();
        context.toast('Бронь лайнапа потеряна: ' + error.message, 'e');
      }
    }
    refreshLocks();
  });
  async function releaseClaim(lineupId) {
    if (!lineupId) return;
    await api('', { method: 'POST', body: JSON.stringify({ lineupId, action: 'release_claim' }) });
    clearClaim();
    await load();
  }
  return { load, clearClaim, releaseClaim };
}
