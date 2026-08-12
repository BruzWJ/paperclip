export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, string | boolean>;
  runtime: Record<string, unknown>;
}

export function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(
  currentAdapterConfig: Readonly<Record<string, string | boolean>>,
  overlay: AgentConfigOverlay,
) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? { ...overlay.adapterConfig }
        : {
            ...currentAdapterConfig,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
