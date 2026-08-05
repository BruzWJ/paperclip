import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** Renders `children` when used as a wrapper, or an `<Outlet />` as a layout route. */
export function PipelinesExperimentalGate({ children }: { children?: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enablePipelines !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children ?? <Outlet />}</>;
}
