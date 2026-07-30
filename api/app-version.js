import { adminFirestore } from './_lib/firebase-admin.js';

export function createAppVersionHandler({ firestore = adminFirestore } = {}) {
  return async function appVersionHandler(req, res) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    try {
      const snapshot = await firestore()
        .collection('settings')
        .doc('app_version')
        .get();
      const data = snapshot.data() || {};
      return res.status(200).json({
        latest_version: String(data.latest_version || '').trim(),
        min_version: String(data.min_version || '').trim(),
      });
    } catch (error) {
      console.error('app-version error:', error);
      return res.status(503).json({ error: 'version_check_unavailable' });
    }
  };
}

export default createAppVersionHandler();
