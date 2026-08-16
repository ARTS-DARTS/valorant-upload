import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeYandexAdStats } from '../backend/yandex-ad-stats.js';

test('normalizes and aggregates Yandex rows by day and ad format', () => {
  const rows = normalizeYandexAdStats({ result:'ok', data:{ points:[
    { dimensions:{ date:['2026-08-15'], block_type:'App: Баннер' }, measures:[{ hits:100, hits_render:80, shows:60, impressions:64, partner_wo_nds:1.28 }] },
    { dimensions:{ date:['2026-08-15'], block_type:'App: Межстраничная реклама' }, measures:[{ hits:20, hits_render:10, shows:3, impressions:4, partner_wo_nds:2 }] },
    { dimensions:{ date:['2026-08-15'], block_type:'App: Баннер' }, measures:[{ hits:50, hits_render:40, shows:30, impressions:32, partner_wo_nds:0.64 }] },
  ] } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].total, {
    requests:170, matched:130, visible_impressions:93, impressions:100,
    revenue_rub:3.92, fill_rate:76.47, show_rate:76.92,
    visibility_rate:93, ecpm_rub:39.2,
  });
  assert.equal(rows[0].formats.banner.impressions, 96);
  assert.equal(rows[0].formats.banner.revenue_rub, 1.92);
  assert.equal(rows[0].formats.interstitial.ecpm_rub, 500);
});

test('rejects malformed provider response', () => {
  assert.throws(() => normalizeYandexAdStats({ result:'error' }), /invalid_response/);
});
