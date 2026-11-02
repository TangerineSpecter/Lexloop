import { describe, expect, it } from 'vitest';
import { withProviderTemperature } from '../src/modules/ai/model-temperature';

describe('provider temperature policy', () => {
  const request = {
    model: 'selected-model',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    response_format: { type: 'json_object' },
  };

  it('omits temperature for custom OpenAI when no model-specific value is configured', () => {
    const body = withProviderTemperature(request, {
      provider: 'OPENAI_COMPATIBLE',
      temperature: null,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses a legal explicit model value in place of each call-site default', () => {
    const body = withProviderTemperature(request, {
      provider: 'OPENAI_COMPATIBLE',
      temperature: 0.65,
    });
    expect(body.temperature).toBe(0.65);
  });

  it('preserves legacy per-call temperatures for DeepSeek and unconfigured providers', () => {
    expect(withProviderTemperature(request, { provider: 'DEEPSEEK', temperature: null })).toEqual(
      request,
    );
    expect(withProviderTemperature(request)).toEqual(request);
  });
});
