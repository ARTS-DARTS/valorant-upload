const CYPHER_ICON =
  'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/displayicon.png';
const TRAINING_VIDEO = '/author-training/training-control-example.mp4?v=2026-07-26-v1';
const DEFENSE_FORM_VIDEO = '/author-training/defense-form-guide.mp4';
const ASCENT_MAP =
  'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/displayicon.png';
const KILLJOY_ABILITY_ROOT =
  'https://media.valorant-api.com/agents/1e58de9c-4950-5125-93e9-a0aee9f98746/abilities';
const controlAnswers = new Map();
let completingControlStep = false;
const trainingParams = new URLSearchParams(window.location.search);

function trainingCompletionKey() {
  const category = trainingParams.get('category') || 'defense';
  const uid = trainingParams.get('uid') || 'guest';
  return `vl_category_training_${uid}_${category}`;
}

function recordTrainingCompletion() {
  try {
    localStorage.setItem(trainingCompletionKey(), new Date().toISOString());
  } catch (_) {}
}

function addTrainingReturnAction(completion) {
  if (completion.querySelector('[data-training-return]')) return;
  recordTrainingCompletion();
  const rawReturn = trainingParams.get('return') || '/';
  const returnPath = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
  const link = document.createElement('a');
  link.dataset.trainingReturn = 'true';
  link.className = 'primary training-return-link';
  link.href = returnPath;
  link.textContent = 'ВЕРНУТЬСЯ К ЗАГРУЗКЕ →';
  completion.appendChild(link);
}

function createDefenseFormVideoGuide() {
  if (document.querySelector('[data-defense-form-guide]')) return;
  const launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'training-video-launch';
  launch.dataset.defenseFormGuide = 'launch';
  launch.innerHTML = '<span>▶</span><b>КАК ЗАПОЛНИТЬ ФОРМУ ЗАЩИТЫ</b><small>Пошаговый видеоразбор</small>';

  const modal = document.createElement('div');
  modal.className = 'training-video-modal';
  modal.dataset.defenseFormGuide = 'modal';
  modal.hidden = true;
  modal.innerHTML = `
    <section class="training-video-dialog" role="dialog" aria-modal="true"
      aria-labelledby="defense-form-video-title">
      <button class="training-video-close" type="button" aria-label="Закрыть">×</button>
      <div class="training-video-kicker">ПРАКТИЧЕСКИЙ РАЗБОР</div>
      <h2 id="defense-form-video-title">Как правильно заполнить форму защиты</h2>
      <p>На видео будет показан весь путь: карта и агент → запись → кадры и способности → оформление → проверка.</p>
      <div class="training-video-stage">
        <video controls preload="metadata" playsinline></video>
        <div class="training-video-placeholder">
          <strong>Видео готовится</strong>
          <span>После записи администратора оно появится здесь — интерфейс уже готов.</span>
        </div>
      </div>
    </section>`;

  const video = modal.querySelector('video');
  const placeholder = modal.querySelector('.training-video-placeholder');
  const close = () => {
    modal.hidden = true;
    video.pause();
    document.body.classList.remove('training-video-open');
  };
  launch.addEventListener('click', () => {
    modal.hidden = false;
    document.body.classList.add('training-video-open');
    if (!video.dataset.loaded) {
      video.dataset.loaded = 'true';
      video.src = `${DEFENSE_FORM_VIDEO}?v=${Date.now()}`;
      video.load();
    }
  });
  modal.querySelector('.training-video-close').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });
  video.addEventListener('loadedmetadata', () => {
    video.hidden = false;
    placeholder.hidden = true;
  });
  video.addEventListener('error', () => {
    video.hidden = true;
    placeholder.hidden = false;
  });

  document.body.append(launch, modal);
}

function setReactInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createAbilityMarker(slot, name, x, y) {
  const marker = document.createElement('span');
  marker.className = 'training-ability-marker';
  marker.style.left = `${x}%`;
  marker.style.top = `${y}%`;
  marker.title = name;
  marker.innerHTML = `<img src="${KILLJOY_ABILITY_ROOT}/${slot}/displayicon.png" alt="${name}">`;
  return marker;
}

function syncControlReview(panel) {
  panel.querySelectorAll('[data-training-answer]').forEach(button => {
    const answer = controlAnswers.get(button.dataset.trainingGroup);
    const selected = answer?.id === button.dataset.trainingAnswer;
    const correct = button.dataset.trainingCorrect === 'true';
    button.classList.toggle('selected', selected);
    button.classList.toggle('correct', selected && correct);
    button.classList.toggle('wrong', selected && !correct);
    button.querySelector('i').textContent = selected ? (correct ? '✓' : '×') : '?';
  });
  const count = panel.querySelector('[data-training-error-count]');
  const correctCount = [...controlAnswers.values()].filter(answer => answer.correct).length;
  if (count) count.textContent = `${correctCount} из 2 правильных ответов`;
}

async function completeOriginalControlStep() {
  const correctCount = [...controlAnswers.values()].filter(answer => answer.correct).length;
  if (completingControlStep || correctCount < 2) return;
  completingControlStep = true;
  for (let index = 0; index < 3; index += 1) {
    const button = document.querySelectorAll('.error-list button')[index];
    if (button && !button.classList.contains('marked')) button.click();
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  completingControlStep = false;
}

function createControlReview(badExample) {
  const panel = document.createElement('section');
  panel.className = 'training-control-review';
  panel.innerHTML = `
    <div class="training-question-label">Что не так с видео?</div>
    <div class="training-answer-pair">
      <button type="button" class="training-error-choice"
        data-training-group="video" data-training-answer="setup-hidden" data-training-correct="true">
        <i>?</i>
        <span>Не показано, как сделан сетап</span>
      </button>
      <button type="button" class="training-error-choice"
        data-training-group="video" data-training-answer="setup-shown" data-training-correct="false">
        <i>?</i>
        <span>Сетап показан полностью</span>
      </button>
    </div>
    <div class="training-map-review">
      <div class="training-map-heading">
        <span>КАРТА</span>
        <strong>Ascent · B Site</strong>
      </div>
      <div class="training-map-stage">
        <img class="training-map-image" src="${ASCENT_MAP}" alt="Карта Ascent, плент B">
        <b class="training-site-label training-site-a">A SITE</b>
        <b class="training-site-label training-site-b">B SITE</b>
      </div>
    </div>
    <div class="training-question-label">Что не так со схемой?</div>
    <div class="training-answer-pair">
      <button type="button" class="training-error-choice"
        data-training-group="map" data-training-answer="abilities-correct" data-training-correct="false">
        <i>?</i>
        <span>Способности расставлены правильно</span>
      </button>
      <button type="button" class="training-error-choice"
        data-training-group="map" data-training-answer="abilities-wrong" data-training-correct="true">
        <i>?</i>
        <span>Неправильно расставлены способности</span>
      </button>
    </div>
    <div class="training-error-count" data-training-error-count>0 из 2 правильных ответов</div>
  `;

  const map = panel.querySelector('.training-map-stage');
  map.append(
    createAbilityMarker('ability2', 'Турель', 26, 36),
    createAbilityMarker('ability1', 'Тревогобот', 62, 37),
    createAbilityMarker('grenade', 'Нанорой', 42, 65),
    createAbilityMarker('grenade', 'Нанорой', 73, 72),
  );

  panel.querySelectorAll('[data-training-answer]').forEach(button => {
    button.addEventListener('click', () => {
      controlAnswers.set(button.dataset.trainingGroup, {
        id: button.dataset.trainingAnswer,
        correct: button.dataset.trainingCorrect === 'true',
      });
      syncControlReview(panel);
      completeOriginalControlStep();
    });
  });
  badExample.after(panel);
  syncControlReview(panel);
}

function enhanceTraining() {
  createDefenseFormVideoGuide();
  const completion = document.querySelector('.completion');
  if (completion) {
    addTrainingReturnAction(completion);
    completion.closest('.content')?.classList.add('training-complete-layout');
  }

  const agent = document.querySelector('.scenario .agent');
  if (agent && !agent.querySelector('img')) {
    agent.textContent = '';
    const image = document.createElement('img');
    image.src = CYPHER_ICON;
    image.alt = 'Cypher';
    agent.appendChild(image);
  }

  const title = document.querySelector(
    '.form-grid input[placeholder*="B Site Camera"]',
  );
  if (title && !title.dataset.automaticTitle) {
    title.dataset.automaticTitle = 'true';
    setReactInputValue(title, 'B Site Camera and Trapwires');
  }

  const badExample = document.querySelector('.bad-video');
  if (badExample && !badExample.querySelector('video')) {
    const video = document.createElement('video');
    video.src = TRAINING_VIDEO;
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.setAttribute('aria-label', 'Учебный плохой пример');
    badExample.prepend(video);
  }
  if (badExample && !document.querySelector('.training-control-review')) {
    createControlReview(badExample);
  }

  const controlHeading = [...document.querySelectorAll('h1')].find(heading =>
    heading.textContent?.includes('Найди три причины отклонения'),
  );
  if (controlHeading) controlHeading.textContent = 'Найди две причины отклонения';

  document.querySelectorAll('.quality p').forEach(paragraph => {
    if (paragraph.textContent?.includes('Название и описание понятны')) {
      paragraph.textContent = 'Описание материала и шаблон понятны.';
    }
    if (paragraph.textContent?.includes('Заполни название и подробное описание')) {
      paragraph.textContent = 'Выбери шаблон и подробно опиши материал.';
    }
  });
}

const observer = new MutationObserver(enhanceTraining);
observer.observe(document.getElementById('root'), {
  childList: true,
  subtree: true,
});
enhanceTraining();
