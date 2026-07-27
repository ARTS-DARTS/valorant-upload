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
  { q: 'Когда лайнап считается доказанным?', a: ['После взмаха рукой', 'После появления прицела', 'Когда показаны попадание и результат'], c: 2 },
];
const state = { step: 0, category: '', recording: new Set(), title: '', template: '', issues: new Set(), answers: [] };
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
  if (state.step === 3) return /^[a-z0-9][a-z0-9 '&+\-]{7,}$/i.test(state.title.trim()) && state.template === 'correct';
  if (state.step === 4) return state.issues.size === issueItems.length;
  return state.answers.length === quiz.length && quiz.every((item, i) => state.answers[i] === item.c);
}
function complete() {
  localStorage.setItem(storageKey, new Date().toISOString());
  localStorage.removeItem(draftKey);
  state.completed = true;
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
  if (state.step === 3) return `<p class="eyebrow">УЧЕБНАЯ КАРТОЧКА</p><h1>Оформи лайнап без догадок</h1><div class="example"><strong>ПРИМЕР</strong><p><b>Название:</b> A Site Recon from A Lobby</p><p><b>Описание:</b> позиция → ориентир → параметры → бросок → результат.</p></div><div class="form-grid"><label>Категория<input value="Лайнапы" disabled></label><label>Карта<input value="Ascent" disabled></label><label class="wide">Название на английском<input id="training-title" value="${state.title.replaceAll('"', '&quot;')}" placeholder="A Site Recon from A Lobby"></label><div class="wide templates"><span>Шаблон описания</span><button data-template="correct" class="${state.template === 'correct' ? 'correct' : ''}"><b>Лайнап по ориентиру</b><br>Позиция → прицел → параметры → бросок → результат</button><button data-template="wrong"><b>Защитный сетап</b><br>Общий вид → установка → активация</button></div></div>`;
  if (state.step === 4) return `<p class="eyebrow">ПРАКТИКА · ПЛОХОЙ ПРИМЕР</p><h1>Найди три причины отклонения</h1><div class="bad-video">▶</div><div class="issues">${issueItems.map(x => `<button class="${state.issues.has(x) ? 'selected correct' : ''}" data-issue="${x}"><i>${state.issues.has(x) ? '!' : '?'}</i>${x}</button>`).join('')}</div>`;
  return `<p class="eyebrow">ФИНАЛЬНАЯ ПРОВЕРКА</p><h1>Подтверди правила лайнапов</h1><div class="quiz">${quiz.map((item, i) => `<article><b>0${i + 1}</b><div><h3>${item.q}</h3><div class="quiz-options">${item.a.map((answer, ai) => `<button data-answer="${i}:${ai}" class="${state.answers[i] === ai ? `selected ${ai === item.c ? 'correct' : 'wrong'}` : ''}">${answer}</button>`).join('')}</div></div></article>`).join('')}</div>`;
}
function completionContent() {
  const rawReturn = params.get('return') || '/';
  const returnPath = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
  return `<div class="completion"><div class="seal"><span>✓</span></div><p class="eyebrow">ДОПУСК · ЛАЙНАПЫ</p><h1>Ты готов оформлять лайнапы</h1><p class="lead">Отдельный допуск для категории «Лайнапы» сохранён. Теперь форма загрузки откроет все этапы.</p><div class="actions"><a class="primary" href="${returnPath}">ВЕРНУТЬСЯ К ЗАГРУЗКЕ →</a><button class="ghost" data-repeat>ПРОЙТИ ЕЩЁ РАЗ</button></div></div>`;
}
function render() {
  const done = Boolean(state.completed);
  const ready = valid();
  root.innerHTML = `<div class="mobile-lock"><div><h1>Открой инструктаж на компьютере</h1><p>Для обучения нужен большой экран, мышь и клавиатура.</p></div></div><main class="app"><aside class="sidebar"><div class="brand"><i>V</i>VLINEUPS</div><div class="course-label">ИНСТРУКТАЖ · ЛАЙНАПЫ</div><nav class="steps">${steps.map((item, i) => `<button class="step ${i === state.step && !done ? 'active' : ''} ${i < state.step || done ? 'done' : ''}" data-step="${i}" ${i > state.step && !done ? 'disabled' : ''}><span class="num">${i < state.step || done ? '✓' : i + 1}</span><span><strong>${item[0]}</strong><small>${item[1]}</small></span></button>`).join('')}</nav><div class="desktop-note">▣ Загрузка доступна только с компьютера</div></aside><section class="workspace"><header class="top"><div><p class="eyebrow">УЧЕБНЫЙ РЕЖИМ · ДАННЫЕ НЕ ПУБЛИКУЮТСЯ</p><h2>${done ? 'Инструктаж завершён' : steps[state.step][0]}</h2></div><div class="progress-label">${done ? '6 из 6' : `${state.step + 1} из 6`}<div class="progress"><i style="width:${done ? 100 : (state.step + 1) / 6 * 100}%"></i></div></div></header><div class="content ${done ? 'complete' : ''}"><section class="lesson">${done ? completionContent() : stepContent()}</section>${done ? '' : `<aside class="quality ${ready ? 'ready' : ''}"><b>КОНТРОЛЬ КАЧЕСТВА</b><div class="scan">${ready ? '✓' : '⌁'}</div><h3>${ready ? 'Шаг пройден' : 'Заверши задание'}</h3><p>${ready ? 'Все обязательные условия выполнены.' : 'Выполни задание слева, чтобы продолжить.'}</p></aside>`}</div>${done ? '' : `<footer class="bottom"><button class="ghost" data-prev ${state.step === 0 ? 'disabled' : ''}>НАЗАД</button><span>${ready ? 'Можно продолжать' : 'Выполни задание, чтобы продолжить'}</span><button class="primary" data-next ${ready ? '' : 'disabled'}>${state.step === 5 ? 'ЗАВЕРШИТЬ' : 'ДАЛЬШЕ'} →</button></footer>`}</section></main>`;
  bind();
}
function bind() {
  root.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { const n = Number(b.dataset.step); if (n <= state.step) { state.step = n; saveDraft(); render(); } });
  root.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { state.category = b.dataset.category; saveDraft(); render(); });
  root.querySelectorAll('[data-recording]').forEach(b => b.onclick = () => toggle(state.recording, b.dataset.recording));
  root.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => toggle(state.issues, b.dataset.issue));
  root.querySelectorAll('[data-template]').forEach(b => b.onclick = () => { state.template = b.dataset.template; saveDraft(); render(); });
  root.querySelectorAll('[data-answer]').forEach(b => b.onclick = () => { const [q, a] = b.dataset.answer.split(':').map(Number); state.answers[q] = a; saveDraft(); render(); });
  const title = root.querySelector('#training-title');
  if (title) title.oninput = e => { state.title = e.target.value; saveDraft(); root.querySelector('[data-next]').disabled = !valid(); };
  root.querySelector('[data-prev]')?.addEventListener('click', () => { state.step--; saveDraft(); render(); });
  root.querySelector('[data-next]')?.addEventListener('click', () => { if (!valid()) return; if (state.step === 5) complete(); else { state.step++; saveDraft(); render(); } });
  root.querySelector('[data-repeat]')?.addEventListener('click', () => { localStorage.removeItem(storageKey); Object.assign(state, { step: 0, category: '', recording: new Set(), title: '', template: '', issues: new Set(), answers: [], completed: false }); render(); });
}
restoreDraft();
state.completed = Boolean(localStorage.getItem(storageKey));
render();
