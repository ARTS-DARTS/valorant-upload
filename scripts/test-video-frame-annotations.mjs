import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAX_FREEZE_ANNOTATION_POINTS,
  createFreezeAnnotation,
  drawFreezeAnnotations,
  freezeAnnotationsSvg,
  normalizeFreezeAnnotations,
  updateFreezeAnnotation,
} from '../video-frame-annotations.mjs';

test('serializes drawings as resolution-independent SVG paths and circles', () => {
  const svg = freezeAnnotationsSvg([
    { type:'line', color:'#ff4655', width:0.01, points:[{x:0.1,y:0.2},{x:0.9,y:0.8}] },
    { type:'brush', color:'#ffffff', width:0.006, points:[{x:0.5,y:0.5}] },
  ]);
  assert.match(svg, /<path d="M 100 200 L 900 800"/);
  assert.match(svg, /<circle cx="500" cy="500"/);
});

test('normalizes freeze-frame strokes into bounded relative coordinates', () => {
  const annotations = normalizeFreezeAnnotations([{
    type: 'line',
    color: '#FF4655',
    width: 4,
    points: [{ x: -2, y: 0.25 }, { x: 2, y: 0.75 }],
  }]);
  assert.deepEqual(annotations, [{
    type: 'line',
    color: '#ff4655',
    width: 0.03,
    points: [{ x: 0, y: 0.25 }, { x: 1, y: 0.75 }],
  }]);
});

test('brush sampling is bounded while straight lines keep two endpoints', () => {
  const brush = createFreezeAnnotation({ point: { x: 0.1, y: 0.2 } });
  assert.equal(updateFreezeAnnotation(brush, { x: 0.1001, y: 0.2001 }), false);
  assert.equal(updateFreezeAnnotation(brush, { x: 0.2, y: 0.3 }), true);
  for (let i = 0; i < MAX_FREEZE_ANNOTATION_POINTS + 20; i++) {
    updateFreezeAnnotation(brush, { x: i / 300, y: 0.5 }, 0);
  }
  assert.equal(brush.points.length, MAX_FREEZE_ANNOTATION_POINTS);

  const line = createFreezeAnnotation({ type: 'line', point: { x: 0.2, y: 0.2 } });
  updateFreezeAnnotation(line, { x: 0.8, y: 0.7 });
  assert.deepEqual(line.points, [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.7 }]);
});

test('renders normalized annotations using the target canvas dimensions', () => {
  const calls = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    arc: (...args) => calls.push(['arc', ...args]),
  };
  drawFreezeAnnotations(ctx, [{
    type: 'line', color: '#ffffff', width: 0.01,
    points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.25 }],
  }], 1000, 500);
  assert.deepEqual(calls, [
    ['moveTo', 250, 250],
    ['lineTo', 750, 125],
  ]);
  assert.equal(ctx.lineWidth, 10);
});

test('upload editor persists and previews drawing data on freeze-frame clips', async () => {
  const root = new URL('../', import.meta.url);
  const [app, html, css] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8'),
  ]);
  assert.match(html, /id="freeze-drawing-vector"/);
  assert.match(html, /id="freeze-drawing-canvas"/);
  assert.match(html, /data-freeze-draw-tool="brush"/);
  assert.match(html, /data-freeze-draw-tool="line"/);
  assert.match(app, /annotations: normalizeFreezeAnnotations\(item\.annotations \|\| item\.drawings\)/);
  assert.match(app, /setFreezeOverlay\(freezeFrameImages\.get\(segment\.id\) \|\| '', segment\.id\)/);
  assert.match(app, /previewFreezeForDrawing\(freeze\.id\)/);
  assert.match(css, /\.freeze-drawing-canvas\.interactive \{ pointer-events:auto; \}/);
});
