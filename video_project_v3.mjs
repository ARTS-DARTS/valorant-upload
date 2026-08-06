const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const ticks = value => Math.max(0, Math.round(finite(value) * 1_000_000));
const seconds = value => Math.max(0, finite(value) / 1_000_000);

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function stableVideoItemId(kind, item = {}, index = 0) {
  if (item?.id) return String(item.id);
  const signature = [
    kind,
    index,
    ticks(item?.at),
    ticks(item?.outputAt),
    ticks(item?.duration),
    item?.url || '',
    item?.name || '',
  ].join('|');
  return `${kind}_${hashText(signature)}`;
}

export function migrateVideoEditToProjectV3(editValue = {}, sourceDuration = 0) {
  const edit = editValue && typeof editValue === 'object' ? editValue : {};
  const duration = Math.max(0, finite(sourceDuration, finite(edit.trimEnd)));
  const trimStart = clamp(edit.trimStart, 0, duration || Number.MAX_SAFE_INTEGER);
  const trimEnd = duration
    ? clamp(finite(edit.trimEnd, duration) || duration, trimStart, duration)
    : Math.max(trimStart, finite(edit.trimEnd));
  const cuts = [...new Set([
    trimStart,
    ...(Array.isArray(edit.splits) ? edit.splits : []),
    trimEnd,
  ].map(value => clamp(value, trimStart, trimEnd)).filter(value => value >= trimStart && value <= trimEnd))]
    .sort((a, b) => a - b);
  const clips = [];
  const freezes = (Array.isArray(edit.freezeFrames) ? edit.freezeFrames : [])
    .map((item, index) => ({ ...item, id:stableVideoItemId('freeze', item, index) }))
    .filter(item => finite(item.at) >= trimStart && finite(item.at) <= trimEnd)
    .sort((a, b) => finite(a.at) - finite(b.at));
  const freezeDurationBefore = sourceTime => freezes.reduce((total, item) => (
    finite(item.at) <= sourceTime ? total + Math.max(0.2, finite(item.duration, 2)) : total
  ), 0);
  const sourceToTimeline = sourceTime => Math.max(0, finite(sourceTime) - trimStart) + freezeDurationBefore(sourceTime);
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const sourceStart = cuts[index];
    const sourceEnd = cuts[index + 1];
    if (sourceEnd - sourceStart < 0.000001) continue;
    clips.push({
      id:`clip_${ticks(sourceStart)}_${ticks(sourceEnd)}`,
      sourceStartUs:ticks(sourceStart),
      sourceEndUs:ticks(sourceEnd),
      timelineStartUs:ticks(sourceToTimeline(sourceStart)),
      enabled:true,
    });
  }

  const layer = (kind, item, index) => ({
    id:stableVideoItemId(kind, item, index),
    kind,
    sourceAtUs:ticks(item?.at),
    timelineStartUs:ticks(Number.isFinite(Number(item?.outputAt)) ? item.outputAt : sourceToTimeline(item?.at)),
    durationUs:ticks(Math.max(0.2, finite(item?.duration, 2))),
    track:Math.max(0, Math.floor(finite(item?.track))),
    payload:{ ...item, id:undefined, at:undefined, outputAt:undefined, duration:undefined, track:undefined },
  });
  const layers = [
    ...freezes.map((item, index) => layer('freeze', {
      ...item,
      outputAt:Math.max(0, finite(item.at) - trimStart) + freezes
        .filter(other => finite(other.at) < finite(item.at))
        .reduce((total, other) => total + Math.max(0.2, finite(other.duration, 2)), 0),
    }, index)),
    ...(Array.isArray(edit.zoomKeyframes) ? edit.zoomKeyframes : []).map((item, index) => layer('zoom', item, index)),
    ...(Array.isArray(edit.footageOverlays) ? edit.footageOverlays : []).map((item, index) => layer('footage', item, index)),
  ].sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.track - b.track || a.id.localeCompare(b.id));

  return {
    schemaVersion:3,
    timebase:1_000_000,
    revision:Math.max(0, Math.floor(finite(edit.revision))),
    source:{ durationUs:ticks(duration), width:1920, height:1080 },
    sequence:{
      clips,
      durationUs:ticks(Math.max(0, trimEnd - trimStart) + freezes.reduce(
        (total, item) => total + Math.max(0.2, finite(item.duration, 2)),
        0,
      )),
    },
    tracks:{ count:Math.max(1, Math.floor(finite(edit.effectTracks, 1))), layers },
    audio:{ muted:!!edit.audio?.muted, volume:clamp(edit.audio?.volume ?? 1, 0, 2) },
    confirmation:{
      status:edit.confirmation?.status === 'confirmed' ? 'confirmed' : 'pending',
      confirmedRevision:Number.isFinite(Number(edit.confirmation?.confirmedRevision))
        ? Math.max(0, Math.floor(Number(edit.confirmation.confirmedRevision)))
        : null,
      confirmedAt:Number.isFinite(Number(edit.confirmation?.confirmedAt)) ? Number(edit.confirmation.confirmedAt) : null,
    },
  };
}

export function projectV3HasEdits(projectValue = {}) {
  const project = projectValue && typeof projectValue === 'object' ? projectValue : {};
  const clips = project.sequence?.clips || [];
  const sourceDuration = Math.max(0, finite(project.source?.durationUs));
  const onlyClip = clips.length === 1 ? clips[0] : null;
  const clipChanged = clips.length > 1 || (onlyClip && (
    finite(onlyClip.sourceStartUs) > 0 || finite(onlyClip.sourceEndUs) < sourceDuration
  ));
  return !!(
    clipChanged || (project.tracks?.layers || []).length ||
    project.audio?.muted || finite(project.audio?.volume, 1) !== 1
  );
}

export function projectV3DurationSeconds(projectValue = {}) {
  return seconds(projectValue?.sequence?.durationUs);
}
