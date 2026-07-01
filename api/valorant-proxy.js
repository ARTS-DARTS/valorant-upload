const ALLOWED_HOSTS = new Set(['valorant-api.com', 'media.valorant-api.com']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
