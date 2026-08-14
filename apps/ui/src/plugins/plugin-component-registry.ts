import { useEffect, useState, type ComponentType } from "react";

import type { PluginHostContext } from "./bridge";

export type PluginSlotComponentProps = {
  context: PluginHostContext;
};

export type RegisteredPluginComponent = {
  component: ComponentType<PluginSlotComponentProps>;
};

const registry = new Map<string, RegisteredPluginComponent>();
const registryListeners = new Set<() => void>();

function buildRegistryKey(pluginId: string, pluginUpdatedAt: string, exportName: string): string {
  return JSON.stringify([pluginId, pluginUpdatedAt, exportName]);
}

function notifyRegistryListeners(): void {
  for (const listener of registryListeners) listener();
}

export function usePluginRegistrySubscription(): void {
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const listener = () => forceRerender((tick) => tick + 1);
    registryListeners.add(listener);
    return () => {
      registryListeners.delete(listener);
    };
  }, []);
}

export function registerPluginReactComponents(
  pluginId: string,
  pluginUpdatedAt: string,
  components: ReadonlyArray<readonly [string, ComponentType<PluginSlotComponentProps>]>,
): void {
  for (const [exportName, component] of components) {
    registry.set(buildRegistryKey(pluginId, pluginUpdatedAt, exportName), {
      component,
    });
  }
  notifyRegistryListeners();
}

export function resolveRegisteredPluginComponent(
  pluginId: string,
  pluginUpdatedAt: string,
  exportName: string,
): RegisteredPluginComponent | null {
  return registry.get(buildRegistryKey(pluginId, pluginUpdatedAt, exportName)) ?? null;
}

export function resetPluginComponentRegistry(): void {
  registry.clear();
  notifyRegistryListeners();
}
