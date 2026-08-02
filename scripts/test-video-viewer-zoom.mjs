import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  clampVideoViewerZoom,
  zoomVideoViewerAtPoint,
} from '../video-viewer-zoom.mjs';

test('video viewer zoom stays between 100% and 400%', () => {
  assert.equal(clampVideoViewerZoom(-5), 1);
  assert.equal(clampVideoViewerZoom(2.25), 2.25);
  assert.equal(clampVideoViewerZoom(20), 4);
});

test('video viewer zoom keeps the cursor point stable and resets cleanly', () => {
  const zoomed = zoomVideoViewerAtPoint(
    { scale: 1, panX: 0, panY: 0 },
    2,
    { x: 750, y: 250 },
    { width: 1000, height: 500 },
  );
  assert.deepEqual(zoomed, { scale: 2, panX: -250, panY: 0 });
  assert.deepEqual(
    zoomVideoViewerAtPoint(zoomed, 1, { x: 0, y: 0 }, { width: 1000, height: 500 }),
    { scale: 1, panX: 0, panY: 0 },
  );
});

test('upload video player exposes wheel zoom, Z reset, and visible hints', async () => {
  const root = new URL('../', import.meta.url);
  const [app, html, css] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8'),
  ]);
  assert.match(html, /id="video-viewer-viewport"/);
  assert.match(html, /Колесо.*зум/);
  assert.match(html, /<kbd>Z<\/kbd>.*сброс/);
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /e\.code === 'KeyZ'/);
  assert.match(app, /resetVideoViewerZoom/);
  assert.match(css, /\.video-viewer-zoom-hud/);
});
