import { applyAdminCors, requireAdminRequest, adminRequestError } from './_lib/admin-auth.js';

const CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || 'djxgwkbqn').trim();
const API_KEY = String(process.env.CLOUDINARY_API_KEY || '').trim();
const API_SECRET = String(process.env.CLOUDINARY_API_SECRET || '').trim();
const SCREENSHOT_PREFIX = String(process.env.CLOUDINARY_SCREENSHOT_PREFIX || 'lineups_screenshots').trim();

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function cloudinaryGet(path, query = {}, fetchImpl = fetch) {
  if (!API_KEY || !API_SECRET) throw fail(503, 'cloudinary_credentials_missing');
  const url = new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/${path}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const authorization = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  const response = await fetchImpl(url, {
    headers:{ Authorization:`Basic ${authorization}`, Accept:'application/json' },
    signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Cloudinary Admin API error:', response.status, detail.slice(0, 300));
    throw fail(502, 'cloudinary_api_unavailable');
  }
  return response.json();
}

async function countScreenshotResources() {
  let count = 0;
  let nextCursor = '';
  do {
    const page = await cloudinaryGet('resources/image/upload', {
      prefix:SCREENSHOT_PREFIX,
      max_results:500,
      ...(nextCursor ? { next_cursor:nextCursor } : {}),
    });
    count += Array.isArray(page.resources) ? page.resources.length : 0;
    nextCursor = String(page.next_cursor || '');
  } while (nextCursor);
  return count;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeCloudinaryUsage(usage, screenshotCount) {
  const storageBytes = finiteNumber(usage?.storage?.usage);
  const creditsUsed = finiteNumber(usage?.credits?.usage);
  const creditsLimit = finiteNumber(usage?.credits?.limit);
  const creditsPercent = finiteNumber(
    usage?.credits?.used_percent,
    creditsLimit > 0 ? (creditsUsed / creditsLimit) * 100 : 0,
  );
  return {
    screenshot_count:finiteNumber(screenshotCount),
    storage_bytes:storageBytes,
    storage_credits:finiteNumber(usage?.storage?.credits_usage),
    credits_used:creditsUsed,
    credits_limit:creditsLimit,
    credits_percent:Math.min(creditsPercent, 100),
    updated_at:usage?.last_updated || new Date().toISOString(),
  };
}

export default async function adminCloudinaryUsageHandler(req, res) {
  try {
    applyAdminCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error:'method_not_allowed' });
    await requireAdminRequest(req);
    const [usage, screenshotCount] = await Promise.all([
      cloudinaryGet('usage'),
      countScreenshotResources(),
    ]);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(normalizeCloudinaryUsage(usage, screenshotCount));
  } catch (error) {
    return adminRequestError(res, error, 'admin-cloudinary-usage');
  }
}
