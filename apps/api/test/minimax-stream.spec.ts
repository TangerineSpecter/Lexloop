import { describe, expect, it, vi } from 'vitest';
import {
  normalizeProviderResponse,
  withProviderRequest,
} from '../src/modules/ai/provider-protocol';
import { forwardChatStream } from '../src/modules/ai/chat-stream';
import { TutorService } from '../src/modules/ai/tutor.service';

const mini = { provider: 'MINIMAX' };
const delta =
  'data: {"choices":[{"index":0,"delta":{"content":"保留的部分"},"finish_reason":null}]}\n\n';
const finish = (reason: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
const response = (source: string, split = 7) => {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + split));
        offset += split;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

describe('MiniMax completion boundary and SSE termination', () => {
  it.each([NaN, Infinity, -Infinity])('rejects non-finite internal budgets %s', (value) => {
    for (const key of ['max_tokens', 'max_completion_tokens'])
      expect(() => withProviderRequest({ [key]: value }, mini)).toThrow('有限正整数');
  });
  it.each(['stop', 'tool_calls'])(
    'accepts split UTF-8 and normal %s completion',
    async (reason) => {
      const result = await normalizeProviderResponse(
        response(delta + finish(reason) + 'data: [DONE]\n\n'),
        mini,
      );
      const text = await result.text();
      expect(text).toContain('保留的部分');
      expect(text).toContain(`"finish_reason":"${reason}"`);
      expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    },
  );
  it('accepts an explicit finish marker followed by EOF without an optional sentinel', async () => {
    const result = await normalizeProviderResponse(response(delta + finish('stop')), mini);
    expect(await result.text()).toContain('[DONE]');
  });
  it.each([
    ['', 'empty EOF'],
    [delta, 'EOF after partial text'],
    [delta + 'data: {"choices":', 'EOF inside JSON'],
    [delta + 'data: [DONE]\n\n', 'sentinel without a finish reason'],
    [delta + finish('length'), 'length limit'],
    [delta + finish('unknown'), 'unknown finish reason'],
    [delta + finish('stop').trimEnd(), 'unterminated finish frame'],
    [delta + finish('stop') + 'data: [DONE]\n\ndata: {}\n\n', 'data after sentinel'],
  ])('rejects %s (%s) and sends a safe public error without DONE', async (source) => {
    const result = await normalizeProviderResponse(response(source), mini);
    const chunks = [];
    for await (const chunk of forwardChatStream(result.body!)) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    expect(text).toContain('STREAM_INCOMPLETE');
    expect(text).not.toContain('[DONE]');
  });
  it('requires every observed choice to finish', async () => {
    const other = 'data: {"choices":[{"index":1,"delta":{"content":"unfinished"}}]}\n\n';
    const result = await normalizeProviderResponse(response(delta + other + finish('stop')), mini);
    await expect(result.text()).rejects.toThrow('未完整结束');
  });
  it('marks an interrupted tutor answer FAILED and emits error, never done', async () => {
    const tx = {
      tutorMessage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiCallAudit: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      tutorDailyUsage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const normalized = await normalizeProviderResponse(response(delta), mini);
    const ai = { selectedChatCompletions: vi.fn().mockResolvedValue(normalized) };
    const service = new TutorService(prisma as never, {} as never, ai as never, {} as never);
    const stream = (service as any).streamAnswer('user', [], 'message', 'audit', {
      remaining: 29,
      usageDate: new Date(),
    });
    const events: string[] = [];
    for await (const event of stream) events.push(event);
    expect(events.join('')).toContain('保留的部分');
    expect(events.join('')).toContain('event: error');
    expect(events.join('')).not.toContain('event: done');
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { content: '保留的部分', status: 'FAILED' } }),
    );
    expect(tx.aiCallAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });
});
