const params = new URLSearchParams(location.search);
document.querySelectorAll('[data-course]').forEach(link => {
  const url = new URL(link.href);
  url.searchParams.set('category', link.dataset.course);
  for (const key of ['uid', 'return']) {
    const value = params.get(key);
    if (value) url.searchParams.set(key, value);
  }
  link.href = url;
});
