import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  ISSUE_STATUSES,
  type IssueStatus,
  type IssueTreeControlMode,
  type IssueTreeControlPreview,
  type IssueTreeHold,
  type IssueTreeHoldMember,
  type IssueTreeHoldReleasePolicy,
  type IssueTreePreviewAgent,
  type IssueTreePreviewIssue,
  type IssueTreePreviewRun,
  type IssueTreePreviewWarning,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  recordNamedBoardLifecycleCommandInTransaction,
  type NamedBoardLifecycleAffectedIssue,
} from "./issue-board-lifecycle-command.js";
import { resolveCurrentIssueOwnerRunLinkages } from "./productive-run-linkage.js";
import type {
  IssueExecutionCancellationActor,
  IssueExecutionCancellationService,
  RequestedRunningIssueInterruptions,
  RequestedScopedRunCancellations,
} from "./issue-execution-cancellation.js";
import { lockIssueTreeExecutionGate } from "./issue-execution-lifecycle-gate.js";

type IssueRow = typeof issues.$inferSelect;
type HoldRow = typeof issueTreeHolds.$inferSelect;
type HoldMemberRow = typeof issueTreeHoldMembers.$inferSelect;
export type ActiveIssueTreePauseHoldGate = {
  holdId: string;
  rootIssueId: string;
  issueId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: IssueTreeHoldReleasePolicy | null;
};
type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type TreeIssue = IssueRow & { depth: number };
type ActiveRunRow = {
  id: string;
  issueId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
type ActiveCancelSnapshot = {
  holdIds: string[];
  member: IssueTreeHoldMember | null;
};
type TreeStatusUpdateResult = {
  updatedIssueIds: string[];
  updatedIssues: Array<{
    id: string;
    boardPresentationStatus: IssueStatus;
    ownerAgentId: string | null;
  }>;
};
type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: IssueTreeHold | null;
};
export type IssueTreeCancellationPort = Pick<
  IssueExecutionCancellationService,
  | "requestRunningIssueInterruptionsInTransaction"
  | "reconcileRequestedRunningIssueInterruptions"
  | "requestScopeCancellationsInTransaction"
  | "reconcileRequestedScopeCancellations"
>;

const DEFAULT_RELEASE_POLICY: IssueTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
function normalizeReleasePolicy(
  releasePolicy: IssueTreeHoldReleasePolicy | null | undefined,
): IssueTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
}

function coerceIssueStatus(status: string): IssueStatus {
  return ISSUE_STATUSES.includes(status as IssueStatus) ? (status as IssueStatus) : "backlog";
}

function toPreviewRun(row: ActiveRunRow): IssueTreePreviewRun {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

function toHold(row: HoldRow, members?: HoldMemberRow[]): IssueTreeHold {
  return {
    id: row.id,
    companyId: row.companyId,
    rootIssueId: row.rootIssueId,
    mode: row.mode as IssueTreeControlMode,
    status: row.status as IssueTreeHold["status"],
    reason: row.reason,
    releasePolicy: (row.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
    createdByActorType: row.createdByActorType as IssueTreeHold["createdByActorType"],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    releasedAt: row.releasedAt,
    releasedByActorType: row.releasedByActorType as IssueTreeHold["releasedByActorType"],
    releasedByAgentId: row.releasedByAgentId,
    releasedByUserId: row.releasedByUserId,
    releasedByRunId: row.releasedByRunId,
    releaseReason: row.releaseReason,
    releaseMetadata: row.releaseMetadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(members ? { members: members.map(toHoldMember) } : {}),
  };
}

function toHoldMember(row: HoldMemberRow): IssueTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    issueId: row.issueId,
    parentIssueId: row.parentIssueId,
    depth: row.depth,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    issueStatus: coerceIssueStatus(row.issueStatus),
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    activeRunId: row.activeRunId,
    activeRunStatus: row.activeRunStatus,
    skipped: row.skipped,
    skipReason: row.skipReason,
    createdAt: row.createdAt,
  };
}

function issueSkipReason(input: {
  mode: IssueTreeControlMode;
  issue: TreeIssue;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const lifecycleStatus = input.issue.lifecycleStatus;
  if (input.mode === "restore") {
    if (
      input.activeCancelSnapshot?.member &&
      lifecycleStatus !== "cancelled"
    ) {
      return "changed_after_cancel";
    }
    if (lifecycleStatus !== "cancelled") return "not_cancelled";
    if (!input.activeCancelSnapshot?.member) return "not_cancelled_by_tree_control";
    return null;
  }
  if (lifecycleStatus === "done" || lifecycleStatus === "cancelled") {
    return "terminal_status";
  }
  if (input.mode === "pause" && input.activePauseHoldIds.length > 0) {
    return "already_held";
  }
  if (input.mode === "resume" && input.activePauseHoldIds.length === 0) {
    return "not_held";
  }
  return null;
}

function buildAffectedAgents(issuesToPreview: IssueTreePreviewIssue[]): IssueTreePreviewAgent[] {
  const byAgentId = new Map<string, IssueTreePreviewAgent>();
  for (const issue of issuesToPreview) {
    if (issue.skipped) continue;
    const agentIds = new Set<string>();
    if (issue.ownerAgentId) agentIds.add(issue.ownerAgentId);
    if (issue.activeRun) agentIds.add(issue.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? { agentId, issueCount: 0, activeRunCount: 0 };
      current.issueCount += 1;
      if (issue.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildWarnings(input: {
  mode: IssueTreeControlMode;
  issuesToPreview: IssueTreePreviewIssue[];
  activeRuns: IssueTreePreviewRun[];
}): IssueTreePreviewWarning[] {
  const affectedIssues = input.issuesToPreview.filter((issue) => !issue.skipped);
  const affectedIssueIds = new Set(affectedIssues.map((issue) => issue.id));
  const affectedRuns = input.activeRuns.filter((run) => affectedIssueIds.has(run.issueId));
  const warnings: IssueTreePreviewWarning[] = [];

  if (affectedIssues.length === 0) {
    warnings.push({
      code: "no_affected_issues",
      message: "No issues in this subtree match the requested control action.",
    });
  }

  const runningRunIssueIds = affectedRuns
    .filter((run) => run.status === "running")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunIssueIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected issues have running issue-execution runs.",
      issueIds: [...new Set(runningRunIssueIds)].sort(),
    });
  }

  const queuedRunIssueIds = affectedRuns
    .filter((run) => run.status === "queued")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && queuedRunIssueIds.length > 0) {
    warnings.push({
      code: "queued_runs_present",
      message: "Some affected issues have queued issue-execution runs.",
      issueIds: [...new Set(queuedRunIssueIds)].sort(),
    });
  }

  if (input.mode === "resume" && affectedIssues.length === 0) {
    warnings.push({
      code: "no_active_pause_holds",
      message: "No active pause holds were found in this subtree.",
    });
  }

  if (input.mode === "restore") {
    const changedIssueIds = input.issuesToPreview
      .filter((issue) => issue.skipReason === "changed_after_cancel")
      .map((issue) => issue.id);
    if (changedIssueIds.length > 0) {
      warnings.push({
        code: "restore_conflicts_present",
        message: "Some issues changed after subtree cancellation and will be skipped.",
        issueIds: changedIssueIds,
      });
    }
  }

  return warnings;
}

function restoreStatusFromCancelSnapshot(status: IssueStatus): IssueStatus | null {
  if (status === "in_progress") return "todo";
  return status;
}

function namedBoardActorUserId(actor: ActorInput): string | null {
  if (actor.actorType !== "user") return null;
  if (!actor.userId || actor.actorId !== actor.userId) {
    throw unprocessable(
      "A named-user issue-tree command requires one exact authenticated user identity",
    );
  }
  return actor.userId;
}

function cancellationActorForHold(hold: {
  createdByActorType: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
}): IssueExecutionCancellationActor {
  if (hold.createdByActorType === "user" && hold.createdByUserId) {
    return { kind: "user", userId: hold.createdByUserId };
  }
  if (hold.createdByActorType === "agent" && hold.createdByAgentId) {
    return { kind: "agent", agentId: hold.createdByAgentId };
  }
  return { kind: "system" };
}

function deterministicTreeCommandId(namespace: string, sourceId: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${sourceId}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function issueTreeControlService(
  db: Db,
  options: { issueExecutionCancellation?: IssueTreeCancellationPort } = {},
) {
  async function listTreeIssues(companyId: string, rootIssueId: string): Promise<TreeIssue[]> {
    const root = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root issue not found");
    }

    const result: TreeIssue[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const children = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, parentIds)))
        .orderBy(asc(issues.createdAt), asc(issues.id));

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

  async function activeRunsForTree(companyId: string, treeIssues: TreeIssue[]) {
    const issueIds = treeIssues.map((issue) => issue.id);
    if (issueIds.length === 0) return [];
    const linkages = await resolveCurrentIssueOwnerRunLinkages(db, {
      companyId,
      issueIds,
    });
    return [...linkages.values()]
      .map((linkage) => ({
        id: linkage.runId,
        issueId: linkage.issueId,
        agentId: linkage.agentId,
        status: "running" as const,
        startedAt: linkage.startedAt,
        createdAt: linkage.createdAt,
      }))
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function activeHoldsByIssueId(companyId: string, issueIds: string[]) {
    const byIssueId = new Map<string, { all: string[]; pause: string[] }>();
    if (issueIds.length === 0) return byIssueId;
    const rows = await db
      .select({
        issueId: issueTreeHoldMembers.issueId,
        holdId: issueTreeHolds.id,
        mode: issueTreeHolds.mode,
      })
      .from(issueTreeHoldMembers)
      .innerJoin(issueTreeHolds, eq(issueTreeHoldMembers.holdId, issueTreeHolds.id))
      .where(
        and(
          eq(issueTreeHoldMembers.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          inArray(issueTreeHoldMembers.issueId, issueIds),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));

    for (const row of rows) {
      const current = byIssueId.get(row.issueId) ?? { all: [], pause: [] };
      current.all.push(row.holdId);
      if (row.mode === "pause") current.pause.push(row.holdId);
      byIssueId.set(row.issueId, current);
    }
    return byIssueId;
  }

  async function activeCancelSnapshotsByIssueId(companyId: string, rootIssueId: string) {
    const activeCancelHolds = await listHolds(companyId, rootIssueId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byIssueId = new Map<string, ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byIssueId.get(member.issueId) ?? { holdIds: [], member: null };
        if (!current.holdIds.includes(hold.id)) current.holdIds.push(hold.id);
        if (!current.member && !member.skipped) current.member = member;
        byIssueId.set(member.issueId, current);
      }
    }
    return byIssueId;
  }

  async function getActivePauseHoldGate(
    companyId: string,
    issueId: string,
  ): Promise<ActiveIssueTreePauseHoldGate | null> {
    const activePauseHolds = await db
      .select({
        id: issueTreeHolds.id,
        rootIssueId: issueTreeHolds.rootIssueId,
        reason: issueTreeHolds.reason,
        releasePolicy: issueTreeHolds.releasePolicy,
      })
      .from(issueTreeHolds)
      .where(
        and(
          eq(issueTreeHolds.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (activePauseHolds.length === 0) return null;

    const holdByRootIssueId = new Map(activePauseHolds.map((hold) => [hold.rootIssueId, hold]));
    let currentIssueId: string | null = issueId;
    const visited = new Set<string>();

    while (
      currentIssueId
      && !visited.has(currentIssueId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH
    ) {
      visited.add(currentIssueId);
      const hold = holdByRootIssueId.get(currentIssueId);
      if (hold) {
        return {
          holdId: hold.id,
          rootIssueId: hold.rootIssueId,
          issueId,
          isRoot: hold.rootIssueId === issueId,
          mode: "pause",
          reason: hold.reason,
          releasePolicy: (hold.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
        };
      }

      const parent: { parentId: string | null } | null = await db
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentIssueId = parent?.parentId ?? null;
    }

    return null;
  }

  async function preview(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
    },
  ): Promise<IssueTreeControlPreview> {
    const treeIssues = await listTreeIssues(companyId, rootIssueId);
    const issueIds = treeIssues.map((issue) => issue.id);
    const [activeRunRows, holdsByIssueId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeIssues),
      activeHoldsByIssueId(companyId, issueIds),
      input.mode === "restore"
        ? activeCancelSnapshotsByIssueId(companyId, rootIssueId)
        : Promise.resolve(new Map<string, ActiveCancelSnapshot>()),
    ]);
    const runsByIssueId = new Map<string, ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByIssueId.has(run.issueId)) runsByIssueId.set(run.issueId, run);
    }
    const countsByStatus: Partial<Record<IssueStatus, number>> = {};

    const issuesToPreview = treeIssues.map((issue) => {
      const boardPresentationStatus = coerceIssueStatus(issue.boardPresentationStatus);
      countsByStatus[boardPresentationStatus] =
        (countsByStatus[boardPresentationStatus] ?? 0) + 1;
      const holdState = holdsByIssueId.get(issue.id) ?? { all: [], pause: [] };
      const skipReason = issueSkipReason({
        mode: input.mode,
        issue,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(issue.id) ?? null,
      });
      const run = runsByIssueId.get(issue.id);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        boardPresentationStatus,
        parentId: issue.parentId,
        depth: issue.depth,
        ownerAgentId: issue.ownerAgentId,
        ownerUserId: issue.ownerUserId,
        activeRun: run ? toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies IssueTreePreviewIssue;
    });
    const skippedIssues = issuesToPreview.filter((issue) => issue.skipped);
    const activeRuns = activeRunRows
      .map(toPreviewRun)
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.id.localeCompare(b.id));
    const affectedAgents = buildAffectedAgents(issuesToPreview);

    return {
      companyId,
      rootIssueId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: normalizeReleasePolicy(input.releasePolicy),
      totals: {
        totalIssues: issuesToPreview.length,
        affectedIssues: issuesToPreview.length - skippedIssues.length,
        skippedIssues: skippedIssues.length,
        activeRuns: activeRuns.filter((run) => run.status === "running").length,
        queuedRuns: activeRuns.filter((run) => run.status === "queued").length,
        affectedAgents: affectedAgents.length,
      },
      countsByStatus,
      issues: issuesToPreview,
      skippedIssues,
      activeRuns,
      affectedAgents,
      warnings: buildWarnings({ mode: input.mode, issuesToPreview, activeRuns }),
    };
  }

  async function createHold(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      actor: ActorInput;
    },
  ): Promise<{
    hold: IssueTreeHold;
    preview: IssueTreeControlPreview;
    resumedPauseHoldIds?: string[];
    cancelledIssueIds: string[];
  }> {
    const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
    const holdPreview = input.mode === "pause" || input.mode === "cancel"
      ? null
      : await preview(companyId, rootIssueId, {
        mode: input.mode,
        releasePolicy: holdReleasePolicy,
      });

    async function insertHoldWithMembers(
      tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
      previewSnapshot: IssueTreeControlPreview,
    ) {
      const [createdHold] = await tx
        .insert(issueTreeHolds)
        .values({
          companyId,
          rootIssueId,
          mode: input.mode,
          status: "active",
          reason: input.reason ?? null,
          releasePolicy: holdReleasePolicy as unknown as Record<string, unknown>,
          createdByActorType: input.actor.actorType,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          createdByRunId: input.actor.runId ?? null,
        })
        .returning();

      const memberRows = previewSnapshot.issues.map((issue) => ({
        companyId,
        holdId: createdHold.id,
        issueId: issue.id,
        parentIssueId: issue.parentId,
        depth: issue.depth,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueStatus: issue.boardPresentationStatus,
        ownerAgentId: issue.ownerAgentId,
        ownerUserId: issue.ownerUserId,
        activeRunId: issue.activeRun?.id ?? null,
        activeRunStatus: issue.activeRun?.status ?? null,
        skipped: issue.skipped,
        skipReason: issue.skipReason,
      }));

      const createdMembers = memberRows.length > 0
        ? await tx
          .insert(issueTreeHoldMembers)
          .values(memberRows)
          .returning()
        : [];

      return { createdHold, createdMembers };
    }

    if (input.mode === "resume") {
      const resumePreview = holdPreview!;
      const issueIds = [...new Set(resumePreview.issues.map((issue) => issue.id))];
      const releaseReason = input.reason ?? "Subtree resume applied.";
      const actorUserId = namedBoardActorUserId(input.actor);

      return db.transaction(async (tx) => {
        const activePauseHolds = issueIds.length === 0
          ? []
          : await tx
            .select()
            .from(issueTreeHolds)
            .where(
              and(
                eq(issueTreeHolds.companyId, companyId),
                eq(issueTreeHolds.status, "active"),
                eq(issueTreeHolds.mode, "pause"),
                inArray(issueTreeHolds.rootIssueId, issueIds),
              ),
            )
            .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id))
            .for("update");
        const { createdHold, createdMembers } = await insertHoldWithMembers(tx, resumePreview);
        const resumedPauseHoldIds = activePauseHolds.map((hold) => hold.id);
        const now = new Date();
        let affectedIssueIds: string[] = [];
        if (resumedPauseHoldIds.length > 0) {
          affectedIssueIds = await tx
            .select({ issueId: issueTreeHoldMembers.issueId })
            .from(issueTreeHoldMembers)
            .where(
              and(
                eq(issueTreeHoldMembers.companyId, companyId),
                inArray(issueTreeHoldMembers.holdId, resumedPauseHoldIds),
                eq(issueTreeHoldMembers.skipped, false),
              ),
            )
            .then((rows) => [...new Set(rows.map((row) => row.issueId))]);
          await tx
            .update(issueTreeHolds)
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
                'resumedPauseHoldId', ${issueTreeHolds.id}
              )`,
              updatedAt: now,
            })
            .where(
              and(
                eq(issueTreeHolds.companyId, companyId),
                eq(issueTreeHolds.status, "active"),
                inArray(issueTreeHolds.id, resumedPauseHoldIds),
              ),
            );
        }

        const [releasedResumeHold] = await tx
          .update(issueTreeHolds)
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
              ...(input.releasePolicy
                ? { releasePolicy: holdReleasePolicy }
                : {}),
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(issueTreeHolds.companyId, companyId),
              eq(issueTreeHolds.id, createdHold.id),
              eq(issueTreeHolds.status, "active"),
            ),
          )
          .returning();
        if (!releasedResumeHold) {
          throw conflict("Subtree resume command was not committed");
        }

        if (actorUserId && affectedIssueIds.length > 0) {
          const affectedIssues = await tx
            .select({
              id: issues.id,
              ownershipEpoch: issues.ownershipEpoch,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.id, affectedIssueIds),
              ),
            )
            .orderBy(asc(issues.id))
            .for("update");
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedIssues,
            actorUserId,
            subtype: "tree_control_resume",
            sourceCommandId: createdHold.id,
            idempotencyKey: `issue-tree-resume:${createdHold.id}`,
            committedAt: now,
          });
        }

        return {
          hold: toHold(releasedResumeHold, createdMembers),
          preview: resumePreview,
          resumedPauseHoldIds,
          cancelledIssueIds: [],
        };
      });
    }

    const applied = await db.transaction(async (tx) => {
      if (input.mode === "pause" || input.mode === "cancel") {
        await lockIssueTreeExecutionGate(tx, companyId, rootIssueId);
      }
      const committedPreview = holdPreview
        ?? await issueTreeControlService(tx as unknown as Db).preview(
          companyId,
          rootIssueId,
          {
            mode: input.mode,
            releasePolicy: holdReleasePolicy,
          },
        );
      const { createdHold, createdMembers } = await insertHoldWithMembers(
        tx,
        committedPreview,
      );
      const affectedIssueIds = createdMembers
        .filter((member) => !member.skipped)
        .map((member) => member.issueId);
      const actorUserId = namedBoardActorUserId(input.actor);
      const now = createdHold.createdAt;

      if (input.mode === "pause") {
        if (!options.issueExecutionCancellation) {
          throw new Error(
            "Issue-tree pause requires the execution cancellation boundary",
          );
        }
        const affectedIssues = affectedIssueIds.length === 0
          ? []
          : await tx
            .select({
              id: issues.id,
              ownershipEpoch: issues.ownershipEpoch,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.id, affectedIssueIds),
                inArray(issues.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .orderBy(asc(issues.id))
            .for("update");
        const pauseInterruptions: RequestedRunningIssueInterruptions[] = [];
        for (const issue of affectedIssues) {
          pauseInterruptions.push(
            await options.issueExecutionCancellation
              .requestRunningIssueInterruptionsInTransaction(tx, {
                companyId,
                issueId: issue.id,
                ownershipEpoch: issue.ownershipEpoch,
                reason: "active_subtree_pause_hold",
                actor: cancellationActorForHold(createdHold),
                now,
              }),
          );
        }
        if (actorUserId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedIssues,
            actorUserId,
            subtype: "tree_control_pause",
            sourceCommandId: createdHold.id,
            idempotencyKey: `issue-tree-pause:${createdHold.id}`,
            committedAt: now,
          });
        }
        return {
          hold: createdHold,
          members: createdMembers,
          preview: committedPreview,
          pauseInterruptions,
          cancelCancellations: [] as RequestedScopedRunCancellations[],
          cancelledIssueIds: [],
        };
      }

      if (input.mode === "cancel") {
        if (!options.issueExecutionCancellation) {
          throw new Error(
            "Issue-tree cancellation requires the execution cancellation boundary",
          );
        }
        const rows = affectedIssueIds.length === 0
          ? []
          : await tx
            .update(issues)
            .set({
              boardPresentationStatus: "cancelled",
              lifecycleStatus: "cancelled",
              disposition: {
                message: `Cancelled by issue-tree hold ${createdHold.id}`,
                structuredResult: {
                  kind: "issue_tree_control",
                  holdId: createdHold.id,
                },
              },
              cancelledAt: now,
              completedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.id, affectedIssueIds),
                inArray(issues.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .returning({
              id: issues.id,
              companyId: issues.companyId,
              ownershipEpoch: issues.ownershipEpoch,
              identifier: issues.identifier,
              title: issues.title,
              boardPresentationStatus: issues.boardPresentationStatus,
              ownerAgentId: issues.ownerAgentId,
            });
        if (actorUserId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId,
            affectedIssues: rows.map((issue) => ({
              id: issue.id,
              ownershipEpoch: issue.ownershipEpoch,
            })),
            actorUserId,
            subtype: "tree_control_cancel",
            sourceCommandId: createdHold.id,
            idempotencyKey: `issue-tree-cancel:${createdHold.id}`,
            committedAt: now,
          });
        }
        const cancelCancellations: RequestedScopedRunCancellations[] = [];
        for (const issue of rows) {
          cancelCancellations.push(
            await options.issueExecutionCancellation
              .requestScopeCancellationsInTransaction(tx, {
                companyId,
                issueId: issue.id,
                selector: {
                  kind: "ownership_epoch",
                  ownershipEpoch: issue.ownershipEpoch,
                },
                reason: "issue_tree_cancelled",
                actor: cancellationActorForHold(createdHold),
                now,
              }),
          );
        }
        return {
          hold: createdHold,
          members: createdMembers,
          preview: committedPreview,
          pauseInterruptions: [] as RequestedRunningIssueInterruptions[],
          cancelCancellations,
          cancelledIssueIds: rows.map((issue) => issue.id),
        };
      }

      return {
        hold: createdHold,
        members: createdMembers,
        preview: committedPreview,
        pauseInterruptions: [] as RequestedRunningIssueInterruptions[],
        cancelCancellations: [] as RequestedScopedRunCancellations[],
        cancelledIssueIds: [],
      };
    });

    if (options.issueExecutionCancellation) {
      for (const requested of applied.pauseInterruptions) {
        void options.issueExecutionCancellation
          .reconcileRequestedRunningIssueInterruptions(requested)
          .catch(() => {
            // The durable cancellation intent remains restart-reconcilable.
          });
      }
      for (const requested of applied.cancelCancellations) {
        void options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(requested)
          .catch(() => {
            // The durable cancellation intent remains restart-reconcilable.
          });
      }
    }
    return {
      hold: toHold(applied.hold, applied.members),
      preview: applied.preview,
      cancelledIssueIds: applied.cancelledIssueIds,
    };
  }

  async function restoreIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: ActorInput;
    },
  ): Promise<RestoreTreeStatusResult> {
    const restoreHold = await getHold(companyId, restoreHoldId);
    if (!restoreHold) throw notFound("Issue tree hold not found");
    if (restoreHold.rootIssueId !== rootIssueId) {
      throw unprocessable("Issue tree hold does not belong to the requested root issue");
    }
    if (restoreHold.mode !== "restore") {
      throw unprocessable("Issue tree hold is not a restore operation");
    }

    const activeCancelHolds = await listHolds(companyId, rootIssueId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const cancelSnapshotByIssueId = new Map<string, IssueTreeHoldMember>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        if (!member.skipped && !cancelSnapshotByIssueId.has(member.issueId)) {
          cancelSnapshotByIssueId.set(member.issueId, member);
        }
      }
    }

    const restoreIssueIds = [...new Set((restoreHold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.issueId))];
    const restoreStatusByIssueId = new Map<string, IssueStatus>();
    for (const issueId of restoreIssueIds) {
      const snapshot = cancelSnapshotByIssueId.get(issueId);
      if (!snapshot) continue;
      const restoredStatus = restoreStatusFromCancelSnapshot(coerceIssueStatus(snapshot.issueStatus));
      if (restoredStatus) restoreStatusByIssueId.set(issueId, restoredStatus);
    }

    const issueIdsByStatus = new Map<IssueStatus, string[]>();
    for (const [issueId, status] of restoreStatusByIssueId) {
      const current = issueIdsByStatus.get(status) ?? [];
      current.push(issueId);
      issueIdsByStatus.set(status, current);
    }

    const now = new Date();
    const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
    const updatedIssues = await db.transaction(async (tx) => {
      const restored: TreeStatusUpdateResult["updatedIssues"] = [];
      const restoredForLedger: NamedBoardLifecycleAffectedIssue[] = [];
      for (const [status, issueIdsForStatus] of issueIdsByStatus) {
        if (issueIdsForStatus.length === 0) continue;
        const rows = await tx
          .update(issues)
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
              eq(issues.companyId, companyId),
              inArray(issues.id, issueIdsForStatus),
              eq(issues.lifecycleStatus, "cancelled"),
              eq(issues.boardPresentationStatus, "cancelled"),
            ),
          )
          .returning({
            id: issues.id,
            ownershipEpoch: issues.ownershipEpoch,
            boardPresentationStatus: issues.boardPresentationStatus,
            ownerAgentId: issues.ownerAgentId,
          });
        restoredForLedger.push(
          ...rows.map((issue) => ({
            id: issue.id,
            ownershipEpoch: issue.ownershipEpoch,
          })),
        );
        restored.push(...rows.map((issue) => ({
          id: issue.id,
          boardPresentationStatus:
            coerceIssueStatus(issue.boardPresentationStatus),
          ownerAgentId: issue.ownerAgentId,
        })));
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(issueTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredIssueIds: restored.map((issue) => issue.id),
            },
            updatedAt: now,
          })
          .where(and(eq(issueTreeHolds.companyId, companyId), inArray(issueTreeHolds.id, releasedCancelHoldIds)));
      }

      await tx
        .update(issueTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredIssueIds: restored.map((issue) => issue.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.id, restoreHoldId)));

      const actorUserId =
        restoreHold.createdByActorType === "user"
          ? restoreHold.createdByUserId
          : null;
      if (
        restoreHold.createdByActorType === "user" &&
        (!actorUserId || namedBoardActorUserId(input.actor) !== actorUserId)
      ) {
        throw unprocessable(
          "Restore application actor does not match the named user who issued the restore command",
        );
      }
      if (actorUserId) {
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId,
          affectedIssues: restoredForLedger,
          actorUserId,
          subtype: "tree_control_restore",
          sourceCommandId: restoreHoldId,
          idempotencyKey: `issue-tree-restore:${restoreHoldId}`,
          committedAt: now,
        });
      }

      return restored;
    });

    return {
      updatedIssueIds: updatedIssues.map((issue) => issue.id),
      updatedIssues,
      releasedCancelHoldIds,
      restoreHold: await getHold(companyId, restoreHoldId),
    };
  }

  async function getHold(companyId: string, holdId: string) {
    const hold = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await db
      .select()
      .from(issueTreeHoldMembers)
      .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));
    return toHold(hold, members);
  }

  async function listHolds(
    companyId: string,
    rootIssueId: string,
    input?: {
      status?: IssueTreeHold["status"];
      mode?: IssueTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    const whereClauses = [
      eq(issueTreeHolds.companyId, companyId),
      eq(issueTreeHolds.rootIssueId, rootIssueId),
    ];
    if (input?.status) whereClauses.push(eq(issueTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(issueTreeHolds.mode, input.mode));

    const holds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => toHold(hold));
    }

    const holdIds = holds.map((hold) => hold.id);
    const members = await db
      .select()
      .from(issueTreeHoldMembers)
      .where(
        and(
          eq(issueTreeHoldMembers.companyId, companyId),
          inArray(issueTreeHoldMembers.holdId, holdIds),
        ),
      )
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));

    const membersByHoldId = new Map<string, HoldMemberRow[]>();
    for (const member of members) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }

    return holds.map((hold) => toHold(hold, membersByHoldId.get(hold.id) ?? []));
  }

  async function releaseHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
      /** Internal cleanup/choreography never qualifies as a board action. */
      internal?: true;
    },
  ) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(issueTreeHolds)
        .where(
          and(
            eq(issueTreeHolds.id, holdId),
            eq(issueTreeHolds.companyId, companyId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Issue tree hold not found");
      if (existing.rootIssueId !== rootIssueId) {
        throw unprocessable(
          "Issue tree hold does not belong to the requested root issue",
        );
      }
      if (
        existing.mode !== "pause" &&
        !(input.internal && existing.mode === "restore")
      ) {
        throw unprocessable("Only pause holds can be released directly");
      }
      if (existing.status === "released") {
        throw conflict("Issue tree hold is already released");
      }

      const now = new Date();
      const [updated] = await tx
        .update(issueTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId:
            input.actor.userId ??
            (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? null,
          releasePolicy: input.releasePolicy
            ? (normalizeReleasePolicy(
                input.releasePolicy,
              ) as unknown as Record<string, unknown>)
            : existing.releasePolicy,
          releaseMetadata: input.metadata ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueTreeHolds.id, holdId),
            eq(issueTreeHolds.companyId, companyId),
            eq(issueTreeHolds.status, "active"),
          ),
        )
        .returning();
      if (!updated) {
        throw conflict("Issue tree hold changed while it was released");
      }

      const members = await tx
        .select()
        .from(issueTreeHoldMembers)
        .where(
          and(
            eq(issueTreeHoldMembers.companyId, companyId),
            eq(issueTreeHoldMembers.holdId, holdId),
          ),
        )
        .orderBy(
          asc(issueTreeHoldMembers.depth),
          asc(issueTreeHoldMembers.createdAt),
          asc(issueTreeHoldMembers.issueId),
        );

      const actorUserId = input.internal
        ? null
        : namedBoardActorUserId(input.actor);
      if (actorUserId) {
        const affectedIssueIds = members
          .filter((member) => !member.skipped)
          .map((member) => member.issueId);
        const affectedIssues = affectedIssueIds.length === 0
          ? []
          : await tx
            .select({
              id: issues.id,
              ownershipEpoch: issues.ownershipEpoch,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.id, affectedIssueIds),
              ),
            )
            .orderBy(asc(issues.id))
            .for("update");
        const sourceCommandId = deterministicTreeCommandId(
          "issue-tree-release",
          `${companyId}:${holdId}`,
        );
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId,
          affectedIssues,
          actorUserId,
          subtype: "tree_control_release",
          sourceCommandId,
          idempotencyKey: `issue-tree-release:${holdId}`,
          committedAt: now,
        });
      }

      return toHold(updated, members);
    });
  }

  return {
    listTreeIssues,
    preview,
    createHold,
    restoreIssueStatusesForHold,
    getHold,
    listHolds,
    getActivePauseHoldGate,
    releaseHold,
  };
}
