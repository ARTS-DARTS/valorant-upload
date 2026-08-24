function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export default function appCheckConfigHandler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const siteKey = clean(process.env.FIREBASE_APP_CHECK_WEB_SITE_KEY);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    enabled: Boolean(siteKey),
    provider: siteKey ? 'recaptcha_enterprise' : null,
    siteKey: siteKey || null,
  });
}
