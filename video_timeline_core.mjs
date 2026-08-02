const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function clampTimelineNumber(value, min, max) {
  return Math.max(min, Math.min(max, finiteNumber(value)));
}

export function resolveTimelineSourceDuration(mediaDuration, editValue = {}) {
  const media = finiteNumber(mediaDuration);
  if (media > 0) return media;
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const savedEnd = finiteNumber(edit.trimEnd);
  if (savedEnd > 0) return savedEnd;
  const effectEnd = [
    ...(Array.isArray(edit.freezeFrames) ? edit.freezeFrames : []),
    ...(Array.isArray(edit.zoomKeyframes) ? edit.zoomKeyframes : []),
    ...(Array.isArray(edit.footageOverlays) ? edit.footageOverlays : []),
  ].reduce((maximum, item) => Math.max(
    maximum,
    finiteNumber(item?.at) + Math.max(0, finiteNumber(item?.duration)),
  ), 0);
  return effectEnd;
}

export function timelineBounds(editValue = {}, sourceDuration = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const duration = resolveTimelineSourceDuration(sourceDuration, edit);
  const start = clampTimelineNumber(edit.trimStart, 0, duration || Number.MAX_SAFE_INTEGER);
  const requestedEnd = finiteNumber(edit.trimEnd, duration);
  const end = duration
    ? clampTimelineNumber(requestedEnd > 0 ? requestedEnd : duration, start, duration)
    : Math.max(start, requestedEnd);
  return { start, end, duration };
}

export function buildVideoTimelineSegments(editValue = {}, sourceDuration = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const { start, end } = timelineBounds(edit, sourceDuration);
  const freezes = (Array.isArray(edit.freezeFrames) ? edit.freezeFrames : [])
    .map((item, index) => ({
      ...item,
      id:String(item?.id || `freeze_${index}`),
      at:finiteNumber(item?.at),
      duration:clampTimelineNumber(item?.duration || 2, 0.2, 10),
      annotations:Array.isArray(item?.annotations || item?.drawings) ? (item.annotations || item.drawings) : [],
    }))
    .filter(item => item.at >= start && item.at <= end)
    .sort((a, b) => a.at - b.at);
  const segments = [];
  let sourceCursor = start;
  freezes.forEach(freeze => {
    if (freeze.at > sourceCursor) {
      segments.push({
        type:'video',
        sourceStart:sourceCursor,
        sourceEnd:freeze.at,
        duration:freeze.at - sourceCursor,
      });
    }
    segments.push({
      type:'freeze',
      id:freeze.id,
      sourceAt:freeze.at,
      duration:freeze.duration,
      annotations:freeze.annotations,
    });
    sourceCursor = freeze.at;
  });
  if (sourceCursor < end) {
    segments.push({
      type:'video',
      sourceStart:sourceCursor,
      sourceEnd:end,
      duration:end - sourceCursor,
    });
  }
  let outputStart = 0;
  return segments.map(segment => {
    const result = { ...segment, outputStart };
    outputStart += segment.duration;
    return result;
  });
}

export function videoTimelineOutputDuration(editValue = {}, sourceDuration = 0) {
  return buildVideoTimelineSegments(editValue, sourceDuration)
    .reduce((total, segment) => total + segment.duration, 0);
}

export function videoTimelineSegmentAt(editValue, sourceDuration, outputTime) {
  const segments = buildVideoTimelineSegments(editValue, sourceDuration);
  const time = Math.max(0, finiteNumber(outputTime));
  return segments.find((segment, index) => {
    const end = segment.outputStart + segment.duration;
    return time >= segment.outputStart && (time < end || index === segments.length - 1);
  }) || segments.at(-1) || null;
}

export function sourceTimeToOutputTime(editValue = {}, sourceDuration = 0, sourceTime = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const { start, end } = timelineBounds(edit, sourceDuration);
  const source = clampTimelineNumber(sourceTime, start, end);
  let output = Math.max(0, source - start);
  (Array.isArray(edit.freezeFrames) ? edit.freezeFrames : []).forEach(freeze => {
    const at = finiteNumber(freeze?.at);
    if (at >= start && at <= end && at < source) {
      output += clampTimelineNumber(freeze?.duration || 2, 0.2, 10);
    }
  });
  return output;
}

export function outputTimeToSourceTime(editValue = {}, sourceDuration = 0, outputTime = 0) {
  const time = Math.max(0, finiteNumber(outputTime));
  const segments = buildVideoTimelineSegments(editValue, sourceDuration);
  for (const segment of segments) {
    const local = time - segment.outputStart;
    if (local < 0 || local > segment.duration) continue;
    return segment.type === 'freeze' ? segment.sourceAt : segment.sourceStart + local;
  }
  return timelineBounds(editValue, sourceDuration).end;
}

export function videoTimelineEffectOutputStart(item, editValue = {}, sourceDuration = 0) {
  const explicit = Number(item?.outputAt);
  return Number.isFinite(explicit)
    ? Math.max(0, explicit)
    : sourceTimeToOutputTime(editValue, sourceDuration, item?.at || 0);
}

export function videoTimelineZoomStateAt(editValue = {}, sourceDuration = 0, outputTime = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const time = Math.max(0, finiteNumber(outputTime));
  const clip = (Array.isArray(edit.zoomKeyframes) ? edit.zoomKeyframes : [])
    .slice()
    .reverse()
    .find(item => {
      const start = videoTimelineEffectOutputStart(item, edit, sourceDuration);
      const duration = clampTimelineNumber(item?.duration || 2, 0.2, 10);
      return time >= start && time <= start + duration;
    }) || null;
  if (!clip) return { clip:null, mix:0 };
  const start = videoTimelineEffectOutputStart(clip, edit, sourceDuration);
  const duration = clampTimelineNumber(clip.duration || 2, 0.2, 10);
  const local = clampTimelineNumber(time - start, 0, duration);
  const ramp = Math.max(0.08, Math.min(0.4, duration / 2));
  const linear = clampTimelineNumber(Math.min(local / ramp, (duration - local) / ramp), 0, 1);
  return { clip, mix:linear * linear * (3 - 2 * linear) };
}

export function videoTimelineActiveFootageAt(editValue = {}, sourceDuration = 0, outputTime = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const time = Math.max(0, finiteNumber(outputTime));
  return (Array.isArray(edit.footageOverlays) ? edit.footageOverlays : [])
    .slice()
    .reverse()
    .find(item => {
      const start = videoTimelineEffectOutputStart(item, edit, sourceDuration);
      const duration = clampTimelineNumber(item?.duration || 2, 0.2, 60);
      return time >= start && time <= start + duration;
    }) || null;
}

export function scrubberValueToOutputTime(value, maximum, outputDuration) {
  const max = Math.max(1, finiteNumber(maximum, 1000));
  const duration = Math.max(0, finiteNumber(outputDuration));
  return clampTimelineNumber(value, 0, max) / max * duration;
}

export function outputTimeToScrubberValue(outputTime, maximum, outputDuration) {
  const max = Math.max(1, finiteNumber(maximum, 1000));
  const duration = Math.max(0, finiteNumber(outputDuration));
  if (!duration) return 0;
  return Math.round(clampTimelineNumber(outputTime, 0, duration) / duration * max);
}

export function advanceVideoTimelinePlayback(startOutputTime, elapsedMilliseconds, outputDuration) {
  const duration = Math.max(0, finiteNumber(outputDuration));
  const rawTime = Math.max(0, finiteNumber(startOutputTime)) + Math.max(0, finiteNumber(elapsedMilliseconds)) / 1000;
  return {
    outputTime:duration ? Math.min(duration, rawTime) : 0,
    ended:duration <= 0 || rawTime >= duration,
  };
}
