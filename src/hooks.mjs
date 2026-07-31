// Managed SessionStart hook block in ~/.kimi-code/config.toml.
// The host rewrites tui.toml on some upgrades (wiping [status_line]) but
// preserves config.toml [[hooks]] — observed with the vibe-island managed
// block across the 0.30.0 -> 0.31.0 upgrade. So --install registers a
// SessionStart hook here that re-points tui.toml's status-line command at
// every session start (see hooks/sync-status-line.mjs).
//
// Same marker convention as vibe-island: a START/END comment pair wraps
// our block so we can find, refresh and remove it without a TOML parser.
// Installs that predate the markers left bare [[hooks]] blocks behind;
// those are recognized by their SessionStart command path and adopted or
// removed, so an old hook is never registered twice or left as uninstall
// residue.

const START = '# --- kimi-code-hud hooks START (managed, do not edit) ---';
const END = '# --- kimi-code-hud hooks END ---';

function blockLines(hookCommand) {
  return [
    START,
    '[[hooks]]',
    'event = "SessionStart"',
    `command = "${hookCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    'timeout = 5',
    END,
  ];
}

function findBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === START);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === END) return { start, end: i };
  }
  // Without the END marker the ownership boundary is unknowable. Treat the
  // file as malformed and leave it untouched rather than deleting user config
  // that may follow the dangling START marker.
  return { start, end: null };
}

// The hook script path inside a hook command such as
// 'node /abs/path/hooks/sync-status-line.mjs'; null when there is no path
// to match against.
function hookPathFromCommand(hookCommand) {
  if (typeof hookCommand !== 'string') return null;
  const path = hookCommand.trim().replace(/^node\s+/, '').trim();
  return path === '' ? null : path;
}

// Legacy bare [[hooks]] blocks (written before the marker convention) that
// register our SessionStart hook. A block spans from its [[hooks]] header
// to the next table header or EOF and matches when it sets
// event = "SessionStart" and has a command line containing the hook path.
// The marked block (`exclude`) and anything unrecognized are left alone.
function findBareBlocks(lines, hookPath, exclude) {
  if (!hookPath) return [];
  const escapedPath = hookPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    if (exclude && i >= exclude.start && i <= exclude.end) {
      i = exclude.end + 1;
      continue;
    }
    if (lines[i].trim() !== '[[hooks]]') {
      i++;
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if ((exclude && j === exclude.start) || lines[j].trim().startsWith('[')) {
        end = j;
        break;
      }
    }
    let hasEvent = false;
    let hasCommand = false;
    for (let j = i + 1; j < end; j++) {
      const line = lines[j].trim();
      if (/^event\s*=\s*"SessionStart"\s*$/.test(line)) hasEvent = true;
      if (/^command\s*=\s*"/.test(line) && (line.includes(hookPath) || line.includes(escapedPath))) {
        hasCommand = true;
      }
    }
    if (hasEvent && hasCommand) {
      // Trailing blank lines belong to the separator after the block, not
      // to the block itself, so in-place replacement keeps its spacing.
      let last = end - 1;
      while (last > i && lines[last].trim() === '') last--;
      ranges.push({ start: i, end: last });
    }
    i = end;
  }
  return ranges;
}

// After deleting a block at index i, merge the run of blank lines crossing
// i down to a single separator (or none at the top of the file), so a
// removal never leaves consecutive blank lines behind.
function collapseBlanksAt(lines, i) {
  let lo = i;
  while (lo > 0 && lines[lo - 1].trim() === '') lo--;
  let hi = i;
  while (hi < lines.length && lines[hi].trim() === '') hi++;
  const count = hi - lo;
  if (lo === 0) lines.splice(0, count);
  else if (count > 1) lines.splice(lo, count - 1);
}

// Apply inclusive line ranges ({start, end, replacement?}) bottom-up so no
// edit shifts ranges still to be applied. Ranges without a replacement are
// deletions; their blank-line surroundings are collapsed afterwards.
function applyRanges(lines, ranges) {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  for (const range of sorted) {
    lines.splice(range.start, range.end - range.start + 1, ...(range.replacement || []));
    if (!range.replacement) collapseBlanksAt(lines, range.start);
  }
}

/**
 * Return config.toml content with our SessionStart hook block present.
 * Idempotent; refreshes the block in place when the hook path moved.
 * Legacy unmarked [[hooks]] blocks from early installs are adopted: the
 * first match is upgraded to the marked block in place, the rest removed.
 * @param {string} content existing file content (may be empty)
 * @param {string} hookCommand e.g. 'node /abs/path/hooks/sync-status-line.mjs'
 * @returns {string}
 */
export function ensureHooksBlock(content, hookCommand) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const block = blockLines(hookCommand);
  const found = findBlock(lines);
  if (found && found.end === null) return content;

  const ranges = [];
  const bare = findBareBlocks(lines, hookPathFromCommand(hookCommand), found);
  if (found) {
    ranges.push({ start: found.start, end: found.end, replacement: block });
    for (const b of bare) ranges.push({ start: b.start, end: b.end });
  } else if (bare.length > 0) {
    const [first, ...rest] = bare;
    ranges.push({ start: first.start, end: first.end, replacement: block });
    for (const b of rest) ranges.push({ start: b.start, end: b.end });
  } else {
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  }
  applyRanges(lines, ranges);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.join('\n') + '\n';
  const normalized = (content || '').replace(/\r\n/g, '\n');
  return out === normalized ? content : out;
}

/**
 * Return config.toml content with our hook block removed. Also removes
 * legacy unmarked [[hooks]] blocks whose SessionStart command contains the
 * hook path from hookCommand (when given). No-op when neither is present;
 * other hooks and settings are untouched.
 * @param {string} content
 * @param {string} [hookCommand] e.g. 'node /abs/path/hooks/sync-status-line.mjs'
 * @returns {string}
 */
export function removeHooksBlock(content, hookCommand) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const found = findBlock(lines);
  if (found && found.end === null) return content;

  const ranges = [];
  if (found) ranges.push({ start: found.start, end: found.end });
  for (const b of findBareBlocks(lines, hookPathFromCommand(hookCommand), found)) {
    ranges.push({ start: b.start, end: b.end });
  }
  if (ranges.length === 0) return content;
  applyRanges(lines, ranges);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
