import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { sortProjectsByStoredOrder } from "../lib/project-order";
import { queryKeys } from "../lib/queryKeys";

type UseProjectOrderParams = {
  projects: Project[];
  companyId: string | null | undefined;
  userId: string | null | undefined;
};

function areEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildOrderIds(projects: Project[], orderedIds: string[]) {
  return sortProjectsByStoredOrder(projects, orderedIds).map((project) => project.id);
}

export function useProjectOrder({ projects, companyId, userId }: UseProjectOrderParams) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => companyId && userId
      ? queryKeys.sidebarPreferences.projectOrder(companyId, userId)
      : ["sidebar-preferences", "project-order", companyId ?? null, userId ?? null] as const,
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
    setOrderedIds((current) => (areEqual(current, nextIds) ? current : nextIds));
  }, [data?.orderedIds, projects]);

  const orderedProjects = useMemo(
    () => sortProjectsByStoredOrder(projects, orderedIds),
    [projects, orderedIds],
  );

  const persistOrder = useCallback(
    (ids: string[]) => {
      const idSet = new Set(projects.map((project) => project.id));
      const filtered = ids.filter((id) => idSet.has(id));
      for (const project of projects) {
        if (!filtered.includes(project.id)) filtered.push(project.id);
      }

      setOrderedIds((current) => (areEqual(current, filtered) ? current : filtered));
      if (!companyId || !userId) return;

      queryClient.setQueryData(queryKey, (current: { orderedIds?: string[]; updatedAt?: Date | null } | undefined) => ({
        orderedIds: filtered,
        updatedAt: current?.updatedAt ?? null,
      }));
      void sidebarPreferencesApi.updateProjectOrder(companyId, userId, { orderedIds: filtered })
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
