import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const EMPTY = Object.freeze({ branch: null, dirty: false });
const INDEX_ENTRY = /^([0-7]{6}) [0-9a-f]{40,64} ([0-3])\t([^\0]*)$/;
const INDEX_STAT = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: [^\n]*\n  uid: [^\n]*\n  size: (\d+)\tflags: [^\n]*\n/;

function readIndexEntries(output) {
  const entries = [];
  let offset = 0;
  while (offset < output.length) {
    const nul = output.indexOf('\0', offset);
    if (nul < 0) throw new Error('invalid Git index listing');
    const header = INDEX_ENTRY.exec(output.slice(offset, nul));
    // With --cached --others, an untracked path has no stage header or debug
    // metadata. Its presence is enough to mark the worktree dirty.
    if (!header) return { entries, untracked: true };
    offset = nul + 1;
    const stat = INDEX_STAT.exec(output.slice(offset));
    if (!stat) throw new Error('unsupported Git index metadata');
    offset += stat[0].length;
    entries.push({
      mode: Number.parseInt(header[1], 8),
      stage: Number(header[2]),
      path: header[3],
      ctimeNs: BigInt(stat[1]) * 1_000_000_000n + BigInt(stat[2]),
      mtimeNs: BigInt(stat[3]) * 1_000_000_000n + BigInt(stat[4]),
      size: BigInt(stat[5]),
    });
  }
  return { entries, untracked: false };
}

function readBranch(cwd, env) {
  try {
    const override = Object.entries(env).find(([key]) => key.toUpperCase() === 'GIT_DIR')?.[1];
    let gitDir = typeof override === 'string' && override
      ? resolve(cwd, override)
      : null;
    if (!gitDir) {
      let current = resolve(cwd);
      for (;;) {
        const candidate = join(current, '.git');
        try {
          const stat = statSync(candidate);
          if (stat.isDirectory()) gitDir = candidate;
          else if (stat.isFile() && stat.size <= 4096) {
            const pointer = /^gitdir: ([^\r\n]+)\s*$/i.exec(readFileSync(candidate, 'utf8'));
            if (pointer) gitDir = resolve(current, pointer[1]);
          }
        } catch { /* no repository marker here */ }
        if (gitDir || dirname(current) === current) break;
        current = dirname(current);
      }
    }
    if (!gitDir || statSync(join(gitDir, 'HEAD')).size > 4096) return null;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
    const branch = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(head)?.[1];
    return branch && branch.length <= 1024 ? branch : null;
  } catch {
    return null;
  }
}

function changedOnDisk(cwd, entry, platform) {
  if (entry.stage !== 0) return true;
  const path = resolve(cwd, entry.path);
  const rel = relative(cwd, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  try {
    const stat = lstatSync(path, { bigint: true });
    if (entry.mode === 0o160000) return !stat.isDirectory();
    if (entry.mode === 0o120000 ? !stat.isSymbolicLink() : !stat.isFile()) return true;
    if (platform !== 'win32' && entry.mode !== 0o120000) {
      const executable = (stat.mode & 0o111n) !== 0n;
      if (executable !== (entry.mode === 0o100755)) return true;
    }
    // Git for Windows and Node can disagree on creation/change time for the
    // same clean file. Git's content check uses size and mtime there; do not
    // turn a clean Windows worktree into a permanent dirty indicator.
    if (platform === 'win32') {
      return stat.size !== entry.size || stat.mtimeNs !== entry.mtimeNs;
    }
    return stat.size !== entry.size
      || stat.ctimeNs !== entry.ctimeNs
      || stat.mtimeNs !== entry.mtimeNs;
  } catch {
    return true;
  }
}

/**
 * Inspect dirtiness without asking Git to convert working-tree content.
 * Git status/diff-files/ls-files --modified may invoke repository filters.
 * Every Git child here is read-only, has a shared time budget, and performs
 * index or ref inspection only. Unknown index formats fail toward dirty.
 */
export function probeGitStatusSafely(git, cwd, {
  env,
  platform,
  timeoutMs = 150,
  exec = execFileSync,
} = {}) {
  const deadline = performance.now() + Math.max(1, Math.min(150, Math.floor(timeoutMs)));
  const base = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`];
  const run = (args) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error('Git probe deadline');
    return exec(git, [...base, ...args], {
      cwd,
      env,
      timeout: remaining,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  };

  const branch = readBranch(cwd, env);

  try {
    const raw = run(['ls-files', '--cached', '--others', '--exclude-standard', '--stage', '--debug', '-z']).toString('utf8');
    const { entries, untracked } = readIndexEntries(raw);
    if (untracked) return Object.freeze({ branch, dirty: true });
    for (const entry of entries) {
      if (performance.now() >= deadline || changedOnDisk(cwd, entry, platform)) {
        return Object.freeze({ branch, dirty: true });
      }
    }

    // Cached diff never reads working-tree content or invokes clean/process
    // filters. An unborn HEAD fails here; a nonempty index is then dirty.
    try {
      const staged = run(['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
      return Object.freeze({ branch, dirty: staged.length > 0 });
    } catch {
      return Object.freeze({ branch, dirty: entries.length > 0 });
    }
  } catch {
    return branch ? Object.freeze({ branch, dirty: true }) : EMPTY;
  }
}
