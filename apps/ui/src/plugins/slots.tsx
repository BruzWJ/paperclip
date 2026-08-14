/** Plugin UI slot discovery, filtering, and isolated rendering. */
import type { PluginUiSlotDeclaration, PluginUiSlotEntityType, PluginUiSlotType } from "@paperclipai/shared";
import { PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Component, createElement, useEffect, useMemo, type ErrorInfo, type ReactNode } from "react";

import { authApi } from "@/api/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { pluginsApi } from "@/api/plugins";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import { PluginBridgeContext, type PluginHostContext, type PluginMountContext } from "./bridge";
import { resolveRegisteredPluginComponent, usePluginRegistrySubscription } from "./plugin-component-registry";
import {
  aggregatePluginLoadError,
  pluginModulesAreSettled,
  resetPluginModuleLoader,
  usePluginModuleLoader,
} from "./plugin-module-loader";
import type { ResolvedPluginIdentity } from "./plugin-launcher-types";

export {
  resolveRegisteredPluginComponent,
  type RegisteredPluginComponent,
} from "./plugin-component-registry";
export {
  createBridgeModuleShimSource,
  ensurePluginContributionLoaded,
  registerPluginModuleExports,
  rewriteBareSpecifiers,
} from "./plugin-module-loader";

export type ResolvedPluginSlot = PluginUiSlotDeclaration & ResolvedPluginIdentity;

export function resolveRouteSidebarSlot(
  slots: ResolvedPluginSlot[],
  routePath: string | null,
): ResolvedPluginSlot | null {
  if (!routePath) return null;
  const pageMatches = slots.filter((slot) => slot.type === "page" && slot.routePath === routePath);
  if (pageMatches.length !== 1) return null;

  const pageSlot = pageMatches[0]!;
  const sidebarMatches = slots.filter(
    (slot) =>
      slot.type === "routeSidebar" && slot.routePath === routePath && slot.pluginId === pageSlot.pluginId,
  );
  return sidebarMatches.length === 1 ? sidebarMatches[0]! : null;
}

type SlotFilters = {
  slotTypes: PluginUiSlotType[];
  entityType?: PluginUiSlotEntityType | null;
  enabled?: boolean;
};

type UsePluginSlotsResult = {
  slots: ResolvedPluginSlot[];
  isLoading: boolean;
  errorMessage: string | null;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function isEntityScopedSlot(slot: PluginUiSlotDeclaration): slot is PluginUiSlotDeclaration & {
  entityTypes: PluginUiSlotEntityType[];
} {
  return PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES.some((type) => type === slot.type);
}

export function usePluginSlots(filters: SlotFilters): UsePluginSlotsResult {
  const queryEnabled = filters.enabled ?? true;
  const {
    data,
    isLoading: isQueryLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: queryEnabled,
  });
  const pluginError = error ? getErrorMessage(error) : null;

  usePluginModuleLoader(data);
  const moduleError = data ? aggregatePluginLoadError(data) : null;
  const errorMessage = pluginError ?? moduleError;

  useEffect(() => {
    if (!toast || !errorMessage) return;
    toast.error("Plugin extensions unavailable", {
      description: errorMessage,
      id: "plugin-ui-contributions-error",
    });
  }, [errorMessage, toast]);

  const slotTypesKey = useMemo(() => [...filters.slotTypes].sort().join("|"), [filters.slotTypes]);
  const slots = useMemo(() => {
    const allowedTypes = new Set(slotTypesKey.split("|").filter(Boolean) as PluginUiSlotType[]);
    const rows: ResolvedPluginSlot[] = [];
    for (const contribution of data ?? []) {
      for (const slot of contribution.slots) {
        if (!allowedTypes.has(slot.type)) continue;
        if (isEntityScopedSlot(slot)) {
          if (!filters.entityType) continue;
          if (!(slot.entityTypes as readonly PluginUiSlotEntityType[]).includes(filters.entityType)) continue;
        }
        rows.push({
          ...slot,
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
  }, [data, filters.entityType, slotTypesKey]);

  const modulesSettled = data ? pluginModulesAreSettled(data) : true;
  return {
    slots,
    isLoading: queryEnabled && (isQueryLoading || !modulesSettled),
    errorMessage,
  };
}

type PluginSlotErrorBoundaryProps = {
  slot: ResolvedPluginSlot;
  className?: string;
  children: ReactNode;
};

class PluginSlotErrorBoundary extends Component<PluginSlotErrorBoundaryProps, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Plugin slot render failed", {
      pluginKey: this.props.slot.pluginKey,
      slotId: this.props.slot.id,
      error,
      info: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <Alert variant="destructive" className={this.props.className}>
          <AlertDescription>{this.props.slot.pluginDisplayName}: failed to render</AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}

function slotContextToHostContext(context: PluginMountContext, userId: string | null): PluginHostContext {
  return {
    companyId: context.companyId ?? null,
    projectId: context.projectId ?? (context.entityType === "project" ? (context.entityId ?? null) : null),
    entityId: context.entityId ?? null,
    entityType: context.entityType ?? null,
    userId,
    renderEnvironment: null,
  };
}

export type PluginBridgeScopeProps = {
  pluginId: string;
  hostContext: PluginHostContext;
  children: ReactNode;
};

export function PluginBridgeScope({ pluginId, hostContext, children }: PluginBridgeScopeProps) {
  const value = useMemo(() => ({ pluginId, hostContext }), [pluginId, hostContext]);
  return <PluginBridgeContext.Provider value={value}>{children}</PluginBridgeContext.Provider>;
}

export type PluginSlotMountProps = {
  slot: ResolvedPluginSlot;
  context: PluginMountContext;
  className?: string;
  missingBehavior?: "hidden" | "placeholder";
};

export function PluginSlotMount({
  slot,
  context,
  className,
  missingBehavior = "hidden",
}: PluginSlotMountProps) {
  usePluginRegistrySubscription();
  const component = resolveRegisteredPluginComponent(slot.pluginId, slot.pluginUpdatedAt, slot.exportName);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const hostContext = useMemo(
    () => slotContextToHostContext(context, session?.user.id ?? null),
    [context, session?.user.id],
  );

  if (!component) {
    if (missingBehavior === "hidden") return null;
    return (
      <Alert className={className}>
        <AlertDescription>
          {slot.pluginDisplayName}: {slot.displayName}
        </AlertDescription>
      </Alert>
    );
  }

  const node = createElement(component.component, { context: hostContext });
  return (
    <PluginSlotErrorBoundary
      key={`${slot.pluginId}:${slot.pluginUpdatedAt}:${slot.id}`}
      slot={slot}
      className={className}
    >
      <PluginBridgeScope pluginId={slot.pluginId} hostContext={hostContext}>
        {className ? <div className={className}>{node}</div> : node}
      </PluginBridgeScope>
    </PluginSlotErrorBoundary>
  );
}

export type PluginSlotOutletProps = {
  slotTypes: PluginUiSlotType[];
  context: PluginMountContext;
  entityType?: PluginUiSlotEntityType | null;
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
  missingBehavior?: "hidden" | "placeholder";
};

export function PluginSlotOutlet({
  slotTypes,
  context,
  entityType,
  className,
  itemClassName,
  errorClassName,
  missingBehavior = "hidden",
}: PluginSlotOutletProps) {
  const { slots, errorMessage } = usePluginSlots({ slotTypes, entityType });
  if (errorMessage) {
    return (
      <Alert variant="destructive" className={errorClassName}>
        <AlertDescription>Plugin extensions unavailable: {errorMessage}</AlertDescription>
      </Alert>
    );
  }
  if (slots.length === 0) return null;
  return (
    <div className={className}>
      {slots.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginId}:${slot.pluginUpdatedAt}:${slot.id}`}
          slot={slot}
          context={context}
          className={itemClassName}
          missingBehavior={missingBehavior}
        />
      ))}
    </div>
  );
}

/** Reset the module loader state. Only use in tests. */
export function _resetPluginModuleLoader(): void {
  resetPluginModuleLoader();
}
