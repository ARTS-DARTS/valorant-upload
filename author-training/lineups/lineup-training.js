const steps = [
  ['Старт', 'Что делает лайнап полезным'],
  ['Категория', 'Отличи лайнап от других материалов'],
  ['Запись', 'Покажи бросок без пропусков'],
  ['Оформление', 'Подготовь понятную карточку'],
  ['Контроль', 'Найди причины отклонения'],
  ['Допуск', 'Подтверди правила'],
];
const recordingItems = [
  'Исходная позиция игрока показана крупно',
  'Ориентир прицела хорошо различим',
  'Видны параметры броска и движение',
  'Показаны попадание способности и результат',
];
const issueItems = [
  'Не показана исходная позиция',
  'Прицел и ориентир скрыты монтажом',
  'Видео заканчивается до попадания',
];
const quiz = [
  { q: 'Что обязательно показать до броска?', a: ['Только название карты', 'Позицию и ориентир прицела', 'Только агента'], c: 1 },
  { q: 'Можно ли скрыть параметры заряда или отскоков?', a: ['Нет, если они влияют на повторение', 'Да, всегда', 'Только на Ascent'], c: 0 },
  { q: 'Когда лайнап считается выполненным?', a: ['После взмаха рукой', 'После появления прицела', 'Когда показано попадание и результат'], c: 2 },
];
const state = { step: 0, maxStep: 0, category: '', recording: new Set(), acknowledged: false, template: '', issues: new Set(), answers: [] };
const params = new URLSearchParams(location.search);
const uid = params.get('uid') || 'guest';
const storageKey = `vl_category_training_${uid}_lineup`;
const draftKey = `vlineups-training-lineup-${uid}`;
const root = document.getElementById('lineup-training-root');

function saveDraft() {
  localStorage.setItem(draftKey, JSON.stringify({ ...state, recording: [...state.recording], issues: [...state.issues] }));
}
function restoreDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (!saved) return;
    Object.assign(state, saved, { recording: new Set(saved.recording || []), issues: new Set(saved.issues || []) });
  } catch (_) {}
}
function valid() {
  if (state.step === 0) return true;
  if (state.step === 1) return state.category === 'Лайнап';
  if (state.step === 2) return state.recording.size === recordingItems.length;
  if (state.step === 3) return state.acknowledged && state.template === 'correct';
  if (state.step === 4) return state.issues.size === issueItems.length;
  return state.answers.length === quiz.length && quiz.every((item, i) => state.answers[i] === item.c);
}
function complete() {
  localStorage.setItem(storageKey, new Date().toISOString());
  localStorage.removeItem(draftKey);
  state.completed = true;
  window.dispatchEvent(new CustomEvent('author-training-completed'));
  render();
}
function toggle(set, value) { set.has(value) ? set.delete(value) : set.add(value); saveDraft(); render(); }
function stepContent() {
  if (state.step === 0) return `<p class="eyebrow">ТВОЯ ЗАДАЧА</p><h1>Запиши лайнап, который повторят с первой попытки</h1><p class="lead">Хороший лайнап не заставляет угадывать позицию, ориентир или параметры броска. За шесть этапов ты соберёшь материал, готовый к публикации.</p><div class="principles"><article><b>01</b><span>Зафиксируй<small>Покажи точную позицию игрока</small></span></article><article><b>02</b><span>Наведи<small>Дай читаемый ориентир прицела</small></span></article><article><b>03</b><span>Докажи<small>Покажи попадание и результат</small></span></article></div>`;
  if (state.step === 1) {
    const options = ['Лайнап', 'Защита', 'Комбо', 'Фишка'];
    return `<p class="eyebrow">СИТУАЦИЯ 01</p><h1>Выбери правильную категорию</h1><div class="scenario"><span class="agent">S</span><p><strong>Sova</strong> из A Lobby бросает Recon Bolt по ориентиру, чтобы стрела приземлилась на A Site. Что это?</p></div><div class="choices">${options.map(x => `<button class="choice ${state.category === x ? `selected ${x === 'Лайнап' ? 'correct' : 'wrong'}` : ''}" data-category="${x}">${x}</button>`).join('')}</div>${state.category ? `<div class="feedback ${state.category === 'Лайнап' ? 'success' : ''}">${state.category === 'Лайнап' ? '✓ Верно. Это повторяемый бросок способности по ориентиру.' : '× Здесь важны точка броска, ориентир и траектория.'}</div>` : ''}`;
  }
  if (state.step === 2) return `<p class="eyebrow">ЧЕК-ЛИСТ ЗАПИСИ</p><h1>Собери полный показ броска</h1><p class="lead">Отметь всё, без чего зритель не сможет точно повторить лайнап.</p><div class="checklist">${recordingItems.map(x => `<button class="${state.recording.has(x) ? 'selected' : ''}" data-recording="${x}"><i>${state.recording.has(x) ? '✓' : ''}</i>${x}</button>`).join('')}</div>`;
  if (state.step === 3) return `<p class="eyebrow">УЧЕБНАЯ КАРТОЧКА</p><h1>Прочитай правила оформления</h1><div class="example"><strong>ПРИМЕР</strong><p><b>Название:</b> A Site Recon from A Lobby</p><p><b>Важно:</b> название материала заполняется на английском языке.</p><p><b>Описание:</b> позиция → ориентир → параметры → бросок → результат.</p></div><button class="acknowledge ${state.acknowledged ? 'selected' : ''}" data-acknowledge><i>${state.acknowledged ? '✓' : ''}</i><span><b>Я прочитал правило</b><small>Название должно быть на английском языке</small></span></button><div class="templates"><span>Выбери подходящий шаблон</span><button data-template="correct" class="${state.template === 'correct' ? 'selected correct' : ''}"><b>Лайнап по ориентиру</b><br>Позиция → прицел → параметры → бросок → результат</button><button data-template="wrong" class="${state.template === 'wrong' ? 'selected wrong' : ''}"><b>Защитный сетап</b><br>Общий вид → установка → активация</button></div>`;
  if (state.step === 4) return `<p class="eyebrow">ПРАКТИКА · ПЛОХОЙ ПРИМЕР</p><h1>Найди три причины отклонения</h1><div class="bad-video"><video controls playsinline preload="metadata" aria-label="Плохой пример записи лайнапа"><source src="/author-training/lineups/lineup-control-example.mp4?v=2026-07-28-v1" type="video/mp4">Ваш браузер не поддерживает воспроизведение видео.</video></div><div class="issues">${issueItems.map(x => `<button class="${state.issues.has(x) ? 'selected correct' : ''}" data-issue="${x}"><i>${state.issues.has(x) ? '!' : '?'}</i>${x}</button>`).join('')}</div>`;
  return `<p class="eyebrow">ФИНАЛЬНАЯ ПРОВЕРКА</p><h1>Подтверди правила лайнапов</h1><div class="quiz">${quiz.map((item, i) => `<article><b>0${i + 1}</b><div><h3>${item.q}</h3><div class="quiz-options">${item.a.map((answer, ai) => `<button data-answer="${i}:${ai}" class="${state.answers[i] === ai ? `selected ${ai === item.c ? 'correct' : 'wrong'}` : ''}">${answer}</button>`).join('')}</div></div></article>`).join('')}</div>`;
}
function completionContent() {
  const rawReturn = params.get('return') || '/';
  const returnPath = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
  return `<div class="completion"><div class="seal"><span>✓</span></div><p class="eyebrow">ДОПУСК · ЛАЙНАПЫ</p><h1>Ты готов оформлять лайнапы</h1><p class="lead">Отдельный допуск для категории «Лайнапы» сохранён. Теперь форма загрузки откроет все этапы.</p><div class="actions"><a class="primary" data-training-return href="${returnPath}">ВЕРНУТЬСЯ К ЗАГРУЗКЕ →</a><button class="ghost" data-repeat>ПРОЙТИ ЕЩЁ РАЗ</button></div></div>`;
}
function render(animateStep = false) {
  const done = Boolean(state.completed);
  const ready = valid();
  root.innerHTML = `<div class="mobile-lock"><div><h1>Открой инструктаж на компьютере</h1><p>Для обучения нужен большой экран, мышь и клавиатура.</p></div></div><main class="app"><aside class="sidebar"><div class="brand"><i>V</i>VLINEUPS</div><div class="course-label">ИНСТРУКТАЖ · ЛАЙНАПЫ</div><nav class="steps">${steps.map((item, i) => `<button class="step ${i === state.step && !done ? 'active' : ''} ${i < state.maxStep || done ? 'done' : ''}" data-step="${i}" ${i > state.maxStep && !done ? 'disabled' : ''}><span class="num">${i < state.maxStep || done ? '✓' : i + 1}</span><span><strong>${item[0]}</strong><small>${item[1]}</small></span></button>`).join('')}</nav><div class="desktop-note">▣ Загрузка доступна только с компьютера</div></aside><section class="workspace"><header class="top"><div><p class="eyebrow">УЧЕБНЫЙ РЕЖИМ · ДАННЫЕ НЕ ПУБЛИКУЮТСЯ</p><h2>${done ? 'Инструктаж завершён' : steps[state.step][0]}</h2></div><div class="progress-label"><b>${done ? '6 из 6' : `${state.step} из 6`}</b><div class="progress"><i style="width:${done ? 100 : state.step / 6 * 100}%"></i></div></div></header><div class="content ${done ? 'complete' : ''}"><section class="lesson">${done ? completionContent() : `${stepContent()}<div class="lesson-actions"><button class="ghost" data-prev ${state.step === 0 ? 'disabled' : ''}>НАЗАД</button><span>${ready ? 'Можно продолжать' : 'Заверши задание'}</span><button class="primary" data-next ${ready ? '' : 'disabled'}>${state.step === 5 ? 'ЗАВЕРШИТЬ' : 'ДАЛЬШЕ'} →</button></div>`}</section>${done ? '' : `<aside class="quality ${ready ? 'ready' : ''}"><b>КОНТРОЛЬ КАЧЕСТВА</b><div class="scan"><i></i><span>${ready ? '✓' : '⌁'}</span></div><h3>${ready ? 'Шаг пройден' : 'Заверши задание'}</h3><p>${ready ? 'Все обязательные условия выполнены.' : 'Выполни задание слева, чтобы продолжить.'}</p></aside>`}</div></section></main>`;
  root.querySelector('.lesson')?.classList.toggle('entering', animateStep);
  bind();
}
function bind() {
  const sidebar = root.querySelector('.sidebar');
  if (sidebar && !sidebar.querySelector('.training-nav')) {
    const navigation = document.createElement('div');
    navigation.className = 'training-nav';
    navigation.innerHTML = '<a href="/author-training/">← ВСЕ ИНСТРУКТАЖИ</a><a href="/">ВЕРНУТЬСЯ НА САЙТ ↗</a>';
    sidebar.insertBefore(navigation, sidebar.querySelector('.desktop-note'));
  }
  const brand = root.querySelector('.brand');
  if (brand) {
    brand.classList.add('brand-link');
    brand.tabIndex = 0;
    brand.title = 'Все инструктажи';
    const openMenu = () => {
      const menu = new URL('/author-training/', location.origin);
      for (const key of ['uid', 'return']) {
        const value = params.get(key);
        if (value) menu.searchParams.set(key, value);
      }
      location.href = menu;
    };
    brand.onclick = openMenu;
    brand.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') openMenu(); };
  }
  root.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { const n = Number(b.dataset.step); if (n <= state.maxStep) { state.step = n; saveDraft(); render(true); } });
  root.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { state.category = b.dataset.category; saveDraft(); render(); });
  root.querySelectorAll('[data-recording]').forEach(b => b.onclick = () => toggle(state.recording, b.dataset.recording));
  root.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => toggle(state.issues, b.dataset.issue));
  root.querySelectorAll('[data-template]').forEach(b => b.onclick = () => { state.template = b.dataset.template; saveDraft(); render(); });
  root.querySelector('[data-acknowledge]')?.addEventListener('click', () => { state.acknowledged = !state.acknowledged; saveDraft(); render(); });
  root.querySelectorAll('[data-answer]').forEach(b => b.onclick = () => { const [q, a] = b.dataset.answer.split(':').map(Number); state.answers[q] = a; saveDraft(); render(); });
  root.querySelector('[data-prev]')?.addEventListener('click', () => { state.step--; saveDraft(); render(true); });
  root.querySelector('[data-next]')?.addEventListener('click', () => { if (!valid()) return; if (state.step === 5) complete(); else { state.step++; state.maxStep = Math.max(state.maxStep, state.step); saveDraft(); render(true); } });
  root.querySelector('[data-repeat]')?.addEventListener('click', () => { localStorage.removeItem(storageKey); Object.assign(state, { step: 0, maxStep: 0, category: '', recording: new Set(), acknowledged: false, template: '', issues: new Set(), answers: [], completed: false }); render(); });
}
restoreDraft();
state.completed = Boolean(localStorage.getItem(storageKey));
render(true);
