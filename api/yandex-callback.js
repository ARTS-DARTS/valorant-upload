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
const APP_SCHEME           = 'vlineupapp://yandex';

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${APP_SCHEME}?error=${encodeURIComponent(error || 'no_code')}`);
  }

  try {
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
      return res.redirect(`${APP_SCHEME}?error=token_failed`);
    }

    // 2. Получаем инфо о пользователе
    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { 'Authorization': `OAuth ${tokenData.access_token}` },
    });
    const info = await infoRes.json();

    const yandexId  = String(info.id);
    const email     = info.default_email || `yandex_${yandexId}@yandex.ru`;
    const name      = info.display_name  || info.real_name || `Игрок${yandexId.slice(-4)}`;
    const firebaseUid = `yandex_${yandexId}`;

    // 3. Создаём Firebase custom token
    initFirebase();
    const customToken = await getAuth().createCustomToken(firebaseUid, {
      yandex_id: yandexId,
      email,
      name,
    });

    // 4. Создаём/обновляем документ пользователя в Firestore
    const db  = getFirestore();
    const ref = db.collection('users').doc(firebaseUid);
    const doc = await ref.get();
    if (!doc.exists) {
      // Новый пользователь — создаём документ
      await ref.set({
        uid:            firebaseUid,
        name,
        name_lower:     name.toLowerCase(),
        user_email:     email,
        auth_provider:  'yandex',
        yandex_id:      yandexId,
        created_at:     FieldValue.serverTimestamp(),
        is_banned:      false,
        terms_accepted: true,
        approved_lineups: 0,
      });
    } else {
      await ref.update({ last_seen: FieldValue.serverTimestamp() });
    }

    const isNew = !doc.exists;

    // 5. Редиректим в приложение
    return res.redirect(
      `${APP_SCHEME}?token=${encodeURIComponent(customToken)}` +
      `&is_new=${isNew}` +
      `&email=${encodeURIComponent(email)}` +
      `&name=${encodeURIComponent(name)}` +
      `&yid=${yandexId}`
    );
  } catch (e) {
    console.error('yandex-callback error:', e);
    return res.redirect(`${APP_SCHEME}?error=${encodeURIComponent(e.message)}`);
  }
}
