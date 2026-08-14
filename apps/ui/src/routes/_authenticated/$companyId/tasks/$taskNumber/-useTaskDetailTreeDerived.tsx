import { tasksApi } from "@/api/tasks";
import { Button } from "@/components/ui/button";
import { computePauseAffectsSummary } from "@/lib/owner-transition";
import { cn } from "@/lib/utils";
import type { Agent, Task, TaskTreeControlMode } from "@paperclipai/shared";
import { Paperclip } from "lucide-react";
import {
  useMemo,
  type ChangeEvent,
  type Dispatch,
  type DragEvent,
  type RefObject,
  type SetStateAction,
} from "react";

import { isMarkdownFile } from "./-task-detail-model";
import type {
  useTaskDetailActionMutations,
  useTaskDetailTreeMutation,
} from "./-useTaskDetailActionMutations";
import type { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";

export interface TaskDetailTreeDerivedOptions {
  task: Task | undefined;
  childTasks: Task[];
  agentMap: Map<string, Agent>;
  canManageTreeControl: boolean;
  treeControlMode: TaskTreeControlMode;
  treeControlPreview?: Awaited<ReturnType<typeof tasksApi.previewTreeControl>>;
  treeControlPreviewLoading: boolean;
  treeControlState?: Awaited<ReturnType<typeof tasksApi.getTreeControlState>>;
  activeRootPauseHolds: Awaited<ReturnType<typeof tasksApi.listTreeHolds>>;
  activeCancelHolds: Awaited<ReturnType<typeof tasksApi.listTreeHolds>>;
  treeControlCancelConfirmed: boolean;
  attachmentListLength: number;
  attachmentDragActive: boolean;
  setAttachmentDragActive: Dispatch<SetStateAction<boolean>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploadAttachment: ReturnType<typeof useTaskDetailActionMutations>["uploadAttachment"];
  importMarkdownDocument: ReturnType<typeof useTaskDetailActionMutations>["importMarkdownDocument"];
  commitHumanOwnerStatus: ReturnType<typeof useTaskDetailCoreMutations>["commitHumanOwnerStatus"];
  withdrawAndCancelTask: ReturnType<typeof useTaskDetailCoreMutations>["withdrawAndCancelTask"];
  executeTreeControl: ReturnType<typeof useTaskDetailTreeMutation>;
  isNamedUserCreator: boolean;
  isSystemEscalationHumanOwner: boolean;
  isUserCreatorWithdrawalOwner: boolean;
}

/** Computes task-tree presentation and attachment/lifecycle controls. */
export function useTaskDetailTreeDerived({
  task,
  childTasks,
  agentMap,
  canManageTreeControl,
  treeControlMode,
  treeControlPreview,
  treeControlPreviewLoading,
  treeControlState,
  activeRootPauseHolds,
  activeCancelHolds,
  treeControlCancelConfirmed,
  attachmentListLength,
  attachmentDragActive,
  setAttachmentDragActive,
  fileInputRef,
  uploadAttachment,
  importMarkdownDocument,
  commitHumanOwnerStatus,
  withdrawAndCancelTask,
  executeTreeControl,
  isNamedUserCreator,
  isSystemEscalationHumanOwner,
  isUserCreatorWithdrawalOwner,
}: TaskDetailTreeDerivedOptions) {
  const treePreviewAffectedTasks = useMemo(
    () => (treeControlPreview?.tasks ?? []).filter((candidate) => !candidate.skipped),
    [treeControlPreview],
  );
  const pauseAffectsSummary = useMemo(
    () => computePauseAffectsSummary(treeControlPreview?.tasks ?? []),
    [treeControlPreview],
  );
  const treePreviewDisplayTasks = useMemo(() => {
    const previewTasks = treeControlPreview?.tasks ?? [];
    if (treeControlMode !== "pause") {
      return previewTasks.filter((candidate) => !candidate.skipped);
    }
    return previewTasks.filter(
      (candidate) => !candidate.skipped || candidate.skipReason === "terminal_status",
    );
  }, [treeControlMode, treeControlPreview]);
  const activePauseHold = treeControlState?.activePauseHold ?? null;
  const activeRootPauseHoldsForDisplay = useMemo(
    () => (activePauseHold?.isRoot === true ? activeRootPauseHolds : []),
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (!member.skipped) ids.add(member.taskId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of childTasks) {
      if (heldTaskIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childTasks, heldTaskIds]);
  const childPauseBadgeById = useMemo(() => {
    const badges = new Map<string, string>();
    for (const child of childTasks) {
      if (heldTaskIds.has(child.id)) badges.set(child.id, "Paused");
    }
    return badges;
  }, [childTasks, heldTaskIds]);
  const activePauseHoldRoot = useMemo(() => {
    if (!activePauseHold) return null;
    if (activePauseHold.rootTaskId === task?.id) return task ?? null;
    return task?.ancestors?.find((ancestor) => ancestor.id === activePauseHold.rootTaskId) ?? null;
  }, [activePauseHold, task]);
  const activeRootPauseHold = useMemo(
    () => activeRootPauseHoldsForDisplay.find((hold) => hold.id === activePauseHold?.holdId) ?? null,
    [activePauseHold?.holdId, activeRootPauseHoldsForDisplay],
  );

  const handleFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const handleAttachmentDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setAttachmentDragActive(false);
    const files = event.dataTransfer.files;
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const treePreviewWarnings = treeControlPreview?.warnings ?? [];
  const heldDescendantCount =
    activeRootPauseHold?.members?.filter((member) => member.depth > 0 && !member.skipped).length ??
    Math.max(heldTaskIds.size - 1, 0);
  const canShowSubtreeControls = canManageTreeControl && childTasks.length > 0;
  const canResumeSubtree = canShowSubtreeControls && activePauseHold?.isRoot === true;
  const canRestoreSubtree = canShowSubtreeControls && activeCancelHolds.length > 0;
  const isTerminalTask = task?.lifecycleStatus === "done" || task?.lifecycleStatus === "cancelled";
  const canPauseLeafWork =
    canManageTreeControl && childTasks.length === 0 && !activePauseHold && !isTerminalTask;
  const canResumeLeafWork =
    canManageTreeControl && childTasks.length === 0 && activePauseHold?.isRoot === true;
  const treeControlScope: "leaf" | "subtree" = childTasks.length === 0 ? "leaf" : "subtree";
  const previewAffectedTaskCount = treePreviewAffectedTasks.length;
  const treeControlPrimaryButtonLabel =
    treeControlMode === "pause"
      ? treeControlScope === "leaf"
        ? "Pause work"
        : "Pause and stop work"
      : treeControlMode === "cancel"
        ? `Cancel ${previewAffectedTaskCount} tasks`
        : treeControlMode === "restore"
          ? `Restore ${previewAffectedTaskCount} tasks`
          : treeControlScope === "leaf"
            ? "Resume work"
            : "Resume subtree";
  const pausedComposerHint = activePauseHold
    ? task?.ownerAgentId
      ? `Use @ to mention ${agentMap.get(task.ownerAgentId)?.name ?? "the owner"} if you want to queue triage while the subtree remains paused. Ordinary comments do not dispatch.`
      : "Choose an agent owner or use @ to mention an eligible agent. Ordinary comments do not dispatch."
    : null;
  const humanLifecycleMode =
    !task || isTerminalTask
      ? null
      : isSystemEscalationHumanOwner
        ? ("system" as const)
        : isNamedUserCreator && (task.ownerKind === "agent" || isUserCreatorWithdrawalOwner)
          ? isUserCreatorWithdrawalOwner
            ? ("withdrawal" as const)
            : ("creator" as const)
          : null;
  const humanLifecyclePending =
    humanLifecycleMode === "system" ? commitHumanOwnerStatus.isPending : withdrawAndCancelTask.isPending;
  const humanLifecycleFormControls =
    task && humanLifecycleMode ? (
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {humanLifecycleMode === "system"
            ? "Human escalation owner controls"
            : humanLifecycleMode === "withdrawal"
              ? "Creator withdrawal is awaiting cancellation"
              : "Named creator withdrawal control"}
        </span>
        {humanLifecycleMode === "system" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={humanLifecyclePending}
              onClick={() =>
                commitHumanOwnerStatus.mutate(
                  task.lifecycleStatus === "blocked"
                    ? {
                        status: "open",
                        message: "Reopened by the human escalation owner.",
                      }
                    : {
                        status: "blocked",
                        message: "Blocked by the human escalation owner.",
                      },
                )
              }
            >
              {task.lifecycleStatus === "blocked" ? "Reopen" : "Block"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={humanLifecyclePending}
              onClick={() =>
                commitHumanOwnerStatus.mutate({
                  status: "done",
                  message: "Resolved by the human escalation owner.",
                })
              }
            >
              Resolve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={humanLifecyclePending}
              onClick={() =>
                commitHumanOwnerStatus.mutate({
                  status: "cancelled",
                  message: "Cancelled by the human escalation owner.",
                })
              }
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            disabled={humanLifecyclePending}
            onClick={() => withdrawAndCancelTask.mutate()}
          >
            {humanLifecycleMode === "withdrawal" ? "Finish cancellation" : "Withdraw and cancel"}
          </Button>
        )}
      </div>
    ) : null;
  const canApplyTreeControl =
    Boolean(treeControlPreview) &&
    !treeControlPreviewLoading &&
    (treeControlMode !== "cancel" || treeControlCancelConfirmed);
  const attachmentUploadPending = uploadAttachment.isPending || importMarkdownDocument.isPending;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Upload task attachments"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      {attachmentUploadPending ? (
        <span className="sr-only" role="status">
          Uploading attachment.
        </span>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={attachmentUploadPending}
        className={cn(attachmentDragActive && "border-primary bg-primary/5")}
      >
        <Paperclip className="size-4" />
        {attachmentUploadPending ? "Uploading..." : "Upload attachment"}
      </Button>
    </>
  );

  return {
    pauseAffectsSummary,
    treePreviewDisplayTasks,
    activePauseHold,
    mutedChildTaskIds,
    childPauseBadgeById,
    activePauseHoldRoot,
    activeRootPauseHold,
    ancestors: task?.ancestors ?? [],
    handleAttachmentDrop,
    hasAttachments: attachmentListLength > 0,
    treePreviewWarnings,
    heldDescendantCount,
    canShowSubtreeControls,
    canResumeSubtree,
    canRestoreSubtree,
    canPauseLeafWork,
    canResumeLeafWork,
    treeControlScope,
    previewAffectedTaskCount,
    treeControlPrimaryButtonLabel,
    composerHint: pausedComposerHint,
    humanLifecycleFormControls,
    canApplyTreeControl,
    attachmentUploadButton,
    executeTreeControl,
  };
}
