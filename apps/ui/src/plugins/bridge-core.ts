import { ApiError } from "@/api/client";
import type { PluginHostContext, PluginRenderEnvironmentContext } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginBridgeError,
  PluginLauncherRenderContextSnapshot,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";
import { PLUGIN_BRIDGE_ERROR_CODES } from "@paperclipai/shared";
import { createContext, useContext } from "react";

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
export const PluginBridgeContext = createContext<PluginBridgeContextValue | null>(null);

export function usePluginBridgeContext(): PluginBridgeContextValue {
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

function isPluginBridgeErrorCode(value: unknown): value is PluginBridgeError["code"] {
  return typeof value === "string" && PLUGIN_BRIDGE_ERROR_CODES.some((code) => code === value);
}

/**
 * Attempt to extract a structured PluginBridgeError from an API error.
 *
 * The bridge proxy endpoints return error bodies shaped as
 * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`.
 * This helper extracts that structure from the ApiError thrown by the client.
 */
export function extractBridgeError(err: unknown): PluginBridgeError {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as Record<string, unknown>;
    if (isPluginBridgeErrorCode(body.code) && typeof body.message === "string") {
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

function serializePluginBridgeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Plugin bridge parameters must contain only finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Plugin bridge parameters cannot contain ${typeof value} values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Plugin bridge parameters cannot contain circular references");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializePluginBridgeJson(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Plugin bridge parameters must contain only plain objects and arrays");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Plugin bridge parameters cannot contain symbol keys");
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializePluginBridgeJson(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable, strict JSON serialization used as the request dependency key. */
export function serializePluginBridgeParams(params?: Record<string, unknown>): string {
  return params === undefined ? "" : serializePluginBridgeJson(params, new Set());
}

export function serializeRenderEnvironment(
  renderEnvironment: PluginRenderEnvironmentContext | null,
): PluginLauncherRenderContextSnapshot | null {
  if (!renderEnvironment) return null;
  return {
    environment: renderEnvironment.environment,
    launcherId: renderEnvironment.launcherId,
    bounds: renderEnvironment.bounds,
  };
}

export function serializeRenderEnvironmentSnapshot(
  snapshot: PluginLauncherRenderContextSnapshot | null,
): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}
