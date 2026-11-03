import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProgressiveCompatibility } from './progressive-compatibility.mjs';
test('refuses pre-recovery releases when invalidated plans exist or evidence is unavailable', () => {
  for (const version of ['1.27.165', '1.0.0']) {
    assert.throws(() => assertProgressiveCompatibility(version, () => 't'), /INVALIDATED/);
    assert.throws(() => assertProgressiveCompatibility(version, () => ''), /无法核实/);
    assert.doesNotThrow(() => assertProgressiveCompatibility(version, () => 'f'));
  }
  assert.doesNotThrow(() =>
    assertProgressiveCompatibility('1.27.166', () => {
      throw Error('unnecessary read');
    }),
  );
});
