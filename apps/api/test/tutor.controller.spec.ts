import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TutorController } from '../src/modules/ai/tutor.controller';

function fixtureReply() {
  const raw = new EventEmitter() as EventEmitter & { writableEnded: boolean };
  raw.writableEnded = false;
  const reply = {
    raw,
    header: vi.fn().mockReturnThis(),
    send: vi.fn((stream: unknown) => stream),
  };
  return { raw, reply };
}

const request = { user: { sub: 'user-1' } };
const dto = {
  type: 'STUDY_GROUP' as const,
  planId: 'plan-1',
  groupIndex: 0,
  message: '给我一点提示',
};

describe('TutorController stream cancellation', () => {
  it('aborts provider work when the HTTP client closes before the stream finishes', async () => {
    let signal: AbortSignal | undefined;
    const tutor = {
      prepareMessage: vi.fn(
        async (_userId: string, _context: unknown, _message: string, value: AbortSignal) => {
          signal = value;
          return {
            stream: (async function* () {
              yield 'event: done\\n\\n';
            })(),
          };
        },
      ),
    };
    const controller = new TutorController(tutor as any);
    const { raw, reply } = fixtureReply();

    await controller.message(request as any, dto, reply as any);
    expect(signal?.aborted).toBe(false);
    expect(reply.send).toHaveBeenCalledOnce();

    raw.emit('close');
    expect(signal?.aborted).toBe(true);
  });

  it('does not abort a response that has finished normally', async () => {
    let signal: AbortSignal | undefined;
    const tutor = {
      prepareMessage: vi.fn(
        async (_userId: string, _context: unknown, _message: string, value: AbortSignal) => {
          signal = value;
          return {
            stream: (async function* () {
              yield 'event: done\\n\\n';
            })(),
          };
        },
      ),
    };
    const controller = new TutorController(tutor as any);
    const { raw, reply } = fixtureReply();

    await controller.message(request as any, dto, reply as any);
    raw.writableEnded = true;
    raw.emit('finish');
    raw.emit('close');

    expect(signal?.aborted).toBe(false);
  });

  it('finalizes a pending message when the client closes while preparation is in flight', async () => {
    let finishPreparation!: (value: { stream: AsyncGenerator<string> }) => void;
    let signal: AbortSignal | undefined;
    let streamStarted = false;
    let observedAborted = false;
    const tutor = {
      prepareMessage: vi.fn(
        (_userId: string, _context: unknown, _message: string, value: AbortSignal) => {
          signal = value;
          return new Promise<{ stream: AsyncGenerator<string> }>((resolve) => {
            finishPreparation = resolve;
          });
        },
      ),
    };
    const controller = new TutorController(tutor as any);
    const { raw, reply } = fixtureReply();
    const response = controller.message(request as any, dto, reply as any);
    raw.emit('close');
    expect(signal?.aborted).toBe(true);
    finishPreparation({
      stream: (async function* () {
        streamStarted = true;
        observedAborted = signal?.aborted ?? false;
      })(),
    });

    await response;
    expect(streamStarted).toBe(true);
    expect(observedAborted).toBe(true);
    expect(reply.send).not.toHaveBeenCalled();
  });
});
