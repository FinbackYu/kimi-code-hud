// Minimal tui.toml rewriting for --install / --uninstall. This is NOT a
// general TOML parser: it only locates the [status_line] section and adds,
// replaces or removes its `command = "..."` line, preserving everything
// else (including `items`) byte-for-byte.

function tomlEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findSection(lines, name) {
  const header = new RegExp(`^\\s*\\[${name.replace('.', '\\.')}\\]\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i])) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[/.test(lines[j])) { end = j; break; }
      }
      return { start: i, end };
    }
  }
  return null;
}

function isCommandLine(line) {
  return /^\s*command\s*=/.test(line);
}

/**
 * Return tui.toml content with the status-line command installed.
 * Idempotent: running twice yields the same content. Preserves an existing
 * [status_line] section (e.g. its `items`) and appends a new section when
 * none exists.
 * @param {string} content existing file content (may be empty)
 * @param {string} command e.g. 'node /abs/path/bin/kimi-hud.mjs'
 * @returns {string}
 */
export function setStatusLineCommand(content, command) {
  const line = `command = "${tomlEscape(command)}"`;
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  // Trim trailing blank lines so appends stay tidy; restored at the end.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const section = findSection(lines, 'status_line');
  if (!section) {
    if (lines.length > 0) lines.push('');
    lines.push('[status_line]', line);
    return lines.join('\n') + '\n';
  }
  for (let i = section.start + 1; i < section.end; i++) {
    if (isCommandLine(lines[i])) {
      if (lines[i] === line) return (content.endsWith('\n') ? content : content + '\n');
      lines[i] = line;
      return lines.join('\n') + '\n';
    }
  }
  lines.splice(section.start + 1, 0, line);
  return lines.join('\n') + '\n';
}

/**
 * Return the `command` value inside the [status_line] section, or null when
 * the section or its command line is absent. Other sections' `command` keys
 * (e.g. [editor]) are ignored.
 * @param {string} content
 * @returns {string | null}
 */
export function getStatusLineCommand(content) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const section = findSection(lines, 'status_line');
  if (!section) return null;
  for (let i = section.start + 1; i < section.end; i++) {
    const m = lines[i].match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\(["\\])/g, '$1');
  }
  return null;
}

/**
 * Return tui.toml content with the status-line command removed. Only
 * command lines inside [status_line] whose value mentions our script (or
 * equals the given command) are removed; other keys are untouched.
 * @param {string} content
 * @param {string} command
 * @returns {string}
 */
export function removeStatusLineCommand(content, command) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const section = findSection(lines, 'status_line');
  if (!section) return content;
  const out = lines.slice(0, section.start + 1);
  for (let i = section.start + 1; i < section.end; i++) {
    const l = lines[i];
    if (isCommandLine(l) && (l.includes(command) || l.includes('kimi-hud'))) continue;
    out.push(l);
  }
  out.push(...lines.slice(section.end));
  return out.join('\n');
}
