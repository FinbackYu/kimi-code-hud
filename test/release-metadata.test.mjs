import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPORARY_RELEASE_STATE = /working(?:[ -]|\r?\n)+tree|pending(?:[ -]|\r?\n)+release/i;
const PUBLIC_SHOWCASE_SOURCES = [
  'docs/showcase/README.md',
  'docs/showcase/export-assets.py',
  'docs/showcase/render-states.mjs',
  'docs/showcase/startup-page.html',
  'docs/showcase/states-gallery.html',
];
const PUBLIC_SHOWCASE_IMAGES = [
  'docs/media/hud-demo.png',
  'docs/media/hud-states.png',
];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function compatibilityMetadata(text, name) {
  const verified = text.match(/^- Last verified: (\d{4}-\d{2}-\d{2})$/m);
  const hud = text.match(/^- HUD behavior baseline: `v([^`]+)` \(`([0-9a-f]{7,40})`\)$/m);
  const kimi = text.match(/^- Kimi Code baseline: `([^`]+)` \(`([0-9a-f]{40})`\)$/m);
  assert.ok(verified, `${name} is missing the Last verified line`);
  assert.ok(hud, `${name} is missing the released HUD behavior baseline line`);
  assert.ok(kimi, `${name} is missing the pinned Kimi Code baseline line`);
  return {
    verified: verified[1],
    hudVersion: hud[1],
    hudCommit: hud[2],
    kimiVersion: kimi[1],
    kimiCommit: kimi[2],
  };
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertReleasedHudCommit(version, commit) {
  const tag = `v${version}`;
  let targetCommit;
  try {
    targetCommit = git(['rev-parse', '--verify', `${tag}^{commit}`]);
  } catch {
    // During the version-bump commit the new tag does not exist yet. HEAD is the
    // release candidate; the post-tag rerun below resolves the exact tag.
    targetCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  }
  try {
    const behaviorCommit = git(['rev-parse', '--verify', `${commit}^{commit}`]);
    execFileSync('git', ['merge-base', '--is-ancestor', behaviorCommit, targetCommit], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  } catch {
    assert.fail(`HUD behavior commit ${commit} must belong to release ${tag} or its pre-tag HEAD`);
  }
}

function assertNoTemporaryReleaseState(capabilities, knownIssues) {
  const metadataHeader = `${capabilities.split('\n').slice(0, 12).join('\n')}\n${knownIssues.split('\n').slice(0, 12).join('\n')}`;
  assert.doesNotMatch(metadataHeader, TEMPORARY_RELEASE_STATE);
  const issueBlocks = knownIssues
    .split(/(?=^## KI-\d+:)/m)
    .filter((section) => /^## KI-\d+:/m.test(section));
  for (const block of issueBlocks.filter((section) => /^Status: closed\b/im.test(section))) {
    assert.doesNotMatch(block, TEMPORARY_RELEASE_STATE);
  }
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, payload = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), payload.length + 8);
  return chunk;
}

function pngTextEntry(type, payload, name) {
  const separator = payload.indexOf(0);
  assert.ok(separator > 0, `${name} has an invalid PNG ${type} keyword`);
  const keyword = payload.toString('latin1', 0, separator);
  if (type === 'tEXt') {
    return { type, keyword, value: payload.toString('latin1', separator + 1) };
  }
  if (type === 'zTXt') {
    assert.ok(separator + 2 <= payload.length, `${name} has a truncated PNG zTXt chunk`);
    assert.equal(payload[separator + 1], 0, `${name} has an unsupported PNG zTXt compression method`);
    return {
      type,
      keyword,
      value: inflateSync(payload.subarray(separator + 2)).toString('latin1'),
    };
  }

  let cursor = separator + 1;
  assert.ok(cursor + 2 <= payload.length, `${name} has a truncated PNG iTXt header`);
  const compressionFlag = payload[cursor];
  const compressionMethod = payload[cursor + 1];
  assert.ok(compressionFlag === 0 || compressionFlag === 1,
    `${name} has an invalid PNG iTXt compression flag`);
  assert.equal(compressionMethod, 0, `${name} has an unsupported PNG iTXt compression method`);
  cursor += 2;
  const languageEnd = payload.indexOf(0, cursor);
  assert.ok(languageEnd >= cursor, `${name} has an invalid PNG iTXt language tag`);
  cursor = languageEnd + 1;
  const translatedEnd = payload.indexOf(0, cursor);
  assert.ok(translatedEnd >= cursor, `${name} has an invalid PNG iTXt translated keyword`);
  const text = payload.subarray(translatedEnd + 1);
  return {
    type,
    keyword,
    value: (compressionFlag === 1 ? inflateSync(text) : text).toString('utf8'),
  };
}

function pngTextEntries(data, name) {
  assert.ok(data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${name} must be a PNG`);
  const entries = [];
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset < data.length) {
    assert.ok(offset + 12 <= data.length, `${name} has a truncated PNG chunk header`);
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= data.length, `${name} has a truncated PNG chunk`);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + length);
    const actualCrc = data.readUInt32BE(offset + 8 + length);
    const expectedCrc = crc32(data.subarray(offset + 4, offset + 8 + length));
    assert.equal(actualCrc, expectedCrc, `${name} has an invalid PNG ${type} CRC`);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      entries.push(pngTextEntry(type, payload, name));
    }
    offset = end;
    if (type === 'IEND') {
      sawIend = true;
      assert.equal(offset, data.length, `${name} must not contain bytes after IEND`);
    }
  }
  assert.ok(sawIend, `${name} is missing IEND`);
  return entries;
}

function assertPngAuthor(data, name, author) {
  const authorEntries = pngTextEntries(data, name).filter(({ keyword }) => keyword === 'Author');
  assert.deepEqual(authorEntries, [{ type: 'tEXt', keyword: 'Author', value: author }],
    `${name} must contain exactly one tEXt Author entry from kimi.plugin.json`);
}

function pngWithTextChunks(textChunks) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 0, 0, 0]));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...textChunks,
    pngChunk('IDAT', idat),
    pngChunk('IEND'),
  ]);
}

test('package and plugin manifest versions stay aligned', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
});

test('changelog links start from the current package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## \[Unreleased\]$/m);
  assert.ok(changelog.includes(`[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v${pkg.version}...HEAD`));
  assert.ok(changelog.includes(`[${pkg.version}]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v${pkg.version}`));
});

test('compatibility inventories stay aligned with the current HUD release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf8');
  const knownIssues = fs.readFileSync(path.join(ROOT, 'KNOWN_ISSUES.md'), 'utf8');
  const cap = compatibilityMetadata(capabilities, 'CAPABILITIES.md');
  const known = compatibilityMetadata(knownIssues, 'KNOWN_ISSUES.md');
  assert.deepEqual(known, cap, 'CAPABILITIES.md and KNOWN_ISSUES.md metadata must match');
  assert.equal(cap.hudVersion, pkg.version, 'HUD behavior baseline must match package.json');
  assertReleasedHudCommit(cap.hudVersion, cap.hudCommit);

  if (process.env.KIMI_HUD_RELEASE_CHECK === '1') {
    assertNoTemporaryReleaseState(capabilities, knownIssues);
  }
});

test('strict metadata rejects hyphenated and multiline temporary release states', () => {
  const cleanHeader = '# HUD capabilities\n\n- Last verified: 2026-08-22\n';
  assert.throws(
    () => assertNoTemporaryReleaseState(`${cleanHeader}- HUD behavior baseline: working-tree\n`, ''),
    /working-tree/i,
  );
  assert.throws(
    () => assertNoTemporaryReleaseState(cleanHeader, [
      '## KI-99: example',
      '',
      'Status: closed (implemented in the working',
      'tree, pending-',
      'release)',
      '',
      'Resolution:',
      '',
      'Example only.',
    ].join('\n')),
    /working[\s\S]*tree|pending[\s\S]*release/i,
  );
});

test('public showcase source chain is present and contains no private checkout paths', () => {
  for (const relativePath of PUBLIC_SHOWCASE_SOURCES) {
    const absolutePath = path.join(ROOT, relativePath);
    assert.ok(fs.statSync(absolutePath).isFile(), `${relativePath} must be present in a public checkout`);
    const source = fs.readFileSync(absolutePath, 'utf8');
    assert.doesNotMatch(source, /\/Users\/|\/private\/|kimi-ecosystem|KimiCodeBar/,
      `${relativePath} must not depend on a private checkout path`);
  }
  const exporter = fs.readFileSync(path.join(ROOT, 'docs/showcase/export-assets.py'), 'utf8');
  assert.match(exporter, /--metadata-only/, 'public exporter must support metadata-only updates');
});

test('public showcase PNGs carry the plugin author as standard text metadata', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  for (const relativePath of PUBLIC_SHOWCASE_IMAGES) {
    assertPngAuthor(fs.readFileSync(path.join(ROOT, relativePath)), relativePath, plugin.author);
  }
});

test('strict PNG metadata detects cross-type duplicate Author chunks in memory', () => {
  const author = 'FinbackYu';
  const duplicateAuthors = pngWithTextChunks([
    pngChunk('tEXt', Buffer.from(`Author\0${author}`, 'latin1')),
    pngChunk('zTXt', Buffer.concat([
      Buffer.from('Author\0', 'latin1'),
      Buffer.from([0]),
      deflateSync(Buffer.from(author, 'latin1')),
    ])),
    pngChunk('iTXt', Buffer.concat([
      Buffer.from('Author\0', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from(author, 'utf8'),
    ])),
  ]);
  const authorEntries = pngTextEntries(duplicateAuthors, 'in-memory PNG')
    .filter(({ keyword }) => keyword === 'Author');
  assert.deepEqual(authorEntries, [
    { type: 'tEXt', keyword: 'Author', value: author },
    { type: 'zTXt', keyword: 'Author', value: author },
    { type: 'iTXt', keyword: 'Author', value: author },
  ]);
  assert.throws(
    () => assertPngAuthor(duplicateAuthors, 'in-memory PNG', author),
    /exactly one tEXt Author/,
  );
});

test('released metadata rejects a HUD behavior commit after its tag', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tag = `v${pkg.version}`;
  let descendant;
  try {
    descendant = git(['rev-list', '--max-count=1', `${tag}..HEAD`]);
  } catch {
    t.skip(`${tag} does not exist yet`);
    return;
  }
  if (!descendant) {
    t.skip(`HEAD has no commits after ${tag}`);
    return;
  }
  assert.throws(
    () => assertReleasedHudCommit(pkg.version, descendant),
    /must belong to release/,
  );
});

test('showcase pages embed the current plugin and CLI baseline versions', () => {
  const pages = [
    path.join(ROOT, 'docs/showcase/states-gallery.html'),
    path.join(ROOT, 'docs/showcase/startup-page.html'),
  ];
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf8');
  const baseline = capabilities.match(/^- Kimi Code baseline: `([^`]+)`/m);
  assert.ok(baseline, 'CAPABILITIES.md is missing the Kimi Code baseline line');
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const name = path.basename(page);
    const hud = html.match(/const HUD_VERSION = ['"]([^'"]+)['"]/);
    assert.ok(hud, `${name} is missing the HUD_VERSION constant`);
    assert.equal(hud[1], plugin.version, `${name} HUD_VERSION must match kimi.plugin.json`);
    const cli = html.match(/const CLI_VERSION = ['"]([^'"]+)['"]/);
    assert.ok(cli, `${name} is missing the CLI_VERSION constant`);
    assert.equal(cli[1], baseline[1], `${name} CLI_VERSION must match the CAPABILITIES.md Kimi Code baseline`);
  }
});
