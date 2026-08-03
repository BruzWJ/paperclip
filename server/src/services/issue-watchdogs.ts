import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueExecutionRefs,
  issueRelations,
  issues,
  issueWatchdogs,
  issueWorkProducts,
} from "@paperclipai/db";
import type {
  IssueExecutionRunStatus,
  IssueWatchdog,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { OrdinaryIssueRuntime } from "./ordinary-issue-runtime.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  listIssueExecutionRunsForIssue,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunListCursor,
} from "./issue-execution-run-service.js";

const ISSUE_WATCHDOG_STOP_FINGERPRINT_PREFIX = "issue_watchdog_stop:";
const ISSUE_WATCHDOG_SUBTREE_MAX_DEPTH = 100;
const ISSUE_WATCHDOG_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ISSUE_WATCHDOG_TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const ISSUE_WATCHDOG_TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
// Grace window after an issue is created/assigned during which its first
// initial execution ref may have been committed but is not yet visible to a
// watchdog evaluation (the eval can race the issue's own assignment run).
// Within this window a non-terminal issue that has never completed a run is
// treated as not-yet-stopped so the evaluation does not produce a
// false-positive stopped-subtree nudge. The periodic watchdog reconciler
// re-evaluates after the window, so a genuinely idle issue still triggers.
const ISSUE_WATCHDOG_FIRST_RUN_GRACE_MS = 15_000;

async function listWatchdogRunsForIssues(
  db: Db,
  companyId: string,
  issueIds: readonly string[],
  statuses: readonly IssueExecutionRunStatus[],
): Promise<IssueExecutionRunEnvelope[]> {
  const pages = await Promise.all(issueIds.map(async (issueId) => {
    const runs: IssueExecutionRunEnvelope[] = [];
    let cursor: IssueExecutionRunListCursor | null = null;
    do {
      const page = await listIssueExecutionRunsForIssue(db, {
        companyId,
        issueId,
        statuses,
        cursor,
        limit: 200,
      });
      runs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }));
  return pages.flat();
}

type IssueWatchdogRow = typeof issueWatchdogs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type IssueWatchdogClassifierIssue = Pick<
  IssueRow,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "parentId"
  | "ownerAgentId"
  | "ownerUserId"
  | "originKind"
  | "updatedAt"
> & {
  boardPresentationStatus: string;
  // Optional so existing callers/tests that do not care about the first-run
  // grace window keep working; the pending-first-run guard is skipped when
  // it (or `evaluatedAt`) is absent.
  createdAt?: Date | string | null;
  latestCommentAt?: Date | string | null;
  latestDocumentAt?: Date | string | null;
  latestWorkProductAt?: Date | string | null;
};

export type IssueWatchdogClassifierPath = {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
};

export type IssueWatchdogClassifierWaitingPath = {
  companyId: string;
  issueId: string;
  id?: string | null;
  status: string;
};

export type IssueWatchdogClassifierRelation = {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
};

export type IssueWatchdogClassifierConfig = Pick<
  IssueWatchdog,
  "companyId" | "issueId"
>;

export type IssueWatchdogStoppedLeaf = {
  issueId: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  blockerIssueIds: string[];
  pendingApprovalIds: string[];
  updatedAt: string;
  latestCommentAt: string | null;
  latestDocumentAt: string | null;
  latestWorkProductAt: string | null;
};

export type IssueWatchdogClassifierResult =
  | {
    state: "not_applicable";
    reason: string;
    includedIssueIds: string[];
  }
  | {
    state: "live";
    reason: string;
    includedIssueIds: string[];
    liveIssueIds: string[];
  }
  | {
    state: "pending_first_run";
    reason: string;
    includedIssueIds: string[];
    pendingIssueIds: string[];
  }
  | {
    state: "stopped";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: IssueWatchdogStoppedLeaf[];
  };

export type IssueWatchdogClassifierInput = {
  watchdog: IssueWatchdogClassifierConfig;
  issues: IssueWatchdogClassifierIssue[];
  activeRuns?: IssueWatchdogClassifierPath[];
  pendingDispatchRefs?: IssueWatchdogClassifierPath[];
  blockers?: IssueWatchdogClassifierRelation[];
  pendingApprovals?: IssueWatchdogClassifierWaitingPath[];
  // Timestamp the evaluation reads its snapshot at. When provided together
  // with a positive `firstRunGraceMs`, the classifier suppresses a
  // stopped-subtree verdict for issues created within the grace window that
  // have never completed a run (their initial execution ref may not yet
  // be visible). Omit to disable the guard (legacy behavior).
  evaluatedAt?: Date | string | null;
  firstRunGraceMs?: number | null;
  // Ids of included issues that have at least one run in a terminal status.
  // Such issues are never treated as "pending first run" — they have
  // demonstrably executed, so a stop is genuine rather than a snapshot race.
  completedRunIssueIds?: string[];
};

export type IssueWatchdogServiceDeps = Pick<
  OrdinaryIssueRuntime,
  "dispatchDirectEvent"
>;

export function summarizeIssueWatchdog(row: IssueWatchdogRow): IssueWatchdog {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    status: row.status as IssueWatchdog["status"],
    lastObservedFingerprint: row.lastObservedFingerprint,
    lastTriggeredAt: row.lastTriggeredAt,
    triggerCount: row.triggerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function issueUpdatedAtIso(issue: Pick<IssueWatchdogClassifierIssue, "updatedAt">) {
  return issue.updatedAt instanceof Date
    ? issue.updatedAt.toISOString()
    : new Date(String(issue.updatedAt)).toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pathIssueIds(paths: IssueWatchdogClassifierPath[] | undefined, companyId: string) {
  return new Set(
    (paths ?? [])
      .filter((path) => path.companyId === companyId && typeof path.issueId === "string" && path.issueId.length > 0)
      .map((path) => path.issueId as string),
  );
}

function waitingPathIds(
  paths: IssueWatchdogClassifierWaitingPath[] | undefined,
  companyId: string,
  issueId: string,
) {
  return (paths ?? [])
    .filter((path) => path.companyId === companyId && path.issueId === issueId)
    .map((path) => path.id ?? `${path.status}:${path.issueId}`)
    .sort();
}

function stableStopFingerprint(input: {
  companyId: string;
  watchedIssueId: string;
  leaves: IssueWatchdogStoppedLeaf[];
}) {
  const payload = JSON.stringify({
    version: 1,
    companyId: input.companyId,
    watchedIssueId: input.watchedIssueId,
    leaves: input.leaves,
  });
  return `issue_watchdog_stop:${createHash("sha256").update(payload).digest("hex")}`;
}

export function classifyIssueWatchdogSubtree(input: IssueWatchdogClassifierInput): IssueWatchdogClassifierResult {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issuesById.get(input.watchdog.issueId);
  if (!root || root.companyId !== input.watchdog.companyId) {
    return { state: "not_applicable", reason: "Watched issue is missing.", includedIssueIds: [] };
  }
  const childrenByParentId = new Map<string, IssueWatchdogClassifierIssue[]>();
  for (const issue of input.issues) {
    if (issue.companyId !== input.watchdog.companyId || !issue.parentId) continue;
    const list = childrenByParentId.get(issue.parentId) ?? [];
    list.push(issue);
    childrenByParentId.set(issue.parentId, list);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.id.localeCompare(right.id));
  }

  const included: IssueWatchdogClassifierIssue[] = [];
  const visit = (issue: IssueWatchdogClassifierIssue) => {
    included.push(issue);
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  if (included.length === 0) {
    return { state: "not_applicable", reason: "Watched subtree has no visible issues.", includedIssueIds: [] };
  }

  const includedIds = included.map((issue) => issue.id);
  const includedIdSet = new Set(includedIds);
  const liveIssueIds = [
    ...pathIssueIds(input.activeRuns, input.watchdog.companyId),
    ...pathIssueIds(input.pendingDispatchRefs, input.watchdog.companyId),
  ].filter((issueId) => includedIdSet.has(issueId));
  const uniqueLiveIssueIds = [...new Set(liveIssueIds)].sort();
  if (uniqueLiveIssueIds.length > 0) {
    return {
      state: "live",
      reason: "At least one issue in the watched subtree has a live run or pending persisted dispatch ref.",
      includedIssueIds: includedIds,
      liveIssueIds: uniqueLiveIssueIds,
    };
  }

  // Pending-first-run guard: a watchdog evaluation triggered as part of issue
  // (or watchdog) creation can read its snapshot before the issue's own
  // initial execution ref is committed/visible, making an actively-starting
  // subtree look idle. Suppress the stopped verdict for non-terminal issues
  // created within the first-run grace window that have never completed a run.
  const evaluatedAtMs = toEpochMs(input.evaluatedAt);
  const graceMs = input.firstRunGraceMs ?? 0;
  if (evaluatedAtMs != null && graceMs > 0) {
    const completedRunIssueIds = new Set(input.completedRunIssueIds ?? []);
    const pendingIssueIds = included
      .filter((issue) => {
        if (isTerminalIssueStatus(issue.boardPresentationStatus)) return false;
        if (completedRunIssueIds.has(issue.id)) return false;
        const createdAtMs = toEpochMs(issue.createdAt);
        if (createdAtMs == null) return false;
        return evaluatedAtMs - createdAtMs < graceMs;
      })
      .map((issue) => issue.id)
      .sort();
    if (pendingIssueIds.length > 0) {
      return {
        state: "pending_first_run",
        reason:
          "A watched issue was created within the first-run grace window and has not yet completed a run; deferring evaluation until its initial execution ref is observable.",
        includedIssueIds: includedIds,
        pendingIssueIds,
      };
    }
  }

  const includedChildrenByParentId = new Map<string, string[]>();
  for (const issue of included) {
    if (!issue.parentId || !includedIdSet.has(issue.parentId)) continue;
    const list = includedChildrenByParentId.get(issue.parentId) ?? [];
    list.push(issue.id);
    includedChildrenByParentId.set(issue.parentId, list);
  }
  const blockersByIssueId = new Map<string, string[]>();
  for (const relation of input.blockers ?? []) {
    if (relation.companyId !== input.watchdog.companyId) continue;
    if (!includedIdSet.has(relation.blockedIssueId)) continue;
    const list = blockersByIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation.blockerIssueId);
    blockersByIssueId.set(relation.blockedIssueId, list);
  }

  const leaves = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length === 0)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      boardPresentationStatus: issue.boardPresentationStatus,
      ownerAgentId: issue.ownerAgentId,
      ownerUserId: issue.ownerUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
      updatedAt: issueUpdatedAtIso(issue),
      latestCommentAt: optionalIso(issue.latestCommentAt),
      latestDocumentAt: optionalIso(issue.latestDocumentAt),
      latestWorkProductAt: optionalIso(issue.latestWorkProductAt),
    }));
  const stopFingerprint = stableStopFingerprint({
    companyId: input.watchdog.companyId,
    watchedIssueId: input.watchdog.issueId,
    leaves,
  });

  return {
    state: "stopped",
    reason: "No issue in the watched subtree has a live execution path.",
    includedIssueIds: includedIds,
    stopFingerprint,
    stoppedLeaves: leaves,
  };
}

async function assertWatchedIssue(dbOrTx: any, companyId: string, issueId: string) {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

function issueWatchdogNudgeIdempotencyKey(watchdogId: string, stopFingerprint: string) {
  return `issue_watchdog:${watchdogId}:${stopFingerprint}`;
}

function buildStoppedFingerprintComment(input: {
  sourceIssue: Pick<IssueRow, "identifier" | "id">;
  stopFingerprint: string;
  stoppedLeaves: IssueWatchdogStoppedLeaf[];
}) {
  const leafLines = input.stoppedLeaves.slice(0, 12).map((leaf) =>
    `- ${leaf.identifier ?? leaf.issueId}: ${leaf.boardPresentationStatus} (updated ${leaf.updatedAt})`
  );
  const more = input.stoppedLeaves.length > leafLines.length
    ? `\n- ...and ${input.stoppedLeaves.length - leafLines.length} more stopped leaves`
    : "";
  return [
    "System safeguard detected a stopped subtree.",
    "",
    `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
    `Stopped fingerprint: \`${input.stopFingerprint}\``,
    "",
    "Stopped leaves:",
    ...(leafLines.length > 0 ? leafLines : ["- No leaf issues found."]),
    more,
  ].filter((line) => line !== "").join("\n");
}

function isTerminalIssueStatus(status: string) {
  return ISSUE_WATCHDOG_TERMINAL_ISSUE_STATUSES.includes(
    status as (typeof ISSUE_WATCHDOG_TERMINAL_ISSUE_STATUSES)[number],
  );
}

function isUniqueConstraintConflict(error: unknown, constraintName: string) {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  for (const candidate of queue) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
      message?: string;
    };
    if (typed.code === "23505") hasUniqueCode = true;
    if (typed.constraint === constraintName || typed.constraint_name === constraintName) hasConstraint = true;
    if (typed.message) messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(constraintName));
}

function isIssueWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issue_watchdogs_company_issue_uq");
}

async function updateIssueWatchdogRow(
  dbOrTx: any,
  existing: IssueWatchdogRow,
  now: Date,
) {
  const [updated] = await dbOrTx
    .update(issueWatchdogs)
    .set({
      status: "active",
      updatedAt: now,
    })
    .where(eq(issueWatchdogs.id, existing.id))
    .returning();
  return updated;
}

export async function upsertIssueWatchdogForIssue(
  dbOrTx: any,
  companyId: string,
  issueId: string,
): Promise<{ watchdog: IssueWatchdog; created: boolean }> {
  await assertWatchedIssue(dbOrTx, companyId, issueId);

  const now = new Date();
  const existing = await dbOrTx
    .select()
    .from(issueWatchdogs)
    .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
    .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);

  if (existing) {
    const updated = await updateIssueWatchdogRow(dbOrTx, existing, now);
    return { watchdog: summarizeIssueWatchdog(updated), created: false };
  }

  const insertResult: { row: IssueWatchdogRow; created: boolean } = await dbOrTx
    .insert(issueWatchdogs)
    .values({
      companyId,
      issueId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows: IssueWatchdogRow[]) => ({ row: rows[0], created: true }))
    .catch(async (error: unknown) => {
      if (!isIssueWatchdogUniqueConflict(error)) throw error;
      const winner = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
      if (!winner) throw error;
      const updated = await updateIssueWatchdogRow(dbOrTx, winner, now);
      return { row: updated, created: false };
    });
  return { watchdog: summarizeIssueWatchdog(insertResult.row), created: insertResult.created };
}

export function issueWatchdogService(db: Db, deps: IssueWatchdogServiceDeps) {
  async function loadWatchdogSubtreeIssues(companyId: string, watchedIssueId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE watched_issues AS (
        SELECT
          id,
          company_id,
          identifier,
          title,
          board_presentation_status AS "boardPresentationStatus",
          parent_id,
          owner_agent_id,
          owner_user_id,
          origin_kind,
          updated_at,
          created_at,
          0 AS depth
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${watchedIssueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT
          child.id,
          child.company_id,
          child.identifier,
          child.title,
          child.board_presentation_status AS "boardPresentationStatus",
          child.parent_id,
          child.owner_agent_id,
          child.owner_user_id,
          child.origin_kind,
          child.updated_at,
          child.created_at,
          watched_issues.depth + 1
        FROM issues child
        JOIN watched_issues ON child.parent_id = watched_issues.id
        WHERE child.company_id = ${companyId}
          AND child.hidden_at IS NULL
          AND child.harness_kind IS NULL
          AND watched_issues.depth < ${ISSUE_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT
        id,
        company_id AS "companyId",
        identifier,
        title,
        "boardPresentationStatus",
        parent_id AS "parentId",
        owner_agent_id AS "ownerAgentId",
        owner_user_id AS "ownerUserId",
        origin_kind AS "originKind",
        updated_at AS "updatedAt",
        created_at AS "createdAt"
      FROM watched_issues
    `);

    return (Array.isArray(rows) ? rows : []) as IssueWatchdogClassifierIssue[];
  }

  async function collectClassifierInput(companyId: string, watchdog: IssueWatchdogRow) {
    const issueRows = await loadWatchdogSubtreeIssues(companyId, watchdog.issueId);
    const subtreeIssueIds = issueRows.map((issue) => issue.id);
    if (subtreeIssueIds.length === 0) {
      return {
        watchdog: summarizeIssueWatchdog(watchdog),
        issues: [],
        activeRuns: [],
        pendingDispatchRefs: [],
        blockers: [],
        pendingApprovals: [],
        evaluatedAt: new Date(),
        firstRunGraceMs: ISSUE_WATCHDOG_FIRST_RUN_GRACE_MS,
        completedRunIssueIds: [],
      } satisfies IssueWatchdogClassifierInput;
    }

    const [
      activeRunRows,
      pendingRefRows,
      blockerRows,
      approvalRows,
      commentActivityRows,
      documentActivityRows,
      workProductActivityRows,
    ] = await Promise.all([
      listWatchdogRunsForIssues(
        db,
        companyId,
        subtreeIssueIds,
        ISSUE_WATCHDOG_LIVE_RUN_STATUSES,
      ).then((runs) => runs.flatMap((run) =>
        (run.kind === "productive" || run.kind === "consult") &&
        run.targetAgentId !== null
          ? [{
              companyId: run.companyId,
              agentId: run.targetAgentId,
              status: run.status,
              issueId: run.issueId,
            }]
          : []
      )),
      db
        .select({
          companyId: issueExecutionRefs.companyId,
          agentId: issueExecutionRefs.targetAgentId,
          status: issueExecutionRefs.disposition,
          issueId: issueExecutionRefs.issueId,
        })
        .from(issueExecutionRefs)
        .where(and(
          eq(issueExecutionRefs.companyId, companyId),
          eq(issueExecutionRefs.disposition, "active"),
          inArray(issueExecutionRefs.issueId, subtreeIssueIds),
        )),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, subtreeIssueIds),
        )),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          id: approvals.id,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          inArray(issueApprovals.issueId, subtreeIssueIds),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )),
      db
        .select({
          issueId: issueComments.issueId,
          latestAt: sql<Date | null>`MAX(${issueComments.updatedAt})`,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, subtreeIssueIds),
        ))
        .groupBy(issueComments.issueId),
      db
        .select({
          issueId: issueDocuments.issueId,
          latestAt: sql<Date | null>`MAX(${issueDocuments.updatedAt})`,
        })
        .from(issueDocuments)
        .where(and(
          eq(issueDocuments.companyId, companyId),
          inArray(issueDocuments.issueId, subtreeIssueIds),
        ))
        .groupBy(issueDocuments.issueId),
      db
        .select({
          issueId: issueWorkProducts.issueId,
          latestAt: sql<Date | null>`MAX(${issueWorkProducts.updatedAt})`,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.issueId, subtreeIssueIds),
        ))
        .groupBy(issueWorkProducts.issueId),
    ]);
    const latestCommentByIssueId = new Map(commentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestDocumentByIssueId = new Map(documentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestWorkProductByIssueId = new Map(workProductActivityRows.map((row) => [row.issueId, row.latestAt]));

    const evaluatedAt = new Date();
    const evaluatedAtMs = evaluatedAt.getTime();
    // Only the issues created within the first-run grace window can be racing
    // their own assignment run; scope the (potentially expensive) terminal-run
    // lookup to those few issues so the common path stays a no-op.
    const freshIssueIds = issueRows
      .filter((row) => {
        if (isTerminalIssueStatus(row.boardPresentationStatus)) return false;
        const createdAtMs = toEpochMs(row.createdAt);
        return createdAtMs != null && evaluatedAtMs - createdAtMs < ISSUE_WATCHDOG_FIRST_RUN_GRACE_MS;
      })
      .map((row) => row.id);
    const completedRunIssueIds = await collectCompletedRunIssueIds(companyId, freshIssueIds);

    return {
      watchdog: summarizeIssueWatchdog(watchdog),
      issues: issueRows.map((issue) => ({
        ...issue,
        latestCommentAt: latestCommentByIssueId.get(issue.id) ?? null,
        latestDocumentAt: latestDocumentByIssueId.get(issue.id) ?? null,
        latestWorkProductAt: latestWorkProductByIssueId.get(issue.id) ?? null,
      })),
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      })),
      pendingDispatchRefs: pendingRefRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      })),
      blockers: blockerRows,
      pendingApprovals: approvalRows,
      evaluatedAt,
      firstRunGraceMs: ISSUE_WATCHDOG_FIRST_RUN_GRACE_MS,
      completedRunIssueIds,
    } satisfies IssueWatchdogClassifierInput;
  }

  // Returns the subset of `issueIds` that already have at least one run in a
  // terminal status. Such issues have demonstrably executed, so a stopped
  // subtree is genuine and must not be masked by the pending-first-run guard.
  async function collectCompletedRunIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const completed = await listWatchdogRunsForIssues(
      db,
      companyId,
      issueIds,
      ISSUE_WATCHDOG_TERMINAL_RUN_STATUSES,
    );
    return [...new Set(completed.flatMap((run) =>
      run.kind === "productive" || run.kind === "consult"
        ? [run.issueId]
        : []
    ))];
  }

  async function evaluateWatchdog(row: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, row.companyId),
        eq(issues.id, row.issueId),
        visibleIssueCondition(),
      ))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) {
      return { state: "skipped" as const, reason: "watched_issue_not_applicable" };
    }

    const input = await collectClassifierInput(row.companyId, row);
    const classification = classifyIssueWatchdogSubtree(input);
    if (classification.state !== "stopped") {
      return { state: classification.state, reason: classification.reason, classification };
    }
    if (row.lastObservedFingerprint === classification.stopFingerprint) {
      return {
        state: "already_nudged" as const,
        classification,
        nudgedIssueId: sourceIssue.id,
      };
    }
    const idempotencyKey = issueWatchdogNudgeIdempotencyKey(
      row.id,
      classification.stopFingerprint,
    );
    const previousFingerprint = row.lastObservedFingerprint;
    const evidenceClaimedAt = new Date();
    const claimed = await db
      .update(issueWatchdogs)
      .set({
        lastObservedFingerprint: classification.stopFingerprint,
        updatedAt: evidenceClaimedAt,
      })
      .where(and(
        eq(issueWatchdogs.id, row.id),
        eq(issueWatchdogs.companyId, row.companyId),
        eq(issueWatchdogs.status, "active"),
        previousFingerprint == null
          ? isNull(issueWatchdogs.lastObservedFingerprint)
          : eq(issueWatchdogs.lastObservedFingerprint, previousFingerprint),
      ))
      .returning({ id: issueWatchdogs.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) {
      return {
        state: "already_nudged" as const,
        classification,
        nudgedIssueId: sourceIssue.id,
      };
    }

    let refId: string;
    try {
      const delivery = await deps.dispatchDirectEvent({
        companyId: sourceIssue.companyId,
        issueId: sourceIssue.id,
        message: buildStoppedFingerprintComment({
          sourceIssue,
          stopFingerprint: classification.stopFingerprint,
          stoppedLeaves: classification.stoppedLeaves,
        }),
        sourceKind: "system_nudge",
        sourceRecordId: row.id,
        idempotencyKey,
      });
      refId = delivery.ref.id;
    } catch (error) {
      // dispatchDirectEvent commits the ref before asking the executor to
      // lease it. Recover that admitted ref when dispatch notification fails;
      // an immediately leased run must retain the evidence written above.
      const admittedRef = await db
        .select({ id: issueExecutionRefs.id })
        .from(issueExecutionRefs)
        .where(and(
          eq(issueExecutionRefs.companyId, sourceIssue.companyId),
          eq(issueExecutionRefs.issueId, sourceIssue.id),
          eq(issueExecutionRefs.sourceKind, "system_nudge"),
          eq(issueExecutionRefs.sourceRecordId, row.id),
          eq(issueExecutionRefs.deliveryIdempotencyKey, idempotencyKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (!admittedRef) {
        await db
          .update(issueWatchdogs)
          .set({
            lastObservedFingerprint: previousFingerprint,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueWatchdogs.id, row.id),
            eq(
              issueWatchdogs.lastObservedFingerprint,
              classification.stopFingerprint,
            ),
          ));
        throw error;
      }
      refId = admittedRef.id;
    }

    const now = new Date();
    await db
      .update(issueWatchdogs)
      .set({
        lastTriggeredAt: now,
        triggerCount: sql`${issueWatchdogs.triggerCount} + 1`,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, row.id));

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: sourceIssue.ownerAgentId,
      runId: opts.runId ?? null,
      action: "issue.watchdog_triggered",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "issue_watchdogs.evaluate",
        watchdogId: row.id,
        refId,
        stopFingerprint: classification.stopFingerprint,
        stoppedLeaves: classification.stoppedLeaves,
      },
    });

    return {
      state: "triggered" as const,
      classification,
      nudgedIssueId: sourceIssue.id,
      refId,
    };
  }

  async function listActiveWatchdogsForCompany(companyId?: string | null) {
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.status, "active"),
        ...(companyId ? [eq(issueWatchdogs.companyId, companyId)] : []),
      ));
  }

  async function activeWatchdogsForIssueAndAncestors(companyId: string, issueId: string) {
    const ancestorRows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND parent.hidden_at IS NULL
          AND parent.harness_kind IS NULL
          AND ancestors.depth < ${ISSUE_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT id FROM ancestors
    `);
    const ancestorIds = (Array.isArray(ancestorRows) ? ancestorRows : [])
      .map((row) => typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : null)
      .filter((id): id is string => typeof id === "string");
    if (ancestorIds.length === 0) return [];
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.status, "active"),
        inArray(issueWatchdogs.issueId, ancestorIds),
      ));
  }

  return {
    getActiveForIssue: async (companyId: string, issueId: string): Promise<IssueWatchdog | null> => {
      const row = await db
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          eq(issueWatchdogs.issueId, issueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      return row ? summarizeIssueWatchdog(row) : null;
    },

    listActiveSummariesForIssues: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: any = db,
    ): Promise<Map<string, IssueWatchdog>> => {
      if (issueIds.length === 0) return new Map();
      const rows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, [...new Set(issueIds)]),
          eq(issueWatchdogs.status, "active"),
        ));
      return new Map(rows.map((row: IssueWatchdogRow) => [row.issueId, summarizeIssueWatchdog(row)]));
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
    ): Promise<{ watchdog: IssueWatchdog; created: boolean }> => {
      return upsertIssueWatchdogForIssue(db, companyId, issueId);
    },

    disableForIssue: async (
      companyId: string,
      issueId: string,
    ): Promise<IssueWatchdog | null> => {
      await assertWatchedIssue(db, companyId, issueId);
      const existing = await db
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status === "disabled") return null;
      const [updated] = await db
        .update(issueWatchdogs)
        .set({
          status: "disabled",
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, existing.id))
        .returning();
      return summarizeIssueWatchdog(updated);
    },

    reconcileIssueWatchdogs: async (opts: {
      companyId?: string | null;
      runId?: string | null;
      issueCreatedAtGte?: Date | null;
    } = {}) => {
      let rows = await listActiveWatchdogsForCompany(opts.companyId ?? null);
      if (opts.issueCreatedAtGte) {
        const watchedIssueIds = [...new Set(rows.map((row) => row.issueId))];
        const eligibleIssueIds = new Set(
          watchedIssueIds.length === 0
            ? []
            : (await db
                .select({ id: issues.id })
                .from(issues)
                .where(and(
                  inArray(issues.id, watchedIssueIds),
                  gte(issues.createdAt, opts.issueCreatedAtGte),
                )))
                .map((issue) => issue.id),
        );
        rows = rows.filter((row) => eligibleIssueIds.has(row.issueId));
      }
      const result = {
        checked: 0,
        triggered: 0,
        live: 0,
        pendingFirstRun: 0,
        alreadyNudged: 0,
        skipped: 0,
        nudgedIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.nudgedIssueIds.push(evaluated.nudgedIssueId);
        } else if (evaluated.state === "live") {
          result.live += 1;
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "already_nudged") {
          result.alreadyNudged += 1;
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    reconcileForIssueAndAncestors: async (
      companyId: string,
      issueId: string,
      opts: { runId?: string | null } = {},
    ) => {
      const rows = await activeWatchdogsForIssueAndAncestors(companyId, issueId);
      const result = {
        checked: 0,
        triggered: 0,
        pendingFirstRun: 0,
        skipped: 0,
        nudgedIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.nudgedIssueIds.push(evaluated.nudgedIssueId);
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "live") {
          // A persisted execution ref or run is still live.
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },
  };
}
