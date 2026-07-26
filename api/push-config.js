function clean(value) {
  return String(value ?? '').replace(/\uFEFF/g, '').trim();
}

const PUBLIC_ONESIGNAL_APP_ID = '1703b1a2-73e6-42b5-b788-9437233799ca';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const appId = clean(process.env.ONESIGNAL_APP_ID) || PUBLIC_ONESIGNAL_APP_ID;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    enabled: Boolean(appId),
    appId,
  });
}
