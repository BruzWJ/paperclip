import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { dashboardApi } from "../api/dashboard";
import { runsApi } from "../api/runs";
import { tasksApi } from "../api/tasks";
import { INBOX_MINE_TASK_STATUSES, type AuthSession } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import {
  filterLocalInboxArchivedTasks,
  useLocalInboxArchiveTaskIds,
} from "../lib/inboxArchiveCache";
import {
  buildInboxDismissedAtByKey,
  computeInboxBadgeData,
  getRecentTouchedTasks,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";

const INBOX_BADGE_TASK_LIMIT = 500;
const INBOX_BADGE_RUN_LIMIT = 200;
const INBOX_BADGE_HOT_PATH_STALE_MS = 30_000;

export function useDismissedInboxAlerts() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxAlerts);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxAlerts());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxAlerts(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxDismissals(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.inboxDismissals(companyId)
    : ["inbox-dismissals", "__disabled__"] as const;

  const { data: dismissals = [] } = useQuery({
    queryKey,
    queryFn: () => inboxDismissalsApi.list(companyId!),
    enabled: !!companyId,
  });

  function invalidateDismissalConsumers() {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
  }

  const dismissedAtByKey = useMemo(
    () => buildInboxDismissedAtByKey(dismissals),
    [dismissals],
  );

  const [pendingCount, setPendingCount] = useState(0);
  const dismiss = useCallback((itemKey: string) => {
    if (!companyId) return;
    const previous = queryClient.getQueryData<typeof dismissals>(queryKey) ?? [];
    const now = new Date();
    const currentUserId = queryClient.getQueryData<AuthSession | null>(
      queryKeys.auth.session,
    )?.user.id;
    if (currentUserId) {
      queryClient.setQueryData(queryKey, [
        {
          id: `optimistic:${itemKey}`,
          companyId,
          userId: currentUserId,
          itemKey,
          dismissedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        ...previous.filter((dismissal) => dismissal.itemKey !== itemKey),
      ]);
    }
    setPendingCount((count) => count + 1);
    void inboxDismissalsApi.dismiss(companyId, itemKey)
      .catch(() => {
        queryClient.setQueryData(queryKey, previous);
      })
      .finally(() => {
        setPendingCount((count) => Math.max(0, count - 1));
        invalidateDismissalConsumers();
      });
  }, [companyId, dismissals, queryClient, queryKey]);
  const snooze = useCallback(
    (itemKey: string, snoozedUntil: string) => {
      if (!companyId) return;
      setPendingCount((count) => count + 1);
      void inboxDismissalsApi.snooze(companyId, itemKey, snoozedUntil)
        .catch(() => undefined)
        .finally(() => {
          setPendingCount((count) => Math.max(0, count - 1));
          invalidateDismissalConsumers();
        });
    },
    [companyId, queryClient, queryKey],
  );
  const restore = useCallback((itemKey: string) => {
    if (!companyId) return;
    setPendingCount((count) => count + 1);
    void inboxDismissalsApi.restore(companyId, itemKey)
      .catch(() => undefined)
      .finally(() => {
        setPendingCount((count) => Math.max(0, count - 1));
        invalidateDismissalConsumers();
      });
  }, [companyId, queryClient, queryKey]);

  return {
    dismissals,
    dismissedAtByKey,
    dismiss,
    snooze,
    restore,
    isPending: pendingCount > 0,
  };
}

export function useReadInboxItems() {
  const [readItems, setReadItems] = useState<Set<string>>(loadReadInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== READ_ITEMS_KEY) return;
      setReadItems(loadReadInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const markRead = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  const markUnread = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  return { readItems, markRead, markUnread };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const locallyArchivedTaskIds = useLocalInboxArchiveTaskIds(companyId);
  const { dismissed: dismissedAlerts } = useDismissedInboxAlerts();
  const { dismissedAtByKey } = useInboxDismissals(companyId);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!companyId,
    retry: false,
  });

  const dashboardQueryKey = queryKeys.dashboard(companyId!);
  const { data: dashboard } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const mineTasksQueryKey = queryKeys.tasks.listMineByMe(companyId!);
  const { data: mineTasksRaw = [] } = useQuery({
    queryKey: mineTasksQueryKey,
    queryFn: () =>
      tasksApi.list(companyId!, {
        touchedByUserId: currentUserId!,
        inboxArchivedByUserId: currentUserId!,
        status: INBOX_MINE_TASK_STATUSES,
        limit: INBOX_BADGE_TASK_LIMIT,
      }),
    enabled: !!companyId && !!currentUserId,
    refetchOnWindowFocus: false,
    staleTime: INBOX_BADGE_HOT_PATH_STALE_MS,
  });

  const mineTasks = useMemo(
    () => getRecentTouchedTasks(filterLocalInboxArchivedTasks(companyId, mineTasksRaw)),
    [companyId, locallyArchivedTaskIds, mineTasksRaw],
  );

  const { data: runPage } = useQuery({
    queryKey: queryKeys.runs(companyId!),
    queryFn: () => runsApi.listForCompany(companyId!, { limit: INBOX_BADGE_RUN_LIMIT }),
    enabled: !!companyId,
    refetchOnWindowFocus: false,
    staleTime: INBOX_BADGE_HOT_PATH_STALE_MS,
  });

  return useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        runs: runPage?.items ?? [],
        mineTasks,
        dismissedAlerts,
        dismissedAtByKey,
        currentUserId,
      }),
    [approvals, joinRequests, dashboard, runPage?.items, mineTasks, dismissedAlerts, dismissedAtByKey, currentUserId],
  );
}
