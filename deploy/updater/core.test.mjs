import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVersions,
  evaluateUpdate,
  parseStableVersion,
  selectLatestRelease,
} from './core.mjs';

test('accepts stable versions and ignores prereleases', () => {
  assert.equal(parseStableVersion('v1.2.3')?.version, '1.2.3');
  assert.equal(parseStableVersion('1.2.3-beta.1'), null);
  assert.equal(parseStableVersion('01.2.3'), null);
});

test('sorts versions numerically and requires annotated tags', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.deepEqual(
    selectLatestRelease([
      { tag: 'v1.9.0', annotated: true, sha: 'a' },
      { tag: 'v2.0.0-beta.1', annotated: true, sha: 'b' },
      { tag: 'v3.0.0', annotated: false, sha: 'c' },
      { tag: 'v1.10.0', annotated: true, sha: 'd' },
    ]),
    { tag: 'v1.10.0', annotated: true, sha: 'd' },
  );
});

test('detects a moved same-version tag by commit sha', () => {
  assert.deepEqual(
    evaluateUpdate('1.0.0', 'a'.repeat(40), { version: '1.0.0', sha: 'b'.repeat(40) }, true),
    { updateAvailable: true, sameVersionRevision: true },
  );
});

test('blocks downgrade, unrelated commits and unchanged releases', () => {
  assert.equal(
    evaluateUpdate('2.0.0', 'b'.repeat(40), { version: '1.9.0', sha: 'a'.repeat(40) }, true)
      .updateAvailable,
    false,
  );
  assert.equal(
    evaluateUpdate('1.0.0', 'a'.repeat(40), { version: '1.1.0', sha: 'b'.repeat(40) }, false)
      .updateAvailable,
    false,
  );
  assert.equal(
    evaluateUpdate('1.0.0', 'a'.repeat(40), { version: '1.0.0', sha: 'a'.repeat(40) }, true)
      .updateAvailable,
    false,
  );
});
