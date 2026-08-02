export const MAX_FREEZE_ANNOTATION_STROKES = 40;
export const MAX_FREEZE_ANNOTATION_POINTS = 240;

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function roundCoordinate(value) {
  return Math.round(clamp01(value) * 10000) / 10000;
}

function normalizePoint(point) {
  return {
    x: roundCoordinate(point?.x),
    y: roundCoordinate(point?.y),
  };
}

function normalizeColor(value) {
  const color = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : '#00d4ff';
}

export function normalizeFreezeAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FREEZE_ANNOTATION_STROKES).flatMap(raw => {
    const type = raw?.type === 'line' ? 'line' : 'brush';
    const points = Array.isArray(raw?.points)
      ? raw.points.slice(0, type === 'line' ? 2 : MAX_FREEZE_ANNOTATION_POINTS).map(normalizePoint)
      : [];
    if (!points.length) return [];
    if (type === 'line' && points.length === 1) points.push({ ...points[0] });
    return [{
      type,
      color: normalizeColor(raw?.color),
      width: Math.round(Math.max(0.0015, Math.min(0.03, Number(raw?.width || 0.006))) * 10000) / 10000,
      points,
    }];
  });
}

export function createFreezeAnnotation({ type = 'brush', color = '#00d4ff', width = 0.006, point } = {}) {
  const normalizedPoint = normalizePoint(point);
  return normalizeFreezeAnnotations([{
    type,
    color,
    width,
    points: type === 'line' ? [normalizedPoint, normalizedPoint] : [normalizedPoint],
  }])[0];
}

export function updateFreezeAnnotation(annotation, point, minDistance = 0.0015) {
  if (!annotation || !Array.isArray(annotation.points)) return false;
  const next = normalizePoint(point);
  if (annotation.type === 'line') {
    annotation.points[1] = next;
    return true;
  }
  if (annotation.points.length >= MAX_FREEZE_ANNOTATION_POINTS) return false;
  const previous = annotation.points[annotation.points.length - 1];
  if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < minDistance) return false;
  annotation.points.push(next);
  return true;
}

export function drawFreezeAnnotations(ctx, value, width, height) {
  if (!ctx || !width || !height) return;
  const annotations = normalizeFreezeAnnotations(value);
  annotations.forEach(annotation => {
    const points = annotation.points;
    const strokeWidth = Math.max(1, annotation.width * width);
    const isDot = points.length === 1 || (
      points.length === 2 &&
      points[0].x === points[1].x &&
      points[0].y === points[1].y
    );
    ctx.save();
    ctx.strokeStyle = annotation.color;
    ctx.fillStyle = annotation.color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (isDot) {
      ctx.beginPath();
      ctx.arc(points[0].x * width, points[0].y * height, strokeWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x * width, points[0].y * height);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * width, points[i].y * height);
      }
      ctx.stroke();
    }
    ctx.restore();
  });
}
