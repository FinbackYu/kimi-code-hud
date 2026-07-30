import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parsePayload, readPayload } from '../src/payload.mjs';

const SAMPLE = '{"model":"K3","cwd":"/abs/path","gitBranch":"main","permissionMode":"manual","planMode":false,"contextUsage":0.04,"contextTokens":10000,"maxContextTokens":262144,"sessionId":"21b1bdb2-250a-45ac-9be2-727fbec97926","version":"0.31.0"}';

test('parsePayload parses the host snapshot', () => {
  const p = parsePayload(SAMPLE);
  assert.equal(p.model, 'K3');
  assert.equal(p.gitBranch, 'main');
  assert.equal(p.planMode, false);
  assert.equal(p.contextTokens, 10000);
});

test('parsePayload tolerates null gitBranch and junk input', () => {
  assert.equal(parsePayload('{"model":"K3","gitBranch":null}').gitBranch, null);
  assert.equal(parsePayload(''), null);
  assert.equal(parsePayload('not json'), null);
  assert.equal(parsePayload('[1,2]'), null);
  assert.equal(parsePayload('null'), null);
  assert.equal(parsePayload(undefined), null);
});

test('readPayload reads a piped snapshot', async () => {
  const stdin = new PassThrough();
  const promise = readPayload({ stdin, timeoutMs: 1000 });
  stdin.end(SAMPLE);
  const p = await promise;
  assert.equal(p.sessionId, '21b1bdb2-250a-45ac-9be2-727fbec97926');
});

test('readPayload survives immediate EOF with no data', async () => {
  const stdin = new PassThrough();
  const promise = readPayload({ stdin, timeoutMs: 100 });
  stdin.end();
  assert.equal(await promise, null);
});

test('readPayload times out gracefully on a silent stream', async () => {
  const stdin = new PassThrough();
  const p = await readPayload({ stdin, timeoutMs: 50 });
  assert.equal(p, null);
});
