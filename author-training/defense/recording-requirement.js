const requirements = [
  { key: 'full-hd', text: 'Видео записано в 1920×1080 (Full HD)' },
  { key: 'game-quality', text: 'Качество графики в игре — минимум «Среднее»' },
];

function showRecordingRequirement() {
  const checklist = document.querySelector('#root .checklist');
  if (!checklist || checklist.querySelector('[data-recording-requirement]')) return;

  requirements.slice().reverse().forEach(({ key, text }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.disabled = true;
    item.className = 'checked';
    item.dataset.recordingRequirement = key;
    item.setAttribute('role', 'note');
    item.innerHTML = `<i>!</i><span>${text}</span>`;
    checklist.prepend(item);
  });
}

new MutationObserver(showRecordingRequirement).observe(document.getElementById('root'), {
  childList: true,
  subtree: true,
});
showRecordingRequirement();
