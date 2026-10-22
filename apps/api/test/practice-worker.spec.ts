import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import { gradeOutput } from '../src/modules/practice/output.processor';

const job = {
  data: { submissionId: 'submission1', workerToken: 'a'.repeat(64) },
  attemptsMade: 0,
  opts: { attempts: 3 },
};
const claim = {
  done: false,
  leaseToken: 'lease',
  auditId: 'audit',
  provider: { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'private-key' },
  messages: [{ role: 'user', content: 'learner draft' }],
};
afterEach(() => vi.unstubAllGlobals());
describe('output worker boundaries', () => {
  it('calls the Provider in the headless worker and commits only validated feedback', async () => {
    const service = {
      claim: vi.fn().mockResolvedValue(claim),
      complete: vi.fn().mockResolvedValue({ done: true }),
      fail: vi.fn().mockResolvedValue({ done: true }),
    };
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify({ grammarScore: 80 }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(gradeOutput(job as never, service as never)).resolves.toEqual({ done: true });
    expect(fetch.mock.calls[0][0]).toBe('https://model.example/v1/chat/completions');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer private-key');
    expect(service.complete).toHaveBeenCalledWith('submission1', 'a'.repeat(64), 'lease', {
      grammarScore: 80,
    });
    expect(service.fail).toHaveBeenCalledWith(
      'submission1',
      'a'.repeat(64),
      'lease',
      true,
      'audit',
      true,
    );
  });
  it('does not call a model again when a repeated job is already complete', async () => {
    const service = {
      claim: vi.fn().mockResolvedValue({ done: true }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await gradeOutput(job as never, service as never);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
  });
  it('waits for an existing lease without consuming retries or calling the model', async () => {
    const waitUntil = Date.now() + 120_000;
    const service = {
      claim: vi.fn().mockResolvedValue({ done: false, waitUntil }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    await expect(
      gradeOutput(
        { ...job, attemptsMade: 2, token: 'queue-lock', moveToDelayed } as never,
        service as never,
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(waitUntil, 'queue-lock');
    expect(service.fail).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('releases failed leases for retry and never includes raw provider errors in queue failures', async () => {
    const service = {
      claim: vi.fn().mockResolvedValue(claim),
      complete: vi.fn(),
      fail: vi.fn().mockResolvedValue({ done: true }),
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-key learner draft')));
    await expect(gradeOutput(job as never, service as never)).rejects.toThrow('输出批改未完成');
    expect(service.fail).toHaveBeenCalledWith(
      'submission1',
      'a'.repeat(64),
      'lease',
      false,
      'audit',
      false,
    );
    expect(service.complete).not.toHaveBeenCalled();
  });
});
