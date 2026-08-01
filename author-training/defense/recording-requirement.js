const requirement = 'Видео записано в 1920×1080 (Full HD) с качеством игры по умолчанию';

function showRecordingRequirement() {
  const checklist = document.querySelector('#root .checklist');
  if (!checklist || checklist.querySelector('[data-full-hd-requirement]')) return;

  const item = document.createElement('button');
  item.type = 'button';
  item.disabled = true;
  item.className = 'checked';
  item.dataset.fullHdRequirement = 'true';
  item.setAttribute('role', 'note');
  item.innerHTML = `<i>!</i><span>${requirement}</span>`;
  checklist.prepend(item);
}

new MutationObserver(showRecordingRequirement).observe(document.getElementById('root'), {
  childList: true,
  subtree: true,
});
showRecordingRequirement();
