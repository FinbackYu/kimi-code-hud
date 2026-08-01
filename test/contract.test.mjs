import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics } from '../src/metrics.mjs';
import { parsePayload } from '../src/payload.mjs';
import { renderHud } from '../src/render.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1785456060000;
const SENSITIVE_PATTERN =
  /\/Users\/\S+|\/home\/\S+|[A-Z]:\\Users\\\S+|access_token|authorization|bearer\s+\S+|cookie\s*[:=]/i;

test('sanitized host payload and wire fixtures lock every layout/theme/color contract', () => {
  const payloadText = fs.readFileSync(path.join(FIXTURES, 'status-line-payload.json'), 'utf8');
  const wireText = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');
  const quotaText = fs.readFileSync(path.join(FIXTURES, 'quota-cache.json'), 'utf8');
  const expectedText = fs.readFileSync(path.join(FIXTURES, 'render-contract.json'), 'utf8');
  const quota = JSON.parse(quotaText);
  const expected = JSON.parse(expectedText);
  for (const fixtureText of [payloadText, wireText, quotaText, expectedText]) {
    assert.doesNotMatch(fixtureText, SENSITIVE_PATTERN);
  }
  assert.doesNotMatch(wireText, /"input"\s*:/);

  const payload = parsePayload(payloadText);
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-contract-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-contract-state-'));
  const agentDir = path.join(
    sessionsRoot,
    'workspace-redacted',
    `ses_${payload.sessionId}`,
    'agents',
    'main',
  );
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'wire.jsonl'), wireText);
  const metrics = getMetrics(payload.sessionId, { sessionsRoot, stateDir, now: NOW });
  assert.equal(metrics.tps, 30);
  assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });

  const actual = {};
  for (const layout of ['compact', 'normal']) {
    for (const theme of ['dark', 'light']) {
      for (const color of [false, true]) {
        const key = `${layout}-${theme}-${color ? 'ansi' : 'plain'}`;
        actual[key] = renderHud({
          payload,
          quota,
          metrics,
          gitDirty: false,
          layout,
          theme,
          color,
          now: NOW,
        })[0];
      }
    }
  }
  assert.deepEqual(actual, expected);
});

test('sanitization guard pattern catches leaked paths and credentials', () => {
  const payloadText = fs.readFileSync(path.join(FIXTURES, 'status-line-payload.json'), 'utf8');
  assert.match(payloadText.replace('/workspace/hud', '/Users/alice/hud'), SENSITIVE_PATTERN);
  assert.match('/home/bob/work', SENSITIVE_PATTERN);
  assert.match('C:\\Users\\carol\\repo', SENSITIVE_PATTERN);
  assert.match('"access_token": "secret"', SENSITIVE_PATTERN);
  assert.match('authorization: Bearer abc123', SENSITIVE_PATTERN);
  assert.match('cookie: session=abc123', SENSITIVE_PATTERN);
  assert.doesNotMatch('llmFirstTokenLatencyMs', SENSITIVE_PATTERN);
  assert.doesNotMatch('contextTokens', SENSITIVE_PATTERN);
});
