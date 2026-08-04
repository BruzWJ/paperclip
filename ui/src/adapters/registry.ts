import type { UIAdapterModule } from "./types";
import {
  ENVIRONMENT_DRIVERS,
  type EnvironmentDriver,
} from "@paperclipai/shared";
import {
  SchemaConfigFields,
  buildSchemaAdapterConfig,
} from "./schema-config-fields";

const adaptersByType = new Map<string, UIAdapterModule>();

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function getUIAdapter(type: string): UIAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    throw new Error(`Adapter "${type}" is not in the server-admitted ACP catalog.`);
  }
  return adapter;
}

/**
 * Replace the UI catalog with the server-admitted declarative ACP catalog.
 * UI entries contain only schema rendering metadata; no executable adapter
 * package, override, or unknown-type fallback exists in the browser.
 */
export function syncServerAdapters(
  serverAdapters: {
    type: string;
    label: string;
    /** Absence is treated as no driver rather than an all-driver fallback. */
    drivers?: readonly string[];
  }[],
): void {
  const next = new Map<string, UIAdapterModule>();
  for (const adapter of serverAdapters) {
    const declaredDrivers = adapter.drivers ?? [];
    if (
      typeof adapter.type !== "string"
      || typeof adapter.label !== "string"
      || adapter.type.length === 0
      || adapter.type !== adapter.type.trim()
      || adapter.label.length === 0
      || adapter.label !== adapter.label.trim()
      || !Array.isArray(declaredDrivers)
      || declaredDrivers.some(
        (driver) =>
          typeof driver !== "string"
          || !ENVIRONMENT_DRIVERS.includes(driver as EnvironmentDriver),
      )
      || new Set(declaredDrivers).size !== declaredDrivers.length
      || next.has(adapter.type)
    ) {
      throw new Error("Server returned an invalid ACP adapter catalog.");
    }
    const drivers = Object.freeze(
      ENVIRONMENT_DRIVERS.filter((driver) => declaredDrivers.includes(driver)),
    );
    next.set(adapter.type, Object.freeze({
      type: adapter.type,
      label: adapter.label,
      drivers,
      ConfigFields: SchemaConfigFields,
      buildAdapterConfig: buildSchemaAdapterConfig,
    }));
  }

  const changed =
    next.size !== adaptersByType.size
    || [...next].some(([type, adapter]) => {
      const current = adaptersByType.get(type);
      return !current
        || current.label !== adapter.label
        || current.drivers.length !== adapter.drivers.length
        || current.drivers.some((driver, index) => driver !== adapter.drivers[index]);
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
