import { type Db, taskTreeHoldMembers, taskTreeHolds, tasks } from "@paperclipai/db";
import {
  type TaskStatus,
  type TaskTreeHoldMember,
  type TaskTreeHoldReleasePolicy,
} from "@paperclipai/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  recordNamedBoardLifecycleCommandInTransaction,
  type NamedBoardLifecycleAffectedTask,
} from "./task-board-lifecycle-command.js";
import { taskTreeControlServiceGroup1 } from "./task-tree-control-group-1.js";
import { taskTreeControlServiceGroup2 } from "./task-tree-control-group-2.js";
import * as treeControl from "./task-tree-control-foundation.js";

export function taskTreeControlServiceGroup3(
  context: {
    db: Db;
    options: {
      taskExecutionCancellation?: treeControl.TaskTreeCancellationPort;
    };
  },
  group1: ReturnType<typeof taskTreeControlServiceGroup1>,
  group2: ReturnType<typeof taskTreeControlServiceGroup2>,
) {
  const { db, options } = context;
  const {
    hydrateHoldMemberTaskNumbers,
    listTreeTasks,
    activeRunsForTree,
    activeHoldsByTaskId,
    activeCancelSnapshotsByTaskId,
    getActivePauseHoldGate,
    listHolds,
    preview,
    createHold,
  } = Object.assign({}, group1, group2);
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
      .orderBy(
        asc(taskTreeHoldMembers.depth),
        asc(taskTreeHoldMembers.createdAt),
        asc(taskTreeHoldMembers.taskId),
      );
    return treeControl.toHold(hold, await hydrateHoldMemberTaskNumbers(db, companyId, members));
  }

  async function restoreTaskStatusesForHold(
    companyId: string,
    rootTaskId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: treeControl.ActorInput;
    },
  ): Promise<treeControl.RestoreTreeStatusResult> {
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

    const restoreTaskIds = [
      ...new Set(
        (restoreHold.members ?? []).filter((member) => !member.skipped).map((member) => member.taskId),
      ),
    ];
    const restoreStatusByTaskId = new Map<string, TaskStatus>();
    for (const taskId of restoreTaskIds) {
      const snapshot = cancelSnapshotByTaskId.get(taskId);
      if (!snapshot) continue;
      const restoredStatus = treeControl.restoreStatusFromCancelSnapshot(
        treeControl.coerceTaskStatus(snapshot.taskStatus),
      );
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
      const restored: treeControl.TreeStatusUpdateResult["updatedTasks"] = [];
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
        restored.push(
          ...rows.map((task) => ({
            id: task.id,
            boardPresentationStatus: treeControl.coerceTaskStatus(task.boardPresentationStatus),
            ownerAgentId: task.ownerAgentId,
          })),
        );
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(taskTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId:
              input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredTaskIds: restored.map((task) => task.id),
            },
            updatedAt: now,
          })
          .where(
            and(eq(taskTreeHolds.companyId, companyId), inArray(taskTreeHolds.id, releasedCancelHoldIds)),
          );
      }

      await tx
        .update(taskTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId:
            input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredTaskIds: restored.map((task) => task.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(taskTreeHolds.companyId, companyId), eq(taskTreeHolds.id, restoreHoldId)));

      const actorUserId = restoreHold.createdByActorType === "user" ? restoreHold.createdByUserId : null;
      if (
        restoreHold.createdByActorType === "user" &&
        (!actorUserId || treeControl.namedBoardActorUserId(input.actor) !== actorUserId)
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

  async function releaseHold(
    companyId: string,
    rootTaskId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: treeControl.ActorInput;
      /** Internal cleanup/choreography never qualifies as a board action. */
      internal?: true;
    },
  ) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(taskTreeHolds)
        .where(and(eq(taskTreeHolds.id, holdId), eq(taskTreeHolds.companyId, companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Task tree hold not found");
      if (existing.rootTaskId !== rootTaskId) {
        throw unprocessable("Task tree hold does not belong to the requested root task");
      }
      if (existing.mode !== "pause" && !(input.internal && existing.mode === "restore")) {
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
            input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? null,
          releasePolicy: input.releasePolicy
            ? (treeControl.normalizeReleasePolicy(input.releasePolicy) as unknown as Record<string, unknown>)
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
        .where(and(eq(taskTreeHoldMembers.companyId, companyId), eq(taskTreeHoldMembers.holdId, holdId)))
        .orderBy(
          asc(taskTreeHoldMembers.depth),
          asc(taskTreeHoldMembers.createdAt),
          asc(taskTreeHoldMembers.taskId),
        );

      const actorUserId = input.internal ? null : treeControl.namedBoardActorUserId(input.actor);
      if (actorUserId) {
        const affectedTaskIds = members.filter((member) => !member.skipped).map((member) => member.taskId);
        const affectedTasks =
          affectedTaskIds.length === 0
            ? []
            : await tx
                .select({
                  id: tasks.id,
                  ownershipEpoch: tasks.ownershipEpoch,
                })
                .from(tasks)
                .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, affectedTaskIds)))
                .orderBy(asc(tasks.id))
                .for("update");
        const sourceCommandId = treeControl.deterministicTreeCommandId(
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

      return treeControl.toHold(updated, await hydrateHoldMemberTaskNumbers(tx, companyId, members));
    });
  }
  return { getHold, listHolds, restoreTaskStatusesForHold, releaseHold };
}
