import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const YANDEX_CLIENT_ID = (process.env.YANDEX_CLIENT_ID ?? '').replace(/﻿/g, '').trim();
const REDIRECT_URI = 'https://vlineups.ru/api/yandex-callback';

const WEB_RETURN = 'https://vlineups.ru/';

export default function handler(req, res) {
  const state = String(req.query?.state || 'web');

  if (!YANDEX_CLIENT_ID) {
    res.writeHead(302, { Location: `${WEB_RETURN}?yandex_error=service_unavailable` });
    res.end();
    return;
  }

  const url = new URL('https://oauth.yandex.ru/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', YANDEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
}
