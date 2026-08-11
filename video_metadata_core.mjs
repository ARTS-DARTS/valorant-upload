function readUint64(view, offset) {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : 0;
}

function boxType(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function boxDurationSeconds(view, payloadStart, boxEnd) {
  if (payloadStart + 20 > boxEnd) return 0;
  const version = view.getUint8(payloadStart);
  const timescaleOffset = version === 1 ? payloadStart + 20 : payloadStart + 12;
  const durationOffset = timescaleOffset + 4;
  const durationBytes = version === 1 ? 8 : 4;
  if (durationOffset + durationBytes > boxEnd) return 0;
  const timescale = view.getUint32(timescaleOffset);
  const duration = version === 1
    ? readUint64(view, durationOffset)
    : view.getUint32(durationOffset);
  const seconds = timescale > 0 ? duration / timescale : 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function scanBoxes(view, start, end, depth = 0) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = boxType(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return 0;
      size = readUint64(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < headerSize || offset + size > end) return 0;
    const payloadStart = offset + headerSize;
    const boxEnd = offset + size;
    if (type === 'mvhd') return boxDurationSeconds(view, payloadStart, boxEnd);
    if (type === 'moov' && depth < 2) {
      const duration = scanBoxes(view, payloadStart, boxEnd, depth + 1);
      if (duration > 0) return duration;
    }
    offset = boxEnd;
  }
  return 0;
}

export function parseIsoBmffDuration(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return 0;
  try {
    return scanBoxes(new DataView(buffer), 0, buffer.byteLength);
  } catch (_) {
    return 0;
  }
}
