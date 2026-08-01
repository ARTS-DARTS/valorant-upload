(function initVLineupsLoader() {
  const root = document.documentElement;
  root.classList.add('vl-loader-pending');
  let loader = null;
  let longTimer = 0;
  const routeCopy = href => {
    const path = (new URL(href, location.href).pathname.replace(/\/+$/, '') || '/');
    if (path.startsWith('/author-training')) return ['Открываем инструктаж', 'Подготавливаем задания и сохраняемый прогресс'];
    if (path.startsWith('/lineups')) return ['Открываем каталог лайнапов', 'Загружаем доступные материалы и фильтры'];
    if (path.startsWith('/payment')) return ['Переходим к оплате', 'Подготавливаем защищённую страницу платежа'];
    if (path === '/offer' || path === '/offer.html') return ['Открываем условия подписки', 'Загружаем тарифы и условия оплаты'];
    if (path === '/') return ['Возвращаемся на сайт', 'Готовим личный кабинет'];
    return ['Переходим на другую страницу', 'Загружаем нужный раздел'];
  };
  function mount() {
    loader = document.getElementById('site-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'site-loader';
      loader.className = 'site-loader';
      loader.setAttribute('role', 'status');
      loader.setAttribute('aria-live', 'polite');
      loader.innerHTML = '<div class="site-loader__brand">VALORANT <span>LINEUPS</span></div><div class="site-loader__game" aria-hidden="true"><div class="site-loader__pacman"></div><div class="site-loader__dots"><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="site-loader__title">Загрузка сайта</div><div class="site-loader__hint">Готовим страницу и необходимые данные</div><button class="site-loader__retry" type="button">Попробовать снова</button>';
      document.body.prepend(loader);
    }
    loader.querySelector('.site-loader__retry')?.addEventListener('click', () => location.reload(), { once:true });
    return loader;
  }
  function setCopy(title, hint) {
    const node = mount();
    const titleNode = node.querySelector('.site-loader__title');
    const hintNode = node.querySelector('.site-loader__hint');
    if (titleNode) titleNode.textContent = title || 'Загрузка сайта';
    if (hintNode) hintNode.textContent = hint || 'Готовим страницу и необходимые данные';
    node.setAttribute('aria-label', title || 'Загрузка сайта');
  }
  function show(title, hint) {
    window.clearTimeout(longTimer);
    setCopy(title, hint);
    root.classList.add('vl-loader-pending');
    loader.classList.remove('site-loader--hidden', 'site-loader--error');
    longTimer = window.setTimeout(() => {
      const hintNode = loader?.querySelector('.site-loader__hint');
      if (hintNode && !loader.classList.contains('site-loader--hidden')) hintNode.textContent = 'Загрузка занимает больше времени…';
    }, 7000);
  }
  function hide() {
    window.clearTimeout(longTimer);
    root.classList.remove('vl-loader-pending');
    mount().classList.add('site-loader--hidden');
  }
  function fail(message = 'Не удалось загрузить данные. Проверьте соединение и попробуйте снова.') {
    window.clearTimeout(longTimer);
    setCopy('Не удалось открыть страницу', message);
    root.classList.add('vl-loader-pending');
    loader.classList.remove('site-loader--hidden');
    loader.classList.add('site-loader--error');
  }
  window.VLineupsLoader = { show, hide, fail, routeCopy };
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    show(...routeCopy(url.href));
  });
  window.addEventListener('pageshow', event => { if (event.persisted) hide(); });
  const ready = () => {
    mount();
    show(root.dataset.loaderTitle || 'Загрузка сайта', root.dataset.loaderHint || 'Готовим страницу и необходимые данные');
    if (!root.hasAttribute('data-loader-manual')) window.addEventListener('load', hide, { once:true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once:true }); else ready();
  window.setTimeout(() => { if (root.classList.contains('vl-loader-pending')) fail(); }, 20000);
})();

