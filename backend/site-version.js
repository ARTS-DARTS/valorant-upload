import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

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

function gitDeploymentTime() {
  try {
    return execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch (_) {
    return '';
  }
}

function fileDeploymentTime() {
  try {
    return statSync(new URL('../app.js', import.meta.url)).mtime.toISOString();
  } catch (_) {
    return '';
  }
}

export const deploymentVersion = String(
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.SITE_DEPLOY_VERSION ||
  gitVersion() ||
  'local-development',
).trim();
export const deploymentTime = String(
  process.env.SITE_DEPLOYED_AT ||
  gitDeploymentTime() ||
  fileDeploymentTime() ||
  '',
).trim();

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    version: deploymentVersion,
    deployedAt: deploymentTime || undefined,
  });
}
