import { execFileSync } from 'node:child_process';

/**
 * Check whether the git working tree at cwd has uncommitted changes.
 * Any failure (not a repo, git missing, timeout) returns false.
 * @param {string} cwd
 * @returns {boolean}
 */
export function isGitDirty(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 150,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}
