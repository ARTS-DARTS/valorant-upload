const configs = {
  combo: {
    label: 'КОМБО', name: 'Комбо', icon: '⚡', accent: '#ffb23f',
    intro: 'Покажи связку способностей так, чтобы зритель понял роли игроков, порядок действий и точный тайминг.',
    scenario: 'Fade стягивает соперника Seize на A Site, а Raze точно по таймингу бросает Paint Shells.',
    recording: ['Видео записано в 1920×1080 (Full HD) с качеством игры по умолчанию', 'Показаны агенты, их позиции и роли', 'Полностью показана первая способность', 'Виден тайминг запуска второй способности', 'Показан общий результат связки'],
    issues: ['Не показано, кто начинает комбинацию', 'Монтаж скрывает тайминг между способностями', 'Нет общего результата обеих способностей'],
    title: 'A Site Fade Seize and Raze Nade',
    flow: 'роли → первая способность → тайминг → вторая способность → результат',
    quiz: [
      ['Что отличает комбо от одиночного лайнапа?', ['Красивый монтаж', 'Связка двух или более действий с понятным таймингом', 'Только выбор карты'], 1],
      ['Что обязательно показать между способностями?', ['Точный тайминг и порядок', 'Таблицу счёта', 'Настройки графики'], 0],
      ['Когда комбо доказано?', ['После первой способности', 'Когда показан совместный итог связки', 'После выбора агентов'], 1],
    ],
  },
  wallbang: {
    label: 'ПРОСТРЕЛЫ', name: 'Прострел', icon: '✹', accent: '#ff5e91',
    intro: 'Докажи прострел: оружие, позиция, поверхность, точка прицела и реальный урон должны быть видны без догадок.',
    scenario: 'Игрок с Odin стреляет из Market через стену в соперника на B Main и показывает нанесённый урон.',
    recording: ['Видео записано в 1920×1080 (Full HD) с качеством игры по умолчанию', 'Показаны оружие и исходная позиция', 'Хорошо видны поверхность и точка прицела', 'Сам выстрел показан без монтажного разрыва', 'Видны попадание и нанесённый урон'],
    issues: ['Не показано используемое оружие', 'Невозможно повторить точку прицела', 'Нет подтверждения попадания или урона'],
    title: 'B Main Wallbang from Market',
    flow: 'оружие → позиция → прицел → выстрел → урон',
    quiz: [
      ['Что нужно показать до выстрела?', ['Оружие, позицию и точку прицела', 'Только карту', 'Только соперника'], 0],
      ['Можно ли вырезать момент прохождения пули?', ['Да', 'Нет, выстрел должен быть доказан', 'Только с Odin'], 1],
      ['Чем подтверждается прострел?', ['Попаданием и уроном', 'Громким звуком', 'Название карты'], 0],
    ],
  },
};

const course = location.pathname.includes('/wallbang') ? 'wallbang' : 'combo';
const cfg = configs[course];
const params = new URLSearchParams(location.search);
const uid = params.get('uid') || 'guest';
const storageKey = `vl_category_training_${uid}_${course}`;
const draftKey = `vlineups-training-${course}-${uid}`;
const root = document.getElementById('special-training-root');
const steps = [
  ['Старт', `Зачем нужен инструктаж`], ['Категория', 'Определи тип материала'],
  ['Запись', 'Покажи всё необходимое'], ['Оформление', 'Заполни карточку'],
  ['Контроль', 'Найди ошибки'], ['Допуск', 'Подтверди знания'],
];
const state = { step: 0, maxStep: 0, category: '', recording: new Set(), acknowledged: false, template: '', issues: new Set(), answers: [], completed: false };

function save() {
  localStorage.setItem(draftKey, JSON.stringify({ ...state, recording: [...state.recording], issues: [...state.issues] }));
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (saved) Object.assign(state, saved, { recording: new Set(saved.recording || []), issues: new Set(saved.issues || []) });
  } catch (_) {}
}
function ready() {
  if (state.step === 0) return true;
  if (state.step === 1) return state.category === cfg.name;
  if (state.step === 2) return state.recording.size === cfg.recording.length;
  if (state.step === 3) return state.acknowledged && state.template === 'correct';
  if (state.step === 4) return state.issues.size === cfg.issues.length;
  return state.answers.length === cfg.quiz.length && cfg.quiz.every((q, i) => state.answers[i] === q[2]);
}
function toggle(set, value) { set.has(value) ? set.delete(value) : set.add(value); save(); render(); }
function lesson() {
  if (state.step === 0) return `<p class="eyebrow">ТВОЯ ЗАДАЧА</p><h1>Создай материал категории «${cfg.name}», который можно повторить</h1><p class="lead">${cfg.intro}</p><div class="principles"><article><b>01</b><span>Подготовь<small>Покажи исходные условия</small></span></article><article><b>02</b><span>Объясни<small>Не скрывай ключевые действия</small></span></article><article><b>03</b><span>Докажи<small>Покажи итоговый результат</small></span></article></div>`;
  if (state.step === 1) {
    const options = ['Лайнап', 'Комбо', 'Прострел', 'Защита'];
    return `<p class="eyebrow">СИТУАЦИЯ 01</p><h1>Выбери правильную категорию</h1><div class="scenario"><span class="agent">${cfg.icon}</span><p>${cfg.scenario}</p></div><div class="choices">${options.map(x => `<button class="choice ${state.category === x ? `selected ${x === cfg.name ? 'correct' : 'wrong'}` : ''}" data-category="${x}">${x}</button>`).join('')}</div>${state.category ? `<div class="feedback ${state.category === cfg.name ? 'success' : ''}">${state.category === cfg.name ? `✓ Верно. Это категория «${cfg.name}».` : '× Посмотри на главное действие и результат материала.'}</div>` : ''}`;
  }
  if (state.step === 2) return `<p class="eyebrow">ЧЕК-ЛИСТ ЗАПИСИ</p><h1>Собери полный показ</h1><p class="lead">Отметь всё, без чего зритель не сможет повторить материал.</p><div class="checklist">${cfg.recording.map(x => `<button class="${state.recording.has(x) ? 'selected' : ''}" data-recording="${x}"><i>${state.recording.has(x) ? '✓' : ''}</i>${x}</button>`).join('')}</div>`;
  if (state.step === 3) return `<p class="eyebrow">УЧЕБНАЯ КАРТОЧКА</p><h1>Прочитай правила оформления</h1><div class="example"><strong>ПРИМЕР</strong><p><b>Название:</b> ${cfg.title}</p><p><b>Важно:</b> название материала заполняется на английском языке.</p><p><b>Описание:</b> ${cfg.flow}.</p></div><button class="acknowledge ${state.acknowledged ? 'selected' : ''}" data-acknowledge><i>${state.acknowledged ? '✓' : ''}</i><span><b>Я прочитал правило</b><small>Название должно быть на английском языке</small></span></button><div class="templates"><span>Выбери подходящий шаблон</span><button data-template="correct" class="${state.template === 'correct' ? 'selected correct' : ''}"><b>${cfg.name}</b><br>${cfg.flow}</button><button data-template="wrong" class="${state.template === 'wrong' ? 'selected wrong' : ''}"><b>Неподходящий шаблон</b><br>Общий вид → красивый финал</button></div>`;
  if (state.step === 4) return `<p class="eyebrow">ПРАКТИКА · ПЛОХОЙ ПРИМЕР</p><h1>Найди три причины отклонения</h1><div class="bad-video">▶</div><div class="issues">${cfg.issues.map(x => `<button class="${state.issues.has(x) ? 'selected correct' : ''}" data-issue="${x}"><i>${state.issues.has(x) ? '!' : '?'}</i>${x}</button>`).join('')}</div>`;
  return `<p class="eyebrow">ФИНАЛЬНАЯ ПРОВЕРКА</p><h1>Подтверди правила категории «${cfg.name}»</h1><div class="quiz">${cfg.quiz.map((q, i) => `<article><b>0${i + 1}</b><div><h3>${q[0]}</h3><div class="quiz-options">${q[1].map((a, ai) => `<button data-answer="${i}:${ai}" class="${state.answers[i] === ai ? `selected ${ai === q[2] ? 'correct' : 'wrong'}` : ''}">${a}</button>`).join('')}</div></div></article>`).join('')}</div>`;
}
function completion() {
  const raw = params.get('return') || '/';
  const target = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  return `<div class="completion"><div class="seal"><span>✓</span></div><p class="eyebrow">ДОПУСК · ${cfg.label}</p><h1>Доступ к категории открыт</h1><p class="lead">Инструктаж по категории «${cfg.name}» завершён. Теперь она доступна в форме загрузки.</p><div class="actions"><a class="primary" data-training-return href="${target}">ВЕРНУТЬСЯ К ЗАГРУЗКЕ →</a><button class="ghost" data-repeat>ПРОЙТИ ЕЩЁ РАЗ</button></div></div>`;
}
function render(animateStep = false) {
  const ok = ready();
  document.documentElement.style.setProperty('--cyan', cfg.accent);
  root.innerHTML = `<div class="mobile-lock"><div><h1>Открой инструктаж на компьютере</h1><p>Для обучения нужен большой экран, мышь и клавиатура.</p></div></div><main class="app"><aside class="sidebar"><div class="brand"><i>V</i>VLINEUPS</div><div class="course-label">ИНСТРУКТАЖ · ${cfg.label}</div><nav class="steps">${steps.map((s, i) => `<button class="step ${i === state.step && !state.completed ? 'active' : ''} ${i < state.maxStep || state.completed ? 'done' : ''}" data-step="${i}" ${i > state.maxStep && !state.completed ? 'disabled' : ''}><span class="num">${i < state.maxStep || state.completed ? '✓' : i + 1}</span><span><strong>${s[0]}</strong><small>${s[1]}</small></span></button>`).join('')}</nav><div class="desktop-note">▣ Загрузка доступна только с компьютера</div></aside><section class="workspace"><header class="top"><div><p class="eyebrow">УЧЕБНЫЙ РЕЖИМ · ДАННЫЕ НЕ ПУБЛИКУЮТСЯ</p><h2>${state.completed ? 'Инструктаж завершён' : steps[state.step][0]}</h2></div><div class="progress-label"><b>${state.completed ? 6 : state.step} из 6</b><div class="progress"><i style="width:${state.completed ? 100 : state.step / 6 * 100}%"></i></div></div></header><div class="content ${state.completed ? 'complete' : ''}"><section class="lesson">${state.completed ? completion() : `${lesson()}<div class="lesson-actions"><button class="ghost" data-prev ${state.step === 0 ? 'disabled' : ''}>НАЗАД</button><span>${ok ? 'Можно продолжать' : 'Заверши задание'}</span><button class="primary" data-next ${ok ? '' : 'disabled'}>${state.step === 5 ? 'ЗАВЕРШИТЬ' : 'ДАЛЬШЕ'} →</button></div>`}</section>${state.completed ? '' : `<aside class="quality ${ok ? 'ready' : ''}"><b>КОНТРОЛЬ КАЧЕСТВА</b><div class="scan"><i></i><span>${ok ? '✓' : '⌁'}</span></div><h3>${ok ? 'Шаг пройден' : 'Заверши задание'}</h3><p>${ok ? 'Все обязательные условия выполнены.' : 'Выполни задание слева, чтобы продолжить.'}</p></aside>`}</div></section></main>`;
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
  root.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { const n = Number(b.dataset.step); if (n <= state.maxStep) { state.step = n; save(); render(true); } });
  root.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { state.category = b.dataset.category; save(); render(); });
  root.querySelectorAll('[data-recording]').forEach(b => b.onclick = () => toggle(state.recording, b.dataset.recording));
  root.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => toggle(state.issues, b.dataset.issue));
  root.querySelectorAll('[data-template]').forEach(b => b.onclick = () => { state.template = b.dataset.template; save(); render(); });
  root.querySelector('[data-acknowledge]')?.addEventListener('click', () => { state.acknowledged = !state.acknowledged; save(); render(); });
  root.querySelectorAll('[data-answer]').forEach(b => b.onclick = () => { const [i, a] = b.dataset.answer.split(':').map(Number); state.answers[i] = a; save(); render(); });
  root.querySelector('[data-prev]')?.addEventListener('click', () => { state.step--; save(); render(true); });
  root.querySelector('[data-next]')?.addEventListener('click', () => {
    if (!ready()) return;
    if (state.step < 5) { state.step++; state.maxStep = Math.max(state.maxStep, state.step); save(); render(true); return; }
    localStorage.setItem(storageKey, new Date().toISOString());
    localStorage.removeItem(draftKey);
    state.completed = true;
    window.dispatchEvent(new CustomEvent('author-training-completed'));
    render();
  });
  root.querySelector('[data-repeat]')?.addEventListener('click', () => {
    Object.assign(state, { step: 0, maxStep: 0, category: '', recording: new Set(), acknowledged: false, template: '', issues: new Set(), answers: [], completed: false });
    save(); render();
  });
}
restore();
render(true);
