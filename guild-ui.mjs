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

const guildKey = value => String(value || '').trim().toLocaleLowerCase('ru-RU');

function guildSide(value) {
  const side = guildKey(value);
  if (['attack', 'atk', 'атака'].includes(side)) return 'attack';
  if (['defense', 'defence', 'def', 'защита'].includes(side)) return 'defense';
  return 'any';
}

function guildDemandRows(value) {
  if (Array.isArray(value)) return value;
  return Object.entries(value || {}).map(([key, row]) => ({ key, ...(row || {}) }));
}

function guildDemandScore(row = {}) {
  return Math.max(0, Number(row.priority_score || 0));
}

function guildExpectedZones(map) {
  return ['a', 'b', ...(['haven', 'lotus'].includes(guildKey(map)) ? ['c'] : []), 'mid'];
}

function guildCoverageFor(demand, row) {
  const raw = demand?.market_zone_coverage?.[guildKey(row.map)]?.[guildKey(row.agent)]
    ?.[guildKey(row.ability)]?.[guildSide(row.side || row.round_side)];
  const normalized = Object.fromEntries(Object.entries(raw || {}).map(([zone, count]) => [guildKey(zone), Number(count || 0)]));
  return Object.fromEntries(guildExpectedZones(row.map).map(zone => [zone, Number(normalized[zone] || 0)]));
}

function guildQuestForZone(quests, row, zone) {
  return quests.find(quest => guildKey(quest.content_type) === 'lineup'
    && guildKey(quest.map) === guildKey(row.map)
    && guildKey(quest.agent) === guildKey(row.agent)
    && guildKey(quest.ability) === guildKey(row.ability)
    && guildSide(quest.round_side) === guildSide(row.side || row.round_side)
    && guildKey(quest.end_zone) === guildKey(zone));
}

function guildDemandTask(row, quests, abilityIcon, rewards) {
  const coverage = guildCoverageFor(row.demand, row);
  const zones = Object.entries(coverage);
  const missing = zones.filter(([, count]) => count <= 0).map(([zone]) => zone);
  const zoneStates = missing.map(zone => ({ zone, quest:guildQuestForZone(quests, row, zone) }));
  const available = zoneStates.find(item => !item.quest || item.quest.status === 'available');
  const allClaimed = missing.length > 0 && !available;
  const icon = abilityIcon(row.agent, row.ability);
  const status = missing.length
    ? (allClaimed ? 'ВЗЯТО АВАНТЮРИСТОМ' : `НУЖНЫ · ${missing.map(zone => zone === 'mid' ? 'MID' : zone.toUpperCase()).join(' / ')}`)
    : 'ВСЕ ЗОНЫ ЕСТЬ';
  const chips = zones.map(([zone, count]) => {
    const quest = guildQuestForZone(quests, row, zone);
    const state = count > 0 ? 'filled' : quest && quest.status !== 'available' ? 'claimed' : 'missing';
    return `<span class="${state}"><em>${zone === 'mid' ? 'MID' : zone.toUpperCase()}</em><b>${Number(count || 0)}</b></span>`;
  }).join('');
  const take = available ? `<button class="guild-demand-take" type="button" data-guild-action="take-demand"
    data-guild-demand-map="${esc(row.map)}" data-guild-demand-agent="${esc(row.agent)}"
    data-guild-demand-ability="${esc(row.ability)}" data-guild-demand-side="${esc(guildSide(row.side || row.round_side))}"
    data-guild-demand-zone="${esc(available.zone)}">Взять</button>` : '';
  return `<article class="guild-demand-ability reward-demand-ability${missing.length ? ' urgent' : ''}${allClaimed ? ' claimed' : ''}">
    <span class="guild-demand-ability-icon reward-demand-ability-icon">${icon ? `<img src="${esc(icon)}" alt="">` : '✦'}</span>
    <span class="guild-demand-count reward-demand-count">${Number(row.count || 0)}</span>
    <div class="guild-demand-copy"><strong>${esc(row.ability || 'Способность')}</strong><small>${esc(guildSide(row.side || row.round_side))}</small><div class="guild-demand-zones reward-demand-zones">${chips}</div></div>
    <div class="guild-demand-result"><b>${status}</b><small>${rewards.vp} VP · ${rewards.xp} Guild XP</small></div>${take}
  </article>`;
}

function guildDemandBoard({ quests, demand, settings, assignmentByQuest, selectedAgent, selectedMap, agentIcon, abilityIcon }) {
  const mapRows = guildDemandRows(demand?.map_pool).filter(row => guildKey(row.category || row.content_type || 'lineup') === 'lineup'
    && row.map && row.agent && row.ability);
  const subscribers = demand?.agent_notification_subscribers || {};
  const unique = values => [...new Set(values.filter(Boolean))];
  const rowsForAgent = agent => mapRows.filter(row => guildKey(row.agent) === guildKey(agent));
  const agentPriority = agent => {
    const rows = rowsForAgent(agent);
    return {
      score:rows.length ? Math.max(...rows.map(guildDemandScore)) : 0,
      subscribers:Number(rows[0]?.agent_subscribers ?? subscribers[guildKey(agent)] ?? subscribers[agent] ?? 0),
      deficitCount:rows.filter(row => row.deficit === true).length,
      minCount:rows.length ? Math.min(...rows.map(row => Number(row.count || 0))) : 9999,
    };
  };
  const agents = unique(mapRows.map(row => String(row.agent || '').trim())).sort((a, b) => {
    const ap = agentPriority(a); const bp = agentPriority(b);
    return bp.score - ap.score || bp.subscribers - ap.subscribers || bp.deficitCount - ap.deficitCount
      || ap.minCount - bp.minCount || a.localeCompare(b, 'ru');
  });
  const activeAgent = agents.includes(selectedAgent) ? selectedAgent : (agents[0] || '');
  const agentRows = rowsForAgent(activeAgent);
  const mapPriority = map => {
    const rows = agentRows.filter(row => guildKey(row.map) === guildKey(map));
    return {
      score:rows.length ? Math.max(...rows.map(guildDemandScore)) : 0,
      deficitCount:rows.filter(row => row.deficit === true).length,
      minCount:rows.length ? Math.min(...rows.map(row => Number(row.count || 0))) : 9999,
    };
  };
  const maps = unique([...(demand?.active_map_pool || []), ...agentRows.map(row => String(row.map || '').trim())]).sort((a, b) => {
    const ap = mapPriority(a); const bp = mapPriority(b);
    return bp.score - ap.score || bp.deficitCount - ap.deficitCount || ap.minCount - bp.minCount || a.localeCompare(b, 'ru');
  });
  const activeMap = maps.includes(selectedMap) ? selectedMap : (maps[0] || '');
  const visible = agentRows.filter(row => guildKey(row.map) === guildKey(activeMap))
    .sort((a, b) => guildDemandScore(b) - guildDemandScore(a) || Number(a.count || 0) - Number(b.count || 0));
  const agentButtons = agents.map((agent, index) => {
    const icon = agentIcon(agent); const selected = agent === activeAgent;
    const opacity = Math.max(.34, 1 - (index / Math.max(1, agents.length - 1)) * .66);
    return `<button class="guild-demand-agent${selected ? ' selected' : ''}" type="button" data-guild-filter-agent="${esc(agent)}" aria-pressed="${selected}" title="${esc(agent)} · подписки: ${agentPriority(agent).subscribers}" style="--demand-opacity:${opacity.toFixed(2)}">${icon ? `<img src="${esc(icon)}" alt="${esc(agent)}">` : `<span>${esc(agent.slice(0, 1) || '?')}</span>`}</button>`;
  }).join('');
  const mapButtons = maps.map((map, index) => `<button class="guild-demand-map${map === activeMap ? ' selected' : ''}${mapPriority(map).deficitCount ? ' priority' : ''}" type="button" data-guild-filter-map="${esc(map)}" aria-pressed="${map === activeMap}"><strong>${esc(map)}</strong><small>ПРИОРИТЕТ ${index + 1}</small></button>`).join('');
  const groups = [
    { key:'attack', icon:'⚔', label:'АТАКА' }, { key:'defense', icon:'◆', label:'ЗАЩИТА' },
  ].map(group => {
    const rows = visible.filter(row => guildSide(row.side || row.round_side) === group.key).map(row => ({ ...row, demand }));
    if (!rows.length) return '';
    const zoneCounts = rows.flatMap(row => Object.values(guildCoverageFor(demand, row)));
    const filled = zoneCounts.filter(count => Number(count) > 0).length;
    const rewards = { vp:Number(settings?.algorithm_reward_vp || 0) + Number(settings?.algorithm_bonus_vp || 0), xp:Number(settings?.algorithm_guild_xp || 0) };
    return `<section class="guild-demand-side guild-demand-side--${group.key}"><header><span>${group.icon}</span><strong>${group.label}</strong><b>${filled}/${zoneCounts.length}</b></header><div>${rows.map(row => guildDemandTask(row, quests, abilityIcon, rewards)).join('')}</div></section>`;
  }).join('');
  const manual = quests.filter(quest => quest.source === 'guildmaster');
  return {
    selectedAgent:activeAgent,
    selectedMap:activeMap,
    deficitCount:mapRows.filter(row => row.deficit === true).length,
    html: mapRows.length ? `<div class="guild-demand-board">
      <p class="guild-demand-note">Порядок учитывает дефицит агента и способности на каждой карте.</p>
      <section class="guild-demand-stage"><label>1 · АГЕНТ · ПО ПРИОРИТЕТУ И ПОДПИСКАМ</label><div class="guild-demand-agents">${agentButtons}</div></section>
      <section class="guild-demand-stage"><label>2 · ВЕСЬ АКТИВНЫЙ МАППУЛ · ПРИОРИТЕТНЫЕ КАРТЫ ПЕРВЫМИ</label><div class="guild-demand-maps">${mapButtons}</div></section>
      <section class="guild-demand-stage"><label>3 · СПОСОБНОСТЬ И НЕДОСТАЮЩИЕ ЗОНЫ</label><div class="guild-demand-side-columns">${groups || '<div class="guild-empty"><strong>Для этой карты заданий нет</strong><span>Выбери другого агента или карту.</span></div>'}</div></section>
    </div>${manual.length ? `<div class="guild-manual-quests"><h3>Задания гильдмастера</h3><div class="guild-quest-grid">${manual.map(quest => questCard(quest, assignmentByQuest.get(quest.id))).join('')}</div></div>` : ''}`
      : '<div class="guild-empty"><strong>Данные алгоритма пока обновляются</strong><span>Доска появится после следующего расчёта дефицита.</span></div>',
  };
}

function assignmentRow(item) {
  const deadline = item.status === 'revision_required' ? item.revision_deadline_at : item.deadline_at;
  const reward = Number(item.snapshot?.reward_vp || 0) + Number(item.snapshot?.bonus_vp || 0);
  const penalty = Number(item.penalty_applied_vp || 0);
  const canOpen = ['active', 'revision_required'].includes(item.status);
  const appealLabel = ({ pending:'Апелляция на рассмотрении', approved:'Штраф отменён', rejected:'Апелляция отклонена' })[item.appeal_status] || '';
  const imported = item.imported_from_reward_program === true;
  const resultNote = imported
    ? `Ранее выдано · +${Number(item.awarded_guild_xp || item.snapshot?.guild_xp || 0)} Guild XP`
    : (appealLabel || (deadline ? remainingLabel(deadline) : ''));
  return `<article class="guild-assignment-row guild-assignment-row--${esc(item.status)}${imported ? ' guild-assignment-row--imported' : ''}">
    <div><span>${imported ? 'ПЕРЕНЕСЕНО ИЗ АКЦИИ VP' : esc(statusCopy(item.status))}</span><strong>${esc(item.snapshot?.generated_title || item.snapshot?.ability || 'Задание')}</strong><small>${[item.snapshot?.map, item.snapshot?.agent, item.snapshot?.ability].filter(Boolean).map(esc).join(' · ')}</small></div>
    <div class="guild-assignment-result"><b>${penalty ? `−${penalty} VP` : item.status === 'hot_awarded' ? `+${Number(item.awarded_vp || reward)} VP` : `${reward} VP`}</b>${resultNote ? `<small>${esc(resultNote)}</small>` : ''}</div>
    ${canOpen ? `<button class="guild-button guild-button--open" type="button" data-guild-action="open" data-assignment-id="${esc(item.id)}">Продолжить</button>` : ''}
    ${penalty && !item.appeal_status ? `<button class="guild-button guild-button--quiet" type="button" data-guild-action="appeal" data-assignment-id="${esc(item.id)}">Оспорить штраф</button>` : ''}
  </article>`;
}

function sizeGuildHistory(host) {
  requestAnimationFrame(() => {
    const list = host.querySelector('[data-visible-guild-history-rows]');
    if (!list) return;
    const rowCount = Math.max(1, Number(list.dataset.visibleGuildHistoryRows || 7));
    const items = [...list.children].slice(0, rowCount);
    if (list.children.length <= rowCount || items.length < rowCount) {
      list.style.maxHeight = 'none';
      return;
    }
    const style = getComputedStyle(list);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
    const height = items.reduce((total, item) => total + item.getBoundingClientRect().height, 0)
      + gap * (items.length - 1) + padding + border;
    list.style.maxHeight = `${Math.ceil(height)}px`;
  });
}

export function createGuildWebsite({
  host,
  call,
  ensureRewardMembership,
  openAssignmentDraft,
  detachAssignmentDraft,
  openVpExchange = () => {},
  startTour = () => {},
  agentIcon = () => '',
  abilityIcon = () => '',
  toast,
}) {
  let entry = null;
  let dashboard = null;
  let loading = false;
  let selectedAgent = '';
  let selectedMap = '';

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
        <button class="guild-button guild-button--quiet" type="button" data-guild-action="tour">Короткая экскурсия</button>
      </div>
    </section>`;
  }

  function renderDashboard() {
    const profile = dashboard.profile || {};
    const assignments = dashboard.assignments || [];
    const assignmentByQuest = new Map(assignments.map(item => [item.quest_id, item]));
    const active = assignments.filter(item => ['active', 'revision_required', 'submitted', 'moderator_rework'].includes(item.status));
    const history = assignments.filter(item => !active.includes(item));
    const demandBoard = guildDemandBoard({
      quests:dashboard.quests || [], demand:dashboard.demand || {}, settings:dashboard.settings || {}, assignmentByQuest,
      selectedAgent, selectedMap, agentIcon, abilityIcon,
    });
    selectedAgent = demandBoard.selectedAgent;
    selectedMap = demandBoard.selectedMap;
    host.innerHTML = `<div class="guild-board">
      <header class="guild-command-strip">
        <div class="guild-rank"><span>РАНГ ГИЛЬДИИ</span><strong>${esc(rankLabel(profile.rank_key))}</strong><small>Уровень ${Number(profile.level || 1)} · серия ${Number(profile.completion_streak_days || 0)} дн. · рекорд ${Number(profile.best_completion_streak_days || 0)}</small></div>
        <div class="guild-level-track"><div><span>${Number(profile.xp || 0)} Guild XP</span><b>${profile.next_level_xp ? `до ${Number(profile.next_level_xp)} XP` : 'максимальный ранг'}</b></div><i><em style="width:${progressPercent(profile)}%"></em></i></div>
        <div class="guild-slots"><span>СЛОТЫ ЗАДАНИЙ</span><strong>${Number(profile.active_assignment_count || 0)}<i>/</i>${Number(profile.quest_limit || 5)}</strong><small>Чем выше уровень, тем больше лимит</small></div>
        <div class="guild-vp"><span>ДОСТУПНО</span><strong>${Number(dashboard.balance?.available_vp || 0)} VP</strong><div class="guild-vp-actions"><button class="guild-vp-exchange" type="button" data-guild-action="exchange">Обменять</button><button class="guild-vp-privacy" type="button" data-guild-action="privacy">${profile.hide_public_nickname ? 'Показать ник' : 'Скрыть ник'}</button></div></div>
      </header>
      <section class="guild-legend" aria-label="Обозначения заданий"><b>Метки</b><span class="available">Свободно</span><span class="bonus">Активный бонус</span><span class="claimed">Взято авантюристом</span><span class="review">Проверяется</span><span class="revision">Нужна доработка</span><span class="fulfilled">Пирожки / награда выдана</span></section>
      ${active.length ? `<section class="guild-active"><div class="guild-section-head"><div><span>МОЯ РАБОТА</span><h2>Текущие задания</h2></div><b>${active.filter(item => ['active','revision_required'].includes(item.status)).length} занимают слот</b></div><div class="guild-assignment-list">${active.map(assignmentRow).join('')}</div></section>` : ''}
      <section class="guild-quests"><div class="guild-section-head"><div><span>ДОСКА ГИЛЬДИИ</span><h2>Задания алгоритма</h2></div><div class="guild-section-head-actions"><b>${demandBoard.deficitCount} активных дефицитов</b><button type="button" data-guild-action="tour">Как это работает?</button></div></div>
        ${demandBoard.html}</section>
      <section class="guild-history"><div class="guild-section-head"><div><span>ЛИЧНЫЙ ЖУРНАЛ</span><h2>История и награды</h2></div></div><div class="guild-assignment-list guild-assignment-list--history" data-visible-guild-history-rows="7">${history.map(assignmentRow).join('') || '<div class="guild-empty"><strong>История начнётся с первого задания</strong><span>Здесь появятся принятые работы, начисления, отказы и просрочки.</span></div>'}</div></section>
    </div>`;
    sizeGuildHistory(host);
  }

  function render() {
    if (loading) {
      host.innerHTML = '<div class="guild-loading"><span>◇</span><strong>Гильдия собирает данные…</strong></div>';
      return;
    }
    if (dashboard) renderDashboard(); else renderEntry();
  }

  function preserveReturnedDrafts(assignments) {
    const returned = (assignments || []).filter(item =>
      ['abandoned', 'expired', 'revision_failed', 'canceled'].includes(item.status));
    let saved = 0;
    for (const assignment of returned) {
      if (detachAssignmentDraft(assignment.id) === true) saved += 1;
    }
    if (saved) {
      toast(
        saved === 1
          ? 'Черновик возвращённого задания сохранён: Кабинет автора → Черновики.'
          : `Сохранено черновиков возвращённых заданий: ${saved}. Открой «Кабинет автора → Черновики».`,
        's',
      );
    }
  }

  async function load({ force = false } = {}) {
    if (loading || (!force && (dashboard || entry))) return;
    loading = true; render();
    try {
      entry = await call('getGuildEntry');
      dashboard = entry.member?.permanent ? await call('getGuildDashboard') : null;
      if (dashboard) preserveReturnedDrafts(dashboard.assignments);
    } catch (error) {
      host.innerHTML = `<div class="guild-empty"><strong>Гильдия временно недоступна</strong><span>${esc(error?.message || 'Обнови страницу и попробуй ещё раз.')}</span><button class="guild-button" data-guild-action="reload">Повторить</button></div>`;
    } finally {
      loading = false;
      if (host.querySelector('.guild-loading')) render();
    }
  }

  async function openTrackedDraft(assignment) {
    await call('recordGuildQuestOpened', { assignment_id:assignment.id }).catch(() => {});
    await openAssignmentDraft(assignment);
  }

  async function act(button) {
    const action = button.dataset.guildAction;
    if (loading) return;
    if (action === 'reload') return load({ force:true });
    if (action === 'exchange') return openVpExchange();
    if (action === 'tour') return startTour();
    if (action === 'open') {
      const assignment = dashboard?.assignments?.find(item => item.id === button.dataset.assignmentId);
      if (assignment) await openTrackedDraft(assignment);
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
      if (action === 'take' || action === 'take-demand') {
        let questId = button.dataset.questId || '';
        if (action === 'take-demand') {
          const ensured = await call('ensureGuildDemandQuest', {
            map:button.dataset.guildDemandMap,
            agent:button.dataset.guildDemandAgent,
            ability:button.dataset.guildDemandAbility,
            round_side:button.dataset.guildDemandSide,
            end_zone:button.dataset.guildDemandZone,
          });
          questId = ensured.quest_id;
        }
        await call('takeGuildQuest', { quest_id:questId, idempotency_key:crypto.randomUUID() });
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
    const agent = event.target.closest('[data-guild-filter-agent]');
    if (agent) {
      selectedAgent = agent.dataset.guildFilterAgent || '';
      selectedMap = '';
      renderDashboard();
      return;
    }
    const map = event.target.closest('[data-guild-filter-map]');
    if (map) {
      selectedMap = map.dataset.guildFilterMap || '';
      renderDashboard();
      return;
    }
    const button = event.target.closest('[data-guild-action]');
    if (button) act(button);
  });

  host.addEventListener('wheel', event => {
    const rail = event.target.closest?.('.guild-demand-agents,.guild-demand-maps');
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    const maxScroll = rail.scrollWidth - rail.clientWidth;
    const canMove = delta < 0 ? rail.scrollLeft > 0 : rail.scrollLeft < maxScroll - 1;
    if (!canMove) return;
    event.preventDefault();
    rail.scrollLeft = Math.max(0, Math.min(maxScroll, rail.scrollLeft + delta));
  }, { passive:false });

  let historyResizeFrame = 0;
  window.addEventListener('resize', () => {
    if (historyResizeFrame) cancelAnimationFrame(historyResizeFrame);
    historyResizeFrame = requestAnimationFrame(() => {
      historyResizeFrame = 0;
      sizeGuildHistory(host);
    });
  });

  return {
    open:options => load(options),
    async openAssignment(assignmentId) {
      await load({ force:true });
      const assignment = dashboard?.assignments?.find(item => item.id === assignmentId);
      if (!assignment || !['active', 'revision_required'].includes(assignment.status)) {
        throw new Error('Задание уже недоступно для редактирования. Обнови Гильдию.');
      }
      await openTrackedDraft(assignment);
    },
    reset() { entry = null; dashboard = null; loading = false; selectedAgent = ''; selectedMap = ''; host.innerHTML = ''; },
    refresh() { entry = null; dashboard = null; return load({ force:true }); },
  };
}
