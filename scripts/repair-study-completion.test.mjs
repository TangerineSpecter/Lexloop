import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from './repair-study-completion.mjs';
test('completion repair requires explicit target, reviewed manifest and confirmation', () => {
  assert.throws(() => parseArguments(['scan']), /Explicit/);
  assert.throws(
    () => parseArguments(['apply', '--database-url-env', 'LAB_TEST_DATABASE_URL']),
    /manifest/,
  );
  assert.throws(
    () => parseArguments(['scan', '--database-url-env', 'LAB_TEST_DATABASE_URL', '--limit', '101']),
    /limit/,
  );
  assert.equal(
    parseArguments([
      'preview',
      '--database-url-env',
      'LAB_TEST_DATABASE_URL',
      '--plan-id',
      'fixture',
      '--out',
      '/tmp/fixture.json',
    ]).command,
    'preview',
  );
  assert.equal(
    parseArguments([
      'apply',
      '--database-url-env',
      'LAB_TEST_DATABASE_URL',
      '--manifest',
      '/tmp/fixture.json',
      '--confirm',
      'REPAIR_COMPLETION_METADATA',
    ]).command,
    'apply',
  );
});
