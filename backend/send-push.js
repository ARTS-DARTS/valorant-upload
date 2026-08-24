// Vercel serverless: proxies OneSignal push notifications (browser → server → OneSignal)
// Env vars required: ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY

import {
  adminRequestError,
  applyAdminCors,
  requireAdminRequest,
} from './_lib/admin-auth.js';
import { adminMessaging } from './_lib/firebase-admin.js';

function clean(value) {
  return String(value ?? '').replace(/﻿/g, '').trim();
}

export const GOOGLE_PLAY_URL =
  'https://play.google.com/store/apps/details?id=com.artsdarts.valorantlineups';

export function externalUrlForNotification(type) {
  return clean(type) === 'force_update' ? GOOGLE_PLAY_URL : '';
}

export function createSendPushHandler({ auth, db, messaging = adminMessaging() } = {}) {
  return async function handler(req, res) {
    try {
      applyAdminCors(req, res);
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
      const adminRequest = await requireAdminRequest(req, { auth, db });
      const firestore = db || adminRequest.db;

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
      const externalUrl = externalUrlForNotification(payload.data.type);
      if (externalUrl) payload.app_url = externalUrl;

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
      if (!osRes.ok || !targetUid || Number(data.recipients || 0) > 0) {
        return res.status(osRes.status).json(data);
      }

      // Some existing Android accounts have a valid Firebase token but were
      // never linked to a OneSignal external_id. Do not silently report a
      // successful personal push with zero recipients: fall back to FCM.
      const user = await firestore.collection('users').doc(targetUid).get();
      const fcmToken = clean(user.data()?.fcm_token);
      if (!fcmToken) return res.status(osRes.status).json(data);
      try {
        const fcmId = await messaging.send({
          token: fcmToken,
          notification: { title: clean(title), body: clean(body) },
          data: Object.fromEntries(Object.entries({
            ...extraData,
            type: type || extraData.type || 'admin_message',
          }).map(([key, value]) => [key, String(value ?? '')])),
          android: { priority: 'high' },
        });
        return res.status(200).json({
          ...data,
          recipients: 1,
          provider: 'fcm_fallback',
          fcm_id: fcmId,
        });
      } catch (fcmError) {
        console.warn('send-push FCM fallback failed:', fcmError?.code || fcmError?.message || fcmError);
        return res.status(osRes.status).json({ ...data, fcm_fallback_error: true });
      }
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
