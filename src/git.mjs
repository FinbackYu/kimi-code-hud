import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

// cmd.exe / CreateProcess search the current directory before PATH, so a bare
// command name can execute a binary planted in the workspace. Resolve PATH
// ourselves and refuse workspace-local hits before running the pre-trust Git
// probe. This mirrors the Kimi Code 0.35+ host boundary.
const DEFAULT_WIN32_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

function envValue(env, name) {
  const match = Object.entries(env).find(([key]) => key.toUpperCase() === name);
  return typeof match?.[1] === 'string' ? match[1] : '';
}

function pathExtensions(platform, env) {
  if (platform !== 'win32') return [''];
  const raw = envValue(env, 'PATHEXT');
  if (raw.trim().length === 0) return DEFAULT_WIN32_PATHEXT;
  return raw
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
}

function candidateNames(command, extensions) {
  if (extensions.length === 1 && extensions[0] === '') return [command];
  const lower = command.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
    return [command, ...extensions.map((extension) => command + extension)];
  }
  return extensions.map((extension) => command + extension);
}

function executablePath(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return null;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isInsideCwd(candidate, cwd, platform) {
  let resolvedCandidate = candidate;
  let resolvedCwd;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = resolve(cwd);
  }
  if (platform === 'win32') {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedCwd = resolvedCwd.toLowerCase();
  }
  const rel = relative(resolvedCwd, resolvedCandidate);
  return rel === '' || (
    rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

/**
 * Resolve a bare command to an absolute executable from PATH. A hit inside
 * cwd fails closed instead of falling through to a later PATH entry.
 * @param {string} command
 * @param {string} [cwd]
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|object} [opts.env]
 * @param {NodeJS.Platform|string} [opts.platform]
 * @returns {string|undefined}
 */
export function resolveCommandPath(
  command,
  cwd = process.cwd(),
  { env = process.env, platform = process.platform } = {},
) {
  if (typeof command !== 'string' || command === '' || /[\\/]/.test(command)) return undefined;
  const names = candidateNames(command, pathExtensions(platform, env));
  const separator = platform === 'win32' ? ';' : ':';
  for (const rawDir of envValue(env, 'PATH').split(separator)) {
    if (rawDir === '') continue;
    const dir = rawDir.startsWith('"') && rawDir.endsWith('"')
      ? rawDir.slice(1, -1)
      : rawDir;
    for (const name of names) {
      const candidate = executablePath(join(dir, name), platform);
      if (!candidate) continue;
      if (isInsideCwd(candidate, cwd, platform)) return undefined;
      return candidate;
    }
  }
  return undefined;
}

/**
 * Check whether the git working tree at cwd has uncommitted changes.
 * Any failure (not a repo, git missing, timeout) returns false.
 * @param {string} cwd
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {NodeJS.ProcessEnv|object} [opts.env]
 * @param {NodeJS.Platform|string} [opts.platform]
 * @returns {boolean}
 */
export function isGitDirty(
  cwd,
  {
    timeoutMs = 150,
    env = process.env,
    platform = process.platform,
  } = {},
) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    const git = resolveCommandPath('git', cwd, { env, platform });
    if (!git) return false;
    const out = execFileSync(git, ['status', '--porcelain'], {
      cwd,
      env,
      timeout: Math.max(1, Math.min(150, Math.floor(timeoutMs))),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}
