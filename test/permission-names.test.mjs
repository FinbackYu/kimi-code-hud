import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderHud } from '../src/render.mjs';
import { permissionNamesFromSnapshot } from '../src/runtime-snapshot.mjs';

test('resolver: env beats config.json, unknown values fall through, default official', () => {
  assert.equal(permissionNamesFromSnapshot({}, {}), 'official');
  assert.equal(permissionNamesFromSnapshot({}, { KIMI_HUD_PERMISSION_NAMES: 'short' }), 'short');
  assert.equal(permissionNamesFromSnapshot({}, { KIMI_HUD_PERMISSION_NAMES: 'official' }), 'official');
  // An unknown env value falls through to config.json instead of winning.
  assert.equal(
    permissionNamesFromSnapshot(
      { hudConfig: { permissionNames: 'short' } },
      { KIMI_HUD_PERMISSION_NAMES: 'bogus' },
    ),
    'short',
  );
  // An unknown config value and a missing snapshot (unreadable config.json)
  // both land on the default.
  assert.equal(permissionNamesFromSnapshot({ hudConfig: { permissionNames: 'yolo' } }, {}), 'official');
  assert.equal(permissionNamesFromSnapshot({ hudConfig: {} }, {}), 'official');
  assert.equal(permissionNamesFromSnapshot(null, {}), 'official');
});

function namingCtx(permissionNames, permissionMode) {
  return {
    payload: { model: 'K3', permissionMode },
    permissionNames,
    color: false,
    now: 0,
  };
}

test('render: unknown ctx naming fails closed to official labels', () => {
  const [line] = renderHud(namingCtx('bogus', 'yolo'));
  assert.ok(line.startsWith('[Ask When Needed] '));
});

test('render: short naming keeps the historical compact badges', () => {
  const [yolo] = renderHud(namingCtx('short', 'yolo'));
  assert.ok(yolo.startsWith('[yolo] '));
  const [auto] = renderHud(namingCtx('short', 'auto'));
  assert.ok(auto.startsWith('[auto] '));
  const [manual] = renderHud(namingCtx('short', 'manual'));
  assert.ok(manual.startsWith('[manual] '));
});

test('render: manual badge renders in the faded-blue dim slot in both namings', () => {
  for (const permissionNames of ['official', 'short']) {
    const [line] = renderHud({ ...namingCtx(permissionNames, 'manual'), color: true });
    const label = permissionNames === 'short' ? '[manual]' : '[Always Ask]';
    assert.ok(line.includes(`\x1b[38;2;84;101;138m${label}\x1b[0m`));
    assert.ok(!line.includes(`\x1b[90m${label}`));
  }
});
