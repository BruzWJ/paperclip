import { pluginsApi } from "@/api/plugins";
import type { PluginDataResult } from "@paperclipai/plugin-sdk/ui";
import type { PluginBridgeError } from "@paperclipai/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractBridgeError,
  serializePluginBridgeParams,
  serializeRenderEnvironment,
  serializeRenderEnvironmentSnapshot,
  usePluginBridgeContext,
} from "./bridge-core";

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
  const renderEnvironmentSnapshot = serializeRenderEnvironment(hostContext.renderEnvironment);
  const renderEnvironmentKey = serializeRenderEnvironmentSnapshot(renderEnvironmentSnapshot);

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
    const retryableCodes: PluginBridgeError["code"][] = ["WORKER_UNAVAILABLE", "TIMEOUT"];
    setLoading(true);
    const request = () => {
      pluginsApi
        .bridgeGetData(pluginId, key, params, companyId, renderEnvironmentSnapshot)
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
          if (retryableCodes.includes(bridgeError.code) && retryCount < maxRetryCount) {
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
  }, [pluginId, key, paramsKey, refreshCounter, companyId, renderEnvironmentKey]);

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
export type PluginActionFn = (params?: Record<string, unknown>) => Promise<unknown>;

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
      const renderEnvironment = serializeRenderEnvironment(hostContext.renderEnvironment);

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
