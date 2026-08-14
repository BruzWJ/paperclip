import { taskTreeHoldMembers, taskTreeHolds, tasks } from "@paperclipai/db";
import {
  TASK_STATUSES,
  type TaskStatus,
  type TaskTreeControlMode,
  type TaskTreeHold,
  type TaskTreeHoldMember,
  type TaskTreeHoldReleasePolicy,
  type TaskTreePreviewAgent,
  type TaskTreePreviewRun,
  type TaskTreePreviewTask,
  type TaskTreePreviewWarning,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
} from "./task-execution-cancellation.js";

export type TaskRow = typeof tasks.$inferSelect;
export type HoldRow = typeof taskTreeHolds.$inferSelect;
export type HoldMemberRow = typeof taskTreeHoldMembers.$inferSelect;
export type HoldMemberSummaryRow = HoldMemberRow & { taskNumber: number };
export type ActiveTaskTreePauseHoldGate = {
  holdId: string;
  rootTaskId: string;
  taskId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: TaskTreeHoldReleasePolicy | null;
};
export type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
export type TreeTask = TaskRow & { depth: number };
export type ActiveRunRow = {
  id: string;
  taskId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
export type ActiveCancelSnapshot = {
  holdIds: string[];
  member: TaskTreeHoldMember | null;
};
export type TreeStatusUpdateResult = {
  updatedTaskIds: string[];
  updatedTasks: Array<{
    id: string;
    boardPresentationStatus: TaskStatus;
    ownerAgentId: string | null;
  }>;
};
export type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: TaskTreeHold | null;
};
export type TaskTreeCancellationPort = Pick<
  TaskExecutionCancellationService,
  | "requestRunningTaskInterruptionsInTransaction"
  | "reconcileRequestedCancellations"
  | "requestScopeCancellationsInTransaction"
>;

export const DEFAULT_RELEASE_POLICY: TaskTreeHoldReleasePolicy = {
  strategy: "manual",
};
export const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
export function normalizeReleasePolicy(
  releasePolicy: TaskTreeHoldReleasePolicy | null | undefined,
): TaskTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
}

export function coerceTaskStatus(status: string): TaskStatus {
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : "backlog";
}

export function toPreviewRun(row: ActiveRunRow): TaskTreePreviewRun {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

export function toHold(row: HoldRow, members?: HoldMemberSummaryRow[]): TaskTreeHold {
  return {
    id: row.id,
    companyId: row.companyId,
    rootTaskId: row.rootTaskId,
    mode: row.mode as TaskTreeControlMode,
    status: row.status as TaskTreeHold["status"],
    reason: row.reason,
    releasePolicy: (row.releasePolicy as TaskTreeHoldReleasePolicy | null) ?? null,
    createdByActorType: row.createdByActorType as TaskTreeHold["createdByActorType"],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    releasedAt: row.releasedAt,
    releasedByActorType: row.releasedByActorType as TaskTreeHold["releasedByActorType"],
    releasedByAgentId: row.releasedByAgentId,
    releasedByUserId: row.releasedByUserId,
    releasedByRunId: row.releasedByRunId,
    releaseReason: row.releaseReason,
    releaseMetadata: row.releaseMetadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(members ? { members: members.map(toHoldMember) } : {}),
  };
}

export function toHoldMember(row: HoldMemberSummaryRow): TaskTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    taskId: row.taskId,
    parentTaskId: row.parentTaskId,
    depth: row.depth,
    taskNumber: row.taskNumber,
    taskIdentifier: row.taskIdentifier,
    taskTitle: row.taskTitle,
    taskStatus: coerceTaskStatus(row.taskStatus),
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    activeRunId: row.activeRunId,
    activeRunStatus: row.activeRunStatus,
    skipped: row.skipped,
    skipReason: row.skipReason,
    createdAt: row.createdAt,
  };
}

export function taskSkipReason(input: {
  mode: TaskTreeControlMode;
  task: TreeTask;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const lifecycleStatus = input.task.lifecycleStatus;
  if (input.mode === "restore") {
    if (input.activeCancelSnapshot?.member && lifecycleStatus !== "cancelled") {
      return "changed_after_cancel";
    }
    if (lifecycleStatus !== "cancelled") return "not_cancelled";
    if (!input.activeCancelSnapshot?.member) return "not_cancelled_by_tree_control";
    return null;
  }
  if (lifecycleStatus === "done" || lifecycleStatus === "cancelled") {
    return "terminal_status";
  }
  if (input.mode === "pause" && input.activePauseHoldIds.length > 0) {
    return "already_held";
  }
  if (input.mode === "resume" && input.activePauseHoldIds.length === 0) {
    return "not_held";
  }
  return null;
}

export function buildAffectedAgents(tasksToPreview: TaskTreePreviewTask[]): TaskTreePreviewAgent[] {
  const byAgentId = new Map<string, TaskTreePreviewAgent>();
  for (const task of tasksToPreview) {
    if (task.skipped) continue;
    const agentIds = new Set<string>();
    if (task.ownerAgentId) agentIds.add(task.ownerAgentId);
    if (task.activeRun) agentIds.add(task.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? {
        agentId,
        taskCount: 0,
        activeRunCount: 0,
      };
      current.taskCount += 1;
      if (task.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function buildWarnings(input: {
  mode: TaskTreeControlMode;
  tasksToPreview: TaskTreePreviewTask[];
  activeRuns: TaskTreePreviewRun[];
}): TaskTreePreviewWarning[] {
  const affectedTasks = input.tasksToPreview.filter((task) => !task.skipped);
  const affectedTaskIds = new Set(affectedTasks.map((task) => task.id));
  const affectedRuns = input.activeRuns.filter((run) => affectedTaskIds.has(run.taskId));
  const warnings: TaskTreePreviewWarning[] = [];

  if (affectedTasks.length === 0) {
    warnings.push({
      code: "no_affected_tasks",
      message: "No tasks in this subtree match the requested control action.",
    });
  }

  const runningRunTaskIds = affectedRuns.filter((run) => run.status === "running").map((run) => run.taskId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunTaskIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected tasks have running task-execution runs.",
      taskIds: [...new Set(runningRunTaskIds)].sort(),
    });
  }

  const queuedRunTaskIds = affectedRuns.filter((run) => run.status === "queued").map((run) => run.taskId);
  if ((input.mode === "pause" || input.mode === "cancel") && queuedRunTaskIds.length > 0) {
    warnings.push({
      code: "queued_runs_present",
      message: "Some affected tasks have queued task-execution runs.",
      taskIds: [...new Set(queuedRunTaskIds)].sort(),
    });
  }

  if (input.mode === "resume" && affectedTasks.length === 0) {
    warnings.push({
      code: "no_active_pause_holds",
      message: "No active pause holds were found in this subtree.",
    });
  }

  if (input.mode === "restore") {
    const changedTaskIds = input.tasksToPreview
      .filter((task) => task.skipReason === "changed_after_cancel")
      .map((task) => task.id);
    if (changedTaskIds.length > 0) {
      warnings.push({
        code: "restore_conflicts_present",
        message: "Some tasks changed after subtree cancellation and will be skipped.",
        taskIds: changedTaskIds,
      });
    }
  }

  return warnings;
}

export function restoreStatusFromCancelSnapshot(status: TaskStatus): TaskStatus | null {
  if (status === "in_progress") return "todo";
  return status;
}

export function namedBoardActorUserId(actor: ActorInput): string | null {
  if (actor.actorType !== "user") return null;
  if (!actor.userId || actor.actorId !== actor.userId) {
    throw unprocessable("A named-user task-tree command requires one exact authenticated user identity");
  }
  return actor.userId;
}

export function cancellationActorForHold(hold: {
  createdByActorType: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
}): TaskExecutionCancellationActor {
  if (hold.createdByActorType === "user" && hold.createdByUserId) {
    return { kind: "user", userId: hold.createdByUserId };
  }
  if (hold.createdByActorType === "agent" && hold.createdByAgentId) {
    return { kind: "agent", agentId: hold.createdByAgentId };
  }
  return { kind: "system" };
}

export { deterministicUuid as deterministicTreeCommandId } from "./deterministic-uuid.js";
