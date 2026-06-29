// Yandex OAuth callback: code → Yandex token → user info → Firebase custom token → redirect to app
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse((process.env.FIREBASE_SERVICE_ACCOUNT ?? '').replace(/﻿/g, '').trim());
    initializeApp({ credential: cert(sa) });
  }
}

const YANDEX_CLIENT_ID     = (process.env.YANDEX_CLIENT_ID     ?? '').replace(/﻿/g, '').trim();
const YANDEX_CLIENT_SECRET = (process.env.YANDEX_CLIENT_SECRET ?? '').replace(/﻿/g, '').trim();
const REDIRECT_URI         = 'https://vlineups.ru/api/yandex-callback';
const APP_SCHEME = 'vlineupapp://yandex';

// HTTP 302 на custom scheme: Chrome Custom Tab видит vlineupapp://, закрывается,
// Android возвращает URL в FlutterWebAuth2.authenticate().
function appRedirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { code, error } = req.query;

  if (error || !code) {
    return appRedirect(res, `${APP_SCHEME}?error=${encodeURIComponent(error || 'no_code')}`);
  }

  try {
    const state = req.query.state || '';

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
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Yandex token error:', tokenData);
      return appRedirect(res, `${APP_SCHEME}?error=token_failed`);
    }

    // 2. Получаем инфо о пользователе
    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { 'Authorization': `OAuth ${tokenData.access_token}` },
    });
    const info = await infoRes.json();

    const yandexId = String(info.id);
    const email    = info.default_email || `yandex_${yandexId}@yandex.ru`;
    const name     = info.display_name  || info.real_name || `Игрок${yandexId.slice(-4)}`;

    initFirebase();
    const db = getFirestore();

    // Режим привязки: state=link_<firebaseUid>
    if (state.startsWith('link_')) {
      const firebaseUid = state.slice('link_'.length);
      const alreadySnap = await db.collection('users').where('yandex_id', '==', yandexId).limit(1).get();
      if (!alreadySnap.empty && alreadySnap.docs[0].id !== firebaseUid) {
        return appRedirect(res, `${APP_SCHEME}?error=yandex_already_linked`);
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

    // 4. Редиректим в приложение через HTML (HTTP redirect на custom scheme не работает в Chrome Custom Tab)
    return appRedirect(res,
      `${APP_SCHEME}?token=${encodeURIComponent(customToken)}` +
      `&is_new=${isNew}` +
      `&email=${encodeURIComponent(email)}` +
      `&name=${encodeURIComponent(name)}` +
      `&yid=${yandexId}`
    );
  } catch (e) {
    console.error('yandex-callback error:', e);
    return appRedirect(res, `${APP_SCHEME}?error=${encodeURIComponent(e.message)}`);
  }
}
