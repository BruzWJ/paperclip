import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adaptersApi,
  type ReadyAdapterInfo,
} from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { syncServerAdapters } from "./registry";

/**
 * Fetch and install the server-admitted ACPX catalog in the UI
 * schema renderer. The browser cannot add, override, hide, or infer an
 * adapter entry. ACPX probe diagnostics remain visible in the manager but
 * deliberately do not enter this selectable catalog.
 */
export function useAdapterCatalogSync(
  options: { enabled?: boolean } = {},
): readonly ReadyAdapterInfo[] {
  const queryClient = useQueryClient();
  const previousCatalogUpdateAt = useRef(0);
  const enabled = options.enabled ?? true;
  const { data, dataUpdatedAt, isError, isSuccess } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    // The server probes ACPX on a bounded cadence. Keep an open picker in
    // sync when a local compatible CLI is installed or authenticated.
    refetchInterval: 30_000,
  });

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
        drivers: adapter.drivers,
      })),
    );
  } else if (enabled && isError) {
    // A failed refresh must not leave a prior catalog masquerading as current.
    syncServerAdapters([]);
  }

  useEffect(() => {
    if (!isSuccess || dataUpdatedAt === 0) return;
    const previousUpdateAt = previousCatalogUpdateAt.current;
    previousCatalogUpdateAt.current = dataUpdatedAt;
    if (previousUpdateAt === 0 || previousUpdateAt === dataUpdatedAt) return;

    // Config schema values are adapter-owned and may change independently of
    // labels. Clear active schemas after every fresh catalog snapshot so an
    // editor never keeps an older option list.
    void queryClient.resetQueries({
      queryKey: queryKeys.adapters.configSchemas,
    });
  }, [dataUpdatedAt, isSuccess, queryClient]);

  return selectableAdapters;
}
