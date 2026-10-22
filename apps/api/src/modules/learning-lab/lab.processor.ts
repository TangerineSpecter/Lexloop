import { DelayedError, type Job } from 'bullmq';
import type { LabService } from './lab.service';

type Task = { submissionId: string; workerToken: string };
type Claim = {
  done: boolean;
  waitUntil?: number;
  leaseToken?: string;
  auditId?: string;
  provider?: { baseUrl: string; model: string; apiKey: string };
  messages?: Array<{ role: string; content: string }>;
};

export async function generateLab(
  job: Job<Task>,
  service: Pick<LabService, 'claim' | 'complete' | 'fail'>,
) {
  const { submissionId, workerToken } = job.data;
  if (!/^[a-z0-9]+$/i.test(submissionId) || !/^[a-f0-9]{64}$/.test(workerToken))
    throw new Error('学习内容生成任务参数无效');
  let leaseToken: string | undefined;
  let auditId: string | undefined;
  try {
    const claim = (await service.claim(submissionId, workerToken)) as Claim;
    if (claim.done) return { done: true };
    if (claim.waitUntil !== undefined) {
      await job.moveToDelayed(claim.waitUntil, job.token);
      throw new DelayedError();
    }
    leaseToken = claim.leaseToken;
    auditId = claim.auditId;
    if (!leaseToken || !claim.provider || !claim.messages) throw new Error('生成任务不完整');
    const response = await fetch(`${claim.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${claim.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: claim.provider.model,
        messages: claim.messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        max_tokens: 5000,
      }),
    });
    if (!response.ok) throw new Error('模型生成暂时不可用，请检查模型配置');
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content || content.length > 60_000) throw new Error('模型没有返回有效生成结果');
    const feedback: unknown = JSON.parse(content);
    await service.complete(submissionId, workerToken, leaseToken, feedback);
    await service.fail(submissionId, workerToken, leaseToken, true, auditId, true);
    return { done: true };
  } catch (error) {
    // BullMQ treats this as a scheduled continuation, not a failed attempt.
    if (error instanceof DelayedError) throw error;
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await service
      .fail(submissionId, workerToken, leaseToken, final, auditId, false)
      .catch(() => undefined);
    // Never serialize Provider bodies, credentials, prompts, or learner answers in job errors.
    throw new Error('学习内容生成未完成，请检查模型或任务服务后重试');
  }
}
