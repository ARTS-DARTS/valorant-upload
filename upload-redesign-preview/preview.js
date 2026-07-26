const proxy = (url) => `/api/valorant-proxy?url=${encodeURIComponent(url)}`;
const canvas = document.getElementById('canvas');
const workflow = document.querySelector('.workflow');
const inspector = document.querySelector('.inspector');
const score = document.getElementById('score');
const readyTitle = document.getElementById('ready-title');
const progressLabel = document.getElementById('progress-label');
const videoCheck = document.getElementById('video-check');

let activeStage = 'basics';
let selectedMap = 'Haven';
let selectedAgent = 'Cypher';
let selectedAbility = '';
let maps = [];
let agents = [];

const fallbackMaps = [
  { displayName: 'Haven', splash: 'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/splash.png', displayIcon: 'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/displayicon.png' },
  { displayName: 'Ascent', splash: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png', displayIcon: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/displayicon.png' },
  { displayName: 'Bind', splash: 'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/splash.png', displayIcon: 'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/displayicon.png' },
  { displayName: 'Split', splash: 'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/splash.png', displayIcon: 'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/displayicon.png' },
  { displayName: 'Icebox', splash: 'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/splash.png', displayIcon: 'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/displayicon.png' },
  { displayName: 'Breeze', splash: 'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/splash.png', displayIcon: 'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/displayicon.png' },
  { displayName: 'Fracture', splash: 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/splash.png', displayIcon: 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/displayicon.png' },
  { displayName: 'Pearl', splash: 'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/splash.png', displayIcon: 'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/displayicon.png' },
  { displayName: 'Lotus', splash: 'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/splash.png', displayIcon: 'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/displayicon.png' },
  { displayName: 'Sunset', splash: 'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/splash.png', displayIcon: 'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/displayicon.png' },
  { displayName: 'Abyss', splash: 'https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/splash.png', displayIcon: 'https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/displayicon.png' },
  { displayName: 'Corrode', splash: 'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/splash.png', displayIcon: 'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/displayicon.png' },
  { displayName: 'Summit', splash: 'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/splash.png', displayIcon: 'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/displayicon.png' },
];

const fallbackAgents = [
  { displayName: 'Cypher', displayIcon: 'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/displayicon.png', fullPortrait: 'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/fullportrait.png', abilities: [] },
  { displayName: 'Killjoy', displayIcon: 'https://media.valorant-api.com/agents/1dbf2edd-4729-0984-3115-daa5eed44993/displayicon.png', fullPortrait: 'https://media.valorant-api.com/agents/1dbf2edd-4729-0984-3115-daa5eed44993/fullportrait.png', abilities: [] },
  { displayName: 'Sage', displayIcon: 'https://media.valorant-api.com/agents/569fdd95-4d10-43ab-ca70-79becc718b46/displayicon.png', fullPortrait: 'https://media.valorant-api.com/agents/569fdd95-4d10-43ab-ca70-79becc718b46/fullportrait.png', abilities: [] },
];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const currentMap = () => maps.find((item) => item.displayName === selectedMap) || maps[0] || fallbackMaps[0];
const currentAgent = () => agents.find((item) => item.displayName === selectedAgent) || agents[0] || fallbackAgents[0];

async function loadAssets() {
  try {
    const [mapsResponse, agentsResponse] = await Promise.all([
      fetch(proxy('https://valorant-api.com/v1/maps')),
      fetch(proxy('https://valorant-api.com/v1/agents?isPlayableCharacter=true')),
    ]);
    const mapData = await mapsResponse.json();
    const agentData = await agentsResponse.json();
    const desiredMaps = ['Haven', 'Ascent', 'Bind', 'Split', 'Icebox', 'Breeze', 'Fracture', 'Pearl', 'Lotus', 'Sunset', 'Abyss', 'Corrode', 'Summit'];
    const desiredAgents = ['Cypher', 'Killjoy', 'Sage', 'Sova', 'Veto', 'Deadlock', 'Vyse'];
    maps = desiredMaps.map((name) => mapData.data.find((item) => item.displayName === name)).filter(Boolean);
    agents = desiredAgents.map((name) => agentData.data.find((item) => item.displayName === name)).filter(Boolean);
  } catch (_) {
    maps = fallbackMaps;
    agents = fallbackAgents;
  }
  if (!maps.length) maps = fallbackMaps;
  if (!agents.length) agents = fallbackAgents;
  renderStage(activeStage);
}

function stageHeader(number, title, subtitle) {
  return `<div class="canvas-head visual-head"><div><p>ШАГ ${number}</p><h1>${title}</h1><span>${subtitle}</span></div><button class="quiet" data-reset>СБРОСИТЬ ДЕМО</button></div>`;
}

function renderBasics() {
  const mapCards = maps.map((map) => `<button class="visual-card map-card ${map.displayName === selectedMap ? 'selected' : ''}" data-map="${esc(map.displayName)}" style="--image:url('${esc(map.splash)}')"><span><b>${esc(map.displayName)}</b><small>${map.displayName === selectedMap ? 'ВЫБРАНА' : 'ВЫБРАТЬ КАРТУ'}</small></span></button>`).join('');
  const agentCards = agents.map((agent) => `<button class="agent-card ${agent.displayName === selectedAgent ? 'selected' : ''}" data-agent="${esc(agent.displayName)}"><img src="${esc(agent.displayIcon)}" alt=""><span>${esc(agent.displayName)}</span></button>`).join('');
  canvas.innerHTML = `${stageHeader('01', 'Собери основу материала', 'Выбери карту и персонажа для материала.')}
    <section class="visual-section"><div class="section-line"><span>01 · КАРТА</span><b>${esc(selectedMap)}</b></div><div class="map-gallery">${mapCards}</div></section>
    <section class="visual-section agent-picker"><div class="section-line"><span>02 · ПЕРСОНАЖ</span><b>${esc(selectedAgent)}</b></div><div class="agent-layout"><div class="agent-gallery">${agentCards}</div></div></section>
    <div class="stage-continue"><span>Основа выбрана — следующий этап уже подготовлен</span><button data-go="video">ПРОДОЛЖИТЬ К ВИДЕО →</button></div>`;
}

function renderVideo() {
  canvas.innerHTML = `${stageHeader('02', 'Смонтируй видео', 'Загрузи исходную запись, обрежь лишнее и оставь полный показ результата.')}
    <div class="context-banner" style="--image:url('${esc(currentMap().splash)}')"><img src="${esc(currentAgent().displayIcon)}" alt=""><div><small>${esc(selectedMap)} · ЗАЩИТА</small><h2>${esc(selectedAgent)}</h2></div></div>
    <button class="upload-zone colorful" id="visual-upload"><span class="upload-icon">✂</span><strong id="visual-upload-title">ДОБАВЬ ИСХОДНУЮ ЗАПИСЬ ДЛЯ МОНТАЖА</strong><small id="visual-upload-note">Обрезка · порядок фрагментов · проверка результата</small><i>ОТКРЫТЬ МОНТАЖ</i></button>
    <div class="video-rules"><span>✓ Убрать лишнее</span><span>✓ Сохранить порядок действий</span><span>✓ Оставить полный результат</span></div>
    <div class="stage-continue"><span>После монтажа скриншоты и карта заполняются в одном редакторе</span><button data-go="editor">ПРОДОЛЖИТЬ В РЕДАКТОР →</button></div>`;
}

function renderEditor() {
  const items = [['01', 'Общий вид', currentMap().splash], ['02', 'Камера', currentAgent().fullPortrait], ['03', 'Растяжки', currentAgent().displayIcon], ['04', 'Результат', currentMap().splash]];
  const abilityButtons = (currentAgent().abilities || []).filter((item) => item.displayIcon).map((ability, index) => `<button class="${selectedAbility === ability.displayName || (!selectedAbility && index === 0) ? 'active' : ''}" data-ability-map="${esc(ability.displayName)}"><img src="${esc(ability.displayIcon)}" alt="" title="${esc(ability.displayName)}"></button>`).join('');
  canvas.innerHTML = `${stageHeader('03', 'Собери материал в редакторе', 'Добавь скриншоты и сразу разметь позицию на карте.')}
    <div class="template-banner"><div><small>ВЫБРАННЫЙ ШАБЛОН</small><h2>Защитный сетап</h2></div><span>Общий вид → камера → растяжки → результат</span></div>
    <div class="screenshot-grid">${items.map(([number, title, image], index) => `<button class="screenshot-card ${index < 2 ? 'filled' : ''}" style="--image:url('${esc(image)}')"><i>${number}</i><b>${title}</b><small>${index < 2 ? 'ЗАГРУЖЕНО' : '+ ДОБАВИТЬ СКРИНШОТ'}</small></button>`).join('')}</div>
    <div class="editor-divider"><span>РАЗМЕТКА КАРТЫ</span><b>Позиция и траектория</b></div>
    <div class="map-editor-preview"><div class="map-tools"><button class="active">1 · ПОЗИЦИЯ</button><button>2 · ТРАЕКТОРИЯ</button><button>ОЧИСТИТЬ</button></div><div class="minimap"><img src="${esc(currentMap().displayIcon)}" alt=""><span class="throw-point"></span><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M32 72 C39 55, 52 47, 69 28"/><circle cx="69" cy="28" r="2"/></svg></div>
    <aside class="ability-settings"><div class="settings-agent"><img src="${esc(currentAgent().displayIcon)}" alt=""><div><b>${esc(selectedAgent)}</b><small>${esc(selectedAbility || 'Выбери способность')}</small></div></div>
      <div class="settings-group"><label>СПОСОБНОСТЬ</label><div class="settings-abilities">${abilityButtons || '<span>Загрузка…</span>'}</div></div>
      <div class="settings-group"><label>СТОРОНА РАУНДА</label><div class="segmented"><button class="active">Атака</button><button>Защита</button></div></div>
      <div class="settings-group"><label>СЛОЖНОСТЬ</label><div class="segmented three"><button>Легко</button><button class="active">Средне</button><button>Сложно</button></div></div>
      <div class="settings-group"><label>ТИП БРОСКА</label><div class="segmented"><button class="active">ЛКМ</button><button>ПКМ</button></div></div>
      <div class="settings-group"><label>ЗАРЯД / ОТСКОКИ</label><div class="charge-row"><button>0</button><button>1</button><button class="active">2</button><button>3</button><span>Отскоки</span><button class="active">1</button></div></div>
      <button class="extra-trajectory">＋ ДОБАВИТЬ ТРАЕКТОРИЮ</button>
    </aside></div>
    <div class="stage-continue"><span>Скриншоты и карта собраны в одном месте</span><button data-go="details">ПЕРЕЙТИ К ОФОРМЛЕНИЮ →</button></div>`;
}

function renderDetails() {
  const abilities = (currentAgent().abilities || []).filter((item) => item.displayIcon).slice(0, 4);
  canvas.innerHTML = `${stageHeader('04', 'Оформи карточку', 'Живой предпросмотр обновляется рядом с полями.')}
    <div class="details-layout"><div class="form-preview"><label>НАЗВАНИЕ НА АНГЛИЙСКОМ<input value="B Site Camera and Trapwires"></label><label>ШАБЛОН ОПИСАНИЯ<select><option>Защитный сетап · 4 скриншота</option></select></label><div class="ability-row">${abilities.map((ability) => `<button><img src="${esc(ability.displayIcon)}" alt="">${esc(ability.displayName)}</button>`).join('')}</div><label>СЛОЖНОСТЬ<div class="difficulty"><button>Легко</button><button class="active">Средне</button><button>Сложно</button></div></label></div>
    <article class="lineup-preview" style="--image:url('${esc(currentMap().splash)}')"><div class="preview-agent"><img src="${esc(currentAgent().displayIcon)}" alt=""></div><span>${esc(selectedMap)} · DEFENSE</span><h2>B Site Camera and Trapwires</h2><p>${esc(selectedAgent)} · Защитный сетап</p><div><b>4</b> скриншота <b>26с</b> видео</div></article></div>`;
}

function renderReview() {
  canvas.innerHTML = `${stageHeader('05', 'Посмотри глазами модератора', 'Перед отправкой видны карточка, медиа и все результаты проверки.')}
    <div class="review-hero" style="--image:url('${esc(currentMap().splash)}')"><div class="review-agent"><img src="${esc(currentAgent().fullPortrait || currentAgent().displayIcon)}" alt=""></div><div class="review-copy"><small>${esc(selectedMap)} · ЗАЩИТА · ${esc(selectedAgent)}</small><h1>B Site Camera and Trapwires</h1><div class="review-tags"><span>✓ Видео 26 сек</span><span>✓ 4 скриншота</span><span>✓ Карта размечена</span></div><button>▶ СМОТРЕТЬ ПРЕДПРОСМОТР</button></div></div>
    <div class="review-result"><span>ГОТОВО К ОТПРАВКЕ</span><h2>Ошибок не найдено</h2><button>ОТПРАВИТЬ МАТЕРИАЛ →</button></div>`;
}

function renderStage(target) {
  activeStage = target;
  workflow.hidden = false;
  inspector.hidden = false;
  document.querySelectorAll('.flow-step').forEach((item) => item.classList.toggle('active', item.dataset.target === target));
  ({ basics: renderBasics, video: renderVideo, editor: renderEditor, details: renderDetails, review: renderReview }[target] || renderBasics)();
}

function renderLibrary(kind) {
  workflow.hidden = true;
  inspector.hidden = true;
  const configs = {
    works: ['Мои работы', '167 опубликованных материалов', ['Одобрено', 'На модерации', 'Популярное']],
    drafts: ['Черновики', 'Продолжи с того места, где остановился', ['Видео добавлено', 'Нужны скриншоты', 'Оформление']],
    rejected: ['Отклонённые', 'Причина и быстрый переход к исправлению', ['Неверное название', 'Мало кадров', 'Исправлено']],
  };
  const [title, subtitle, labels] = configs[kind];
  canvas.innerHTML = `<div class="library-head"><div><p>БИБЛИОТЕКА АВТОРА</p><h1>${title}</h1><span>${subtitle}</span></div><input placeholder="Поиск по карте, агенту или названию"></div>
    <div class="library-grid">${maps.slice(0, 6).map((map, index) => `<article class="work-card"><div class="work-image" style="--image:url('${esc(map.splash)}')"><span>${labels[index % labels.length]}</span><img src="${esc(agents[index % agents.length]?.displayIcon || currentAgent().displayIcon)}" alt=""></div><div><small>${esc(map.displayName)} · ${esc(agents[index % agents.length]?.displayName || selectedAgent)}</small><h2>${['B Site Camera Setup', 'Default Post Plant', 'Retake Utility'][index % 3]}</h2><p>${index % 2 ? '4 скриншота · 24 сек' : '3 скриншота · 19 сек'}</p><button>${kind === 'drafts' ? 'ПРОДОЛЖИТЬ' : kind === 'rejected' ? 'ИСПРАВИТЬ' : 'ОТКРЫТЬ'}</button></div></article>`).join('')}</div>`;
}

function renderStats() {
  workflow.hidden = true;
  inspector.hidden = true;
  canvas.innerHTML = `<div class="library-head"><div><p>АНАЛИТИКА АВТОРА</p><h1>Твои материалы работают</h1><span>Результаты за последние 30 дней</span></div></div>
    <div class="metric-grid"><article><small>ПРОСМОТРЫ</small><b>48 291</b><span>↑ 18%</span></article><article><small>СОХРАНЕНИЯ</small><b>7 842</b><span>↑ 9%</span></article><article><small>ПОВТОРИЛИ</small><b>3 106</b><span>↑ 24%</span></article></div>
    <div class="chart-panel"><div><small>АКТИВНОСТЬ</small><h2>Просмотры материалов</h2></div><div class="bars">${[38,56,45,72,65,88,62,94,77,100,82,96].map((height) => `<i style="height:${height}%"></i>`).join('')}</div></div>
    <div class="top-agents">${agents.slice(0, 4).map((agent, index) => `<article><img src="${esc(agent.displayIcon)}" alt=""><div><b>${esc(agent.displayName)}</b><small>${[12840,9640,7310,4920][index]} просмотров</small></div><span>#${index + 1}</span></article>`).join('')}</div>`;
}

function renderMore() {
  workflow.hidden = true;
  inspector.hidden = true;
  canvas.innerHTML = `<div class="library-head"><div><p>ИНСТРУМЕНТЫ</p><h1>Ещё в кабинете</h1><span>Всё необходимое для работы автора</span></div></div><div class="tool-grid">${[
    ['▣', 'Материалы для авторов', 'Шаблоны, инструкции и примеры'],
    ['●', 'Уведомления', 'Ответы модераторов и новости'],
    ['✦', 'Чат с админом', 'Задать вопрос по материалу'],
    ['◇', 'Модерация', 'Доступно для команды проекта'],
  ].map(([icon, title, text]) => `<button><i>${icon}</i><span><b>${title}</b><small>${text}</small></span><em>→</em></button>`).join('')}</div>`;
}

document.addEventListener('click', (event) => {
  const mapButton = event.target.closest('[data-map]');
  if (mapButton) { selectedMap = mapButton.dataset.map; renderBasics(); return; }
  const agentButton = event.target.closest('[data-agent]');
  if (agentButton) { selectedAgent = agentButton.dataset.agent; selectedAbility = ''; renderBasics(); return; }
  const mapAbilityButton = event.target.closest('[data-ability-map]');
  if (mapAbilityButton) { selectedAbility = mapAbilityButton.dataset.abilityMap; renderEditor(); return; }
  const stageButton = event.target.closest('.flow-step,[data-go]');
  if (stageButton) { renderStage(stageButton.dataset.target || stageButton.dataset.go); return; }
  if (event.target.closest('[data-reset]')) { location.reload(); return; }
  if (event.target.closest('#visual-upload')) {
    const upload = document.getElementById('visual-upload');
    upload.classList.add('loaded');
    upload.querySelector('.upload-icon').textContent = '✓';
    document.getElementById('visual-upload-title').textContent = 'cypher-haven-defense.mp4';
    document.getElementById('visual-upload-note').textContent = '00:26 · 34,8 МБ · видео прошло проверку';
    upload.querySelector('i').textContent = 'ЗАМЕНИТЬ ВИДЕО';
    videoCheck.classList.add('done');
    videoCheck.querySelector('i').textContent = '✓';
    score.textContent = '40%';
    readyTitle.textContent = 'Монтаж готов';
    progressLabel.textContent = '2 ИЗ 5 ГОТОВО';
  }
  const segmentedButton = event.target.closest('.segmented button,.charge-row button');
  if (segmentedButton) {
    const group = segmentedButton.parentElement;
    group.querySelectorAll('button').forEach((button) => button.classList.remove('active'));
    segmentedButton.classList.add('active');
  }
});

document.querySelectorAll('.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const tab = button.dataset.tab;
    if (tab === 'upload') renderStage(activeStage);
    else if (['works', 'drafts', 'rejected'].includes(tab)) renderLibrary(tab);
    else if (tab === 'stats') renderStats();
    else renderMore();
  });
});

maps = fallbackMaps;
agents = fallbackAgents;
renderStage('basics');
loadAssets();
