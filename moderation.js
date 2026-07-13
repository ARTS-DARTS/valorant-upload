let context = null;
let loading = false;

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
  const list = document.getElementById('moderation-list');
  const status = document.getElementById('moderation-status');
  status.textContent = items.length ? `В очереди: ${items.length}` : '';
  if (!items.length) {
    list.innerHTML = '<div class="moderation-empty"><strong>Очередь пуста</strong><br>Новые лайнапы появятся здесь автоматически.</div>';
    return;
  }
  list.innerHTML = items.map(item => {
    const video = safeMediaUrl(item.video_url);
    const meta = [item.map, item.agent, item.ability, sideLabel(item.round_side)].filter(Boolean);
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
      <div class="moderation-actions">
        <button class="moderation-action moderation-reject" data-moderation-action="reject" type="button">Отклонить с причиной</button>
        <button class="moderation-action moderation-promote" data-moderation-action="promote" type="button">🔥 В пирожки</button>
      </div>
    </article>`;
  }).join('');
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
  let reason = '';
  if (action === 'reject') {
    reason = prompt('Что автор должен исправить? От 10 до 500 символов.')?.trim() || '';
    if (!reason) return;
    if (reason.length < 10) return context.toast('Напиши более понятную причину — минимум 10 символов', 'e');
  } else if (!confirm('Отправить этот лайнап на финальную публикацию в «Пирожки»?')) {
    return;
  }
  const buttons = card.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    await api('', { method: 'POST', body: JSON.stringify({ lineupId: card.dataset.moderationId, action, reason }) });
    card.remove();
    context.toast(action === 'promote' ? 'Лайнап отправлен в «Пирожки»' : 'Лайнап отклонён, причина отправлена автору', 's');
    if (!document.querySelector('.moderation-card')) load();
  } catch (error) {
    context.toast(error.message, 'e');
    buttons.forEach(button => { button.disabled = false; });
  }
}

export function initModeration(nextContext) {
  context = nextContext;
  document.getElementById('moderation-refresh')?.addEventListener('click', load);
  document.getElementById('moderation-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-moderation-action]');
    const card = button?.closest('[data-moderation-id]');
    if (button && card) act(card, button.dataset.moderationAction);
  });
  return { load };
}
