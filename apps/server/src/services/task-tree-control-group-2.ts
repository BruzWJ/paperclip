import { type Db, taskTreeHoldMembers, taskTreeHolds, tasks } from "@paperclipai/db";
import {
  type TaskTreeControlMode,
  type TaskTreeControlPreview,
  type TaskTreeHold,
  type TaskTreeHoldReleasePolicy,
} from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { recordNamedBoardLifecycleCommandInTransaction } from "./task-board-lifecycle-command.js";
import type {
  RequestedRunningTaskInterruptions,
  RequestedScopedRunCancellations,
} from "./task-execution-cancellation.js";
import { lockTaskTreeExecutionGate } from "./task-execution-lifecycle-gate.js";
import { taskTreeControlServiceGroup1 } from "./task-tree-control-group-1.js";
import * as treeControl from "./task-tree-control-foundation.js";

export function taskTreeControlServiceGroup2(
  context: {
    db: Db;
    options: {
      taskExecutionCancellation?: treeControl.TaskTreeCancellationPort;
    };
  },
  group1: ReturnType<typeof taskTreeControlServiceGroup1>,
) {
  const { db, options } = context;
  const {
    hydrateHoldMemberTaskNumbers,
    listTreeTasks,
    activeRunsForTree,
    activeHoldsByTaskId,
    activeCancelSnapshotsByTaskId,
    getActivePauseHoldGate,
    preview,
  } = Object.assign({}, group1);
  async function createHold(
    companyId: string,
    rootTaskId: string,
    input: {
      mode: TaskTreeControlMode;
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      actor: treeControl.ActorInput;
    },
  ): Promise<{
    hold: TaskTreeHold;
    preview: TaskTreeControlPreview;
    resumedPauseHoldIds?: string[];
    cancelledTaskIds: string[];
  }> {
    const holdReleasePolicy = treeControl.normalizeReleasePolicy(input.releasePolicy);
    const holdPreview =
      input.mode === "pause" || input.mode === "cancel"
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
          createdByUserId:
            input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
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

      const createdMembers =
        memberRows.length > 0 ? await tx.insert(taskTreeHoldMembers).values(memberRows).returning() : [];

      const taskNumberById = new Map(previewSnapshot.tasks.map((task) => [task.id, task.taskNumber]));
      const createdMemberSummaries: treeControl.HoldMemberSummaryRow[] = createdMembers.map((member) => {
        const taskNumber = taskNumberById.get(member.taskId);
        if (taskNumber === undefined) {
          throw conflict("Created task-tree hold member references an unavailable task");
        }
        return { ...member, taskNumber };
      });

      return { createdHold, createdMembers: createdMemberSummaries };
    }

    if (input.mode === "resume") {
      const resumePreview = holdPreview!;
      const taskIds = [...new Set(resumePreview.tasks.map((task) => task.id))];
      const releaseReason = input.reason ?? "Subtree resume applied.";
      const actorUserId = treeControl.namedBoardActorUserId(input.actor);

      return db.transaction(async (tx) => {
        const activePauseHolds =
          taskIds.length === 0
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
              ...(input.releasePolicy ? { releasePolicy: holdReleasePolicy } : {}),
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
            .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, affectedTaskIds)))
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
          hold: treeControl.toHold(releasedResumeHold, createdMembers),
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
      const committedPreview =
        holdPreview ??
        (await taskTreeControlServiceGroup1({
          db: tx as unknown as Db,
          options: {},
        }).preview(companyId, rootTaskId, {
          mode: input.mode,
          releasePolicy: holdReleasePolicy,
        }));
      const { createdHold, createdMembers } = await insertHoldWithMembers(tx, committedPreview);
      const affectedTaskIds = createdMembers
        .filter((member) => !member.skipped)
        .map((member) => member.taskId);
      const actorUserId = treeControl.namedBoardActorUserId(input.actor);
      const now = createdHold.createdAt;

      if (input.mode === "pause") {
        if (!options.taskExecutionCancellation) {
          throw new Error("Task-tree pause requires the execution cancellation boundary");
        }
        const affectedTasks =
          affectedTaskIds.length === 0
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
            await options.taskExecutionCancellation.requestRunningTaskInterruptionsInTransaction(tx, {
              companyId,
              taskId: task.id,
              ownershipEpoch: task.ownershipEpoch,
              reason: "active_subtree_pause_hold",
              actor: treeControl.cancellationActorForHold(createdHold),
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
          throw new Error("Task-tree cancellation requires the execution cancellation boundary");
        }
        const rows =
          affectedTaskIds.length === 0
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
            await options.taskExecutionCancellation.requestScopeCancellationsInTransaction(tx, {
              companyId,
              taskId: task.id,
              selector: {
                kind: "ownership_epoch",
                ownershipEpoch: task.ownershipEpoch,
              },
              reason: "task_tree_cancelled",
              actor: treeControl.cancellationActorForHold(createdHold),
              now,
              nativeContinuity: "preserve_carry",
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
        void options.taskExecutionCancellation.reconcileRequestedCancellations(requested).catch(() => {
          // The durable cancellation intent remains restart-reconcilable.
        });
      }
      for (const requested of applied.cancelCancellations) {
        void options.taskExecutionCancellation.reconcileRequestedCancellations(requested).catch(() => {
          // The durable cancellation intent remains restart-reconcilable.
        });
      }
    }
    return {
      hold: treeControl.toHold(applied.hold, applied.members),
      preview: applied.preview,
      cancelledTaskIds: applied.cancelledTaskIds,
    };
  }
  return { createHold };
}
