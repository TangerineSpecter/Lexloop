import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrentStudyContentBankRequest } from '../lib/study-content-bank-request.ts';

const request = { sequence: 7, userId: 'user-a', accessToken: 'token-a' };

test('study content bank responses require the same request, account, and token', () => {
  assert.equal(isCurrentStudyContentBankRequest(request, { ...request }), true);
  assert.equal(
    isCurrentStudyContentBankRequest(request, { ...request, sequence: request.sequence + 1 }),
    false,
    'a newer filter request invalidates an older response',
  );
  assert.equal(
    isCurrentStudyContentBankRequest(request, { ...request, userId: 'user-b' }),
    false,
    'an account switch invalidates the previous account response',
  );
  assert.equal(
    isCurrentStudyContentBankRequest(request, { ...request, accessToken: 'token-b' }),
    false,
    'a refreshed or replaced session token invalidates the previous response',
  );
});
