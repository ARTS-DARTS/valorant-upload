const fallbackVersion = process.env.SITE_DEPLOY_VERSION || 'local-development';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const version = String(process.env.VERCEL_GIT_COMMIT_SHA || fallbackVersion).trim();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({ version });
}
