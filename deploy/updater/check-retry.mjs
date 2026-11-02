export const REPOSITORY_CHECK_MAX_ATTEMPTS = 3;
export const REPOSITORY_CHECK_ATTEMPT_TIMEOUT_MS = 20_000;
export const REPOSITORY_CHECK_TOTAL_TIMEOUT_MS = 65_000;
export const REPOSITORY_CHECK_BACKOFF_MS = [300, 900];

const DEFAULT_OPTIONS = {
  maxAttempts: REPOSITORY_CHECK_MAX_ATTEMPTS,
  attemptTimeoutMs: REPOSITORY_CHECK_ATTEMPT_TIMEOUT_MS,
  totalTimeoutMs: REPOSITORY_CHECK_TOTAL_TIMEOUT_MS,
  backoffMs: REPOSITORY_CHECK_BACKOFF_MS,
};

export class RepositoryCheckError extends Error {
  constructor({ code, message, attempts, retryable = false }) {
    super(message);
    this.name = 'RepositoryCheckError';
    this.code = code;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export function classifyRepositoryFetchError(error, attempts = 1) {
  if (error instanceof RepositoryCheckError) return error;
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/GnuTLS recv error \(-110\)|TLS connection (?:was )?not properly terminated/i.test(text)) {
    return new RepositoryCheckError({
      code: 'GIT_TLS_INTERRUPTED',
      message: 'GitHub TLS 连接中断（GnuTLS -110）；已有限重试，远端版本尚未确认。',
      attempts,
      retryable: true,
    });
  }
  if (/timed? ?out|timeout|ETIMEDOUT|SIGKILL/i.test(text)) {
    return new RepositoryCheckError({
      code: 'GIT_FETCH_TIMEOUT',
      message: '连接 GitHub 超时；已有限重试，远端版本尚未确认。',
      attempts,
      retryable: true,
    });
  }
  if (
    /could not resolve host|temporary failure in name resolution|failed to connect|connection reset by peer|connection refused|network is unreachable|empty reply from server|curl (?:52|56):|early EOF|remote end hung up unexpectedly/i.test(
      text,
    ) ||
    /(?:requested URL returned error|HTTP(?: response)?)[^\n]{0,24}\b(?:408|500|502|503|504)\b/i.test(
      text,
    )
  ) {
    return new RepositoryCheckError({
      code: 'GIT_NETWORK_INTERRUPTED',
      message: '与 GitHub 的网络连接中断；已有限重试，远端版本尚未确认。',
      attempts,
      retryable: true,
    });
  }
  if (
    /authentication failed|could not read username|permission denied|http basic: access denied/i.test(
      text,
    )
  ) {
    return new RepositoryCheckError({
      code: 'GIT_AUTH_FAILED',
      message: '读取受信任 GitHub 仓库时认证或权限不足；未自动重试。',
      attempts,
    });
  }
  if (
    /repository .* not found|repository not found|部署仓库尚未初始化|仓库地址与受信任仓库不一致/i.test(
      text,
    )
  ) {
    return new RepositoryCheckError({
      code: 'GIT_REPOSITORY_UNAVAILABLE',
      message: '无法读取已配置的受信任仓库；未自动重试。',
      attempts,
    });
  }
  return new RepositoryCheckError({
    code: 'GIT_FETCH_FAILED',
    message: '读取受信任仓库失败；请查看 updater 日志，未自动重试。',
    attempts,
  });
}

export async function retryRepositoryFetch(fetchOnce, overrides = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const startedAt = now();
  const deadline = startedAt + options.totalTimeoutMs;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new RepositoryCheckError({
        code: 'GIT_CHECK_TIMEOUT',
        message: '更新检查超过总时限；远端版本尚未确认。',
        attempts: attempt - 1,
        retryable: false,
      });
    }

    const attemptTimeoutMs = Math.max(1, Math.min(options.attemptTimeoutMs, remainingMs));
    let attemptTimedOut = false;
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    options.signal?.addEventListener('abort', abortAttempt, { once: true });
    let timeoutId;
    let rejectTimeout;
    const operation = Promise.resolve().then(() =>
      fetchOnce({ attempt, timeoutMs: attemptTimeoutMs, signal: attemptController.signal }),
    );
    // Keep the child process (and its repository lock) from overlapping a retry.
    operation.catch(() => {});
    const timeout = new Promise((_, reject) => {
      rejectTimeout = reject;
      timeoutId = setTimeout(() => {
        attemptTimedOut = true;
        attemptController.abort();
        rejectTimeout(new Error(`Git fetch timed out after ${attemptTimeoutMs} ms`));
      }, attemptTimeoutMs);
    });

    try {
      await Promise.race([operation, timeout]);
      return { attempts: attempt };
    } catch (error) {
      if (attemptTimedOut) await operation.catch(() => {});
      if (options.signal?.aborted) throw abortError();
      const classified = classifyRepositoryFetchError(
        attemptTimedOut ? new Error('Git fetch timed out') : error,
        attempt,
      );
      if (!classified.retryable || attempt >= options.maxAttempts) throw classified;

      const delayMs = options.backoffMs[attempt - 1] ?? 0;
      if (now() + delayMs >= deadline) throw classified;
      try {
        await sleep(delayMs, options.signal);
      } catch {
        if (options.signal?.aborted) throw abortError();
        throw classified;
      }
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abortAttempt);
    }
  }

  throw new RepositoryCheckError({
    code: 'GIT_CHECK_TIMEOUT',
    message: '更新检查超过总时限；远端版本尚未确认。',
    attempts: options.maxAttempts,
  });
}

function abortError() {
  return Object.assign(new Error('更新检查已停止等待'), { name: 'AbortError' });
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
