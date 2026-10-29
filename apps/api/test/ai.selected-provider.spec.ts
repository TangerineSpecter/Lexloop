import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/modules/ai/ai.service';

describe('AiService selected provider requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses only the authenticated learner selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const selected = {
      baseUrl: 'https://selected.example.test/v1/',
      model: 'learner-model',
      apiKey: 'selected-key',
      provider: 'OPENAI_COMPATIBLE',
    };
    const models = { selectedProvider: vi.fn().mockResolvedValue(selected) };
    const service = new AiService({ get: vi.fn() } as never, models as never);
    const controller = new AbortController();

    await service.selectedChatCompletions(
      { model: 'unselected-model', messages: [{ role: 'user', content: 'feedback' }] },
      'learner-a',
      controller.signal,
    );

    expect(models.selectedProvider).toHaveBeenCalledWith('learner-a');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://selected.example.test/v1/chat/completions',
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: 'Bearer selected-key' }),
        body: JSON.stringify({
          model: 'learner-model',
          messages: [{ role: 'user', content: 'feedback' }],
        }),
      }),
    );
  });

  it('does not fall back to a global model when the learner has not selected one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn(() => 'global-key') } as never,
      { selectedProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      service.selectedChatCompletions(
        { messages: [{ role: 'user', content: 'feedback' }] },
        'learner-a',
      ),
    ).rejects.toMatchObject({ constructor: ServiceUnavailableException });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
