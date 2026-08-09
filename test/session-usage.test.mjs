import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  advanceSessionUsageAgent,
  applySessionUsageRow,
  emptySessionUsageState,
  sessionUsageMetricFromState,
} from '../src/session-usage.mjs';

function record(model, usage) {
  return { type: 'usage.record', model, usage, usageScope: 'turn' };
}

const USAGE = {
  inputOther: 100,
  inputCacheRead: 300,
  inputCacheCreation: 20,
  output: 40,
};

test('usage.record folds model-scoped token deltas and ignores duplicate step.end', () => {
  const agentUsage = { reader: {}, byModel: {} };
  assert.equal(applySessionUsageRow(agentUsage, record('model-a', USAGE)), true);
  assert.equal(applySessionUsageRow(agentUsage, record('model-a', USAGE)), true);
  assert.equal(applySessionUsageRow(agentUsage, {
    type: 'context.append_loop_event',
    event: { type: 'step.end', usage: USAGE },
  }), false);
  assert.deepEqual(agentUsage.byModel['model-a'], {
    inputOther: 200,
    inputCacheRead: 600,
    inputCacheCreation: 40,
    output: 80,
  });
});

test('dedicated usage readers rebuild and combine the complete all-agent session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-session-usage-'));
  const state = { sessionUsage: emptySessionUsageState() };
  const paths = {
    main: path.join(root, 'main.jsonl'),
    agent: path.join(root, 'agent.jsonl'),
  };
  fs.writeFileSync(paths.main, `${JSON.stringify(record('openai/gpt-5.6', USAGE))}\n`);
  fs.writeFileSync(paths.agent, `${JSON.stringify(record('openai/gpt-5.6', {
    inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 5,
  }))}\n`);

  for (const [agent, wirePath] of Object.entries(paths)) {
    const stat = fs.statSync(wirePath);
    const result = advanceSessionUsageAgent({
      state,
      agent,
      wirePath,
      fileId: `${stat.dev}:${stat.ino}`,
      fileSize: stat.size,
      maxBytes: stat.size,
    });
    assert.equal(result.complete, true);
  }
  state.sessionUsage.complete = true;
  assert.deepEqual(sessionUsageMetricFromState(state, new Set(['main', 'agent'])), {
    scope: 'session',
    agents: 'all',
    byModel: {
      'openai/gpt-5.6': {
        inputOther: 110,
        inputCacheRead: 300,
        inputCacheCreation: 20,
        output: 45,
      },
    },
  });
});

test('a replaced wire resets only that agent ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-session-usage-replace-'));
  const wirePath = path.join(root, 'wire.jsonl');
  const state = { sessionUsage: emptySessionUsageState() };
  fs.writeFileSync(wirePath, `${JSON.stringify(record('old', USAGE))}\n`);
  let stat = fs.statSync(wirePath);
  advanceSessionUsageAgent({
    state, agent: 'main', wirePath, fileId: `${stat.dev}:${stat.ino}`,
    fileSize: stat.size, maxBytes: stat.size,
  });
  const replacementPath = path.join(root, 'replacement.jsonl');
  fs.writeFileSync(replacementPath, `${JSON.stringify(record('new', USAGE))}\n`);
  fs.renameSync(replacementPath, wirePath);
  stat = fs.statSync(wirePath);
  advanceSessionUsageAgent({
    state, agent: 'main', wirePath, fileId: `${stat.dev}:${stat.ino}`,
    fileSize: stat.size, maxBytes: stat.size,
  });
  assert.deepEqual(Object.keys(state.sessionUsage.agents.main.byModel), ['new']);
});
