const upload = document.getElementById('upload-zone');
const videoCheck = document.getElementById('video-check');
const score = document.getElementById('score');
const readyTitle = document.getElementById('ready-title');
const progressLabel = document.getElementById('progress-label');

upload.addEventListener('click', () => {
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
  });
});

document.querySelectorAll('.chips button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.chips button').forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
  });
});
