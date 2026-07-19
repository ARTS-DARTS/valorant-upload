let context = null;
let loading = false;
let lockPollTimer = null;
let claimHeartbeatTimer = null;
let claimedLineupId = '';
let claimExpiresAt = 0;
let claimCountdownTimer = null;
let totalQueueItems = 0;

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
    ${missing.has('sova_charge') || missing.has('sova_bounces') ? `<fieldset><legend>🏹 Стрела Совы</legend>
      ${missing.has('sova_charge') ? `<div class="moderation-sova-charge" style="--sova-charge-pct:50%"><input type="range" min="0" max="3" step="0.05" value="1.5" data-metadata-charge><div class="moderation-sova-ticks"><span></span><span></span></div><span class="moderation-sova-caption">ЗАРЯД</span></div>` : ''}
      ${missing.has('sova_bounces') ? `<div class="moderation-sova-bounces" data-metadata-bounces data-value=""><span>ОТСКОКИ</span><div><button type="button" data-metadata-bounce="1" aria-label="Первый отскок"><i></i></button><button type="button" data-metadata-bounce="2" aria-label="Второй отскок"><i></i></button></div><small>Нажми ромбы и выставь 0, 1 или 2</small></div>` : ''}
    </fieldset>` : ''}
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

function render(items, total = totalQueueItems) {
  // Defensive client-side deduplication in case an older/cached API response
  // contains the same Firestore document through overlapping queue queries.
  items = [...new Map(items.map(item => [item.id, item])).values()];
  const playback = new Map();
  document.querySelectorAll('[data-moderation-id] video').forEach(video => {
    const id = video.closest('[data-moderation-id]')?.dataset.moderationId;
    if (id) playback.set(id, { time: video.currentTime || 0, playing: !video.paused && !video.ended });
  });
  loadedItems = items;
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
    const metadataTask = item.task_kind === 'metadata';
    const ownedByCurrentModerator = item.moderation_lock_owned === true;
    const meta = [item.moderator_only ? 'ЗАГОТОВКА ДЛЯ МОДЕРАЦИИ' : '', item.map, item.agent, item.agent ? item.ability : 'Выбери агента', sideLabel(item.round_side)].filter(Boolean);
    return `<article class="moderation-card" data-moderation-id="${esc(item.id)}">
      <div class="moderation-card-main">
        ${video ? `<video class="moderation-video" src="${esc(video)}" controls preload="metadata"></video>` : '<div class="moderation-video moderation-empty">Видео не прикреплено</div>'}
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
  items.forEach(item => applyLockToCard(item));
  playback.forEach((state, id) => {
    const video = document.querySelector(`[data-moderation-id="${CSS.escape(id)}"] video`);
    if (!video) return;
    const restore = () => {
      if (state.time > 0) video.currentTime = Math.min(state.time, Number.isFinite(video.duration) ? video.duration : state.time);
      if (state.playing) video.play().catch(() => {});
    };
    if (video.readyState >= 1) restore();
    else video.addEventListener('loadedmetadata', restore, { once: true });
  });
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

async function load() {
  if (loading) return;
  loading = true;
  const status = document.getElementById('moderation-status');
  status.textContent = 'Загрузка очереди…';
  try {
    if (context.getRole?.() === 'admin' && !sessionStorage.getItem('metadata-review-seeded-v1')) {
      await api('', { method: 'POST', body: JSON.stringify({ action: 'seed_metadata_queue' }) });
      sessionStorage.setItem('metadata-review-seeded-v1', '1');
    }
    const body = await api();
    const items = Array.isArray(body.items) ? body.items : [];
    render(items, body.total);
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
    if (missing.has('sova_charge')) data.sova_charge = Number(card.querySelector('[data-metadata-charge]')?.value);
    if (missing.has('sova_bounces')) {
      const raw = card.querySelector('[data-metadata-bounces]')?.dataset.value ?? '';
      data.sova_bounces = raw === '' ? null : Number(raw);
    }
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
    picker.querySelectorAll('[data-metadata-bounce]').forEach(item => item.classList.toggle('active', Number(item.dataset.metadataBounce) <= next));
  });
  clearInterval(lockPollTimer);
  lockPollTimer = setInterval(refreshLocks, 10_000);
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
