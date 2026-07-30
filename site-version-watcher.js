const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;

function hideBanner(banner) {
  banner?.classList.remove('show');
}

function updateVersionLabel(data, liveVersion) {
  const versionLabel = document.getElementById('site-update');
  if (!versionLabel) return;
  const deployedAt = data?.deployedAt ? new Date(data.deployedAt) : null;
  const validDate = deployedAt && !Number.isNaN(deployedAt.getTime());
  const stamp = validDate
    ? `${deployedAt.toLocaleDateString('ru-RU')} ${deployedAt.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' })}`
    : 'время неизвестно';
  versionLabel.textContent = `${liveVersion.slice(0, 7)} | ${stamp}`;
  versionLabel.title = `Версия ${liveVersion.slice(0, 7)} · обновлено ${stamp}`;
}

export function initSiteVersionWatcher({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  beforeReload = null,
  onUpdate = null,
} = {}) {
  const banner = document.getElementById('site-update-banner');
  const reloadButton = document.getElementById('btn-reload-site');
  let loadedVersion = '';
  let checking = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(`/api/site-version?site_version=${Date.now()}`, {
        cache:'no-store',
        headers:{ 'Cache-Control':'no-cache' },
      });
      if (!response.ok) return;
      const data = await response.json();
      const liveVersion = String(data?.version || '').trim();
      if (!liveVersion) return;
      updateVersionLabel(data, liveVersion);
      window.__vlLiveVersion = liveVersion;
      if (!loadedVersion) {
        loadedVersion = liveVersion;
        hideBanner(banner);
        return;
      }
      const changed = liveVersion !== loadedVersion;
      const wasVisible = banner?.classList.contains('show');
      banner?.classList.toggle('show', changed);
      if (changed && !wasVisible) onUpdate?.(liveVersion);
    } catch (_) {
      // A temporary network failure must not interrupt the current page.
    } finally {
      checking = false;
    }
  }

  reloadButton?.addEventListener('click', async () => {
    if (beforeReload && await beforeReload() === false) return;
    hideBanner(banner);
    const url = new URL(window.location.href);
    url.searchParams.set('site_refresh', `${window.__vlLiveVersion || loadedVersion || 'latest'}_${Date.now()}`);
    window.location.assign(url.toString());
    setTimeout(() => window.location.reload(), 250);
  });

  check();
  const timer = window.setInterval(check, pollIntervalMs);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once:true });
  return { check };
}
