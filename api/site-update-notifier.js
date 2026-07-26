import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { deploymentTime, deploymentVersion } from './site-version.js';

function clean(value) {
  return String(value ?? '').replace(/\uFEFF/g, '').trim();
}

function initFirebase() {
  if (getApps().length) return;
  const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

async function sendUpdatePush() {
  const appId = clean(process.env.ONESIGNAL_APP_ID);
  const restKey = clean(process.env.ONESIGNAL_REST_KEY);
  if (!appId || !restKey) return { skipped: 'onesignal_not_configured' };

  const response = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify({
      app_id: appId,
      headings: { ru: 'VLineups обновлён', en: 'VLineups updated' },
      contents: {
        ru: 'На сайте появилась новая версия. Откройте, чтобы увидеть изменения.',
        en: 'A new site version is available. Open it to see the changes.',
      },
      filters: [
        { field: 'tag', key: 'site_update_notifications', relation: '=', value: '1' },
      ],
      url: `https://vlineups.ru/?site_refresh=${encodeURIComponent(deploymentVersion)}`,
      data: {
        type: 'site_update',
        version: deploymentVersion,
        deployed_at: deploymentTime,
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || result.errors?.join?.(', ') || `OneSignal ${response.status}`);
  }
  return result;
}

export async function notifySiteUpdateOnce() {
  if (!deploymentVersion || deploymentVersion === 'local-development') {
    return { skipped: 'local_development' };
  }
  initFirebase();
  const db = getFirestore();
  const stateRef = db.collection('system_state').doc('site_update_push');
  const state = await stateRef.get();
  if (clean(state.data()?.version) === deploymentVersion) {
    return { skipped: 'already_sent' };
  }
  const result = await sendUpdatePush();
  if (result?.skipped) return result;
  await stateRef.set({
    version: deploymentVersion,
    deployed_at: deploymentTime || null,
    notified_at: FieldValue.serverTimestamp(),
    recipients: Number(result?.recipients || 0),
  }, { merge: true });
  return { sent: true, recipients: Number(result?.recipients || 0) };
}
