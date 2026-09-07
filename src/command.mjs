/**
 * Quote one command argument only when the shell could split or expand it.
 * Generated commands stay byte-for-byte compatible for ordinary paths while
 * paths containing spaces or shell metacharacters remain a single argument.
 *
 * The stored command is executed by the host's status-line runner through
 * `sh -c` on POSIX and `spawn(cmd.exe, ['/d', '/s', '/c', command])` on
 * Windows, so the escaping rules differ per platform:
 * - POSIX: inside double quotes a `\`, `"`, `$` or backtick must be escaped,
 *   or the shell rewrites the argument.
 * - Windows: cmd.exe knows no `\` escapes and a `"` cannot occur in a real
 *   Windows path, so the argument is wrapped unescaped. (PowerShell is not
 *   the host shell; it shares the double-quote rule but would expand `$var`
 *   and backticks inside them, which cmd.exe leaves literal.)
 * @param {string} value
 * @returns {string}
 */
export function quoteCommandArg(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    // `~` is a plain filename character for cmd.exe (no tilde expansion) and
    // occurs in 8.3 short names like RUNNER~1, so it must reach the unquoted
    // fast path there.
    if (/^[A-Za-z0-9_@%+=:,./\\~-]+$/.test(text)) return text;
    return `"${text}"`;
  }
  // A backslash must never reach the unquoted fast path: unquoted, a POSIX
  // shell consumes it as an escape and node receives a corrupted path.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `"${text.replace(/["\\$`]/g, '\\$&')}"`;
}

/**
 * Build the command string stored in Kimi Code's TOML configuration.
 * @param {string} scriptPath
 * @returns {string}
 */
export function nodeCommand(scriptPath) {
  return `node ${quoteCommandArg(scriptPath)}`;
}
