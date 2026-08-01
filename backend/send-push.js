// Vercel serverless: proxies OneSignal push notifications (browser → server → OneSignal)
// Env vars required: ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY

import {
  adminRequestError,
  applyAdminCors,
  requireAdminRequest,
} from './_lib/admin-auth.js';

function clean(value) {
  return String(value ?? '').replace(/﻿/g, '').trim();
}

export function createSendPushHandler({ auth, db } = {}) {
  return async function handler(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
      await requireAdminRequest(req, { auth, db });

      const {
    title,
    body,
    translations,
    type,
    targetUid,
    requiredTag,
    minAndroidVersionCode,
    maxAndroidVersionCode,
    data: extraData = {},
      } = req.body || {};
      if (!title || !body) return res.status(400).json({ error:'title and body required' });

      const localized = await normalizeTranslations(translations, title, body);

      const OS_APP_ID = clean(process.env.ONESIGNAL_APP_ID);
      const OS_REST = clean(process.env.ONESIGNAL_REST_KEY);

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
      } else if (requiredTag || type === 'duel') {
    const allowedTags = new Set(['duel_notifications']);
    const tag = clean(requiredTag || 'duel_notifications');
    if (!allowedTags.has(tag)) return res.status(400).json({ error: 'Unsupported notification audience' });
    payload.filters = [
      { field: 'tag', key: tag, relation: '=', value: '1' },
    ];
      } else if (minAndroidVersionCode || maxAndroidVersionCode) {
    payload.filters = [
      ...(minAndroidVersionCode
        ? [{ field: 'app_version', relation: '>', value: clean(minAndroidVersionCode) }]
        : []),
      ...(minAndroidVersionCode && maxAndroidVersionCode
        ? [{ operator: 'AND' }]
        : []),
      ...(maxAndroidVersionCode
        ? [{ field: 'app_version', relation: '<', value: clean(maxAndroidVersionCode) }]
        : []),
    ];
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
    } catch (error) {
      return adminRequestError(res, error, 'send-push');
    }
  };
}

export default createSendPushHandler();

async function normalizeTranslations(value, fallbackTitle, fallbackBody) {
  const locales = ['ru', 'en', 'tr', 'es', 'pt'];
  const source = value && typeof value === 'object' ? value : {};
  const russian = source.ru && typeof source.ru === 'object' ? source.ru : {};
  const ruTitle = clean(russian.title) || clean(fallbackTitle);
  const ruBody = clean(russian.body) || clean(fallbackBody);
  const result = { ru: { title: ruTitle, body: ruBody } };
  await Promise.all(locales.filter((locale) => locale !== 'ru').map(async (locale) => {
    const item = source[locale] && typeof source[locale] === 'object' ? source[locale] : {};
    const localizedTitle = clean(item.title);
    const localizedBody = clean(item.body);
    if (localizedTitle && localizedBody) {
      result[locale] = { title: localizedTitle, body: localizedBody };
      return;
    }
    result[locale] = {
      title: await translateFromRussian(ruTitle, locale),
      body: await translateFromRussian(ruBody, locale),
    };
  }));
  return result;
}

async function translateFromRussian(text, targetLocale) {
  if (!text) return text;
  try {
    const query = new URLSearchParams({
      client: 'gtx', sl: 'ru', tl: targetLocale, dt: 't', q: text,
    });
    const response = await fetch(`https://translate.googleapis.com/translate_a/single?${query}`);
    if (!response.ok) return text;
    const payload = await response.json();
    return (payload?.[0] || []).map((part) => part?.[0] || '').join('').trim() || text;
  } catch (_) {
    return text;
  }
}
