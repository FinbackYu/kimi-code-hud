import fs from 'node:fs';
import path from 'node:path';

let writeSeq = 0;

/**
 * Atomically replace a file with a same-directory temporary + rename. Existing
 * permission bits are retained by default; callers may explicitly force the
 * requested mode without inspecting or following the existing target.
 */
export function atomicWriteFile(
  filePath,
  content,
  { mode = 0o600, preserveMode = true } = {},
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let effectiveMode = mode;
  if (preserveMode) {
    try { effectiveMode = fs.statSync(filePath).mode & 0o777; } catch { /* new file */ }
  }
  const tmp = `${filePath}.tmp-${process.pid}-${writeSeq++}`;
  try {
    fs.writeFileSync(tmp, content, { mode: effectiveMode });
    if (!preserveMode) fs.chmodSync(tmp, effectiveMode);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* no temp to clean */ }
    throw err;
  }
}
