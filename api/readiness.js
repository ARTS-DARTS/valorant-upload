import { validateFirebaseAdminServices } from './_lib/firebase-admin.js';

export function createFirebaseReadinessController({
  validate = validateFirebaseAdminServices,
  deployVersion = process.env.SITE_DEPLOY_VERSION,
  requireDeployVersion = process.env.NODE_ENV === 'production',
} = {}) {
  const normalizedVersion = String(deployVersion || '').trim().toLowerCase();
  const versionValid = /^[0-9a-f]{40}$/.test(normalizedVersion);
  let state = 'starting';
  let validationPromise = null;

  async function check() {
    if (validationPromise) return validationPromise;
    if (requireDeployVersion && !versionValid) {
      state = 'not_ready';
      return false;
    }
    state = 'checking';
    validationPromise = (async () => {
      try {
        await validate();
        state = 'ready';
        return true;
      } catch {
        state = 'not_ready';
        return false;
      } finally {
        validationPromise = null;
      }
    })();
    return validationPromise;
  }

  function snapshot() {
    return Object.freeze({
      ready: state === 'ready',
      state,
    });
  }

  function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (state === 'ready') {
      return res.status(200).json({
        ok: true,
        sha: versionValid ? normalizedVersion : 'development',
      });
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ ok: false, status: 'not_ready' });
  }

  return Object.freeze({ check, handler, snapshot });
}

export const firebaseReadiness = createFirebaseReadinessController();
export default firebaseReadiness.handler;
