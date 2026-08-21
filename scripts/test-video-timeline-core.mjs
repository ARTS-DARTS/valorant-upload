import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  advanceVideoTimelinePlayback,
  buildVideoTimelineSegments,
  outputTimeToScrubberValue,
  outputTimeToSourceTime,
  resolveTimelineSourceDuration,
  scrubberValueToOutputTime,
  sourceTimeToOutputTime,
  videoTimelineActiveFootageAt,
  videoTimelineOutputDuration,
  videoTimelineSegmentAt,
  videoTimelineZoomStateAt,
} from '../video_timeline_core.mjs';

const edit = {
  trimStart:2,
  trimEnd:10,
  freezeFrames:[{ id:'freeze-1', at:5, duration:2 }],
  zoomKeyframes:[{ id:'zoom-1', at:5, outputAt:3, duration:2, scale:1.8 }],
  footageOverlays:[{ id:'footage-1', at:6, outputAt:5, duration:2, url:'/effect.mp4' }],
};

test('shared timeline builds deterministic video and freeze segments', () => {
  assert.deepEqual(
    buildVideoTimelineSegments(edit, 14).map(item => [item.type, item.duration, item.outputStart]),
    [['video', 3, 0], ['freeze', 2, 3], ['video', 5, 5]],
  );
  assert.equal(videoTimelineOutputDuration(edit, 14), 10);
  assert.equal(videoTimelineSegmentAt(edit, 14, 3.5).type, 'freeze');
});

test('shared timeline converts source and output time across freeze frames', () => {
  assert.equal(sourceTimeToOutputTime(edit, 14, 4), 2);
  assert.equal(sourceTimeToOutputTime(edit, 14, 7), 7);
  assert.equal(outputTimeToSourceTime(edit, 14, 4), 5);
  assert.equal(outputTimeToSourceTime(edit, 14, 7), 7);
  assert.equal(sourceTimeToOutputTime(edit, 14, 5), 3);
  assert.equal(outputTimeToSourceTime(edit, 14, 3), 5);
});

test('zoom framing keeps its intentional eased transition', () => {
  const zoomEdit = { trimStart:0, trimEnd:5, zoomKeyframes:[{ at:1, duration:2, scale:2.2 }] };
  assert.equal(videoTimelineZoomStateAt(zoomEdit, 5, 1).mix, 0);
  assert.ok(videoTimelineZoomStateAt(zoomEdit, 5, 1.2).mix > 0);
  assert.equal(videoTimelineZoomStateAt(zoomEdit, 5, 2).mix, 1);
  assert.equal(videoTimelineZoomStateAt(zoomEdit, 5, 3.01).mix, 0);
});

test('shared timeline ignores freeze frames outside the trimmed interval', () => {
  const withOutsideFreeze = { ...edit, freezeFrames:[{ id:'outside', at:1, duration:5 }, ...edit.freezeFrames] };
  assert.equal(videoTimelineOutputDuration(withOutsideFreeze, 14), 10);
  assert.equal(sourceTimeToOutputTime(withOutsideFreeze, 14, 7), 7);
});

test('shared timeline seek conversion is stable and independent from UI reset', () => {
  const sought = scrubberValueToOutputTime(750, 1000, 12);
  assert.equal(sought, 9);
  assert.equal(outputTimeToScrubberValue(sought, 1000, 12), 750);
  assert.equal(scrubberValueToOutputTime(2000, 1000, 12), 12);
});

test('shared timeline playback advances and ends deterministically', () => {
  assert.deepEqual(advanceVideoTimelinePlayback(3, 1500, 10), { outputTime:4.5, ended:false });
  assert.deepEqual(advanceVideoTimelinePlayback(9, 1500, 10), { outputTime:10, ended:true });
});

test('upload editor delegates its player scrubber to the shared timeline core', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /sharedOutputToScrubberValue\(current/);
  assert.match(app, /const targetTime = sharedScrubberToOutputTime\(vidScrubber\.value/);
  assert.match(app, /advanceVideoTimelinePlayback as sharedPlaybackPosition,[\s\S]*from '\.\/video_timeline_core\.mjs/);
  assert.match(app, /const playback = sharedPlaybackPosition\(outputPlaybackStartTime/);
});

test('upload editor requires an explicit confirmed montage revision', async () => {
  const { readFile } = await import('node:fs/promises');
  const [app, html, css] = await Promise.all([
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="edit-confirm"[^>]*>Подтвердить монтаж</);
  assert.match(html, /id="editor-confirm-modal"/);
  assert.match(app, /confirmation:\s*\{\s*status:\s*'pending'/);
  assert.match(app, /videoUrl && videoEditConfirmationState\(\) !== 'confirmed'/);
  assert.match(app, /confirmedRevision:\s*Math\.max\(0, Number\(videoEdit\.revision/);
  assert.match(app, /draft\.videoEdit\?\.footageOverlays\?\.length/);
  assert.match(html, /id="video-player-fullscreen-open"[^>]*aria-label="Видео на весь экран"[^>]*>⛶</);
  assert.match(app, /function setVideoPlayerFullscreen\(open\)/);
  assert.match(css, /\.video-editor\[hidden\]\s*\{\s*display:none !important;/);
  assert.match(css, /#vid-stage:fullscreen \.vid-player\s*\{[^}]*max-height:none;/);
  assert.match(html, /id="video-player-fullscreen-controls"/);
  assert.match(app, /fullscreenVidScrubber\?\.addEventListener\('input'/);
  assert.match(app, /fullscreenVidScrubber\?\.addEventListener\('pointerdown'/);
  assert.match(app, /fullscreenVidScrubber\?\.addEventListener\('pointerup', finishScrubberDrag/);
  assert.match(html, /id="video-player-fullscreen-volume"/);
  assert.match(html, /id="video-editor-fullscreen-open"[^>]*>Открыть редактор</);
  assert.match(app, /function setVideoEditorFullscreen\(open\)/);
});

test('shared timeline resolves cached metadata fallback and effects', () => {
  assert.equal(resolveTimelineSourceDuration(Number.NaN, edit), 10);
  assert.equal(videoTimelineZoomStateAt(edit, 14, 4).mix, 1);
  assert.equal(videoTimelineActiveFootageAt(edit, 14, 6)?.id, 'footage-1');
});

test('explicit clips define playback order and close gaps after ripple deletion', () => {
  const reordered = {
    trimStart:0,
    trimEnd:10,
    clips:[
      { id:'second', sourceStart:5, sourceEnd:10 },
      { id:'first', sourceStart:0, sourceEnd:5 },
    ],
  };
  const segments = buildVideoTimelineSegments(reordered, 10);
  assert.deepEqual(segments.map(item => [item.clipId, item.sourceStart, item.outputStart]), [
    ['second', 5, 0],
    ['first', 0, 5],
  ]);
  assert.equal(outputTimeToSourceTime(reordered, 10, 2), 7);
  assert.equal(sourceTimeToOutputTime(reordered, 10, 2), 7);
  assert.equal(videoTimelineOutputDuration({ ...reordered, clips:[reordered.clips[0]] }, 10), 5);
});

test('freely positioned clips create a real timeline gap', () => {
  const positioned = {
    trimStart:0,
    trimEnd:10,
    clips:[
      { id:'first', sourceStart:0, sourceEnd:5, timelineStart:0 },
      { id:'second', sourceStart:5, sourceEnd:10, timelineStart:8 },
    ],
  };
  const segments = buildVideoTimelineSegments(positioned, 10);
  assert.deepEqual(segments.map(item => [item.type, item.outputStart, item.duration]), [
    ['video', 0, 5],
    ['gap', 5, 3],
    ['video', 8, 5],
  ]);
  assert.equal(videoTimelineOutputDuration(positioned, 10), 13);
  assert.equal(videoTimelineSegmentAt(positioned, 10, 6).type, 'gap');
  assert.equal(outputTimeToSourceTime(positioned, 10, 6), 5);
});

test('upload editor exposes a selection-aware inspector for real timeline items', async () => {
  const { readFile } = await import('node:fs/promises');
  const [app, html, css] = await Promise.all([
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="editor-inspector-title"/);
  assert.match(html, /id="editor-inspector-selection"/);
  assert.match(html, /id="editor-inspector-properties"/);
  assert.match(html, /id="edit-clip-left"/);
  assert.match(html, /id="edit-clip-right"/);
  assert.match(app, /function renderEditorInspectorSelection\(\)/);
  assert.match(app, /selected\?\.type === 'clip'/);
  assert.match(app, /selected\?\.type === 'freeze'/);
  assert.match(app, /selected\?\.type === 'zoom'/);
  assert.match(app, /selected\?\.type === 'footage'/);
  assert.match(app, /function selectedInspectorTarget\(\)/);
  assert.match(app, /data-inspector-field/);
  assert.match(app, /saveVideoEdit\(\{ skipUndo:true \}\)/);
  assert.match(html, /class="video-editor-shortcuts"/);
  assert.match(app, /function splitVideoClipAtPlayhead\(\)/);
  assert.match(app, /activeEditorMode === 'split'[\s\S]*splitVideoClipAt\(sourceTime\)/);
  assert.match(app, /neighborId:sharedBoundary \? neighbor\.id : ''/);
  assert.match(app, /if \(neighbor\) neighbor\.sourceEnd = clip\.sourceStart/);
  assert.match(app, /if \(neighbor\) neighbor\.sourceStart = clip\.sourceEnd/);
  assert.match(app, /timelineDrag\?\.kind === 'clip-reorder'[\s\S]*'moving'/);
  assert.match(app, /function syncKnownVideoDuration\(value\)/);
  assert.match(app, /video\.ondurationchange = finishWhenDurationIsReady/);
  assert.match(app, /e\.code === 'KeyB'/);
  assert.match(app, /data-clip-edge="start"/);
  assert.match(app, /kind:'clip-resize'/);
  assert.match(app, /timelineDrag\.kind === 'clip-resize'/);
  assert.match(app, /kind:'clip-reorder'/);
  assert.match(app, /timelineDrag\.kind === 'clip-reorder'/);
  assert.match(app, /draggedClip\.timelineStart = nextTimelineStart/);
  assert.match(app, /classList\.toggle\('timeline-gap', segment\.type === 'gap'\)/);
  assert.match(html, /id="edit-redo"/);
  assert.match(app, /const VIDEO_EDIT_REDO_KEY/);
  assert.match(app, /function redoVideoEdit\(\)/);
  assert.match(app, /e\.code === 'KeyY'/);
  assert.match(app, /e\.shiftKey && e\.code === 'KeyZ'/);
  assert.match(html, /id="timeline-fit"/);
  assert.match(app, /function fitTimelineToViewport\(\)/);
  assert.match(app, /return Math\.max\(native, known\)/);
  assert.match(app, /const nextDuration = Math\.max\(knownVideoDuration, duration\)/);
  assert.match(app, /async function loadCompleteVideoForEditor\(remoteUrl\)/);
  assert.match(app, /await reader\.read\(\)/);
  assert.match(app, /localVideoPreviewUrl = URL\.createObjectURL\(blob\)/);
  assert.match(app, /loadCompleteVideoForEditor\(d\.videoUrl\)/);
  assert.match(app, /const resumeAt = currentOutputTime\(\);[\s\S]*startOutputPlayback\(resumeAt\)/);
  assert.match(app, /const nextOutputTime = startOutput === null[\s\S]*clearFreezeHold\(\)/);
  assert.match(app, /severity:'error'/);
  assert.match(app, /error\('invalid_clip'/);
  assert.match(app, /error\('effect_outside'/);
  assert.match(app, /error\('orphan_freeze'/);
  assert.match(app, /editorEls\.confirmCommit\.disabled = report\.blocking/);
  assert.match(html, /styles\.css\?v=2026-08-21-readable-type-v1/);
  assert.match(html, /app\.js\?v=2026-08-21-profile-fix-v1/);
  assert.match(app, /function rewardDemandAbilityIcon\(/);
  assert.match(app, /reward-demand-ability-icon/);
  assert.match(app, /function isRealRewardMap\(value\)/);
  assert.match(app, /function setRewardModalOpen\(open\)/);
  assert.match(app, /document\.body\.style\.position = 'fixed'/);
  assert.match(html, /Минимум 1 кадр обязателен/);
  assert.match(app, /Добавь хотя бы один обязательный кадр из видео/);
  assert.match(app, /screenshots\.some\(item => item\.cloudUrl\)/);
  assert.match(app, /editorEls\.editor\.dataset\.mode = activeEditorMode/);
  assert.match(app, /editorEls\.editor\.dataset\.selection = selectedEditorItem\?\.type \|\| 'none'/);
  assert.match(css, /grid-template-columns:82px minmax\(0,1fr\) 340px/);
  assert.match(css, /\.video-editor \.zoom-panel,[\s\S]*order:4/);
  assert.match(css, /\.video-editor\[data-mode="effects"\] \.editor-actions #edit-add-footage/);
  assert.match(css, /\.video-editor-fullscreen \.editor-confirmation[\s\S]*position:sticky/);
  assert.match(css, /\.video-editor \.editor-confirmation \{[\s\S]*?display:flex;[\s\S]*?flex-direction:column;[\s\S]*?align-items:stretch;/);
  assert.match(css, /\.video-editor \.editor-confirm-button \{[\s\S]*?position:static;[\s\S]*?width:100%;/);
  assert.match(app, /const BUILT_IN_FOOTAGE = Object\.freeze\(\[/);
  assert.match(app, /function footageLibraryShell\(/);
  assert.match(app, /data-footage-tab="built-in"/);
  assert.match(app, /function closeFootageLibrary\(\)/);
  for (const name of ['pulse-circle','tactical-scan','target-lock','danger-frame','speed-streaks']) {
    assert.equal(existsSync(new URL(`../assets/footage/${name}.mp4`, import.meta.url)), true);
    assert.equal(existsSync(new URL(`../assets/footage/${name}-preview.mp4`, import.meta.url)), true);
  }
});
