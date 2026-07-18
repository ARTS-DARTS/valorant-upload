// Vercel serverless: proxies OneSignal push notifications (browser → server → OneSignal)
// Env vars required: ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY, ADMIN_SECRET

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const clean    = s => (s ?? '').replace(/﻿/g, '').trim();
  const adminKey = req.headers['x-admin-key'];
  const secret   = clean(process.env.ADMIN_SECRET);
  if (!adminKey || adminKey !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { title, body, translations, type, targetUid, data: extraData = {} } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });

  const localized = normalizeTranslations(translations, title, body);

  const OS_APP_ID  = clean(process.env.ONESIGNAL_APP_ID);
  const OS_REST    = clean(process.env.ONESIGNAL_REST_KEY);

  const payload = {
    app_id:   OS_APP_ID,
    headings: Object.fromEntries(Object.entries(localized).map(([locale, text]) => [locale, text.title])),
    contents: Object.fromEntries(Object.entries(localized).map(([locale, text]) => [locale, text.body])),
    data:     { ...extraData, type: type || extraData.type || 'admin_message' },
    priority: 10,
  };

  if (targetUid) {
    payload.include_aliases = { external_id: [targetUid] };
    payload.target_channel  = 'push';
  } else {
    payload.included_segments = ['All'];
  }

  const osRes = await fetch('https://api.onesignal.com/notifications', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Key ${OS_REST}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await osRes.json().catch(() => ({}));
  return res.status(osRes.status).json(data);
}

function normalizeTranslations(value, fallbackTitle, fallbackBody) {
  const locales = ['ru', 'en', 'tr', 'es', 'pt'];
  const source = value && typeof value === 'object' ? value : {};
  const russian = source.ru && typeof source.ru === 'object' ? source.ru : {};
  const ruTitle = clean(russian.title) || clean(fallbackTitle);
  const ruBody = clean(russian.body) || clean(fallbackBody);
  return Object.fromEntries(locales.map((locale) => {
    const item = source[locale] && typeof source[locale] === 'object' ? source[locale] : {};
    return [locale, {
      title: clean(item.title) || ruTitle,
      body: clean(item.body) || ruBody,
    }];
  }));
}
