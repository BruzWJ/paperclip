import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  documentRevisions,
  goals,
  routineRuns,
  executionWorkspaces,
  issueApprovals,
  issueAttachments,
  issueCreateIdempotencyKeys,
  issueExecutionWorkspaceBindings,
  issueExecutionRefs,
  issueInboxArchives,
  issueLabels,
  issueWatchdogs,
  issueRelations,
  issueComments,
  issueCommentProjectionSources,
  issueSessionMessages,
  issueDocuments,
  issueReadStates,
  issues,
  labels,
  projectWorkspaces,
  projects,
  workspaceOperations,
  authUsers,
} from "@paperclipai/db";
import type {
  BoardIssueComment,
  BoardIssueCommentAuthor,
  BoardIssueCommentGroupPage,
  BoardIssueCommentParentReference,
  BoardIssueCommentRunState,
  BoardIssueCommentThreadPage,
  BoardIssueRunSegmentEntry,
  BoardIssueRunSegmentPart,
  BoardIssueThreadEntry,
  IssueComment,
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  IssueBlockerAttention,
  IssueBlockedInboxAttention,
  IssueBlockedInboxIssueRef,
  IssueExecutionRunStatus,
  IssueRelationIssueSummary,
  IssueStatus,
  IssueWatchdog,
  LowTrustBoundary,
} from "@paperclipai/shared";
import {
  clampIssueRequestDepth,
  extractAgentMentionIds,
  extractProjectMentionIds,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
} from "@paperclipai/shared";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolvePinnedIssueWorkspaceStrategyType,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
  type ParsedExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { buildInitialIssueMonitorFields, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { syncIssue } from "./issue-references.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  InvokableIssueOwnerRejected,
  resolveInvokableIssueOwnerFromDb,
} from "./agent-invokability.js";
import { summarizeIssueWatchdog } from "./issue-watchdogs.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { finalizeSummarySlotsForTerminalIssue } from "./summary-slot-finalization.js";
import { resolveCurrentIssueOwnerRunLinkages } from "./productive-run-linkage.js";
import {
  listLiveOwnerIssueIds,
  readIssueExecutionRun,
  resolveIssueExecutionRunIdentityById,
} from "./issue-execution-run-service.js";

const ALL_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
const DEFAULT_BOARD_COMMENT_ROOT_LIMIT = 100;
const DEFAULT_BOARD_COMMENT_ENTRY_LIMIT = 100;

type BoardCommentCursor = {
  version: 1;
  kind: "roots" | "thread";
  issueId: string;
  rootCommentId: string | null;
  sequence: number;
  id: string;
};

function encodeBoardCommentCursor(cursor: BoardCommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeBoardCommentCursor(
  encoded: string | null | undefined,
  expected: Pick<BoardCommentCursor, "kind" | "issueId" | "rootCommentId">,
): BoardCommentCursor | null {
  if (!encoded) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw unprocessable("Invalid issue comment cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unprocessable("Invalid issue comment cursor");
  }
  const candidate = value as Partial<BoardCommentCursor>;
  if (
    candidate.version !== 1 ||
    candidate.kind !== expected.kind ||
    candidate.issueId !== expected.issueId ||
    candidate.rootCommentId !== expected.rootCommentId ||
    !Number.isSafeInteger(candidate.sequence) ||
    Number(candidate.sequence) < 0 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0
  ) {
    throw unprocessable("Issue comment cursor does not belong to this view");
  }
  return candidate as BoardCommentCursor;
}

function boundedBoardCommentPageSize(
  requested: number | null | undefined,
  fallback: number,
): number {
  if (requested == null) return fallback;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw unprocessable("Issue comment page limit must be a positive integer");
  }
  return Math.min(requested, MAX_ISSUE_COMMENT_PAGE_LIMIT);
}

function boardRunState(
  status: IssueExecutionRunStatus | null | undefined,
): BoardIssueCommentRunState | null {
  if (status === "queued" || status === "scheduled_retry") return "queued";
  if (status === "running") return "working";
  return status ? "terminal" : null;
}

function compareCanonicalEntry(
  left: { canonicalSequence: number; id: string },
  right: { canonicalSequence: number; id: string },
): number {
  return left.canonicalSequence - right.canonicalSequence || left.id.localeCompare(right.id);
}

function isAfterBoardCommentCursor(
  entry: { canonicalSequence: number; id: string },
  cursor: BoardCommentCursor | null,
): boolean {
  if (!cursor) return true;
  return entry.canonicalSequence > cursor.sequence ||
    (entry.canonicalSequence === cursor.sequence && entry.id > cursor.id);
}
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
export const ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS = 100;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH = 8;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES = 100;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE = 20;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!(ALL_ISSUE_STATUSES as readonly string[]).includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function workspaceWorktreeRequiresProjectDetails() {
  return {
    code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
    remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
  };
}

function assertExplicitPinnedWorktreeIssueRunnable(input: {
  projectId: string | null | undefined;
  projectWorkspaceId: string | null | undefined;
  executionWorkspaceId: string | null | undefined;
  executionWorkspacePreference: string | null | undefined;
  executionWorkspaceSettings: unknown;
}) {
  const settings = parseIssueExecutionWorkspaceSettings(input.executionWorkspaceSettings);
  const mode = settings?.mode;
  if (mode !== "isolated_workspace" && mode !== "operator_branch") return;

  const resolvedMode = mode as ParsedExecutionWorkspaceMode;
  if (
    isUnrunnableWorktreeCombo({
      issue: {
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
      },
      resolvedMode,
      resolvedStrategy: resolvePinnedIssueWorkspaceStrategyType({
        mode: resolvedMode,
        issueSettings: settings,
      }),
      reusableExecutionWorkspaceAvailable:
        input.executionWorkspacePreference === "reuse_existing" &&
        Boolean(input.executionWorkspaceId),
    })
  ) {
    throw unprocessable(
      WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
      workspaceWorktreeRequiresProjectDetails(),
    );
  }
}

function buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(
  settings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return {
    environmentId: settings?.environmentId ?? null,
    provisionCommand: settings?.workspaceStrategy?.provisionCommand ?? null,
    teardownCommand: settings?.workspaceStrategy?.teardownCommand ?? null,
    workspaceRuntime: settings?.workspaceRuntime ?? null,
  };
}

// Accepted-plan children are not realized yet, so carry only unresolved
// workspace intent and let the first child run render/persist its own branch.
function buildPreRealizationExecutionWorkspaceSettings(raw: unknown): Record<string, unknown> | null {
  const settings = parseIssueExecutionWorkspaceSettings(raw, { includeEnvironmentId: true });
  if (!settings) return null;
  const mode =
    settings.mode && settings.mode !== "inherit" && settings.mode !== "reuse_existing"
      ? settings.mode
      : null;
  const next: Record<string, unknown> = {};
  if (mode) next.mode = mode;
  if (settings.environmentId !== undefined) next.environmentId = settings.environmentId;
  if (settings.workspaceRuntime) next.workspaceRuntime = settings.workspaceRuntime;
  if (settings.workspaceStrategy) {
    next.workspaceStrategy = {
      type: settings.workspaceStrategy.type,
      ...(settings.workspaceStrategy.baseRef ? { baseRef: settings.workspaceStrategy.baseRef } : {}),
      ...(settings.workspaceStrategy.branchTemplate ? { branchTemplate: settings.workspaceStrategy.branchTemplate } : {}),
      ...(settings.workspaceStrategy.worktreeParentDir ? { worktreeParentDir: settings.workspaceStrategy.worktreeParentDir } : {}),
      ...(settings.workspaceStrategy.provisionCommand ? { provisionCommand: settings.workspaceStrategy.provisionCommand } : {}),
      ...(settings.workspaceStrategy.teardownCommand ? { teardownCommand: settings.workspaceStrategy.teardownCommand } : {}),
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

// Express's default `qs` parser binds repeated query keys to a `string[]`,
// so a request like `?status=todo&status=in_progress` arrives here as an
// array. Single-key + comma-separated forms remain valid too; normalize the
// supported shapes once so the service contract matches runtime reality.
export function parseStatusFilter(
  input: string | readonly string[] | undefined,
): IssueStatus[] {
  if (input === undefined || input === null) return [];
  const entries = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return entries
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((status) => status.trim())
    .filter(
      (status): status is IssueStatus =>
        (ALL_ISSUE_STATUSES as readonly string[]).includes(status),
    );
}

export interface IssueFilters {
  attention?: "blocked";
  status?: string | readonly string[];
  /**
   * Filter by owner agent ID.
   * - `string` (UUID): match issues owned by that agent.
   * - `null`: match issues without an agent owner (IS NULL).
   * - The literal string `"null"` is also accepted as a sentinel for `null`
   *   so that query-string callers can pass `?ownerAgentId=null` directly.
   *   The route layer normalises it before calling the service, but the service
   *   also normalises it for direct callers.
   */
  ownerAgentId?: string | null;
  participantAgentId?: string;
  ownerUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includePluginOperations?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  lowTrustBoundary?: LowTrustBoundary & { companyId: string };
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
}

type IssueRow = typeof issues.$inferSelect;
type IssueControlStateUpdate = Partial<
  Omit<
    typeof issues.$inferInsert,
    | "id"
    | "companyId"
    | "parentId"
    | "parentOwnershipEpoch"
    | "request"
    | "title"
    | "ownerKind"
    | "ownerAgentId"
    | "ownerUserId"
    | "ownerAssignmentSource"
    | "ownershipEpoch"
    | "creatorKind"
    | "creatorAuthorityId"
    | "creatorAdapterConfigRevisionId"
    | "creatorUserId"
    | "creatorPluginInstallationId"
    | "creatorPluginKey"
    | "creatorCallbackKey"
    | "creatorCallbackVersion"
    | "creatorRoutineId"
    | "creatorRoutineDispatchId"
    | "creatorSystemSourceKind"
    | "creatorSystemSourceId"
    | "lifecycleStatus"
    | "disposition"
    | "completedAt"
    | "cancelledAt"
    | "createdAt"
    | "executionWorkspaceId"
  >
> & {
  labelIds?: string[];
  blockedByIssueIds?: string[];
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type IssueLabelRow = typeof labels.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  sourceKind: string;
  sourceRecordId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueLabelEnrichment = {
  labels: IssueLabelRow[];
  labelIds: string[];
  watchdog?: IssueWatchdog | null;
};
type IssueWithLabels = IssueRow & IssueLabelEnrichment;
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type CanonicalIssueListRow = IssueRow;
type CanonicalIssueWithLabels = CanonicalIssueListRow & IssueLabelEnrichment;
type CanonicalIssueWithLabelsAndRun = CanonicalIssueWithLabels & {
  activeRun: IssueActiveRunRow | null;
};
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueReadStat = {
  issueId: string;
  myLastReadAt: Date | null;
};
type IssueLastActivityStat = {
  issueId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};

type IssueUserContextInput = {
  creatorUserId: string | null;
  ownerUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
type IssueRelationSummaryMap = {
  blockedBy: IssueRelationIssueSummary[];
  blocks: IssueRelationIssueSummary[];
};
type IssueBlockerDiagnosticsIssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: typeof ALL_ISSUE_STATUSES[number];
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};
type IssueSubtreeDiagnosticsIssueRow = IssueBlockerDiagnosticsIssueRow & {
  depth: number;
  createdAt: Date;
  updatedAt: Date;
};
type IssueSubtreeDiagnosticsBlockerRow = IssueBlockerDiagnosticsIssueRow & {
  blockedIssueId: string;
  relationCreatedAt: Date;
};
type IssueSubtreeDiagnosticsBlockerResultRow = IssueSubtreeDiagnosticsBlockerRow & {
  rowNumber: number | string;
};
export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  /** Blockers whose status is `done` but whose execution workspace has not yet finalized. */
  pendingFinalizeBlockerIssueIds: string[];
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
const ISSUE_LIST_REQUEST_MAX_CHARS = 1200;
const ISSUE_LIST_REQUEST_MAX_BYTES = ISSUE_LIST_REQUEST_MAX_CHARS * 4;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string, maxChars: number): string {
  return truncateByCodePoint(Buffer.from(value, "base64").toString("utf8"), maxChars);
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

/**
 * Returns the set of execution-workspace ids whose most recent workspace operation
 * is NOT a successful `workspace_finalize`. These workspaces have either an in-flight
 * run, a failed finalize, or never reached the finalize barrier — dependents that
 * read this workspace must wait until finalize succeeds.
 *
 * Workspaces with no recorded operations are considered finalized (nothing has
 * touched them since they were realized).
 */
export async function listUnfinalizedExecutionWorkspaceIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceIds: string[],
): Promise<Set<string>> {
  const unfinalized = new Set<string>();
  if (executionWorkspaceIds.length === 0) return unfinalized;

  // Pull every workspace op for the candidate workspaces and pick the latest per
  // workspace in memory. Per-workspace LATERAL queries would be tighter, but the
  // candidate set is tiny in practice (one workspace per blocker per readiness call).
  const rows = await dbOrTx
    .select({
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
      ),
    );

  const latestByWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    const current = latestByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const workspaceId of executionWorkspaceIds) {
    const latest = latestByWorkspace.get(workspaceId);
    if (!latest) continue; // no ops recorded → treat as finalized
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    unfinalized.add(workspaceId);
  }

  return unfinalized;
}

async function listPendingFinalizeBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerWorkspacePairs: Array<{ blockerIssueId: string; executionWorkspaceId: string }>,
): Promise<Set<string>> {
  const pending = new Set<string>();
  const blockerIssueIds = [...new Set(blockerWorkspacePairs.map((pair) => pair.blockerIssueId))];
  const executionWorkspaceIds = [...new Set(blockerWorkspacePairs.map((pair) => pair.executionWorkspaceId))];
  if (blockerIssueIds.length === 0 || executionWorkspaceIds.length === 0) return pending;
  const blockerWorkspaceKeys = new Set(
    blockerWorkspacePairs.map((pair) => `${pair.blockerIssueId}:${pair.executionWorkspaceId}`),
  );

  const rows = await dbOrTx
    .select({
      issueId: workspaceOperations.issueId,
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
        or(inArray(workspaceOperations.issueId, blockerIssueIds), isNull(workspaceOperations.issueId)),
      ),
    );

  const latestAttributedByBlockerWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  const latestUnattributedByWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    if (row.issueId) {
      const key = `${row.issueId}:${row.executionWorkspaceId}`;
      if (!blockerWorkspaceKeys.has(key)) continue;
      const current = latestAttributedByBlockerWorkspace.get(key);
      if (!current || row.startedAt > current.startedAt) {
        latestAttributedByBlockerWorkspace.set(key, {
          phase: row.phase,
          status: row.status,
          startedAt: row.startedAt,
        });
      }
      continue;
    }

    const current = latestUnattributedByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestUnattributedByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const pair of blockerWorkspacePairs) {
    const latest = latestAttributedByBlockerWorkspace.get(`${pair.blockerIssueId}:${pair.executionWorkspaceId}`)
      ?? latestUnattributedByWorkspace.get(pair.executionWorkspaceId);
    if (!latest) continue; // no ops recorded -> nothing to finalize for this blocker
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    pending.add(pair.blockerIssueId);
  }

  return pending;
}

/**
 * Returns whether a specific run's operations on a specific execution workspace
 * reached the workspace_finalize barrier.
 *
 * Runs with no operations on the workspace are considered finalized because
 * they never touched the workspace state that accept/review gates protect.
 */
export async function runWorkspaceIsFinalized(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceId: string,
  runId: string,
): Promise<boolean> {
  const rows = await dbOrTx
    .select({
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId),
        eq(workspaceOperations.runId, runId),
      ),
    );

  let latest: { phase: string; status: string; startedAt: Date } | null = null;
  for (const row of rows) {
    if (!latest || row.startedAt > latest.startedAt) latest = row;
  }

  if (!latest) return true;
  return latest.phase === "workspace_finalize" && latest.status === "succeeded";
}

async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of uniqueIssueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }
  if (uniqueIssueIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.boardPresentationStatus,
      blockerExecutionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .leftJoin(
      issueExecutionWorkspaceBindings,
      and(
        eq(issueExecutionWorkspaceBindings.companyId, issues.companyId),
        eq(issueExecutionWorkspaceBindings.issueId, issues.id),
        eq(issueExecutionWorkspaceBindings.ownershipEpoch, issues.ownershipEpoch),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    );

  // Collect issue/workspace pairs of "done" blockers — these are the only ones
  // subject to the workspace-finalize barrier. Blockers that aren't done already
  // mark the dependent as not-ready and don't need a finalize check.
  const doneBlockerWorkspacePairs: Array<{ blockerIssueId: string; executionWorkspaceId: string }> = [];
  for (const row of blockerRows) {
    if (row.blockerStatus === "done" && row.blockerExecutionWorkspaceId) {
      doneBlockerWorkspacePairs.push({
        blockerIssueId: row.blockerIssueId,
        executionWorkspaceId: row.blockerExecutionWorkspaceId,
      });
    }
  }
  const pendingFinalizeBlockerIssueIds = await listPendingFinalizeBlockerIssueIds(
    dbOrTx,
    companyId,
    doneBlockerWorkspacePairs,
  );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.issueId) ?? createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    } else if (
      row.blockerExecutionWorkspaceId &&
      pendingFinalizeBlockerIssueIds.has(row.blockerIssueId)
    ) {
      // Workspace-finalize barrier: the blocker's most recent run on its
      // execution workspace hasn't recorded a successful workspace_finalize.
      // Treat the dependent as not-ready until sync-back lands (or the run
      // finalizes); subsequent finalization will re-evaluate readiness.
      // `allBlockersDone` is cleared too so that callers using it as a
      // proxy for "this dependent can proceed" still see the gate.
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.pendingFinalizeBlockerIssueIds.push(row.blockerIssueId);
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(issues.boardPresentationStatus, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.creatorUserId} = ${userId}
      OR ${issues.ownerUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      (
        ${issues.creatorKind} = 'agent-execution'
        AND ${issues.creatorAuthorityId} = ${agentId}
      )
      OR ${issues.ownerAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.creatorUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.ownerUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

function issueLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
    )
  `;
}

function issueLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'issue'
        AND ${activityLog.entityId} = ${issues.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function issueCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = issueLatestCommentAtExpr(companyId);
  const latestLogAt = issueLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${issues.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND NOT (
          EXISTS (
            SELECT 1
            FROM ${activityLog}
            WHERE ${activityLog.companyId} = ${companyId}
              AND ${activityLog.entityType} = 'issue'
              AND ${activityLog.entityId} = ${issues.id}::text
              AND ${activityLog.action} = 'issue.updated'
              AND ${activityLog.createdAt} > ${issueInboxArchives.archivedAt}
              AND ${activityLog.details}->>'status' IN ('in_review', 'blocked', 'done')
              AND ${activityLog.details}->'_previous'->>'status'
                IS DISTINCT FROM ${activityLog.details}->>'status'
          )
          OR EXISTS (
            SELECT 1
            FROM ${issueComments}
            WHERE ${issueComments.issueId} = ${issues.id}
              AND ${issueComments.companyId} = ${companyId}
              AND ${issueComments.createdAt} > ${issueInboxArchives.archivedAt}
              AND (
                (
                  ${issueComments.authorType} = 'user'
                  AND
                  ${issueComments.authorUserId} IS NOT NULL
                  AND ${issueComments.authorUserId} <> ${userId}
                )
                OR POSITION(${`](user://${userId})`} IN ${issueComments.body}) > 0
              )
          )
        )
    )
  `;
}

const LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS = [
  "plugin:paperclipai.content-machine:case",
  "plugin:paperclipai.content-machine:evaluation",
  "plugin:paperclipai.content-machine:source-sync",
] as const;

function nonPluginOperationIssueCondition() {
  return sql<boolean>`NOT (
    ${issues.originKind} LIKE 'plugin:%:operation'
    OR ${issues.originKind} LIKE 'plugin:%:operation:%'
    OR ${inArray(issues.originKind, LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS)}
  )`;
}

function shouldIncludePluginOperationIssues(filters: IssueFilters | undefined) {
  return Boolean(
    filters?.includePluginOperations ||
    filters?.originKind ||
    filters?.originKindPrefix ||
    filters?.originId ||
    filters?.projectId,
  );
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.creatorUserId === userId ? normalizeDate(issue.createdAt) : null;
  const ownedTouchAt = issue.ownerUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, ownedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestIssueActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

type InboxArchiveAttributionRow = {
  issueId: string;
  archivedAt: Date;
  archivedByActorType: "user" | "agent";
  archivedByAgentId: string | null;
  archivedByRunId: string | null;
};

async function inboxArchiveRowsForIssues(
  dbOrTx: Db,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<InboxArchiveAttributionRow[]> {
  if (issueIds.length === 0) return [];
  return dbOrTx
    .select({
      issueId: issueInboxArchives.issueId,
      archivedAt: issueInboxArchives.archivedAt,
      archivedByActorType: issueInboxArchives.archivedByActorType,
      archivedByAgentId: issueInboxArchives.archivedByAgentId,
      archivedByRunId: issueInboxArchives.archivedByRunId,
    })
    .from(issueInboxArchives)
    .where(and(
      eq(issueInboxArchives.companyId, companyId),
      eq(issueInboxArchives.userId, userId),
      inArray(issueInboxArchives.issueId, issueIds),
    ));
}

function activeInboxArchiveFields(
  archive: InboxArchiveAttributionRow | undefined,
  lastActivityAt: Date,
) {
  if (!archive || archive.archivedAt.getTime() < lastActivityAt.getTime()) return {};
  return {
    archivedAt: archive.archivedAt,
    archivedByActorType: archive.archivedByActorType,
    archivedByAgentId: archive.archivedByAgentId,
    archivedByRunId: archive.archivedByRunId,
  };
}

function issueListOrderBy(
  companyId: string,
  {
    hasSearch,
    priorityOrder,
    searchOrder,
    sortField,
    sortDir,
  }: {
    hasSearch: boolean;
    priorityOrder: SQL;
    searchOrder: SQL;
    sortField?: IssueFilters["sortField"];
    sortDir?: IssueFilters["sortDir"];
  },
) {
  const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
  if (sortField === "updated") {
    const activityOrder = sortDir === "asc"
      ? asc(canonicalLastActivityAt)
      : desc(canonicalLastActivityAt);
    const updatedOrder = sortDir === "asc" ? asc(issues.updatedAt) : desc(issues.updatedAt);
    const idOrder = sortDir === "asc" ? asc(issues.id) : desc(issues.id);
    return hasSearch
      ? [asc(searchOrder), activityOrder, updatedOrder, idOrder]
      : [activityOrder, updatedOrder, idOrder];
  }

  return [
    hasSearch ? asc(searchOrder) : asc(priorityOrder),
    asc(priorityOrder),
    desc(canonicalLastActivityAt),
    desc(issues.updatedAt),
    desc(issues.id),
  ];
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.issueId);
      if (existing) existing.push(row.label);
      else map.set(row.issueId, [row.label]);
    }
  }
  return map;
}

async function withIssueLabels<
  T extends Pick<
    IssueRow,
    "id" | "companyId" | "ownershipEpoch" | "boardPresentationStatus"
  >,
>(dbOrTx: any, rows: T[]): Promise<Array<T & IssueLabelEnrichment>> {
  if (rows.length === 0) return [];
  const issueIds = rows.map((row) => row.id);
  const [labelsByIssueId, watchdogByIssueId, workspaceBindings] = await Promise.all([
    labelMapForIssues(dbOrTx, issueIds),
    watchdogMapForIssues(dbOrTx, rows),
    dbOrTx
      .select({
        companyId: issueExecutionWorkspaceBindings.companyId,
        issueId: issueExecutionWorkspaceBindings.issueId,
        ownershipEpoch: issueExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
      })
      .from(issueExecutionWorkspaceBindings)
      .where(inArray(issueExecutionWorkspaceBindings.issueId, issueIds)),
  ]);
  const issueScopeById = new Map(
    rows.map((row) => [
      row.id,
      { companyId: row.companyId, ownershipEpoch: row.ownershipEpoch },
    ]),
  );
  const currentBindingByIssueId = new Map<string, string>();
  for (const binding of workspaceBindings as Array<{
    companyId: string;
    issueId: string;
    ownershipEpoch: number;
    executionWorkspaceId: string;
  }>) {
    const scope = issueScopeById.get(binding.issueId);
    if (
      scope?.companyId === binding.companyId &&
      scope.ownershipEpoch === binding.ownershipEpoch
    ) {
      currentBindingByIssueId.set(binding.issueId, binding.executionWorkspaceId);
    }
  }
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      executionWorkspaceId: currentBindingByIssueId.get(row.id) ?? null,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
      watchdog: watchdogByIssueId.get(row.id) ?? null,
    };
  });
}

async function watchdogMapForIssues<
  T extends Pick<IssueRow, "id" | "companyId">,
>(dbOrTx: any, rows: T[]): Promise<Map<string, IssueWatchdog>> {
  const map = new Map<string, IssueWatchdog>();
  if (rows.length === 0) return map;
  const byCompany = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byCompany.get(row.companyId) ?? [];
    ids.push(row.id);
    byCompany.set(row.companyId, ids);
  }
  for (const [companyId, issueIds] of byCompany.entries()) {
    for (const issueIdChunk of chunkList([...new Set(issueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const watchdogRows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, issueIdChunk),
          eq(issueWatchdogs.status, "active"),
        ));
      for (const row of watchdogRows) {
        map.set(row.issueId, summarizeIssueWatchdog(row));
      }
    }
  }
  return map;
}

const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES = [
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

function lowTrustBoundaryIssueCondition(
  companyId: string,
  boundary: (LowTrustBoundary & { companyId: string }) | null | undefined,
) {
  if (!boundary || boundary.companyId !== companyId) return null;
  const clauses: SQL[] = [];
  const issueIds = [...new Set(boundary.issueIds ?? [])];
  const projectIds = [...new Set(boundary.projectIds ?? [])];
  if (issueIds.length > 0) clauses.push(inArray(issues.id, issueIds));
  if (projectIds.length > 0) clauses.push(inArray(issues.projectId, projectIds));
  if (boundary.rootIssueId) {
    clauses.push(sql<boolean>`
      ${issues.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.id} = ${boundary.rootIssueId}
          UNION
          SELECT ${issues.id}
          FROM ${issues}
          JOIN descendants ON ${issues.parentId} = descendants.id
          WHERE ${issues.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  if (clauses.length === 0) return sql<boolean>`false`;
  return or(...clauses);
}

const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

type IssueBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};
type IssueBlockerAttentionInputNode =
  Pick<
    IssueRow,
    | "id"
    | "companyId"
    | "parentId"
    | "identifier"
    | "title"
    | "boardPresentationStatus"
    | "ownerAgentId"
    | "ownerUserId"
  >;

type IssueBlockerAttentionEdge = {
  issueId: string;
  blockerIssueId: string;
};
type IssueBlockerAttentionQueryRow = IssueBlockerAttentionNode & {
  issueId: string | null;
  blockerIssueId: string;
};
type IssueBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

async function activeRunMapForIssues<
  T extends Pick<IssueRow, "id" | "companyId">,
>(
  dbOrTx: any,
  issueRows: T[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const issueIdsByCompany = new Map<string, string[]>();
  for (const row of issueRows) {
    const ids = issueIdsByCompany.get(row.companyId) ?? [];
    ids.push(row.id);
    issueIdsByCompany.set(row.companyId, ids);
  }

  for (const [companyId, issueIds] of issueIdsByCompany) {
    for (const issueIdChunk of chunkList([...new Set(issueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const linkages = await resolveCurrentIssueOwnerRunLinkages(dbOrTx as Db, {
        companyId,
        issueIds: issueIdChunk,
      });
      for (const [issueId, linkage] of linkages) {
        map.set(issueId, {
          id: linkage.runId,
          status: linkage.runStatus,
          agentId: linkage.agentId,
          sourceKind: linkage.sourceKind,
          sourceRecordId: linkage.sourceRecordId,
          startedAt: linkage.startedAt,
          finishedAt: linkage.finishedAt,
          createdAt: linkage.createdAt,
        });
      }
    }
  }
  return map;
}

async function liveDescendantCountMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, number>> {
  const uniqueIssueIds = [...new Set(issueIds)];
  const map = new Map<string, number>();
  if (uniqueIssueIds.length === 0) return map;
  const liveRunIssueIds = await listLiveOwnerIssueIds(dbOrTx as Db, {
    companyId,
  });
  if (liveRunIssueIds.length === 0) return map;
  const liveRunIssueRows = liveRunIssueIds.map(
    (issueId) => sql`(${issueId}::uuid)`,
  );

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const targetRows = issueIdChunk.map((issueId) => sql`(${issueId}::uuid)`);
    const rows = await dbOrTx.execute(sql<{
      issueId: string;
      liveDescendantCount: number;
    }>`
      WITH RECURSIVE
        target_issues(issue_id) AS (
          VALUES ${sql.join(targetRows, sql`, `)}
        ),
        live_run_issues(issue_id) AS (
          VALUES ${sql.join(liveRunIssueRows, sql`, `)}
        ),
        live_issues(live_issue_id, parent_id) AS (
          SELECT DISTINCT live_issue.id, live_issue.parent_id
          FROM live_run_issues live_run
          JOIN issues live_issue ON live_issue.id = live_run.issue_id
          WHERE live_issue.company_id = ${companyId}
            AND live_issue.hidden_at IS NULL
            AND live_issue.harness_kind IS NULL
        ),
        live_ancestors(live_issue_id, ancestor_id, next_parent_id, visited_issue_ids) AS (
          SELECT live_issues.live_issue_id, parent.id, parent.parent_id, ARRAY[live_issues.live_issue_id, parent.id]
          FROM live_issues
          JOIN issues parent ON parent.id = live_issues.parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND parent.harness_kind IS NULL
          UNION ALL
          SELECT
            live_ancestors.live_issue_id,
            parent.id,
            parent.parent_id,
            live_ancestors.visited_issue_ids || parent.id
          FROM live_ancestors
          JOIN issues parent ON parent.id = live_ancestors.next_parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND parent.harness_kind IS NULL
            AND NOT parent.id = ANY(live_ancestors.visited_issue_ids)
        )
      SELECT
        live_ancestors.ancestor_id::text AS "issueId",
        count(DISTINCT live_ancestors.live_issue_id)::int AS "liveDescendantCount"
      FROM live_ancestors
      JOIN target_issues ON target_issues.issue_id = live_ancestors.ancestor_id
      WHERE live_ancestors.ancestor_id <> live_ancestors.live_issue_id
      GROUP BY live_ancestors.ancestor_id
    `);

    const resultRows = Array.isArray(rows) ? rows : Array.from(rows as Iterable<unknown>);
    for (const row of resultRows) {
      if (typeof row !== "object" || row === null) continue;
      const issueId = (row as { issueId?: unknown }).issueId;
      const liveDescendantCount = (row as { liveDescendantCount?: unknown }).liveDescendantCount;
      if (typeof issueId !== "string") continue;
      const count = typeof liveDescendantCount === "number"
        ? liveDescendantCount
        : Number(liveDescendantCount);
      if (Number.isFinite(count)) map.set(issueId, count);
    }
  }

  return map;
}

function createIssueBlockerAttention(input: Partial<IssueBlockerAttention> = {}): IssueBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(node: IssueBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? node?.id ?? null;
}

function appendBlockerAttentionEdges(
  edgesByIssueId: Map<string, IssueBlockerAttentionEdge[]>,
  rows: IssueBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByIssueId.get(row.issueId) ?? [];
    if (!existing.some((edge) => edge.blockerIssueId === row.blockerIssueId)) {
      existing.push(row);
      edgesByIssueId.set(row.issueId, existing);
    }
  }
}

type IssueRelationSummaryRow = {
  relatedId: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

function summarizeIssueRelationRow(row: IssueRelationSummaryRow): IssueRelationIssueSummary {
  return {
    id: row.relatedId,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus:
      row.boardPresentationStatus as IssueRelationIssueSummary["boardPresentationStatus"],
    priority: row.priority as IssueRelationIssueSummary["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

function issueRelationSortLabel(issue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title">) {
  return issue.title ?? issue.identifier ?? issue.id;
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: IssueRelationIssueSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, IssueRelationIssueSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, IssueRelationIssueSummary>();
  const edgesByIssueId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.boardPresentationStatus, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByIssueId.get(row.currentIssueId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByIssueId.set(row.currentIssueId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeIssueRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (issueId: string, seen: Set<string>): IssueRelationIssueSummary[] => {
    if (seen.has(issueId)) return [];
    const node = nodesById.get(issueId);
    if (!node || node.boardPresentationStatus === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(issueId);
    const downstreamIds = edgesByIssueId.get(issueId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, IssueRelationIssueSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(
        rootId,
        [...deduped.values()].sort((a, b) => issueRelationSortLabel(a).localeCompare(issueRelationSortLabel(b))),
      );
    }
  }

  return terminalByRoot;
}

async function listIssueBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: IssueBlockerAttentionInputNode[],
): Promise<Map<string, IssueBlockerAttention>> {
  const statusRows: IssueBlockerAttentionNode[] = issueRows;
  const roots = statusRows.filter(
    (row) => row.companyId === companyId && row.boardPresentationStatus === "blocked",
  );
  const attentionMap = new Map<string, IssueBlockerAttention>();
  for (const row of statusRows) {
    if (row.boardPresentationStatus !== "blocked") {
      attentionMap.set(row.id, createIssueBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, IssueBlockerAttentionNode>();
  const edgesByIssueId = new Map<string, IssueBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.boardPresentationStatus, "done"),
          ),
        );
      const childRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issues.parentId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, chunk),
            notInArray(
              issues.boardPresentationStatus,
              [...BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES],
            ),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByIssueId, [
        ...explicitBlockerRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
        ...childRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.issueId || nodesById.has(row.blockerIssueId)) continue;
        nodesById.set(row.blockerIssueId, {
          id: row.blockerIssueId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          boardPresentationStatus: row.boardPresentationStatus,
          ownerAgentId: row.ownerAgentId,
          ownerUserId: row.ownerUserId,
        });
        nextFrontier.add(row.blockerIssueId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeIssueIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const node of nodesById.values()) {
    if (node.ownerAgentId) agentIds.add(node.ownerAgentId);
  }

  for (const chunk of chunkList(nodeIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const linkages = await resolveCurrentIssueOwnerRunLinkages(dbOrTx as Db, {
      companyId,
      issueIds: chunk,
    });
    for (const issueId of linkages.keys()) activeIssueIds.add(issueId);
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.boardPresentationStatus !== "done")
    .map((node) => node.id);
  const explicitWaitingIssueIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(explicitWaitCandidateIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const approvalRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            inArray(issueApprovals.issueId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingIssueIds.add(row.issueId);
    }

  }

  const agentRows: IssueBlockerAttentionAgentRow[] = agentIds.size > 0
    ? await dbOrTx
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])))
    : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: sample, sampleStalledBlockerIdentifier: null };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeId, sampleStalledBlockerIdentifier: null };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.boardPresentationStatus === "done") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (explicitWaitingIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.ownerUserId && node.boardPresentationStatus !== "cancelled") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.boardPresentationStatus === "in_review") {
      const hasWaitingPath = activeIssueIds.has(node.id) || Boolean(node.ownerUserId);
      if (hasWaitingPath) {
        return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
      return { covered: false, stalled: true, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: nodeSample };
    }
    if (activeIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.boardPresentationStatus === "cancelled") {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.boardPresentationStatus === "backlog" && node.ownerAgentId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }

    const downstream = (edgesByIssueId.get(node.id) ?? []).filter(
      (edge) => nodesById.get(edge.blockerIssueId)?.boardPresentationStatus !== "done",
    );
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) => classifyPath(edge.blockerIssueId, nextSeen));
      const stalledChild = classified.find((result) => result.stalled || result.sampleStalledBlockerIdentifier);
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.ownerAgentId) {
      const owner = agentsById.get(node.ownerAgentId);
      if (!owner || owner.companyId !== companyId || !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(owner.status)) {
        return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
    }

    return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByIssueId.get(root.id) ?? []).filter(
      (edge) => nodesById.get(edge.blockerIssueId)?.boardPresentationStatus !== "done",
    );
    if (topLevelEdges.length === 0) {
      attentionMap.set(root.id, createIssueBlockerAttention({
        state: "needs_attention",
        reason: "attention_required",
      }));
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerIssueId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerIssueId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: IssueBlockerAttention["state"];
    let reason: IssueBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every((edge) => nodesById.get(edge.blockerIssueId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(root.id, createIssueBlockerAttention({
      state,
      reason,
      unresolvedBlockerCount: topLevelEdges.length,
      coveredBlockerCount,
      stalledBlockerCount,
      attentionBlockerCount,
      sampleBlockerIdentifier: sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
      sampleStalledBlockerIdentifier:
        stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
    }));
  }

  return attentionMap;
}

const issueListSelect = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  projectWorkspaceId: issues.projectWorkspaceId,
  goalId: issues.goalId,
  parentId: issues.parentId,
  parentOwnershipEpoch: issues.parentOwnershipEpoch,
  title: issues.title,
  request: sql<string>`
    encode(
      substring(
        convert_to(${issues.request}, current_setting('server_encoding'))
        FROM 1 FOR ${ISSUE_LIST_REQUEST_MAX_BYTES}
      ),
      'base64'
    )
  `,
  lifecycleStatus: issues.lifecycleStatus,
  boardPresentationStatus: issues.boardPresentationStatus,
  disposition: issues.disposition,
  workMode: issues.workMode,
  harnessKind: issues.harnessKind,
  priority: issues.priority,
  ownerKind: issues.ownerKind,
  ownerAgentId: issues.ownerAgentId,
  ownerUserId: issues.ownerUserId,
  ownerAssignmentSource: issues.ownerAssignmentSource,
  ownershipEpoch: issues.ownershipEpoch,
  creatorKind: issues.creatorKind,
  creatorAuthorityId: issues.creatorAuthorityId,
  creatorAdapterConfigRevisionId: issues.creatorAdapterConfigRevisionId,
  creatorUserId: issues.creatorUserId,
  creatorPluginInstallationId: issues.creatorPluginInstallationId,
  creatorPluginKey: issues.creatorPluginKey,
  creatorCallbackKey: issues.creatorCallbackKey,
  creatorCallbackVersion: issues.creatorCallbackVersion,
  creatorRoutineId: issues.creatorRoutineId,
  creatorRoutineDispatchId: issues.creatorRoutineDispatchId,
  creatorSystemSourceKind: issues.creatorSystemSourceKind,
  creatorSystemSourceId: issues.creatorSystemSourceId,
  contextAccessMask: issues.contextAccessMask,
  escalatedFromAffectedIssueId: issues.escalatedFromAffectedIssueId,
  escalatedFromTriggeringRunId: issues.escalatedFromTriggeringRunId,
  escalatedFromReason: issues.escalatedFromReason,
  affectedOwnershipEpoch: issues.affectedOwnershipEpoch,
  responsibleUserId: issues.responsibleUserId,
  issueNumber: issues.issueNumber,
  identifier: issues.identifier,
  originKind: issues.originKind,
  originId: issues.originId,
  originRunId: issues.originRunId,
  originFingerprint: issues.originFingerprint,
  requestDepth: issues.requestDepth,
  billingCode: issues.billingCode,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  monitorNextCheckAt: issues.monitorNextCheckAt,
  monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
  monitorAttemptCount: issues.monitorAttemptCount,
  monitorNotes: issues.monitorNotes,
  monitorScheduledBy: issues.monitorScheduledBy,
  executionWorkspaceId: sql<string | null>`(
    select ${issueExecutionWorkspaceBindings.executionWorkspaceId}
    from ${issueExecutionWorkspaceBindings}
    where ${issueExecutionWorkspaceBindings.companyId} = ${issues.companyId}
      and ${issueExecutionWorkspaceBindings.issueId} = ${issues.id}
      and ${issueExecutionWorkspaceBindings.ownershipEpoch} = ${issues.ownershipEpoch}
    limit 1
  )`,
  executionWorkspacePreference: issues.executionWorkspacePreference,
  executionWorkspaceSettings: sql<null>`null`,
  sourceTrust: issues.sourceTrust,
  startedAt: issues.startedAt,
  completedAt: issues.completedAt,
  cancelledAt: issues.cancelledAt,
  hiddenAt: issues.hiddenAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
};

function withActiveRuns<
  T extends Pick<IssueRow, "id">,
>(
  issueRows: T[],
  runMap: Map<string, IssueActiveRunRow>,
): Array<T & { activeRun: IssueActiveRunRow | null }> {
  return issueRows.map((row) => ({
    ...row,
    activeRun: runMap.get(row.id) ?? null,
  }));
}

async function userCommentStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueUserCommentStats[]> {
  const stats: IssueUserCommentStats[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueComments.issueId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${issueComments.authorUserId} = ${userId} THEN ${issueComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${userId}
              THEN ${issueComments.createdAt}
            END
          )
        `,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
        ),
      )
      .groupBy(issueComments.issueId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueReadStat[]> {
  const stats: IssueReadStat[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueReadStates.issueId,
        myLastReadAt: issueReadStates.lastReadAt,
      })
      .from(issueReadStates)
      .where(
        and(
          eq(issueReadStates.companyId, companyId),
          eq(issueReadStates.userId, userId),
          inArray(issueReadStates.issueId, issueIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<IssueLastActivityStat[]> {
  const byIssueId = new Map<string, IssueLastActivityStat>();
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIdChunk),
          ),
        )
        .groupBy(issueComments.issueId),
      dbOrTx
        .select({
          issueId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, issueIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byIssueId.set(row.issueId, {
        issueId: row.issueId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byIssueId.get(row.issueId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byIssueId.set(row.issueId, {
          issueId: row.issueId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byIssueId.values()];
}

async function blockedByMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const map = new Map<string, IssueRelationIssueSummary[]>();
  const uniqueIssueIds = [...new Set(issueIds)];
  if (uniqueIssueIds.length === 0) return map;

  for (const issueId of uniqueIssueIds) {
    map.set(issueId, []);
  }

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentIssueId: issueRelations.relatedIssueId,
        relatedId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        boardPresentationStatus: issues.boardPresentationStatus,
        priority: issues.priority,
        ownerAgentId: issues.ownerAgentId,
        ownerUserId: issues.ownerUserId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentIssueId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        boardPresentationStatus:
          row.boardPresentationStatus as IssueRelationIssueSummary["boardPresentationStatus"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        ownerAgentId: row.ownerAgentId,
        ownerUserId: row.ownerUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => issueRelationSortLabel(a).localeCompare(issueRelationSortLabel(b)));
  }

  return map;
}

const BLOCKED_INBOX_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const BLOCKED_INBOX_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

type BlockedInboxIssueRow = IssueRow & {
  labels?: IssueLabelRow[];
  labelIds?: string[];
};
type BlockedInboxApprovalRow = {
  approvalId: string;
  issueId: string;
  createdAt: Date;
};

function issueRef(row: Pick<
  IssueRow,
  "id" | "identifier" | "title" | "boardPresentationStatus" | "priority" | "ownerAgentId" | "ownerUserId"
> | null | undefined): IssueBlockedInboxIssueRef | null {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus: row.boardPresentationStatus,
    priority: row.priority as IssueBlockedInboxIssueRef["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

function hasPlanDocumentCondition(companyId: string, hasPlanDocument: boolean): SQL {
  const existsPlanDocument = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${issueDocuments}
      WHERE ${issueDocuments.companyId} = ${companyId}
        AND ${issueDocuments.issueId} = ${issues.id}
        AND ${issueDocuments.key} = 'plan'
    )
  `;
  return hasPlanDocument ? existsPlanDocument : sql<boolean>`NOT ${existsPlanDocument}`;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attentionBase(input: {
  state: IssueBlockedInboxAttention["state"];
  reason: IssueBlockedInboxAttention["reason"];
  severity: IssueBlockedInboxAttention["severity"];
  stoppedSinceAt: Date | string | null | undefined;
  owner: IssueBlockedInboxAttention["owner"];
  action: IssueBlockedInboxAttention["action"];
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue?: IssueBlockedInboxIssueRef | null;
  approvalId?: string | null;
  sampleIssueIdentifier?: string | null;
  externalDetailsRedacted?: boolean;
}): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason,
    severity: input.severity,
    stoppedSinceAt: isoDate(input.stoppedSinceAt),
    owner: input.owner,
    action: input.action,
    sourceIssue: input.sourceIssue,
    leafIssue: input.leafIssue ?? null,
    approvalId: input.approvalId ?? null,
    sampleIssueIdentifier:
      input.sampleIssueIdentifier
      ?? input.leafIssue?.identifier
      ?? input.sourceIssue?.identifier
      ?? null,
    redaction: {
      externalDetailsRedacted: input.externalDetailsRedacted ?? false,
      secretFieldsOmitted: true,
    },
  };
}

function externalWaitFromRequest(request: string | null): { owner: string; action: string } | null {
  if (!request) return null;
  const owner = request.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = request.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExternalWaitRequest(
  request: string | null | undefined,
  external: { owner: string; action: string } | null,
) {
  if (!request) return null;
  let redacted = request
    .split(/\r?\n/)
    .filter((line) => !/^\s*external\s+(?:owner|action)\s*:/i.test(line))
    .join("\n");

  for (const value of [external?.owner, external?.action]) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[redacted external wait detail]");
  }

  redacted = redacted.replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > 0 ? redacted : null;
}

function blockedInboxResponseRequest(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  if (!attention.redaction.externalDetailsRedacted) return row.request;
  return (
    redactExternalWaitRequest(
      row.request,
      externalWaitFromRequest(row.request),
    ) ?? "[redacted]"
  );
}

function blockedInboxSearchText(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  return [
    row.identifier,
    row.title,
    blockedInboxResponseRequest(attention, row),
    attention.sourceIssue?.identifier,
    attention.sourceIssue?.title,
    attention.leafIssue?.identifier,
    attention.leafIssue?.title,
    attention.sampleIssueIdentifier,
    attention.action.label,
    attention.action.detail,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function blockedInboxSeverityRank(severity: IssueBlockedInboxAttention["severity"]) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function issuePriorityRank(priority: string) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function compareBlockedInboxRows(
  left: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
  right: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
) {
  const leftAttention = left.blockedInboxAttention;
  const rightAttention = right.blockedInboxAttention;
  const severity = blockedInboxSeverityRank(leftAttention.severity)
    - blockedInboxSeverityRank(rightAttention.severity);
  if (severity !== 0) return severity;

  const leftStopped = leftAttention.stoppedSinceAt
    ? new Date(leftAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rightStopped = rightAttention.stoppedSinceAt
    ? new Date(rightAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftStopped !== rightStopped) return leftStopped - rightStopped;

  const priority = issuePriorityRank(left.priority) - issuePriorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftActivity = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : new Date(left.updatedAt).getTime();
  const rightActivity = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : new Date(right.updatedAt).getTime();
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  return right.id.localeCompare(left.id);
}

async function listIssueBlockedInboxAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: BlockedInboxIssueRow[],
): Promise<Map<string, IssueBlockedInboxAttention>> {
  const rowIssueIds = [...new Set(issueRows.map((row) => row.id))];
  const result = new Map<string, IssueBlockedInboxAttention>();
  if (rowIssueIds.length === 0) return result;

  const approvalRows: BlockedInboxApprovalRow[] = await dbOrTx
    .select({
      approvalId: approvals.id,
      issueId: issueApprovals.issueId,
      createdAt: approvals.createdAt,
    })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(and(
      eq(issueApprovals.companyId, companyId),
      eq(approvals.companyId, companyId),
      inArray(approvals.status, [...BLOCKED_INBOX_PENDING_APPROVAL_STATUSES]),
      inArray(issueApprovals.issueId, rowIssueIds),
    ));
  const blockerAttention = await listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows);

  const approvalByIssueId = new Map<string, BlockedInboxApprovalRow>();
  for (const row of approvalRows) {
    if (!approvalByIssueId.has(row.issueId)) approvalByIssueId.set(row.issueId, row);
  }
  for (const row of issueRows) {
    if (
      row.companyId !== companyId
      || BLOCKED_INBOX_TERMINAL_STATUSES.includes(
        row.boardPresentationStatus as typeof BLOCKED_INBOX_TERMINAL_STATUSES[number],
      )
      || row.hiddenAt
    ) {
      continue;
    }
    const source = issueRef(row);

    const approval = approvalByIssueId.get(row.id);
    if (approval) {
      result.set(row.id, attentionBase({
        state: "awaiting_decision",
        reason: "pending_board_decision",
        severity: "medium",
        stoppedSinceAt: approval.createdAt,
        owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: {
          label: "Decide approval",
          detail: "Approve, reject, or request revision on the linked approval.",
        },
        sourceIssue: source,
        approvalId: approval.approvalId,
      }));
      continue;
    }

    const hasMonitor = Boolean(row.monitorNextCheckAt && row.monitorNextCheckAt.getTime() > Date.now());
    const external =
      row.boardPresentationStatus === "blocked" && !hasMonitor
        ? externalWaitFromRequest(row.request)
        : null;
    if (external) {
      result.set(row.id, attentionBase({
        state: "external_wait",
        reason: "external_owner_action",
        severity: "medium",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "external", agentId: null, userId: null, label: null },
        action: {
          label: "External owner action",
          detail: null,
        },
        sourceIssue: source,
        externalDetailsRedacted: true,
      }));
      continue;
    }

    const blockerState = blockerAttention.get(row.id);
    if (
      row.boardPresentationStatus === "blocked"
      && (
        blockerState?.state === "needs_attention"
        || blockerState?.state === "stalled"
      )
    ) {
      result.set(row.id, attentionBase({
        state: "needs_attention",
        reason: "blocked_chain_stalled",
        severity: "high",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "unknown", agentId: null, userId: null, label: null },
        action: {
          label: "Inspect blocker chain",
          detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
        },
        sourceIssue: source,
        sampleIssueIdentifier: blockerState.sampleStalledBlockerIdentifier ?? blockerState.sampleBlockerIdentifier,
      }));
    }
  }

  return result;
}

function parseIssueOwnerAgentFilter(
  ownerAgentId: IssueFilters["ownerAgentId"],
): string | null | undefined {
  const normalizedRaw = typeof ownerAgentId === "string" ? ownerAgentId.trim() : ownerAgentId;
  const normalized = normalizedRaw === "" ? undefined : normalizedRaw;
  if (typeof normalized !== "string") return normalized;
  return normalized.toLowerCase() === "null" ? null : normalized;
}

function assertValidOwnerAgentFilter(ownerAgentFilter: string | null | undefined) {
  if (typeof ownerAgentFilter === "string" && !isUuidLike(ownerAgentFilter)) {
    throw unprocessable("ownerAgentId must be a UUID or 'null'");
  }
}

function currentExecutionWorkspaceBindingCondition(executionWorkspaceId: string) {
  return sql<boolean>`exists (
    select 1
    from ${issueExecutionWorkspaceBindings}
    where ${issueExecutionWorkspaceBindings.companyId} = ${issues.companyId}
      and ${issueExecutionWorkspaceBindings.issueId} = ${issues.id}
      and ${issueExecutionWorkspaceBindings.ownershipEpoch} = ${issues.ownershipEpoch}
      and ${issueExecutionWorkspaceBindings.executionWorkspaceId} = ${executionWorkspaceId}
  )`;
}

async function blockedInboxIssueConditions(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
) {
  const conditions = [
    eq(issues.companyId, companyId),
    visibleIssueCondition(),
    notInArray(issues.boardPresentationStatus, [...BLOCKED_INBOX_TERMINAL_STATUSES]),
  ];
  const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
  const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
  const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
  const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;

  if (filters?.descendantOf) {
    conditions.push(sql<boolean>`
      ${issues.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.parentId} = ${filters.descendantOf}
          UNION
          SELECT ${issues.id}
          FROM ${issues}
          JOIN descendants ON ${issues.parentId} = descendants.id
          WHERE ${issues.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  const lowTrustCondition = lowTrustBoundaryIssueCondition(companyId, filters?.lowTrustBoundary);
  if (lowTrustCondition) conditions.push(lowTrustCondition);
  const statuses = parseStatusFilter(filters?.status);
  if (statuses.length > 0) {
    conditions.push(statuses.length === 1 ? eq(issues.boardPresentationStatus, statuses[0]!) : inArray(issues.boardPresentationStatus, statuses));
  }
  const ownerAgentFilter = parseIssueOwnerAgentFilter(filters?.ownerAgentId);
  assertValidOwnerAgentFilter(ownerAgentFilter);
  if (ownerAgentFilter === null) {
    conditions.push(isNull(issues.ownerAgentId));
  } else if (ownerAgentFilter) {
    conditions.push(eq(issues.ownerAgentId, ownerAgentFilter));
  }
  if (filters?.participantAgentId) conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
  if (filters?.ownerUserId) conditions.push(eq(issues.ownerUserId, filters.ownerUserId));
  if (touchedByUserId) conditions.push(touchedByUserCondition(companyId, touchedByUserId));
  if (inboxArchivedByUserId) conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
  if (unreadForUserId) conditions.push(unreadForUserCondition(companyId, unreadForUserId));
  if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
  if (filters?.workspaceId) {
    conditions.push(or(
      currentExecutionWorkspaceBindingCondition(filters.workspaceId),
      eq(issues.projectWorkspaceId, filters.workspaceId),
    )!);
  }
  if (filters?.executionWorkspaceId) {
    conditions.push(currentExecutionWorkspaceBindingCondition(filters.executionWorkspaceId));
  }
  if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
  if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
  if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
  if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
  if (filters?.hasPlanDocument !== undefined) {
    conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
  }
  if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
  if (filters?.labelId) {
    const labeledIssueIds = await dbOrTx
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
    if (labeledIssueIds.length === 0) return { conditions: [sql<boolean>`false`], contextUserId };
    conditions.push(inArray(issues.id, labeledIssueIds.map((row: { issueId: string }) => row.issueId)));
  }
  if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
    conditions.push(ne(issues.originKind, "routine_execution"));
  }

  return { conditions, contextUserId };
}

async function listBlockedInboxIssues(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
): Promise<Array<CanonicalIssueWithLabelsAndRun & {
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention: IssueBlockedInboxAttention;
  liveDescendantCount?: number;
  lastActivityAt: Date;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  isUnreadForMe?: boolean;
}>> {
  const { conditions, contextUserId } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);

  const rows: CanonicalIssueListRow[] = (await dbOrTx
    .select(issueListSelect)
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issueCanonicalLastActivityAtExpr(companyId)), desc(issues.updatedAt), desc(issues.id)))
    .map((row: CanonicalIssueListRow) => ({
      ...row,
      request: decodeDatabaseTextPreview(row.request, ISSUE_LIST_REQUEST_MAX_CHARS),
    }));
  const withLabels = await withIssueLabels(dbOrTx, rows);
  const withRuns = withActiveRuns(withLabels, await activeRunMapForIssues(dbOrTx, withLabels));
  if (withRuns.length === 0) return [];

  const issueIds = withRuns.map((row) => row.id);
  const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
  const [
    statsRows,
    readRows,
    lastActivityRows,
    blockedByMap,
    blockerAttentionByIssueId,
    blockedInboxAttentionByIssueId,
    liveDescendantCountByIssueId,
  ] = await Promise.all([
    contextUserId ? userCommentStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    contextUserId ? userReadStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    lastActivityStatsForIssues(dbOrTx, companyId, issueIds),
    blockedByMapForIssues(dbOrTx, companyId, issueIds),
    listIssueBlockerAttentionMap(dbOrTx, companyId, withRuns),
    listIssueBlockedInboxAttentionMap(dbOrTx, companyId, withRuns),
    includeLiveDescendantSummary
      ? liveDescendantCountMapForIssues(dbOrTx, companyId, issueIds)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of rows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }
  const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
  const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));
  const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));

  const enriched = withRuns.flatMap((row) => {
    const blockedInboxAttention = blockedInboxAttentionByIssueId.get(row.id);
    if (!blockedInboxAttention) return [];
    if (
      rawSearch
      && !blockedInboxSearchText(blockedInboxAttention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return [];

    const activity = lastActivityByIssueId.get(row.id);
    const lastActivityAt = latestIssueActivityAt(
      row.updatedAt,
      activity?.latestCommentAt ?? null,
      activity?.latestLogAt ?? null,
    ) ?? row.updatedAt;
    return [{
      ...row,
      request: blockedInboxResponseRequest(blockedInboxAttention, row),
      blockedBy: blockedByMap.get(row.id) ?? [],
      lastActivityAt,
      ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
      blockedInboxAttention,
      ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
      ...(contextUserId
        ? deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          })
        : {}),
    }];
  }).sort(compareBlockedInboxRows);

  const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
    ? Math.max(0, Math.floor(filters.offset))
    : 0;
  const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
    ? Math.max(1, Math.floor(filters.limit))
    : undefined;
  return limit === undefined ? enriched.slice(offset) : enriched.slice(offset, offset + limit);
}

async function countBlockedInboxIssues(dbOrTx: any, companyId: string, filters?: IssueFilters): Promise<number> {
  const { conditions } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);
  const rawRows = (await dbOrTx
    .select()
    .from(issues)
    .where(and(...conditions))) as IssueRow[];
  if (rawRows.length === 0) return 0;
  const rows = await withIssueLabels(dbOrTx, rawRows);

  const blockedInboxAttentionByIssueId = await listIssueBlockedInboxAttentionMap(dbOrTx, companyId, rows);
  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const issueIds = rows.map((row) => row.id);
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const commentRows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of commentRows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }

  return rows.reduce((count: number, row) => {
    const attention = blockedInboxAttentionByIssueId.get(row.id);
    if (!attention) return count;
    if (
      rawSearch
      && !blockedInboxSearchText(attention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return count;
    return count + 1;
  }, 0);
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  async function getIssueByUuid(id: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getIssueByIdentifier(identifier: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  function redactIssueComment<T extends {
    body: string;
    authorType: IssueCommentAuthorType;
    presentation?: unknown;
    metadata?: unknown;
  }>(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    presentation: IssueCommentPresentation | null;
    metadata: IssueCommentMetadata | null;
  } {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
      presentation: issueCommentPresentationSchema.nullable().catch(null).parse(comment.presentation ?? null),
      metadata: issueCommentMetadataSchema.nullable().catch(null).parse(comment.metadata ?? null),
    };
  }

  type IssueCommentRow = typeof issueComments.$inferSelect;
  type BoardAuthorLabels = {
    agents: Map<string, string>;
    users: Map<string, string>;
  };

  async function loadBoardAuthorLabels(
    comments: readonly Pick<
      IssueCommentRow,
      "authorAgentId" | "authorUserId"
    >[],
    extraAgentIds: readonly (string | null)[] = [],
  ): Promise<BoardAuthorLabels> {
    const agentIds = [...new Set([
      ...comments.map((comment) => comment.authorAgentId),
      ...extraAgentIds,
    ].filter((value): value is string => Boolean(value)))];
    const userIds = [...new Set(comments
      .map((comment) => comment.authorUserId)
      .filter((value): value is string => Boolean(value)))];
    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({ id: authUsers.id, name: authUsers.name })
            .from(authUsers)
            .where(inArray(authUsers.id, userIds))
        : Promise.resolve([]),
    ]);
    return {
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
      users: new Map(userRows.map((row) => [row.id, row.name])),
    };
  }

  function boardCommentAuthor(
    comment: Pick<
      IssueCommentRow,
      | "authorType"
      | "authorAgentId"
      | "authorUserId"
      | "authorPluginKey"
    >,
    labels: BoardAuthorLabels,
  ): BoardIssueCommentAuthor {
    const label = comment.authorType === "agent"
      ? labels.agents.get(comment.authorAgentId ?? "") ?? "Agent"
      : comment.authorType === "user"
        ? labels.users.get(comment.authorUserId ?? "") ?? "User"
        : comment.authorType === "plugin"
          ? comment.authorPluginKey ?? "Plugin"
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
    parent: IssueCommentRow | null,
    labels: BoardAuthorLabels,
    censorUsernameInLogs: boolean,
    parentRunState: BoardIssueCommentRunState | null = null,
  ): BoardIssueCommentParentReference | null {
    if (!parent) return null;
    const author = boardCommentAuthor(parent, labels);
    const body = redactCurrentUserText(parent.body, {
      enabled: censorUsernameInLogs,
    });
    const derivedBody = parent.presentation?.kind === "run_progress" && body.length === 0
      ? parentRunState === "queued"
        ? "Queued…"
        : parentRunState === "working"
          ? "Working…"
          : "Run finished"
      : body;
    return {
      authorLabel: author.label,
      excerpt: boardCommentExcerpt(derivedBody),
    };
  }

  function projectBoardIssueComment(input: {
    comment: IssueCommentRow;
    parent: IssueCommentRow | null;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
    runStatus?: IssueExecutionRunStatus | null;
    parentRunStatus?: IssueExecutionRunStatus | null;
  }): BoardIssueComment {
    const redacted = redactIssueComment(
      input.comment,
      input.censorUsernameInLogs,
    );
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
        boardRunState(input.parentRunStatus),
      ),
      createdAt: redacted.createdAt,
      updatedAt: redacted.updatedAt,
    };
  }

  function projectBoardRunSegment(input: {
    message: typeof issueSessionMessages.$inferSelect;
    parent: IssueCommentRow;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
    parentRunStatus?: IssueExecutionRunStatus | null;
  }): BoardIssueRunSegmentEntry {
    const data = input.message.data && typeof input.message.data === "object"
      ? input.message.data as Record<string, unknown>
      : {};
    const content = Array.isArray(data.content) ? data.content : [];
    const parts: BoardIssueRunSegmentPart[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part = raw as Record<string, unknown>;
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        parts.push({
          type: part.type,
          text: redactCurrentUserText(part.text, {
            enabled: input.censorUsernameInLogs,
          }),
        });
        continue;
      }
      if (part.type !== "tool" || typeof part.name !== "string") continue;
      const state = part.state && typeof part.state === "object" && !Array.isArray(part.state)
        ? part.state as Record<string, unknown>
        : null;
      const status = state?.status;
      if (
        status === "pending" ||
        status === "running" ||
        status === "completed" ||
        status === "error"
      ) {
        parts.push({ type: "tool", name: part.name, status });
      }
    }
    const time = data.time && typeof data.time === "object" && !Array.isArray(data.time)
      ? data.time as Record<string, unknown>
      : null;
    const complete = typeof time?.completed === "number";
    const hasError = Boolean(data.error) || data.finish === "error";
    const author: BoardIssueCommentAuthor = {
      type: "agent",
      label: input.message.agentId
        ? input.labels.agents.get(input.message.agentId) ?? "Agent"
        : "Agent",
      agentId: input.message.agentId,
      userId: null,
      pluginKey: null,
    };
    const id = `segment_${createHash("sha256")
      .update(`board-run-segment/v1\u0000${input.message.companyId}\u0000${input.message.issueId}\u0000${input.message.id}`)
      .digest("hex")
      .slice(0, 32)}`;
    return {
      kind: "run_segment",
      id,
      author,
      parts,
      status: hasError ? "error" : complete ? "complete" : "working",
      canonicalSequence: input.message.seq,
      immediateParentDisplayReference: boardCommentParentReference(
        input.parent,
        input.labels,
        input.censorUsernameInLogs,
        boardRunState(input.parentRunStatus),
      ),
      createdAt: input.message.timeCreated,
      updatedAt: input.message.timeUpdated,
    };
  }

  async function loadRunStatuses(
    runIds: readonly (string | null)[],
  ): Promise<Map<string, IssueExecutionRunStatus>> {
    const ids = [...new Set(runIds.filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return new Map();
    const runs = await Promise.all(ids.map(async (runId) => {
      const identity = await resolveIssueExecutionRunIdentityById(db, runId);
      if (!identity) return null;
      return readIssueExecutionRun(db, identity);
    }));
    return new Map(
      runs
        .filter((run) => run !== null)
        .map((run) => [run.runId, run.status]),
    );
  }

  async function loadBoardCommentThreadPage(input: {
    root: IssueCommentRow;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<BoardIssueCommentThreadPage & {
    replyCount: number;
    runSegmentCount: number;
  }> {
    const { root } = input;
    const limit = boundedBoardCommentPageSize(
      input.limit,
      DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
    );
    const cursor = decodeBoardCommentCursor(input.cursor, {
      kind: "thread",
      issueId: root.issueId,
      rootCommentId: root.id,
    });
    const sequenceFloor = cursor?.sequence ?? root.projectedEventSeq;
    const descendantConditions = [
      eq(issueComments.companyId, root.companyId),
      eq(issueComments.issueId, root.issueId),
      eq(issueComments.threadRootCommentId, root.id),
      gte(issueComments.projectedEventSeq, sequenceFloor),
    ];
    const messageConditions = root.runId
      ? [
          eq(issueSessionMessages.companyId, root.companyId),
          eq(issueSessionMessages.issueId, root.issueId),
          eq(issueSessionMessages.sessionId, root.sessionId),
          eq(issueSessionMessages.runId, root.runId),
          eq(issueSessionMessages.type, "assistant" as const),
          gte(issueSessionMessages.seq, sequenceFloor),
          sql`${issueSessionMessages.id} is distinct from (
            select source.terminal_session_message_id
            from ${issueCommentProjectionSources} source
            where source.comment_id = ${root.id}
              and source.company_id = ${root.companyId}
              and source.issue_id = ${root.issueId}
            limit 1
          )`,
        ]
      : null;

    const [descendantRows, assistantRows, replyCountRow, runSegmentCountRow] =
      await Promise.all([
        db
          .select()
          .from(issueComments)
          .where(and(...descendantConditions))
          .orderBy(asc(issueComments.projectedEventSeq), asc(issueComments.id))
          .limit(limit + 1),
        messageConditions
          ? db
              .select({
                message: issueSessionMessages,
                steeringParentCommentId: sql<string | null>`(
                  select source.comment_id
                  from issue_comment_projection_sources source
                  where source.company_id = ${root.companyId}
                    and source.issue_id = ${root.issueId}
                    and source.session_id = ${root.sessionId}
                    and source.run_id = ${root.runId}
                    and source.segment_ordinal is not null
                    and source.projected_event_seq <= ${issueSessionMessages.seq}
                  order by source.projected_event_seq desc, source.comment_id desc
                  limit 1
                )`,
              })
              .from(issueSessionMessages)
              .where(and(...messageConditions))
              .orderBy(asc(issueSessionMessages.seq), asc(issueSessionMessages.id))
              .limit(limit + 1)
          : Promise.resolve([]),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, root.companyId),
              eq(issueComments.issueId, root.issueId),
              eq(issueComments.threadRootCommentId, root.id),
            ),
          )
          .then((rows) => rows[0] ?? { count: 0 }),
        root.runId
          ? db
              .select({ count: sql<number>`count(*)::int` })
              .from(issueSessionMessages)
              .where(
                and(
                  eq(issueSessionMessages.companyId, root.companyId),
                  eq(issueSessionMessages.issueId, root.issueId),
                  eq(issueSessionMessages.sessionId, root.sessionId),
                  eq(issueSessionMessages.runId, root.runId),
                  eq(issueSessionMessages.type, "assistant" as const),
                  sql`${issueSessionMessages.id} is distinct from (
                    select source.terminal_session_message_id
                    from ${issueCommentProjectionSources} source
                    where source.comment_id = ${root.id}
                      and source.company_id = ${root.companyId}
                      and source.issue_id = ${root.issueId}
                    limit 1
                  )`,
                ),
              )
              .then((rows) => rows[0] ?? { count: 0 })
          : Promise.resolve({ count: 0 }),
      ]);

    const parentIds = [...new Set([
      ...descendantRows.map((comment) => comment.replyToCommentId),
      ...assistantRows.map((row) => row.steeringParentCommentId ?? root.id),
    ].filter((value): value is string => Boolean(value)))];
    const parentRows = parentIds.length > 0
      ? await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, root.companyId),
              eq(issueComments.issueId, root.issueId),
              inArray(issueComments.id, parentIds),
            ),
          )
      : [];
    const parents = new Map(parentRows.map((comment) => [comment.id, comment]));
    const labels = await loadBoardAuthorLabels(
      [...descendantRows, ...parentRows],
      assistantRows.map((row) => row.message.agentId),
    );
    const runStatuses = await loadRunStatuses([
      root.runId,
      ...descendantRows.map((comment) => comment.runId),
      ...parentRows.map((comment) => comment.runId),
    ]);
    const { censorUsernameInLogs } = await instanceSettings.getGeneral();

    const entries: BoardIssueThreadEntry[] = [
      ...descendantRows.map((comment) => ({
        kind: "comment" as const,
        ...projectBoardIssueComment({
          comment,
          parent: comment.replyToCommentId
            ? parents.get(comment.replyToCommentId) ?? null
            : null,
          labels,
          censorUsernameInLogs,
          runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
          parentRunStatus: comment.replyToCommentId
            ? runStatuses.get(parents.get(comment.replyToCommentId)?.runId ?? "")
            : null,
        }),
      })),
      ...assistantRows.map((row) => {
        const parent = parents.get(row.steeringParentCommentId ?? root.id) ?? root;
        return projectBoardRunSegment({
          message: row.message,
          parent,
          labels,
          censorUsernameInLogs,
          parentRunStatus: parent.runId ? runStatuses.get(parent.runId) : null,
        });
      }),
    ]
      .filter((entry) => isAfterBoardCommentCursor(entry, cursor))
      .sort(compareCanonicalEntry);
    const pageEntries = entries.slice(0, limit);
    const finalEntry = pageEntries.at(-1);
    return {
      entries: pageEntries,
      nextCursor: entries.length > limit && finalEntry
        ? encodeBoardCommentCursor({
            version: 1,
            kind: "thread",
            issueId: root.issueId,
            rootCommentId: root.id,
            sequence: finalEntry.canonicalSequence,
            id: finalEntry.id,
          })
        : null,
      replyCount: Number(replyCountRow.count),
      runSegmentCount: Number(runSegmentCountRow.count),
    };
  }

  /**
   * Loads the bounded first entry page for every root in one fixed query plan.
   * Per-kind window ranks keep a large thread from consuming another root's
   * allowance; the in-memory merge then applies the closed union's canonical
   * sequence/stable-id order.
   */
  async function loadBoardCommentThreadPages(
    roots: readonly IssueCommentRow[],
    limit: number,
  ): Promise<Map<string, BoardIssueCommentThreadPage & {
    replyCount: number;
    runSegmentCount: number;
  }>> {
    const pages = new Map<string, BoardIssueCommentThreadPage & {
      replyCount: number;
      runSegmentCount: number;
    }>();
    if (roots.length === 0) return pages;

    const rootIds = roots.map((root) => root.id);
    const rootIdSql = sql.join(rootIds.map((id) => sql`${id}::uuid`), sql`, `);
    type RankedCommentIdentity = {
      rootCommentId: string;
      sourceId: string;
      totalCount: number | string;
    };
    type RankedSegmentIdentity = RankedCommentIdentity & {
      steeringParentCommentId: string | null;
    };
    const [commentIdentityResult, segmentIdentityResult] = await Promise.all([
      db.execute(sql<RankedCommentIdentity>`
        select
          ranked.root_comment_id as "rootCommentId",
          ranked.source_id as "sourceId",
          ranked.total_count as "totalCount"
        from (
          select
            comment_entry.thread_root_comment_id as root_comment_id,
            comment_entry.id as source_id,
            count(*) over (
              partition by comment_entry.thread_root_comment_id
            ) as total_count,
            row_number() over (
              partition by comment_entry.thread_root_comment_id
              order by comment_entry.projected_event_seq asc, comment_entry.id asc
            ) as entry_rank
          from ${issueComments} comment_entry
          where comment_entry.company_id = ${roots[0]!.companyId}
            and comment_entry.issue_id = ${roots[0]!.issueId}
            and comment_entry.thread_root_comment_id in (${rootIdSql})
        ) ranked
        where ranked.entry_rank <= ${limit + 1}
        order by ranked.root_comment_id asc, ranked.entry_rank asc
      `),
      db.execute(sql<RankedSegmentIdentity>`
        select
          ranked.root_comment_id as "rootCommentId",
          ranked.source_id as "sourceId",
          ranked.steering_parent_comment_id as "steeringParentCommentId",
          ranked.total_count as "totalCount"
        from (
          select
            root_comment.id as root_comment_id,
            message_entry.id as source_id,
            (
              select source.comment_id
              from ${issueCommentProjectionSources} source
              where source.company_id = root_comment.company_id
                and source.issue_id = root_comment.issue_id
                and source.session_id = root_comment.session_id
                and source.run_id = root_comment.run_id
                and source.segment_ordinal is not null
                and source.projected_event_seq <= message_entry.seq
              order by source.projected_event_seq desc, source.comment_id desc
              limit 1
            ) as steering_parent_comment_id,
            count(*) over (partition by root_comment.id) as total_count,
            row_number() over (
              partition by root_comment.id
              order by message_entry.seq asc, message_entry.id asc
            ) as entry_rank
          from ${issueComments} root_comment
          inner join ${issueCommentProjectionSources} root_source
            on root_source.comment_id = root_comment.id
           and root_source.company_id = root_comment.company_id
           and root_source.issue_id = root_comment.issue_id
          inner join ${issueSessionMessages} message_entry
            on message_entry.company_id = root_comment.company_id
           and message_entry.issue_id = root_comment.issue_id
           and message_entry.session_id = root_comment.session_id
           and message_entry.run_id = root_comment.run_id
           and message_entry.type = 'assistant'
           and message_entry.id is distinct from root_source.terminal_session_message_id
          where root_comment.company_id = ${roots[0]!.companyId}
            and root_comment.issue_id = ${roots[0]!.issueId}
            and root_comment.id in (${rootIdSql})
            and root_comment.run_id is not null
        ) ranked
        where ranked.entry_rank <= ${limit + 1}
        order by ranked.root_comment_id asc, ranked.entry_rank asc
      `),
    ]);
    const commentIdentities = Array.from(
      commentIdentityResult,
    ) as RankedCommentIdentity[];
    const segmentIdentities = Array.from(
      segmentIdentityResult,
    ) as RankedSegmentIdentity[];
    const commentIds = commentIdentities.map((row) => row.sourceId);
    const messageIds = segmentIdentities.map((row) => row.sourceId);
    const [descendantRows, assistantMessages] = await Promise.all([
      commentIds.length > 0
        ? db
            .select()
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, roots[0]!.companyId),
                eq(issueComments.issueId, roots[0]!.issueId),
                inArray(issueComments.id, commentIds),
              ),
            )
        : Promise.resolve([]),
      messageIds.length > 0
        ? db
            .select()
            .from(issueSessionMessages)
            .where(
              and(
                eq(issueSessionMessages.companyId, roots[0]!.companyId),
                eq(issueSessionMessages.issueId, roots[0]!.issueId),
                inArray(issueSessionMessages.id, messageIds),
              ),
            )
        : Promise.resolve([]),
    ]);
    const descendantsById = new Map(descendantRows.map((row) => [row.id, row]));
    const messagesById = new Map(assistantMessages.map((row) => [row.id, row]));
    const rootsById = new Map(roots.map((root) => [root.id, root]));
    const segmentIdentityByMessageId = new Map(
      segmentIdentities.map((row) => [row.sourceId, row]),
    );
    const parentIds = [...new Set([
      ...descendantRows.map((comment) => comment.replyToCommentId),
      ...segmentIdentities.map((row) => row.steeringParentCommentId ?? row.rootCommentId),
    ].filter((value): value is string => Boolean(value)))];
    const missingParentIds = parentIds.filter((id) => !rootsById.has(id));
    const parentRows = missingParentIds.length > 0
      ? await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, roots[0]!.companyId),
              eq(issueComments.issueId, roots[0]!.issueId),
              inArray(issueComments.id, missingParentIds),
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

    const commentsByRoot = new Map<string, IssueCommentRow[]>();
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
        ...projectBoardIssueComment({
          comment,
          parent: comment.replyToCommentId
            ? parents.get(comment.replyToCommentId) ?? null
            : null,
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
        const parent = parents.get(
          identity?.steeringParentCommentId ?? root.id,
        ) ?? root;
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
        nextCursor: merged.length > limit && finalEntry
          ? encodeBoardCommentCursor({
              version: 1,
              kind: "thread",
              issueId: root.issueId,
              rootCommentId: root.id,
              sequence: finalEntry.canonicalSequence,
              id: finalEntry.id,
            })
          : null,
        replyCount: countValue(
          commentIdentities.find((row) => row.rootCommentId === root.id)?.totalCount,
        ),
        runSegmentCount: countValue(
          segmentIdentities.find((row) => row.rootCommentId === root.id)?.totalCount,
        ),
      });
    }
    return pages;
  }

  async function getBoardCommentProjection(input: {
    companyId: string;
    issueId: string;
    commentId: string;
  }): Promise<BoardIssueComment | null> {
    const comment = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issueId),
          eq(issueComments.id, input.commentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) return null;
    const parent = comment.replyToCommentId
      ? await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, input.companyId),
              eq(issueComments.issueId, input.issueId),
              eq(issueComments.id, comment.replyToCommentId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const [labels, runStatuses, general] = await Promise.all([
      loadBoardAuthorLabels(parent ? [comment, parent] : [comment]),
      loadRunStatuses([comment.runId, parent?.runId ?? null]),
      instanceSettings.getGeneral(),
    ]);
    return projectBoardIssueComment({
      comment,
      parent,
      labels,
      censorUsernameInLogs: general.censorUsernameInLogs,
      runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
      parentRunStatus: parent?.runId ? runStatuses.get(parent.runId) : null,
    });
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
    return workspace;
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
    return workspace;
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function getIssueRelationSummaryMap(
    companyId: string,
    issueIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, IssueRelationSummaryMap>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const empty = new Map<string, IssueRelationSummaryMap>();
    for (const issueId of uniqueIssueIds) {
      empty.set(issueId, { blockedBy: [], blocks: [] });
    }
    if (uniqueIssueIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      dbOrTx
        .select({
          currentIssueId: issueRelations.issueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentIssueId)?.blockedBy.push(summarizeIssueRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentIssueId)?.blocks.push(summarizeIssueRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => issueRelationSortLabel(a).localeCompare(issueRelationSortLabel(b)));
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) => issueRelationSortLabel(a).localeCompare(issueRelationSortLabel(b)));
    }

    return empty;
  }

  async function withIssueRelationSummaries<T extends { id: string }>(
    companyId: string,
    rows: T[],
    dbOrTx: DbReader = db,
  ): Promise<Array<T & IssueRelationSummaryMap>> {
    if (rows.length === 0) return [];
    const relationMap = await getIssueRelationSummaryMap(
      companyId,
      rows.map((row) => row.id),
      dbOrTx,
    );
    return rows.map((row) => ({
      ...row,
      ...(relationMap.get(row.id) ?? { blockedBy: [], blocks: [] }),
    }));
  }

  async function assertNoBlockingCycles(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerIssueIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerIssueId) ?? [];
      list.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, list);
    }

    for (const blockerIssueId of blockerIssueIds) {
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerIssueId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByIssueIds(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByIssueIds)];
    if (deduped.some((candidate) => candidate === issueId)) {
      throw unprocessable("Issue cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedIssueIds = [issueId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${issues.id} FROM ${issues}
            WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
            ORDER BY ${issues.id}
            FOR UPDATE`,
      );
      const relatedIssues = await dbOrTx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, deduped)));
      if (relatedIssues.length !== deduped.length) {
        throw unprocessable("Blocked-by issues must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, issueId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(issueRelations).values(
      deduped.map((blockerIssueId) => ({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  return {
    list: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return listBlockedInboxIssues(db, companyId, {
          ...filters,
          includeBlockedBy: true,
          includeBlockedInboxAttention: true,
        });
      }

      const conditions = [eq(issues.companyId, companyId), visibleIssueCondition()];
      const ownerAgentFilter = parseIssueOwnerAgentFilter(filters?.ownerAgentId);
      assertValidOwnerAgentFilter(ownerAgentFilter);
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : undefined;
      const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
        ? Math.max(0, Math.floor(filters.offset))
        : 0;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const includeBlockedInboxAttention = filters?.includeBlockedInboxAttention === true;
      const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const requestContainsMatch = sql<boolean>`${issues.request} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${issues.id}
              FROM ${issues}
              JOIN descendants ON ${issues.parentId} = descendants.id
              WHERE ${issues.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      const lowTrustCondition = lowTrustBoundaryIssueCondition(companyId, filters?.lowTrustBoundary);
      if (lowTrustCondition) conditions.push(lowTrustCondition);
      const statuses = parseStatusFilter(filters?.status);
      if (statuses.length === 1) {
        conditions.push(eq(issues.boardPresentationStatus, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.boardPresentationStatus, statuses));
      }
      if (ownerAgentFilter === null) {
        conditions.push(isNull(issues.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(eq(issues.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.ownerUserId) {
        conditions.push(eq(issues.ownerUserId, filters.ownerUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          currentExecutionWorkspaceBindingCondition(filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(currentExecutionWorkspaceBindingCondition(filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationIssues(filters)) {
        conditions.push(nonPluginOperationIssueCondition());
      }
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            requestContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(issues.originKind, "routine_execution"));
      }
      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${requestContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const baseQuery = db
        .select(issueListSelect)
        .from(issues)
        .where(and(...conditions))
        .orderBy(...issueListOrderBy(companyId, {
          hasSearch,
          priorityOrder,
          searchOrder,
          sortField: filters?.sortField,
          sortDir: filters?.sortDir,
        }));
      const pageQuery = offset > 0
        ? (limit === undefined ? baseQuery.offset(offset) : baseQuery.limit(limit).offset(offset))
        : (limit === undefined ? baseQuery : baseQuery.limit(limit));
      const rows: CanonicalIssueListRow[] = (await pageQuery).map((row) => ({
        ...row,
        request: decodeDatabaseTextPreview(row.request, ISSUE_LIST_REQUEST_MAX_CHARS),
      }));
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows, archiveRows, blockedByMap, liveDescendantCountByIssueId] = await Promise.all([
        contextUserId
          ? userCommentStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        lastActivityStatsForIssues(db, companyId, issueIds),
        contextUserId
          ? inboxArchiveRowsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        includeBlockedBy
          ? blockedByMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, IssueRelationIssueSummary[]>()),
        includeLiveDescendantSummary
          ? liveDescendantCountMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, number>()),
      ]);
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));
      const archiveByIssueId = new Map(archiveRows.map((row) => [row.issueId, row]));
      const [blockerAttentionByIssueId, blockedInboxAttentionByIssueId] = await Promise.all([
        listIssueBlockerAttentionMap(db, companyId, withRuns),
        includeBlockedInboxAttention
          ? listIssueBlockedInboxAttentionMap(db, companyId, withRuns)
          : Promise.resolve(new Map<string, IssueBlockedInboxAttention>()),
      ]);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByIssueId.get(row.id);
          const lastActivityAt = latestIssueActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
            ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
            ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
          };
        });
      }

      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByIssueId.get(row.id);
        const lastActivityAt = latestIssueActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          ...activeInboxArchiveFields(archiveByIssueId.get(row.id), lastActivityAt),
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
          ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
          ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
          ...deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    count: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return countBlockedInboxIssues(db, companyId, filters);
      }

      const conditions = [eq(issues.companyId, companyId), visibleIssueCondition()];
      const statuses = parseStatusFilter(filters?.status);
      if (statuses.length === 1) conditions.push(eq(issues.boardPresentationStatus, statuses[0]!));
      else if (statuses.length > 1) conditions.push(inArray(issues.boardPresentationStatus, statuses));
      const ownerAgentFilter = parseIssueOwnerAgentFilter(filters?.ownerAgentId);
      assertValidOwnerAgentFilter(ownerAgentFilter);
      if (ownerAgentFilter === null) {
        conditions.push(isNull(issues.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(eq(issues.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.ownerUserId) conditions.push(eq(issues.ownerUserId, filters.ownerUserId));
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          currentExecutionWorkspaceBindingCondition(filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(currentExecutionWorkspaceBindingCondition(filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    countUnreadTouchedByUser: async (
      companyId: string,
      userId: string,
      status?: string | readonly string[],
    ) => {
      const conditions = [
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        nonPluginOperationIssueCondition(),
        unreadForUserCondition(companyId, userId),
      ];
      const statuses = parseStatusFilter(status);
      if (statuses.length === 1) {
        conditions.push(eq(issues.boardPresentationStatus, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.boardPresentationStatus, statuses));
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, issueId: string, userId: string) => {
      const deleted = await db
        .delete(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.issueId, issueId),
            eq(issueReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (
      companyId: string,
      issueId: string,
      userId: string,
      archivedAt: Date = new Date(),
      attribution?: {
        archivedByActorType: "user" | "agent";
        archivedByAgentId?: string | null;
        archivedByRunId?: string | null;
      },
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedByActorType: attribution?.archivedByActorType ?? "user",
          archivedByAgentId: attribution?.archivedByAgentId ?? null,
          archivedByRunId: attribution?.archivedByRunId ?? null,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            archivedByActorType: attribution?.archivedByActorType ?? "user",
            archivedByAgentId: attribution?.archivedByAgentId ?? null,
            archivedByRunId: attribution?.archivedByRunId ?? null,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getActiveInboxArchiveFields: async (
      issue: Pick<IssueRow, "id" | "companyId" | "updatedAt">,
      userId: string,
    ) => {
      const [[activity], [archive]] = await Promise.all([
        lastActivityStatsForIssues(db, issue.companyId, [issue.id]),
        inboxArchiveRowsForIssues(db, issue.companyId, userId, [issue.id]),
      ]);
      const lastActivityAt = latestIssueActivityAt(
        issue.updatedAt,
        activity?.latestCommentAt ?? null,
        activity?.latestLogAt ?? null,
      ) ?? issue.updatedAt;
      return activeInboxArchiveFields(archive, lastActivityAt);
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      const identifier = normalizeIssueReferenceIdentifier(id);
      if (identifier) {
        return getIssueByIdentifier(identifier);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
    },

    getRelationSummaries: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const relations = await getIssueRelationSummaryMap(issue.companyId, [issueId], db);
      return relations.get(issueId) ?? { blockedBy: [], blocks: [] };
    },

    getBlockerDiagnostics: async (
      issueId: string,
      maxBlockers = ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    ) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const cappedMax = Math.max(0, Math.min(maxBlockers, ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS));
      const blockerRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, issue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issues.companyId, issue.companyId),
          ),
        )
        .orderBy(asc(issues.title), asc(issues.id))
        .limit(cappedMax + 1);

      const readiness = await listIssueDependencyReadinessMap(db, issue.companyId, [issue.id]);

      return {
        blockers: blockerRows.slice(0, cappedMax) as IssueBlockerDiagnosticsIssueRow[],
        readiness: readiness.get(issue.id) ?? createIssueDependencyReadiness(issue.id),
        truncated: blockerRows.length > cappedMax,
      };
    },

    getSubtreeDiagnostics: async (
      issueId: string,
      opts?: {
        maxDepth?: number;
        maxNodes?: number;
        maxBlockersPerNode?: number;
      },
    ) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const maxDepth = Math.max(
        0,
        Math.min(opts?.maxDepth ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH, ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH),
      );
      const maxNodes = Math.max(
        1,
        Math.min(opts?.maxNodes ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES, ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES),
      );
      const maxBlockersPerNode = Math.max(
        0,
        Math.min(
          opts?.maxBlockersPerNode ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
          ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
        ),
      );
      const rawSubtreeRows = await db.execute(sql<IssueSubtreeDiagnosticsIssueRow>`
        WITH RECURSIVE issue_tree AS (
          SELECT
            id,
            company_id,
            project_id,
            parent_id,
            identifier,
            title,
            board_presentation_status AS "boardPresentationStatus",
            priority,
            owner_agent_id,
            owner_user_id,
            created_at,
            updated_at,
            0 AS depth,
            ARRAY[id] AS path
          FROM issues
          WHERE company_id = ${issue.companyId}
            AND id = ${issue.id}
            AND hidden_at IS NULL
            AND harness_kind IS NULL
          UNION ALL
          SELECT
            child.id,
            child.company_id,
            child.project_id,
            child.parent_id,
            child.identifier,
            child.title,
            child.board_presentation_status AS "boardPresentationStatus",
            child.priority,
            child.owner_agent_id,
            child.owner_user_id,
            child.created_at,
            child.updated_at,
            issue_tree.depth + 1,
            issue_tree.path || child.id
          FROM issues child
          JOIN issue_tree ON child.parent_id = issue_tree.id
          WHERE child.company_id = ${issue.companyId}
            AND child.hidden_at IS NULL
            AND child.harness_kind IS NULL
            AND issue_tree.depth < ${maxDepth + 1}
            AND NOT child.id = ANY(issue_tree.path)
        )
        SELECT
          id,
          company_id AS "companyId",
          project_id AS "projectId",
          parent_id AS "parentId",
          identifier,
          title,
          "boardPresentationStatus",
          priority,
          owner_agent_id AS "ownerAgentId",
          owner_user_id AS "ownerUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          depth::int AS depth
        FROM issue_tree
        ORDER BY depth ASC, created_at ASC, id ASC
        LIMIT ${maxNodes + 1}
      `);
      const subtreeRows = Array.from(rawSubtreeRows)
        .map((row) => ({ ...row, depth: Number(row.depth) }));
      const rowsWithinDepth = subtreeRows.filter((row) => row.depth <= maxDepth);
      const nodes = rowsWithinDepth.slice(0, maxNodes) as IssueSubtreeDiagnosticsIssueRow[];
      const truncatedNodes = rowsWithinDepth.length > maxNodes;
      const truncatedDepth = truncatedNodes || subtreeRows.some((row) => row.depth > maxDepth);
      const nodeIds = nodes.map((node) => node.id);

      const readiness = nodeIds.length > 0
        ? await listIssueDependencyReadinessMap(db, issue.companyId, nodeIds)
        : new Map<string, IssueDependencyReadiness>();
      const blockersByIssueId = new Map<string, IssueSubtreeDiagnosticsBlockerRow[]>();
      const truncatedBlockerIssueIds = new Set<string>();

      if (nodeIds.length > 0) {
        const nodeIdValues = sql.join(nodeIds.map((id) => sql`${id}`), sql`, `);
        const rawBlockerRows = Array.from(await db.execute(sql`
          WITH blocker_rows AS (
            SELECT
              blocker.id,
              blocker.company_id AS "companyId",
              blocker.project_id AS "projectId",
              blocker.parent_id AS "parentId",
              blocker.identifier,
              blocker.title,
              blocker.board_presentation_status AS "boardPresentationStatus",
              blocker.priority,
              blocker.owner_agent_id AS "ownerAgentId",
              blocker.owner_user_id AS "ownerUserId",
              relation.related_issue_id AS "blockedIssueId",
              relation.created_at AS "relationCreatedAt",
              row_number() OVER (
                PARTITION BY relation.related_issue_id
                ORDER BY blocker.title ASC, blocker.id ASC
              )::int AS "rowNumber"
            FROM issue_relations relation
            INNER JOIN issues blocker ON blocker.id = relation.issue_id
            WHERE relation.company_id = ${issue.companyId}
              AND relation.type = 'blocks'
              AND blocker.company_id = ${issue.companyId}
              AND blocker.hidden_at IS NULL
              AND blocker.harness_kind IS NULL
              AND relation.related_issue_id::text IN (${nodeIdValues})
          )
          SELECT *
          FROM blocker_rows
          WHERE "rowNumber" <= ${maxBlockersPerNode + 1}
          ORDER BY "blockedIssueId" ASC, "rowNumber" ASC
        `)) as IssueSubtreeDiagnosticsBlockerResultRow[];
        for (const row of rawBlockerRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxBlockersPerNode) {
            truncatedBlockerIssueIds.add(normalized.blockedIssueId);
            continue;
          }
          const rows = blockersByIssueId.get(normalized.blockedIssueId) ?? [];
          rows.push(normalized);
          blockersByIssueId.set(normalized.blockedIssueId, rows);
        }

      }

      return {
        nodes,
        blockersByIssueId,
        readinessByIssueId: readiness,
        truncatedNodes,
        truncatedDepth,
        truncatedBlockerIssueIds,
        caps: {
          maxDepth,
          maxNodes,
          maxBlockersPerNode,
        },
      };
    },

    getDependencyReadiness: async (issueId: string, dbOrTx: any = db) => {
      const issue = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const readiness = await listIssueDependencyReadinessMap(dbOrTx, issue.companyId, [issueId]);
      return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
    },

    listDependencyReadiness: async (companyId: string, issueIds: string[], dbOrTx: any = db) => {
      return listIssueDependencyReadinessMap(dbOrTx, companyId, issueIds);
    },

    listBlockerAttention: async (
      companyId: string,
      issueRows: IssueBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows);
    },

    updateTitle: async (id: string, title: string | null) => {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(issues)
          .set({ title, updatedAt: new Date() })
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await syncIssue(updated.id, tx);
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      });
    },

    updateControlState: async (
      id: string,
      data: IssueControlStateUpdate,
      dbOrTx: any = db,
    ) => {
      if (Object.prototype.hasOwnProperty.call(data, "executionWorkspaceId")) {
        throw unprocessable(
          "executionWorkspaceId is managed by the current issue execution workspace binding",
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
          throw unprocessable(
            `Issue ${field} is immutable or has a dedicated canonical command`,
          );
        }
      }
      const existing = await dbOrTx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByIssueIds,
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (issueData.boardPresentationStatus) {
        assertTransition(
          existing.boardPresentationStatus,
          issueData.boardPresentationStatus,
        );
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };
      if (issueData.requestDepth !== undefined) {
        patch.requestDepth = clampIssueRequestDepth(issueData.requestDepth);
      }

      if (
        patch.boardPresentationStatus === "in_progress" &&
        !existing.ownerAgentId &&
        !existing.ownerUserId
      ) {
        throw unprocessable("in_progress issues require an owner");
      }
      if (patch.boardPresentationStatus === "in_progress") {
        const unresolvedBlockerIssueIds = blockedByIssueIds !== undefined
          ? await listUnresolvedBlockerIssueIds(dbOrTx, existing.companyId, blockedByIssueIds)
          : (
              await listIssueDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerIssueIds ?? [];
        if (unresolvedBlockerIssueIds.length > 0) {
          throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
        }
      }
      if (
        patch.boardPresentationStatus === "in_progress" &&
        existing.ownerKind === "agent" &&
        existing.ownerAgentId
      ) {
        try {
          await resolveInvokableIssueOwnerFromDb(dbOrTx as Db, {
            companyId: existing.companyId,
            ownerAgentId: existing.ownerAgentId,
          });
        } catch (error) {
          if (error instanceof InvokableIssueOwnerRejected) {
            throw conflict("Issue owner must be an invokable issue owner", {
              code: "issue_owner_not_invokable",
              reason: error.reason,
              companyId: existing.companyId,
              ownerAgentId: existing.ownerAgentId,
              ...error.details,
            });
          }
          throw error;
        }
      }
      let nextProjectId = issueData.projectId !== undefined ? issueData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        issueData.projectWorkspaceId !== undefined ? issueData.projectWorkspaceId : existing.projectWorkspaceId;
      const currentExecutionWorkspaceId = await dbOrTx
        .select({
          executionWorkspaceId: issueExecutionWorkspaceBindings.executionWorkspaceId,
        })
        .from(issueExecutionWorkspaceBindings)
        .where(and(
          eq(issueExecutionWorkspaceBindings.companyId, existing.companyId),
          eq(issueExecutionWorkspaceBindings.issueId, existing.id),
          eq(issueExecutionWorkspaceBindings.ownershipEpoch, existing.ownershipEpoch),
        ))
        .then((rows: Array<{ executionWorkspaceId: string }>) => rows[0]?.executionWorkspaceId ?? null);
      const nextExecutionWorkspacePreference =
        issueData.executionWorkspacePreference !== undefined
          ? issueData.executionWorkspacePreference
          : existing.executionWorkspacePreference;
      const nextExecutionWorkspaceSettings =
        issueData.executionWorkspaceSettings !== undefined
          ? parseIssueExecutionWorkspaceSettings(issueData.executionWorkspaceSettings)
          : parseIssueExecutionWorkspaceSettings(existing.executionWorkspaceSettings);
      if (issueData.executionWorkspaceSettings !== undefined) {
        patch.executionWorkspaceSettings = nextExecutionWorkspaceSettings
          ? { ...nextExecutionWorkspaceSettings }
          : null;
      }
      let validatedProjectWorkspace: { projectId: string } | null = null;
      let validatedExecutionWorkspace: { projectId: string | null } | null = null;
      if (!nextProjectId && nextProjectWorkspaceId) {
        const workspace = await assertValidProjectWorkspace(existing.companyId, null, nextProjectWorkspaceId);
        validatedProjectWorkspace = workspace;
        nextProjectId = workspace.projectId;
        patch.projectId = workspace.projectId;
      }
      if (!nextProjectId && currentExecutionWorkspaceId) {
        const workspace = await assertValidExecutionWorkspace(existing.companyId, null, currentExecutionWorkspaceId);
        validatedExecutionWorkspace = workspace;
        if (workspace.projectId) {
          nextProjectId = workspace.projectId;
          patch.projectId = workspace.projectId;
        }
      }
      if (nextProjectWorkspaceId) {
        if (!validatedProjectWorkspace) {
          await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
        }
      }
      if (currentExecutionWorkspaceId) {
        if (!validatedExecutionWorkspace) {
          await assertValidExecutionWorkspace(existing.companyId, nextProjectId, currentExecutionWorkspaceId);
        }
      }
      if (isolatedWorkspacesEnabled && issueData.executionWorkspaceSettings !== undefined) {
        assertExplicitPinnedWorktreeIssueRunnable({
          projectId: nextProjectId ?? null,
          projectWorkspaceId: nextProjectWorkspaceId ?? null,
          executionWorkspaceId: currentExecutionWorkspaceId,
          executionWorkspacePreference: nextExecutionWorkspacePreference ?? null,
          executionWorkspaceSettings: issueData.executionWorkspaceSettings,
        });
      }

      applyStatusSideEffects(issueData.boardPresentationStatus, patch);
      if (
        issueData.boardPresentationStatus &&
        issueData.boardPresentationStatus !== "done"
      ) {
        patch.completedAt = null;
      }
      if (
        issueData.boardPresentationStatus &&
        issueData.boardPresentationStatus !== "cancelled"
      ) {
        patch.cancelledAt = null;
      }
      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
          ),
        ]);

        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          currentProjectGoalId,
          projectId: issueData.projectId,
          goalId: issueData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (
          (updated.boardPresentationStatus === "done" ||
            updated.boardPresentationStatus === "cancelled") &&
          existing.boardPresentationStatus !==
            updated.boardPresentationStatus
        ) {
          await finalizeSummarySlotsForTerminalIssue(tx, updated);
        }
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            updated.id,
            existing.companyId,
            blockedByIssueIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        if (
          issueData.executionWorkspaceSettings !== undefined &&
          currentExecutionWorkspaceId &&
          nextExecutionWorkspacePreference === "reuse_existing"
        ) {
          const workspace = await tx
            .select({
              id: executionWorkspaces.id,
              metadata: executionWorkspaces.metadata,
            })
            .from(executionWorkspaces)
            .where(
              and(
                eq(executionWorkspaces.id, currentExecutionWorkspaceId),
                eq(executionWorkspaces.companyId, existing.companyId),
              ),
            )
            .then((rows: Array<{ id: string; metadata: unknown }>) => rows[0] ?? null);
          if (workspace) {
            await tx
              .update(executionWorkspaces)
              .set({
                metadata: mergeExecutionWorkspaceConfig(
                  (workspace.metadata as Record<string, unknown> | null) ?? null,
                  buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(nextExecutionWorkspaceSettings),
                ),
                updatedAt: new Date(),
              })
              .where(eq(executionWorkspaces.id, workspace.id));
          }
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseIssueExecutionWorkspaceSettings(
          row.executionWorkspaceSettings,
          { includeEnvironmentId: true },
        );
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(issues)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listBoardCommentGroups: async (
      companyId: string,
      issueId: string,
      opts?: {
        cursor?: string | null;
        limit?: number | null;
        entryLimit?: number | null;
      },
    ): Promise<BoardIssueCommentGroupPage> => {
      const limit = boundedBoardCommentPageSize(
        opts?.limit,
        DEFAULT_BOARD_COMMENT_ROOT_LIMIT,
      );
      const entryLimit = boundedBoardCommentPageSize(
        opts?.entryLimit,
        DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
      );
      const cursor = decodeBoardCommentCursor(opts?.cursor, {
        kind: "roots",
        issueId,
        rootCommentId: null,
      });
      const conditions = [
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.replyToCommentId),
      ];
      if (cursor) {
        conditions.push(
          or(
            lt(issueComments.projectedEventSeq, cursor.sequence),
            and(
              eq(issueComments.projectedEventSeq, cursor.sequence),
              lt(issueComments.id, cursor.id),
            ),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(desc(issueComments.projectedEventSeq), desc(issueComments.id))
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
          root: projectBoardIssueComment({
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
        nextCursor: rows.length > limit && finalRoot
          ? encodeBoardCommentCursor({
              version: 1,
              kind: "roots",
              issueId,
              rootCommentId: null,
              sequence: finalRoot.projectedEventSeq,
              id: finalRoot.id,
            })
          : null,
      };
    },

    getBoardComment: (
      companyId: string,
      issueId: string,
      commentId: string,
    ) => getBoardCommentProjection({ companyId, issueId, commentId }),

    getBoardCommentThread: async (
      companyId: string,
      issueId: string,
      rootCommentId: string,
      opts?: { cursor?: string | null; limit?: number | null },
    ): Promise<BoardIssueCommentThreadPage | null> => {
      const root = await db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.id, rootCommentId),
            isNull(issueComments.replyToCommentId),
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
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt =
          anchor.createdAt instanceof Date
            ? anchor.createdAt
            : new Date(String(anchor.createdAt));
        conditions.push(
          order === "asc"
            ? or(
                gt(issueComments.createdAt, anchorCreatedAt),
                and(
                  eq(issueComments.createdAt, anchorCreatedAt),
                  gt(issueComments.id, anchor.id),
                ),
              )!
            : or(
                lt(issueComments.createdAt, anchorCreatedAt),
                and(
                  eq(issueComments.createdAt, anchorCreatedAt),
                  lt(issueComments.id, anchor.id),
                ),
              )!,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) =>
        redactIssueComment(comment, censorUsernameInLogs),
      );
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: async (commentId: string) => {
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      return redactIssueComment(comment, censorUsernameInLogs);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (explicitAgentMentionIds.length === 0) return [];

      const rows = await db.select({ id: agents.id })
        .from(agents).where(eq(agents.companyId, companyId));
      const companyAgentIds = new Set(rows.map((agent) => agent.id));
      return explicitAgentMentionIds.filter((agentId) => companyAgentIds.has(agentId));
    },

    findMentionedProjectIds: async (
      issueId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          request: issues.request,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const mentionedIds = new Set<string>();
      for (const source of [issue.title, issue.request]) {
        if (!source) continue;
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string | null; request: string | null;
        boardPresentationStatus: IssueStatus; priority: string;
        ownerAgentId: string | null; ownerUserId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, request: issues.request,
          boardPresentationStatus: issues.boardPresentationStatus, priority: issues.priority,
          ownerAgentId: issues.ownerAgentId, ownerUserId: issues.ownerUserId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, request: parent.request,
          boardPresentationStatus: parent.boardPresentationStatus, priority: parent.priority,
          ownerAgentId: parent.ownerAgentId ?? null,
          ownerUserId: parent.ownerUserId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
