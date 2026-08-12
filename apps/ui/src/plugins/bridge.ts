/**
 * Plugin UI bridge runtime — concrete implementations of the bridge hooks.
 *
 * Plugin UI bundles import `usePluginData`, `usePluginAction`, and
 * `useHostContext` from `@paperclipai/plugin-sdk/ui`. The host module shim
 * binds those SDK runtime exports to these concrete implementations through
 * the initialized bridge registry.
 *
 * The bridge runtime communicates with plugin workers via HTTP REST endpoints:
 * - `POST /api/plugins/:pluginId/data/:key`     — proxies `getData` RPC
 * - `POST /api/plugins/:pluginId/actions/:key`   — proxies `performAction` RPC
 *
 * ## How it works
 *
 * 1. Before loading a plugin's UI module, the host creates a scoped bridge via
 *    `createPluginBridge(pluginId)`.
 * 2. The bridge's hook implementations are registered in a global bridge
 *    registry keyed by `pluginId`.
 * 3. The "ambient" hooks (`usePluginData`, `usePluginAction`, `useHostContext`)
 *    look up the current plugin context from a React context provider and
 *    delegate to the appropriate bridge instance.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  useLocation as useRouterLocation,
  useNavigate as useRouterNavigate,
} from "@tanstack/react-router";
import type {
  PluginBridgeError,
  PluginLauncherRenderContextSnapshot,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";
import type {
  HostLocation,
  HostNavigation,
  HostNavigationLinkOptions,
  HostNavigationLinkProps,
  HostNavigationOptions,
  PluginDataResult,
  PluginHostContext,
  PluginRenderEnvironmentContext,
  PluginToastFn,
  PluginToastInput,
} from "@paperclipai/plugin-sdk/ui";
import {
  PLUGIN_BRIDGE_ERROR_CODES,
  resolvePluginNavigationHref,
} from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { useToastActions } from "@/context/ToastContext";
import { useSidebar } from "@/context/SidebarContext";

export type { PluginBridgeError } from "@paperclipai/shared";
export type {
  HostLocation,
  HostNavigation,
  HostNavigationLinkOptions,
  HostNavigationLinkProps,
  HostNavigationOptions,
  PluginDataResult,
  PluginHostContext,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginRenderCloseHandler,
  PluginRenderEnvironmentContext,
  PluginToastFn,
  PluginToastInput,
} from "@paperclipai/plugin-sdk/ui";

export type PluginMountContext = {
  companyId?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  entityType?: PluginUiSlotEntityType | null;
};

// ---------------------------------------------------------------------------
// Bridge context — React context for plugin identity and host scope
// ---------------------------------------------------------------------------

export type PluginBridgeContextValue = {
  pluginId: string;
  hostContext: PluginHostContext;
};

/**
 * React context that carries the active plugin identity and host scope.
 *
 * The slot/launcher mount wraps plugin components in a Provider so that
 * bridge hooks (`usePluginData`, `usePluginAction`, `useHostContext`) can
 * resolve the current plugin without ambient mutable globals.
 *
 * Because plugin bundles share the host's React instance (via the bridge
 * registry on `globalThis.__paperclipPluginBridge__`), context propagation
 * works correctly across the host/plugin boundary.
 */
export const PluginBridgeContext =
  createContext<PluginBridgeContextValue | null>(null);

function usePluginBridgeContext(): PluginBridgeContextValue {
  const ctx = useContext(PluginBridgeContext);
  if (!ctx) {
    throw new Error(
      "Plugin bridge hook called outside of a <PluginBridgeContext.Provider>. " +
        "Ensure the plugin component is rendered within a PluginBridgeScope.",
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Error extraction helpers
// ---------------------------------------------------------------------------

function isPluginBridgeErrorCode(
  value: unknown,
): value is PluginBridgeError["code"] {
  return (
    typeof value === "string" &&
    PLUGIN_BRIDGE_ERROR_CODES.some((code) => code === value)
  );
}

/**
 * Attempt to extract a structured PluginBridgeError from an API error.
 *
 * The bridge proxy endpoints return error bodies shaped as
 * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`.
 * This helper extracts that structure from the ApiError thrown by the client.
 */
function extractBridgeError(err: unknown): PluginBridgeError {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as Record<string, unknown>;
    if (
      isPluginBridgeErrorCode(body.code) &&
      typeof body.message === "string"
    ) {
      return {
        code: body.code,
        message: body.message,
        details: body.details,
      };
    }
  }

  return {
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

// ---------------------------------------------------------------------------
// usePluginData — concrete implementation
// ---------------------------------------------------------------------------

function serializePluginBridgeJson(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Plugin bridge parameters must contain only finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(
      `Plugin bridge parameters cannot contain ${typeof value} values`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError(
      "Plugin bridge parameters cannot contain circular references",
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializePluginBridgeJson(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Plugin bridge parameters must contain only plain objects and arrays",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(
        "Plugin bridge parameters cannot contain symbol keys",
      );
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializePluginBridgeJson(record[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable, strict JSON serialization used as the request dependency key. */
export function serializePluginBridgeParams(
  params?: Record<string, unknown>,
): string {
  return params === undefined
    ? ""
    : serializePluginBridgeJson(params, new Set());
}

function serializeRenderEnvironment(
  renderEnvironment: PluginRenderEnvironmentContext | null,
): PluginLauncherRenderContextSnapshot | null {
  if (!renderEnvironment) return null;
  return {
    environment: renderEnvironment.environment,
    launcherId: renderEnvironment.launcherId,
    bounds: renderEnvironment.bounds,
  };
}

function serializeRenderEnvironmentSnapshot(
  snapshot: PluginLauncherRenderContextSnapshot | null,
): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

export function shouldHandleHostNavigationClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  target?: string,
): boolean {
  if (!isPlainLeftClick(event)) return false;
  if (target && target !== "_self") return false;
  if (event.currentTarget.hasAttribute("download")) return false;
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * Concrete implementation of `usePluginData<T>(key, params)`.
 *
 * Makes an HTTP POST to `/api/plugins/:pluginId/data/:key` and returns
 * a reactive `PluginDataResult<T>` matching the SDK type contract.
 *
 * Re-fetches automatically when `key` or `params` change. Provides a
 * `refresh()` function for manual re-fetch.
 */
export function usePluginData<T = unknown>(
  key: string,
  params?: Record<string, unknown>,
): PluginDataResult<T> {
  const { pluginId, hostContext } = usePluginBridgeContext();
  const companyId = hostContext.companyId;
  const renderEnvironmentSnapshot = serializeRenderEnvironment(
    hostContext.renderEnvironment,
  );
  const renderEnvironmentKey = serializeRenderEnvironmentSnapshot(
    renderEnvironmentSnapshot,
  );

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PluginBridgeError | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Stable serialization for params change detection
  const paramsKey = serializePluginBridgeParams(params);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const maxRetryCount = 2;
    const retryableCodes: PluginBridgeError["code"][] = [
      "WORKER_UNAVAILABLE",
      "TIMEOUT",
    ];
    setLoading(true);
    const request = () => {
      pluginsApi
        .bridgeGetData(
          pluginId,
          key,
          params,
          companyId,
          renderEnvironmentSnapshot,
        )
        .then((response) => {
          if (!cancelled) {
            setData(response.data as T);
            setError(null);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;

          const bridgeError = extractBridgeError(err);
          if (
            retryableCodes.includes(bridgeError.code) &&
            retryCount < maxRetryCount
          ) {
            retryCount += 1;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) request();
            }, 150 * retryCount);
            return;
          }

          setError(bridgeError);
          setData(null);
          setLoading(false);
        });
    };

    request();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pluginId,
    key,
    paramsKey,
    refreshCounter,
    companyId,
    renderEnvironmentKey,
  ]);

  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1);
  }, []);

  return { data, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// usePluginAction — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Action function type matching the SDK's `PluginActionFn`.
 */
export type PluginActionFn = (
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Concrete implementation of `usePluginAction(key)`.
 *
 * Returns a stable async function that, when called, sends a POST to
 * `/api/plugins/:pluginId/actions/:key` and returns the worker result.
 *
 * On failure, the function throws a `PluginBridgeError`.
 */
export function usePluginAction(key: string): PluginActionFn {
  const bridgeContext = usePluginBridgeContext();
  const contextRef = useRef(bridgeContext);
  contextRef.current = bridgeContext;

  return useCallback(
    async (params?: Record<string, unknown>): Promise<unknown> => {
      const { pluginId, hostContext } = contextRef.current;
      const companyId = hostContext.companyId;
      const renderEnvironment = serializeRenderEnvironment(
        hostContext.renderEnvironment,
      );

      try {
        const response = await pluginsApi.bridgePerformAction(
          pluginId,
          key,
          params,
          companyId,
          renderEnvironment,
        );
        return response.data;
      } catch (err) {
        throw extractBridgeError(err);
      }
    },
    [key],
  );
}

// ---------------------------------------------------------------------------
// useHostContext — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `useHostContext()`.
 *
 * Returns the current host context (company, project, entity, user)
 * from the enclosing `PluginBridgeContext.Provider`.
 */
export function useHostContext(): PluginHostContext {
  const { hostContext } = usePluginBridgeContext();
  return hostContext;
}

// ---------------------------------------------------------------------------
// useHostNavigation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostNavigation(): HostNavigation {
  const { hostContext } = usePluginBridgeContext();
  const routerNavigate = useRouterNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const companyId = hostContext.companyId;

  const resolveHref = useCallback(
    (to: string) => resolvePluginNavigationHref(to, companyId),
    [companyId],
  );

  const navigateResolvedHref = useCallback(
    (href: string, options?: HostNavigationOptions) => {
      void routerNavigate({
        href,
        replace: options?.replace,
        state: options?.state,
      });
      // Mirror host sidebar behavior: tapping a link inside the mobile drawer
      // dismisses the drawer so the user can see the destination page.
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, routerNavigate, setSidebarOpen],
  );

  const navigate = useCallback(
    (to: string, options?: HostNavigationOptions) => {
      navigateResolvedHref(resolveHref(to), options);
    },
    [navigateResolvedHref, resolveHref],
  );

  const linkProps = useCallback(
    (
      to: string,
      options?: HostNavigationLinkOptions,
    ): HostNavigationLinkProps => {
      const href = resolveHref(to);
      return {
        href,
        target: options?.target,
        rel: options?.rel,
        onClick: (event) => {
          if (!shouldHandleHostNavigationClick(event, href, options?.target))
            return;
          event.preventDefault();
          navigateResolvedHref(href, options);
        },
      };
    },
    [navigateResolvedHref, resolveHref],
  );

  return useMemo(
    () => ({
      resolveHref,
      navigate,
      linkProps,
    }),
    [linkProps, navigate, resolveHref],
  );
}

// ---------------------------------------------------------------------------
// useHostLocation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostLocation(): HostLocation {
  const location = useRouterLocation();
  return useMemo(
    () => ({
      pathname: location.pathname,
      search: location.searchStr,
      hash: location.hash ? `#${location.hash}` : "",
      state: location.state,
    }),
    [location.hash, location.pathname, location.searchStr, location.state],
  );
}

// ---------------------------------------------------------------------------
// usePluginToast — concrete implementation
// ---------------------------------------------------------------------------

export function usePluginToast(): PluginToastFn {
  const { pushToast } = useToastActions();
  return useCallback(
    (input: PluginToastInput) =>
      pushToast({
        ...input,
        action: input.action
          ? {
              label: input.action.label,
              target: { kind: "plugin", href: input.action.href },
            }
          : undefined,
      }),
    [pushToast],
  );
}
