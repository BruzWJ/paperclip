import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { dashboardApi } from "../api/dashboard";
import { runsApi } from "../api/runs";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  filterLocalInboxArchivedIssues,
  useLocalInboxArchiveIssueIds,
} from "../lib/inboxArchiveCache";
import { usePublishSharedQueryData, useSharedPollingQuery } from "./useSharedPolling";
import {
  buildInboxDismissedAtByKey,
  computeInboxBadgeData,
  getRecentTouchedIssues,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";

const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";
const INBOX_BADGE_ISSUE_LIMIT = 500;
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
    queryClient.setQueryData(queryKey, [
      {
        id: `optimistic:${itemKey}`,
        companyId,
        userId: "me",
        itemKey,
        dismissedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      ...previous.filter((dismissal) => dismissal.itemKey !== itemKey),
    ]);
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
  const locallyArchivedIssueIds = useLocalInboxArchiveIssueIds(companyId);
  const { dismissed: dismissedAlerts } = useDismissedInboxAlerts();
  const { dismissedAtByKey } = useInboxDismissals(companyId);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

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
  const sharedDashboard = useSharedPollingQuery({
    companyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!companyId,
  });
  const { data: dashboard, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });
  usePublishSharedQueryData(sharedDashboard, dashboard, dashboardUpdatedAt);

  const mineIssuesQueryKey = queryKeys.issues.listMineByMe(companyId!);
  const sharedMineIssues = useSharedPollingQuery({
    companyId,
    resourceKey: "inbox-badge:mine-issues",
    queryKey: mineIssuesQueryKey,
    enabled: !!companyId,
  });
  const { data: mineIssuesRaw = [], dataUpdatedAt: mineIssuesUpdatedAt } = useQuery({
    queryKey: mineIssuesQueryKey,
    queryFn: () =>
      issuesApi.list(companyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
        limit: INBOX_BADGE_ISSUE_LIMIT,
      }),
    enabled: !!companyId,
    refetchOnWindowFocus: false,
    staleTime: INBOX_BADGE_HOT_PATH_STALE_MS,
  });
  usePublishSharedQueryData(sharedMineIssues, mineIssuesRaw, mineIssuesUpdatedAt);

  const mineIssues = useMemo(
    () => getRecentTouchedIssues(filterLocalInboxArchivedIssues(companyId, mineIssuesRaw)),
    [companyId, locallyArchivedIssueIds, mineIssuesRaw],
  );
  const currentUserId = session?.user.id ?? session?.session.userId ?? null;

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
        mineIssues,
        dismissedAlerts,
        dismissedAtByKey,
        currentUserId,
      }),
    [approvals, joinRequests, dashboard, runPage?.items, mineIssues, dismissedAlerts, dismissedAtByKey, currentUserId],
  );
}
