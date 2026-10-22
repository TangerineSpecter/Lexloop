import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradeOutput } from '../src/modules/practice/output.processor';

afterEach(() => vi.unstubAllGlobals());

// Opt in with isolated Redis. A unique prefix keeps this fixture's jobs apart
// from every other queue; cleanup never flushes Redis or shared application data.
describe.skipIf(!process.env.PRACTICE_TEST_REDIS_URL)('output lease recovery queue', () => {
  it('reschedules an occupied lease without exhausting the only allowed attempt', async () => {
    const connection = { url: process.env.PRACTICE_TEST_REDIS_URL! };
    const prefix = `practice-test-${randomUUID()}`;
    const queue = new Queue('practice-output', { connection, prefix });
    const events = new QueueEvents('practice-output', { connection, prefix });
    const attempts: number[] = [];
    const service = {
      claim: vi
        .fn()
        .mockImplementationOnce(async () => ({ done: false, waitUntil: Date.now() + 150 }))
        .mockResolvedValue({
          done: false,
          leaseToken: 'recovered-lease',
          auditId: 'audit',
          provider: { baseUrl: 'https://example.invalid', model: 'mock', apiKey: 'test-only' },
          messages: [],
        }),
      complete: vi.fn().mockResolvedValue({ done: true }),
      fail: vi.fn().mockResolvedValue({ done: true }),
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{"grammarScore":80}' } }] }),
      );
    vi.stubGlobal('fetch', fetch);
    const worker = new Worker(
      'practice-output',
      async (job) => {
        attempts.push(job.attemptsMade);
        return gradeOutput(job, service as never);
      },
      { connection, prefix },
    );
    try {
      await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
      const job = await queue.add(
        'grade-output',
        {
          submissionId: 'submission1',
          workerToken: 'a'.repeat(64),
        },
        { attempts: 1 },
      );
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({ done: true });
      expect(attempts).toEqual([0, 0]);
      expect(service.claim).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(service.complete).toHaveBeenCalledTimes(1);
      expect(service.fail).toHaveBeenCalledTimes(1);
      expect(service.fail.mock.calls[0][5]).toBe(true);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 15_000);
});
