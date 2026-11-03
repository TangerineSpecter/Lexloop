import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { withProviderTemperature, type ProviderTemperatureConfig } from './model-temperature';

/** Only the explicit MiniMax provider gets protocol changes; custom endpoints retain their contract. */
export function withProviderRequest<T extends Record<string, unknown>>(
  request: T,
  config?: ProviderTemperatureConfig | null,
): Record<string, unknown> {
  const prepared = withProviderTemperature(request, config);
  if (config?.provider !== 'MINIMAX') return prepared;
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = prepared[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32768)
    ) {
      throw new BadRequestException(`MiniMax ${key} 必须是 1 到 32768 之间的有限正整数。`);
    }
  }
  const { temperature, top_p, response_format, max_tokens, ...rest } = prepared;
  return {
    ...rest,
    reasoning_split: true,
    reasoning_effort: 'low',
    // MiniMax counts reasoning in the output budget. Reserve room without unbounded generation.
    max_completion_tokens:
      rest.max_completion_tokens ?? Math.max(16384, (max_tokens as number | undefined) ?? 0),
  };
}

function sanitizeMiniMax(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object')
    throw new BadGatewayException('MiniMax 返回了无效响应。');
  const value = payload as Record<string, any>;
  if (value.base_resp?.status_code != null && value.base_resp.status_code !== 0) {
    throw new BadGatewayException('MiniMax 未完成请求，请检查账号额度、模型与接口配置。');
  }
  if (value.error) throw new BadGatewayException('MiniMax 未完成请求，请稍后重试。');
  const choices = Array.isArray(value.choices)
    ? value.choices.map((choice: any) => {
        if (choice.finish_reason === 'length') {
          throw new BadGatewayException(
            'MiniMax 输出达到长度上限，结果不完整；请缩小生成范围后重试。',
          );
        }
        const clean = (message: any) => {
          if (!message || typeof message !== 'object') return message;
          const { reasoning_content, ...visible } = message;
          return visible;
        };
        return {
          ...choice,
          ...(choice.message ? { message: clean(choice.message) } : {}),
          ...(choice.delta ? { delta: clean(choice.delta) } : {}),
        };
      })
    : value.choices;
  const { base_resp, ...safe } = value;
  return { ...safe, ...(choices ? { choices } : {}) };
}

export async function normalizeProviderResponse(
  response: Response,
  config?: ProviderTemperatureConfig | null,
): Promise<Response> {
  if (config?.provider !== 'MINIMAX' || !response.ok) return response;
  if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const emit = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        else {
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            throw new BadGatewayException('MiniMax 流式响应格式无效。');
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(sanitizeMiniMax(payload))}\n\n`),
          );
        }
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 2 * 1024 * 1024)
            throw new BadGatewayException('MiniMax 响应超过读取上限。');
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          frames.forEach((frame) => emit(frame, controller));
        },
        flush(controller) {
          buffer += decoder.decode();
          if (buffer.trim()) emit(buffer, controller);
        },
      }),
    );
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (!response.body) throw new BadGatewayException('MiniMax 返回了空响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new BadGatewayException('MiniMax 响应超过读取上限。');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BadGatewayException('MiniMax 响应不是有效 JSON。');
  }
  return Response.json(sanitizeMiniMax(payload));
}
