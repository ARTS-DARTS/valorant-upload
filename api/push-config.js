function clean(value) {
  return String(value ?? '').replace(/\uFEFF/g, '').trim();
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const appId = clean(process.env.ONESIGNAL_APP_ID);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    enabled: Boolean(appId),
    appId,
  });
}
