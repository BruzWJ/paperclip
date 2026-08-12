import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  taskApprovals,
  taskComments,
  taskExecutionAuthorities,
  tasks,
} from "@paperclipai/db";
import { visibleTaskCondition } from "./task-visibility.js";

import type {
  TimelineActorType,
  WorkTimelineActor,
  WorkTimelineSpan,
  WorkTimelineEvent,
  WorkTimelineEdge,
  WorkTimelineResult,
} from "@paperclipai/shared";
import {
  listTaskExecutionRunsForActivity,
  listTaskExecutionRunsForWorkTimeline,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
} from "./task-execution-run-service.js";

export interface WorkTimelineQuery {
  companyId: string;
  from?: Date;
  to?: Date;
  userId?: string;
  goalId?: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  offset?: number;
  canReadTask?: (task: WorkTimelineTaskAccessInput) => Promise<boolean>;
}

export interface WorkTimelineTaskAccessInput {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  boardPresentationStatus: string;
}

type TaskRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  taskNumber: number;
  identifier: string;
  title: string | null;
  creatorKind: string | null;
  creatorAgentId: string | null;
  creatorUserId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  boardPresentationStatus: string;
  createdAt: Date;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_ROWS = 5_000;
const ACL_FILTER_CONCURRENCY = 16;

function actorId(type: TimelineActorType, id: string) {
  return `${type}:${id}`;
}

function normalizeLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function normalizeOffset(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

export function normalizeTimelineWindow(input: { from?: Date; to?: Date }, now = new Date()) {
  const rawTo = input.to ?? now;
  const to = rawTo.getTime() > now.getTime() ? now : rawTo;
  const requestedFrom = input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  let from = requestedFrom;
  let capped = false;
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    from = new Date(to.getTime() - MAX_WINDOW_MS);
    capped = true;
  }
  if (from.getTime() > to.getTime()) {
    from = new Date(to.getTime() - DEFAULT_WINDOW_MS);
    capped = true;
  }
  return { from, to, capped };
}

function dateIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : null;
}

function maybeUuidList(ids: Iterable<string>) {
  return Array.from(new Set(Array.from(ids).filter((id) => id.length > 0)));
}

function runOverlapsWindow(
  run: TaskExecutionRunEnvelope,
  from: Date,
  to: Date,
) {
  const startedAt = run.startedAt ?? run.createdAt;
  const finishedAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return startedAt <= to && finishedAt >= from;
}

export function workTimelineService(db: Db) {
  async function listCompanyRunsInWindow(
    companyId: string,
    from: Date,
    to: Date,
    maximum: number,
  ) {
    const runs: TaskExecutionRunEnvelope[] = [];
    let cursor: TaskExecutionRunListCursor | null = null;
    do {
      const page = await listTaskExecutionRunsForActivity(db, {
        companyId,
        cursor,
        limit: 200,
      });
      for (const run of page.items) {
        if (runOverlapsWindow(run, from, to)) runs.push(run);
        if (runs.length === maximum) return runs;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }

  async function listTaskRunsInWindow(
    companyId: string,
    taskId: string,
    from: Date,
    to: Date,
  ) {
    const runs: TaskExecutionRunEnvelope[] = [];
    let cursor: TaskExecutionRunListCursor | null = null;
    do {
      const page = await listTaskExecutionRunsForWorkTimeline(db, {
        companyId,
        taskId,
        cursor,
        limit: 200,
      });
      runs.push(...page.items.filter((run) => runOverlapsWindow(run, from, to)));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }

  async function filterReadableTasks(
    rows: TaskRow[],
    canReadTask: NonNullable<WorkTimelineQuery["canReadTask"]> | undefined,
  ) {
    if (!canReadTask) return rows;

    const allowedRows: TaskRow[] = [];
    for (let index = 0; index < rows.length; index += ACL_FILTER_CONCURRENCY) {
      const batch = rows.slice(index, index + ACL_FILTER_CONCURRENCY);
      const decisions = await Promise.all(batch.map(async (task) => ({
        task,
        allowed: await canReadTask({
          id: task.id,
          companyId: task.companyId,
          projectId: task.projectId,
          parentId: task.parentId,
          ownerAgentId: task.ownerAgentId,
          ownerUserId: task.ownerUserId,
          boardPresentationStatus: task.boardPresentationStatus,
        }),
      })));
      for (const decision of decisions) {
        if (decision.allowed) allowedRows.push(decision.task);
      }
    }
    return allowedRows;
  }

  async function collectTaskIds(input: WorkTimelineQuery, from: Date, to: Date) {
    const ids = new Set<string>();

    if (input.taskId) {
      ids.add(input.taskId);
    }

    const filterConditions = [
      eq(tasks.companyId, input.companyId),
      visibleTaskCondition(),
      input.goalId ? eq(tasks.goalId, input.goalId) : undefined,
      input.projectId ? eq(tasks.projectId, input.projectId) : undefined,
      input.taskId ? eq(tasks.id, input.taskId) : undefined,
    ].filter(Boolean);

    const recentlyTouched = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          ...filterConditions,
          or(
            and(gte(tasks.createdAt, from), lte(tasks.createdAt, to)),
            and(gte(tasks.updatedAt, from), lte(tasks.updatedAt, to)),
          ),
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of recentlyTouched) ids.add(row.id);

    const runRows = await listCompanyRunsInWindow(
      input.companyId,
      from,
      to,
      MAX_SOURCE_ROWS,
    );
    for (const row of runRows) {
      ids.add(row.taskId);
    }

    const activityTaskRows = await db
      .select({ taskId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "task"),
          gte(activityLog.createdAt, from),
          lte(activityLog.createdAt, to),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of activityTaskRows) ids.add(row.taskId);

    const commentTaskRows = await db
      .select({ taskId: taskComments.taskId })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.companyId, input.companyId),
          gte(taskComments.createdAt, from),
          lte(taskComments.createdAt, to),
        ),
      )
      .orderBy(desc(taskComments.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of commentTaskRows) ids.add(row.taskId);

    const approvalTaskRows = await db
      .select({ taskId: taskApprovals.taskId })
      .from(taskApprovals)
      .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(taskApprovals.companyId, input.companyId),
          or(
            and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
            and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of approvalTaskRows) ids.add(row.taskId);

    return maybeUuidList(ids);
  }

  async function loadTasks(input: WorkTimelineQuery, taskIds: string[]) {
    if (taskIds.length === 0) return [];
    return db
      .select({
        id: tasks.id,
        companyId: tasks.companyId,
        projectId: tasks.projectId,
        goalId: tasks.goalId,
        parentId: tasks.parentId,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        creatorKind: tasks.creatorKind,
        creatorAgentId: taskExecutionAuthorities.agentId,
        creatorUserId: tasks.creatorUserId,
        ownerAgentId: tasks.ownerAgentId,
        ownerUserId: tasks.ownerUserId,
        boardPresentationStatus: tasks.boardPresentationStatus,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .leftJoin(
        taskExecutionAuthorities,
        eq(taskExecutionAuthorities.id, tasks.creatorAuthorityId),
      )
      .where(
        and(
          eq(tasks.companyId, input.companyId),
          visibleTaskCondition(),
          inArray(tasks.id, taskIds),
          input.goalId ? eq(tasks.goalId, input.goalId) : undefined,
          input.projectId ? eq(tasks.projectId, input.projectId) : undefined,
          input.taskId ? eq(tasks.id, input.taskId) : undefined,
        ),
      );
  }

  async function applyUserLens(input: WorkTimelineQuery, rows: TaskRow[], from: Date, to: Date) {
    if (!input.userId) return rows;

    const byId = new Map(rows.map((task) => [task.id, task]));
    const selected = new Set<string>();
    for (const task of rows) {
      if (
        (task.creatorKind === "user/board" && task.creatorUserId === input.userId)
        || task.ownerUserId === input.userId
      ) {
        selected.add(task.id);
      }
    }

    const [commentRows, approvalRows, activityRows] = await Promise.all([
      db
        .select({ taskId: taskComments.taskId })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, input.companyId),
            eq(taskComments.authorUserId, input.userId),
            gte(taskComments.createdAt, from),
            lte(taskComments.createdAt, to),
          ),
        ),
      db
        .select({ taskId: taskApprovals.taskId })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, input.companyId),
            eq(approvals.decidedByUserId, input.userId),
            gte(approvals.decidedAt, from),
            lte(approvals.decidedAt, to),
          ),
        ),
      db
        .select({ taskId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, input.userId),
            eq(activityLog.entityType, "task"),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    for (const row of [...commentRows, ...approvalRows, ...activityRows]) {
      selected.add(row.taskId);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const task of rows) {
        if (task.parentId && selected.has(task.parentId) && !selected.has(task.id)) {
          selected.add(task.id);
          changed = true;
        }
      }
    }

    return rows.filter((task) => selected.has(task.id) || byId.get(task.parentId ?? "") && selected.has(task.parentId ?? ""));
  }

  async function loadActorMaps(companyId: string, actorIds: Set<string>) {
    const agentIds = Array.from(actorIds)
      .filter((id) => id.startsWith("agent:"))
      .map((id) => id.slice("agent:".length));
    const userIds = Array.from(actorIds)
      .filter((id) => id.startsWith("user:"))
      .map((id) => id.slice("user:".length));

    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
          .select({ id: agents.id, name: agents.name, icon: agents.icon })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, maybeUuidList(agentIds))))
        : [],
      userIds.length > 0
        ? db
          .select({ id: authUsers.id, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(inArray(authUsers.id, maybeUuidList(userIds)))
        : [],
    ]);

    return {
      agents: new Map(agentRows.map((agent) => [agent.id, agent])),
      users: new Map(userRows.map((user) => [user.id, user])),
    };
  }

  function actorForTaskCreator(task: TaskRow) {
    if (task.creatorKind === "agent-execution" && task.creatorAgentId) {
      return actorId("agent", task.creatorAgentId);
    }
    if (task.creatorKind === "user/board" && task.creatorUserId) {
      return actorId("user", task.creatorUserId);
    }
    return actorId("system", "system");
  }

  function actorForTaskOwner(task: TaskRow) {
    if (task.ownerAgentId) return actorId("agent", task.ownerAgentId);
    if (task.ownerUserId) return actorId("user", task.ownerUserId);
    return null;
  }

  async function getTimeline(input: WorkTimelineQuery): Promise<WorkTimelineResult> {
    const { from, to, capped } = normalizeTimelineWindow(input);
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    const candidateTaskIds = await collectTaskIds(input, from, to);
    const loadedTasks = await loadTasks(input, candidateTaskIds);
    const userScopedTasks = await applyUserLens(input, loadedTasks, from, to);
    const accessibleTasks = await filterReadableTasks(userScopedTasks, input.canReadTask);
    const sortedTasks = accessibleTasks.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const pagedTasks = sortedTasks.slice(offset, offset + limit);
    const taskById = new Map(pagedTasks.map((task) => [task.id, task]));
    const readableTaskIds = Array.from(taskById.keys());

    if (readableTaskIds.length === 0) {
      return {
        actors: [],
        spans: [],
        events: [],
        edges: [],
        pagination: { limit, offset, totalTasks: sortedTasks.length, hasMore: offset + limit < sortedTasks.length },
        window: { from: from.toISOString(), to: to.toISOString(), capped },
      };
    }

    const actorIds = new Set<string>();
    const events: WorkTimelineEvent[] = [];
    const edges: WorkTimelineEdge[] = [];

    for (const task of pagedTasks) {
      const creatorActorId = actorForTaskCreator(task);
      actorIds.add(creatorActorId);
      events.push({
        actorId: creatorActorId,
        kind: "created",
        taskId: task.id,
        at: task.createdAt.toISOString(),
      });

      const ownerActorId = actorForTaskOwner(task);
      if (ownerActorId) {
        actorIds.add(ownerActorId);
        edges.push({
          fromActorId: creatorActorId,
          toActorId: ownerActorId,
          taskId: task.id,
          at: task.createdAt.toISOString(),
          kind: "assignment",
        });
      }

      const parent = task.parentId ? taskById.get(task.parentId) : null;
      const parentActorId = parent ? actorForTaskOwner(parent) ?? actorForTaskCreator(parent) : null;
      if (parentActorId && ownerActorId && parentActorId !== ownerActorId) {
        actorIds.add(parentActorId);
        edges.push({
          fromActorId: parentActorId,
          toActorId: ownerActorId,
          taskId: task.id,
          at: task.createdAt.toISOString(),
          kind: "delegation",
        });
        events.push({
          actorId: parentActorId,
          kind: "delegated",
          taskId: task.id,
          at: task.createdAt.toISOString(),
        });
      }
    }

    const [runRows, commentRows, approvalRows, logRows] = await Promise.all([
      Promise.all(
        readableTaskIds.map((taskId) =>
          listTaskRunsInWindow(input.companyId, taskId, from, to)
        ),
      ).then((pages) => pages.flat()),
      db
        .select({
          taskId: taskComments.taskId,
          authorAgentId: taskComments.authorAgentId,
          authorUserId: taskComments.authorUserId,
          createdAt: taskComments.createdAt,
        })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, input.companyId),
            inArray(taskComments.taskId, readableTaskIds),
            gte(taskComments.createdAt, from),
            lte(taskComments.createdAt, to),
          ),
        ),
      db
        .select({
          taskId: taskApprovals.taskId,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          createdAt: approvals.createdAt,
        })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, input.companyId),
            inArray(taskApprovals.taskId, readableTaskIds),
            or(
              and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
              and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
            ),
          ),
        ),
      db
        .select({
          taskId: activityLog.entityId,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.entityType, "task"),
            inArray(activityLog.entityId, readableTaskIds),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    const spanByRunId = new Map<string, WorkTimelineSpan>();
    for (const row of runRows) {
      if (!taskById.has(row.taskId) || spanByRunId.has(row.runId)) continue;
      const task = taskById.get(row.taskId)!;
      const runActorId = actorId("agent", row.targetAgentId);
      actorIds.add(runActorId);
      spanByRunId.set(row.runId, {
        actorId: runActorId,
        runId: row.runId,
        kind: row.kind,
        taskId: row.taskId,
        taskNumber: task.taskNumber,
        taskIdentifier: task.identifier,
        taskTitle: task.title,
        start: (row.startedAt ?? row.createdAt).toISOString(),
        end: dateIso(row.finishedAt),
        status: row.status,
        retryOfRunId: row.retryOfRunId ?? null,
      });
    }

    for (const row of commentRows) {
      const commentActorId = row.authorAgentId
        ? actorId("agent", row.authorAgentId)
        : row.authorUserId
          ? actorId("user", row.authorUserId)
          : actorId("system", "system");
      actorIds.add(commentActorId);
      events.push({ actorId: commentActorId, kind: "commented", taskId: row.taskId, at: row.createdAt.toISOString() });
    }

    for (const row of approvalRows) {
      const approvalActorId = row.decidedByUserId
        ? actorId("user", row.decidedByUserId)
        : row.requestedByAgentId
          ? actorId("agent", row.requestedByAgentId)
          : row.requestedByUserId
            ? actorId("user", row.requestedByUserId)
            : actorId("system", "system");
      actorIds.add(approvalActorId);
      events.push({
        actorId: approvalActorId,
        kind: "approved",
        taskId: row.taskId,
        at: (row.decidedAt ?? row.createdAt).toISOString(),
      });
    }

    for (const row of logRows) {
      const logActorType = row.actorType === "agent" || row.actorType === "user" || row.actorType === "plugin"
        ? row.actorType
        : "system";
      const fromActorId = actorId(logActorType, row.actorId);
      actorIds.add(fromActorId);
      if (row.action.includes("assign")) {
        events.push({ actorId: fromActorId, kind: "assigned", taskId: row.taskId, at: row.createdAt.toISOString() });
        const details = row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : {};
        const targetAgentId = readString(details.ownerAgentId);
        const targetUserId = readString(details.ownerUserId);
        const toActorId = targetAgentId
          ? actorId("agent", targetAgentId)
          : targetUserId
            ? actorId("user", targetUserId)
            : null;
        if (toActorId) {
          actorIds.add(toActorId);
          edges.push({
            fromActorId,
            toActorId,
            taskId: row.taskId,
            at: row.createdAt.toISOString(),
            kind: "assignment",
          });
        }
      }
    }

    const actorMaps = await loadActorMaps(input.companyId, actorIds);
    const actors: WorkTimelineActor[] = Array.from(actorIds).map((id) => {
      const [type, rawId] = id.split(":", 2) as [TimelineActorType, string];
      if (type === "agent") {
        const agent = actorMaps.agents.get(rawId);
        return { id, type, name: agent?.name ?? "Unknown agent", avatar: agent?.icon ?? null };
      }
      if (type === "user") {
        const user = actorMaps.users.get(rawId);
        return { id, type, name: user?.name ?? rawId, avatar: user?.image ?? null };
      }
      return { id, type, name: type === "plugin" ? rawId : "System", avatar: null };
    });

    return {
      actors,
      spans: Array.from(spanByRunId.values()).sort((left, right) => left.start.localeCompare(right.start)),
      events: events.sort((left, right) => left.at.localeCompare(right.at)),
      edges: edges.sort((left, right) => left.at.localeCompare(right.at)),
      pagination: {
        limit,
        offset,
        totalTasks: sortedTasks.length,
        hasMore: offset + limit < sortedTasks.length,
      },
      window: { from: from.toISOString(), to: to.toISOString(), capped },
    };
  }

  return { getTimeline };
}
