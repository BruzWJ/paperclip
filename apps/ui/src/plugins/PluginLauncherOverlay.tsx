// Empty collections render dedicated UI when data.length === 0.
import { PLUGIN_LAUNCHER_BOUNDS, type PluginLauncherBounds } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Component, createElement, useMemo, type CSSProperties, type ErrorInfo, type ReactNode } from "react";

import { authApi } from "@/api/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type {
  PluginHostContext,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginRenderEnvironmentContext,
} from "./bridge";
import type { LauncherInstance } from "./plugin-launcher-types";
import { PluginBridgeScope } from "./slots";

const launcherOverlayBaseZIndex = 1000;
const supportedLauncherBounds = new Set<PluginLauncherBounds>(PLUGIN_LAUNCHER_BOUNDS);

type LauncherBoundsStyle = { width: string; height?: string };

export function isPluginLauncherBounds(value: unknown): value is PluginLauncherBounds {
  return typeof value === "string" && supportedLauncherBounds.has(value as PluginLauncherBounds);
}

function buildLauncherHostContext(
  instance: LauncherInstance,
  renderEnvironment: PluginRenderEnvironmentContext,
  userId: string | null,
): PluginHostContext {
  const context = instance.hostContext;
  return {
    companyId: context.companyId ?? null,
    projectId: context.projectId ?? (context.entityType === "project" ? (context.entityId ?? null) : null),
    entityId: context.entityId ?? null,
    entityType: context.entityType ?? null,
    userId,
    renderEnvironment,
  };
}

function launcherShellBoundsStyle(bounds: PluginLauncherBounds): LauncherBoundsStyle {
  switch (bounds) {
    case "compact":
      return { width: "min(28rem, calc(100vw - 2rem))" };
    case "wide":
      return { width: "min(64rem, calc(100vw - 2rem))" };
    case "full":
      return {
        width: "calc(100vw - 2rem)",
        height: "calc(100vh - 2rem)",
      };
    case "inline":
      return { width: "min(24rem, calc(100vw - 2rem))" };
    default:
      return { width: "min(40rem, calc(100vw - 2rem))" };
  }
}

function launcherPopoverStyle(instance: LauncherInstance): CSSProperties {
  const rect = instance.sourceRect;
  return {
    width: launcherShellBoundsStyle(instance.bounds).width,
    maxHeight: "min(70vh, 36rem)",
    top: Math.min(rect.bottom + 8, window.innerHeight - 32),
    left: Math.min(Math.max(rect.left, 16), Math.max(16, window.innerWidth - 360)),
  };
}

class LauncherErrorBoundary extends Component<
  { instance: LauncherInstance; children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Plugin launcher render failed", {
      pluginKey: this.props.instance.launcher.pluginKey,
      launcherId: this.props.instance.launcher.id,
      error,
      info: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <Alert variant="destructive">
          <AlertDescription>
            {this.props.instance.launcher.pluginDisplayName}: failed to render
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}

function LauncherRenderContent({
  instance,
  renderEnvironment,
}: {
  instance: LauncherInstance;
  renderEnvironment: PluginRenderEnvironmentContext;
}) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const hostContext = useMemo(
    () => buildLauncherHostContext(instance, renderEnvironment, session?.user.id ?? null),
    [instance, renderEnvironment, session?.user.id],
  );
  const node = createElement(instance.component.component, {
    context: hostContext,
  });
  return (
    <LauncherErrorBoundary instance={instance}>
      <PluginBridgeScope pluginId={instance.launcher.pluginId} hostContext={hostContext}>
        {node}
      </PluginBridgeScope>
    </LauncherErrorBoundary>
  );
}

export type LauncherModalShellProps = {
  instance: LauncherInstance;
  stackIndex: number;
  isTopmost: boolean;
  requestBounds: (key: string, request: PluginModalBoundsRequest) => Promise<void>;
  closeLauncher: (key: string, event: PluginRenderCloseEvent) => Promise<void>;
};

export function LauncherModalShell({
  instance,
  stackIndex,
  isTopmost,
  requestBounds,
  closeLauncher,
}: LauncherModalShellProps) {
  const renderEnvironment = useMemo<PluginRenderEnvironmentContext>(
    () => ({
      environment: "hostOverlay",
      launcherId: instance.launcher.id,
      bounds: instance.bounds,
      requestModalBounds: (request) => requestBounds(instance.key, request),
      closeLifecycle: {
        onBeforeClose: (handler) => {
          instance.beforeCloseHandlers.add(handler);
          return () => instance.beforeCloseHandlers.delete(handler);
        },
        onClose: (handler) => {
          instance.closeHandlers.add(handler);
          return () => instance.closeHandlers.delete(handler);
        },
      },
    }),
    [instance, requestBounds],
  );

  const baseZ = launcherOverlayBaseZIndex + stackIndex * 20;
  const shellType = instance.launcher.action.type;
  const containerStyle =
    shellType === "openPopover" ? launcherPopoverStyle(instance) : launcherShellBoundsStyle(instance.bounds);
  const panelClassName =
    shellType === "openDrawer"
      ? "inset-y-0 right-0 left-auto top-0 h-full translate-x-0 translate-y-0 rounded-none border-l"
      : shellType === "openPopover"
        ? "translate-x-0 translate-y-0"
        : undefined;

  return (
    <Dialog open modal={isTopmost} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className={cn("flex max-w-none flex-col gap-0 overflow-hidden p-0", panelClassName)}
        style={{
          zIndex: baseZ + 1,
          maxHeight: "calc(100vh - var(--spacing) * 8)",
          ...(shellType === "openDrawer"
            ? { width: containerStyle.width, maxHeight: "100vh" }
            : containerStyle),
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!isTopmost) return;
          void closeLauncher(instance.key, {
            reason: "escapeKey",
            nativeEvent: event,
          });
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
          if (!isTopmost) return;
          void closeLauncher(instance.key, {
            reason: "backdrop",
            nativeEvent: event,
          });
        }}
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 text-left">
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm">{instance.launcher.displayName}</DialogTitle>
            <DialogDescription className="truncate text-xs">
              {instance.launcher.pluginDisplayName}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void closeLauncher(instance.key, { reason: "programmatic" })}
          >
            Close
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <LauncherRenderContent instance={instance} renderEnvironment={renderEnvironment} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
