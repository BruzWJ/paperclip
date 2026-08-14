import * as d from "./tasks-dependencies.js";

import { taskServiceOperations } from "./tasks-operations.js";
import * as taskShared from "./tasks-shared.js";
import type { TaskControlStateUpdate } from "./tasks-shared-part-1.js";

export function taskServicePart3(db: d.Db) {
  const context = taskShared.taskServiceContext(db);
  const { instanceSettings } = context;
  const {
    redactTaskComment,
    loadBoardAuthorLabels,
    projectBoardTaskComment,
    loadRunStatuses,
    loadBoardCommentThreadPage,
    loadBoardCommentThreadPages,
    getBoardCommentProjection,
    syncTaskLabels,
    syncBlockedByTaskIds,
  } = taskServiceOperations(context);

  return {
    updateControlState: async (id: string, data: TaskControlStateUpdate, dbOrTx: any = db) => {
      if (Object.prototype.hasOwnProperty.call(data, "executionWorkspaceId")) {
        throw d.unprocessable(
          "executionWorkspaceId is managed by the current task execution workspace binding",
        );
      }
      for (const field of [
        "request",
        "title",
        "parentId",
        "parentOwnershipEpoch",
        "ownerKind",
        "ownerAgentId",
        "ownerUserId",
        "ownerAssignmentSource",
        "ownershipEpoch",
        "creatorKind",
        "creatorAuthorityId",
        "creatorAdapterConfigRevisionId",
        "creatorUserId",
        "creatorPluginInstallationId",
        "creatorPluginKey",
        "creatorCallbackKey",
        "creatorCallbackVersion",
        "creatorRoutineId",
        "creatorRoutineDispatchId",
        "creatorSystemSourceKind",
        "creatorSystemSourceId",
        "lifecycleStatus",
        "disposition",
        "completedAt",
        "cancelledAt",
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
          throw d.unprocessable(`Task ${field} is immutable or has a dedicated canonical command`);
        }
      }
      const existing = await dbOrTx
        .select()
        .from(d.tasks)
        .where(d.eq(d.tasks.id, id))
        .then((rows: Array<typeof d.tasks.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const { labelIds: nextLabelIds, blockedByTaskIds, actorAgentId, actorUserId, ...taskData } = data;
      if (taskData.boardPresentationStatus) {
        taskShared.assertTransition(existing.boardPresentationStatus, taskData.boardPresentationStatus);
      }

      const patch: Partial<typeof d.tasks.$inferInsert> = {
        ...taskData,
        updatedAt: new Date(),
      };
      if (taskData.requestDepth !== undefined) {
        patch.requestDepth = d.clampTaskRequestDepth(taskData.requestDepth);
      }

      if (
        patch.boardPresentationStatus === "in_progress" &&
        !existing.ownerAgentId &&
        !existing.ownerUserId
      ) {
        throw d.unprocessable("in_progress tasks require an owner");
      }
      if (patch.boardPresentationStatus === "in_progress") {
        const unresolvedBlockerTaskIds =
          blockedByTaskIds !== undefined
            ? await taskShared.listUnresolvedBlockerTaskIds(dbOrTx, existing.companyId, blockedByTaskIds)
            : ((await taskShared.listTaskDependencyReadinessMap(dbOrTx, existing.companyId, [id])).get(id)
                ?.unresolvedBlockerTaskIds ?? []);
        if (unresolvedBlockerTaskIds.length > 0) {
          throw d.unprocessable("Task is blocked by unresolved blockers", {
            unresolvedBlockerTaskIds,
          });
        }
      }
      if (
        patch.boardPresentationStatus === "in_progress" &&
        existing.ownerKind === "agent" &&
        existing.ownerAgentId
      ) {
        try {
          await d.resolveInvokableTaskOwnerFromDb(dbOrTx as d.Db, {
            companyId: existing.companyId,
            ownerAgentId: existing.ownerAgentId,
          });
        } catch (error) {
          if (error instanceof d.InvokableTaskOwnerRejected) {
            throw d.conflict("Task owner must be an invokable task owner", {
              code: "task_owner_not_invokable",
              reason: error.reason,
              companyId: existing.companyId,
              ownerAgentId: existing.ownerAgentId,
              ...error.details,
            });
          }
          throw error;
        }
      }
      taskShared.applyStatusSideEffects(taskData.boardPresentationStatus, patch);
      if (taskData.boardPresentationStatus && taskData.boardPresentationStatus !== "done") {
        patch.completedAt = null;
      }
      if (taskData.boardPresentationStatus && taskData.boardPresentationStatus !== "cancelled") {
        patch.cancelledAt = null;
      }
      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await d.getDefaultCompanyGoal(tx, existing.companyId);

        patch.goalId = d.resolveNextTaskGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          projectId: taskData.projectId,
          goalId: taskData.goalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(d.tasks)
          .set(patch)
          .where(d.eq(d.tasks.id, id))
          .returning()
          .then((rows: Array<typeof d.tasks.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncTaskLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByTaskIds !== undefined) {
          await syncBlockedByTaskIds(
            updated.id,
            existing.companyId,
            blockedByTaskIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await taskShared.withTaskLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },
    listLabels: (companyId: string) =>
      db
        .select()
        .from(d.labels)
        .where(d.eq(d.labels.companyId, companyId))
        .orderBy(d.asc(d.labels.name), d.asc(d.labels.id)),
    getLabelById: (id: string) => {
      if (!d.isCanonicalUuid(id)) return Promise.resolve(null);
      return db
        .select()
        .from(d.labels)
        .where(d.eq(d.labels.id, id))
        .then((rows) => rows[0] ?? null);
    },
    createLabel: async (companyId: string, data: Pick<typeof d.labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(d.labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },
    deleteLabel: async (id: string) => {
      if (!d.isCanonicalUuid(id)) return null;
      return db
        .delete(d.labels)
        .where(d.eq(d.labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
    listBoardCommentGroups: async (
      companyId: string,
      taskId: string,
      opts?: {
        cursor?: string | null;
        limit?: number | null;
        entryLimit?: number | null;
      },
    ): Promise<d.BoardTaskCommentGroupPage> => {
      const limit = taskShared.boundedBoardCommentPageSize(
        opts?.limit,
        taskShared.DEFAULT_BOARD_COMMENT_ROOT_LIMIT,
      );
      const entryLimit = taskShared.boundedBoardCommentPageSize(
        opts?.entryLimit,
        taskShared.DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
      );
      const cursor = taskShared.decodeBoardCommentCursor(opts?.cursor, {
        kind: "roots",
        taskId,
        rootCommentId: null,
      });
      const conditions = [
        d.eq(d.taskComments.companyId, companyId),
        d.eq(d.taskComments.taskId, taskId),
        d.isNull(d.taskComments.replyToCommentId),
      ];
      if (cursor) {
        conditions.push(
          d.or(
            d.lt(d.taskComments.projectedEventSeq, cursor.sequence),
            d.and(
              d.eq(d.taskComments.projectedEventSeq, cursor.sequence),
              d.lt(d.taskComments.id, cursor.id),
            ),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(d.taskComments)
        .where(d.and(...conditions))
        .orderBy(d.desc(d.taskComments.projectedEventSeq), d.desc(d.taskComments.id))
        .limit(limit + 1);
      const roots = rows.slice(0, limit);
      const [labels, runStatuses, general, threadPages] = await Promise.all([
        loadBoardAuthorLabels(roots),
        loadRunStatuses(roots.map((root) => root.runId)),
        instanceSettings.getGeneral(),
        loadBoardCommentThreadPages(roots, entryLimit),
      ]);
      const groups = roots.map((root) => {
        const thread = threadPages.get(root.id)!;
        return {
          root: projectBoardTaskComment({
            comment: root,
            parent: null,
            labels,
            censorUsernameInLogs: general.censorUsernameInLogs,
            runStatus: root.runId ? runStatuses.get(root.runId) : null,
          }),
          replyCount: thread.replyCount,
          runSegmentCount: thread.runSegmentCount,
          entries: thread.entries,
          entriesNextCursor: thread.nextCursor,
        };
      });
      const finalRoot = roots.at(-1);
      return {
        groups,
        nextCursor:
          rows.length > limit && finalRoot
            ? taskShared.encodeBoardCommentCursor({
                version: 1,
                kind: "roots",
                taskId,
                rootCommentId: null,
                sequence: finalRoot.projectedEventSeq,
                id: finalRoot.id,
              })
            : null,
      };
    },
    getBoardComment: (companyId: string, taskId: string, commentId: string) =>
      getBoardCommentProjection({ companyId, taskId, commentId }),
    getBoardCommentThread: async (
      companyId: string,
      taskId: string,
      rootCommentId: string,
      opts?: { cursor?: string | null; limit?: number | null },
    ): Promise<d.BoardTaskCommentThreadPage | null> => {
      if (!d.isCanonicalUuid(companyId) || !d.isCanonicalUuid(taskId) || !d.isCanonicalUuid(rootCommentId)) {
        return null;
      }
      const root = await db
        .select()
        .from(d.taskComments)
        .where(
          d.and(
            d.eq(d.taskComments.companyId, companyId),
            d.eq(d.taskComments.taskId, taskId),
            d.eq(d.taskComments.id, rootCommentId),
            d.isNull(d.taskComments.replyToCommentId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!root) return null;
      const page = await loadBoardCommentThreadPage({
        root,
        cursor: opts?.cursor,
        limit: opts?.limit,
      });
      return { entries: page.entries, nextCursor: page.nextCursor };
    },
    listComments: async (
      taskId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId ?? null;
      if (afterCommentId !== null && !d.isCanonicalUuid(afterCommentId)) {
        throw d.unprocessable("afterCommentId must be an exact canonical UUID");
      }
      const limit = opts?.limit ?? null;
      if (
        limit !== null &&
        (!Number.isSafeInteger(limit) || limit < 1 || limit > taskShared.MAX_TASK_COMMENT_PAGE_LIMIT)
      ) {
        throw d.unprocessable(
          `Task comment page limit must be between 1 and ${taskShared.MAX_TASK_COMMENT_PAGE_LIMIT}`,
        );
      }

      const conditions = [d.eq(d.taskComments.taskId, taskId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: d.taskComments.id,
            createdAt: d.taskComments.createdAt,
          })
          .from(d.taskComments)
          .where(d.and(d.eq(d.taskComments.taskId, taskId), d.eq(d.taskComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt =
          anchor.createdAt instanceof Date ? anchor.createdAt : new Date(String(anchor.createdAt));
        conditions.push(
          order === "asc"
            ? d.or(
                d.gt(d.taskComments.createdAt, anchorCreatedAt),
                d.and(d.eq(d.taskComments.createdAt, anchorCreatedAt), d.gt(d.taskComments.id, anchor.id)),
              )!
            : d.or(
                d.lt(d.taskComments.createdAt, anchorCreatedAt),
                d.and(d.eq(d.taskComments.createdAt, anchorCreatedAt), d.lt(d.taskComments.id, anchor.id)),
              )!,
        );
      }

      const query = db
        .select()
        .from(d.taskComments)
        .where(d.and(...conditions))
        .orderBy(
          order === "asc" ? d.asc(d.taskComments.createdAt) : d.desc(d.taskComments.createdAt),
          order === "asc" ? d.asc(d.taskComments.id) : d.desc(d.taskComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) => redactTaskComment(comment, censorUsernameInLogs));
    },
  };
}
