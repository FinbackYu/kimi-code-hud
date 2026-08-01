/**
 * Quote one command argument only when the shell could split or expand it.
 * Generated commands stay byte-for-byte compatible for ordinary paths while
 * paths containing spaces or shell metacharacters remain a single argument.
 * @param {string} value
 * @returns {string}
 */
export function quoteCommandArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text;
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
