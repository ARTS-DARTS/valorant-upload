const mapImages = {
  Haven: 'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/splash.png',
  Ascent: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png',
  Bind: 'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/splash.png',
  Lotus: 'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/splash.png',
  Sunset: 'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/splash.png',
  Icebox: 'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/splash.png',
};

function findSectionByText(text) {
  return [...document.querySelectorAll('#workspace-upload .section-title')].find((item) => item.textContent.includes(text));
}

function scrollToUploadSection(text) {
  const section = findSectionByText(text);
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function createUploadRail() {
  const upload = document.getElementById('workspace-upload');
  if (!upload || upload.querySelector('.production-flow')) return;
  const rail = document.createElement('aside');
  rail.className = 'production-flow';
  rail.innerHTML = `
    <div class="production-flow-head"><span>НОВЫЙ МАТЕРИАЛ</span><b>РАБОЧИЙ ПРОЦЕСС</b></div>
    <button class="active" data-production-step="КАРТА"><i>1</i><span><b>Основа</b><small>Карта, категория и агент</small></span></button>
    <button data-production-step="ВИДЕО"><i>2</i><span><b>Монтаж</b><small>Видео и захват кадров</small></span></button>
    <button data-production-step="СКРИНШОТЫ"><i>3</i><span><b>Редактор</b><small>Кадры, абилки и карта</small></span></button>
    <button data-production-step="НАЗВАНИЕ"><i>4</i><span><b>Оформление</b><small>Название и шаблон</small></span></button>
    <button data-production-step="submit"><i>5</i><span><b>Проверка</b><small>Готовность к отправке</small></span></button>
    <a href="/author-training/">? Открыть инструктаж</a>`;
  upload.prepend(rail);
  rail.addEventListener('click', (event) => {
    const button = event.target.closest('[data-production-step]');
    if (!button) return;
    rail.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    if (button.dataset.productionStep === 'submit') {
      document.getElementById('stats-sidebar')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    scrollToUploadSection(button.dataset.productionStep);
  });
}

function createMapGallery() {
  const select = document.getElementById('sel-map');
  const card = select?.closest('.card');
  if (!select || !card || card.querySelector('.production-map-gallery')) return;
  const gallery = document.createElement('div');
  gallery.className = 'production-map-gallery';
  gallery.innerHTML = Object.entries(mapImages).map(([name, image]) =>
    `<button type="button" data-map-name="${name}" style="--map-image:url('${image}')"><span>${name}</span></button>`
  ).join('');
  card.appendChild(gallery);
  const sync = () => gallery.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mapName === select.value);
  });
  gallery.addEventListener('click', (event) => {
    const button = event.target.closest('[data-map-name]');
    if (!button) return;
    select.value = button.dataset.mapName;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });
  select.addEventListener('change', sync);
  sync();
}

function improveFrameCapture() {
  const button = document.getElementById('vid-frame-btn');
  if (!button) return;
  button.textContent = '◉ Сделать кадр из видео';
  button.title = 'Останови видео на нужном моменте и нажми, чтобы добавить этот кадр в скриншоты';
  const shots = document.getElementById('shots-row')?.closest('.card');
  if (shots && !shots.querySelector('.production-shot-help')) {
    const help = document.createElement('div');
    help.className = 'production-shot-help';
    help.innerHTML = '<b>Кадры создаются из видео</b><span>Останови ролик на нужном моменте и нажми «Сделать кадр из видео». Также можно добавить готовое изображение кнопкой +.</span>';
    shots.prepend(help);
  }
}

function observeWorkspaceTabs() {
  document.querySelectorAll('.workspace-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.body.dataset.workspaceSection = button.dataset.workspaceTab || '';
    });
  });
  document.body.dataset.workspaceSection = 'upload';
}

window.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('workspace-redesign');
  createUploadRail();
  createMapGallery();
  improveFrameCapture();
  observeWorkspaceTabs();
});
