#!/usr/bin/env node
// Read-only release gate for kimi-code-hud.
//
// Runs the release-day checks from .agents/skills/release/SKILL.md that need
// no network access and no working-tree changes, in the same order:
//   1. strict release metadata — node --test test/release-metadata.test.mjs
//      with KIMI_HUD_RELEASE_CHECK=1 (blocks pending-release / working-tree
//      compatibility states and verifies baselines, changelog links, PNG
//      authorship and showcase version constants)
//   2. the full test suite (skipped with --metadata-only)
//   3. git diff --check over the working tree
//
// The gate never tags, commits, pushes, or writes files. When the version
// tag does not exist yet (version-bump commit, pre-tag candidate), the
// strict metadata check validates HEAD as the release candidate — see
// test/release-metadata.test.mjs. Re-run the gate after tagging so the same
// checks resolve the exact tag.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: node scripts/check-release.mjs [--metadata-only] [--help]

Read-only release gate:
  1. strict release metadata  KIMI_HUD_RELEASE_CHECK=1 node --test test/release-metadata.test.mjs
  2. full test suite          node --test  (skip with --metadata-only)
  3. whitespace               git diff --check

When the v<version> tag does not exist yet, HEAD is validated as the
release candidate; re-run this gate after tagging.`;

/** Human-readable explanation of which release contract this run enforces. */
export function describeReleaseMode(version, tagExists) {
  const tag = `v${version}`;
  if (tagExists) {
    return `tag ${tag} exists — tagged mode; behavior commits must resolve to ${tag}`;
  }
  return `tag ${tag} not created yet — candidate mode; HEAD is validated as the release candidate, re-run after tagging`;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw new Error(`git is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function runNode(args, { label, env = process.env }) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    label,
    ok: !result.error && result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
  };
}

function parseArgs(argv) {
  const flags = { metadataOnly: false };
  for (const arg of argv) {
    if (arg === '--metadata-only') flags.metadataOnly = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return flags;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err2) {
    err.write(`check-release: ${err2.message}\n${USAGE}\n`);
    return 2;
  }
  if (flags.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }

  let tagExists;
  let version;
  try {
    ({ version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
    tagExists = git(['rev-parse', '--verify', `v${version}^{commit}`], { allowFailure: true }) !== null;
  } catch (err3) {
    err.write(`check-release: ${err3.message}\n`);
    return 1;
  }
  out.write(`check-release: HUD version ${version} — ${describeReleaseMode(version, tagExists)}\n`);

  const gates = [
    runNode(['--test', 'test/release-metadata.test.mjs'], {
      label: 'strict metadata (KIMI_HUD_RELEASE_CHECK=1)',
      env: { ...process.env, KIMI_HUD_RELEASE_CHECK: '1' },
    }),
  ];
  if (!flags.metadataOnly) {
    gates.push(runNode(['--test'], { label: 'full test suite (node --test)' }));
  }
  try {
    git(['diff', '--check']);
    gates.push({ label: 'whitespace (git diff --check)', ok: true, output: '' });
  } catch (err4) {
    gates.push({ label: 'whitespace (git diff --check)', ok: false, output: err4.message });
  }

  let failed = false;
  for (const gate of gates) {
    if (gate.ok) {
      out.write(`check-release: PASS ${gate.label}\n`);
    } else {
      failed = true;
      err.write(`check-release: FAIL ${gate.label}\n${gate.output}\n`);
    }
  }
  if (!failed) {
    out.write(`check-release: OK (${gates.map((gate) => gate.label).join(', ')})\n`);
  }
  return failed ? 1 : 0;
}

if (isMainModule()) {
  process.exitCode = main();
}
