import { useQuery } from "@tanstack/react-query";
import { adaptersApi, type AdapterInfo } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { syncServerAdapters } from "./registry";

/**
 * Fetch and install the server-admitted declarative ACP catalog in the UI
 * schema renderer. The browser cannot add, override, disable, or infer an
 * adapter entry.
 */
export function useAdapterCatalogSync(
  options: { enabled?: boolean } = {},
): readonly AdapterInfo[] {
  const { data } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });

  if (data) {
    syncServerAdapters(
      data.map((adapter) => ({ type: adapter.type, label: adapter.label })),
    );
  }

  return data ?? [];
}
