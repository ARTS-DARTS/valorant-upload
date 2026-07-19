let context = null;
let loading = false;
let lockPollTimer = null;
let claimHeartbeatTimer = null;
let claimedLineupId = '';
let claimExpiresAt = 0;
let claimCountdownTimer = null;

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
  return value === 'attack' ? 'Атака' : value === 'defense' ? 'Защита' : 'Сторона не указана';
}

async function api(path = '', options = {}) {
  const token = await context.getToken();
  const response = await fetch(`/api/moderation${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Ошибка ${response.status}`);
  return body;
}

function render(items) {
  loadedItems = items;
  const list = document.getElementById('moderation-list');
  const status = document.getElementById('moderation-status');
  status.textContent = items.length ? `В очереди: ${items.length}` : '';
  if (!items.length) {
    list.innerHTML = '<div class="moderation-empty"><strong>Очередь пуста</strong><br>Новые лайнапы появятся здесь автоматически.</div>';
    return;
  }
  list.innerHTML = items.map(item => {
    const video = safeMediaUrl(item.video_url);
    const meta = [item.moderator_only ? 'ЗАГОТОВКА ДЛЯ МОДЕРАЦИИ' : '', item.map, item.agent, item.agent ? item.ability : 'Выбери агента', sideLabel(item.round_side)].filter(Boolean);
    return `<article class="moderation-card" data-moderation-id="${esc(item.id)}">
      <div class="moderation-card-main">
        ${video ? `<video class="moderation-video" src="${esc(video)}" controls preload="metadata"></video>` : '<div class="moderation-video moderation-empty">Видео не прикреплено</div>'}
        <div class="moderation-info">
          <div class="moderation-meta">${meta.map(value => `<span class="moderation-chip">${esc(value)}</span>`).join('')}</div>
          <h3 class="moderation-title">${esc(item.title || 'Без названия')}</h3>
          <p class="moderation-description">${esc(item.description || 'Описание отсутствует')}</p>
          <div class="moderation-author">Автор: ${esc(item.submitted_by || 'не указан')}</div>
        </div>
      </div>
      <div class="moderation-lock-status" data-moderation-lock-status></div>
      <div class="moderation-actions">
        <button class="moderation-action moderation-complete" data-moderation-action="complete" type="button">✏️ Доработать</button>
        <button class="moderation-action moderation-reject" data-moderation-action="reject" type="button">Отклонить с причиной</button>
      </div>
    </article>`;
  }).join('');
  items.forEach(item => applyLockToCard(item));
}

function applyLockToCard(item) {
  const card = document.querySelector(`[data-moderation-id="${CSS.escape(item.id)}"]`);
  if (!card) return;
  const lockedByOther = item.moderation_lock_active && !item.moderation_lock_owned;
  const status = card.querySelector('[data-moderation-lock-status]');
  if (status) {
    status.textContent = lockedByOther ? `🔒 Сейчас редактирует: ${item.moderation_lock_name || 'другой модератор'}` : '';
    status.style.display = lockedByOther ? '' : 'none';
  }
  card.classList.toggle('moderation-card-locked', !!lockedByOther);
  card.querySelectorAll('[data-moderation-action]').forEach(button => { button.disabled = !!lockedByOther; });
}

async function refreshLocks() {
  const ids = loadedItems.map(item => item.id);
  if (!ids.length || document.hidden) return;
  try {
    const body = await api(`?locks=${encodeURIComponent(ids.join(','))}`);
    loadedItems.forEach(item => {
      const lock = body.locks?.[item.id];
      item.moderation_lock_active = !!lock?.active;
      item.moderation_lock_owned = !!lock?.owned;
      item.moderation_lock_name = lock?.name || '';
      applyLockToCard(item);
    });
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
    const body = await api();
    render(Array.isArray(body.items) ? body.items : []);
  } catch (error) {
    status.textContent = `Не удалось загрузить очередь: ${error.message}`;
    document.getElementById('moderation-list').innerHTML = '';
  } finally {
    loading = false;
  }
}

async function act(card, action) {
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
    card.remove();
    context.toast('Лайнап отклонён, причина отправлена автору', 's');
    if (!document.querySelector('.moderation-card')) load();
  } catch (error) {
    context.toast(error.message, 'e');
    buttons.forEach(button => { button.disabled = false; });
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
  return { load, clearClaim };
}
