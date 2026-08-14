import { resolvePluginNavigationHref, type PluginUiContribution } from "@paperclipai/shared";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { pluginsApi } from "@/api/plugins";
import type { PluginModalBoundsRequest, PluginMountContext, PluginRenderCloseEvent } from "./bridge";
import { resolveLauncherComponent } from "./plugin-launcher-discovery";
import type {
  LauncherInstance,
  PluginLauncherRuntimeContextValue,
  ResolvedPluginLauncher,
} from "./plugin-launcher-types";
import { LauncherModalShell, isPluginLauncherBounds } from "./PluginLauncherOverlay";

const PluginLauncherRuntimeContext = createContext<PluginLauncherRuntimeContextValue | null>(null);

export function PluginLauncherProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<LauncherInstance[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const location = useLocation();
  const navigate = useNavigate();

  const closeLauncher = useCallback(async (key: string, event: PluginRenderCloseEvent) => {
    const instance = stackRef.current.find((entry) => entry.key === key);
    if (!instance) return;
    for (const handler of [...instance.beforeCloseHandlers]) {
      await handler(event);
    }
    setStack((current) => current.filter((entry) => entry.key !== key));
    queueMicrotask(() => {
      for (const handler of [...instance.closeHandlers]) void handler(event);
      if (document.contains(instance.sourceElement)) {
        instance.sourceElement.focus();
      }
    });
  }, []);

  useEffect(() => {
    if (stack.length === 0) return;
    void Promise.all(stack.map((entry) => closeLauncher(entry.key, { reason: "hostNavigation" })));
    // Only react to navigation changes, not stack churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state.__TSR_key]);

  const requestBounds = useCallback(async (key: string, request: PluginModalBoundsRequest) => {
    if (!isPluginLauncherBounds(request.bounds)) {
      throw new Error(`Unsupported plugin launcher bounds: ${String(request.bounds)}`);
    }
    setStack((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, bounds: request.bounds } : entry)),
    );
  }, []);

  const activateLauncher = useCallback(
    async (
      launcher: ResolvedPluginLauncher,
      hostContext: PluginMountContext,
      contribution: PluginUiContribution,
      sourceEl: HTMLElement,
    ) => {
      if (
        contribution.pluginId !== launcher.pluginId ||
        contribution.updatedAt !== launcher.pluginUpdatedAt
      ) {
        throw new Error(`Stale contribution metadata for plugin "${launcher.pluginKey}".`);
      }

      switch (launcher.action.type) {
        case "navigate":
          void navigate({
            href: resolvePluginNavigationHref(launcher.action.target, hostContext.companyId),
          });
          return;
        case "deepLink":
          if (!/^https?:\/\//.test(launcher.action.target)) {
            throw new Error("Plugin deepLink launchers require an absolute HTTP(S) URL.");
          }
          window.open(launcher.action.target, "_blank", "noopener,noreferrer");
          return;
        case "performAction":
          await pluginsApi.bridgePerformAction(
            launcher.pluginId,
            launcher.action.target,
            launcher.action.params,
            hostContext.companyId ?? null,
          );
          return;
        case "openModal":
        case "openDrawer":
        case "openPopover": {
          if (!launcher.render || launcher.render.environment !== "hostOverlay") {
            throw new Error("Plugin overlay launchers require hostOverlay render metadata.");
          }
          const component = await resolveLauncherComponent(contribution, launcher);
          const nextEntry: LauncherInstance = {
            key: `${launcher.pluginId}:${launcher.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            launcher,
            hostContext,
            component,
            sourceElement: sourceEl,
            sourceRect: sourceEl.getBoundingClientRect(),
            bounds: launcher.render.bounds ?? "default",
            beforeCloseHandlers: new Set(),
            closeHandlers: new Set(),
          };
          setStack((current) => [...current, nextEntry]);
          return;
        }
      }
    },
    [navigate],
  );

  const value = useMemo<PluginLauncherRuntimeContextValue>(() => ({ activateLauncher }), [activateLauncher]);
  return (
    <PluginLauncherRuntimeContext.Provider value={value}>
      {children}
      {stack.map((instance, index) => (
        <LauncherModalShell
          key={instance.key}
          instance={instance}
          stackIndex={index}
          isTopmost={index === stack.length - 1}
          requestBounds={requestBounds}
          closeLauncher={closeLauncher}
        />
      ))}
    </PluginLauncherRuntimeContext.Provider>
  );
}

export function usePluginLauncherRuntime(): PluginLauncherRuntimeContextValue {
  const value = useContext(PluginLauncherRuntimeContext);
  if (!value) {
    throw new Error("usePluginLauncherRuntime must be used within PluginLauncherProvider");
  }
  return value;
}
