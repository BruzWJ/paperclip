import { type Db, taskTreeHoldMembers, taskTreeHolds, tasks } from "@paperclipai/db";
import type {
  TaskStatus,
  TaskTreeControlMode,
  TaskTreeControlPreview,
  TaskTreeHold,
  TaskTreeHoldReleasePolicy,
  TaskTreePreviewTask,
} from "@paperclipai/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { resolveCurrentTaskOwnerRunLinkages } from "./productive-run-linkage.js";

import * as treeControl from "./task-tree-control-foundation.js";

export function taskTreeControlServiceGroup1(context: {
  db: Db;
  options: { taskExecutionCancellation?: treeControl.TaskTreeCancellationPort };
}) {
  const { db, options } = context;
  async function hydrateHoldMemberTaskNumbers(
    dbOrTx: any,
    companyId: string,
    members: treeControl.HoldMemberRow[],
  ): Promise<treeControl.HoldMemberSummaryRow[]> {
    if (members.length === 0) return [];
    const taskRows: Array<{ id: string; taskNumber: number }> = await dbOrTx
      .select({ id: tasks.id, taskNumber: tasks.taskNumber })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          inArray(tasks.id, [...new Set(members.map((member) => member.taskId))]),
        ),
      );
    const taskNumberById = new Map<string, number>(taskRows.map((task) => [task.id, task.taskNumber]));
    return members.map((member) => {
      const taskNumber = taskNumberById.get(member.taskId);
      if (taskNumber === undefined) {
        throw conflict("Task-tree hold member references an unavailable task");
      }
      return { ...member, taskNumber };
    });
  }

  async function listTreeTasks(companyId: string, rootTaskId: string): Promise<treeControl.TreeTask[]> {
    const root = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, rootTaskId), eq(tasks.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root task not found");
    }

    const result: treeControl.TreeTask[] = [{ ...root, depth: 0 }];
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

  async function activeRunsForTree(companyId: string, treeTasks: treeControl.TreeTask[]) {
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

  async function listHolds(
    companyId: string,
    rootTaskId: string,
    input?: {
      status?: TaskTreeHold["status"];
      mode?: TaskTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    const whereClauses = [eq(taskTreeHolds.companyId, companyId), eq(taskTreeHolds.rootTaskId, rootTaskId)];
    if (input?.status) whereClauses.push(eq(taskTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(taskTreeHolds.mode, input.mode));
    const holds = await db
      .select()
      .from(taskTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => treeControl.toHold(hold));
    }
    const holdIds = holds.map((hold) => hold.id);
    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(and(eq(taskTreeHoldMembers.companyId, companyId), inArray(taskTreeHoldMembers.holdId, holdIds)))
      .orderBy(
        asc(taskTreeHoldMembers.depth),
        asc(taskTreeHoldMembers.createdAt),
        asc(taskTreeHoldMembers.taskId),
      );
    const hydratedMembers = await hydrateHoldMemberTaskNumbers(db, companyId, members);
    const membersByHoldId = new Map<string, treeControl.HoldMemberSummaryRow[]>();
    for (const member of hydratedMembers) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }
    return holds.map((hold) => treeControl.toHold(hold, membersByHoldId.get(hold.id) ?? []));
  }

  async function activeCancelSnapshotsByTaskId(companyId: string, rootTaskId: string) {
    const activeCancelHolds = await listHolds(companyId, rootTaskId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byTaskId = new Map<string, treeControl.ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byTaskId.get(member.taskId) ?? {
          holdIds: [],
          member: null,
        };
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
  ): Promise<treeControl.ActiveTaskTreePauseHoldGate | null> {
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
      currentTaskId &&
      !visited.has(currentTaskId) &&
      visited.size < treeControl.MAX_PAUSE_HOLD_ANCESTOR_DEPTH
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
        : Promise.resolve(new Map<string, treeControl.ActiveCancelSnapshot>()),
    ]);
    const runsByTaskId = new Map<string, treeControl.ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByTaskId.has(run.taskId)) runsByTaskId.set(run.taskId, run);
    }
    const countsByStatus: Partial<Record<TaskStatus, number>> = {};

    const tasksToPreview = treeTasks.map((task) => {
      const boardPresentationStatus = treeControl.coerceTaskStatus(task.boardPresentationStatus);
      countsByStatus[boardPresentationStatus] = (countsByStatus[boardPresentationStatus] ?? 0) + 1;
      const holdState = holdsByTaskId.get(task.id) ?? { all: [], pause: [] };
      const skipReason = treeControl.taskSkipReason({
        mode: input.mode,
        task,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(task.id) ?? null,
      });
      const run = runsByTaskId.get(task.id);
      return {
        id: task.id,
        taskNumber: task.taskNumber,
        identifier: task.identifier,
        title: task.title,
        boardPresentationStatus,
        parentId: task.parentId,
        depth: task.depth,
        ownerAgentId: task.ownerAgentId,
        ownerUserId: task.ownerUserId,
        activeRun: run ? treeControl.toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies TaskTreePreviewTask;
    });
    const skippedTasks = tasksToPreview.filter((task) => task.skipped);
    const activeRuns = activeRunRows
      .map(treeControl.toPreviewRun)
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.id.localeCompare(b.id));
    const affectedAgents = treeControl.buildAffectedAgents(tasksToPreview);

    return {
      companyId,
      rootTaskId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: treeControl.normalizeReleasePolicy(input.releasePolicy),
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
      warnings: treeControl.buildWarnings({
        mode: input.mode,
        tasksToPreview,
        activeRuns,
      }),
    };
  }
  return {
    hydrateHoldMemberTaskNumbers,
    listTreeTasks,
    activeRunsForTree,
    activeHoldsByTaskId,
    activeCancelSnapshotsByTaskId,
    getActivePauseHoldGate,
    listHolds,
    preview,
  };
}
