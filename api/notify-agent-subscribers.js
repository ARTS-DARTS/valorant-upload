import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function clean(value) {
  return (value ?? '').replace(/п»ї/g, '').trim();
}

function initFirebase() {
  if (getApps().length) return;
  const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

function agentSubDocId(agent) {
  return String(agent || '')
    .trim()
    .replace(/\//g, '_')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

async function sendOneSignal({ translations, targetUid, data }) {
  const appId = clean(process.env.ONESIGNAL_APP_ID);
  const restKey = clean(process.env.ONESIGNAL_REST_KEY);
  if (!appId || !restKey) throw new Error('OneSignal is not configured');

  const payload = {
    app_id: appId,
    headings: Object.fromEntries(Object.entries(translations).map(([locale, text]) => [locale, text.title])),
    contents: Object.fromEntries(Object.entries(translations).map(([locale, text]) => [locale, text.body])),
    data,
    priority: 10,
    include_aliases: { external_id: [targetUid] },
    target_channel: 'push',
  };

  const osRes = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await osRes.json().catch(() => ({}));
  if (!osRes.ok) {
    throw new Error(result.error || (result.errors ?? []).join(', ') || `OneSignal ${osRes.status}`);
  }
  return result;
}

function agentNotificationTranslations(agent, map) {
  return {
    ru: { title: 'Поступили новые лайнапы!', body: `На ${agent} вышел 1 лайнап на карте ${map}` },
    en: { title: 'New lineups are available!', body: `A new ${agent} lineup is available on ${map}` },
    tr: { title: 'Yeni lineup yayınlandı!', body: `${map} haritasında ${agent} için yeni bir lineup yayınlandı` },
    es: { title: '¡Hay nuevos lineups!', body: `Hay un nuevo lineup de ${agent} en ${map}` },
    pt: { title: 'Novos lineups disponíveis!', body: `Há um novo lineup de ${agent} em ${map}` },
  };
}

async function findSubscriberUids(db, agent) {
  const uids = new Set();

  const subId = agentSubDocId(agent);
  const usersSnap = await db.collection('users').select().get();
  const checks = usersSnap.docs.map(async (userDoc) => {
    const subSnap = await db
      .collection('users')
      .doc(userDoc.id)
      .collection('subscriptions')
      .doc(subId)
      .get();
    if (!subSnap.exists) return;
    const data = subSnap.data() || {};
    if (data.type === 'agent' && String(data.agent || '').toLowerCase() === String(agent).toLowerCase()) {
      uids.add(userDoc.id);
    }
  });
  await Promise.all(checks);
  if (uids.size > 0) return [...uids];

  try {
    const groupSnap = await db
      .collectionGroup('subscriptions')
      .where('type', '==', 'agent')
      .where('agent', '==', agent)
      .get();
    groupSnap.docs.forEach((subDoc) => {
      const uid = subDoc.ref.parent.parent?.id;
      if (uid) uids.add(uid);
    });
  } catch (e) {
    console.warn('subscription collectionGroup skipped:', e.message);
  }
  return [...uids];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminKey = req.headers['x-admin-key'];
  const secret = clean(process.env.ADMIN_SECRET);
  if (!adminKey || adminKey !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { lineup = {} } = req.body || {};
  const agent = lineup.agent || lineup.agent_name || lineup.agentName || '';
  const map = lineup.map || lineup.map_name || lineup.mapName || '';
  const lineupId = lineup.id || lineup.lineup_id || '';
  const lineupTitle = lineup.title || '';
  if (!agent || !map || !lineupId) {
    return res.status(400).json({ error: 'lineup.id, lineup.agent and lineup.map are required' });
  }

  initFirebase();
  const db = getFirestore();
  const uids = await findSubscriberUids(db, agent);
  if (!uids.length) {
    return res.status(200).json({ ok: true, subscribers: 0, notified: 0 });
  }

  const translations = agentNotificationTranslations(agent, map);

  for (let i = 0; i < uids.length; i += 450) {
    const batch = db.batch();
    for (const uid of uids.slice(i, i + 450)) {
      batch.set(db.collection('users').doc(uid).collection('notifications').doc(), {
        type: 'new_lineups_batch',
        lineup_id: lineupId,
        agent,
        map,
        maps: [map],
        total: 1,
        title: lineupTitle,
        body: translations.ru.body,
        translations,
        created_at: FieldValue.serverTimestamp(),
        read: false,
      });
    }
    await batch.commit();
  }

  const pushResults = await Promise.allSettled(
    uids.map((uid) =>
      sendOneSignal({
        translations,
        targetUid: uid,
        data: {
          type: 'new_lineups_batch',
          lineup_id: lineupId,
          agent,
          map,
          total: '1',
        },
      }),
    ),
  );
  const sent = pushResults.filter((r) => r.status === 'fulfilled').length;
  const failed = pushResults.length - sent;

  return res.status(200).json({
    ok: true,
    subscribers: uids.length,
    notified: uids.length,
    push_sent: sent,
    push_failed: failed,
  });
}
