const mapImages = {
  Haven: 'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/splash.png',
  Ascent: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png',
  Bind: 'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/splash.png',
  Split: 'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/splash.png',
  Breeze: 'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/splash.png',
  Fracture: 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/splash.png',
  Pearl: 'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/splash.png',
  Lotus: 'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/splash.png',
  Sunset: 'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/splash.png',
  Icebox: 'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/splash.png',
  Abyss: 'https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/splash.png',
  Corrode: 'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/splash.png',
  Summit: 'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/splash.png',
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
  gallery.className = 'production-map-carousel';
  const availableMaps = [...select.options].map((option) => option.value.trim()).filter((name) => mapImages[name]);
  gallery.innerHTML = `<button class="production-map-arrow previous" type="button" aria-label="Предыдущие карты">‹</button>
    <div class="production-map-gallery">${availableMaps.map((name) =>
    `<button type="button" data-map-name="${name}" style="--map-image:url('${mapImages[name]}')"><span>${name}</span></button>`
  ).join('')}</div>
    <button class="production-map-arrow next" type="button" aria-label="Следующие карты">›</button>`;
  card.appendChild(gallery);
  const track = gallery.querySelector('.production-map-gallery');
  const sync = () => track.querySelectorAll('[data-map-name]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mapName === select.value);
  });
  gallery.addEventListener('click', (event) => {
    const arrow = event.target.closest('.production-map-arrow');
    if (arrow) {
      track.scrollBy({ left: (arrow.classList.contains('next') ? 1 : -1) * Math.max(320, track.clientWidth * .82), behavior: 'smooth' });
      return;
    }
    const button = event.target.closest('[data-map-name]');
    if (!button) return;
    select.value = button.dataset.mapName;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });
  track.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    track.scrollBy({ left: event.deltaY, behavior: 'auto' });
  }, { passive: false });
  select.addEventListener('change', () => {
    sync();
    track.querySelector(`[data-map-name="${CSS.escape(select.value)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  });
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
