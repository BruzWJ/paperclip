import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  taskTreeHoldMembers,
  taskTreeHolds,
  tasks,
} from "@paperclipai/db";
import {
  TASK_STATUSES,
  type TaskStatus,
  type TaskTreeControlMode,
  type TaskTreeControlPreview,
  type TaskTreeHold,
  type TaskTreeHoldMember,
  type TaskTreeHoldReleasePolicy,
  type TaskTreePreviewAgent,
  type TaskTreePreviewTask,
  type TaskTreePreviewRun,
  type TaskTreePreviewWarning,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  recordNamedBoardLifecycleCommandInTransaction,
  type NamedBoardLifecycleAffectedTask,
} from "./task-board-lifecycle-command.js";
import { resolveCurrentTaskOwnerRunLinkages } from "./productive-run-linkage.js";
import type {
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
  RequestedRunningTaskInterruptions,
  RequestedScopedRunCancellations,
} from "./task-execution-cancellation.js";
import { lockTaskTreeExecutionGate } from "./task-execution-lifecycle-gate.js";

type TaskRow = typeof tasks.$inferSelect;
type HoldRow = typeof taskTreeHolds.$inferSelect;
type HoldMemberRow = typeof taskTreeHoldMembers.$inferSelect;
export type ActiveTaskTreePauseHoldGate = {
  holdId: string;
  rootTaskId: string;
  taskId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: TaskTreeHoldReleasePolicy | null;
};
type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type TreeTask = TaskRow & { depth: number };
type ActiveRunRow = {
  id: string;
  taskId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
type ActiveCancelSnapshot = {
  holdIds: string[];
  member: TaskTreeHoldMember | null;
};
type TreeStatusUpdateResult = {
  updatedTaskIds: string[];
  updatedTasks: Array<{
    id: string;
    boardPresentationStatus: TaskStatus;
    ownerAgentId: string | null;
  }>;
};
type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: TaskTreeHold | null;
};
export type TaskTreeCancellationPort = Pick<
  TaskExecutionCancellationService,
  | "requestRunningTaskInterruptionsInTransaction"
  | "reconcileRequestedCancellations"
  | "requestScopeCancellationsInTransaction"
>;

const DEFAULT_RELEASE_POLICY: TaskTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
function normalizeReleasePolicy(
  releasePolicy: TaskTreeHoldReleasePolicy | null | undefined,
): TaskTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
}

function coerceTaskStatus(status: string): TaskStatus {
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : "backlog";
}

function toPreviewRun(row: ActiveRunRow): TaskTreePreviewRun {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

function toHold(row: HoldRow, members?: HoldMemberRow[]): TaskTreeHold {
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

function toHoldMember(row: HoldMemberRow): TaskTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    taskId: row.taskId,
    parentTaskId: row.parentTaskId,
    depth: row.depth,
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

function taskSkipReason(input: {
  mode: TaskTreeControlMode;
  task: TreeTask;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const lifecycleStatus = input.task.lifecycleStatus;
  if (input.mode === "restore") {
    if (
      input.activeCancelSnapshot?.member &&
      lifecycleStatus !== "cancelled"
    ) {
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

function buildAffectedAgents(tasksToPreview: TaskTreePreviewTask[]): TaskTreePreviewAgent[] {
  const byAgentId = new Map<string, TaskTreePreviewAgent>();
  for (const task of tasksToPreview) {
    if (task.skipped) continue;
    const agentIds = new Set<string>();
    if (task.ownerAgentId) agentIds.add(task.ownerAgentId);
    if (task.activeRun) agentIds.add(task.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? { agentId, taskCount: 0, activeRunCount: 0 };
      current.taskCount += 1;
      if (task.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildWarnings(input: {
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

  const runningRunTaskIds = affectedRuns
    .filter((run) => run.status === "running")
    .map((run) => run.taskId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunTaskIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected tasks have running task-execution runs.",
      taskIds: [...new Set(runningRunTaskIds)].sort(),
    });
  }

  const queuedRunTaskIds = affectedRuns
    .filter((run) => run.status === "queued")
    .map((run) => run.taskId);
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

function restoreStatusFromCancelSnapshot(status: TaskStatus): TaskStatus | null {
  if (status === "in_progress") return "todo";
  return status;
}

function namedBoardActorUserId(actor: ActorInput): string | null {
  if (actor.actorType !== "user") return null;
  if (!actor.userId || actor.actorId !== actor.userId) {
    throw unprocessable(
      "A named-user task-tree command requires one exact authenticated user identity",
    );
  }
  return actor.userId;
}

function cancellationActorForHold(hold: {
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

function deterministicTreeCommandId(namespace: string, sourceId: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${sourceId}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function taskTreeControlService(
  db: Db,
  options: { taskExecutionCancellation?: TaskTreeCancellationPort } = {},
) {
  async function listTreeTasks(companyId: string, rootTaskId: string): Promise<TreeTask[]> {
    const root = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, rootTaskId), eq(tasks.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root task not found");
    }

    const result: TreeTask[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const children = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.parentId, parentIds)))
        .orderBy(asc(tasks.createdAt), asc(tasks.id));

      const nextFrontier: typeof frontier = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        const depth = (depthByParentId.get(child.parentId ?? "") ?? 0) + 1;
        visited.add(child.id);
        result.push({ ...child, depth });
        nextFrontier.push({ id: child.id, depth });
      }
      frontier = nextFrontier;
    }

    return result;
  }

  async function activeRunsForTree(companyId: string, treeTasks: TreeTask[]) {
    const taskIds = treeTasks.map((task) => task.id);
    if (taskIds.length === 0) return [];
    const linkages = await resolveCurrentTaskOwnerRunLinkages(db, {
      companyId,
      taskIds,
    });
    return [...linkages.values()]
      .map((linkage) => ({
        id: linkage.runId,
        taskId: linkage.taskId,
        agentId: linkage.agentId,
        status: "running" as const,
        startedAt: linkage.startedAt,
        createdAt: linkage.createdAt,
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function activeHoldsByTaskId(companyId: string, taskIds: string[]) {
    const byTaskId = new Map<string, { all: string[]; pause: string[] }>();
    if (taskIds.length === 0) return byTaskId;
    const rows = await db
      .select({
        taskId: taskTreeHoldMembers.taskId,
        holdId: taskTreeHolds.id,
        mode: taskTreeHolds.mode,
      })
      .from(taskTreeHoldMembers)
      .innerJoin(taskTreeHolds, eq(taskTreeHoldMembers.holdId, taskTreeHolds.id))
      .where(
        and(
          eq(taskTreeHoldMembers.companyId, companyId),
          eq(taskTreeHolds.status, "active"),
          inArray(taskTreeHoldMembers.taskId, taskIds),
        ),
      )
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));

    for (const row of rows) {
      const current = byTaskId.get(row.taskId) ?? { all: [], pause: [] };
      current.all.push(row.holdId);
      if (row.mode === "pause") current.pause.push(row.holdId);
      byTaskId.set(row.taskId, current);
    }
    return byTaskId;
  }

  async function activeCancelSnapshotsByTaskId(companyId: string, rootTaskId: string) {
    const activeCancelHolds = await listHolds(companyId, rootTaskId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byTaskId = new Map<string, ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byTaskId.get(member.taskId) ?? { holdIds: [], member: null };
        if (!current.holdIds.includes(hold.id)) current.holdIds.push(hold.id);
        if (!current.member && !member.skipped) current.member = member;
        byTaskId.set(member.taskId, current);
      }
    }
    return byTaskId;
  }

  async function getActivePauseHoldGate(
    companyId: string,
    taskId: string,
  ): Promise<ActiveTaskTreePauseHoldGate | null> {
    const activePauseHolds = await db
      .select({
        id: taskTreeHolds.id,
        rootTaskId: taskTreeHolds.rootTaskId,
        reason: taskTreeHolds.reason,
        releasePolicy: taskTreeHolds.releasePolicy,
      })
      .from(taskTreeHolds)
      .where(
        and(
          eq(taskTreeHolds.companyId, companyId),
          eq(taskTreeHolds.status, "active"),
          eq(taskTreeHolds.mode, "pause"),
        ),
      )
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));
    if (activePauseHolds.length === 0) return null;

    const holdByRootTaskId = new Map(activePauseHolds.map((hold) => [hold.rootTaskId, hold]));
    let currentTaskId: string | null = taskId;
    const visited = new Set<string>();

    while (
      currentTaskId
      && !visited.has(currentTaskId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH
    ) {
      visited.add(currentTaskId);
      const hold = holdByRootTaskId.get(currentTaskId);
      if (hold) {
        return {
          holdId: hold.id,
          rootTaskId: hold.rootTaskId,
          taskId,
          isRoot: hold.rootTaskId === taskId,
          mode: "pause",
          reason: hold.reason,
          releasePolicy: (hold.releasePolicy as TaskTreeHoldReleasePolicy | null) ?? null,
        };
      }

      const parent: { parentId: string | null } | null = await db
        .select({ parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.id, currentTaskId), eq(tasks.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentTaskId = parent?.parentId ?? null;
    }

    return null;
  }

  async function preview(
    companyId: string,
    rootTaskId: string,
    input: {
      mode: TaskTreeControlMode;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
    },
  ): Promise<TaskTreeControlPreview> {
    const treeTasks = await listTreeTasks(companyId, rootTaskId);
    const taskIds = treeTasks.map((task) => task.id);
    const [activeRunRows, holdsByTaskId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeTasks),
      activeHoldsByTaskId(companyId, taskIds),
      input.mode === "restore"
        ? activeCancelSnapshotsByTaskId(companyId, rootTaskId)
        : Promise.resolve(new Map<string, ActiveCancelSnapshot>()),
    ]);
    const runsByTaskId = new Map<string, ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByTaskId.has(run.taskId)) runsByTaskId.set(run.taskId, run);
    }
    const countsByStatus: Partial<Record<TaskStatus, number>> = {};

    const tasksToPreview = treeTasks.map((task) => {
      const boardPresentationStatus = coerceTaskStatus(task.boardPresentationStatus);
      countsByStatus[boardPresentationStatus] =
        (countsByStatus[boardPresentationStatus] ?? 0) + 1;
      const holdState = holdsByTaskId.get(task.id) ?? { all: [], pause: [] };
      const skipReason = taskSkipReason({
        mode: input.mode,
        task,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(task.id) ?? null,
      });
      const run = runsByTaskId.get(task.id);
      return {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        boardPresentationStatus,
        parentId: task.parentId,
        depth: task.depth,
        ownerAgentId: task.ownerAgentId,
        ownerUserId: task.ownerUserId,
        activeRun: run ? toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies TaskTreePreviewTask;
    });
    const skippedTasks = tasksToPreview.filter((task) => task.skipped);
    const activeRuns = activeRunRows
      .map(toPreviewRun)
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.id.localeCompare(b.id));
    const affectedAgents = buildAffectedAgents(tasksToPreview);

    return {
      companyId,
      rootTaskId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: normalizeReleasePolicy(input.releasePolicy),
      totals: {
        totalTasks: tasksToPreview.length,
        affectedTasks: tasksToPreview.length - skippedTasks.length,
        skippedTasks: skippedTasks.length,
        activeRuns: activeRuns.filter((run) => run.status === "running").length,
        queuedRuns: activeRuns.filter((run) => run.status === "queued").length,
        affectedAgents: affectedAgents.length,
      },
      countsByStatus,
      tasks: tasksToPreview,
      skippedTasks,
      activeRuns,
      affectedAgents,
      warnings: buildWarnings({ mode: input.mode, tasksToPreview, activeRuns }),
    };
  }

  async function createHold(
    companyId: string,
    rootTaskId: string,
    input: {
      mode: TaskTreeControlMode;
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      actor: ActorInput;
    },
  ): Promise<{
    hold: TaskTreeHold;
    preview: TaskTreeControlPreview;
    resumedPauseHoldIds?: string[];
    cancelledTaskIds: string[];
  }> {
    const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
    const holdPreview = input.mode === "pause" || input.mode === "cancel"
      ? null
      : await preview(companyId, rootTaskId, {
        mode: input.mode,
        releasePolicy: holdReleasePolicy,
      });

    async function insertHoldWithMembers(
      tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
      previewSnapshot: TaskTreeControlPreview,
    ) {
      const [createdHold] = await tx
        .insert(taskTreeHolds)
        .values({
          companyId,
          rootTaskId,
          mode: input.mode,
          status: "active",
          reason: input.reason ?? null,
          releasePolicy: holdReleasePolicy as unknown as Record<string, unknown>,
          createdByActorType: input.actor.actorType,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          createdByRunId: input.actor.runId ?? null,
        })
        .returning();

      const memberRows = previewSnapshot.tasks.map((task) => ({
        companyId,
        holdId: createdHold.id,
        taskId: task.id,
        parentTaskId: task.parentId,
        depth: task.depth,
        taskIdentifier: task.identifier,
        taskTitle: task.title,
        taskStatus: task.boardPresentationStatus,
        ownerAgentId: task.ownerAgentId,
        ownerUserId: task.ownerUserId,
        activeRunId: task.activeRun?.id ?? null,
        activeRunStatus: task.activeRun?.status ?? null,
        skipped: task.skipped,
        skipReason: task.skipReason,
      }));

      const createdMembers = memberRows.length > 0
        ? await tx
          .insert(taskTreeHoldMembers)
          .values(memberRows)
          .returning()
        : [];

      return { createdHold, createdMembers };
    }

    if (input.mode === "resume") {
      const resumePreview = holdPreview!;
      const taskIds = [...new Set(resumePreview.tasks.map((task) => task.id))];
      const releaseReason = input.reason ?? "Subtree resume applied.";
      const actorUserId = namedBoardActorUserId(input.actor);

      return db.transaction(async (tx) => {
        const activePauseHolds = taskIds.length === 0
          ? []
          : await tx
            .select()
            .from(taskTreeHolds)
            .where(
              and(
                eq(taskTreeHolds.companyId, companyId),
                eq(taskTreeHolds.status, "active"),
                eq(taskTreeHolds.mode, "pause"),
                inArray(taskTreeHolds.rootTaskId, taskIds),
              ),
            )
            .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id))
            .for("update");
        const { createdHold, createdMembers } = await insertHoldWithMembers(tx, resumePreview);
        const resumedPauseHoldIds = activePauseHolds.map((hold) => hold.id);
        const now = new Date();
        let affectedTaskIds: string[] = [];
        if (resumedPauseHoldIds.length > 0) {
          affectedTaskIds = await tx
            .select({ taskId: taskTreeHoldMembers.taskId })
            .from(taskTreeHoldMembers)
            .where(
              and(
                eq(taskTreeHoldMembers.companyId, companyId),
                inArray(taskTreeHoldMembers.holdId, resumedPauseHoldIds),
                eq(taskTreeHoldMembers.skipped, false),
              ),
            )
            .then((rows) => [...new Set(rows.map((row) => row.taskId))]);
          await tx
            .update(taskTreeHolds)
            .set({
              status: "released",
              releasedAt: now,
              releasedByActorType: input.actor.actorType,
              releasedByAgentId: input.actor.agentId ?? null,
              releasedByUserId: input.actor.userId ?? null,
              releasedByRunId: input.actor.runId ?? null,
              releaseReason,
              releaseMetadata: sql`jsonb_build_object(
                'resumedByResumeHoldId', ${createdHold.id},
                'resumeHoldMode', 'tree_resume',
                'resumedPauseHoldId', ${taskTreeHolds.id}
              )`,
              updatedAt: now,
            })
            .where(
              and(
                eq(taskTreeHolds.companyId, companyId),
                eq(taskTreeHolds.status, "active"),
                inArray(taskTreeHolds.id, resumedPauseHoldIds),
              ),
            );
        }

        const [releasedResumeHold] = await tx
          .update(taskTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? null,
            releasedByRunId: input.actor.runId ?? null,
            releaseReason,
            releaseMetadata: {
              resumedPauseHoldIds,
              resumeMode: "subtree",
              ...(input.releasePolicy
                ? { releasePolicy: holdReleasePolicy }
                : {}),
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(taskTreeHolds.companyId, companyId),
              eq(taskTreeHolds.id, createdHold.id),
              eq(taskTreeHolds.status, "active"),
            ),
          )
          .returning();
        if (!releasedResumeHold) {
          throw conflict("Subtree resume command was not committed");
        }

        if (actorUserId && affectedTaskIds.length > 0) {
          const affectedTasks = await tx
            .select({
              id: tasks.id,
              ownershipEpoch: tasks.ownershipEpoch,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                inArray(tasks.id, affectedTaskIds),
              ),
            )
            .orderBy(asc(tasks.id))
            .for("update");
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedTasks,
            actorUserId,
            subtype: "tree_control_resume",
            sourceCommandId: createdHold.id,
            idempotencyKey: `task-tree-resume:${createdHold.id}`,
            committedAt: now,
          });
        }

        return {
          hold: toHold(releasedResumeHold, createdMembers),
          preview: resumePreview,
          resumedPauseHoldIds,
          cancelledTaskIds: [],
        };
      });
    }

    const applied = await db.transaction(async (tx) => {
      if (input.mode === "pause" || input.mode === "cancel") {
        await lockTaskTreeExecutionGate(tx, companyId, rootTaskId);
      }
      const committedPreview = holdPreview
        ?? await taskTreeControlService(tx as unknown as Db).preview(
          companyId,
          rootTaskId,
          {
            mode: input.mode,
            releasePolicy: holdReleasePolicy,
          },
        );
      const { createdHold, createdMembers } = await insertHoldWithMembers(
        tx,
        committedPreview,
      );
      const affectedTaskIds = createdMembers
        .filter((member) => !member.skipped)
        .map((member) => member.taskId);
      const actorUserId = namedBoardActorUserId(input.actor);
      const now = createdHold.createdAt;

      if (input.mode === "pause") {
        if (!options.taskExecutionCancellation) {
          throw new Error(
            "Task-tree pause requires the execution cancellation boundary",
          );
        }
        const affectedTasks = affectedTaskIds.length === 0
          ? []
          : await tx
            .select({
              id: tasks.id,
              ownershipEpoch: tasks.ownershipEpoch,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                inArray(tasks.id, affectedTaskIds),
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .orderBy(asc(tasks.id))
            .for("update");
        const pauseInterruptions: RequestedRunningTaskInterruptions[] = [];
        for (const task of affectedTasks) {
          pauseInterruptions.push(
            await options.taskExecutionCancellation
              .requestRunningTaskInterruptionsInTransaction(tx, {
                companyId,
                taskId: task.id,
                ownershipEpoch: task.ownershipEpoch,
                reason: "active_subtree_pause_hold",
                actor: cancellationActorForHold(createdHold),
                now,
              }),
          );
        }
        if (actorUserId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedTasks,
            actorUserId,
            subtype: "tree_control_pause",
            sourceCommandId: createdHold.id,
            idempotencyKey: `task-tree-pause:${createdHold.id}`,
            committedAt: now,
          });
        }
        return {
          hold: createdHold,
          members: createdMembers,
          preview: committedPreview,
          pauseInterruptions,
          cancelCancellations: [] as RequestedScopedRunCancellations[],
          cancelledTaskIds: [],
        };
      }

      if (input.mode === "cancel") {
        if (!options.taskExecutionCancellation) {
          throw new Error(
            "Task-tree cancellation requires the execution cancellation boundary",
          );
        }
        const rows = affectedTaskIds.length === 0
          ? []
          : await tx
            .update(tasks)
            .set({
              boardPresentationStatus: "cancelled",
              lifecycleStatus: "cancelled",
              disposition: {
                message: `Cancelled by task-tree hold ${createdHold.id}`,
                structuredResult: {
                  kind: "task_tree_control",
                  holdId: createdHold.id,
                },
              },
              cancelledAt: now,
              completedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.companyId, companyId),
                inArray(tasks.id, affectedTaskIds),
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .returning({
              id: tasks.id,
              companyId: tasks.companyId,
              ownershipEpoch: tasks.ownershipEpoch,
              identifier: tasks.identifier,
              title: tasks.title,
              boardPresentationStatus: tasks.boardPresentationStatus,
              ownerAgentId: tasks.ownerAgentId,
            });
        if (actorUserId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedTasks: rows.map((task) => ({
              id: task.id,
              ownershipEpoch: task.ownershipEpoch,
            })),
            actorUserId,
            subtype: "tree_control_cancel",
            sourceCommandId: createdHold.id,
            idempotencyKey: `task-tree-cancel:${createdHold.id}`,
            committedAt: now,
          });
        }
        const cancelCancellations: RequestedScopedRunCancellations[] = [];
        for (const task of rows) {
          cancelCancellations.push(
            await options.taskExecutionCancellation
              .requestScopeCancellationsInTransaction(tx, {
                companyId,
                taskId: task.id,
                selector: {
                  kind: "ownership_epoch",
                  ownershipEpoch: task.ownershipEpoch,
                },
                reason: "task_tree_cancelled",
                actor: cancellationActorForHold(createdHold),
                now,
              }),
          );
        }
        return {
          hold: createdHold,
          members: createdMembers,
          preview: committedPreview,
          pauseInterruptions: [] as RequestedRunningTaskInterruptions[],
          cancelCancellations,
          cancelledTaskIds: rows.map((task) => task.id),
        };
      }

      return {
        hold: createdHold,
        members: createdMembers,
        preview: committedPreview,
        pauseInterruptions: [] as RequestedRunningTaskInterruptions[],
        cancelCancellations: [] as RequestedScopedRunCancellations[],
        cancelledTaskIds: [],
      };
    });

    if (options.taskExecutionCancellation) {
      for (const requested of applied.pauseInterruptions) {
        void options.taskExecutionCancellation
          .reconcileRequestedCancellations(requested)
          .catch(() => {
            // The durable cancellation intent remains restart-reconcilable.
          });
      }
      for (const requested of applied.cancelCancellations) {
        void options.taskExecutionCancellation
          .reconcileRequestedCancellations(requested)
          .catch(() => {
            // The durable cancellation intent remains restart-reconcilable.
          });
      }
    }
    return {
      hold: toHold(applied.hold, applied.members),
      preview: applied.preview,
      cancelledTaskIds: applied.cancelledTaskIds,
    };
  }

  async function restoreTaskStatusesForHold(
    companyId: string,
    rootTaskId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: ActorInput;
    },
  ): Promise<RestoreTreeStatusResult> {
    const restoreHold = await getHold(companyId, restoreHoldId);
    if (!restoreHold) throw notFound("Task tree hold not found");
    if (restoreHold.rootTaskId !== rootTaskId) {
      throw unprocessable("Task tree hold does not belong to the requested root task");
    }
    if (restoreHold.mode !== "restore") {
      throw unprocessable("Task tree hold is not a restore operation");
    }

    const activeCancelHolds = await listHolds(companyId, rootTaskId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const cancelSnapshotByTaskId = new Map<string, TaskTreeHoldMember>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        if (!member.skipped && !cancelSnapshotByTaskId.has(member.taskId)) {
          cancelSnapshotByTaskId.set(member.taskId, member);
        }
      }
    }

    const restoreTaskIds = [...new Set((restoreHold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.taskId))];
    const restoreStatusByTaskId = new Map<string, TaskStatus>();
    for (const taskId of restoreTaskIds) {
      const snapshot = cancelSnapshotByTaskId.get(taskId);
      if (!snapshot) continue;
      const restoredStatus = restoreStatusFromCancelSnapshot(coerceTaskStatus(snapshot.taskStatus));
      if (restoredStatus) restoreStatusByTaskId.set(taskId, restoredStatus);
    }

    const taskIdsByStatus = new Map<TaskStatus, string[]>();
    for (const [taskId, status] of restoreStatusByTaskId) {
      const current = taskIdsByStatus.get(status) ?? [];
      current.push(taskId);
      taskIdsByStatus.set(status, current);
    }

    const now = new Date();
    const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
    const updatedTasks = await db.transaction(async (tx) => {
      const restored: TreeStatusUpdateResult["updatedTasks"] = [];
      const restoredForLedger: NamedBoardLifecycleAffectedTask[] = [];
      for (const [status, taskIdsForStatus] of taskIdsByStatus) {
        if (taskIdsForStatus.length === 0) continue;
        const rows = await tx
          .update(tasks)
          .set({
            boardPresentationStatus: status,
            lifecycleStatus: status === "blocked" ? "blocked" : "open",
            disposition: null,
            cancelledAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, companyId),
              inArray(tasks.id, taskIdsForStatus),
              eq(tasks.lifecycleStatus, "cancelled"),
              eq(tasks.boardPresentationStatus, "cancelled"),
            ),
          )
          .returning({
            id: tasks.id,
            ownershipEpoch: tasks.ownershipEpoch,
            boardPresentationStatus: tasks.boardPresentationStatus,
            ownerAgentId: tasks.ownerAgentId,
          });
        restoredForLedger.push(
          ...rows.map((task) => ({
            id: task.id,
            ownershipEpoch: task.ownershipEpoch,
          })),
        );
        restored.push(...rows.map((task) => ({
          id: task.id,
          boardPresentationStatus:
            coerceTaskStatus(task.boardPresentationStatus),
          ownerAgentId: task.ownerAgentId,
        })));
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(taskTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredTaskIds: restored.map((task) => task.id),
            },
            updatedAt: now,
          })
          .where(and(eq(taskTreeHolds.companyId, companyId), inArray(taskTreeHolds.id, releasedCancelHoldIds)));
      }

      await tx
        .update(taskTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredTaskIds: restored.map((task) => task.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(taskTreeHolds.companyId, companyId), eq(taskTreeHolds.id, restoreHoldId)));

      const actorUserId =
        restoreHold.createdByActorType === "user"
          ? restoreHold.createdByUserId
          : null;
      if (
        restoreHold.createdByActorType === "user" &&
        (!actorUserId || namedBoardActorUserId(input.actor) !== actorUserId)
      ) {
        throw unprocessable(
          "Restore application actor does not match the named user who sent the restore command",
        );
      }
      if (actorUserId) {
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId,
          affectedTasks: restoredForLedger,
          actorUserId,
          subtype: "tree_control_restore",
          sourceCommandId: restoreHoldId,
          idempotencyKey: `task-tree-restore:${restoreHoldId}`,
          committedAt: now,
        });
      }

      return restored;
    });

    return {
      updatedTaskIds: updatedTasks.map((task) => task.id),
      updatedTasks,
      releasedCancelHoldIds,
      restoreHold: await getHold(companyId, restoreHoldId),
    };
  }

  async function getHold(companyId: string, holdId: string) {
    const hold = await db
      .select()
      .from(taskTreeHolds)
      .where(and(eq(taskTreeHolds.id, holdId), eq(taskTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(and(eq(taskTreeHoldMembers.companyId, companyId), eq(taskTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(taskTreeHoldMembers.depth), asc(taskTreeHoldMembers.createdAt), asc(taskTreeHoldMembers.taskId));
    return toHold(hold, members);
  }

  async function listHolds(
    companyId: string,
    rootTaskId: string,
    input?: {
      status?: TaskTreeHold["status"];
      mode?: TaskTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    const whereClauses = [
      eq(taskTreeHolds.companyId, companyId),
      eq(taskTreeHolds.rootTaskId, rootTaskId),
    ];
    if (input?.status) whereClauses.push(eq(taskTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(taskTreeHolds.mode, input.mode));

    const holds = await db
      .select()
      .from(taskTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => toHold(hold));
    }

    const holdIds = holds.map((hold) => hold.id);
    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(
        and(
          eq(taskTreeHoldMembers.companyId, companyId),
          inArray(taskTreeHoldMembers.holdId, holdIds),
        ),
      )
      .orderBy(asc(taskTreeHoldMembers.depth), asc(taskTreeHoldMembers.createdAt), asc(taskTreeHoldMembers.taskId));

    const membersByHoldId = new Map<string, HoldMemberRow[]>();
    for (const member of members) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }

    return holds.map((hold) => toHold(hold, membersByHoldId.get(hold.id) ?? []));
  }

  async function releaseHold(
    companyId: string,
    rootTaskId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
      /** Internal cleanup/choreography never qualifies as a board action. */
      internal?: true;
    },
  ) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(taskTreeHolds)
        .where(
          and(
            eq(taskTreeHolds.id, holdId),
            eq(taskTreeHolds.companyId, companyId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Task tree hold not found");
      if (existing.rootTaskId !== rootTaskId) {
        throw unprocessable(
          "Task tree hold does not belong to the requested root task",
        );
      }
      if (
        existing.mode !== "pause" &&
        !(input.internal && existing.mode === "restore")
      ) {
        throw unprocessable("Only pause holds can be released directly");
      }
      if (existing.status === "released") {
        throw conflict("Task tree hold is already released");
      }

      const now = new Date();
      const [updated] = await tx
        .update(taskTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId:
            input.actor.userId ??
            (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? null,
          releasePolicy: input.releasePolicy
            ? (normalizeReleasePolicy(
                input.releasePolicy,
              ) as unknown as Record<string, unknown>)
            : existing.releasePolicy,
          releaseMetadata: input.metadata ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskTreeHolds.id, holdId),
            eq(taskTreeHolds.companyId, companyId),
            eq(taskTreeHolds.status, "active"),
          ),
        )
        .returning();
      if (!updated) {
        throw conflict("Task tree hold changed while it was released");
      }

      const members = await tx
        .select()
        .from(taskTreeHoldMembers)
        .where(
          and(
            eq(taskTreeHoldMembers.companyId, companyId),
            eq(taskTreeHoldMembers.holdId, holdId),
          ),
        )
        .orderBy(
          asc(taskTreeHoldMembers.depth),
          asc(taskTreeHoldMembers.createdAt),
          asc(taskTreeHoldMembers.taskId),
        );

      const actorUserId = input.internal
        ? null
        : namedBoardActorUserId(input.actor);
      if (actorUserId) {
        const affectedTaskIds = members
          .filter((member) => !member.skipped)
          .map((member) => member.taskId);
        const affectedTasks = affectedTaskIds.length === 0
          ? []
          : await tx
            .select({
              id: tasks.id,
              ownershipEpoch: tasks.ownershipEpoch,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                inArray(tasks.id, affectedTaskIds),
              ),
            )
            .orderBy(asc(tasks.id))
            .for("update");
        const sourceCommandId = deterministicTreeCommandId(
          "task-tree-release",
          `${companyId}:${holdId}`,
        );
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId,
          affectedTasks,
          actorUserId,
          subtype: "tree_control_release",
          sourceCommandId,
          idempotencyKey: `task-tree-release:${holdId}`,
          committedAt: now,
        });
      }

      return toHold(updated, members);
    });
  }

  return {
    listTreeTasks,
    preview,
    createHold,
    restoreTaskStatusesForHold,
    getHold,
    listHolds,
    getActivePauseHoldGate,
    releaseHold,
  };
}
