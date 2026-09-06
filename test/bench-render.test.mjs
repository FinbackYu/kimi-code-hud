import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// H09 measurement half: the benchmark script must RUN and produce a
// structurally valid result. Absolute latencies are machine-specific by
// design and must never be asserted here — only shape, schema and internal
// consistency of the report. One sample per row keeps the suite fast; use
// scripts/bench-render.mjs directly (or npm run bench) for real baselines.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'bench-render.mjs',
);

test('bench-render produces a structurally valid JSON report (no timing assertions)', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--samples', '1', '--json', '--scenario', 'cold-cache', '--scenario', 'warm-cache'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.equal(report.schema, 'hud-bench-render/v1');
  assert.equal(typeof report.meta.measuredAt, 'string');
  assert.equal(report.meta.bin, 'bin/kimi-hud.mjs');
  assert.equal(report.meta.samplesPerRow, 1);
  assert.equal(report.meta.thresholds.internalBudgetMs, 220);
  assert.equal(report.meta.thresholds.hostCeilingMs, 300);
  assert.ok(report.meta.env.nodeVersion.startsWith('v'));
  assert.ok(Number.isInteger(report.meta.env.cpuCount) && report.meta.env.cpuCount >= 1);
  assert.equal(typeof report.meta.env.osType, 'string');

  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.name),
    ['cold-cache', 'warm-cache'],
  );
  for (const scenario of report.scenarios) {
    assert.equal(typeof scenario.description, 'string');
    assert.ok(scenario.rows.length >= 1);
    for (const row of scenario.rows) {
      assert.equal(row.unit, 'ms');
      assert.ok(row.n >= 1, `${row.row}: expected at least one valid sample`);
      assert.equal(row.failures, 0, `${row.row}: render must not fail`);
      assert.ok(row.min <= row.p50, `${row.row}: min <= p50`);
      assert.ok(row.p50 <= row.p95, `${row.row}: p50 <= p95`);
      assert.ok(row.p95 <= row.p99, `${row.row}: p95 <= p99`);
      assert.ok(row.p99 <= row.max, `${row.row}: p99 <= max`);
      assert.ok(row.over220 <= row.n && row.over300 <= row.n, `${row.row}: overflow counts <= n`);
      assert.ok(Number.isFinite(row.meta.wireBytes) && row.meta.wireBytes > 0);
    }
  }
});
