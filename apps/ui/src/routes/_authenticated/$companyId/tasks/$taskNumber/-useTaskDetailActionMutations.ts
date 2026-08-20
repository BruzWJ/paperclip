import { approvalsApi } from "@/api/approvals";
import { tasksApi } from "@/api/tasks";
import { toast } from "sonner";
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
import { createOptimisticTaskComment, type OptimisticTaskComment } from "@/lib/optimistic-task-comments";
import { fileBaseName, slugifyDocumentKey, titleizeFilename } from "@/lib/document-file-names";
import { queryKeys } from "@/lib/queryKeys";
import type { CreateTaskUserComment, Task, TaskTreeControlMode } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type Dispatch, type SetStateAction } from "react";

import { readTaskRunStateFromCache, taskTreeControlLabel } from "./-task-detail-model";
import type { useTaskDetailCacheActions } from "./-useTaskDetailEffects";

interface TaskDetailActionMutationsOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  currentUserId: string | null;
  navigateToTaskSource: (replace?: boolean) => Promise<unknown> | unknown;
  cacheActions: ReturnType<typeof useTaskDetailCacheActions>;
}

interface ApprovalDecisionInput {
  approvalId: string;
  action: "approve" | "reject";
}

/** Owns approval, comment, attachment, document, and inbox mutations. */
export function useTaskDetailActionMutations({
  companyId,
  taskId,
  task,
  currentUserId,
  navigateToTaskSource,
  cacheActions,
}: TaskDetailActionMutationsOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const [pendingApprovalAction, setPendingApprovalAction] = useState<ApprovalDecisionInput | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [optimisticComments, setOptimisticComments] = useState<OptimisticTaskComment[]>([]);
  const [locallyQueuedCommentRunIds, setLocallyQueuedCommentRunIds] = useState<Map<string, string>>(
    () => new Map(),
  );
  const {
    invalidateTaskDetail,
    invalidateTaskThreadLazily,
    invalidateTaskRunState,
    invalidateTaskCollections,
  } = cacheActions;

  const approvalDecision = useMutation({
    mutationFn: async ({ approvalId, action }: ApprovalDecisionInput) =>
      action === "approve" ? approvalsApi.approve(approvalId) : approvalsApi.reject(approvalId),
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateTaskDetail();
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.approvals(taskId),
      });
      invalidateTaskCollections();
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.detail(variables.approvalId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(companyId),
      });
      toast.success(variables.action === "approve" ? "Approval approved" : "Approval rejected");
    },
    onError: (error, variables) => {
      toast.error(variables.action === "approve" ? "Approval failed" : "Rejection failed", {
        description: error instanceof Error ? error.message : "Unable to update approval",
      });
    },
    onSettled: () => setPendingApprovalAction(null),
  });

  const addComment = useMutation({
    mutationFn: (input: CreateTaskUserComment) => tasksApi.addComment(taskId, input),
    onMutate: async ({ message, mention }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.comments(taskId),
      });
      const queuedComment = mention
        ? readTaskRunStateFromCache(queryClient, taskId).interruptibleTaskRun
        : null;
      const optimisticComment = task
        ? createOptimisticTaskComment({
            body: message,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
          })
        : null;
      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
      };
    },
    onSuccess: ({ comment }, variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (variables.mention && context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.comments(taskId),
      });
    },
    onError: (error, variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      toast.error("Comment failed", {
        description: error instanceof Error ? error.message : "Unable to post comment",
      });
      if (variables.mention) invalidateTaskDetail();
    },
    onSettled: (_result, _error, variables) => {
      invalidateTaskThreadLazily();
      if (variables.mention) {
        invalidateTaskRunState();
      }
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: (file: File) => tasksApi.uploadAttachment(companyId, taskId, file),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.attachments(taskId),
      });
      invalidateTaskDetail();
    },
    onError: (error) => {
      setAttachmentError(error instanceof Error ? error.message : "Upload failed");
    },
  });
  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (task?.documentSummaries ?? []).find((document) => document.key === key) ?? null;
      const body = await file.text();
      const nextTitle = existing?.title ?? titleizeFilename(baseName) ?? null;
      return tasksApi.upsertDocument(taskId, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateTaskDetail();
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.documents(taskId),
      });
    },
    onError: (error) => {
      setAttachmentError(error instanceof Error ? error.message : "Document import failed");
    },
  });
  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => tasksApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.attachments(taskId),
      });
      invalidateTaskDetail();
    },
    onError: (error) => {
      setAttachmentError(error instanceof Error ? error.message : "Delete failed");
    },
  });
  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onMutate: async (id) => {
      beginLocalInboxArchive(companyId, id);
      await cancelInboxTaskQueries(queryClient, companyId);
      const previousData = snapshotInboxTaskCaches(queryClient, companyId);
      removeTaskFromInboxCaches(queryClient, companyId, id);
      return { companyId, previousData };
    },
    onSuccess: (_data, id) => {
      removeTaskFromInboxCaches(queryClient, companyId, id);
      invalidateTaskCollections();
      void navigateToTaskSource(true);
      toast.success("Task archived from inbox");
    },
    onError: (error, id, context) => {
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      if (context?.previousData) {
        restoreTaskToInboxCaches(queryClient, context.previousData, id);
      }
      toast.error("Archive failed", {
        description: error instanceof Error ? error.message : "Unable to archive this task from the inbox",
      });
    },
    onSettled: async (_data, error, id, context) => {
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxTaskQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getTaskPresenceInActiveInboxCaches(queryClient, context.companyId, id);
        if (presence !== "unknown") {
          confirmLocalInboxArchive(context.companyId, id);
        }
      }
    },
  });

  return {
    pendingApprovalAction,
    attachmentError,
    optimisticComments,
    locallyQueuedCommentRunIds,
    setLocallyQueuedCommentRunIds,
    approvalDecision,
    addComment,
    uploadAttachment,
    importMarkdownDocument,
    deleteAttachment,
    archiveFromInbox,
  };
}

interface TaskDetailTreeMutationOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  childTasks: Task[];
  treeControlMode: TaskTreeControlMode;
  treeControlReason: string;
  treeControlState?: Awaited<ReturnType<typeof tasksApi.getTreeControlState>>;
  setTreeControlOpen: Dispatch<SetStateAction<boolean>>;
  setTreeControlReason: Dispatch<SetStateAction<string>>;
  setTreeControlCancelConfirmed: Dispatch<SetStateAction<boolean>>;
}

/** Applies or releases a task-tree hold and refreshes every affected cache. */
export function useTaskDetailTreeMutation({
  companyId,
  taskId,
  task,
  childTasks,
  treeControlMode,
  treeControlReason,
  treeControlState,
  setTreeControlOpen,
  setTreeControlReason,
  setTreeControlCancelConfirmed,
}: TaskDetailTreeMutationOptions) {
  const queryClient = useQueryClient();
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const treeControlScope: "leaf" | "subtree" = childTasks.length === 0 ? "leaf" : "subtree";

  return useMutation({
    mutationFn: async () => {
      if (treeControlMode === "resume") {
        const pauseHoldId = treeControlState?.activePauseHold?.holdId;
        if (!pauseHoldId) {
          throw new Error("No active subtree pause hold is available to resume.");
        }
        const releasedHold = await tasksApi.releaseTreeHold(taskId, pauseHoldId, {
          reason: treeControlReason.trim() || null,
        });
        return { kind: "release" as const, hold: releasedHold };
      }
      const created = await tasksApi.createTreeHold(taskId, {
        mode: treeControlMode,
        reason: treeControlReason.trim() || null,
        releasePolicy: {
          strategy: "manual",
          ...(treeControlMode === "pause"
            ? {
                note: treeControlScope === "leaf" ? "leaf_pause" : "full_pause",
              }
            : {}),
        },
      });
      return {
        kind: "create" as const,
        hold: created.hold,
        preview: created.preview,
      };
    },
    onSuccess: async (result) => {
      const modeLabel = taskTreeControlLabel(result.hold.mode, treeControlScope);
      const cancelCount = result.preview?.totals.activeRuns ?? 0;
      toast.info(
        result.kind === "release"
          ? treeControlScope === "leaf"
            ? "Work resumed"
            : "Subtree resumed"
          : result.hold.mode === "pause"
            ? treeControlScope === "leaf"
              ? "Work paused"
              : "Subtree paused"
            : `${modeLabel} applied`,
        {
          description:
            result.kind === "release"
              ? result.hold.releaseReason?.trim() ||
                (treeControlScope === "leaf"
                  ? "Active task pause released."
                  : "Active subtree pause released.")
              : result.hold.mode === "pause"
                ? treeControlScope === "leaf"
                  ? `Work paused. ${cancelCount} run${cancelCount === 1 ? "" : "s"} cancelled.`
                  : `Subtree paused. ${cancelCount} run${cancelCount === 1 ? "" : "s"} cancelled.`
                : result.hold.reason?.trim() || "Subtree control applied.",
        },
      );
      setTreeControlOpen(false);
      setTreeControlReason("");
      setTreeControlCancelConfirmed(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.detail(taskId),
        }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskId] }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-control-state", taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-holds", taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", "tree-control-preview", taskId],
        }),
      ]);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.list(companyId),
        }),
        ...(task?.id
          ? [
              queryClient.invalidateQueries({
                queryKey: queryKeys.tasks.listByParent(companyId, task.id),
              }),
              queryClient.invalidateQueries({
                queryKey: queryKeys.tasks.listByDescendantRoot(companyId, task.id),
              }),
            ]
          : []),
      ]);
    },
    onError: (error) => {
      toast.error("Unable to apply subtree control", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    },
  });
}
