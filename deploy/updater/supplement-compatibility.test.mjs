import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupplementCompatibility } from './supplement-compatibility.mjs';
test('refuses old releases after supplementation, including paused installations', () => {
  for (const version of ['1.27.156', '1.0.0', '0.9.0']) {
    assert.throws(() => assertSupplementCompatibility(version, () => 't'), /禁止启动/);
    assert.throws(() => assertSupplementCompatibility(version, () => ''), /无法核实/);
    assert.doesNotThrow(() => assertSupplementCompatibility(version, () => 'f'));
  }
  for (const version of ['1.27.157', '1.28.0', '2.0.0'])
    assert.doesNotThrow(() =>
      assertSupplementCompatibility(version, () => {
        throw Error('unnecessary read');
      }),
    );
});
