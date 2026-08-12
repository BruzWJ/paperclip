import type { UIAdapterModule } from "./types";
import {
  AcpxConfigOptions,
  buildAcpxAdapterConfig,
} from "./acpx-config-options";

const adaptersByType = new Map<string, UIAdapterModule>();

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function getUIAdapter(type: string): UIAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    throw new Error(`Adapter "${type}" is not in the server-admitted local agent catalog.`);
  }
  return adapter;
}

/**
 * Replace the UI catalog with the server-admitted local agent catalog.
 * UI entries contain only schema rendering metadata; no executable adapter
 * package, override, or unknown-type fallback exists in the browser.
 */
export function syncServerAdapters(
  serverAdapters: {
    type: string;
    label: string;
  }[],
): void {
  const next = new Map<string, UIAdapterModule>();
  for (const adapter of serverAdapters) {
    if (
      typeof adapter.type !== "string"
      || typeof adapter.label !== "string"
      || adapter.type.length === 0
      || adapter.type !== adapter.type.trim()
      || adapter.label.length === 0
      || adapter.label !== adapter.label.trim()
      || next.has(adapter.type)
    ) {
      throw new Error("Server returned an invalid local agent catalog.");
    }
    next.set(adapter.type, Object.freeze({
      type: adapter.type,
      label: adapter.label,
      ConfigFields: AcpxConfigOptions,
      buildAdapterConfig: buildAcpxAdapterConfig,
    }));
  }

  const changed =
    next.size !== adaptersByType.size
    || [...next].some(([type, adapter]) => {
      const current = adaptersByType.get(type);
      return !current
        || current.label !== adapter.label;
    });
  if (!changed) return;

  adaptersByType.clear();
  for (const [type, adapter] of next) adaptersByType.set(type, adapter);
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...adaptersByType.values()].sort((left, right) =>
    left.type.localeCompare(right.type),
  );
}
