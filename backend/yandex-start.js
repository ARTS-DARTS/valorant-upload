import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { createYandexLinkState } from './yandex-link-state.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const YANDEX_CLIENT_ID = (process.env.YANDEX_CLIENT_ID ?? '').replace(/﻿/g, '').trim();
const REDIRECT_URI = 'https://vlineups.ru/api/yandex-callback';

const WEB_RETURN = 'https://vlineups.ru/';
const ADMIN_RETURN = 'https://arts-darts.github.io/valorant-admin/admin_panel.html';

function initFirebase() {
  if (getApps().length) return;
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

function oauthUrl(state) {
  const url = new URL('https://oauth.yandex.ru/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', YANDEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('force_confirm', 'yes');
  return url.toString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'POST') {
    try {
      if (!YANDEX_CLIENT_ID) return res.status(503).json({ error: 'service_unavailable' });
      if (req.body?.mode !== 'link') return res.status(400).json({ error: 'invalid_mode' });
      const authorization = String(req.headers.authorization || '');
      const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      if (!idToken) return res.status(401).json({ error: 'authentication_required' });
      initFirebase();
      const decoded = await getAuth().verifyIdToken(idToken, true);
      const state = createYandexLinkState(decoded.uid);
      const [, , expiresRaw, nonce] = state.split('.');
      await getFirestore().collection('oauth_link_states').doc(nonce).set({
        uid: decoded.uid,
        provider: 'yandex',
        expires_at: Timestamp.fromMillis(Number(expiresRaw) * 1000),
        consumed: false,
        created_at: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ url: oauthUrl(state) });
    } catch (error) {
      console.warn('Yandex link handshake rejected:', error?.code || error?.message || 'unknown');
      return res.status(401).json({ error: 'invalid_session' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const state = String(req.query?.state || 'web');

  if (!YANDEX_CLIENT_ID) {
    const target = state === 'admin' ? ADMIN_RETURN : WEB_RETURN;
    res.writeHead(302, { Location: `${target}?yandex_error=service_unavailable` });
    res.end();
    return;
  }

  if (state.startsWith('link_') || state.startsWith('link.')) {
    return res.status(400).json({ error: 'signed_link_handshake_required' });
  }
  res.writeHead(302, { Location: oauthUrl(state) });
  res.end();
}
