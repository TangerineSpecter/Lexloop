import { Injectable } from '@nestjs/common';
import { TtsRegion } from '@prisma/client';

export type MiniMaxTtsSettings = {
  apiKey: string;
  region: TtsRegion;
  model: string;
  voiceId: string;
  speed: number;
  volume: number;
  pitch: number;
};

export type MiniMaxTtsDispatchLease = {
  leaseExpiresAt: Date;
  safetyMarginMs: number;
  onDispatch?: () => void;
};

export class MiniMaxTtsError extends Error {
  constructor(
    readonly code: string,
    readonly publicReason: string,
  ) {
    super(publicReason);
    this.name = 'MiniMaxTtsError';
  }
}

const BASE_URLS: Record<TtsRegion, string> = {
  CHINA: 'https://api.minimaxi.com/v1/t2a_v2',
  GLOBAL: 'https://api.minimax.io/v1/t2a_v2',
};
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
export const MINIMAX_TTS_REQUEST_TIMEOUT_MS = 45_000;

@Injectable()
export class MiniMaxTtsClient {
  async synthesize(
    text: string,
    settings: MiniMaxTtsSettings,
    dispatchLease?: MiniMaxTtsDispatchLease,
  ): Promise<Buffer> {
    const body = JSON.stringify({
      model: settings.model,
      text,
      stream: false,
      voice_setting: {
        voice_id: settings.voiceId,
        speed: settings.speed,
        vol: settings.volume,
        pitch: settings.pitch,
      },
      audio_setting: {
        sample_rate: 32_000,
        bitrate: 128_000,
        format: 'mp3',
        channel: 1,
      },
      language_boost: 'auto',
      output_format: 'hex',
    });
    let timeoutMs = MINIMAX_TTS_REQUEST_TIMEOUT_MS;
    if (dispatchLease) {
      const leaseExpiresAtMs = dispatchLease.leaseExpiresAt.getTime();
      if (
        !Number.isFinite(leaseExpiresAtMs) ||
        !Number.isFinite(dispatchLease.safetyMarginMs) ||
        dispatchLease.safetyMarginMs < 0
      ) {
        throw new MiniMaxTtsError(
          'TTS_LEASE_EXPIRED',
          '语音生成租约剩余时间不足，本次没有发起模型请求；请重新点击播放。',
        );
      }
      const remainingMs = leaseExpiresAtMs - Date.now() - dispatchLease.safetyMarginMs;
      timeoutMs = Math.min(MINIMAX_TTS_REQUEST_TIMEOUT_MS, Math.floor(remainingMs));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new MiniMaxTtsError(
          'TTS_LEASE_EXPIRED',
          '语音生成租约剩余时间不足，本次没有发起模型请求；请重新点击播放。',
        );
      }
    }

    const request = {
      method: 'POST',
      redirect: 'error' as const,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    };
    dispatchLease?.onDispatch?.();

    let response: Response;
    try {
      response = await fetch(BASE_URLS[settings.region], request);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new MiniMaxTtsError('TTS_TIMEOUT', '语音生成超时，请稍后手动重试。');
      }
      throw new MiniMaxTtsError('TTS_NETWORK', '暂时无法连接语音服务，请检查网络或稍后重试。');
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new MiniMaxTtsError('TTS_RESPONSE_TOO_LARGE', '语音服务返回内容超出大小限制。');
    }
    const responseText = await readBoundedText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new MiniMaxTtsError(
        response.ok ? 'TTS_INVALID_RESPONSE' : `TTS_HTTP_${response.status}`,
        response.ok ? '语音服务返回了无法识别的结果。' : safeHttpReason(response.status),
      );
    }
    if (!response.ok) {
      throw new MiniMaxTtsError(`TTS_HTTP_${response.status}`, safeHttpReason(response.status));
    }

    const baseResponse = readRecord(payload, 'base_resp');
    const providerStatus = baseResponse?.status_code;
    if (typeof providerStatus === 'number' && providerStatus !== 0) {
      throw new MiniMaxTtsError(
        `TTS_PROVIDER_${providerStatus}`,
        '语音服务未接受本次请求，请检查模型、音色和参数配置。',
      );
    }
    const data = readRecord(payload, 'data');
    const audioHex = data?.audio;
    if (
      typeof audioHex !== 'string' ||
      audioHex.length < 2 ||
      audioHex.length % 2 !== 0 ||
      audioHex.length > MAX_RESPONSE_BYTES * 2 ||
      !/^[a-f0-9]+$/i.test(audioHex)
    ) {
      throw new MiniMaxTtsError('TTS_AUDIO_MISSING', '语音服务没有返回有效音频。');
    }
    const audio = Buffer.from(audioHex, 'hex');
    if (audio.length < 64 || audio.length > MAX_RESPONSE_BYTES) {
      throw new MiniMaxTtsError('TTS_AUDIO_INVALID', '语音服务返回的音频大小不符合要求。');
    }
    return audio;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MiniMaxTtsError('TTS_RESPONSE_TOO_LARGE', '语音服务返回内容超出大小限制。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (typeof source !== 'object' || source === null || !(key in source)) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function safeHttpReason(status: number) {
  if (status === 401 || status === 403) return '语音服务未接受认证，请检查已保存的 API Key。';
  if (status === 404) return '语音服务未找到请求接口或模型，请检查区域和模型配置。';
  if (status === 429) return '语音服务当前请求较多，请稍后手动重试。';
  if (status >= 500) return '语音服务暂时不可用，请稍后手动重试。';
  return '语音服务未接受本次请求，请检查模型、音色和参数配置。';
}
