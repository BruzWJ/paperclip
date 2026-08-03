import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  issueApprovals,
  issueComments,
  issueExecutionAuthorities,
  issues,
} from "@paperclipai/db";
import { visibleIssueCondition } from "./issue-visibility.js";

// DTO types are shared with the UI via @paperclipai/shared so both sides consume
// one contract. Re-exported here for back-compat with existing server imports.
import type {
  TimelineActorType,
  WorkTimelineActor,
  WorkTimelineSpan,
  WorkTimelineEvent,
  WorkTimelineEdge,
  WorkTimelineResult,
} from "@paperclipai/shared";
import {
  listIssueExecutionRunsForActivity,
  listIssueExecutionRunsForWorkTimeline,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunListCursor,
} from "./issue-execution-run-service.js";

export type {
  TimelineActorType,
  TimelineEventKind,
  TimelineEdgeKind,
  WorkTimelineActor,
  WorkTimelineSpan,
  WorkTimelineEvent,
  WorkTimelineEdge,
  WorkTimelineResult,
} from "@paperclipai/shared";

export interface WorkTimelineQuery {
  companyId: string;
  from?: Date;
  to?: Date;
  userId?: string;
  goalId?: string;
  projectId?: string;
  issueId?: string;
  limit?: number;
  offset?: number;
  canReadIssue?: (issue: WorkTimelineIssueAccessInput) => Promise<boolean>;
}

export interface WorkTimelineIssueAccessInput {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  boardPresentationStatus: string;
}

type IssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  identifier: string | null;
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function maybeUuidList(ids: Iterable<string>) {
  return Array.from(new Set(Array.from(ids).filter((id) => id.length > 0)));
}

function runOverlapsWindow(
  run: IssueExecutionRunEnvelope,
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
    const runs: IssueExecutionRunEnvelope[] = [];
    let cursor: IssueExecutionRunListCursor | null = null;
    do {
      const page = await listIssueExecutionRunsForActivity(db, {
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

  async function listIssueRunsInWindow(
    companyId: string,
    issueId: string,
    from: Date,
    to: Date,
  ) {
    const runs: IssueExecutionRunEnvelope[] = [];
    let cursor: IssueExecutionRunListCursor | null = null;
    do {
      const page = await listIssueExecutionRunsForWorkTimeline(db, {
        companyId,
        issueId,
        cursor,
        limit: 200,
      });
      runs.push(...page.items.filter((run) => runOverlapsWindow(run, from, to)));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }

  async function filterReadableIssues(
    rows: IssueRow[],
    canReadIssue: NonNullable<WorkTimelineQuery["canReadIssue"]> | undefined,
  ) {
    if (!canReadIssue) return rows;

    const allowedRows: IssueRow[] = [];
    for (let index = 0; index < rows.length; index += ACL_FILTER_CONCURRENCY) {
      const batch = rows.slice(index, index + ACL_FILTER_CONCURRENCY);
      const decisions = await Promise.all(batch.map(async (issue) => ({
        issue,
        allowed: await canReadIssue({
          id: issue.id,
          companyId: issue.companyId,
          projectId: issue.projectId,
          parentId: issue.parentId,
          ownerAgentId: issue.ownerAgentId,
          ownerUserId: issue.ownerUserId,
          boardPresentationStatus: issue.boardPresentationStatus,
        }),
      })));
      for (const decision of decisions) {
        if (decision.allowed) allowedRows.push(decision.issue);
      }
    }
    return allowedRows;
  }

  async function collectIssueIds(input: WorkTimelineQuery, from: Date, to: Date) {
    const ids = new Set<string>();

    if (input.issueId) {
      ids.add(input.issueId);
    }

    const filterConditions = [
      eq(issues.companyId, input.companyId),
      visibleIssueCondition(),
      input.goalId ? eq(issues.goalId, input.goalId) : undefined,
      input.projectId ? eq(issues.projectId, input.projectId) : undefined,
      input.issueId ? eq(issues.id, input.issueId) : undefined,
    ].filter(Boolean);

    const recentlyTouched = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          ...filterConditions,
          or(
            and(gte(issues.createdAt, from), lte(issues.createdAt, to)),
            and(gte(issues.updatedAt, from), lte(issues.updatedAt, to)),
          ),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of recentlyTouched) ids.add(row.id);

    const runRows = await listCompanyRunsInWindow(
      input.companyId,
      from,
      to,
      MAX_SOURCE_ROWS,
    );
    for (const row of runRows) {
      ids.add(row.issueId);
    }

    const activityIssueRows = await db
      .select({ issueId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          gte(activityLog.createdAt, from),
          lte(activityLog.createdAt, to),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of activityIssueRows) ids.add(row.issueId);

    const commentIssueRows = await db
      .select({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          gte(issueComments.createdAt, from),
          lte(issueComments.createdAt, to),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of commentIssueRows) ids.add(row.issueId);

    const approvalIssueRows = await db
      .select({ issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          or(
            and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
            and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of approvalIssueRows) ids.add(row.issueId);

    return maybeUuidList(ids);
  }

  async function loadIssues(input: WorkTimelineQuery, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        identifier: issues.identifier,
        title: issues.title,
        creatorKind: issues.creatorKind,
        creatorAgentId: issueExecutionAuthorities.agentId,
        creatorUserId: issues.creatorUserId,
        ownerAgentId: issues.ownerAgentId,
        ownerUserId: issues.ownerUserId,
        boardPresentationStatus: issues.boardPresentationStatus,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .leftJoin(
        issueExecutionAuthorities,
        eq(issueExecutionAuthorities.id, issues.creatorAuthorityId),
      )
      .where(
        and(
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
          inArray(issues.id, issueIds),
          input.goalId ? eq(issues.goalId, input.goalId) : undefined,
          input.projectId ? eq(issues.projectId, input.projectId) : undefined,
          input.issueId ? eq(issues.id, input.issueId) : undefined,
        ),
      );
  }

  async function applyUserLens(input: WorkTimelineQuery, rows: IssueRow[], from: Date, to: Date) {
    if (!input.userId) return rows;

    const byId = new Map(rows.map((issue) => [issue.id, issue]));
    const selected = new Set<string>();
    for (const issue of rows) {
      if (
        (issue.creatorKind === "user/board" && issue.creatorUserId === input.userId)
        || issue.ownerUserId === input.userId
      ) {
        selected.add(issue.id);
      }
    }

    const [commentRows, approvalRows, activityRows] = await Promise.all([
      db
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.authorUserId, input.userId),
            gte(issueComments.createdAt, from),
            lte(issueComments.createdAt, to),
          ),
        ),
      db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, input.companyId),
            eq(approvals.decidedByUserId, input.userId),
            gte(approvals.decidedAt, from),
            lte(approvals.decidedAt, to),
          ),
        ),
      db
        .select({ issueId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, input.userId),
            eq(activityLog.entityType, "issue"),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    for (const row of [...commentRows, ...approvalRows, ...activityRows]) {
      selected.add(row.issueId);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const issue of rows) {
        if (issue.parentId && selected.has(issue.parentId) && !selected.has(issue.id)) {
          selected.add(issue.id);
          changed = true;
        }
      }
    }

    return rows.filter((issue) => selected.has(issue.id) || byId.get(issue.parentId ?? "") && selected.has(issue.parentId ?? ""));
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

  function actorForIssueCreator(issue: IssueRow) {
    if (issue.creatorKind === "agent-execution" && issue.creatorAgentId) {
      return actorId("agent", issue.creatorAgentId);
    }
    if (issue.creatorKind === "user/board" && issue.creatorUserId) {
      return actorId("user", issue.creatorUserId);
    }
    return actorId("system", "system");
  }

  function actorForIssueOwner(issue: IssueRow) {
    if (issue.ownerAgentId) return actorId("agent", issue.ownerAgentId);
    if (issue.ownerUserId) return actorId("user", issue.ownerUserId);
    return null;
  }

  async function getTimeline(input: WorkTimelineQuery): Promise<WorkTimelineResult> {
    const { from, to, capped } = normalizeTimelineWindow(input);
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    const candidateIssueIds = await collectIssueIds(input, from, to);
    const loadedIssues = await loadIssues(input, candidateIssueIds);
    const userScopedIssues = await applyUserLens(input, loadedIssues, from, to);
    const accessibleIssues = await filterReadableIssues(userScopedIssues, input.canReadIssue);
    const sortedIssues = accessibleIssues.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const pagedIssues = sortedIssues.slice(offset, offset + limit);
    const issueById = new Map(pagedIssues.map((issue) => [issue.id, issue]));
    const readableIssueIds = Array.from(issueById.keys());

    if (readableIssueIds.length === 0) {
      return {
        actors: [],
        spans: [],
        events: [],
        edges: [],
        pagination: { limit, offset, totalIssues: sortedIssues.length, hasMore: offset + limit < sortedIssues.length },
        window: { from: from.toISOString(), to: to.toISOString(), capped },
      };
    }

    const actorIds = new Set<string>();
    const events: WorkTimelineEvent[] = [];
    const edges: WorkTimelineEdge[] = [];

    for (const issue of pagedIssues) {
      const creatorActorId = actorForIssueCreator(issue);
      actorIds.add(creatorActorId);
      events.push({
        actorId: creatorActorId,
        kind: "created",
        issueId: issue.id,
        at: issue.createdAt.toISOString(),
      });

      const ownerActorId = actorForIssueOwner(issue);
      if (ownerActorId) {
        actorIds.add(ownerActorId);
        edges.push({
          fromActorId: creatorActorId,
          toActorId: ownerActorId,
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
          kind: "assignment",
        });
      }

      const parent = issue.parentId ? issueById.get(issue.parentId) : null;
      const parentActorId = parent ? actorForIssueOwner(parent) ?? actorForIssueCreator(parent) : null;
      if (parentActorId && ownerActorId && parentActorId !== ownerActorId) {
        actorIds.add(parentActorId);
        edges.push({
          fromActorId: parentActorId,
          toActorId: ownerActorId,
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
          kind: "delegation",
        });
        events.push({
          actorId: parentActorId,
          kind: "delegated",
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
        });
      }
    }

    const [runRows, commentRows, approvalRows, logRows] = await Promise.all([
      Promise.all(
        readableIssueIds.map((issueId) =>
          listIssueRunsInWindow(input.companyId, issueId, from, to)
        ),
      ).then((pages) => pages.flat()),
      db
        .select({
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, input.companyId),
            inArray(issueComments.issueId, readableIssueIds),
            gte(issueComments.createdAt, from),
            lte(issueComments.createdAt, to),
          ),
        ),
      db
        .select({
          issueId: issueApprovals.issueId,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          createdAt: approvals.createdAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, input.companyId),
            inArray(issueApprovals.issueId, readableIssueIds),
            or(
              and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
              and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
            ),
          ),
        ),
      db
        .select({
          issueId: activityLog.entityId,
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
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, readableIssueIds),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    const spanByRunId = new Map<string, WorkTimelineSpan>();
    for (const row of runRows) {
      if (!issueById.has(row.issueId) || spanByRunId.has(row.runId)) continue;
      const runActorId = actorId("agent", row.targetAgentId);
      actorIds.add(runActorId);
      spanByRunId.set(row.runId, {
        actorId: runActorId,
        runId: row.runId,
        kind: row.kind,
        issueId: row.issueId,
        issueIdentifier: issueById.get(row.issueId)?.identifier ?? null,
        issueTitle: issueById.get(row.issueId)?.title ?? null,
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
      events.push({ actorId: commentActorId, kind: "commented", issueId: row.issueId, at: row.createdAt.toISOString() });
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
        issueId: row.issueId,
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
        events.push({ actorId: fromActorId, kind: "assigned", issueId: row.issueId, at: row.createdAt.toISOString() });
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
            issueId: row.issueId,
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
        totalIssues: sortedIssues.length,
        hasMore: offset + limit < sortedIssues.length,
      },
      window: { from: from.toISOString(), to: to.toISOString(), capped },
    };
  }

  return { getTimeline };
}
