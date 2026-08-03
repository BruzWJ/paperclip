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
 * Resolve one exact operator-declared adapter runtime. Kubernetes owns no
 * provider-specific adapter catalog or image fallback: active built-in and
 * external transports use the same explicit registry contract.
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
 * A run may select any exact enabled registry entry. When no per-run type is
 * supplied, use the environment's explicit default transport.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
): string {
  if (
    configAdapterType.length === 0 ||
    configAdapterType !== configAdapterType.trim()
  ) {
    throw new Error(
      "Kubernetes execution requires an exact default adapter type",
    );
  }
  if (runAdapterType === null || runAdapterType === undefined) {
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
