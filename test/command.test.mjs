import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeCommand, quoteCommandArg } from '../src/command.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ordinary script paths keep the historical command format', () => {
  assert.equal(nodeCommand('/Users/test/kimi-code-hud/bin/kimi-hud.mjs'),
    'node /Users/test/kimi-code-hud/bin/kimi-hud.mjs');
});

test('paths with spaces and shell metacharacters stay one argument', () => {
  assert.equal(nodeCommand('/Users/Test User/hud$1.mjs'),
    'node "/Users/Test User/hud\\$1.mjs"');
  assert.equal(quoteCommandArg('plain/path'), 'plain/path');
});

test('backslash paths are quoted so POSIX shells do not consume the escape', () => {
  // Unquoted, sh reads back\slash as backslash; the doubled form inside
  // double quotes survives every POSIX shell byte-for-byte.
  assert.equal(quoteCommandArg('back\\slash/kimi-hud.mjs'), '"back\\\\slash/kimi-hud.mjs"');
  assert.equal(nodeCommand('back\\slash/kimi-hud.mjs'), 'node "back\\\\slash/kimi-hud.mjs"');
});

// ---------------------------------------------------------------------------
// Dynamic execution (H05): the host runs the stored [status_line] command
// through a shell, so string equality above cannot prove the quoting works.
// These cases execute the generated command in each real POSIX shell
// available locally and check the script received the path as exactly one
// argument. Only POSIX-compatible shells (sh/bash/zsh) are claimed; csh/
// tcsh/fish dialects are out of scope, and Windows shells cannot run here.
// ---------------------------------------------------------------------------

const POSIX_SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh'];

// Everything below is POSIX-only: on Windows /bin/sh does not exist and
// several hostile directory names (pipe, wildcard, quote, newline) are
// illegal filenames. Those cases skip there instead of failing CI, and
// Windows execution stays covered by the honest cmd.exe/PowerShell probe
// at the bottom of this file — the only place it can ever be verified.
const POSIX_SKIP = process.platform === 'win32'
  ? 'drives /bin/sh and POSIX path semantics; Windows needs its own verified run'
  : false;

// A stub "entry point" that records the argv it received, so the test can
// prove the shell handed the script path through as a single argument.
const STUB_SCRIPT = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.env.STUB_RECORD, JSON.stringify(process.argv.slice(1)) + '\\n');",
  '',
].join('\n');

// Hostile install-directory names executed for real. Backslash names are
// covered separately: node's own ESM entry loader refuses any entry path
// containing a literal backslash (see the boundary test below).
const HOSTILE_DIRS = [
  'plain-bin',
  'with space',
  '中文 目录',
  "single'quote",
  'dollar$SIGN',
  'quote"mark',
  'back`tick$(cmd)',
  'semi;colon|pipe&amp',
  'glob*star?q[range]',
  'tilde~eq=at@plus+',
  'line\nbreak',
];

function availableShells() {
  return POSIX_SHELLS.filter((shell) => {
    if (!fs.existsSync(shell)) return false;
    try {
      return spawnSync(shell, ['-c', ':'], { encoding: 'utf8' }).status === 0;
    } catch {
      return false;
    }
  });
}

test('at least one POSIX shell is available for dynamic command execution', { skip: POSIX_SKIP }, () => {
  assert.ok(availableShells().length > 0, `none of ${POSIX_SHELLS.join(', ')} could run`);
});

// Empty on Windows, so the matrix loop below creates no tests there.
for (const shell of POSIX_SKIP ? [] : availableShells()) {
  test(`generated command runs the script with one exact argument in real ${path.basename(shell)}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `kimi-hud-shell-${path.basename(shell)}-`));
    const record = path.join(root, 'argv-records.jsonl');
    for (const name of HOSTILE_DIRS) {
      const script = path.join(root, name, 'kimi-hud.mjs');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, STUB_SCRIPT);
      const result = spawnSync(shell, ['-c', nodeCommand(script)], {
        env: { PATH: process.env.PATH, STUB_RECORD: record },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${JSON.stringify(name)}: ${result.stderr}`);
      const last = fs.readFileSync(record, 'utf8').trimEnd().split('\n').at(-1);
      assert.deepEqual(JSON.parse(last), [script], JSON.stringify(name));
    }
  });
}

test('backslash paths reach node byte-exact, though node itself refuses them as ESM entries', { skip: POSIX_SKIP }, () => {
  // Two stacked facts established by dynamic execution:
  // 1. quoteCommandArg used to treat `\` as safe and left such paths
  //    unquoted; sh then consumed the backslashes as escapes and node
  //    received a corrupted path (fixed, regression-tested above).
  // 2. Node's ESM entry loader rejects any entry path containing a literal
  //    backslash even on POSIX ("ERR_INVALID_MODULE_SPECIFIER ... must not
  //    include encoded \ characters"), so `node <backslash-path>` cannot be
  //    executed at all — a Node.js limitation no quoting can work around.
  // Full execution of such installs therefore stays unverified here; these
  // cases are asserted up to the shell→argv boundary instead, and Windows
  // (where backslashes are the native separator) remains the skipped test.
  for (const name of ['back\\slash', 'C:\\Program Files\\hud\\bin']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-shell-backslash-'));
    const script = path.join(root, name, 'kimi-hud.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, STUB_SCRIPT);
    const arg = nodeCommand(script).slice('node '.length);
    const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${arg}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, script, JSON.stringify(name));
  }
});

test('the real entry point runs from a quoted hostile install path via a real shell', { skip: POSIX_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-shell-entry-'));
  const hostileRoot = path.join(root, 'HUD 空间$k `tick`', '中文');
  const bin = path.join(hostileRoot, 'bin', 'kimi-hud.mjs');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.cpSync(path.join(REPO, 'bin'), path.dirname(bin), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(hostileRoot, 'src'), { recursive: true });
  for (const shell of availableShells()) {
    // Empty stdin takes the render fallback path: exit 0, silent, exact line.
    const result = spawnSync(shell, ['-c', nodeCommand(bin)], {
      input: '',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        KIMI_CODE_HOME: path.join(root, 'kimi-home'),
        KIMI_HUD_HOME: path.join(root, 'hud-home'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kimi-code-hud\n');
  }
});

test('Windows cmd.exe and PowerShell execution of the generated command', {
  skip: process.platform !== 'win32'
    && 'cmd.exe/PowerShell quoting cannot be verified on this POSIX host; needs a real Windows run (H05, unverified)',
}, () => {
  // quoteCommandArg emits POSIX double-quote escaping. cmd.exe knows no `\`
  // escapes and expands %VARS% inside double quotes, so this body is expected
  // to expose mismatches when it finally runs on Windows — that is its job.
  // Until a Windows host executes it, Windows quoting stays unverified and is
  // NOT claimed correct anywhere.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-win-'));
  const record = path.join(root, 'argv-records.jsonl');
  const script = path.join(root, 'with space', 'kimi-hud.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, STUB_SCRIPT);
  const env = { PATH: process.env.PATH, STUB_RECORD: record };
  const cmd = spawnSync('cmd.exe', ['/d', '/s', '/c', nodeCommand(script)], {
    env, encoding: 'utf8',
  });
  assert.equal(cmd.status, 0, cmd.stderr);
  const powershell = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', nodeCommand(script)],
    { env, encoding: 'utf8' },
  );
  assert.equal(powershell.status, 0, powershell.stderr);
  const last = fs.readFileSync(record, 'utf8').trimEnd().split('\n').at(-1);
  assert.deepEqual(JSON.parse(last), [script]);
});
