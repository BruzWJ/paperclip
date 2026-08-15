import { accessApi } from "@/api/access";
import { tasksApi } from "@/api/tasks";
import { useApprovalMutations } from "@/hooks/useApprovalMutations";
import { isMineInboxTab, type InboxTab } from "@/lib/inbox";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  cancelInboxTaskQueries,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  getTaskPresenceInActiveInboxCaches,
  invalidateInboxTaskQueries,
  removeTaskFromInboxCaches,
  restoreTaskToInboxCaches,
  snapshotInboxTaskCaches,
} from "@/lib/inboxArchiveCache";
import { queryKeys } from "@/lib/queryKeys";
import type { JoinRequest } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { NonTaskUnreadState } from "./-InboxRowShared";
import type { InboxState } from "./-useInboxState";

export interface UseInboxMutationsOptions {
  companyId: string;
  tab: InboxTab;
  state: InboxState;
}

/** Owns inbox approval, archive, and read-state mutations. */
export function useInboxMutations({ companyId, tab, state }: UseInboxMutationsOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const {
    setActionError,
    setArchivingTaskIds,
    setUndoableArchiveTaskIds,
    setUnarchivingTaskIds,
    setFadingOutTasks,
    setFadingNonTaskItems,
    setArchivingNonTaskIds,
    dismissAlert,
    dismissInboxItem,
    readItems,
    markItemRead,
  } = state;
  const canArchiveFromTab = isMineInboxTab(tab);
  const { approveMutation, rejectMutation } = useApprovalMutations(companyId);

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) => accessApi.approveJoinRequest(companyId, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to approve join request");
    },
  });
  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) => accessApi.rejectJoinRequest(companyId, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to reject join request");
    },
  });
  const invalidateInboxTaskQueryCaches = useCallback(() => {
    invalidateInboxTaskQueries(queryClient, companyId);
  }, [companyId, queryClient]);
  const archiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onMutate: async (id) => {
      setActionError(null);
      setArchivingTaskIds((previous) => new Set(previous).add(id));
      beginLocalInboxArchive(companyId, id);
      await cancelInboxTaskQueries(queryClient, companyId);
      const previousData = snapshotInboxTaskCaches(queryClient, companyId);
      removeTaskFromInboxCaches(queryClient, companyId, id);
      return { companyId, previousData };
    },
    onError: (error, id, context) => {
      setActionError(error instanceof Error ? error.message : "Failed to archive task");
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      setArchivingTaskIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      if (context?.previousData) restoreTaskToInboxCaches(queryClient, context.previousData, id);
    },
    onSettled: async (_data, error, id, context) => {
      setArchivingTaskIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxTaskQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getTaskPresenceInActiveInboxCaches(queryClient, context.companyId, id);
        if (presence !== "unknown") confirmLocalInboxArchive(context.companyId, id);
      }
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((previous) => [...previous.filter((taskId) => taskId !== id), id]);
    },
  });
  const unarchiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.unarchiveFromInbox(id),
    onMutate: (id) => {
      setActionError(null);
      setUnarchivingTaskIds((previous) => new Set(previous).add(id));
      clearLocalInboxArchive(companyId, id);
      return { companyId };
    },
    onError: (error, id, context) => {
      setActionError(error instanceof Error ? error.message : "Failed to undo inbox archive");
      if (context?.companyId) {
        beginLocalInboxArchive(context.companyId, id);
        boundLocalInboxArchive(context.companyId, id);
      }
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((previous) => previous.filter((taskId) => taskId !== id));
    },
    onSettled: (_data, _error, id) => {
      setUnarchivingTaskIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      invalidateInboxTaskQueryCaches();
    },
  });
  const markReadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onMutate: (id) => setFadingOutTasks((previous) => new Set(previous).add(id)),
    onSuccess: invalidateInboxTaskQueryCaches,
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutTasks((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });
  const markAllReadMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      await Promise.all(taskIds.map((taskId) => tasksApi.markRead(taskId)));
    },
    onMutate: (taskIds) => {
      setFadingOutTasks((previous) => {
        const next = new Set(previous);
        for (const taskId of taskIds) next.add(taskId);
        return next;
      });
    },
    onSuccess: invalidateInboxTaskQueryCaches,
    onSettled: (_data, _error, taskIds) => {
      setTimeout(() => {
        setFadingOutTasks((previous) => {
          const next = new Set(previous);
          for (const taskId of taskIds) next.delete(taskId);
          return next;
        });
      }, 300);
    },
  });
  const markUnreadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markUnread(id),
    onSuccess: invalidateInboxTaskQueryCaches,
  });
  const handleMarkNonTaskRead = useCallback(
    (key: string) => {
      setFadingNonTaskItems((previous) => new Set(previous).add(key));
      markItemRead(key);
      setTimeout(() => {
        setFadingNonTaskItems((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }, 300);
    },
    [markItemRead, setFadingNonTaskItems],
  );
  const handleArchiveNonTask = useCallback(
    (key: string) => {
      setArchivingNonTaskIds((previous) => new Set(previous).add(key));
      setTimeout(() => {
        if (key.startsWith("alert:")) dismissAlert(key);
        else dismissInboxItem(key);
        setArchivingNonTaskIds((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }, 200);
    },
    [dismissAlert, dismissInboxItem, setArchivingNonTaskIds],
  );
  const nonTaskUnreadState = (key: string): NonTaskUnreadState => {
    if (!canArchiveFromTab) return null;
    if (state.fadingNonTaskItems.has(key)) return "fading";
    if (!readItems.has(key)) return "visible";
    return "hidden";
  };

  return {
    queryClient,
    canArchiveFromTab,
    approveMutation,
    rejectMutation,
    approveJoinMutation,
    rejectJoinMutation,
    invalidateInboxTaskQueryCaches,
    archiveTaskMutation,
    unarchiveTaskMutation,
    markReadMutation,
    markAllReadMutation,
    markUnreadMutation,
    handleMarkNonTaskRead,
    handleArchiveNonTask,
    nonTaskUnreadState,
  };
}
