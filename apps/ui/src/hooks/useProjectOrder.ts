import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SidebarOrderPreference } from "@paperclipai/shared";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { sortProjectsByStoredOrder } from "../lib/project-order";
import { queryKeys } from "../lib/queryKeys";
import { completeOrderedIds, orderedIdsEqual } from "../lib/ordered-ids";

type UseProjectOrderParams = {
  projects: Project[];
  companyId: string | null | undefined;
  userId: string | null | undefined;
};

function buildOrderIds(projects: Project[], orderedIds: string[]) {
  return sortProjectsByStoredOrder(projects, orderedIds).map((project) => project.id);
}

export function useProjectOrder({ projects, companyId, userId }: UseProjectOrderParams) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () =>
      companyId && userId
        ? queryKeys.sidebarPreferences.projectOrder(companyId, userId)
        : (["sidebar-preferences", "project-order", companyId ?? null, userId ?? null] as const),
    [companyId, userId],
  );

  const { data } = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.getProjectOrder(companyId!, userId!),
    enabled: Boolean(companyId && userId),
  });

  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    return buildOrderIds(projects, []);
  });

  useEffect(() => {
    const nextIds = buildOrderIds(projects, data?.orderedIds ?? []);
    setOrderedIds((current) => (orderedIdsEqual(current, nextIds) ? current : nextIds));
  }, [data?.orderedIds, projects]);

  const orderedProjects = useMemo(
    () => sortProjectsByStoredOrder(projects, orderedIds),
    [projects, orderedIds],
  );

  const persistOrder = useCallback(
    (ids: string[]) => {
      const filtered = completeOrderedIds(projects, ids);

      setOrderedIds((current) => (orderedIdsEqual(current, filtered) ? current : filtered));
      if (!companyId || !userId) return;

      queryClient.setQueryData(queryKey, (current: SidebarOrderPreference | undefined) => ({
        orderedIds: filtered,
        updatedAt: current?.updatedAt ?? null,
      }));
      void sidebarPreferencesApi
        .updateProjectOrder(companyId, userId, { orderedIds: filtered })
        .then((preference) => {
          queryClient.setQueryData(queryKey, preference);
        })
        // Keep the reordering optimistic when a background preference sync
        // fails; callers should not receive an unhandled promise rejection.
        .catch(() => undefined);
    },
    [companyId, projects, queryClient, queryKey, userId],
  );

  return {
    orderedProjects,
    orderedIds,
    persistOrder,
  };
}
