import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIsoBmffDuration } from '../video_metadata_core.mjs';

function box(type, payload) {
  const bytes = new Uint8Array(8 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  [...type].forEach((char, index) => { bytes[4 + index] = char.charCodeAt(0); });
  bytes.set(payload, 8);
  return bytes;
}

test('reads duration from an ISO BMFF mvhd version 0 box', () => {
  const mvhdPayload = new Uint8Array(20);
  const view = new DataView(mvhdPayload.buffer);
  view.setUint32(12, 1000);
  view.setUint32(16, 140000);
  const moov = box('moov', box('mvhd', mvhdPayload));
  assert.equal(parseIsoBmffDuration(moov.buffer), 140);
});

test('returns zero for an unsupported or damaged container', () => {
  assert.equal(parseIsoBmffDuration(new Uint8Array([1, 2, 3]).buffer), 0);
  assert.equal(parseIsoBmffDuration(new Uint8Array(16).buffer), 0);
});
