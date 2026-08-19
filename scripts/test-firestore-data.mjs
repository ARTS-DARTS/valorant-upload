import assert from 'node:assert/strict';
import test from 'node:test';
import { undefinedPaths, withoutUndefined } from '../firestore-data.mjs';

test('withoutUndefined removes invalid nested Firestore values', () => {
  const sentinel = new (class TimestampSentinel {})();
  const input = {
    title: 'Lineup',
    video_edit: {
      optional: undefined,
      clips: [{ id: 'clip-1', outputAt: undefined }, undefined],
    },
    submitted_at: sentinel,
    nullable: null,
  };

  assert.deepEqual(undefinedPaths(input), [
    'video_edit.optional',
    'video_edit.clips[0].outputAt',
    'video_edit.clips[1]',
  ]);
  assert.deepEqual(withoutUndefined(input), {
    title: 'Lineup',
    video_edit: { clips: [{ id: 'clip-1' }] },
    submitted_at: sentinel,
    nullable: null,
  });
});
