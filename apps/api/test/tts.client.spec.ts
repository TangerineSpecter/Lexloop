import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtsRegion } from '@prisma/client';
import { MiniMaxTtsClient, MiniMaxTtsError } from '../src/modules/tts/minimax-tts.client';

const settings = {
  apiKey: 'secret-test-key',
  region: TtsRegion.CHINA,
  model: 'speech-2.8-hd',
  voiceId: 'English_captivating_female1',
  speed: 1,
  volume: 1,
  pitch: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MiniMaxTtsClient', () => {
  it('waits for dispatch persistence and never fetches on rejection or an expired lease after the wait', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const lease = {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      safetyMarginMs: 1,
      onDispatch: async () => {
        await hold;
        throw new Error('barrier unconfirmed');
      },
    };
    const pending = new MiniMaxTtsClient().synthesize('hello', settings, lease);
    const rejected = expect(pending).rejects.toThrow('barrier unconfirmed');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    unblock();
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    const expiring = {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      safetyMarginMs: 1,
      onDispatch: async () => {
        expiring.leaseExpiresAt = new Date(0);
      },
    };
    await expect(
      new MiniMaxTtsClient().synthesize('hello', settings, expiring),
    ).rejects.toMatchObject({ code: 'TTS_LEASE_EXPIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the documented T2A v2 payload and decodes hex audio', async () => {
    const audioHex = Buffer.alloc(128, 0x35).toString('hex');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audioHex } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const audio = await new MiniMaxTtsClient().synthesize('Hello, world.', settings);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimaxi.com/v1/t2a_v2',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-test-key' }),
        body: JSON.stringify({
          model: 'speech-2.8-hd',
          text: 'Hello, world.',
          stream: false,
          voice_setting: {
            voice_id: 'English_captivating_female1',
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32_000,
            bitrate: 128_000,
            format: 'mp3',
            channel: 1,
          },
          language_boost: 'auto',
          output_format: 'hex',
        }),
      }),
    );
    expect(audio).toEqual(Buffer.alloc(128, 0x35));
  });

  it('uses only the selected official region host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: { audio: Buffer.alloc(64).toString('hex') },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MiniMaxTtsClient().synthesize('Hello.', { ...settings, region: TtsRegion.GLOBAL });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/t2a_v2');
  });

  it('caps the request timeout to the lease remaining after its safety margin', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const calls: string[] = [];
    const fetchMock = vi.fn(async () => {
      calls.push('fetch');
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: { audio: Buffer.alloc(64, 0x35).toString('hex') },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDispatch = vi.fn(() => {
      calls.push('dispatch');
    });

    await new MiniMaxTtsClient().synthesize('Hello.', settings, {
      leaseExpiresAt: new Date(120_000),
      safetyMarginMs: 15_000,
      onDispatch,
    });

    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['dispatch', 'fetch']);
  });

  it('does not dispatch when the lease expires before the safety margin', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onDispatch = vi.fn();

    await expect(
      new MiniMaxTtsClient().synthesize('Hello.', settings, {
        leaseExpiresAt: new Date(114_999),
        safetyMarginMs: 15_000,
        onDispatch,
      }),
    ).rejects.toMatchObject({
      code: 'TTS_LEASE_EXPIRED',
      publicReason: expect.stringContaining('本次没有发起模型请求'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('maps provider failures without returning its raw body or credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            base_resp: { status_code: 1004, status_msg: 'secret-test-key private text' },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(new MiniMaxTtsClient().synthesize('private text', settings)).rejects.toMatchObject(
      {
        code: 'TTS_PROVIDER_1004',
        publicReason: '语音服务未接受本次请求，请检查模型、音色和参数配置。',
      },
    );
  });

  it('rejects malformed audio responses and never embeds response data in the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: 'xyz' } }), {
          status: 200,
        }),
      ),
    );

    await expect(new MiniMaxTtsClient().synthesize('Hello.', settings)).rejects.toMatchObject({
      code: 'TTS_AUDIO_MISSING',
    });
  });

  it('maps non-JSON errors to a fixed message and rejects redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('private html secret-test-key', { status: 502 }))
      .mockRejectedValueOnce(
        Object.assign(new Error('redirect to private URL'), { name: 'TypeError' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new MiniMaxTtsClient();

    await expect(client.synthesize('Hello.', settings)).rejects.toMatchObject({
      code: 'TTS_HTTP_502',
      publicReason: '语音服务暂时不可用，请稍后手动重试。',
    });
    await expect(client.synthesize('Hello.', settings)).rejects.toBeInstanceOf(MiniMaxTtsError);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('private URL');
  });
});
