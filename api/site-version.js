import { execFileSync } from 'node:child_process';

function gitVersion() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch (_) {
    return '';
  }
}

const deploymentVersion = String(
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.SITE_DEPLOY_VERSION ||
  gitVersion() ||
  'local-development',
).trim();

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({ version: deploymentVersion });
}
