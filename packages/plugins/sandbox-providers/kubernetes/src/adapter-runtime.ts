import type { AdapterRegistryEntry } from "./adapter-registry.js";

export interface AdapterRuntime {
  runtimeImage: string;
  allowFqdns: string[];
  probeCommand: string[];
}

function fromRegistryEntry(
  entry: AdapterRegistryEntry,
): AdapterRuntime {
  if (
    typeof entry.runtimeImage !== "string" ||
    entry.runtimeImage.length === 0 ||
    entry.runtimeImage !== entry.runtimeImage.trim()
  ) {
    throw new Error(
      `Adapter "${entry.adapterType}" is missing an exact runtimeImage`,
    );
  }
  return {
    runtimeImage: entry.runtimeImage,
    allowFqdns: entry.allowFqdns ?? [],
    probeCommand: entry.probeCommand ?? [],
  };
}

/**
 * Resolve one exact operator-declared runtime mapping. Kubernetes cannot
 * advertise agents: it only maps the ACPX-selected agent name for this run to
 * an image and target-specific network settings.
 */
export function requireAdapterRuntime(
  adapterType: string,
  registry: readonly AdapterRegistryEntry[] | undefined,
): AdapterRuntime {
  if (!registry || registry.length === 0) {
    throw new Error(
      "Kubernetes execution requires an explicit adapter runtime registry",
    );
  }
  const entry = registry.find(
    (candidate) =>
      candidate.adapterType === adapterType &&
      candidate.enabled !== false,
  );
  if (!entry) {
    throw new Error(
      `Adapter "${adapterType}" is not an enabled entry in the configured adapter runtime registry`,
    );
  }
  return fromRegistryEntry(entry);
}

/**
 * A run normally supplies its exact ACPX-discovered agent name. A target may
 * have an explicit operator fallback for non-agent calls, but there is never
 * a provider-specific default in Paperclip or this plugin.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string | undefined,
): string {
  if (runAdapterType === null || runAdapterType === undefined) {
    if (
      typeof configAdapterType !== "string" ||
      configAdapterType.length === 0 ||
      configAdapterType !== configAdapterType.trim()
    ) {
      throw new Error(
        "Kubernetes execution requires an ACPX-selected agent type or an exact explicit environment default adapter type",
      );
    }
    return configAdapterType;
  }
  if (
    runAdapterType.length === 0 ||
    runAdapterType !== runAdapterType.trim()
  ) {
    throw new Error(
      "Kubernetes execution requires an exact per-run adapter type",
    );
  }
  return runAdapterType;
}
