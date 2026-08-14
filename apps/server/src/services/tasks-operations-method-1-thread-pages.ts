import * as d from "./tasks-dependencies.js";

import { createTaskServiceProjectionOperations } from "./tasks-operations-method-1-projections.js";
import {
  compareCanonicalEntry,
  encodeBoardCommentCursor,
  taskServiceContext,
  type TaskCommentRow,
} from "./tasks-shared.js";

export function createTaskServiceThreadPagesOperations(
  context: ReturnType<typeof taskServiceContext>,
  projections: ReturnType<typeof createTaskServiceProjectionOperations>,
) {
  const { db, instanceSettings } = context;
  const { loadBoardAuthorLabels, loadRunStatuses, projectBoardTaskComment, projectBoardRunSegment } =
    projections;
  async function loadBoardCommentThreadPages(
    roots: readonly TaskCommentRow[],
    limit: number,
  ): Promise<
    Map<
      string,
      d.BoardTaskCommentThreadPage & {
        replyCount: number;
        runSegmentCount: number;
      }
    >
  > {
    const pages = new Map<
      string,
      d.BoardTaskCommentThreadPage & {
        replyCount: number;
        runSegmentCount: number;
      }
    >();
    if (roots.length === 0) return pages;
    const rootIds = roots.map((root) => root.id);
    const rootIdSql = d.sql.join(
      rootIds.map((id) => d.sql`${id}::uuid`),
      d.sql`, `,
    );
    type RankedCommentIdentity = {
      rootCommentId: string;
      sourceId: string;
      totalCount: number | string;
    };
    type RankedSegmentIdentity = RankedCommentIdentity & {
      steeringParentCommentId: string | null;
    };
    const [commentIdentityResult, segmentIdentityResult] = await Promise.all([
      db.execute(d.sql<RankedCommentIdentity>`
        select ranked.root_comment_id as "rootCommentId", ranked.source_id as "sourceId", ranked.total_count as "totalCount" from ( select comment_entry.thread_root_comment_id as root_comment_id,
            comment_entry.id as source_id, count(*) over ( partition by comment_entry.thread_root_comment_id ) as total_count, row_number() over ( partition by comment_entry.thread_root_comment_id
              order by comment_entry.projected_event_seq asc, comment_entry.id asc ) as entry_rank from ${d.taskComments} comment_entry where comment_entry.company_id = ${roots[0]!.companyId}
            and comment_entry.task_id = ${roots[0]!.taskId} and comment_entry.thread_root_comment_id in (${rootIdSql}) ) ranked where ranked.entry_rank <= ${limit + 1}
        order by ranked.root_comment_id asc, ranked.entry_rank asc `),
      db.execute(d.sql<RankedSegmentIdentity>` select ranked.root_comment_id as "rootCommentId", ranked.source_id as "sourceId",
          ranked.steering_parent_comment_id as "steeringParentCommentId", ranked.total_count as "totalCount" from ( select root_comment.id as root_comment_id, message_entry.id as source_id, ( select source.comment_id
              from ${d.taskCommentProjectionSources} source where source.company_id = root_comment.company_id and source.task_id = root_comment.task_id and source.session_id = root_comment.session_id
                and source.run_id = root_comment.run_id and source.segment_ordinal is not null and source.projected_event_seq <= message_entry.seq order by source.projected_event_seq desc, source.comment_id desc limit 1
            ) as steering_parent_comment_id, count(*) over (partition by root_comment.id) as total_count, row_number() over ( partition by root_comment.id order by message_entry.seq asc, message_entry.id asc
            ) as entry_rank from ${d.taskComments} root_comment inner join ${d.taskCommentProjectionSources} root_source on root_source.comment_id = root_comment.id and root_source.company_id = root_comment.company_id
           and root_source.task_id = root_comment.task_id inner join ${d.taskSessionMessages} message_entry on message_entry.company_id = root_comment.company_id and message_entry.task_id = root_comment.task_id
           and message_entry.session_id = root_comment.session_id and message_entry.run_id = root_comment.run_id and message_entry.type = 'assistant'
           and message_entry.id is distinct from root_source.terminal_session_message_id where root_comment.company_id = ${roots[0]!.companyId} and root_comment.task_id = ${roots[0]!.taskId}
            and root_comment.id in (${rootIdSql}) and root_comment.run_id is not null ) ranked where ranked.entry_rank <= ${limit + 1} order by ranked.root_comment_id asc, ranked.entry_rank asc `),
    ]);
    const commentIdentities = Array.from(commentIdentityResult) as RankedCommentIdentity[];
    const segmentIdentities = Array.from(segmentIdentityResult) as RankedSegmentIdentity[];
    const commentIds = commentIdentities.map((row) => row.sourceId);
    const messageIds = segmentIdentities.map((row) => row.sourceId);
    const [descendantRows, assistantMessages] = await Promise.all([
      commentIds.length > 0
        ? db
            .select()
            .from(d.taskComments)
            .where(
              d.and(
                d.eq(d.taskComments.companyId, roots[0]!.companyId),
                d.eq(d.taskComments.taskId, roots[0]!.taskId),
                d.inArray(d.taskComments.id, commentIds),
              ),
            )
        : Promise.resolve([]),
      messageIds.length > 0
        ? db
            .select()
            .from(d.taskSessionMessages)
            .where(
              d.and(
                d.eq(d.taskSessionMessages.companyId, roots[0]!.companyId),
                d.eq(d.taskSessionMessages.taskId, roots[0]!.taskId),
                d.inArray(d.taskSessionMessages.id, messageIds),
              ),
            )
        : Promise.resolve([]),
    ]);
    const descendantsById = new Map(descendantRows.map((row) => [row.id, row]));
    const messagesById = new Map(assistantMessages.map((row) => [row.id, row]));
    const rootsById = new Map(roots.map((root) => [root.id, root]));
    const segmentIdentityByMessageId = new Map(segmentIdentities.map((row) => [row.sourceId, row]));
    const parentIds = [
      ...new Set(
        [
          ...descendantRows.map((comment) => comment.replyToCommentId),
          ...segmentIdentities.map((row) => row.steeringParentCommentId ?? row.rootCommentId),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const missingParentIds = parentIds.filter((id) => !rootsById.has(id));
    const parentRows =
      missingParentIds.length > 0
        ? await db
            .select()
            .from(d.taskComments)
            .where(
              d.and(
                d.eq(d.taskComments.companyId, roots[0]!.companyId),
                d.eq(d.taskComments.taskId, roots[0]!.taskId),
                d.inArray(d.taskComments.id, missingParentIds),
              ),
            )
        : [];
    const parents = new Map([
      ...roots.map((root) => [root.id, root] as const),
      ...parentRows.map((parent) => [parent.id, parent] as const),
    ]);
    const [labels, runStatuses, general] = await Promise.all([
      loadBoardAuthorLabels(
        [...roots, ...descendantRows, ...parentRows],
        assistantMessages.map((message) => message.agentId),
      ),
      loadRunStatuses([
        ...roots.map((root) => root.runId),
        ...descendantRows.map((comment) => comment.runId),
        ...parentRows.map((comment) => comment.runId),
      ]),
      instanceSettings.getGeneral(),
    ]);
    const commentsByRoot = new Map<string, TaskCommentRow[]>();
    for (const identity of commentIdentities) {
      const comment = descendantsById.get(identity.sourceId);
      if (!comment) continue;
      const entries = commentsByRoot.get(identity.rootCommentId) ?? [];
      entries.push(comment);
      commentsByRoot.set(identity.rootCommentId, entries);
    }
    const messagesByRoot = new Map<string, typeof assistantMessages>();
    for (const identity of segmentIdentities) {
      const message = messagesById.get(identity.sourceId);
      if (!message) continue;
      const entries = messagesByRoot.get(identity.rootCommentId) ?? [];
      entries.push(message);
      messagesByRoot.set(identity.rootCommentId, entries);
    }
    const countValue = (value: number | string | undefined): number => {
      const count = typeof value === "number" ? value : Number(value ?? 0);
      return Number.isSafeInteger(count) && count >= 0 ? count : 0;
    };
    for (const root of roots) {
      const commentEntries = (commentsByRoot.get(root.id) ?? []).map((comment) => ({
        kind: "comment" as const,
        ...projectBoardTaskComment({
          comment,
          parent: comment.replyToCommentId ? (parents.get(comment.replyToCommentId) ?? null) : null,
          labels,
          censorUsernameInLogs: general.censorUsernameInLogs,
          runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
          parentRunStatus: comment.replyToCommentId
            ? runStatuses.get(parents.get(comment.replyToCommentId)?.runId ?? "")
            : null,
        }),
      }));
      const segmentEntries = (messagesByRoot.get(root.id) ?? []).map((message) => {
        const identity = segmentIdentityByMessageId.get(message.id);
        const parent = parents.get(identity?.steeringParentCommentId ?? root.id) ?? root;
        return projectBoardRunSegment({
          message,
          parent,
          labels,
          censorUsernameInLogs: general.censorUsernameInLogs,
          parentRunStatus: parent.runId ? runStatuses.get(parent.runId) : null,
        });
      });
      const merged = [...commentEntries, ...segmentEntries].sort(compareCanonicalEntry);
      const entries = merged.slice(0, limit);
      const finalEntry = entries.at(-1);
      pages.set(root.id, {
        entries,
        nextCursor:
          merged.length > limit && finalEntry
            ? encodeBoardCommentCursor({
                version: 1,
                kind: "thread",
                taskId: root.taskId,
                rootCommentId: root.id,
                sequence: finalEntry.canonicalSequence,
                id: finalEntry.id,
              })
            : null,
        replyCount: countValue(commentIdentities.find((row) => row.rootCommentId === root.id)?.totalCount),
        runSegmentCount: countValue(
          segmentIdentities.find((row) => row.rootCommentId === root.id)?.totalCount,
        ),
      });
    }
    return pages;
  }

  async function getBoardCommentProjection(input: {
    companyId: string;
    taskId: string;
    commentId: string;
  }): Promise<d.BoardTaskComment | null> {
    if (
      !d.isCanonicalUuid(input.companyId) ||
      !d.isCanonicalUuid(input.taskId) ||
      !d.isCanonicalUuid(input.commentId)
    ) {
      return null;
    }
    const comment = await db
      .select()
      .from(d.taskComments)
      .where(
        d.and(
          d.eq(d.taskComments.companyId, input.companyId),
          d.eq(d.taskComments.taskId, input.taskId),
          d.eq(d.taskComments.id, input.commentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) return null;
    const parent = comment.replyToCommentId
      ? await db
          .select()
          .from(d.taskComments)
          .where(
            d.and(
              d.eq(d.taskComments.companyId, input.companyId),
              d.eq(d.taskComments.taskId, input.taskId),
              d.eq(d.taskComments.id, comment.replyToCommentId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const [labels, runStatuses, general] = await Promise.all([
      loadBoardAuthorLabels(parent ? [comment, parent] : [comment]),
      loadRunStatuses([comment.runId, parent?.runId ?? null]),
      instanceSettings.getGeneral(),
    ]);
    return projectBoardTaskComment({
      comment,
      parent,
      labels,
      censorUsernameInLogs: general.censorUsernameInLogs,
      runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
      parentRunStatus: parent?.runId ? runStatuses.get(parent.runId) : null,
    });
  }
  return { loadBoardCommentThreadPages, getBoardCommentProjection };
}
