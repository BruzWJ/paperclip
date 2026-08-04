export function buildNewAgentRuntimeConfig(input?: {
  cheapModel?: string;
  cheapModelEnabled?: boolean;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  const cheapModel = input?.cheapModel?.trim() ?? "";
  const cheapEnabled = input?.cheapModelEnabled ?? false;
  if (cheapModel && cheapEnabled) {
    config.modelProfiles = {
      cheap: {
        enabled: true,
        adapterConfig: { model: cheapModel },
      },
    };
  }

  return config;
}
