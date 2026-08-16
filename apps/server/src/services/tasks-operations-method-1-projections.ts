import * as d from "./tasks-dependencies.js";

import {
  boardRunState,
  taskServiceContext,
  withTaskLabels,
  type BoardAuthorLabels,
  type TaskCommentRow,
} from "./tasks-shared.js";

export function createTaskServiceProjectionOperations(context: ReturnType<typeof taskServiceContext>) {
  const { db } = context;
  async function getTaskByUuid(id: string) {
    const row = await db
      .select()
      .from(d.tasks)
      .where(d.eq(d.tasks.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  async function getTaskByCompanyTaskNumber(companyId: string, taskNumber: number) {
    if (!d.isCanonicalUuid(companyId) || !d.isCanonicalTaskNumber(taskNumber)) {
      return null;
    }
    const rows = await db
      .select()
      .from(d.tasks)
      .where(d.and(d.eq(d.tasks.companyId, companyId), d.eq(d.tasks.taskNumber, taskNumber)))
      .limit(2);
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error("Task number is not unique within its company");
    }
    const row = rows[0]!;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  function redactTaskComment<
    T extends {
      body: string;
      authorType: d.TaskCommentAuthorType;
      presentation?: unknown;
      metadata?: unknown;
    },
  >(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    presentation: d.TaskCommentPresentation | null;
    metadata: d.TaskCommentMetadata | null;
  } {
    return {
      ...comment,
      body: d.redactCurrentUserText(comment.body, {
        enabled: censorUsernameInLogs,
      }),
      presentation: d.taskCommentPresentationSchema
        .nullable()
        .catch(null)
        .parse(comment.presentation ?? null),
      metadata: d.taskCommentMetadataSchema
        .nullable()
        .catch(null)
        .parse(comment.metadata ?? null),
    };
  }

  async function loadBoardAuthorLabels(
    comments: readonly Pick<TaskCommentRow, "authorAgentId" | "authorUserId">[],
    extraAgentIds: readonly (string | null)[] = [],
  ): Promise<BoardAuthorLabels> {
    const agentIds = [
      ...new Set(
        [...comments.map((comment) => comment.authorAgentId), ...extraAgentIds].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    const userIds = [
      ...new Set(
        comments.map((comment) => comment.authorUserId).filter((value): value is string => Boolean(value)),
      ),
    ];
    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
            .select({ id: d.agents.id, name: d.agents.name })
            .from(d.agents)
            .where(d.inArray(d.agents.id, agentIds))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({ id: d.authUsers.id, name: d.authUsers.name })
            .from(d.authUsers)
            .where(d.inArray(d.authUsers.id, userIds))
        : Promise.resolve([]),
    ]);
    return {
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
      users: new Map(userRows.map((row) => [row.id, row.name])),
    };
  }

  function boardCommentAuthor(
    comment: Pick<TaskCommentRow, "authorType" | "authorAgentId" | "authorUserId" | "authorPluginKey">,
    labels: BoardAuthorLabels,
  ): d.BoardTaskCommentAuthor {
    const label =
      comment.authorType === "agent"
        ? (labels.agents.get(comment.authorAgentId ?? "") ?? "Agent")
        : comment.authorType === "user"
          ? (labels.users.get(comment.authorUserId ?? "") ?? "User")
          : comment.authorType === "plugin"
            ? (comment.authorPluginKey ?? "Plugin")
            : "Paperclip";
    return {
      type: comment.authorType,
      label,
      agentId: comment.authorAgentId,
      userId: comment.authorUserId,
      pluginKey: comment.authorPluginKey,
    };
  }

  function boardCommentExcerpt(body: string): string {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
  }

  function boardCommentParentReference(
    parent: TaskCommentRow | null,
    labels: BoardAuthorLabels,
    censorUsernameInLogs: boolean,
  ): d.BoardTaskCommentParentReference | null {
    if (!parent) return null;
    const author = boardCommentAuthor(parent, labels);
    const body = d.redactCurrentUserText(parent.body, {
      enabled: censorUsernameInLogs,
    });
    return {
      authorLabel: author.label,
      excerpt: boardCommentExcerpt(body),
    };
  }

  function projectBoardTaskComment(input: {
    comment: TaskCommentRow;
    parent: TaskCommentRow | null;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
    runStatus?: d.TaskExecutionRunStatus | null;
  }): d.BoardTaskComment {
    const redacted = redactTaskComment(input.comment, input.censorUsernameInLogs);
    return {
      id: redacted.id,
      author: boardCommentAuthor(redacted, input.labels),
      body: redacted.body,
      presentation: redacted.presentation,
      metadata: redacted.metadata,
      sourceTrust: redacted.sourceTrust ?? null,
      runState: boardRunState(input.runStatus),
      canonicalSequence: redacted.projectedEventSeq,
      immediateParentDisplayReference: boardCommentParentReference(
        input.parent,
        input.labels,
        input.censorUsernameInLogs,
      ),
      createdAt: redacted.createdAt,
      updatedAt: redacted.updatedAt,
    };
  }

  function projectBoardRunSegment(input: {
    message: typeof d.taskSessionMessages.$inferSelect;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
  }): d.BoardTaskRunSegmentEntry {
    const data =
      input.message.data && typeof input.message.data === "object"
        ? (input.message.data as Record<string, unknown>)
        : {};
    const content = Array.isArray(data.content) ? data.content : [];
    const parts: d.BoardTaskRunSegmentPart[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part = raw as Record<string, unknown>;
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        parts.push({
          type: part.type,
          text: d.redactCurrentUserText(part.text, {
            enabled: input.censorUsernameInLogs,
          }),
        });
        continue;
      }
      if (part.type !== "tool" || typeof part.name !== "string") continue;
      const state =
        part.state && typeof part.state === "object" && !Array.isArray(part.state)
          ? (part.state as Record<string, unknown>)
          : null;
      const status = state?.status;
      if (status === "pending" || status === "running" || status === "completed" || status === "error") {
        parts.push({ type: "tool", name: part.name, status });
      }
    }
    const time =
      data.time && typeof data.time === "object" && !Array.isArray(data.time)
        ? (data.time as Record<string, unknown>)
        : null;
    const complete = typeof time?.completed === "number";
    const hasError = Boolean(data.error) || data.finish === "error";
    const author: d.BoardTaskCommentAuthor = {
      type: "agent",
      label: input.message.agentId ? (input.labels.agents.get(input.message.agentId) ?? "Agent") : "Agent",
      agentId: input.message.agentId,
      userId: null,
      pluginKey: null,
    };
    const id = `segment_${d.createHash("sha256").update(`board-run-segment/v1\u0000${input.message.companyId}\u0000${input.message.taskId}\u0000${input.message.id}`).digest("hex").slice(0, 32)}`;
    return {
      kind: "run_segment",
      id,
      author,
      parts,
      status: hasError ? "error" : complete ? "complete" : "working",
      canonicalSequence: input.message.seq,
      createdAt: input.message.timeCreated,
      updatedAt: input.message.timeUpdated,
    };
  }

  async function loadRunStatuses(
    runIds: readonly (string | null)[],
  ): Promise<Map<string, d.TaskExecutionRunStatus>> {
    const ids = [...new Set(runIds.filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return new Map();
    const runs = await Promise.all(
      ids.map(async (runId) => {
        const identity = await d.resolveTaskExecutionRunIdentityById(db, runId);
        if (!identity) return null;
        return d.readTaskExecutionRun(db, identity);
      }),
    );
    return new Map(runs.filter((run) => run !== null).map((run) => [run.runId, run.status]));
  }
  return {
    getTaskByUuid,
    getTaskByCompanyTaskNumber,
    redactTaskComment,
    loadBoardAuthorLabels,
    boardCommentAuthor,
    boardCommentExcerpt,
    boardCommentParentReference,
    projectBoardTaskComment,
    projectBoardRunSegment,
    loadRunStatuses,
  };
}
