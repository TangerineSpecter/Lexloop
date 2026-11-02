import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRepositoryFetchError, retryRepositoryFetch } from './check-retry.mjs';

test('retries a transient GnuTLS interruption and returns the successful attempt count', async () => {
  let attempts = 0;
  const result = await retryRepositoryFetch(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error(
        "fatal: unable to access 'https://github.com/example/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
      );
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { attempts: 2 });
});

test('does not retry repository authentication or address failures', () => {
  const authentication = classifyRepositoryFetchError(
    new Error('fatal: Authentication failed for https://github.com/example/private.git'),
  );
  const missingRepository = classifyRepositoryFetchError(
    new Error("fatal: repository 'https://github.com/example/missing.git/' not found"),
  );

  assert.equal(authentication.code, 'GIT_AUTH_FAILED');
  assert.equal(authentication.retryable, false);
  assert.equal(missingRepository.code, 'GIT_REPOSITORY_UNAVAILABLE');
  assert.equal(missingRepository.retryable, false);
  assert.doesNotMatch(authentication.message, /github\.com|private\.git/i);
});

test('caps repeated transient failures by attempt count and per-attempt timeout', async () => {
  const startedAt = Date.now();
  let attempts = 0;
  await assert.rejects(
    retryRepositoryFetch(
      async ({ signal }) => {
        attempts += 1;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
      { attemptTimeoutMs: 12, totalTimeoutMs: 500, backoffMs: [5, 5] },
    ),
    (error) => error.code === 'GIT_FETCH_TIMEOUT' && error.attempts === 3,
  );
  assert.equal(attempts, 3);
  assert.ok(Date.now() - startedAt < 200, 'test timeout budget should remain bounded');
});

test('cancellation stops the current attempt and prevents retry', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const check = retryRepositoryFetch(
    async ({ signal }) => {
      attempts += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    { signal: controller.signal, attemptTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
  );
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(check, { name: 'AbortError' });
  assert.equal(attempts, 1);
});
