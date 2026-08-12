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
  const explicitClips = Array.isArray(edit.clips) ? edit.clips : null;
  const clips = (explicitClips || [{ id:'clip_legacy', sourceStart:start, sourceEnd:end }])
    .map((clip, index) => ({
      id:String(clip?.id || `clip_${index}`),
      sourceStart:clampTimelineNumber(clip?.sourceStart, start, end),
      sourceEnd:clampTimelineNumber(clip?.sourceEnd, start, end),
      timelineStart:Number.isFinite(Number(clip?.timelineStart)) ? Math.max(0, Number(clip.timelineStart)) : null,
    }))
    .filter(clip => clip.sourceEnd - clip.sourceStart > 0.000001);
  const segments = [];
  let outputCursor = 0;
  clips.forEach((clip, clipIndex) => {
    const clipOutputStart = Math.max(outputCursor, clip.timelineStart ?? outputCursor);
    if (clipOutputStart > outputCursor + 0.000001) {
      segments.push({
        type:'gap',
        duration:clipOutputStart - outputCursor,
        outputStart:outputCursor,
        sourceAt:clip.sourceStart,
      });
    }
    const clipSegments = [];
    let sourceCursor = clip.sourceStart;
    freezes
      .filter(freeze => freeze.at >= clip.sourceStart && (freeze.at < clip.sourceEnd || (clipIndex === clips.length - 1 && freeze.at <= clip.sourceEnd)))
      .forEach(freeze => {
        if (freeze.at > sourceCursor) {
          clipSegments.push({
            type:'video', clipId:clip.id,
            sourceStart:sourceCursor, sourceEnd:freeze.at,
            duration:freeze.at - sourceCursor,
          });
        }
        clipSegments.push({
          type:'freeze', id:freeze.id, clipId:clip.id,
          sourceAt:freeze.at, duration:freeze.duration,
          annotations:freeze.annotations,
        });
        sourceCursor = freeze.at;
      });
    if (sourceCursor < clip.sourceEnd) {
      clipSegments.push({
        type:'video', clipId:clip.id,
        sourceStart:sourceCursor, sourceEnd:clip.sourceEnd,
        duration:clip.sourceEnd - sourceCursor,
      });
    }
    let localOutput = clipOutputStart;
    clipSegments.forEach(segment => {
      segments.push({ ...segment, outputStart:localOutput });
      localOutput += segment.duration;
    });
    outputCursor = localOutput;
  });
  return segments;
}

export function videoTimelineOutputDuration(editValue = {}, sourceDuration = 0) {
  return buildVideoTimelineSegments(editValue, sourceDuration)
    .reduce((maximum, segment) => Math.max(maximum, segment.outputStart + segment.duration), 0);
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
  const time = finiteNumber(sourceTime);
  const segments = buildVideoTimelineSegments(editValue, sourceDuration);
  const segment = segments.find(item => item.type === 'freeze' && Math.abs(time - item.sourceAt) < 0.000001)
    || segments.find(item => item.type === 'video' && time >= item.sourceStart && time < item.sourceEnd)
    || segments.find(item => item.type === 'video' && Math.abs(time - item.sourceEnd) < 0.000001);
  if (!segment) return 0;
  return segment.type === 'freeze'
    ? segment.outputStart
    : segment.outputStart + clampTimelineNumber(time - segment.sourceStart, 0, segment.duration);
}

export function outputTimeToSourceTime(editValue = {}, sourceDuration = 0, outputTime = 0) {
  const time = Math.max(0, finiteNumber(outputTime));
  const segments = buildVideoTimelineSegments(editValue, sourceDuration);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const local = time - segment.outputStart;
    if (local < 0 || local > segment.duration || (local === segment.duration && index < segments.length - 1)) continue;
    if (segment.type === 'gap') return segment.sourceAt;
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
  // A zoom clip represents a fixed framing choice. Animating its scale made
  // playback look as if the video element itself was still loading/growing.
  return { clip, mix:1 };
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
