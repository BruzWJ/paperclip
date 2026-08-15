import type {
// Status updates announce through role="status" live regions.
  PluginLauncherBounds,
  PluginLauncherDeclaration,
  PluginLauncherPlacementZone,
  PluginUiContribution,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";

import type { PluginMountContext, PluginRenderCloseHandler } from "./bridge";
import type { RegisteredPluginComponent } from "./plugin-component-registry";

export interface ResolvedPluginIdentity {
  pluginId: string;
  pluginUpdatedAt: string;
  pluginKey: string;
  pluginDisplayName: string;
}

export interface PluginOperationResult {
  type: "success" | "error";
  text: string;
}

export type ResolvedPluginLauncher = PluginLauncherDeclaration & ResolvedPluginIdentity;

export type UsePluginLaunchersFilters = {
  placementZones: PluginLauncherPlacementZone[];
  entityType?: PluginUiSlotEntityType | null;
  enabled?: boolean;
};

export type UsePluginLaunchersResult = {
  launchers: ResolvedPluginLauncher[];
  contributionsByPluginId: Map<string, PluginUiContribution>;
  errorMessage: string | null;
};

export type PluginLauncherRuntimeContextValue = {
  activateLauncher(
    launcher: ResolvedPluginLauncher,
    hostContext: PluginMountContext,
    contribution: PluginUiContribution,
    sourceEl: HTMLElement,
  ): Promise<void>;
};

export type LauncherInstance = {
  key: string;
  launcher: ResolvedPluginLauncher;
  hostContext: PluginMountContext;
  component: RegisteredPluginComponent;
  sourceElement: HTMLElement;
  sourceRect: DOMRect;
  bounds: PluginLauncherBounds;
  beforeCloseHandlers: Set<PluginRenderCloseHandler>;
  closeHandlers: Set<PluginRenderCloseHandler>;
};
