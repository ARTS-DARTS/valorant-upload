import {
  ReCaptchaEnterpriseProvider,
  initializeAppCheck,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js';

export async function initializePublicAppCheck(app, {
  endpoint = '/api/app-check-config',
  timeoutMs = 4000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) return { enabled: false, reason: `http_${response.status}` };
    const config = await response.json();
    if (!config?.enabled || config.provider !== 'recaptcha_enterprise' || !config.siteKey) {
      return { enabled: false, reason: 'not_configured' };
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    return { enabled: true };
  } catch (error) {
    console.warn('[App Check] Web initialization skipped:', error?.message || error);
    return { enabled: false, reason: error?.name === 'AbortError' ? 'timeout' : 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
}
