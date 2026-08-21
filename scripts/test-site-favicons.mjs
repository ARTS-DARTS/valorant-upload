import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pages = [
  'index.html',
  'delete-account.html',
  'privacy_policy.html',
  'offer.html',
  'partners.html',
  'payment-success.html',
  'payment-fail.html',
  'lineups/index.html',
  'rewards/index.html',
  'upload-redesign-preview/index.html',
  'author-training/index.html',
  'author-training/lineups/index.html',
  'author-training/combo/index.html',
  'author-training/defense/index.html',
  'author-training/wallbang/index.html',
];

test('every standalone site page declares a favicon', () => {
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(html, /<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i, `${page} has no favicon`);
  }
});

