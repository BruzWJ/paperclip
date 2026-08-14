import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { queryKeys } from "@/lib/queryKeys";

/** Canonical active-run query projected to the live task id set used by task lists. */
export function useCompanyLiveTaskIds(companyId: string, enabled = true) {
  const { data } = useQuery({
    queryKey: queryKeys.runs(companyId, { status: ACTIVE_TASK_EXECUTION_RUN_STATUSES }),
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled,
  });
  return useMemo(() => collectLiveTaskIds(data?.items), [data?.items]);
}
