import { execFileSync } from 'node:child_process';

/**
 * Check whether the git working tree at cwd has uncommitted changes.
 * Any failure (not a repo, git missing, timeout) returns false.
 * @param {string} cwd
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {boolean}
 */
export function isGitDirty(cwd, { timeoutMs = 150 } = {}) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      timeout: Math.max(1, Math.min(150, Math.floor(timeoutMs))),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}
