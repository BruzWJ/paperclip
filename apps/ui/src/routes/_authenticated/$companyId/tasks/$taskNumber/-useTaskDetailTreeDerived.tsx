import { tasksApi } from "@/api/tasks";
import { computePauseAffectsSummary } from "@/lib/owner-transition";
import type { Agent, Task, TaskTreeControlMode } from "@paperclipai/shared";
import { useCallback, useMemo } from "react";

import { isMarkdownFile } from "./-task-detail-model";
import type { useTaskDetailActionMutations } from "./-useTaskDetailActionMutations";

const EMPTY_TASK_TREE_HOLDS: Awaited<ReturnType<typeof tasksApi.listTreeHolds>> = [];
const EMPTY_TASK_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_CHILD_PAUSE_BADGES: ReadonlyMap<string, string> = new Map();

interface TaskDetailTreeDerivedOptions {
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
  uploadAttachment: ReturnType<typeof useTaskDetailActionMutations>["uploadAttachment"];
  importMarkdownDocument: ReturnType<typeof useTaskDetailActionMutations>["importMarkdownDocument"];
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
  uploadAttachment,
  importMarkdownDocument,
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
    () =>
      activePauseHold?.isRoot === true && activeRootPauseHolds.length > 0
        ? activeRootPauseHolds
        : EMPTY_TASK_TREE_HOLDS,
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldTaskIds = useMemo(() => {
    if (activeRootPauseHoldsForDisplay.length === 0) return EMPTY_TASK_ID_SET;
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (!member.skipped) ids.add(member.taskId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildTaskIds = useMemo(() => {
    if (heldTaskIds.size === 0 || childTasks.length === 0) return EMPTY_TASK_ID_SET;
    const ids = new Set<string>();
    for (const child of childTasks) {
      if (heldTaskIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childTasks, heldTaskIds]);
  const childPauseBadgeById = useMemo(() => {
    if (heldTaskIds.size === 0 || childTasks.length === 0) return EMPTY_CHILD_PAUSE_BADGES;
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

  const handleAttachmentFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        if (isMarkdownFile(file)) {
          await importMarkdownDocument.mutateAsync(file);
        } else {
          await uploadAttachment.mutateAsync(file);
        }
      }
    },
    [importMarkdownDocument.mutateAsync, uploadAttachment.mutateAsync],
  );

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
      : "Assign an agent owner before mentioning one. Ordinary comments do not dispatch."
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
  const canApplyTreeControl =
    Boolean(treeControlPreview) &&
    !treeControlPreviewLoading &&
    (treeControlMode !== "cancel" || treeControlCancelConfirmed);
  const attachmentUploadPending = uploadAttachment.isPending || importMarkdownDocument.isPending;
  return {
    pauseAffectsSummary,
    treePreviewDisplayTasks,
    activePauseHold,
    mutedChildTaskIds,
    childPauseBadgeById,
    activePauseHoldRoot,
    activeRootPauseHold,
    ancestors: task?.ancestors ?? [],
    handleAttachmentFiles,
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
    humanLifecycleMode,
    canApplyTreeControl,
    attachmentUploadPending,
  };
}
