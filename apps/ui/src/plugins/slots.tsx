/**
 * @fileoverview Plugin UI slot system — dynamic loading, error isolation,
 * and rendering of plugin-contributed UI extensions.
 *
 * Provides:
 * - `usePluginSlots(filters)` — React hook that discovers and filters plugin
 *   UI contributions for the requested mounted slot types and entity scope.
 * - `PluginSlotOutlet` — renders all matching slots inline with error
 *   boundary isolation per plugin.
 * - `PluginBridgeScope` — wraps each plugin's component tree to inject
 *   the bridge context (`pluginId`, host context) needed by bridge hooks.
 *
 * Plugin UI modules are loaded via dynamic ESM `import()` from the host's
 * static file server (`/_plugins/:pluginId/ui/index.js`). Each module
 * exports named React components that correspond to `ui.slots[].exportName`
 * in the manifest.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 * @see PLUGIN_SPEC.md §19.0.3 — Bundle Serving
 */
import {
  Component,
  createElement,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
  type ComponentType,
} from "react";
import * as ReactModule from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  PluginLauncherDeclaration,
  PluginUiContribution,
  PluginUiSlotDeclaration,
  PluginUiSlotEntityType,
  PluginUiSlotType,
} from "@paperclipai/shared";
import { PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES } from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { authApi } from "@/api/auth";
import { useOptionalToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  PluginBridgeContext,
  type PluginHostContext,
  type PluginMountContext,
} from "./bridge";

export type ResolvedPluginSlot = PluginUiSlotDeclaration & {
  pluginId: string;
  pluginUpdatedAt: string;
  pluginKey: string;
  pluginDisplayName: string;
};

/**
 * Returns the unique `routeSidebar` slot that pairs with a single `page` slot
 * for the given route, or `null` if no unambiguous pairing exists.
 *
 * Used to detect when a route is taken over by a plugin's full-page sidebar so
 * host chrome (breadcrumb, in-page Back) can be suppressed.
 */
export function resolveRouteSidebarSlot(
  slots: ResolvedPluginSlot[],
  routePath: string | null,
): ResolvedPluginSlot | null {
  if (!routePath) return null;

  const pageMatches = slots.filter((slot) => slot.type === "page" && slot.routePath === routePath);
  if (pageMatches.length !== 1) return null;

  const pageSlot = pageMatches[0]!;
  const sidebarMatches = slots.filter((slot) =>
    slot.type === "routeSidebar"
    && slot.routePath === routePath
    && slot.pluginId === pageSlot.pluginId,
  );

  if (sidebarMatches.length !== 1) return null;
  return sidebarMatches[0]!;
}

type PluginSlotComponentProps = {
  context: PluginHostContext;
};

export type RegisteredPluginComponent = {
  component: ComponentType<PluginSlotComponentProps>;
};

type SlotFilters = {
  slotTypes: PluginUiSlotType[];
  entityType?: PluginUiSlotEntityType | null;
  companyId?: string | null;
  enabled?: boolean;
};

type UsePluginSlotsResult = {
  slots: ResolvedPluginSlot[];
  isLoading: boolean;
  errorMessage: string | null;
};

/**
 * In-memory registry for plugin UI exports loaded by the host page.
 * Component identity includes the immutable installation id and contribution
 * revision so an upgrade can never resolve a component from an older module.
 */
const registry = new Map<string, RegisteredPluginComponent>();
const registryListeners = new Set<() => void>();

function buildRegistryKey(pluginId: string, pluginUpdatedAt: string, exportName: string): string {
  return JSON.stringify([pluginId, pluginUpdatedAt, exportName]);
}

function notifyRegistryListeners(): void {
  for (const listener of registryListeners) {
    listener();
  }
}

function usePluginRegistrySubscription(): void {
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const listener = () => forceRerender((tick) => tick + 1);
    registryListeners.add(listener);
    return () => {
      registryListeners.delete(listener);
    };
  }, []);
}

function isEntityScopedSlot(
  slot: PluginUiSlotDeclaration,
): slot is PluginUiSlotDeclaration & { entityTypes: PluginUiSlotEntityType[] } {
  return PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES.some((type) => type === slot.type);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function registerPluginReactComponents(
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

function resolveRegisteredComponent(slot: ResolvedPluginSlot): RegisteredPluginComponent | null {
  return registry.get(buildRegistryKey(slot.pluginId, slot.pluginUpdatedAt, slot.exportName)) ?? null;
}

export function resolveRegisteredPluginComponent(
  pluginId: string,
  pluginUpdatedAt: string,
  exportName: string,
): RegisteredPluginComponent | null {
  return registry.get(buildRegistryKey(pluginId, pluginUpdatedAt, exportName)) ?? null;
}

// ---------------------------------------------------------------------------
// Plugin module dynamic import loader
// ---------------------------------------------------------------------------

type PluginLoadState = "loading" | "loaded" | "error";

/**
 * Tracks the load state for each plugin's UI module by contribution cache key.
 *
 * Once a plugin module is loaded, manifest-declared React component exports
 * are registered so that `resolveRegisteredComponent` can find them when
 * slots render.
 */
const pluginLoadStates = new Map<string, PluginLoadState>();
const pluginLoadErrors = new Map<string, string>();

/**
 * Promise cache to prevent concurrent duplicate imports for one contribution
 * revision.
 */
const inflightImports = new Map<string, Promise<void>>();

/**
 * Build the full URL for a plugin's UI entry module.
 *
 * Every plugin UI build has one canonical `index.js` module.
 */
function buildPluginModuleKey(contribution: PluginUiContribution): string {
  return `${contribution.pluginId}:${contribution.updatedAt}`;
}

function buildPluginUiUrl(contribution: PluginUiContribution): string {
  const cacheHint = encodeURIComponent(contribution.updatedAt);
  return `/_plugins/${encodeURIComponent(contribution.pluginId)}/ui/index.js?v=${cacheHint}`;
}

/**
 * Import a plugin's UI entry module with bare-specifier rewriting.
 *
 * Plugin bundles are built with `external: ["@paperclipai/plugin-sdk/ui", "react", "react-dom", "react-dom/client"]`,
 * so their ESM output contains bare specifier imports like:
 *
 * ```js
 * import { usePluginData } from "@paperclipai/plugin-sdk/ui";
 * import React from "react";
 * ```
 *
 * Browsers cannot resolve bare specifiers without an import map. Rather than
 * fighting import map timing constraints, we:
 * 1. Fetch the module source text
 * 2. Rewrite bare specifier imports to use blob URLs that re-export from the
 *    host's global bridge registry (`globalThis.__paperclipPluginBridge__`)
 * 3. Import the rewritten module via a blob URL
 *
 * This approach is compatible with all modern browsers and avoids import map
 * ordering tasks.
 */
const shimBlobUrls: Record<string, string> = {};

function applyJsxRuntimeKey(
  props: Record<string, unknown> | null | undefined,
  key: string | number | undefined,
): Record<string, unknown> {
  if (key === undefined) return props ?? {};
  return { ...(props ?? {}), key };
}

function createBridgeModuleShimSource(
  module: object,
  bridgeExpression: string,
  missingMessage: string,
): string {
  const hasDefaultExport = Object.prototype.hasOwnProperty.call(module, "default");
  const exportNames = Object.keys(module)
    .filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
    .sort();
  const namedExports = exportNames
    .map((name) => `        export const ${name} = M.${name};`)
    .join("\n");

  return `
        const M = ${bridgeExpression};
        if (!M) {
          throw new Error(${JSON.stringify(missingMessage)});
        }
${hasDefaultExport ? "        export default M.default;" : ""}
${namedExports}
      `;
}

function getShimBlobUrl(specifier: "react" | "react-dom" | "react-dom/client" | "react/jsx-runtime" | "sdk-ui"): string {
  if (shimBlobUrls[specifier]) return shimBlobUrls[specifier];

  let source: string;
  switch (specifier) {
    case "react":
      source = createBridgeModuleShimSource(
        ReactModule,
        "globalThis.__paperclipPluginBridge__?.react",
        "Paperclip plugin React runtime is not initialized.",
      );
      break;
    case "react/jsx-runtime":
      source = `
        const R = globalThis.__paperclipPluginBridge__?.react;
        if (!R) {
          throw new Error("Paperclip plugin React runtime is not initialized.");
        }
        const withKey = ${applyJsxRuntimeKey.toString()};
        export const jsx = (type, props, key) => R.createElement(type, withKey(props, key));
        export const jsxs = (type, props, key) => R.createElement(type, withKey(props, key));
        export const Fragment = R.Fragment;
      `;
      break;
    case "react-dom":
      if (!globalThis.__paperclipPluginBridge__?.reactDom) {
        throw new Error("Paperclip plugin ReactDOM runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.reactDom as object,
        "globalThis.__paperclipPluginBridge__?.reactDom",
        "Paperclip plugin ReactDOM runtime is not initialized.",
      );
      break;
    case "react-dom/client":
      if (!globalThis.__paperclipPluginBridge__?.reactDomClient) {
        throw new Error("Paperclip plugin ReactDOM client runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.reactDomClient as object,
        "globalThis.__paperclipPluginBridge__?.reactDomClient",
        "Paperclip plugin ReactDOM client runtime is not initialized.",
      );
      break;
    case "sdk-ui":
      if (!globalThis.__paperclipPluginBridge__?.sdkUi) {
        throw new Error("Paperclip plugin SDK UI runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.sdkUi,
        "globalThis.__paperclipPluginBridge__?.sdkUi",
        "Paperclip plugin SDK UI runtime is not initialized.",
      );
      break;
  }

  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  shimBlobUrls[specifier] = url;
  return url;
}

/**
 * Rewrite bare specifier imports in an ESM source string to use blob URLs.
 *
 * This handles the standard import patterns emitted by esbuild:
 * - `import { ... } from "react";`
 * - `import React from "react";`
 * - `import * as React from "react";`
 * - `import { ... } from "@paperclipai/plugin-sdk/ui";`
 *
 * Also handles re-exports:
 * - `export { ... } from "react";`
 */
function rewriteBareSpecifiers(source: string): string {
  // Build a mapping of bare specifiers to blob URLs.
  const rewrites: Record<string, string> = {
    '"@paperclipai/plugin-sdk/ui"': `"${getShimBlobUrl("sdk-ui")}"`,
    "'@paperclipai/plugin-sdk/ui'": `'${getShimBlobUrl("sdk-ui")}'`,
    '"react/jsx-runtime"': `"${getShimBlobUrl("react/jsx-runtime")}"`,
    "'react/jsx-runtime'": `'${getShimBlobUrl("react/jsx-runtime")}'`,
    '"react-dom/client"': `"${getShimBlobUrl("react-dom/client")}"`,
    "'react-dom/client'": `'${getShimBlobUrl("react-dom/client")}'`,
    '"react-dom"': `"${getShimBlobUrl("react-dom")}"`,
    "'react-dom'": `'${getShimBlobUrl("react-dom")}'`,
    '"react"': `"${getShimBlobUrl("react")}"`,
    "'react'": `'${getShimBlobUrl("react")}'`,
  };

  let result = source;
  for (const [from, to] of Object.entries(rewrites)) {
    // Only rewrite in import/export from contexts, not in arbitrary strings.
    // The regex matches `from "..."` or `from '...'` patterns.
    result = result.replaceAll(` from ${from}`, ` from ${to}`);
    // Also handle `import "..."` (side-effect imports)
    result = result.replaceAll(`import ${from}`, `import ${to}`);
  }

  return result;
}

/**
 * Fetch, rewrite, and import a plugin UI module.
 *
 * @param url - The URL to the plugin's UI entry module
 * @returns The module's exports
 */
async function importPluginModule(url: string): Promise<Record<string, unknown>> {
  if (!globalThis.__paperclipPluginBridge__) {
    throw new Error("Paperclip plugin UI bridge is not initialized; plugin modules cannot load.");
  }

  // Fetch the module source text
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch plugin module: ${response.status} ${response.statusText}`);
  }

  const source = await response.text();

  // Rewrite bare specifier imports to blob URLs
  const rewritten = rewriteBareSpecifiers(source);

  // Create a blob URL from the rewritten source and import it
  const blob = new Blob([rewritten], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const mod = await import(/* @vite-ignore */ blobUrl);
    return mod;
  } finally {
    // Clean up the blob URL after import (the module is already loaded)
    URL.revokeObjectURL(blobUrl);
  }
}

function registerPluginModuleExports(
  contribution: PluginUiContribution,
  mod: Record<string, unknown>,
): void {
  const declaredExports = new Set<string>();
  for (const slot of contribution.slots) {
    declaredExports.add(slot.exportName);
  }
  for (const launcher of contribution.launchers) {
    if (isLauncherComponentTarget(launcher)) {
      declaredExports.add(launcher.action.target);
    }
  }

  // Validate the complete declaration before mutating the registry. A module
  // is either accepted in full or rejected; partial registration is forbidden.
  const components: Array<readonly [string, ComponentType<PluginSlotComponentProps>]> = [];
  for (const exportName of declaredExports) {
    const exported = mod[exportName];
    if (exported === undefined) {
      throw new Error(
        `Plugin "${contribution.pluginKey}" declares UI export "${exportName}" but its module does not export it.`,
      );
    }
    if (typeof exported !== "function") {
      throw new Error(
        `Plugin "${contribution.pluginKey}" UI export "${exportName}" must be a React component.`,
      );
    }
    components.push([exportName, exported as ComponentType<PluginSlotComponentProps>]);
  }

  registerPluginReactComponents(
    contribution.pluginId,
    contribution.updatedAt,
    components,
  );
}

/**
 * Dynamically import a plugin's UI entry module and register the React
 * component exports declared by its manifest.
 *
 * Plugin modules are loaded with bare-specifier rewriting so that imports
 * of `@paperclipai/plugin-sdk/ui`, `react`, and `react-dom` resolve to the
 * host-provided implementations via the bridge registry.
 *
 */
async function loadPluginModule(contribution: PluginUiContribution): Promise<void> {
  const { pluginId, pluginKey } = contribution;
  const moduleKey = buildPluginModuleKey(contribution);

  // Each installation revision has exactly one load and one in-flight promise.
  const state = pluginLoadStates.get(moduleKey);
  if (state === "loaded") {
    return;
  }
  const inflight = inflightImports.get(moduleKey);
  if (inflight) {
    await inflight;
    return;
  }

  pluginLoadStates.set(moduleKey, "loading");
  pluginLoadErrors.delete(moduleKey);

  const url = buildPluginUiUrl(contribution);

  const importPromise = (async () => {
    try {
      // Dynamic ESM import of the plugin's UI entry module with
      // bare-specifier rewriting for host-provided dependencies.
      const mod: Record<string, unknown> = await importPluginModule(url);

      registerPluginModuleExports(contribution, mod);
      pluginLoadStates.set(moduleKey, "loaded");
    } catch (err) {
      pluginLoadStates.set(moduleKey, "error");
      pluginLoadErrors.set(moduleKey, getErrorMessage(err));
      console.error(`Failed to load UI module for plugin "${pluginKey}"`, err);
      throw err;
    } finally {
      inflightImports.delete(moduleKey);
    }
  })();

  inflightImports.set(moduleKey, importPromise);
  await importPromise;
}

function isLauncherComponentTarget(launcher: PluginLauncherDeclaration): boolean {
  return launcher.action.type === "openModal"
    || launcher.action.type === "openDrawer"
    || launcher.action.type === "openPopover";
}

/**
 * Load UI modules for a set of plugin contributions.
 *
 * Resolves after every module loads and rejects if any contribution fails.
 * Contributions that are already loaded are skipped.
 */
async function ensurePluginModulesLoaded(contributions: PluginUiContribution[]): Promise<void> {
  await Promise.all(
    contributions.map((c) => loadPluginModule(c)),
  );
}

export async function ensurePluginContributionLoaded(
  contribution: PluginUiContribution,
): Promise<void> {
  await loadPluginModule(contribution);
}

/**
 * Reports whether every contribution revision has either loaded or failed.
 * Failures use the separate error channel instead of keeping mounts pending.
 */
function pluginModulesAreSettled(contributions: PluginUiContribution[]): boolean {
  for (const c of contributions) {
    const state = pluginLoadStates.get(buildPluginModuleKey(c));
    if (state === "loading" || state === undefined) {
      return false;
    }
  }
  return true;
}

function aggregateLoadError(contributions: PluginUiContribution[]): string | null {
  const failures = contributions.flatMap((contribution) => {
    const message = pluginLoadErrors.get(buildPluginModuleKey(contribution));
    return message ? [`${contribution.displayName}: ${message}`] : [];
  });
  return failures.length > 0 ? failures.join("; ") : null;
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/**
 * Trigger dynamic loading of plugin UI modules when contributions change.
 *
 * This hook is intentionally decoupled from usePluginSlots so that callers
 * who consume slots via `usePluginSlots()` automatically get module loading
 * without extra wiring.
 */
function usePluginModuleLoader(contributions: PluginUiContribution[] | undefined) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!contributions || contributions.length === 0) return;

    // Filter to contributions that haven't been loaded yet.
    const unloaded = contributions.filter((c) => {
      const state = pluginLoadStates.get(buildPluginModuleKey(c));
      return state !== "loaded" && state !== "loading";
    });

    if (unloaded.length === 0) return;

    let cancelled = false;
    const finish = () => {
      // Re-render so mounts resolve registered components or expose the exact
      // module-load failure instead of silently leaving an empty slot.
      if (!cancelled) setTick((t) => t + 1);
    };
    void ensurePluginModulesLoaded(unloaded).then(finish, finish);

    return () => {
      cancelled = true;
    };
  }, [contributions]);
}

/**
 * Resolves and sorts slots across all ready plugin contributions.
 *
 * Filtering rules:
 * - `slotTypes` must match one of the caller-requested host slot types.
 * - Entity-scoped slot types (`detailTab`, `taskDetailView`,
 *   `projectSidebarItem`, and `toolbarButton`)
 *   require `entityType` and must include it in `slot.entityTypes`.
 *
 * Automatically triggers dynamic import of plugin UI modules for any
 * newly-discovered contributions. Components render once loading completes.
 */
export function usePluginSlots(filters: SlotFilters): UsePluginSlotsResult {
  const queryEnabled = filters.enabled ?? true;
  const toast = useOptionalToastActions();
  const { data, isLoading: isQueryLoading, error } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: queryEnabled,
  });
  const pluginError = error ? getErrorMessage(error) : null;

  // Kick off dynamic imports for any new plugin contributions.
  usePluginModuleLoader(data);
  const moduleError = data ? aggregateLoadError(data) : null;
  const errorMessage = pluginError ?? moduleError;

  useEffect(() => {
    if (!toast || !errorMessage) return;
    toast.pushToast({
      dedupeKey: "plugin-ui-contributions-error",
      title: "Plugin extensions unavailable",
      body: errorMessage,
      tone: "error",
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
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const pluginCmp = a.pluginDisplayName.localeCompare(b.pluginDisplayName);
      if (pluginCmp !== 0) return pluginCmp;
      return a.displayName.localeCompare(b.displayName);
    });
    return rows;
  }, [data, filters.entityType, slotTypesKey]);

  // Consider loading until both query and module imports are done.
  const modulesSettled = data ? pluginModulesAreSettled(data) : true;
  const isLoading = queryEnabled && (isQueryLoading || !modulesSettled);

  return {
    slots,
    isLoading,
    errorMessage,
  };
}

type PluginSlotErrorBoundaryProps = {
  slot: ResolvedPluginSlot;
  className?: string;
  children: ReactNode;
};

type PluginSlotErrorBoundaryState = {
  hasError: boolean;
};

class PluginSlotErrorBoundary extends Component<PluginSlotErrorBoundaryProps, PluginSlotErrorBoundaryState> {
  override state: PluginSlotErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PluginSlotErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep plugin failures isolated while preserving actionable diagnostics.
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
        <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive", this.props.className)}>
          {this.props.slot.pluginDisplayName}: failed to render
        </div>
      );
    }
    return this.props.children;
  }
}

type PluginSlotMountProps = {
  slot: ResolvedPluginSlot;
  context: PluginMountContext;
  className?: string;
  missingBehavior?: "hidden" | "placeholder";
};

/**
 * Maps the mount context to a `PluginHostContext` for the bridge.
 *
 * The bridge hooks need the full host context shape; the slot context carries
 * the subset available from the rendering location.
 */
function slotContextToHostContext(
  pluginSlotContext: PluginMountContext,
  userId: string | null,
): PluginHostContext {
  return {
    companyId: pluginSlotContext.companyId ?? null,
    companyPrefix: pluginSlotContext.companyPrefix ?? null,
    projectId: pluginSlotContext.projectId ?? (pluginSlotContext.entityType === "project" ? pluginSlotContext.entityId ?? null : null),
    projectRef: pluginSlotContext.projectRef ?? null,
    entityId: pluginSlotContext.entityId ?? null,
    entityType: pluginSlotContext.entityType ?? null,
    userId,
    renderEnvironment: null,
  };
}

/**
 * Wrapper component that sets the active bridge context around plugin renders.
 *
 * This ensures that `usePluginData()`, `usePluginAction()`, and `useHostContext()`
 * have access to the current plugin ID and host context during the render phase.
 */
function PluginBridgeScope({
  pluginId,
  hostContext,
  children,
}: {
  pluginId: string;
  hostContext: PluginHostContext;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ pluginId, hostContext }), [pluginId, hostContext]);

  return (
    <PluginBridgeContext.Provider value={value}>
      {children}
    </PluginBridgeContext.Provider>
  );
}

export function PluginSlotMount({
  slot,
  context,
  className,
  missingBehavior = "hidden",
}: PluginSlotMountProps) {
  usePluginRegistrySubscription();
  const component = resolveRegisteredComponent(slot);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const hostContext = useMemo(
    () => slotContextToHostContext(context, userId),
    [context, userId],
  );

  if (!component) {
    if (missingBehavior === "hidden") return null;
    return (
      <div className={cn("rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground", className)}>
        {slot.pluginDisplayName}: {slot.displayName}
      </div>
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

type PluginSlotOutletProps = {
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
  const { slots, errorMessage } = usePluginSlots({
    slotTypes,
    entityType,
    companyId: context.companyId,
  });

  if (errorMessage) {
    return (
      <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive", errorClassName)} role="alert">
        Plugin extensions unavailable: {errorMessage}
      </div>
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

// ---------------------------------------------------------------------------
// Test helpers — exported for use in test suites only.
// ---------------------------------------------------------------------------

/**
 * Reset the module loader state. Only use in tests.
 * @internal
 */
export function _resetPluginModuleLoader(): void {
  pluginLoadStates.clear();
  pluginLoadErrors.clear();
  inflightImports.clear();
  registry.clear();
  if (typeof URL.revokeObjectURL === "function") {
    for (const url of Object.values(shimBlobUrls)) {
      URL.revokeObjectURL(url);
    }
  }
  for (const key of Object.keys(shimBlobUrls)) {
    delete shimBlobUrls[key];
  }
}

export const _createBridgeModuleShimSourceForTests = createBridgeModuleShimSource;
export const _rewriteBareSpecifiersForTests = rewriteBareSpecifiers;
export const _registerPluginModuleExportsForTests = registerPluginModuleExports;
