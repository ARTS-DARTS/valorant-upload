const params = new URLSearchParams(location.search);
document.querySelectorAll('[data-course]').forEach(link => {
  const url = new URL(link.href);
  url.searchParams.set('category', link.dataset.course);
  for (const key of ['uid', 'return']) {
    const value = params.get(key);
    if (value) url.searchParams.set(key, value);
  }
  link.href = url;
  const uid = params.get('uid') || 'guest';
  const complete = Boolean(localStorage.getItem(`vl_category_training_${uid}_${link.dataset.course}`));
  const status = document.createElement('span');
  status.className = `course-status ${complete ? 'complete' : 'pending'}`;
  status.textContent = complete ? '✓ ПРОЙДЕН' : '○ НЕ ПРОЙДЕН';
  link.appendChild(status);
});

const returnPath = params.get('return');
const siteLink = document.createElement('a');
siteLink.className = 'site-return';
siteLink.href = returnPath?.startsWith('/') && !returnPath.startsWith('//') ? returnPath : '/';
siteLink.textContent = '← ВЕРНУТЬСЯ НА САЙТ';
document.querySelector('.select-brand')?.appendChild(siteLink);
