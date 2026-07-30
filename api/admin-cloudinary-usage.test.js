import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCloudinaryUsage } from './admin-cloudinary-usage.js';

test('normalizes Cloudinary usage and screenshot count', () => {
  assert.deepEqual(
    normalizeCloudinaryUsage({
      storage:{ usage:52428800, credits_usage:0.05 },
      credits:{ usage:1.5, limit:25, used_percent:6 },
      last_updated:'2026-07-30T12:00:00Z',
    }, 292),
    {
      screenshot_count:292,
      storage_bytes:52428800,
      storage_credits:0.05,
      credits_used:1.5,
      credits_limit:25,
      credits_percent:6,
      updated_at:'2026-07-30T12:00:00Z',
    },
  );
});

test('uses safe zero defaults for a partial response', () => {
  const result = normalizeCloudinaryUsage({}, 0);
  assert.equal(result.screenshot_count, 0);
  assert.equal(result.storage_bytes, 0);
  assert.equal(result.credits_percent, 0);
});
