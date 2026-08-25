const esc = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const secondsOf = value => Number(value?.seconds ?? value?._seconds ?? 0);
const dateOf = value => secondsOf(value) ? new Date(secondsOf(value) * 1000) : null;

function remainingLabel(value) {
  const date = dateOf(value);
  if (!date) return 'Срок не указан';
  const left = date.getTime() - Date.now();
  if (left <= 0) return 'Время истекло';
  const hours = Math.floor(left / 3600000);
  const minutes = Math.max(1, Math.ceil((left % 3600000) / 60000));
  return hours >= 24 ? `${Math.floor(hours / 24)} дн. ${hours % 24} ч.` : hours ? `${hours} ч. ${minutes} мин.` : `${minutes} мин.`;
}

function statusCopy(status) {
  return ({
    active:'Выполняется', submitted:'На проверке', moderator_rework:'У модератора',
    revision_required:'Нужна доработка', hot_awarded:'В «Пирожках»',
    abandoned:'Отказ', expired:'Просрочено', revision_failed:'Закрыто', canceled:'Отменено',
  })[status] || status || '—';
}

function questStatusCopy(status) {
  return ({
    available:'Свободно', assigned:'Взято', under_review:'На проверке',
    revision_required:'На доработке', fulfilled:'В «Пирожках»',
  })[status] || status || '—';
}

function questTone(quest) {
  if (quest.status === 'assigned') return 'claimed';
  if (quest.status === 'under_review') return 'review';
  if (quest.status === 'revision_required') return 'revision';
  if (Number(quest.bonus_vp || 0) > 0) return 'bonus';
  return 'available';
}

function progressPercent(profile) {
  if (!profile?.level_required_xp) return 100;
  return Math.max(0, Math.min(100, Math.round(Number(profile.level_progress_xp || 0) / Number(profile.level_required_xp) * 100)));
}

function rankLabel(rankKey) {
  return ({
    novice:'Новичок', scout:'Разведчик', pathfinder:'Следопыт', veteran:'Ветеран', master:'Мастер',
  })[String(rankKey || '').toLowerCase()] || rankKey || 'Новичок';
}

function questCard(quest, assignment) {
  const tone = questTone(quest);
  const isMine = Boolean(assignment);
  const canTake = quest.status === 'available';
  const canOpen = isMine && ['active', 'revision_required'].includes(assignment.status);
  const assignee = quest.assignee?.hidden ? 'Скрытый авантюрист' : (quest.assignee?.name || 'Авантюрист');
  return `<article class="guild-quest guild-quest--${tone}" data-quest-id="${esc(quest.id)}">
    <div class="guild-quest-rail"><span>${esc(quest.source === 'guildmaster' ? 'ЗАДАНИЕ ГИЛЬДМАСТЕРА' : 'АЛГОРИТМ ДЕФИЦИТА')}</span><b>${esc(questStatusCopy(quest.status))}</b></div>
    <div class="guild-quest-main">
      <div class="guild-quest-icon" aria-hidden="true">${tone === 'claimed' ? '◆' : tone === 'bonus' ? '✦' : '◇'}</div>
      <div><h3>${esc(quest.generated_title || quest.ability || 'Задание')}</h3>
      <p>${[quest.map, quest.agent, quest.ability, quest.round_side].filter(Boolean).map(esc).join(' · ')}</p></div>
    </div>
    ${(quest.start_zone || quest.end_zone) ? `<div class="guild-route"><span>${esc(quest.start_zone || 'Начальная зона')}</span><i>→</i><span>${esc(quest.end_zone || 'Точка результата')}</span></div>` : ''}
    <div class="guild-quest-reward"><span><b>${Number(quest.reward_vp || 0) + Number(quest.bonus_vp || 0)} VP</b>${Number(quest.bonus_vp || 0) ? `<em>включая бонус +${Number(quest.bonus_vp)} VP</em>` : '<em>награда за выполнение</em>'}</span><span><b>${Number(quest.guild_xp || 0)} XP</b><em>опыт Гильдии</em></span></div>
    ${quest.status !== 'available' ? `<div class="guild-assignee"><span>${isMine ? 'Это твоё задание' : `Выполняет: ${esc(assignee)}`}</span>${assignment?.deadline_at ? `<b>${esc(remainingLabel(assignment.deadline_at))}</b>` : ''}</div>` : ''}
    <div class="guild-quest-actions">
      ${canTake ? `<button class="guild-button guild-button--take" type="button" data-guild-action="take" data-quest-id="${esc(quest.id)}">Взять задание</button>` : ''}
      ${canOpen ? `<button class="guild-button guild-button--open" type="button" data-guild-action="open" data-assignment-id="${esc(assignment.id)}">${assignment.status === 'revision_required' ? 'Открыть доработку' : 'Открыть заготовку'}</button>` : ''}
      ${isMine && assignment.status === 'active' ? `<button class="guild-button guild-button--quiet" type="button" data-guild-action="abandon" data-assignment-id="${esc(assignment.id)}">Отказаться</button>` : ''}
    </div>
  </article>`;
}

function assignmentRow(item) {
  const deadline = item.status === 'revision_required' ? item.revision_deadline_at : item.deadline_at;
  const reward = Number(item.snapshot?.reward_vp || 0) + Number(item.snapshot?.bonus_vp || 0);
  const penalty = Number(item.penalty_applied_vp || 0);
  const canOpen = ['active', 'revision_required'].includes(item.status);
  const appealLabel = ({ pending:'Апелляция на рассмотрении', approved:'Штраф отменён', rejected:'Апелляция отклонена' })[item.appeal_status] || '';
  return `<article class="guild-assignment-row guild-assignment-row--${esc(item.status)}">
    <div><span>${esc(statusCopy(item.status))}</span><strong>${esc(item.snapshot?.generated_title || item.snapshot?.ability || 'Задание')}</strong><small>${[item.snapshot?.map, item.snapshot?.agent, item.snapshot?.ability].filter(Boolean).map(esc).join(' · ')}</small></div>
    <div class="guild-assignment-result"><b>${penalty ? `−${penalty} VP` : item.status === 'hot_awarded' ? `+${Number(item.awarded_vp || reward)} VP` : `${reward} VP`}</b><small>${appealLabel || (deadline ? remainingLabel(deadline) : statusCopy(item.status))}</small></div>
    ${canOpen ? `<button class="guild-button guild-button--open" type="button" data-guild-action="open" data-assignment-id="${esc(item.id)}">Продолжить</button>` : ''}
    ${penalty && !item.appeal_status ? `<button class="guild-button guild-button--quiet" type="button" data-guild-action="appeal" data-assignment-id="${esc(item.id)}">Оспорить штраф</button>` : ''}
  </article>`;
}

export function createGuildWebsite({
  host,
  call,
  ensureRewardMembership,
  openAssignmentDraft,
  detachAssignmentDraft,
  toast,
}) {
  let entry = null;
  let dashboard = null;
  let loading = false;

  function renderEntry() {
    const settings = entry?.settings || {};
    const available = entry?.can_join === true;
    host.innerHTML = `<section class="guild-entry">
      <div class="guild-entry-mark" aria-hidden="true"><span>V</span><i>GUILD</i></div>
      <div class="guild-entry-copy"><div class="guild-eyebrow">VLINEUPS · ГИЛЬДИЯ</div><h2>Стать авантюристом</h2>
      <p>Алгоритм выдаёт сольные задания по реальным пробелам базы. Ты заполняешь знакомую форму, а после принятия в «Пирожки» получаешь VP и Guild XP.</p>
      <ul><li>Статус присваивается навсегда</li><li>Первый лимит — до 5 заданий</li><li>Отправка вовремя фиксирует выполнение</li></ul></div>
      <div class="guild-entry-contract">
        <strong>Перед вступлением</strong><p>Выхода из Гильдии нет, но брать задания необязательно. Штрафы и ограничения применяются только к уже полученным заданиям.</p>
        ${available ? `<label><input type="checkbox" id="guild-terms-accepted"><span>Я прочитал правила и понимаю, что статус постоянный. <a href="${esc(settings.terms_url || '/rewards')}" target="_blank" rel="noopener">Открыть правила</a></span></label>
          ${entry.reward_membership_ready ? '' : '<label class="guild-region">Регион Riot-аккаунта<select id="guild-reward-region"><option value="RU">Россия (RU)</option><option value="TR">Турция (TR)</option></select></label>'}
          <button class="guild-button guild-button--join" type="button" data-guild-action="join">Вступить в Гильдию</button>`
          : `<div class="guild-entry-closed">Набор авантюристов пока закрыт. Правила и прогресс уже подготовлены.</div>`}
      </div>
    </section>`;
  }

  function renderDashboard() {
    const profile = dashboard.profile || {};
    const assignments = dashboard.assignments || [];
    const assignmentByQuest = new Map(assignments.map(item => [item.quest_id, item]));
    const active = assignments.filter(item => ['active', 'revision_required', 'submitted', 'moderator_rework'].includes(item.status));
    const history = assignments.filter(item => !active.includes(item)).slice(0, 20);
    host.innerHTML = `<div class="guild-board">
      <header class="guild-command-strip">
        <div class="guild-rank"><span>РАНГ ГИЛЬДИИ</span><strong>${esc(rankLabel(profile.rank_key))}</strong><small>Уровень ${Number(profile.level || 1)}</small></div>
        <div class="guild-level-track"><div><span>${Number(profile.xp || 0)} Guild XP</span><b>${profile.next_level_xp ? `до ${Number(profile.next_level_xp)} XP` : 'максимальный ранг'}</b></div><i><em style="width:${progressPercent(profile)}%"></em></i></div>
        <div class="guild-slots"><span>СЛОТЫ ЗАДАНИЙ</span><strong>${Number(profile.active_assignment_count || 0)}<i>/</i>${Number(profile.quest_limit || 5)}</strong><small>Чем выше уровень, тем больше лимит</small></div>
        <div class="guild-vp"><span>ДОСТУПНО</span><strong>${Number(dashboard.balance?.available_vp || 0)} VP</strong><button type="button" data-guild-action="privacy">${profile.hide_public_nickname ? 'Показывать ник' : 'Скрывать ник'}</button></div>
      </header>
      <section class="guild-legend" aria-label="Обозначения заданий"><b>Метки</b><span class="available">Свободно</span><span class="bonus">Активный бонус</span><span class="claimed">Взято авантюристом</span><span class="review">Проверяется</span><span class="revision">Нужна доработка</span><span class="fulfilled">Пирожки / награда выдана</span></section>
      ${active.length ? `<section class="guild-active"><div class="guild-section-head"><div><span>МОЯ РАБОТА</span><h2>Текущие задания</h2></div><b>${active.filter(item => ['active','revision_required'].includes(item.status)).length} занимают слот</b></div><div class="guild-assignment-list">${active.map(assignmentRow).join('')}</div></section>` : ''}
      <section class="guild-quests"><div class="guild-section-head"><div><span>ДОСКА ГИЛЬДИИ</span><h2>Задания алгоритма</h2></div><b>${(dashboard.quests || []).filter(item => item.status === 'available').length} свободно</b></div>
        <div class="guild-quest-grid">${(dashboard.quests || []).map(quest => questCard(quest, assignmentByQuest.get(quest.id))).join('') || '<div class="guild-empty"><strong>Свободных заданий пока нет</strong><span>Алгоритм обновляет доску по фактическому дефициту материалов.</span></div>'}</div></section>
      <section class="guild-history"><div class="guild-section-head"><div><span>ЛИЧНЫЙ ЖУРНАЛ</span><h2>История и награды</h2></div></div><div class="guild-assignment-list">${history.map(assignmentRow).join('') || '<div class="guild-empty"><strong>История начнётся с первого задания</strong><span>Здесь появятся принятые работы, начисления, отказы и просрочки.</span></div>'}</div></section>
    </div>`;
  }

  function render() {
    if (loading) {
      host.innerHTML = '<div class="guild-loading"><span>◇</span><strong>Гильдия собирает данные…</strong></div>';
      return;
    }
    if (dashboard) renderDashboard(); else renderEntry();
  }

  async function load({ force = false } = {}) {
    if (loading || (!force && (dashboard || entry))) return;
    loading = true; render();
    try {
      entry = await call('getGuildEntry');
      dashboard = entry.member?.permanent ? await call('getGuildDashboard') : null;
    } catch (error) {
      host.innerHTML = `<div class="guild-empty"><strong>Гильдия временно недоступна</strong><span>${esc(error?.message || 'Обнови страницу и попробуй ещё раз.')}</span><button class="guild-button" data-guild-action="reload">Повторить</button></div>`;
    } finally {
      loading = false;
      if (host.querySelector('.guild-loading')) render();
    }
  }

  async function act(button) {
    const action = button.dataset.guildAction;
    if (loading) return;
    if (action === 'reload') return load({ force:true });
    if (action === 'open') {
      const assignment = dashboard?.assignments?.find(item => item.id === button.dataset.assignmentId);
      if (assignment) openAssignmentDraft(assignment);
      return;
    }
    if (action === 'abandon'
      && !confirm('Вернуть задание в Гильдию? Черновик останется в «Кабинет автора → Черновики».')) return;
    let appealReason = '';
    if (action === 'appeal') {
      appealReason = prompt('Объясни, почему штраф нужно пересмотреть. Минимум 10 символов.')?.trim() || '';
      if (!appealReason) return;
      if (appealReason.length < 10) {
        toast('Для апелляции нужно описать причину минимум в 10 символах.', 'w');
        return;
      }
    }
    loading = true;
    button.disabled = true;
    try {
      if (action === 'join') {
        if (!host.querySelector('#guild-terms-accepted')?.checked) throw new Error('Сначала прочитай и подтверди правила Гильдии.');
        if (!entry.reward_membership_ready) {
          await ensureRewardMembership(host.querySelector('#guild-reward-region')?.value || 'RU');
        }
        await call('joinGuild', { accepted:true, terms_version:entry.settings.terms_version });
        toast('Статус авантюриста присвоен', 's');
      }
      if (action === 'take') {
        await call('takeGuildQuest', { quest_id:button.dataset.questId, idempotency_key:crypto.randomUUID() });
        toast('Задание закреплено. Бонус и дедлайн зафиксированы.', 's');
      }
      if (action === 'abandon') {
        const result = await call('abandonGuildQuest', { assignment_id:button.dataset.assignmentId });
        detachAssignmentDraft(button.dataset.assignmentId);
        toast(result.applied_penalty_vp ? `Задание возвращено. Списано ${result.applied_penalty_vp} VP.` : 'Задание возвращено без списания. Черновик сохранён.', result.applied_penalty_vp ? 'w' : 's');
      }
      if (action === 'privacy') {
        await call('setGuildPrivacy', { hide_public_nickname:!dashboard.profile.hide_public_nickname });
        toast('Настройка ника обновлена', 's');
      }
      if (action === 'appeal') {
        await call('createGuildPenaltyAppeal', {
          assignment_id:button.dataset.assignmentId,
          reason:appealReason,
        });
        toast('Апелляция отправлена гильдмастеру.', 's');
      }
      entry = null; dashboard = null;
      loading = false;
      await load({ force:true });
    } catch (error) {
      toast(error?.message || 'Действие Гильдии не выполнено', 'e');
      loading = false;
      render();
    }
  }

  host.addEventListener('click', event => {
    const button = event.target.closest('[data-guild-action]');
    if (button) act(button);
  });

  return {
    open:options => load(options),
    async openAssignment(assignmentId) {
      await load({ force:true });
      const assignment = dashboard?.assignments?.find(item => item.id === assignmentId);
      if (!assignment || !['active', 'revision_required'].includes(assignment.status)) {
        throw new Error('Задание уже недоступно для редактирования. Обнови Гильдию.');
      }
      await openAssignmentDraft(assignment);
    },
    reset() { entry = null; dashboard = null; loading = false; host.innerHTML = ''; },
    refresh() { entry = null; dashboard = null; return load({ force:true }); },
  };
}
