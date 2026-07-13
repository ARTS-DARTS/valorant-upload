// Yandex OAuth callback: code → Yandex token → user info → Firebase custom token → redirect to app
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyYandexLinkState } from './yandex-link-state.js';

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
const WEB_ACCOUNT_MISSING_ERROR = 'web_account_missing';
const WEB_PROFILE_INCOMPLETE_ERROR = 'web_profile_incomplete';

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

function hasUsableNickname(data = {}) {
  const name = String(data.name || data.username || data.displayName || '').trim();
  const lower = String(data.name_lower || '').trim();
  return Boolean(name && lower);
}

const USER_SCHEMA_VERSION = 2;

function yandexIdentityId(yandexId) {
  return `yandex__${String(yandexId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

async function resolveYandexUid(db, yandexId) {
  const identity = await db.collection('auth_identities').doc(yandexIdentityId(yandexId)).get();
  if (identity.exists && identity.get('uid')) return String(identity.get('uid'));
  const links = await db.collection('user_auth_links').where('yandex_id', '==', yandexId).limit(1).get();
  if (!links.empty) return links.docs[0].id;
  const legacy = await db.collection('users').where('yandex_id', '==', yandexId).limit(1).get();
  return legacy.empty ? null : legacy.docs[0].id;
}

async function consumeLinkState(db, linkState) {
  const stateRef = db.collection('oauth_link_states').doc(linkState.nonce);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(stateRef);
    if (!snapshot.exists) return false;
    const data = snapshot.data() || {};
    const expiresAt = data.expires_at?.toMillis?.() || 0;
    if (
      data.uid !== linkState.uid ||
      data.provider !== 'yandex' ||
      data.consumed === true ||
      expiresAt < Date.now()
    ) return false;
    tx.delete(stateRef);
    return true;
  });
}

async function writeYandexLibrary(db, { uid, yandexId, email, name = '', isNew = false }) {
  const now = FieldValue.serverTimestamp();
  const identityRef = db.collection('auth_identities').doc(yandexIdentityId(yandexId));
  await db.runTransaction(async tx => {
    const identity = await tx.get(identityRef);
    const ownerUid = identity.exists ? String(identity.get('uid') || '') : '';
    if (ownerUid && ownerUid !== uid) throw new Error('yandex_identity_conflict');
    tx.set(identityRef, {
      uid, provider: 'yandex', subject: yandexId, updated_at: now,
      ...(isNew ? { created_at: now } : {}),
      schema_version: USER_SCHEMA_VERSION,
    }, { merge: true });
  });
  const batch = db.batch();
  batch.set(db.collection('user_private').doc(uid), {
    uid, contact_email: email, auth_email: email, updated_at: now,
    ...(isNew ? { created_at: now, terms_accepted: true } : {}),
    schema_version: USER_SCHEMA_VERSION,
  }, { merge: true });
  batch.set(db.collection('user_auth_links').doc(uid), {
    uid, yandex_id: yandexId, yandex_email: email, yandex_linked: true,
    yandex_linked_at: now, primary_provider: 'yandex', updated_at: now,
    ...(isNew ? { created_at: now } : {}),
    schema_version: USER_SCHEMA_VERSION,
  }, { merge: true });
  if (isNew) {
    batch.set(db.collection('user_stats').doc(uid), {
      uid, display_name: name, approved_lineups: 0, approved_lineups_count: 0,
      bonus_lineups: 0, bonus_points: 0, progress_points: 0,
      total_likes: 0, total_likes_received: 0, duel_wins: 0, level: 1,
      created_at: now, updated_at: now, schema_version: USER_SCHEMA_VERSION,
    }, { merge: true });
  }
  await batch.commit();
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

    // Режим привязки использует только короткоживущий HMAC-signed state,
    // выданный после проверки Firebase ID token в /api/yandex-start.
    const linkState = state.startsWith('link.') ? verifyYandexLinkState(state) : null;
    if (state.startsWith('link.') && !linkState) {
      return appRedirect(res, `${APP_SCHEME}?error=invalid_link_state`);
    }
    if (linkState) {
      const firebaseUid = linkState.uid;
      const firebaseUser = await getAuth().getUser(firebaseUid);
      if (firebaseUser.disabled || !(await consumeLinkState(db, linkState))) {
        return appRedirect(res, `${APP_SCHEME}?error=invalid_link_state`);
      }
      const existingUid = await resolveYandexUid(db, yandexId);
      if (existingUid) {
        if (existingUid !== firebaseUid) {
          // Если это автогенерированный пустой аккаунт (yandex_XXX) — очищаем привязку там
          // чтобы переназначить Яндекс ID на настоящий аккаунт пользователя.
          // Если это чужой настоящий аккаунт — возвращаем ошибку.
          if (existingUid.startsWith('yandex_')) {
            const cleanup = db.batch();
            cleanup.set(db.collection('users').doc(existingUid), { yandex_id: FieldValue.delete() }, { merge: true });
            cleanup.set(db.collection('user_auth_links').doc(existingUid), {
              yandex_id: FieldValue.delete(), yandex_email: FieldValue.delete(),
              yandex_linked: false, updated_at: FieldValue.serverTimestamp(),
            }, { merge: true });
            cleanup.delete(db.collection('auth_identities').doc(yandexIdentityId(yandexId)));
            await cleanup.commit();
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
      await writeYandexLibrary(db, { uid: firebaseUid, yandexId, email, name });
      return appRedirect(res, `${APP_SCHEME}?linked=true&yid=${yandexId}`);
    }

    // Проверяем — может уже есть аккаунт с этим yandex_id (soft-link)
    const linkedUid = await resolveYandexUid(db, yandexId);
    let firebaseUid;
    let isNew = false;

    if (linkedUid) {
      firebaseUid = linkedUid;
      const linkedDoc = await db.collection('users').doc(firebaseUid).get();
      const linkedData = linkedDoc.data() || {};
      if (webTarget && !hasUsableNickname(linkedData)) {
        return authErrorRedirect(res, webTarget, WEB_PROFILE_INCOMPLETE_ERROR);
      }
      const activity = db.batch();
      activity.set(db.collection('users').doc(firebaseUid), { last_seen: FieldValue.serverTimestamp() }, { merge: true });
      activity.set(db.collection('user_stats').doc(firebaseUid), {
        uid: firebaseUid, last_seen_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
        schema_version: USER_SCHEMA_VERSION,
      }, { merge: true });
      await activity.commit();
      await writeYandexLibrary(db, { uid: firebaseUid, yandexId, email, name });
    } else {
      if (webTarget) {
        return authErrorRedirect(res, webTarget, WEB_ACCOUNT_MISSING_ERROR);
      }
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
          schema_version: USER_SCHEMA_VERSION,
        });
        await writeYandexLibrary(db, { uid: firebaseUid, yandexId, email, name, isNew: true });
        isNew = true;
      } else {
        await ref.set({
          yandex_id: yandexId,
          yandex_email: email,
          auth_provider: 'yandex',
          last_seen: FieldValue.serverTimestamp(),
          schema_version: USER_SCHEMA_VERSION,
        }, { merge: true });
        await writeYandexLibrary(db, { uid: firebaseUid, yandexId, email, name });
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
