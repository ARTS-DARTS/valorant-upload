export const VIDEO_VIEWER_MIN_ZOOM = 1;
export const VIDEO_VIEWER_MAX_ZOOM = 4;

export function clampVideoViewerZoom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return VIDEO_VIEWER_MIN_ZOOM;
  return Math.max(VIDEO_VIEWER_MIN_ZOOM, Math.min(VIDEO_VIEWER_MAX_ZOOM, number));
}

export function clampVideoViewerPan(panX, panY, scale, width, height) {
  const safeScale = clampVideoViewerZoom(scale);
  if (safeScale <= VIDEO_VIEWER_MIN_ZOOM) return { panX: 0, panY: 0 };
  const maxX = Math.max(0, Number(width || 0) * (safeScale - 1) / 2);
  const maxY = Math.max(0, Number(height || 0) * (safeScale - 1) / 2);
  return {
    panX: Math.max(-maxX, Math.min(maxX, Number(panX || 0))),
    panY: Math.max(-maxY, Math.min(maxY, Number(panY || 0))),
  };
}

export function zoomVideoViewerAtPoint(state, nextScale, point, size) {
  const scale = clampVideoViewerZoom(state?.scale);
  const zoom = clampVideoViewerZoom(nextScale);
  const width = Math.max(0, Number(size?.width || 0));
  const height = Math.max(0, Number(size?.height || 0));
  if (zoom <= VIDEO_VIEWER_MIN_ZOOM || !width || !height) {
    return { scale: VIDEO_VIEWER_MIN_ZOOM, panX: 0, panY: 0 };
  }
  const ratio = zoom / scale;
  const cursorX = Number(point?.x ?? width / 2) - width / 2;
  const cursorY = Number(point?.y ?? height / 2) - height / 2;
  const pan = clampVideoViewerPan(
    cursorX - (cursorX - Number(state?.panX || 0)) * ratio,
    cursorY - (cursorY - Number(state?.panY || 0)) * ratio,
    zoom,
    width,
    height,
  );
  return { scale: zoom, ...pan };
}
