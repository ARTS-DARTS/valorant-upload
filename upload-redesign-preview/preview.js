const upload = document.getElementById('upload-zone');
const videoCheck = document.getElementById('video-check');
const score = document.getElementById('score');
const readyTitle = document.getElementById('ready-title');
const progressLabel = document.getElementById('progress-label');
const stageNumber = document.getElementById('stage-number');
const stageTitle = document.getElementById('stage-title');
const stageSubtitle = document.getElementById('stage-subtitle');
const toast = document.getElementById('prototype-toast');
let activeStage = 'video';

const stages = {
  basics: ['01', 'Выбери основу', 'Карта и категория определяют доступные инструменты.', 'КАРТА И КАТЕГОРИЯ УЖЕ ВЫБРАНЫ', 'Haven · Лайнапы', 'ИЗМЕНИТЬ ОСНОВУ'],
  video: ['02', 'Добавь видео', 'Покажи установку, ориентиры и полный результат.', 'ПЕРЕТАЩИ ВИДЕО ИЛИ НАЖМИ ДЛЯ ВЫБОРА', '16:9 · 20–30 секунд · MP4, MOV или WebM · до 50 МБ', 'ВЫБРАТЬ ВИДЕО'],
  screens: ['03', 'Добавь скриншоты', 'Разложи объяснение по шагам выбранного шаблона.', 'ДОБАВЬ ЧЕТЫРЕ СКРИНШОТА ПО ШАБЛОНУ', 'Позиция · ориентир · действие · результат', 'ВЫБРАТЬ СКРИНШОТЫ'],
  map: ['04', 'Разметь карту', 'Поставь точку броска и нарисуй траекторию.', 'ИНТЕРАКТИВНАЯ КАРТА ОТКРОЕТСЯ ЗДЕСЬ', 'Сначала позиция, затем траектория', 'ОТКРЫТЬ РАЗМЕТКУ'],
  details: ['05', 'Оформи материал', 'Добавь английское название и выбери шаблон описания.', 'НАЗВАНИЕ И ПАРАМЕТРЫ МАТЕРИАЛА', 'Проверка языка и примеры заполнения включены', 'ЗАПОЛНИТЬ ОФОРМЛЕНИЕ'],
  review: ['06', 'Проверь результат', 'Посмотри материал так, как его увидит модератор.', 'ПРЕДПРОСМОТР МАТЕРИАЛА', 'Все ошибки будут показаны до отправки', 'ОТКРЫТЬ ПРОВЕРКУ'],
};

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 1800);
}

function showStage(target) {
  activeStage = target;
  const [number, title, subtitle, blockTitle, note, action] = stages[target];
  stageNumber.textContent = `ШАГ ${number}`;
  stageTitle.textContent = title;
  stageSubtitle.textContent = subtitle;
  document.getElementById('upload-title').textContent = blockTitle;
  document.getElementById('upload-note').textContent = note;
  upload.querySelector('i').textContent = action;
  upload.querySelector('.upload-icon').textContent = target === 'video' ? '▶' : number;
  upload.classList.remove('loaded');
  document.querySelectorAll('.flow-step').forEach((item) => item.classList.toggle('active', item.dataset.target === target));
}

upload.addEventListener('click', () => {
  if (activeStage !== 'video') {
    showToast(`Этап «${stageTitle.textContent}» переключается и реагирует на нажатие`);
    return;
  }
  upload.classList.add('loaded');
  document.getElementById('upload-title').textContent = 'ascent-cypher-setup.mp4';
  document.getElementById('upload-note').textContent = '00:26 · 34,8 МБ · видео прошло проверку';
  upload.querySelector('.upload-icon').textContent = '✓';
  upload.querySelector('i').textContent = 'ЗАМЕНИТЬ ВИДЕО';
  videoCheck.classList.add('done');
  videoCheck.querySelector('i').textContent = '✓';
  videoCheck.querySelector('small').textContent = 'Видео готово';
  score.textContent = '50%';
  readyTitle.textContent = 'Видео добавлено';
  progressLabel.textContent = '3 ИЗ 6 ГОТОВО';
  document.querySelector('[data-target="video"]').classList.add('done');
  document.querySelector('[data-target="screens"]').classList.add('active');
});

document.getElementById('reset-demo').addEventListener('click', () => location.reload());

document.querySelectorAll('.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    showToast(`Открыт раздел «${button.textContent.trim()}»`);
  });
});

document.querySelectorAll('.flow-step').forEach((button) => {
  button.addEventListener('click', () => showStage(button.dataset.target));
});

document.querySelectorAll('.chips button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.chips button').forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
    showToast(`Выбрана категория «${button.textContent.trim()}»`);
  });
});
