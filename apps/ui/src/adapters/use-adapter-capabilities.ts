import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi, type AdapterCapabilities } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";

const UNAVAILABLE: AdapterCapabilities = {
  supportsModelProfiles: false,
  contractVersion: "acpx-runtime/v1",
  runtimeControls: [],
};

/**
 * Returns a lookup function that resolves adapter capabilities by type.
 *
 * Capabilities come only from the server's ACPX catalog API. Missing catalog
 * state fails closed until ACPX supplies the exact entry.
 */
export function useAdapterCapabilities(): (type: string) => AdapterCapabilities {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const capMap = useMemo(() => {
    const map = new Map<string, AdapterCapabilities>();
    if (adapters) {
      for (const a of adapters) {
        if (!a.loaded) continue;
        map.set(a.type, a.capabilities);
      }
    }
    return map;
  }, [adapters]);

  return (type: string): AdapterCapabilities =>
    capMap.get(type) ?? UNAVAILABLE;
}
