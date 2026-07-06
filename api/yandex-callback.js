// Yandex OAuth callback: code → Yandex token → user info → Firebase custom token → redirect to app
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

function initFirebase() {
  if (!getApps().length) {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT ?? '').replace(/﻿/g, '').trim();
    if (!raw) {
      throw new Error('Firebase service account env is empty');
    }
    let sa;
    try {
      sa = JSON.parse(raw);
    } catch (e) {
      throw new Error('Firebase service account env is invalid JSON');
    }
    initializeApp({ credential: cert(sa) });
  }
}

const YANDEX_CLIENT_ID     = (process.env.YANDEX_CLIENT_ID     ?? '').replace(/﻿/g, '').trim();
const YANDEX_CLIENT_SECRET = (process.env.YANDEX_CLIENT_SECRET ?? '').replace(/﻿/g, '').trim();
const REDIRECT_URI         = 'https://vlineups.ru/api/yandex-callback';
const APP_SCHEME = 'vlineupapp://yandex';
const WEB_RETURN = 'https://vlineups.ru/';
const ADMIN_RETURN = 'https://arts-darts.github.io/valorant-admin/admin_panel.html';
const PUBLIC_AUTH_ERROR = 'service_unavailable';
const AUTH_EXPIRED_ERROR = 'auth_expired';

// Веб-режим (state=web/admin): возвращаем токен через query-параметр.
function webRedirect(res, params, target = WEB_RETURN) {
  res.writeHead(302, { Location: `${target}?${params}` });
  res.end();
}

function authErrorRedirect(res, webTarget, reason = PUBLIC_AUTH_ERROR) {
  const safeReason = encodeURIComponent(reason || PUBLIC_AUTH_ERROR);
  return webTarget
    ? webRedirect(res, `yandex_error=${safeReason}`, webTarget)
    : appRedirect(res, `${APP_SCHEME}?error=${safeReason}`);
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`${label} returned invalid JSON`, {
      status: response.status,
      length: text.length,
    });
    return {};
  }
}

// Chrome Custom Tab НЕ запускает custom-scheme intent из серверного 302 (нет тела → белый экран).
// Поэтому отдаём HTML с тремя механизмами запуска vlineupapp://:
//   1. meta-refresh  2. JS window.location  3. кликабельная ссылка (гарантированный фоллбэк).
// Любой из них откроет Android-intent → его ловит CallbackActivity (flutter_web_auth_2).
function appRedirect(res, url) {
  const jsUrl   = JSON.stringify(url);
  const attrUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="0;url=${attrUrl}">` +
    `<title>Возврат в приложение</title>` +
    `<style>body{font-family:-apple-system,Roboto,sans-serif;background:#0D0D0D;color:#fff;` +
    `text-align:center;padding-top:80px}a{color:#FF4655;font-size:18px;font-weight:600;` +
    `text-decoration:none;display:inline-block;margin-top:24px;padding:14px 28px;` +
    `border:1px solid #FF4655;border-radius:12px}</style></head>` +
    `<body><p>Возврат в приложение...</p>` +
    `<a href="${attrUrl}">Открыть Vlineups</a>` +
    `<script>window.location.href=${jsUrl};</script>` +
    `</body></html>`
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { code, error } = req.query;
  const state = req.query.state || '';
  const webTarget = state === 'admin' ? ADMIN_RETURN : state === 'web' ? WEB_RETURN : '';

  if (error || !code) {
    console.warn('Yandex auth returned without code:', error || 'no_code');
    return authErrorRedirect(res, webTarget);
  }

  try {
    if (!YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET) {
      console.error('Yandex OAuth env is not configured');
      return authErrorRedirect(res, webTarget);
    }

    // 1. Меняем code на access_token
    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     YANDEX_CLIENT_ID,
        client_secret: YANDEX_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
      }),
    });
    const tokenData = await readJsonResponse(tokenRes, 'Yandex token');
    if (!tokenData.access_token) {
      const isExpiredCode = tokenData?.error === 'invalid_grant' || tokenData?.error === 'bad_verification_code';
      const reason = isExpiredCode ? AUTH_EXPIRED_ERROR : PUBLIC_AUTH_ERROR;
      const logPayload = {
        status: tokenRes.status,
        error: tokenData?.error,
        error_description: tokenData?.error_description,
      };
      if (isExpiredCode) {
        console.warn('Yandex auth code expired or was already used:', logPayload);
      } else {
        console.error('Yandex token error:', logPayload);
      }
      return authErrorRedirect(res, webTarget, reason);
    }

    // 2. Получаем инфо о пользователе
    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { 'Authorization': `OAuth ${tokenData.access_token}` },
    });
    const info = await readJsonResponse(infoRes, 'Yandex profile');
    if (!info?.id) {
      console.error('Yandex profile response is missing id', { status: infoRes.status });
      return authErrorRedirect(res, webTarget);
    }

    const yandexId = String(info.id);
    const email    = info.default_email || `yandex_${yandexId}@yandex.ru`;
    const name     = info.display_name  || info.real_name || `Игрок${yandexId.slice(-4)}`;

    initFirebase();
    const db = getFirestore();

    // Режим привязки: state=link_<firebaseUid>
    if (state.startsWith('link_')) {
      const firebaseUid = state.slice('link_'.length);
      const alreadySnap = await db.collection('users').where('yandex_id', '==', yandexId).limit(1).get();
      if (!alreadySnap.empty) {
        const existingUid = alreadySnap.docs[0].id;
        if (existingUid !== firebaseUid) {
          // Если это автогенерированный пустой аккаунт (yandex_XXX) — очищаем привязку там
          // чтобы переназначить Яндекс ID на настоящий аккаунт пользователя.
          // Если это чужой настоящий аккаунт — возвращаем ошибку.
          if (existingUid.startsWith('yandex_')) {
            await db.collection('users').doc(existingUid).update({
              yandex_id: FieldValue.delete(),
            });
          } else {
            return appRedirect(res, `${APP_SCHEME}?error=yandex_already_linked`);
          }
        }
      }
      await db.collection('users').doc(firebaseUid).update({
        yandex_id:            yandexId,
        yandex_email:         email,
        auth_provider_linked: 'yandex',
      });
      return appRedirect(res, `${APP_SCHEME}?linked=true&yid=${yandexId}`);
    }

    // Проверяем — может уже есть аккаунт с этим yandex_id (soft-link)
    const linkedSnap = await db.collection('users').where('yandex_id', '==', yandexId).limit(1).get();
    let firebaseUid;
    let isNew = false;

    if (!linkedSnap.empty) {
      firebaseUid = linkedSnap.docs[0].id;
      await db.collection('users').doc(firebaseUid).update({ last_seen: FieldValue.serverTimestamp() });
    } else {
      firebaseUid = `yandex_${yandexId}`;
      const ref = db.collection('users').doc(firebaseUid);
      const doc = await ref.get();
      if (!doc.exists) {
        await ref.set({
          uid:              firebaseUid,
          name:             '',
          name_lower:       '',
          yandex_name:      name,
          user_email:       email,
          auth_provider:    'yandex',
          yandex_id:        yandexId,
          needs_nickname:   true,
          created_at:       FieldValue.serverTimestamp(),
          is_banned:        false,
          terms_accepted:   true,
          approved_lineups: 0,
        });
        isNew = true;
      } else {
        await ref.update({ last_seen: FieldValue.serverTimestamp() });
      }
    }

    // 3. Создаём Firebase custom token
    const customToken = await getAuth().createCustomToken(firebaseUid, { yandex_id: yandexId, email, name });

    // 4a. Веб-режим: возвращаем токен на сайт через query-параметр
    if (webTarget) {
      return webRedirect(res,
        `yandex_token=${encodeURIComponent(customToken)}` +
        `&is_new=${isNew}` +
        `&name=${encodeURIComponent(name)}`,
        webTarget
      );
    }

    // 4b. Приложение: HTML+JS редирект на custom scheme (302 не работает в Chrome Custom Tab)
    return appRedirect(res,
      `${APP_SCHEME}?token=${encodeURIComponent(customToken)}` +
      `&is_new=${isNew}` +
      `&email=${encodeURIComponent(email)}` +
      `&name=${encodeURIComponent(name)}` +
      `&yid=${yandexId}`
    );
  } catch (e) {
    console.error('yandex-callback error:', e);
    return authErrorRedirect(res, webTarget);
  }
}
