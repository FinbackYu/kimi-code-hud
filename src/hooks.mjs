// Managed SessionStart hook block in ~/.kimi-code/config.toml.
// The host rewrites tui.toml on some upgrades (wiping [status_line]) but
// preserves config.toml [[hooks]] — observed with the vibe-island managed
// block across the 0.30.0 -> 0.31.0 upgrade. So --install registers a
// SessionStart hook here that re-points tui.toml's status-line command at
// every session start (see hooks/sync-status-line.mjs).
//
// Same marker convention as vibe-island: a START/END comment pair wraps
// our block so we can find, refresh and remove it without a TOML parser.

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

/**
 * Return config.toml content with our SessionStart hook block present.
 * Idempotent; refreshes the block in place when the hook path moved.
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
  if (found) {
    lines.splice(found.start, found.end - found.start + 1, ...block);
  } else {
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  }
  const out = lines.join('\n') + '\n';
  const normalized = (content || '').replace(/\r\n/g, '\n');
  return out === normalized ? content : out;
}

/**
 * Return config.toml content with our hook block removed. No-op when the
 * markers are absent; other hooks and settings are untouched.
 * @param {string} content
 * @returns {string}
 */
export function removeHooksBlock(content) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const found = findBlock(lines);
  if (!found) return content;
  if (found.end === null) return content;
  lines.splice(found.start, found.end - found.start + 1);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
