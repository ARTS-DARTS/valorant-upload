import test from 'node:test';
import assert from 'node:assert/strict';

import {
  migrateVideoEditToProjectV3,
  projectV3DurationSeconds,
  projectV3HasEdits,
  stableVideoItemId,
} from '../video_project_v3.mjs';

test('v2 migration creates deterministic real clips on a microsecond timebase', () => {
  const legacy = { trimStart:2, trimEnd:10, splits:[5, 7], effectTracks:1, audio:{ muted:false, volume:1 } };
  const first = migrateVideoEditToProjectV3(legacy, 12);
  const second = migrateVideoEditToProjectV3(legacy, 12);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 3);
  assert.deepEqual(first.sequence.clips.map(clip => [clip.sourceStartUs, clip.sourceEndUs]), [
    [2_000_000, 5_000_000],
    [5_000_000, 7_000_000],
    [7_000_000, 10_000_000],
  ]);
  assert.equal(projectV3DurationSeconds(first), 8);
  assert.equal(projectV3HasEdits(first), true);
});

test('legacy items without ids receive stable ids instead of random ids', () => {
  const item = { at:2.5, outputAt:3, duration:2, name:'Impact' };
  assert.equal(stableVideoItemId('zoom', item, 0), stableVideoItemId('zoom', item, 0));
  assert.notEqual(stableVideoItemId('zoom', item, 0), stableVideoItemId('zoom', item, 1));
});

test('untouched full-duration video is not reported as edited', () => {
  const project = migrateVideoEditToProjectV3({ trimStart:0, trimEnd:12, audio:{ muted:false, volume:1 } }, 12);
  assert.equal(projectV3HasEdits(project), false);
});

test('freeze frames extend project duration and shift following clips', () => {
  const project = migrateVideoEditToProjectV3({
    trimStart:2,
    trimEnd:10,
    splits:[5],
    freezeFrames:[{ at:5, duration:2 }],
  }, 12);
  assert.equal(projectV3DurationSeconds(project), 10);
  assert.equal(project.sequence.clips[1].timelineStartUs, 5_000_000);
  assert.equal(project.tracks.layers.find(item => item.kind === 'freeze').timelineStartUs, 3_000_000);
});
