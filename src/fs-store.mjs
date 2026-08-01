import fs from 'node:fs';
import path from 'node:path';

let writeSeq = 0;

/**
 * Atomically replace a file with a same-directory temporary + rename. Existing
 * permission bits are retained; callers decide whether failures are fatal.
 */
export function atomicWriteFile(filePath, content, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let effectiveMode = mode;
  try { effectiveMode = fs.statSync(filePath).mode & 0o777; } catch { /* new file */ }
  const tmp = `${filePath}.tmp-${process.pid}-${writeSeq++}`;
  try {
    fs.writeFileSync(tmp, content, { mode: effectiveMode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* no temp to clean */ }
    throw err;
  }
}
