export type ProviderTemperatureConfig = {
  provider?: string;
  temperature?: number | null;
};

export function withProviderTemperature<T extends Record<string, unknown>>(
  request: T,
  config?: ProviderTemperatureConfig | null,
): T {
  if (typeof config?.temperature === 'number') {
    return { ...request, temperature: config.temperature } as T;
  }
  if (config?.provider !== 'OPENAI_COMPATIBLE') return request;
  const { temperature: _ignored, ...withoutTemperature } = request;
  return withoutTemperature as T;
}
