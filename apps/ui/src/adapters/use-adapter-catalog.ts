import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  validateAdapterConfigSchema,
  type AdapterConfigSchema,
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

function clearAdapterConfigSchemas(queryClient: QueryClient): void {
  queryClient.removeQueries({
    queryKey: queryKeys.adapters.configSchemas,
  });
}

/**
 * Treat the ready catalog entries as a complete ACPX snapshot. Validation at
 * this boundary prevents the UI from ever interpreting malformed dynamic
 * fields, even though the server has already validated them.
 */
function replaceAdapterConfigSchemas(
  queryClient: QueryClient,
  adapters: readonly AdapterInfo[],
): void {
  const schemasByType = new Map<string, AdapterConfigSchema>();
  for (const adapter of adapters) {
    if (!adapter.loaded) continue;
    const parsedSchema = validateAdapterConfigSchema(adapter.configSchema);
    if (!parsedSchema.success) {
      throw new Error(
        `Local agent "${adapter.type}" returned an invalid configuration schema. ${parsedSchema.errors.join(" ")}`,
      );
    }
    schemasByType.set(adapter.type, parsedSchema.data);
  }

  // A catalog refresh is authoritative. Keep no schema for an agent that is
  // no longer admitted, while replacing every schema that remains selectable.
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: queryKeys.adapters.configSchemas,
  })) {
    const adapterType = query.queryKey[2];
    if (typeof adapterType === "string" && !schemasByType.has(adapterType)) {
      queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
    }
  }
  for (const [adapterType, schema] of schemasByType) {
    queryClient.setQueryData(
      queryKeys.adapters.configSchema(adapterType),
      schema,
    );
  }
}

async function fetchAdapterCatalog(queryClient: QueryClient): Promise<AdapterInfo[]> {
  try {
    const adapters = await adaptersApi.list();
    // The catalog request already caused ACPX to discover every admitted
    // adapter. Prime all option schemas from that one snapshot so selecting a
    // different adapter never needs a second schema request.
    replaceAdapterConfigSchemas(queryClient, adapters);
    return adapters;
  } catch (error) {
    // Do not retain options from an older or malformed catalog after its
    // authoritative refresh failed.
    clearAdapterConfigSchemas(queryClient);
    throw error;
  }
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
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const query = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => fetchAdapterCatalog(queryClient),
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
    clearAdapterConfigSchemas(queryClient);
  }

  return {
    adapters: selectableAdapters,
    isLoading: enabled && query.isPending,
    isError: enabled && isError,
    error: enabled && isError ? query.error : null,
    refetch: async () => await query.refetch(),
  };
}

/**
 * Compatibility shorthand for consumers that only need the current dynamic
 * local-agent selection set. New picker surfaces should prefer the stateful variant
 * so they can distinguish a failed refresh from an empty successful catalog.
 */
export function useAdapterCatalogSync(
  options: { enabled?: boolean } = {},
): readonly ReadyAdapterInfo[] {
  return useAdapterCatalogSyncState(options).adapters;
}
