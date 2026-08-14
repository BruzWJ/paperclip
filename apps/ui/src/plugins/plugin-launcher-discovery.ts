import type { PluginLauncherPlacementZone, PluginUiContribution } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { pluginsApi } from "@/api/plugins";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import type {
  ResolvedPluginLauncher,
  UsePluginLaunchersFilters,
  UsePluginLaunchersResult,
} from "./plugin-launcher-types";
import {
  ensurePluginContributionLoaded,
  resolveRegisteredPluginComponent,
  type RegisteredPluginComponent,
} from "./slots";

export function getPluginLauncherErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

export function usePluginLaunchers(filters: UsePluginLaunchersFilters): UsePluginLaunchersResult {
  const queryEnabled = filters.enabled ?? true;
  const { data, error } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: queryEnabled,
  });
  const pluginError = error ? getPluginLauncherErrorMessage(error) : null;

  useEffect(() => {
    if (!toast || !pluginError) return;
    toast.error("Plugin launchers unavailable", {
      description: pluginError,
      id: "plugin-ui-contributions-error",
    });
  }, [pluginError, toast]);

  const placementZonesKey = useMemo(
    () => [...filters.placementZones].sort().join("|"),
    [filters.placementZones],
  );
  const contributionsByPluginId = useMemo(() => {
    const byPluginId = new Map<string, PluginUiContribution>();
    for (const contribution of data ?? []) {
      byPluginId.set(contribution.pluginId, contribution);
    }
    return byPluginId;
  }, [data]);

  const launchers = useMemo(() => {
    const placementZones = new Set(
      placementZonesKey.split("|").filter(Boolean) as PluginLauncherPlacementZone[],
    );
    const rows: ResolvedPluginLauncher[] = [];
    for (const contribution of data ?? []) {
      for (const launcher of contribution.launchers) {
        if (!placementZones.has(launcher.placementZone)) continue;
        if (launcher.placementZone === "toolbarButton") {
          if (filters.entityType !== "project" && filters.entityType !== "task") {
            continue;
          }
          if (!launcher.entityTypes.includes(filters.entityType)) continue;
        }
        rows.push({
          ...launcher,
          pluginId: contribution.pluginId,
          pluginUpdatedAt: contribution.updatedAt,
          pluginKey: contribution.pluginKey,
          pluginDisplayName: contribution.displayName,
        });
      }
    }
    rows.sort((a, b) => {
      const order = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      if (order !== 0) return order;
      return (
        a.pluginDisplayName.localeCompare(b.pluginDisplayName) || a.displayName.localeCompare(b.displayName)
      );
    });
    return rows;
  }, [data, filters.entityType, placementZonesKey]);

  return {
    launchers,
    contributionsByPluginId,
    errorMessage: pluginError,
  };
}

export async function resolveLauncherComponent(
  contribution: PluginUiContribution,
  launcher: ResolvedPluginLauncher,
): Promise<RegisteredPluginComponent> {
  const exportName = launcher.action.target;
  const existing = resolveRegisteredPluginComponent(launcher.pluginId, launcher.pluginUpdatedAt, exportName);
  if (existing) return existing;

  await ensurePluginContributionLoaded(contribution);
  const registered = resolveRegisteredPluginComponent(
    launcher.pluginId,
    launcher.pluginUpdatedAt,
    exportName,
  );
  if (!registered) {
    throw new Error(
      `Plugin "${launcher.pluginKey}" loaded without declared launcher export "${exportName}".`,
    );
  }
  return registered;
}
