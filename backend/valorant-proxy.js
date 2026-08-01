import https from 'node:https';

const MEDIA_HOSTS = new Set([
  'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
  'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
]);
const ALLOWED_HOSTS = new Set(['valorant-api.com', 'media.valorant-api.com', ...MEDIA_HOSTS]);

function streamMedia(target, req, res, redirects = 0) {
  const headers = { Accept: req.headers.accept || 'video/*', 'User-Agent': 'vlineups-media-proxy/1.0' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  const upstream = https.request(target, { method: 'GET', headers }, response => {
    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
      const redirected = new URL(response.headers.location, target);
      response.resume();
      if (!MEDIA_HOSTS.has(redirected.hostname)) return res.status(502).json({ error: 'Media redirect is not allowed' });
      return streamMedia(redirected, req, res, redirects + 1);
    }
    res.statusCode = response.statusCode || 502;
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(name => {
      if (response.headers[name]) res.setHeader(name, response.headers[name]);
    });
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    response.on('error', error => {
      console.error('media proxy response:', error);
      if (!res.headersSent) res.status(502).json({ error: 'Media stream failed' });
      else res.destroy(error);
    });
    response.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy(new Error('Media upstream timeout')));
  upstream.on('error', error => {
    console.error('media proxy request:', error);
    if (!res.headersSent) res.status(502).json({ error: 'Media upstream unavailable' });
    else res.destroy(error);
  });
  upstream.end();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rawUrl = req.query?.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch (_) {
    return res.status(400).json({ error: 'invalid url' });
  }

  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'host is not allowed' });
  }

  if (MEDIA_HOSTS.has(target.hostname)) return streamMedia(target, req, res);

  const upstream = await fetch(target, {
    headers: {
      'User-Agent': 'vlineups-proxy/1.0',
      Accept: req.headers.accept || '*/*',
    },
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  return res.status(upstream.status).send(body);
}
