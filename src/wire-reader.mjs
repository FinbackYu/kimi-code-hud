import fs from 'node:fs';
import crypto from 'node:crypto';

export const WIRE_READ_BUDGET_BYTES = 1024 * 1024;
export const MAIN_WIRE_SLICE_BYTES = 256 * 1024;
export const BACKFILL_WIRE_SLICE_BYTES = 512 * 1024;
export const AGENT_WIRE_SLICE_BYTES = 128 * 1024;
export const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;

const TAIL_DIGEST_BYTES = 32;
const TAIL_DIGEST_RE = /^[0-9a-f]{64}$/;

function isTailDigest(value) {
  return typeof value === 'string' && TAIL_DIGEST_RE.test(value);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Fixed-length irreversible fingerprint of the bytes before a raw offset. */
export function wireTailDigest(filePath, offset) {
  if (!Number.isFinite(offset) || offset <= 0) return null;
  const len = Math.min(TAIL_DIGEST_BYTES, offset);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, offset - len);
    return sha256Hex(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

/** Detect in-place truncate-and-regrow, which inode/size checks cannot see. */
export function wireTailMatches(filePath, bucket) {
  if (!bucket.tailDigest || bucket.offset <= 0) return true;
  try { return wireTailDigest(filePath, bucket.offset) === bucket.tailDigest; } catch { return false; }
}

/**
 * Upgrade one persisted reader cursor from the legacy content-bearing format
 * (pendingBase64 tail buffer + raw tailMarker) to the content-free shape, in
 * place. The legacy pending bytes are never restored from the cache: the
 * committed offset is rewound to the record's start and the bytes are dropped,
 * so the next read recovers the record from the source wire. The legacy raw
 * tail marker is dropped; the next wire read re-establishes the digest.
 */
export function upgradeReaderCursor(reader) {
  if (Object.prototype.hasOwnProperty.call(reader, 'pendingBase64')) {
    let pendingLen = 0;
    if (typeof reader.pendingBase64 === 'string' && reader.pendingBase64) {
      // Transient in-memory decode to size the rewind; never persisted.
      pendingLen = Buffer.from(reader.pendingBase64, 'base64').length;
    }
    delete reader.pendingBase64;
    // The legacy writer committed its offset past the pending bytes, so the
    // record start sits exactly one pendingLen before the saved offset.
    if (pendingLen > 0 && Number.isFinite(reader.offset) && pendingLen <= reader.offset) {
      reader.offset -= pendingLen;
    }
  }
  delete reader.tailMarker;
  if (!isTailDigest(reader.tailDigest)) reader.tailDigest = null;
  return reader;
}

/**
 * Advance one persisted wire cursor, committing the offset only at complete
 * newline-terminated records so no wire content is ever persisted: an
 * incomplete record is left in the source file (the cursor parks at its start)
 * and is re-read next frame, an over-long record (beyond
 * MAX_PARTIAL_LINE_BYTES) is skipped under the persisted discardingLine flag
 * so it cannot re-read the same span every frame, and the bytes before the
 * committed offset are represented by a fixed-length sha256 digest only.
 *
 * `maxBytes` bounds ordinary streaming and discard-skipping reads. Completing
 * one record may exceed the slice through a single bounded scan of at most
 * MAX_PARTIAL_LINE_BYTES from the record's start — the in-frame replacement
 * for the former cross-frame pending buffer — so `bytesRead` (committed
 * bytes) can legitimately pass the slice for that frame. While the host is
 * mid-record the cursor makes no progress and `bytesRead` is 0.
 */
export function readBoundedWire(filePath, bucket, fileSize, maxBytes) {
  let sliceLeft = Math.max(0, Math.floor(maxBytes));
  if (
    sliceLeft <= 0 ||
    (fileSize - bucket.offset <= 0 && !bucket.discardingLine)
  ) {
    return { text: '', bytesRead: 0 };
  }
  const parts = [];
  let committed = 0;
  const fd = fs.openSync(filePath, 'r');
  const readAt = (start, len) => {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, read);
  };
  const reDigest = () => {
    if (bucket.offset <= 0) {
      bucket.tailDigest = null;
      return;
    }
    const len = Math.min(TAIL_DIGEST_BYTES, bucket.offset);
    bucket.tailDigest = sha256Hex(readAt(bucket.offset - len, len));
  };
  try {
    for (;;) {
      if (bucket.discardingLine) {
        const available = fileSize - bucket.offset;
        const len = Math.min(available, sliceLeft);
        if (available <= 0 || len <= 0) break;
        const chunk = readAt(bucket.offset, len);
        if (!chunk.length) break;
        const nl = chunk.indexOf(0x0a);
        const advance = nl >= 0 ? nl + 1 : chunk.length;
        bucket.offset += advance;
        committed += advance;
        sliceLeft -= advance;
        reDigest();
        if (nl >= 0) bucket.discardingLine = false;
        continue;
      }
      const available = fileSize - bucket.offset;
      if (available <= 0 || sliceLeft <= 0) break;
      const want = Math.min(available, sliceLeft);
      const chunk = readAt(bucket.offset, want);
      if (!chunk.length) break;
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl + 1));
        bucket.offset += nl + 1;
        committed += nl + 1;
        sliceLeft -= nl + 1;
        reDigest();
        continue;
      }
      if (bucket.offset + chunk.length >= fileSize) break; // host mid-record
      // The record spans past the slice: complete it with one bounded scan
      // so a large-but-legal record still parses without any cross-frame
      // content buffer.
      let scanned = chunk;
      let parsed = false;
      while (scanned.length < MAX_PARTIAL_LINE_BYTES) {
        const scanAvailable = fileSize - bucket.offset - scanned.length;
        if (scanAvailable <= 0) break; // EOF: record still incomplete
        const take = Math.min(scanAvailable, MAX_PARTIAL_LINE_BYTES - scanned.length);
        const buf = readAt(bucket.offset + scanned.length, take);
        if (!buf.length) break;
        scanned = Buffer.concat([scanned, buf]);
        const found = scanned.indexOf(0x0a, scanned.length - buf.length);
        if (found >= 0) {
          parts.push(scanned.subarray(0, found + 1));
          bucket.offset += found + 1;
          committed += found + 1;
          sliceLeft -= found + 1;
          reDigest();
          parsed = true;
          break;
        }
      }
      if (parsed) continue;
      if (scanned.length >= MAX_PARTIAL_LINE_BYTES) {
        // Over-long record: persist only discard progress, never content.
        bucket.discardingLine = true;
        bucket.offset += scanned.length;
        committed += scanned.length;
        sliceLeft -= scanned.length;
        reDigest();
        continue;
      }
      break; // EOF inside an incomplete record
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    text: parts.length ? Buffer.concat(parts).toString('utf8') : '',
    bytesRead: committed,
  };
}
