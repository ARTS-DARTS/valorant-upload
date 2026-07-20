import https from 'node:https';

const ALLOWED_HOSTS = new Set([
  'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
  'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
]);

function parseTarget(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const target = new URL(rawUrl);
    return target.protocol === 'https:' && ALLOWED_HOSTS.has(target.hostname) ? target : null;
  } catch (_) {
    return null;
  }
}

function proxyRequest(target, req, res, redirects = 0) {
  const headers = { Accept: req.headers.accept || 'video/*', 'User-Agent': 'vlineups-media-proxy/1.0' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  const upstream = https.request(target, { method: 'GET', headers }, response => {
    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
      const redirected = parseTarget(new URL(response.headers.location, target).href);
      response.resume();
      if (!redirected) return res.status(502).json({ error: 'Media redirect is not allowed' });
      return proxyRequest(redirected, req, res, redirects + 1);
    }
    res.statusCode = response.statusCode || 502;
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(name => {
      if (response.headers[name]) res.setHeader(name, response.headers[name]);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
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

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const target = parseTarget(req.query?.url);
  if (!target) return res.status(400).json({ error: 'Media URL is not allowed' });
  proxyRequest(target, req, res);
}
