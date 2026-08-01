import fs from 'node:fs';

export const WIRE_READ_BUDGET_BYTES = 1024 * 1024;
export const MAIN_WIRE_SLICE_BYTES = 256 * 1024;
export const BACKFILL_WIRE_SLICE_BYTES = 512 * 1024;
export const AGENT_WIRE_SLICE_BYTES = 128 * 1024;
export const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;

const MARKER_BYTES = 32;

/** Fingerprint the bytes immediately before a raw reader offset. */
export function wireTailMarker(filePath, offset) {
  if (!Number.isFinite(offset) || offset <= 0) return null;
  const len = Math.min(MARKER_BYTES, offset);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, offset - len);
    return buf.subarray(0, read).toString('base64');
  } finally {
    fs.closeSync(fd);
  }
}

/** Detect in-place truncate-and-regrow, which inode/size checks cannot see. */
export function wireTailMatches(filePath, bucket) {
  if (!bucket.tailMarker || bucket.offset <= 0) return true;
  try { return wireTailMarker(filePath, bucket.offset) === bucket.tailMarker; } catch { return false; }
}

function pendingBuffer(bucket) {
  if (!bucket.pendingBase64) return Buffer.alloc(0);
  try { return Buffer.from(bucket.pendingBase64, 'base64'); } catch { return Buffer.alloc(0); }
}

/**
 * Read at most maxBytes and advance the raw byte offset even when the final
 * JSONL row is incomplete. The trailing bytes are persisted as base64, which
 * keeps split UTF-8 code points lossless across status-line processes.
 */
export function readBoundedWire(filePath, bucket, fileSize, maxBytes) {
  const available = Math.max(0, fileSize - bucket.offset);
  const len = Math.min(available, Math.max(0, Math.floor(maxBytes)));
  if (len === 0) return { text: '', bytesRead: 0 };

  const fd = fs.openSync(filePath, 'r');
  let chunk;
  try {
    chunk = Buffer.alloc(len);
    const read = fs.readSync(fd, chunk, 0, len, bucket.offset);
    chunk = chunk.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  const bytesRead = chunk.length;
  bucket.offset += bytesRead;
  bucket.tailMarker = wireTailMarker(filePath, bucket.offset);

  if (bucket.discardingLine) {
    const newline = chunk.indexOf(0x0a);
    if (newline < 0) return { text: '', bytesRead };
    bucket.discardingLine = false;
    chunk = chunk.subarray(newline + 1);
  }

  const pending = pendingBuffer(bucket);
  const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const complete = [];
  let lineStart = 0;
  let newline = combined.indexOf(0x0a);
  while (newline >= 0) {
    if (newline - lineStart <= MAX_PARTIAL_LINE_BYTES) {
      complete.push(combined.subarray(lineStart, newline + 1));
    }
    lineStart = newline + 1;
    newline = combined.indexOf(0x0a, lineStart);
  }
  const trailing = combined.subarray(lineStart);
  if (trailing.length > MAX_PARTIAL_LINE_BYTES) {
    bucket.pendingBase64 = '';
    bucket.discardingLine = true;
  } else {
    bucket.pendingBase64 = trailing.toString('base64');
  }
  return {
    text: complete.length ? Buffer.concat(complete).toString('utf8') : '',
    bytesRead,
  };
}
