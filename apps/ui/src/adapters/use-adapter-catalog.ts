import { useQuery } from "@tanstack/react-query";
import {
  validateAcpAdapterConfigOptions,
} from "@paperclipai/adapter-utils";
import {
  adaptersApi,
  type AdapterInfo,
  type ReadyAdapterInfo,
} from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { syncServerAdapters } from "./registry";

export interface AdapterCatalogSyncState {
  /** Exact selectable agents from the current successful server snapshot. */
  readonly adapters: readonly ReadyAdapterInfo[];
  /** True only while the initial catalogue snapshot is being resolved. */
  readonly isLoading: boolean;
  /** A whole-catalog refresh failed, rather than returning no agents. */
  readonly isError: boolean;
  readonly error: Error | null;
  /** Re-runs the local-agent catalogue request on operator demand. */
  readonly refetch: () => Promise<unknown>;
}

/**
 * Treat the ready catalog entries as a complete ACPX snapshot. Validation at
 * this boundary prevents the UI from ever interpreting malformed dynamic
 * fields, even though the server has already validated them.
 */
function validateAdapterCatalog(
  adapters: readonly AdapterInfo[],
): AdapterInfo[] {
  return adapters.map((adapter) => {
    if (!adapter.loaded) return adapter;
    let configOptions;
    try {
      configOptions = validateAcpAdapterConfigOptions(adapter.configOptions);
    } catch (error) {
      throw new Error(
        `Local agent "${adapter.type}" returned invalid ACPX configuration options. ${error instanceof Error ? error.message : ""}`,
      );
    }
    return { ...adapter, configOptions };
  });
}

export async function fetchAdapterCatalog(): Promise<AdapterInfo[]> {
  return validateAdapterCatalog(await adaptersApi.list());
}

/**
 * Fetch and install the server-admitted local-agent catalog in the UI
 * schema renderer. The browser cannot add, override, hide, or infer an
 * adapter entry. Local readiness diagnostics remain visible in the manager but
 * deliberately do not enter this selectable catalog.
 */
export function useAdapterCatalogSyncState(
  options: { enabled?: boolean } = {},
): AdapterCatalogSyncState {
  const enabled = options.enabled ?? true;
  const query = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: fetchAdapterCatalog,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    // The server checks local agents on a bounded cadence. Keep an open picker in
    // sync when a local compatible CLI is installed or authenticated.
    refetchInterval: 30_000,
  });
  const { data, isError, isSuccess } = query;

  const selectableAdapters = isSuccess && data
    ? data.filter(
      (adapter): adapter is ReadyAdapterInfo => adapter.loaded,
    )
    : [];

  if (isSuccess && data) {
    syncServerAdapters(
      selectableAdapters.map((adapter) => ({
        type: adapter.type,
        label: adapter.label,
      })),
    );
  } else if (enabled && isError) {
    // A failed refresh must not leave a prior catalog masquerading as current.
    syncServerAdapters([]);
  }

  return {
    adapters: selectableAdapters,
    isLoading: enabled && query.isPending,
    isError: enabled && isError,
    error: enabled && isError ? query.error : null,
    refetch: async () => await query.refetch(),
  };
}
