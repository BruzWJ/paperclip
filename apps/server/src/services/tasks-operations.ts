import * as d from "./tasks-dependencies.js";
import { createTaskServiceProjectionOperations } from "./tasks-operations-method-1-projections.js";
import { createTaskServiceThreadPagesOperations } from "./tasks-operations-method-1-thread-pages.js";
import * as taskShared from "./tasks-shared.js";

import type { TaskCommentRow } from "./tasks-shared-part-8.js";

export function createTaskServiceRelationOperations(
  context: ReturnType<typeof taskShared.taskServiceContext>,
) {
  const { db } = context;
  async function getTaskRelationSummaryMap(
    companyId: string,
    taskIds: string[],
    dbOrTx: taskShared.DbReader = db,
  ): Promise<Map<string, taskShared.TaskRelationSummaryMap>> {
    const uniqueTaskIds = [...new Set(taskIds)];
    const empty = new Map<string, taskShared.TaskRelationSummaryMap>();
    for (const taskId of uniqueTaskIds) {
      empty.set(taskId, { blockedBy: [], blocks: [] });
    }
    if (uniqueTaskIds.length === 0) return empty;
    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentTaskId: d.taskRelations.relatedTaskId,
          relatedId: d.tasks.id,
          taskNumber: d.tasks.taskNumber,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
          priority: d.tasks.priority,
          ownerAgentId: d.tasks.ownerAgentId,
          ownerUserId: d.tasks.ownerUserId,
        })
        .from(d.taskRelations)
        .innerJoin(d.tasks, d.eq(d.taskRelations.taskId, d.tasks.id))
        .where(
          d.and(
            d.eq(d.taskRelations.companyId, companyId),
            d.eq(d.taskRelations.type, "blocks"),
            d.inArray(d.taskRelations.relatedTaskId, uniqueTaskIds),
          ),
        ),
      dbOrTx
        .select({
          currentTaskId: d.taskRelations.taskId,
          relatedId: d.tasks.id,
          taskNumber: d.tasks.taskNumber,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
          priority: d.tasks.priority,
          ownerAgentId: d.tasks.ownerAgentId,
          ownerUserId: d.tasks.ownerUserId,
        })
        .from(d.taskRelations)
        .innerJoin(d.tasks, d.eq(d.taskRelations.relatedTaskId, d.tasks.id))
        .where(
          d.and(
            d.eq(d.taskRelations.companyId, companyId),
            d.eq(d.taskRelations.type, "blocks"),
            d.inArray(d.taskRelations.taskId, uniqueTaskIds),
          ),
        ),
    ]);
    for (const row of blockedByRows) {
      empty.get(row.currentTaskId)?.blockedBy.push(taskShared.summarizeTaskRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentTaskId)?.blocks.push(taskShared.summarizeTaskRelationRow(row));
    }
    const terminalByRoot = await taskShared.terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );
    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) =>
        taskShared.taskRelationSortLabel(a).localeCompare(taskShared.taskRelationSortLabel(b)),
      );
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) =>
        taskShared.taskRelationSortLabel(a).localeCompare(taskShared.taskRelationSortLabel(b)),
      );
    }
    return empty;
  }

  return {
    getTaskRelationSummaryMap,
  };
}

export function createTaskServiceThreadPageOperations(
  context: ReturnType<typeof taskShared.taskServiceContext>,
  projections: ReturnType<typeof createTaskServiceProjectionOperations>,
) {
  const { db, instanceSettings } = context;
  const { loadBoardAuthorLabels, loadRunStatuses, projectBoardTaskComment, projectBoardRunSegment } =
    projections;
  async function loadBoardCommentThreadPage(input: {
    root: TaskCommentRow;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<
    d.BoardTaskCommentThreadPage & {
      replyCount: number;
      runSegmentCount: number;
    }
  > {
    const { root } = input;
    const limit = taskShared.boundedBoardCommentPageSize(
      input.limit,
      taskShared.DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
    );
    const cursor = taskShared.decodeBoardCommentCursor(input.cursor, {
      kind: "thread",
      taskId: root.taskId,
      rootCommentId: root.id,
    });
    const sequenceFloor = cursor?.sequence ?? root.projectedEventSeq;
    const descendantConditions = [
      d.eq(d.taskComments.companyId, root.companyId),
      d.eq(d.taskComments.taskId, root.taskId),
      d.eq(d.taskComments.threadRootCommentId, root.id),
      d.gte(d.taskComments.projectedEventSeq, sequenceFloor),
    ];
    const messageConditions = root.runId
      ? [
          d.eq(d.taskSessionMessages.companyId, root.companyId),
          d.eq(d.taskSessionMessages.taskId, root.taskId),
          d.eq(d.taskSessionMessages.sessionId, root.sessionId),
          d.eq(d.taskSessionMessages.runId, root.runId),
          d.eq(d.taskSessionMessages.type, "assistant" as const),
          d.gte(d.taskSessionMessages.seq, sequenceFloor),
          d.sql`not exists (
            select 1 from ${d.taskCommentProjectionSources} later_source
            where later_source.company_id = ${root.companyId}
              and later_source.task_id = ${root.taskId}
              and later_source.run_id = ${root.runId}
              and later_source.reply_to_comment_id is null
              and later_source.projected_event_seq > ${root.projectedEventSeq}
              and ${d.taskSessionMessages.seq} >= later_source.projected_event_seq
          )`,
          d.sql`${d.taskSessionMessages.id} is distinct from (
            select source.terminal_session_message_id from ${d.taskCommentProjectionSources} source where source.comment_id = ${root.id} and source.company_id = ${root.companyId} and source.task_id = ${root.taskId} limit 1
          )`,
        ]
      : null;
    const [descendantRows, assistantRows, replyCountRow, runSegmentCountRow] = await Promise.all([
      db
        .select()
        .from(d.taskComments)
        .where(d.and(...descendantConditions))
        .orderBy(d.asc(d.taskComments.projectedEventSeq), d.asc(d.taskComments.id))
        .limit(limit + 1),
      messageConditions
        ? db
            .select()
            .from(d.taskSessionMessages)
            .where(d.and(...messageConditions))
            .orderBy(d.asc(d.taskSessionMessages.seq), d.asc(d.taskSessionMessages.id))
            .limit(limit + 1)
        : Promise.resolve([]),
      db
        .select({ count: d.sql<number>`count(*)::int` })
        .from(d.taskComments)
        .where(
          d.and(
            d.eq(d.taskComments.companyId, root.companyId),
            d.eq(d.taskComments.taskId, root.taskId),
            d.eq(d.taskComments.threadRootCommentId, root.id),
          ),
        )
        .then((rows) => rows[0] ?? { count: 0 }),
      root.runId
        ? db
            .select({ count: d.sql<number>`count(*)::int` })
            .from(d.taskSessionMessages)
            .where(
              d.and(
                d.eq(d.taskSessionMessages.companyId, root.companyId),
                d.eq(d.taskSessionMessages.taskId, root.taskId),
                d.eq(d.taskSessionMessages.sessionId, root.sessionId),
                d.eq(d.taskSessionMessages.runId, root.runId),
                d.eq(d.taskSessionMessages.type, "assistant" as const),
                d.sql`${d.taskSessionMessages.id} is distinct from (
                    select source.terminal_session_message_id from ${d.taskCommentProjectionSources} source where source.comment_id = ${root.id} and source.company_id = ${root.companyId} and source.task_id = ${root.taskId}
                    limit 1 )`,
              ),
            )
            .then((rows) => rows[0] ?? { count: 0 })
        : Promise.resolve({ count: 0 }),
    ]);
    const parentIds = [
      ...new Set(
        descendantRows
          .map((comment) => comment.replyToCommentId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const parentRows =
      parentIds.length > 0
        ? await db
            .select()
            .from(d.taskComments)
            .where(
              d.and(
                d.eq(d.taskComments.companyId, root.companyId),
                d.eq(d.taskComments.taskId, root.taskId),
                d.inArray(d.taskComments.id, parentIds),
              ),
            )
        : [];
    const parents = new Map(parentRows.map((comment) => [comment.id, comment]));
    const labels = await loadBoardAuthorLabels(
      [...descendantRows, ...parentRows],
      assistantRows.map((message) => message.agentId),
    );
    const runStatuses = await loadRunStatuses([
      root.runId,
      ...descendantRows.map((comment) => comment.runId),
      ...parentRows.map((comment) => comment.runId),
    ]);
    const { censorUsernameInLogs } = await instanceSettings.getGeneral();
    const entries: d.BoardTaskThreadEntry[] = [
      ...descendantRows.map((comment) => ({
        kind: "comment" as const,
        ...projectBoardTaskComment({
          comment,
          parent: comment.replyToCommentId ? (parents.get(comment.replyToCommentId) ?? null) : null,
          labels,
          censorUsernameInLogs,
          runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
        }),
      })),
      ...assistantRows.map((message) =>
        projectBoardRunSegment({ message, labels, censorUsernameInLogs }),
      ),
    ]
      .filter((entry) => taskShared.isAfterBoardCommentCursor(entry, cursor))
      .sort(taskShared.compareCanonicalEntry);
    const pageEntries = entries.slice(0, limit);
    const finalEntry = pageEntries.at(-1);
    return {
      entries: pageEntries,
      nextCursor:
        entries.length > limit && finalEntry
          ? taskShared.encodeBoardCommentCursor({
              version: 1,
              kind: "thread",
              taskId: root.taskId,
              rootCommentId: root.id,
              sequence: finalEntry.canonicalSequence,
              id: finalEntry.id,
            })
          : null,
      replyCount: Number(replyCountRow.count),
      runSegmentCount: Number(runSegmentCountRow.count),
    };
  }
  return { loadBoardCommentThreadPage };
}

export function taskServiceOperations(context: ReturnType<typeof taskShared.taskServiceContext>) {
  const projections = createTaskServiceProjectionOperations(context);
  return {
    ...projections,
    ...createTaskServiceThreadPageOperations(context, projections),
    ...createTaskServiceThreadPagesOperations(context, projections),
    ...createTaskServiceRelationOperations(context),
  };
}

export type TaskServiceOperationsResult = ReturnType<typeof taskServiceOperations>;
