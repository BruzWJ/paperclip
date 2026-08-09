import type {
  IssueExecutionAttemptCancellationSignal,
  IssueExecutionTargetLaneIdentity,
} from "./issue-execution-dispatcher.js";
import { createHash } from "node:crypto";
import {
  acpPromptAccounting,
  activityLog,
  agentAdapterConfigRevisions,
  agents,
  costEvents,
  issueExecutionAttempts,
  issueExecutionAttemptRetrySchedules,
  issueExecutionAuthorities,
  issueExecutionCancellationIntents,
  issueExecutionFinalizationPromptDependencies,
  issueExecutionFinalizationUpdateDependencies,
  issueExecutionFinalizations,
  issueExecutionLeases,
  issueExecutionProcessFacts,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunLivenessFacts,
  issueExecutionRunRefs,
  issueExecutionRuns,
  issueExecutionWorkspaceBindings,
  issueExecutionWatchdogDecisions,
  issueComments,
  issueCommentProjectionSources,
  issueSessionEvents,
  issues,
  type Db,
  type IssueExecutionAttempt,
  type IssueExecutionAttemptRetrySchedule,
  type IssueExecutionCancellationIntent,
  type IssueExecutionFinalization,
  type IssueExecutionFinalizationPromptDependency,
  type IssueExecutionFinalizationUpdateDependency,
  type IssueExecutionLease,
  type IssueExecutionProcessFact,
  type IssueExecutionPromptSegment,
  type IssueExecutionRunControl,
  type IssueExecutionRunLivenessFactRow,
  type IssueExecutionRunRef,
} from "@paperclipai/db";
import {
  ISSUE_EXECUTION_RUN_STATUSES,
  type IssueExecutionRunKind,
  type IssueExecutionRunStatus,
  type IssueExecutionRunTerminalClassification,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { redactIssueSessionPublicationValue } from "./issue-session/publication.js";
import type {
  IssueSessionReadProjection,
  IssueSessionStore,
} from "./issue-session/store.js";
import type {
  IssueExecutionSteeringResult,
  IssueExecutionSteeringResultBroker,
} from "./issue-execution-steering-results.js";
import { isIssueExecutionRefDeliveryEligible } from "./issue-execution-ref-delivery.js";

export interface IssueExecutionRunIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
}

/**
 * Exact persisted run/runtime scope used by initialize-only readiness. The run
 * service owns this projection so no consumer can read the canonical run table
 * through a parallel query path.
 */
export interface IssueExecutionRuntimeReadinessBinding
  extends IssueExecutionRunIdentity {
  readonly runKind: IssueExecutionRunKind;
  readonly runStatus: IssueExecutionRunStatus;
  readonly agentId: string;
  readonly currentAdapterConfigRevisionId: string | null;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly absoluteCwd: string | null;
  readonly acpConfiguration: unknown;
}

export interface ResumedAgentSteeringLivenessSource {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly refId: string;
  readonly segmentOrdinal: number;
  readonly committedAt: Date;
}

export type ResumedAgentSteeringLivenessSearch =
  | {
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
      readonly sourceRunId: string;
    }
  | {
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
      readonly committedAfter: Date;
    };

export interface PurgeCompanyIssueExecutionRunsInput {
  readonly companyId: string;
}

export interface PurgedCompanyIssueExecutionRuns {
  readonly companyId: string;
  readonly deletedRunCount: number;
}

/**
 * The exact active productive/consult envelope exposed to steering. Prompt
 * membership and settlement remain in their dedicated run-ref/control rows.
 */
export interface SteerableIssueExecutionRun extends IssueExecutionRunIdentity {
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly kind: "productive" | "consult";
  readonly status: "running";
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly executionMode: "owner" | "consult";
  readonly issueExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly currentAttemptId: string;
  readonly currentLeaseId: string;
  readonly cancellationIntentId: string | null;
  readonly terminalFinalizationId: null;
  readonly startedAt: Date;
  readonly finishedAt: null;
}

export interface ReboundSteerableIssueExecutionRun
  extends Omit<
    SteerableIssueExecutionRun,
    "currentAttemptId" | "currentLeaseId" | "cancellationIntentId"
  > {
  readonly currentAttemptId: null;
  readonly currentLeaseId: null;
  readonly cancellationIntentId: null;
}

export class IssueExecutionRunInvariantViolation extends Error {
  readonly code = "issue_execution_run_invariant_violation";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionRunInvariantViolation";
  }
}

/**
 * The closed run-envelope projection. It deliberately contains no prompt,
 * transcript, result, usage, settlement, activity, or workspace-operation
 * payload; those facts remain in their typed owners below the joined reader.
 */
export interface IssueExecutionRunEnvelope extends IssueExecutionRunIdentity {
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly kind: IssueExecutionRunKind;
  readonly status: IssueExecutionRunStatus;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly executionMode: "owner" | "consult";
  readonly issueExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly parentRunId: string | null;
  readonly retryOfRunId: string | null;
  readonly currentAttemptId: string | null;
  readonly currentLeaseId: string | null;
  readonly cancellationIntentId: string | null;
  readonly terminalFinalizationId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly terminalClassification:
    | IssueExecutionRunTerminalClassification
    | null;
  readonly terminalReasonCode: string | null;
  readonly processExitCode: number | null;
  readonly processSignal: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface CreateIssueExecutionRunCommon {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly ownershipEpoch: number;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly retryOfRunId?: string | null;
  readonly at: Date;
}

export type CreateIssueExecutionRunInput =
  | (CreateIssueExecutionRunCommon & {
      readonly kind: "productive";
      readonly targetAgentId: string;
      readonly issueExecutionAuthorityId: string;
      readonly orderedRefIds: readonly string[];
    })
  | (CreateIssueExecutionRunCommon & {
      readonly kind: "consult";
      readonly targetAgentId: string;
      readonly consultExecutionId: string;
      readonly parentRunId: string;
      readonly orderedRefIds: readonly string[];
    });

export interface CreatedIssueExecutionRun {
  readonly run: IssueExecutionRunEnvelope;
  readonly refs: readonly IssueExecutionRunRef[];
  readonly batchDigest: string | null;
}

export type TransitionIssueExecutionRunStatusInput =
  | (IssueExecutionRunIdentity & {
      readonly expectedStatus: "queued" | "scheduled_retry";
      readonly status: "running";
      readonly startedAt: Date;
      readonly at: Date;
    })
  | (IssueExecutionRunIdentity & {
      readonly expectedStatus: "queued" | "running";
      readonly status: "scheduled_retry";
      readonly at: Date;
    })
  | (IssueExecutionRunIdentity & {
      readonly expectedStatus: "scheduled_retry";
      readonly status: "queued";
      readonly at: Date;
    });

export interface AttachIssueExecutionRunAttemptInput
  extends IssueExecutionRunIdentity {
  readonly attemptId: string;
  readonly leaseId: string;
  readonly at: Date;
}

export interface DetachIssueExecutionRunAttemptInput
  extends IssueExecutionRunIdentity {
  readonly expectedAttemptId: string;
  readonly expectedLeaseId: string;
  readonly at: Date;
}

export interface AttachIssueExecutionRunCancellationInput
  extends IssueExecutionRunIdentity {
  readonly expectedAttemptId: string;
  readonly expectedLeaseId: string;
  readonly cancellationIntentId: string;
  readonly at: Date;
}

export interface DetachIssueExecutionRunCancellationInput
  extends IssueExecutionRunIdentity {
  readonly expectedCancellationIntentId: string;
  readonly at: Date;
}

/** Finalization attachment and the terminal lifecycle transition are atomic. */
export interface AttachIssueExecutionRunFinalizationInput
  extends IssueExecutionRunIdentity {
  readonly expectedStatus: "queued" | "scheduled_retry" | "running";
  readonly finalizationId: string;
  readonly status: IssueExecutionRunTerminalClassification;
  readonly terminalReasonCode: string;
  readonly finishedAt: Date;
  readonly at: Date;
}

export interface IssueExecutionRunListCursor {
  /** Exact PostgreSQL timestamptz text; JavaScript Date loses microseconds. */
  readonly createdAt: string;
  readonly runId: string;
}

export interface IssueExecutionRunListPage {
  readonly items: readonly IssueExecutionRunEnvelope[];
  readonly nextCursor: IssueExecutionRunListCursor | null;
}

export interface BoundedIssueExecutionRunRecords<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly nextCursor?: string | null;
}

export interface RedactedIssueExecutionSessionEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RedactedIssueExecutionSessionMessage {
  readonly id: string;
  readonly seq: number;
  readonly modelStateSeq: number;
  readonly type:
    | "agent-switched"
    | "model-switched"
    | "user"
    | "synthetic"
    | "system"
    | "shell"
    | "assistant";
  readonly data: Record<string, unknown>;
  readonly timeCreated: Date;
  readonly timeUpdated: Date;
}

export interface RedactedIssueExecutionActivity {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly agentId: string | null;
  readonly responsibleUserId: string | null;
  readonly details: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface IssueExecutionRunOutputCommentLink {
  readonly commentId: string;
  readonly messageId: string;
  readonly sourceKind: "run_output" | "run_progress" | "issue_update";
  readonly projectedEventSeq: number;
}

export interface IssueExecutionJoinedFinalization {
  readonly record: IssueExecutionFinalization;
  readonly promptDependencies:
    BoundedIssueExecutionRunRecords<IssueExecutionFinalizationPromptDependency>;
  readonly updateDependencies:
    BoundedIssueExecutionRunRecords<IssueExecutionFinalizationUpdateDependency>;
  readonly liveness: IssueExecutionRunLivenessFactRow | null;
}

export interface JoinedIssueExecutionRunDetail {
  readonly run: IssueExecutionRunEnvelope;
  readonly control: IssueExecutionRunControl | null;
  readonly refs: BoundedIssueExecutionRunRecords<IssueExecutionRunRef>;
  readonly segments: BoundedIssueExecutionRunRecords<IssueExecutionPromptSegment>;
  readonly sessionEvents:
    BoundedIssueExecutionRunRecords<RedactedIssueExecutionSessionEvent>;
  readonly sessionMessages:
    BoundedIssueExecutionRunRecords<RedactedIssueExecutionSessionMessage>;
  readonly attempts: BoundedIssueExecutionRunRecords<IssueExecutionAttempt>;
  readonly retrySchedules:
    BoundedIssueExecutionRunRecords<IssueExecutionAttemptRetrySchedule>;
  readonly leases: BoundedIssueExecutionRunRecords<IssueExecutionLease>;
  readonly processFacts:
    BoundedIssueExecutionRunRecords<IssueExecutionProcessFact>;
  readonly cancellations:
    BoundedIssueExecutionRunRecords<IssueExecutionCancellationIntent>;
  readonly accounting: BoundedIssueExecutionRunRecords<
    typeof acpPromptAccounting.$inferSelect
  >;
  readonly costs: BoundedIssueExecutionRunRecords<
    typeof costEvents.$inferSelect
  >;
  readonly activity:
    BoundedIssueExecutionRunRecords<RedactedIssueExecutionActivity>;
  readonly watchdogDecisions: BoundedIssueExecutionRunRecords<
    typeof issueExecutionWatchdogDecisions.$inferSelect
  >;
  readonly outputComments:
    BoundedIssueExecutionRunRecords<IssueExecutionRunOutputCommentLink>;
  readonly finalization: IssueExecutionJoinedFinalization | null;
}

export interface ReadJoinedIssueExecutionRunDetailInput
  extends IssueExecutionRunIdentity {
  readonly limit: number;
  readonly sessionProjection?: IssueSessionReadProjection;
  readonly sessionEventCursor?: string | null;
  readonly sessionMessageCursor?: string | null;
}

const MAX_RUN_LIST_PAGE_SIZE = 200;
const MAX_RUN_DETAIL_OWNER_ROWS = 500;
const RUN_STATUS_FILTER_VALUES = new Set<string>(
  ISSUE_EXECUTION_RUN_STATUSES,
);
const TERMINAL_RUN_STATUSES = new Set<IssueExecutionRunStatus>([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

function assertExactRunIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionRunInvariantViolation(
      `${label} must be exact and non-empty`,
    );
  }
}

function assertRunIdentity(input: IssueExecutionRunIdentity): void {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.issueId, "issue id");
  assertExactRunIdentifier(input.runId, "run id");
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new IssueExecutionRunInvariantViolation(`${label} must be a date`);
  }
}

function assertPageLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new IssueExecutionRunInvariantViolation(
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
}

function assertRunStatusFilter(
  statuses: readonly IssueExecutionRunStatus[] | undefined,
): void {
  if (statuses === undefined) return;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.length > ISSUE_EXECUTION_RUN_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some(
      (status) =>
        typeof status !== "string" || !RUN_STATUS_FILTER_VALUES.has(status),
    )
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run status filter must contain unique closed run statuses",
    );
  }
}

function assertRunEnvelopeInvariant(run: IssueExecutionRunEnvelope): void {
  assertRunIdentity(run);
  for (const [label, value] of [
    ["session id", run.sessionId],
    ["execution scope id", run.executionScopeId],
    ["adapter config revision id", run.adapterConfigRevisionId],
    ["execution workspace binding id", run.executionWorkspaceBindingId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  if (!Number.isSafeInteger(run.ownershipEpoch) || run.ownershipEpoch < 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run ownership epoch must be a positive integer",
    );
  }
  const productiveShape =
    run.kind === "productive" &&
    run.executionMode === "owner" &&
    run.issueExecutionAuthorityId !== null &&
    run.consultExecutionId === null &&
    run.parentRunId === null;
  const consultShape =
    run.kind === "consult" &&
    run.executionMode === "consult" &&
    run.issueExecutionAuthorityId === null &&
    run.consultExecutionId !== null &&
    run.parentRunId !== null;
  if (!productiveShape && !consultShape) {
    throw new IssueExecutionRunInvariantViolation(
      "run kind provenance is not canonical",
    );
  }
  if ((run.currentAttemptId === null) !== (run.currentLeaseId === null)) {
    throw new IssueExecutionRunInvariantViolation(
      "run attempt and lease pointers must be paired",
    );
  }
  if (
    run.cancellationIntentId !== null &&
    (run.currentAttemptId === null || run.currentLeaseId === null)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run cancellation pointer requires the exact current attempt and lease",
    );
  }
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  if (
    terminal !==
      (run.finishedAt !== null &&
        run.terminalFinalizationId !== null &&
        run.terminalClassification === run.status &&
        run.terminalReasonCode !== null)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run terminal envelope is incomplete",
    );
  }
  if (
    terminal &&
    (run.currentAttemptId !== null ||
      run.currentLeaseId !== null ||
      run.cancellationIntentId !== null)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "terminal run retains an active control pointer",
    );
  }
  if (
    !terminal &&
    (run.finishedAt !== null ||
      run.terminalFinalizationId !== null ||
      run.terminalClassification !== null ||
      run.terminalReasonCode !== null ||
      run.processExitCode !== null ||
      run.processSignal !== null)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "active run contains terminal facts",
    );
  }
  if (run.status === "running" && run.startedAt === null) {
    throw new IssueExecutionRunInvariantViolation(
      "running run requires its start time",
    );
  }
  if (
    run.processExitCode !== null &&
    (run.processSignal !== null ||
      !Number.isSafeInteger(run.processExitCode) ||
      run.processExitCode < 0 ||
      run.processExitCode > 255)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run process exit classification is invalid",
    );
  }
  if (
    run.processSignal !== null &&
    (run.processExitCode !== null || !/^SIG[A-Z0-9]+$/.test(run.processSignal))
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run process signal classification is invalid",
    );
  }
  assertDate(run.createdAt, "run creation time");
  assertDate(run.updatedAt, "run update time");
  if (run.updatedAt < run.createdAt) {
    throw new IssueExecutionRunInvariantViolation(
      "run update time predates creation",
    );
  }
}

function projectRunEnvelope(
  row: typeof issueExecutionRuns.$inferSelect,
): IssueExecutionRunEnvelope {
  const run: IssueExecutionRunEnvelope = {
    companyId: row.companyId,
    issueId: row.issueId,
    runId: row.id,
    sessionId: row.sessionId,
    executionScopeId: row.executionScopeId,
    kind: row.kind,
    status: row.status,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    executionWorkspaceBindingId: row.executionWorkspaceBindingId,
    executionMode: row.executionMode,
    issueExecutionAuthorityId: row.issueExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    parentRunId: row.parentRunId,
    retryOfRunId: row.retryOfRunId,
    currentAttemptId: row.currentAttemptId,
    currentLeaseId: row.currentLeaseId,
    cancellationIntentId: row.cancellationIntentId,
    terminalFinalizationId: row.terminalFinalizationId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    terminalClassification: row.terminalClassification,
    terminalReasonCode: row.terminalReasonCode,
    processExitCode: row.processExitCode,
    processSignal: row.processSignal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  assertRunEnvelopeInvariant(run);
  return run;
}

/**
 * Shared select/join base for the two steering-liveness lookups below. The
 * caller chains its own where/orderBy/limit/for tail.
 */
function steeringLivenessBaseQuery(transaction: IssueSessionDbTransaction) {
  return transaction
    .select({
      companyId: issueExecutionRuns.companyId,
      issueId: issueExecutionRuns.issueId,
      ownershipEpoch: issueExecutionRuns.ownershipEpoch,
      runId: issueExecutionPromptSegments.runId,
      refId: issueExecutionPromptSegments.refId,
      segmentOrdinal: issueExecutionPromptSegments.segmentOrdinal,
      committedAt: issueExecutionPromptSegments.resumedAt,
    })
    .from(issueExecutionPromptSegments)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(
          issueExecutionRuns.companyId,
          issueExecutionPromptSegments.companyId,
        ),
        eq(issueExecutionRuns.issueId, issueExecutionPromptSegments.issueId),
        eq(issueExecutionRuns.id, issueExecutionPromptSegments.runId),
      ),
    )
    .innerJoin(
      issueComments,
      eq(issueComments.id, issueExecutionPromptSegments.sourceCommentId),
    )
    .innerJoin(
      issueSessionEvents,
      and(
        eq(issueSessionEvents.companyId, issueComments.companyId),
        eq(issueSessionEvents.issueId, issueComments.issueId),
        eq(issueSessionEvents.sessionId, issueComments.sessionId),
        eq(issueSessionEvents.sourceId, issueComments.canonicalSourceId),
      ),
    )
    .$dynamic();
}

/**
 * Resolves and locks the exact successful agent-authored steering action used
 * by the closed P15 action-source recorder. The run service owns the join
 * because the action is valid only in the canonical run's company/issue/epoch
 * scope; the Session comment and event prove that it was agent-authored.
 */
export async function lockResumedAgentSteeringLivenessSourceInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly runId: string;
    readonly refId: string;
    readonly segmentOrdinal: number;
  },
): Promise<ResumedAgentSteeringLivenessSource | null> {
  assertExactRunIdentifier(input.runId, "steering liveness run id");
  assertExactRunIdentifier(input.refId, "steering liveness ref id");
  if (
    !Number.isSafeInteger(input.segmentOrdinal) ||
    input.segmentOrdinal < 1
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "steering liveness segment ordinal must be positive",
    );
  }
  const rows = await steeringLivenessBaseQuery(transaction)
    .where(
      and(
        eq(issueExecutionPromptSegments.runId, input.runId),
        eq(issueExecutionPromptSegments.refId, input.refId),
        eq(
          issueExecutionPromptSegments.segmentOrdinal,
          input.segmentOrdinal,
        ),
        isNotNull(issueExecutionPromptSegments.resumedAt),
        eq(issueComments.companyId, issueExecutionRuns.companyId),
        eq(issueComments.issueId, issueExecutionRuns.issueId),
        eq(issueComments.authorType, "agent"),
        eq(issueSessionEvents.sourceKind, "agent_active_run_steering"),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "steering liveness source is not unique",
    );
  }
  const row = rows[0];
  if (!row?.committedAt) return null;
  return Object.freeze({
    companyId: row.companyId,
    issueId: row.issueId,
    ownershipEpoch: row.ownershipEpoch,
    runId: row.runId,
    refId: row.refId,
    segmentOrdinal: row.segmentOrdinal,
    committedAt: row.committedAt,
  });
}

async function listResumedAgentSteeringLivenessActionsInTransaction(
  transaction: IssueSessionDbTransaction,
  input: ResumedAgentSteeringLivenessSearch,
): Promise<readonly ResumedAgentSteeringLivenessSource[]> {
  assertExactRunIdentifier(input.companyId, "steering liveness company id");
  assertExactRunIdentifier(input.issueId, "steering liveness issue id");
  if (
    !Number.isSafeInteger(input.ownershipEpoch) ||
    input.ownershipEpoch < 1
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "steering liveness ownership epoch must be positive",
    );
  }
  if ("sourceRunId" in input) {
    assertExactRunIdentifier(input.sourceRunId, "steering source run id");
  } else if (
    !(input.committedAfter instanceof Date) ||
    !Number.isFinite(input.committedAfter.getTime())
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "steering liveness admission time is invalid",
    );
  }
  const rows = await steeringLivenessBaseQuery(transaction)
    .where(
      and(
        eq(issueExecutionPromptSegments.companyId, input.companyId),
        eq(issueExecutionPromptSegments.issueId, input.issueId),
        eq(issueExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        isNotNull(issueExecutionPromptSegments.resumedAt),
        "sourceRunId" in input
          ? eq(issueComments.runId, input.sourceRunId)
          : gt(
              issueExecutionPromptSegments.resumedAt,
              input.committedAfter,
            ),
        eq(issueComments.authorType, "agent"),
        eq(issueSessionEvents.sourceKind, "agent_active_run_steering"),
      ),
    )
    .orderBy(
      asc(issueExecutionPromptSegments.resumedAt),
      asc(issueExecutionPromptSegments.runId),
      asc(issueExecutionPromptSegments.segmentOrdinal),
    );
  return Object.freeze(
    rows.flatMap((row) =>
      row.committedAt
        ? [
            Object.freeze({
              companyId: row.companyId,
              issueId: row.issueId,
              ownershipEpoch: row.ownershipEpoch,
              runId: row.runId,
              refId: row.refId,
              segmentOrdinal: row.segmentOrdinal,
              committedAt: row.committedAt,
            }),
          ]
        : [],
    ),
  );
}

/**
 * Stable text-free digest of the exact locked batch. Only immutable identities
 * and admission order/version participate; prompt bytes never do.
 */
export function computeIssueExecutionRunBatchDigest(
  members: readonly {
    readonly refId: string;
    readonly messageKind: "user" | "synthetic";
    readonly sourceMessageId: string;
    readonly admissionOrder: number;
    readonly admissionVersion: number;
  }[],
): string {
  if (members.length === 0) {
    throw new IssueExecutionRunInvariantViolation(
      "productive and consult runs require a non-empty ref batch",
    );
  }
  const hash = createHash("sha256");
  hash.update("paperclip.issue-execution-run-batch/v2\n", "utf8");
  const seen = new Set<string>();
  let previousAdmissionOrder = -1;
  members.forEach((member, refOrdinal) => {
    assertExactRunIdentifier(member.refId, "run ref id");
    assertExactRunIdentifier(member.sourceMessageId, "run ref source message id");
    if (member.messageKind !== "user" && member.messageKind !== "synthetic") {
      throw new IssueExecutionRunInvariantViolation(
        "run ref batch contains an invalid source message kind",
      );
    }
    if (seen.has(member.refId)) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref batch contains a duplicate identity",
      );
    }
    seen.add(member.refId);
    if (
      !Number.isSafeInteger(member.admissionOrder) ||
      member.admissionOrder < 0 ||
      member.admissionOrder <= previousAdmissionOrder ||
      !Number.isSafeInteger(member.admissionVersion) ||
      member.admissionVersion < 0
    ) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref batch admission order/version is invalid",
      );
    }
    previousAdmissionOrder = member.admissionOrder;
    hash.update(
      `${refOrdinal}\0${member.refId}\0${member.messageKind}\0${member.sourceMessageId}\0${member.admissionOrder}\0${member.admissionVersion}\n`,
      "utf8",
    );
  });
  return hash.digest("hex");
}

async function selectExactRunRow(
  database: Db | IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
  lock: boolean,
): Promise<typeof issueExecutionRuns.$inferSelect | null> {
  assertRunIdentity(input);
  const base = database
    .select()
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
      ),
    )
    .limit(1);
  const rows = lock ? await base.for("update") : await base;
  return rows[0] ?? null;
}

export async function readIssueExecutionRun(
  database: Db | IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
): Promise<IssueExecutionRunEnvelope | null> {
  const row = await selectExactRunRow(database, input, false);
  return row ? projectRunEnvelope(row) : null;
}

export async function readIssueExecutionRuntimeReadinessBinding(
  database: Db | IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
): Promise<IssueExecutionRuntimeReadinessBinding | null> {
  assertRunIdentity(input);
  const rows = await database
    .select({
      companyId: issueExecutionRuns.companyId,
      issueId: issueExecutionRuns.issueId,
      runId: issueExecutionRuns.id,
      runKind: issueExecutionRuns.kind,
      runStatus: issueExecutionRuns.status,
      targetAgentId: issueExecutionRuns.targetAgentId,
      adapterConfigRevisionId: issueExecutionRuns.adapterConfigRevisionId,
      executionWorkspaceBindingId:
        issueExecutionRuns.executionWorkspaceBindingId,
      currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
      revisionId: agentAdapterConfigRevisions.id,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
      bindingId: issueExecutionWorkspaceBindings.id,
      bindingAbsoluteCwd: issueExecutionWorkspaceBindings.absoluteCwd,
    })
    .from(issueExecutionRuns)
    .leftJoin(
      agents,
      and(
        eq(agents.companyId, issueExecutionRuns.companyId),
        eq(agents.id, issueExecutionRuns.targetAgentId),
      ),
    )
    .leftJoin(
      agentAdapterConfigRevisions,
      and(
        eq(
          agentAdapterConfigRevisions.companyId,
          issueExecutionRuns.companyId,
        ),
        eq(
          agentAdapterConfigRevisions.agentId,
          issueExecutionRuns.targetAgentId,
        ),
        eq(
          agentAdapterConfigRevisions.id,
          issueExecutionRuns.adapterConfigRevisionId,
        ),
      ),
    )
    .leftJoin(
      issueExecutionWorkspaceBindings,
      and(
        eq(
          issueExecutionWorkspaceBindings.companyId,
          issueExecutionRuns.companyId,
        ),
        eq(
          issueExecutionWorkspaceBindings.issueId,
          issueExecutionRuns.issueId,
        ),
        eq(
          issueExecutionWorkspaceBindings.sessionId,
          issueExecutionRuns.sessionId,
        ),
        eq(
          issueExecutionWorkspaceBindings.ownershipEpoch,
          issueExecutionRuns.ownershipEpoch,
        ),
        eq(
          issueExecutionWorkspaceBindings.id,
          issueExecutionRuns.executionWorkspaceBindingId,
        ),
      ),
    )
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.id, input.runId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "runtime-readiness run identity resolved more than once",
    );
  }
  const row = rows[0];
  if (!row) return null;
  if (
    !row.revisionId ||
    !row.executionWorkspaceBindingId
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "issue-execution run violates the persisted runtime-readiness scope invariant",
    );
  }
  return Object.freeze({
    companyId: row.companyId,
    issueId: row.issueId,
    runId: row.runId,
    runKind: row.runKind,
    runStatus: row.runStatus,
    agentId: row.targetAgentId,
    currentAdapterConfigRevisionId: row.currentAdapterConfigRevisionId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    executionWorkspaceBindingId: row.executionWorkspaceBindingId,
    absoluteCwd:
      row.bindingId === row.executionWorkspaceBindingId
        ? row.bindingAbsoluteCwd
        : null,
    acpConfiguration: row.acpConfiguration,
  });
}

/**
 * Resolve the complete canonical identity behind a URL/tool run selector.
 * Every subsequent read or mutation must use the returned company/issue/id
 * tuple; no caller receives an arbitrary run-row query surface.
 */
export async function resolveIssueExecutionRunIdentityById(
  database: Db | IssueSessionDbTransaction,
  runId: string,
): Promise<IssueExecutionRunIdentity | null> {
  assertExactRunIdentifier(runId, "run id");
  const rows = await database
    .select({
      companyId: issueExecutionRuns.companyId,
      issueId: issueExecutionRuns.issueId,
      runId: issueExecutionRuns.id,
    })
    .from(issueExecutionRuns)
    .where(eq(issueExecutionRuns.id, runId))
    .limit(2);
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run selector resolved more than one canonical identity",
    );
  }
  return rows[0] ?? null;
}

export async function lockIssueExecutionRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
): Promise<IssueExecutionRunEnvelope> {
  const run = await lockIssueExecutionRunIfPresentInTransaction(
    transaction,
    input,
  );
  if (!run) {
    throw new IssueExecutionRunInvariantViolation(
      "selected issue-execution run does not exist in the exact scope",
    );
  }
  return run;
}

/** Optional exact lock for callers whose domain result distinguishes absence. */
export async function lockIssueExecutionRunIfPresentInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
): Promise<IssueExecutionRunEnvelope | null> {
  const row = await selectExactRunRow(transaction, input, true);
  return row ? projectRunEnvelope(row) : null;
}

/**
 * Correlated terminal-finalization predicate for a source run whose exact
 * company, issue, and run columns are already selected by a caller. Dispatch
 * discovery keeps one atomic SQL selection, while this service remains the
 * sole owner of the canonical run table and its terminal invariant.
 */
export function terminalFinalizedIssueExecutionRunExistsSql(
  companyId: SQLWrapper,
  issueId: SQLWrapper,
  runId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${issueExecutionRuns}
    where ${issueExecutionRuns.companyId} = ${companyId}
      and ${issueExecutionRuns.issueId} = ${issueId}
      and ${issueExecutionRuns.id} = ${runId}
      and ${issueExecutionRuns.terminalFinalizationId} is not null
  )`;
}

/**
 * Ordered prior-run enumeration for one exact recovered agent session. The
 * recovery layer owns eligibility and trace restoration; this service owns
 * the run-table query and its tenancy/scope fence.
 */
export async function listPriorIssueExecutionRunIdsForAgent(
  database: Db,
  input: IssueExecutionRunIdentity & {
    readonly sessionId: string;
    readonly targetAgentId: string;
  },
): Promise<readonly string[]> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.sessionId, "session id");
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  const rows = await database
    .select({ id: issueExecutionRuns.id })
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.sessionId, input.sessionId),
        eq(issueExecutionRuns.targetAgentId, input.targetAgentId),
        ne(issueExecutionRuns.id, input.runId),
      ),
    )
    .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id));
  return Object.freeze(rows.map((row) => row.id));
}

/**
 * Locks the sole direct retry successor owned by one exact terminal run. Run
 * creation serializes on that source and rejects a second successor, so seeing
 * more than one row is a canonical run-envelope invariant failure.
 */
export async function lockIssueExecutionRetrySuccessorInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity,
): Promise<IssueExecutionRunEnvelope | null> {
  const source = await selectExactRunRow(transaction, input, true);
  if (!source) {
    throw new IssueExecutionRunInvariantViolation(
      "retry source run does not exist in the exact scope",
    );
  }
  const rows = await transaction
    .select()
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.retryOfRunId, input.runId),
      ),
    )
    .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "retry source run owns more than one successor",
    );
  }
  return rows[0] ? projectRunEnvelope(rows[0]) : null;
}

/**
 * Resolve every active run currently owning one exact execution ref. The run
 * root remains opaque to the input/admission owners; only canonical envelopes
 * cross this boundary.
 */
export async function lockActiveIssueExecutionRunsForRefInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly refId: string;
  },
): Promise<readonly IssueExecutionRunEnvelope[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["session id", input.sessionId],
    ["execution ref id", input.refId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  const rows = await transaction
    .select({ run: issueExecutionRuns })
    .from(issueExecutionRunRefs)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.id, issueExecutionRunRefs.runId),
        eq(issueExecutionRuns.companyId, issueExecutionRunRefs.companyId),
        eq(issueExecutionRuns.issueId, issueExecutionRunRefs.issueId),
      ),
    )
    .where(
      and(
        eq(issueExecutionRunRefs.companyId, input.companyId),
        eq(issueExecutionRunRefs.issueId, input.issueId),
        eq(issueExecutionRunRefs.sessionId, input.sessionId),
        eq(issueExecutionRunRefs.refId, input.refId),
        inArray(issueExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    )
    .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
    .limit(2)
    .for("update", { of: issueExecutionRuns });
  return Object.freeze(rows.map((row) => projectRunEnvelope(row.run)));
}

export interface LockedIssueExecutionRunRefMembership {
  readonly run: IssueExecutionRunEnvelope;
  readonly refOrdinal: number;
  readonly currentRefId: string | null;
  readonly currentOrdinal: number | null;
}

/**
 * Locks one exact run/member/control tuple without exposing the canonical run
 * table to consult-chain consumers.
 */
export async function lockIssueExecutionRunRefMembershipInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity & { readonly refId: string },
): Promise<LockedIssueExecutionRunRefMembership | null> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await transaction
    .select({
      run: issueExecutionRuns,
      refOrdinal: issueExecutionRunRefs.refOrdinal,
      currentRefId: issueExecutionRunControls.currentRefId,
      currentOrdinal: issueExecutionRunControls.currentOrdinal,
    })
    .from(issueExecutionRuns)
    .innerJoin(
      issueExecutionRunRefs,
      and(
        eq(issueExecutionRunRefs.runId, issueExecutionRuns.id),
        eq(issueExecutionRunRefs.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionRunRefs.issueId, issueExecutionRuns.issueId),
      ),
    )
    .innerJoin(
      issueExecutionRunControls,
      eq(issueExecutionRunControls.runId, issueExecutionRuns.id),
    )
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRunRefs.refId, input.refId),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "issue-execution run has ambiguous execution-ref membership",
    );
  }
  const row = rows[0];
  if (!row) return null;
  const run = projectRunEnvelope(row.run);
  assertRunEnvelopeInvariant(run);
  return Object.freeze({
    run,
    refOrdinal: row.refOrdinal,
    currentRefId: row.currentRefId,
    currentOrdinal: row.currentOrdinal,
  });
}

/** Active run membership used to exclude refs already owned by a run. */
export async function readOccupiedIssueExecutionRefIds(
  database: Db | IssueSessionDbTransaction,
  input: {
    readonly companyId?: string;
    readonly issueId?: string;
    readonly sessionId?: string;
    readonly ownershipEpoch?: number;
    readonly targetAgentId?: string;
    readonly refIds?: readonly string[];
  },
): Promise<readonly string[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    if (value !== undefined) assertExactRunIdentifier(value, label);
  }
  if (
    input.ownershipEpoch !== undefined &&
    (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "ownership epoch must be a positive integer",
    );
  }
  const refIds = input.refIds === undefined
    ? undefined
    : [...new Set(input.refIds)];
  if (refIds !== undefined) {
    for (const refId of refIds) {
      assertExactRunIdentifier(refId, "execution ref id");
    }
    if (refIds.length === 0) return Object.freeze([]);
  }
  const rows = await database
    .select({ refId: issueExecutionRunRefs.refId })
    .from(issueExecutionRunRefs)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.id, issueExecutionRunRefs.runId),
        eq(issueExecutionRuns.companyId, issueExecutionRunRefs.companyId),
        eq(issueExecutionRuns.issueId, issueExecutionRunRefs.issueId),
      ),
    )
    .where(
      and(
        input.companyId === undefined
          ? undefined
          : eq(issueExecutionRunRefs.companyId, input.companyId),
        input.issueId === undefined
          ? undefined
          : eq(issueExecutionRunRefs.issueId, input.issueId),
        input.sessionId === undefined
          ? undefined
          : eq(issueExecutionRunRefs.sessionId, input.sessionId),
        input.ownershipEpoch === undefined
          ? undefined
          : eq(issueExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        input.targetAgentId === undefined
          ? undefined
          : eq(issueExecutionRuns.targetAgentId, input.targetAgentId),
        refIds === undefined
          ? undefined
          : inArray(issueExecutionRunRefs.refId, refIds),
        inArray(issueExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    );
  return Object.freeze([...new Set(rows.map((row) => row.refId))]);
}

/** Lock the one active productive/consult run for an exact target lane. */
export async function lockActiveProductiveRunForLaneInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionTargetLaneIdentity,
): Promise<IssueExecutionRunEnvelope | null> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new IssueExecutionRunInvariantViolation(
      "ownership epoch must be a positive integer",
    );
  }
  const rows = await transaction
    .select({ run: issueExecutionRuns })
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.sessionId, input.sessionId),
        eq(issueExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        eq(issueExecutionRuns.targetAgentId, input.targetAgentId),
        inArray(issueExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
        inArray(issueExecutionRuns.kind, ["productive", "consult"]),
      ),
    )
    .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
    .limit(2)
    .for("update", { of: issueExecutionRuns });
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "target lane has more than one active productive/consult run",
    );
  }
  return rows[0] ? projectRunEnvelope(rows[0].run) : null;
}

export interface ActiveIssueExecutionRefRunAvailability {
  readonly run: IssueExecutionRunEnvelope;
  readonly leaseExpiresAt: Date | null;
  readonly retryAt: Date | null;
}

/** Resolve the one active run lifecycle currently attached to a persisted ref. */
export async function readActiveIssueExecutionRefRunAvailability(
  database: Db,
  input: { readonly refId: string },
): Promise<ActiveIssueExecutionRefRunAvailability | null> {
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await database
    .select({
      run: issueExecutionRuns,
      leaseExpiresAt: issueExecutionLeases.expiresAt,
      retryAt: issueExecutionAttemptRetrySchedules.retryAt,
    })
    .from(issueExecutionRunRefs)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.id, issueExecutionRunRefs.runId),
        eq(issueExecutionRuns.companyId, issueExecutionRunRefs.companyId),
        eq(issueExecutionRuns.issueId, issueExecutionRunRefs.issueId),
      ),
    )
    .leftJoin(
      issueExecutionLeases,
      eq(issueExecutionLeases.id, issueExecutionRuns.currentLeaseId),
    )
    .leftJoin(
      issueExecutionAttemptRetrySchedules,
      and(
        eq(issueExecutionAttemptRetrySchedules.runId, issueExecutionRuns.id),
        eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(
      and(
        eq(issueExecutionRunRefs.refId, input.refId),
        inArray(issueExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    )
    .orderBy(desc(issueExecutionRuns.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "execution ref belongs to multiple active run lifecycles",
    );
  }
  const row = rows[0];
  return row
    ? {
        run: projectRunEnvelope(row.run),
        leaseExpiresAt: row.leaseExpiresAt,
        retryAt: row.retryAt,
      }
    : null;
}

export interface IssueExecutionLeaseBinding {
  readonly run: IssueExecutionRunEnvelope;
  readonly attemptState: typeof issueExecutionAttempts.$inferSelect.state;
  readonly leaseState: typeof issueExecutionLeases.$inferSelect.state;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: Date;
  readonly currentRefId: string | null;
}

/** One joined current-attempt/lease/control snapshot for lease validation. */
export async function readIssueExecutionLeaseBinding(
  database: Db,
  input: IssueExecutionRunIdentity & {
    readonly attemptId: string;
    readonly leaseId: string;
  },
): Promise<IssueExecutionLeaseBinding | null> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.attemptId, "attempt id");
  assertExactRunIdentifier(input.leaseId, "lease id");
  const rows = await database
    .select({
      run: issueExecutionRuns,
      attemptState: issueExecutionAttempts.state,
      leaseState: issueExecutionLeases.state,
      leaseGeneration: issueExecutionLeases.leaseGeneration,
      leaseExpiresAt: issueExecutionLeases.expiresAt,
      currentRefId: issueExecutionRunControls.currentRefId,
    })
    .from(issueExecutionRuns)
    .innerJoin(
      issueExecutionAttempts,
      and(
        eq(issueExecutionAttempts.id, input.attemptId),
        eq(issueExecutionAttempts.runId, issueExecutionRuns.id),
      ),
    )
    .innerJoin(
      issueExecutionLeases,
      and(
        eq(issueExecutionLeases.id, input.leaseId),
        eq(issueExecutionLeases.runId, issueExecutionRuns.id),
        eq(issueExecutionLeases.attemptId, issueExecutionAttempts.id),
      ),
    )
    .innerJoin(
      issueExecutionRunControls,
      eq(issueExecutionRunControls.runId, issueExecutionRuns.id),
    )
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "attempt lease resolved more than one run binding",
    );
  }
  const row = rows[0];
  return row
    ? {
        run: projectRunEnvelope(row.run),
        attemptState: row.attemptState,
        leaseState: row.leaseState,
        leaseGeneration: row.leaseGeneration,
        leaseExpiresAt: row.leaseExpiresAt,
        currentRefId: row.currentRefId,
      }
    : null;
}

/**
 * Active memberships that cannot be leased now. A ref omitted from this set
 * either has no active run or is the current detached/due prompt of one.
 */
export async function readBlockedActiveIssueExecutionRefIds(
  database: Db,
  input: { readonly now: Date },
): Promise<readonly string[]> {
  assertDate(input.now, "dispatch discovery time");
  const rows = await database
    .select({
      refId: issueExecutionRunRefs.refId,
      status: issueExecutionRuns.status,
      currentAttemptId: issueExecutionRuns.currentAttemptId,
      currentLeaseId: issueExecutionRuns.currentLeaseId,
      cancellationIntentId: issueExecutionRuns.cancellationIntentId,
      currentRefId: issueExecutionRunControls.currentRefId,
      leaseExpiresAt: issueExecutionLeases.expiresAt,
      retryAt: issueExecutionAttemptRetrySchedules.retryAt,
    })
    .from(issueExecutionRunRefs)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.id, issueExecutionRunRefs.runId),
        eq(issueExecutionRuns.companyId, issueExecutionRunRefs.companyId),
        eq(issueExecutionRuns.issueId, issueExecutionRunRefs.issueId),
      ),
    )
    .innerJoin(
      issueExecutionRunControls,
      eq(issueExecutionRunControls.runId, issueExecutionRuns.id),
    )
    .leftJoin(
      issueExecutionLeases,
      eq(issueExecutionLeases.id, issueExecutionRuns.currentLeaseId),
    )
    .leftJoin(
      issueExecutionAttemptRetrySchedules,
      and(
        eq(issueExecutionAttemptRetrySchedules.runId, issueExecutionRuns.id),
        eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(
      inArray(issueExecutionRuns.status, [
        "queued",
        "running",
        "scheduled_retry",
      ]),
    );
  const blocked = new Set<string>();
  for (const row of rows) {
    const detached =
      row.currentAttemptId === null &&
      row.currentLeaseId === null &&
      row.cancellationIntentId === null;
    const expired =
      row.currentAttemptId !== null &&
      row.currentLeaseId !== null &&
      row.cancellationIntentId === null &&
      row.leaseExpiresAt !== null &&
      row.leaseExpiresAt <= input.now;
    const due =
      row.status === "queued" ||
      row.status === "running" ||
      (row.status === "scheduled_retry" &&
        row.retryAt !== null &&
        row.retryAt <= input.now);
    if (row.currentRefId !== row.refId || (!detached && !expired) || !due) {
      blocked.add(row.refId);
    }
  }
  return Object.freeze([...blocked]);
}

/**
 * Canonical run-owner query used by exact-key target materialization GC.
 * The immutable adapter revision already owns the physical target and selected
 * skill set, so these three identities are the complete active-attempt scope.
 */
export async function hasActiveIssueExecutionAttemptForMaterializationInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly adapterConfigRevisionId: string;
  },
): Promise<boolean> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  assertExactRunIdentifier(
    input.adapterConfigRevisionId,
    "adapter configuration revision id",
  );
  const rows = await transaction
    .select({ id: issueExecutionAttempts.id })
    .from(issueExecutionAttempts)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.id, issueExecutionAttempts.runId),
        eq(issueExecutionRuns.companyId, issueExecutionAttempts.companyId),
        eq(issueExecutionRuns.issueId, issueExecutionAttempts.issueId),
      ),
    )
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.targetAgentId, input.targetAgentId),
        eq(
          issueExecutionRuns.adapterConfigRevisionId,
          input.adapterConfigRevisionId,
        ),
        inArray(issueExecutionAttempts.state, [
          "pending",
          "leased",
          "running",
        ]),
      ),
    )
    .limit(1);
  return rows.length !== 0;
}

/**
 * Revoke prompt capabilities through the run owner when a session boundary
 * moves or reverts. Projectors never join the run root themselves.
 */
export async function revokeIssueExecutionPromptCapabilitiesForSessionInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly reason: "session_moved" | "session_revert";
    readonly at: Date;
  },
): Promise<readonly string[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["session id", input.sessionId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  assertDate(input.at, "prompt capability revocation time");
  const runRows = await transaction
    .select({ runId: issueExecutionRuns.id })
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.sessionId, input.sessionId),
      ),
    );
  const runIds = runRows.map((row) => row.runId);
  if (runIds.length === 0) return Object.freeze([]);

  const revertedRefIds = input.reason === "session_revert"
    ? await transaction
        .select({ refId: issueExecutionRefs.id })
        .from(issueExecutionRefs)
        .where(
          and(
            eq(issueExecutionRefs.companyId, input.companyId),
            eq(issueExecutionRefs.issueId, input.issueId),
            eq(issueExecutionRefs.sessionId, input.sessionId),
            eq(issueExecutionRefs.disposition, "invalidated"),
            eq(issueExecutionRefs.invalidationReason, "session_revert"),
          ),
        )
        .then((rows) => rows.map((row) => row.refId))
    : null;
  if (revertedRefIds !== null && revertedRefIds.length === 0) {
    return Object.freeze([]);
  }
  const revoked = await transaction
    .update(issueExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: input.reason,
      revokedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionPromptCapabilities.companyId, input.companyId),
        eq(issueExecutionPromptCapabilities.issueId, input.issueId),
        inArray(issueExecutionPromptCapabilities.runId, runIds),
        inArray(issueExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
        revertedRefIds === null
          ? undefined
          : inArray(issueExecutionPromptCapabilities.refId, revertedRefIds),
      ),
    )
    .returning({
      capabilityConnectionId:
        issueExecutionPromptCapabilities.capabilityConnectionId,
    });
  return Object.freeze(
    [...new Set(revoked.map((row) => row.capabilityConnectionId))],
  );
}

/**
 * Sole company-scoped deletion owner for the canonical run roots. The
 * lifecycle caller must first fence dispatch, settle every attempt, and
 * remove the typed run-child owners; remaining restrictors fail the enclosing
 * transaction instead of being bypassed here.
 */
export async function purgeCompanyIssueExecutionRunsInTransaction(
  transaction: IssueSessionDbTransaction,
  input: PurgeCompanyIssueExecutionRunsInput,
): Promise<PurgedCompanyIssueExecutionRuns> {
  assertExactRunIdentifier(input.companyId, "company id");
  const deleted = await transaction
    .delete(issueExecutionRuns)
    .where(eq(issueExecutionRuns.companyId, input.companyId))
    .returning({ runId: issueExecutionRuns.id });
  return {
    companyId: input.companyId,
    deletedRunCount: deleted.length,
  };
}

function assertCreationInput(input: CreateIssueExecutionRunInput): void {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["session id", input.sessionId],
    ["execution scope id", input.executionScopeId],
    ["adapter config revision id", input.adapterConfigRevisionId],
    ["execution workspace binding id", input.executionWorkspaceBindingId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  assertDate(input.at, "run creation time");
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run ownership epoch must be a positive integer",
    );
  }
  if (input.retryOfRunId) {
    assertExactRunIdentifier(input.retryOfRunId, "retry run id");
  }
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  if (input.kind === "productive") {
    assertExactRunIdentifier(
      input.issueExecutionAuthorityId,
      "issue execution authority id",
    );
  } else {
    assertExactRunIdentifier(input.consultExecutionId, "consult execution id");
    assertExactRunIdentifier(input.parentRunId, "consult parent run id");
  }
  if (input.orderedRefIds.length === 0) {
    throw new IssueExecutionRunInvariantViolation(
      "productive and consult runs require a non-empty ref batch",
    );
  }
  const seen = new Set<string>();
  for (const refId of input.orderedRefIds) {
    assertExactRunIdentifier(refId, "run ref id");
    if (seen.has(refId)) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref batch contains a duplicate identity",
      );
    }
    seen.add(refId);
  }
}

function assertRelatedRunScope(
  related: IssueExecutionRunEnvelope,
  input: CreateIssueExecutionRunInput,
  relation: "parent" | "retry",
): void {
  const sameIssueEpoch =
    related.companyId === input.companyId &&
    related.issueId === input.issueId &&
    related.sessionId === input.sessionId &&
    related.ownershipEpoch === input.ownershipEpoch;
  if (!sameIssueEpoch) {
    throw new IssueExecutionRunInvariantViolation(
      `${relation} run does not belong to the exact issue session epoch`,
    );
  }
  if (relation === "retry") {
    const sameBranch = input.kind === "productive"
      ? related.issueExecutionAuthorityId ===
          input.issueExecutionAuthorityId &&
        related.consultExecutionId === null &&
        related.parentRunId === null
      : related.issueExecutionAuthorityId === null &&
        related.consultExecutionId === input.consultExecutionId &&
        related.parentRunId === input.parentRunId;
    if (
      related.executionScopeId !== input.executionScopeId ||
      related.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
      related.executionWorkspaceBindingId !==
        input.executionWorkspaceBindingId ||
      related.kind !== input.kind ||
      related.targetAgentId !== input.targetAgentId ||
      related.executionMode !==
        (input.kind === "productive" ? "owner" : "consult") ||
      !sameBranch ||
      !TERMINAL_RUN_STATUSES.has(related.status)
    ) {
      throw new IssueExecutionRunInvariantViolation(
        "retry run is not a terminal run of the exact same kind and scope",
      );
    }
    return;
  }
  if (
    (related.kind !== "productive" && related.kind !== "consult") ||
    TERMINAL_RUN_STATUSES.has(related.status)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      `${relation} run must be an active productive or consult run`,
    );
  }
}

/**
 * Creates the envelope and the complete productive/consult membership under
 * one caller-owned transaction. The caller must already hold the lane
 * admission fence; this function locks every named ref before deriving order.
 */
export async function createIssueExecutionRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: CreateIssueExecutionRunInput,
): Promise<CreatedIssueExecutionRun> {
  assertCreationInput(input);

  if (input.kind === "consult") {
    const parent = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.parentRunId,
      },
      true,
    );
    if (!parent) {
      throw new IssueExecutionRunInvariantViolation(
        "consult parent run does not exist",
      );
    }
    assertRelatedRunScope(projectRunEnvelope(parent), input, "parent");
  }
  if (input.retryOfRunId) {
    const retry = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.retryOfRunId,
      },
      true,
    );
    if (!retry) {
      throw new IssueExecutionRunInvariantViolation(
        "retry source run does not exist",
      );
    }
    assertRelatedRunScope(projectRunEnvelope(retry), input, "retry");
    const existingSuccessor = await transaction
      .select({ id: issueExecutionRuns.id })
      .from(issueExecutionRuns)
      .where(
        and(
          eq(issueExecutionRuns.companyId, input.companyId),
          eq(issueExecutionRuns.issueId, input.issueId),
          eq(issueExecutionRuns.retryOfRunId, input.retryOfRunId),
        ),
      )
      .limit(1)
      .for("update");
    if (existingSuccessor.length > 0) {
      throw new IssueExecutionRunInvariantViolation(
        "retry source run already owns its exact successor",
      );
    }
  }

  let lockedRefs: (typeof issueExecutionRefs.$inferSelect)[] = [];
  let batchDigest: string | null = null;
  {
    const rows = await transaction
      .select()
      .from(issueExecutionRefs)
      .where(
        and(
          eq(issueExecutionRefs.companyId, input.companyId),
          eq(issueExecutionRefs.issueId, input.issueId),
          eq(issueExecutionRefs.sessionId, input.sessionId),
          inArray(issueExecutionRefs.id, [...input.orderedRefIds]),
        ),
      )
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    lockedRefs = input.orderedRefIds.map((refId) => {
      const ref = byId.get(refId);
      if (!ref) {
        throw new IssueExecutionRunInvariantViolation(
          "run ref batch contains an identity outside the exact Session scope",
        );
      }
      return ref;
    });
    if (rows.length !== lockedRefs.length) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref batch did not lock one exact row per identity",
      );
    }
    for (const ref of lockedRefs) {
      const correctBranch =
        input.kind === "productive"
          ? ref.mode === "owner" &&
            ref.issueExecutionAuthorityId === input.issueExecutionAuthorityId &&
            ref.consultExecutionId === null
          : ref.mode === "consult" &&
            ref.issueExecutionAuthorityId === null &&
            ref.consultExecutionId === input.consultExecutionId;
      if (
        !correctBranch ||
        ref.disposition !== "active" ||
        ref.ownershipEpoch !== input.ownershipEpoch ||
        ref.executionScopeId !== input.executionScopeId ||
        ref.targetAgentId !== input.targetAgentId ||
        ref.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
        !isIssueExecutionRefDeliveryEligible(ref, "dispatch")
      ) {
        throw new IssueExecutionRunInvariantViolation(
          "run ref batch crossed its locked execution identity or admission state",
        );
      }
    }
    batchDigest = computeIssueExecutionRunBatchDigest(
      lockedRefs.map((ref) => ({
        refId: ref.id,
        messageKind: ref.messageKind,
        sourceMessageId: ref.sourceMessageId,
        admissionOrder: ref.laneOrdinal,
        admissionVersion: ref.admittedSeq ?? ref.admissionHighWaterSeq,
      })),
    );
  }

  const insertedRuns = await transaction
    .insert(issueExecutionRuns)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: input.sessionId,
      executionScopeId: input.executionScopeId,
      kind: input.kind,
      status: "queued",
      ownershipEpoch: input.ownershipEpoch,
      targetAgentId: input.targetAgentId,
      adapterConfigRevisionId: input.adapterConfigRevisionId,
      executionWorkspaceBindingId: input.executionWorkspaceBindingId,
      executionMode: input.kind === "productive" ? "owner" : "consult",
      issueExecutionAuthorityId:
        input.kind === "productive" ? input.issueExecutionAuthorityId : null,
      consultExecutionId:
        input.kind === "consult" ? input.consultExecutionId : null,
      parentRunId: input.kind === "consult" ? input.parentRunId : null,
      retryOfRunId: input.retryOfRunId ?? null,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning();
  const insertedRun = insertedRuns[0];
  if (!insertedRun) {
    throw new IssueExecutionRunInvariantViolation(
      "run creation did not return the canonical envelope",
    );
  }

  const insertedRefs = await transaction
      .insert(issueExecutionRunRefs)
      .values(
        lockedRefs.map((ref, refOrdinal) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          sessionId: input.sessionId,
          runId: insertedRun.id,
          refId: ref.id,
          refOrdinal,
          admissionOrder: ref.laneOrdinal,
          batchDigest: batchDigest!,
          inputId: ref.inputId,
          createdAt: input.at,
        })),
      )
      .returning();
    if (insertedRefs.length !== lockedRefs.length) {
      throw new IssueExecutionRunInvariantViolation(
        "run creation did not persist its complete immutable ref batch",
      );
    }
  await transaction.insert(issueExecutionRunControls).values({
    runId: insertedRun.id,
    currentRefId: null,
    currentOrdinal: null,
    currentSegmentOrdinal: null,
  });
  return {
    run: projectRunEnvelope(insertedRun),
    refs: insertedRefs,
    batchDigest,
  };
}

export async function transitionIssueExecutionRunStatusInTransaction(
  transaction: IssueSessionDbTransaction,
  input: TransitionIssueExecutionRunStatusInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertDate(input.at, "run transition time");
  if (input.status === "running") {
    assertDate(input.startedAt, "run start time");
    if (input.startedAt > input.at) {
      throw new IssueExecutionRunInvariantViolation(
        "run start time cannot follow its running transition",
      );
    }
  }
  const predicates = [
    eq(issueExecutionRuns.id, input.runId),
    eq(issueExecutionRuns.companyId, input.companyId),
    eq(issueExecutionRuns.issueId, input.issueId),
    eq(issueExecutionRuns.status, input.expectedStatus),
    isNull(issueExecutionRuns.terminalFinalizationId),
    isNull(issueExecutionRuns.finishedAt),
  ];
  if (input.status === "running") {
    predicates.push(
      input.startedAt.getTime() === input.at.getTime()
        ? sql`(
            ${issueExecutionRuns.startedAt} is null
            or ${issueExecutionRuns.startedAt} = ${input.startedAt}
          )`
        : eq(issueExecutionRuns.startedAt, input.startedAt),
    );
  }
  if (input.status !== "running") {
    predicates.push(
      isNull(issueExecutionRuns.currentAttemptId),
      isNull(issueExecutionRuns.currentLeaseId),
      isNull(issueExecutionRuns.cancellationIntentId),
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      status: input.status,
      ...(input.status === "running" ? { startedAt: input.startedAt } : {}),
      updatedAt: input.at,
    })
    .where(and(...predicates))
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      `run cannot transition from ${input.expectedStatus} to ${input.status}`,
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachIssueExecutionRunAttemptInTransaction(
  transaction: IssueSessionDbTransaction,
  input: AttachIssueExecutionRunAttemptInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.attemptId, "attempt id");
  assertExactRunIdentifier(input.leaseId, "lease id");
  assertDate(input.at, "attempt attachment time");
  const attempts = await transaction
    .select({
      id: issueExecutionAttempts.id,
      state: issueExecutionAttempts.state,
    })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.id, input.attemptId),
        eq(issueExecutionAttempts.companyId, input.companyId),
        eq(issueExecutionAttempts.issueId, input.issueId),
        eq(issueExecutionAttempts.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  const leases = await transaction
    .select({
      id: issueExecutionLeases.id,
      attemptId: issueExecutionLeases.attemptId,
      state: issueExecutionLeases.state,
    })
    .from(issueExecutionLeases)
    .where(
      and(
        eq(issueExecutionLeases.id, input.leaseId),
        eq(issueExecutionLeases.companyId, input.companyId),
        eq(issueExecutionLeases.issueId, input.issueId),
        eq(issueExecutionLeases.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !attempts[0] ||
    !leases[0] ||
    !["leased", "running"].includes(attempts[0].state) ||
    leases[0].attemptId !== input.attemptId ||
    leases[0].state !== "active"
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run attempt attachment does not target one exact active attempt/lease pair",
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      currentAttemptId: input.attemptId,
      currentLeaseId: input.leaseId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        isNull(issueExecutionRuns.currentAttemptId),
        isNull(issueExecutionRuns.currentLeaseId),
        isNull(issueExecutionRuns.cancellationIntentId),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "run cannot attach the selected attempt and lease",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function detachIssueExecutionRunAttemptInTransaction(
  transaction: IssueSessionDbTransaction,
  input: DetachIssueExecutionRunAttemptInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedAttemptId, "expected attempt id");
  assertExactRunIdentifier(input.expectedLeaseId, "expected lease id");
  assertDate(input.at, "attempt detachment time");
  const attempts = await transaction
    .select({ state: issueExecutionAttempts.state })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.id, input.expectedAttemptId),
        eq(issueExecutionAttempts.companyId, input.companyId),
        eq(issueExecutionAttempts.issueId, input.issueId),
        eq(issueExecutionAttempts.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  const leases = await transaction
    .select({
      attemptId: issueExecutionLeases.attemptId,
      state: issueExecutionLeases.state,
    })
    .from(issueExecutionLeases)
    .where(
      and(
        eq(issueExecutionLeases.id, input.expectedLeaseId),
        eq(issueExecutionLeases.companyId, input.companyId),
        eq(issueExecutionLeases.issueId, input.issueId),
        eq(issueExecutionLeases.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !attempts[0] ||
    !leases[0] ||
    !["settled", "failed", "cancelled"].includes(attempts[0].state) ||
    leases[0].attemptId !== input.expectedAttemptId ||
    leases[0].state === "active"
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run attempt detachment requires its exact terminal attempt and released lease",
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      currentAttemptId: null,
      currentLeaseId: null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        eq(issueExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(issueExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(issueExecutionRuns.cancellationIntentId),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "run cannot detach a stale or cancellation-bound attempt",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachIssueExecutionRunCancellationInTransaction(
  transaction: IssueSessionDbTransaction,
  input: AttachIssueExecutionRunCancellationInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedAttemptId, "expected attempt id");
  assertExactRunIdentifier(input.expectedLeaseId, "expected lease id");
  assertExactRunIdentifier(input.cancellationIntentId, "cancellation intent id");
  assertDate(input.at, "cancellation attachment time");
  const cancellations = await transaction
    .select({
      attemptId: issueExecutionCancellationIntents.attemptId,
      leaseId: issueExecutionCancellationIntents.leaseId,
      state: issueExecutionCancellationIntents.state,
    })
    .from(issueExecutionCancellationIntents)
    .where(
      and(
        eq(issueExecutionCancellationIntents.id, input.cancellationIntentId),
        eq(issueExecutionCancellationIntents.companyId, input.companyId),
        eq(issueExecutionCancellationIntents.issueId, input.issueId),
        eq(issueExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !cancellations[0] ||
    cancellations[0].attemptId !== input.expectedAttemptId ||
    cancellations[0].leaseId !== input.expectedLeaseId ||
    cancellations[0].state !== "requested"
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run cancellation attachment does not target its exact requested attempt/lease intent",
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        eq(issueExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(issueExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(issueExecutionRuns.cancellationIntentId),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "run cannot attach the selected cancellation intent",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function detachIssueExecutionRunCancellationInTransaction(
  transaction: IssueSessionDbTransaction,
  input: DetachIssueExecutionRunCancellationInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(
    input.expectedCancellationIntentId,
    "expected cancellation intent id",
  );
  assertDate(input.at, "cancellation detachment time");
  const cancellations = await transaction
    .select({ state: issueExecutionCancellationIntents.state })
    .from(issueExecutionCancellationIntents)
    .where(
      and(
        eq(
          issueExecutionCancellationIntents.id,
          input.expectedCancellationIntentId,
        ),
        eq(issueExecutionCancellationIntents.companyId, input.companyId),
        eq(issueExecutionCancellationIntents.issueId, input.issueId),
        eq(issueExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!cancellations[0] || cancellations[0].state !== "completed") {
    throw new IssueExecutionRunInvariantViolation(
      "run cancellation detachment requires its exact completed intent",
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({ cancellationIntentId: null, updatedAt: input.at })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        eq(
          issueExecutionRuns.cancellationIntentId,
          input.expectedCancellationIntentId,
        ),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "run cannot detach a stale cancellation intent",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachIssueExecutionRunFinalizationInTransaction(
  transaction: IssueSessionDbTransaction,
  input: AttachIssueExecutionRunFinalizationInput,
): Promise<IssueExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.finalizationId, "finalization id");
  assertDate(input.finishedAt, "run finish time");
  assertDate(input.at, "finalization attachment time");
  if (
    input.at < input.finishedAt ||
    input.terminalReasonCode.length < 1 ||
    input.terminalReasonCode.length > 200 ||
    input.terminalReasonCode !== input.terminalReasonCode.trim()
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run terminal reason or time is invalid",
    );
  }
  const finalizations = await transaction
    .select({
      id: issueExecutionFinalizations.id,
      finalizedAt: issueExecutionFinalizations.finalizedAt,
    })
    .from(issueExecutionFinalizations)
    .where(
      and(
        eq(issueExecutionFinalizations.id, input.finalizationId),
        eq(issueExecutionFinalizations.companyId, input.companyId),
        eq(issueExecutionFinalizations.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!finalizations[0] || finalizations[0].finalizedAt > input.at) {
    throw new IssueExecutionRunInvariantViolation(
      "terminal run requires its exact already-persisted finalization",
    );
  }
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      status: input.status,
      terminalFinalizationId: input.finalizationId,
      finishedAt: input.finishedAt,
      terminalClassification: input.status,
      terminalReasonCode: input.terminalReasonCode,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, input.expectedStatus),
        isNull(issueExecutionRuns.currentAttemptId),
        isNull(issueExecutionRuns.currentLeaseId),
        isNull(issueExecutionRuns.cancellationIntentId),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "run finalization lost its exact active lifecycle fence",
    );
  }
  return projectRunEnvelope(changed[0]);
}

function runListCursorPredicate(cursor: IssueExecutionRunListCursor) {
  if (
    cursor.createdAt.length === 0 ||
    cursor.createdAt !== cursor.createdAt.trim() ||
    !Number.isFinite(new Date(cursor.createdAt).getTime())
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run list cursor time must be an exact valid timestamp",
    );
  }
  assertExactRunIdentifier(cursor.runId, "run list cursor id");
  return sql`(${issueExecutionRuns.createdAt}, ${issueExecutionRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.runId}::uuid)`;
}

async function listIssueExecutionRunPage(
  database: Db,
  input: {
    readonly predicates: readonly ReturnType<typeof eq>[];
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<IssueExecutionRunListPage> {
  assertPageLimit(input.limit, MAX_RUN_LIST_PAGE_SIZE, "run list limit");
  assertRunStatusFilter(input.statuses);
  const rows = await database
    .select({
      run: issueExecutionRuns,
      exactCreatedAt: sql<string>`${issueExecutionRuns.createdAt}::text`,
    })
    .from(issueExecutionRuns)
    .where(
      and(
        ...input.predicates,
        ...(input.statuses
          ? [inArray(issueExecutionRuns.status, [...input.statuses])]
          : []),
        ...(input.cursor ? [runListCursorPredicate(input.cursor)] : []),
      ),
    )
    .orderBy(desc(issueExecutionRuns.createdAt), desc(issueExecutionRuns.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map((row) => projectRunEnvelope(row.run));
  const last = hasMore ? selected[selected.length - 1] : undefined;
  return {
    items,
    nextCursor: last
      ? { createdAt: last.exactCreatedAt, runId: last.run.id }
      : null,
  };
}

export async function listIssueExecutionRunsForIssue(
  database: Db,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<IssueExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.issueId, "issue id");
  return listIssueExecutionRunPage(database, {
    predicates: [
      eq(issueExecutionRuns.companyId, input.companyId),
      eq(issueExecutionRuns.issueId, input.issueId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

export async function listIssueExecutionRunsForAgent(
  database: Db,
  input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<IssueExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  return listIssueExecutionRunPage(database, {
    predicates: [
      eq(issueExecutionRuns.companyId, input.companyId),
      eq(issueExecutionRuns.targetAgentId, input.targetAgentId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Company activity consumes the same envelope bytes as every other list. */
export async function listIssueExecutionRunsForActivity(
  database: Db,
  input: {
    readonly companyId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<IssueExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  return listIssueExecutionRunPage(database, {
    predicates: [eq(issueExecutionRuns.companyId, input.companyId)],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Work timeline is deliberately issue-scoped rather than a polymorphic list. */
export async function listIssueExecutionRunsForWorkTimeline(
  database: Db,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<IssueExecutionRunListPage> {
  return listIssueExecutionRunsForIssue(database, input);
}

/** Distinct issue roots currently owning an active productive owner run. */
export async function listLiveOwnerIssueIds(
  database: Db | IssueSessionDbTransaction,
  input: { readonly companyId: string },
): Promise<readonly string[]> {
  assertExactRunIdentifier(input.companyId, "company id");
  const rows = await database
    .selectDistinct({ issueId: issueExecutionRuns.issueId })
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.kind, "productive"),
        eq(issueExecutionRuns.executionMode, "owner"),
        inArray(issueExecutionRuns.status, [
          "queued",
          "scheduled_retry",
          "running",
        ]),
      ),
    );
  return Object.freeze(rows.map((row) => row.issueId));
}

export interface ProductiveRunLinkage {
  readonly runId: string;
  readonly runStatus: "running";
  readonly companyId: string;
  readonly agentId: string;
  readonly refId: string;
  readonly issueId: string;
  readonly projectId: string | null;
  readonly routineId: string | null;
  readonly sessionId: string;
  readonly ownershipEpoch: number;
  readonly mode: "owner" | "consult";
  readonly sourceKind: typeof issueExecutionRefs.$inferSelect.sourceKind;
  readonly sourceRecordId: string;
  readonly adapterConfigRevisionId: string;
  readonly issueExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly issueExecutionPolicy: Record<string, unknown> | null;
}

export interface CurrentIssueOwnerRunLinkage extends ProductiveRunLinkage {
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

function currentProductivePromptPredicate(now: Date) {
  return and(
    eq(issueExecutionRuns.kind, "productive"),
    eq(issueExecutionRuns.status, "running"),
    eq(issueExecutionAttempts.state, "running"),
    eq(issueExecutionLeases.state, "active"),
    gt(issueExecutionLeases.expiresAt, now),
    eq(issueExecutionRefs.disposition, "active"),
    isNull(issueExecutionRunRefs.protocolSettlementState),
  );
}

/** Resolve one active productive run through its exact prompt and lease. */
export async function resolveProductiveRunLinkage(
  database: Db,
  input: {
    readonly runId: string;
    readonly companyId?: string | null;
    readonly agentId?: string | null;
  },
): Promise<ProductiveRunLinkage | null> {
  assertExactRunIdentifier(input.runId, "run id");
  if (input.companyId) assertExactRunIdentifier(input.companyId, "company id");
  if (input.agentId) assertExactRunIdentifier(input.agentId, "agent id");
  const predicates = [
    eq(issueExecutionRuns.id, input.runId),
    currentProductivePromptPredicate(new Date()),
    ...(input.companyId
      ? [eq(issueExecutionRuns.companyId, input.companyId)]
      : []),
    ...(input.agentId
      ? [eq(issueExecutionRefs.targetAgentId, input.agentId)]
      : []),
  ];
  return database
    .select({
      runId: issueExecutionRuns.id,
      runStatus: issueExecutionRuns.status,
      companyId: issueExecutionRuns.companyId,
      agentId: issueExecutionRefs.targetAgentId,
      refId: issueExecutionRefs.id,
      issueId: issueExecutionRefs.issueId,
      projectId: issues.projectId,
      routineId: issues.creatorRoutineId,
      sessionId: issueExecutionRefs.sessionId,
      ownershipEpoch: issueExecutionRefs.ownershipEpoch,
      mode: issueExecutionRefs.mode,
      sourceKind: issueExecutionRefs.sourceKind,
      sourceRecordId: issueExecutionRefs.sourceRecordId,
      adapterConfigRevisionId: issueExecutionRefs.adapterConfigRevisionId,
      issueExecutionAuthorityId: issueExecutionRefs.issueExecutionAuthorityId,
      consultExecutionId: issueExecutionRefs.consultExecutionId,
      issueExecutionPolicy: issues.executionPolicy,
    })
    .from(issueExecutionRuns)
    .innerJoin(
      issueExecutionAttempts,
      and(
        eq(issueExecutionAttempts.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionAttempts.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionAttempts.runId, issueExecutionRuns.id),
        eq(issueExecutionAttempts.id, issueExecutionRuns.currentAttemptId),
      ),
    )
    .innerJoin(
      issueExecutionLeases,
      and(
        eq(issueExecutionLeases.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionLeases.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionLeases.runId, issueExecutionRuns.id),
        eq(issueExecutionLeases.attemptId, issueExecutionAttempts.id),
        eq(issueExecutionLeases.id, issueExecutionRuns.currentLeaseId),
      ),
    )
    .innerJoin(
      issueExecutionRefs,
      and(
        eq(issueExecutionRefs.companyId, issueExecutionAttempts.companyId),
        eq(issueExecutionRefs.issueId, issueExecutionAttempts.issueId),
        eq(issueExecutionRefs.id, issueExecutionAttempts.refId),
        eq(issueExecutionRefs.targetAgentId, issueExecutionRuns.targetAgentId),
      ),
    )
    .innerJoin(
      issueExecutionRunRefs,
      and(
        eq(issueExecutionRunRefs.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionRunRefs.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionRunRefs.runId, issueExecutionRuns.id),
        eq(issueExecutionRunRefs.refId, issueExecutionAttempts.refId),
        eq(issueExecutionRunRefs.refOrdinal, issueExecutionAttempts.refOrdinal),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueExecutionRuns.issueId),
        eq(issues.companyId, issueExecutionRuns.companyId),
      ),
    )
    .where(and(...predicates))
    .limit(1)
    .then((rows) => rows[0] ?? null) as Promise<ProductiveRunLinkage | null>;
}

/** Resolve each issue's exact current owner prompt, never an historical run. */
export async function resolveCurrentIssueOwnerRunLinkages(
  database: Db,
  input: { readonly companyId: string; readonly issueIds: readonly string[] },
): Promise<Map<string, CurrentIssueOwnerRunLinkage>> {
  assertExactRunIdentifier(input.companyId, "company id");
  const issueIds = [...new Set(input.issueIds)];
  for (const issueId of issueIds) assertExactRunIdentifier(issueId, "issue id");
  if (issueIds.length === 0) return new Map();
  const rows = await database
    .select({
      runId: issueExecutionRuns.id,
      runStatus: issueExecutionRuns.status,
      companyId: issueExecutionRuns.companyId,
      agentId: issueExecutionRefs.targetAgentId,
      refId: issueExecutionRefs.id,
      issueId: issueExecutionRefs.issueId,
      projectId: issues.projectId,
      routineId: issues.creatorRoutineId,
      sessionId: issueExecutionRefs.sessionId,
      ownershipEpoch: issueExecutionRefs.ownershipEpoch,
      mode: issueExecutionRefs.mode,
      sourceKind: issueExecutionRefs.sourceKind,
      sourceRecordId: issueExecutionRefs.sourceRecordId,
      adapterConfigRevisionId: issueExecutionRefs.adapterConfigRevisionId,
      issueExecutionAuthorityId: issueExecutionRefs.issueExecutionAuthorityId,
      consultExecutionId: issueExecutionRefs.consultExecutionId,
      issueExecutionPolicy: issues.executionPolicy,
      startedAt: issueExecutionRuns.startedAt,
      finishedAt: issueExecutionRuns.finishedAt,
      createdAt: issueExecutionRuns.createdAt,
    })
    .from(issues)
    .innerJoin(
      issueExecutionRuns,
      and(
        eq(issueExecutionRuns.companyId, issues.companyId),
        eq(issueExecutionRuns.issueId, issues.id),
        eq(issueExecutionRuns.ownershipEpoch, issues.ownershipEpoch),
        eq(issueExecutionRuns.targetAgentId, issues.ownerAgentId),
        eq(issueExecutionRuns.executionMode, "owner"),
      ),
    )
    .innerJoin(
      issueExecutionAttempts,
      and(
        eq(issueExecutionAttempts.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionAttempts.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionAttempts.runId, issueExecutionRuns.id),
        eq(issueExecutionAttempts.id, issueExecutionRuns.currentAttemptId),
      ),
    )
    .innerJoin(
      issueExecutionLeases,
      and(
        eq(issueExecutionLeases.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionLeases.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionLeases.runId, issueExecutionRuns.id),
        eq(issueExecutionLeases.attemptId, issueExecutionAttempts.id),
        eq(issueExecutionLeases.id, issueExecutionRuns.currentLeaseId),
      ),
    )
    .innerJoin(
      issueExecutionRefs,
      and(
        eq(issueExecutionRefs.companyId, issueExecutionAttempts.companyId),
        eq(issueExecutionRefs.issueId, issueExecutionAttempts.issueId),
        eq(issueExecutionRefs.id, issueExecutionAttempts.refId),
        eq(issueExecutionRefs.ownershipEpoch, issues.ownershipEpoch),
        eq(issueExecutionRefs.targetAgentId, issues.ownerAgentId),
        eq(issueExecutionRefs.mode, "owner"),
      ),
    )
    .innerJoin(
      issueExecutionRunRefs,
      and(
        eq(issueExecutionRunRefs.companyId, issueExecutionRuns.companyId),
        eq(issueExecutionRunRefs.issueId, issueExecutionRuns.issueId),
        eq(issueExecutionRunRefs.runId, issueExecutionRuns.id),
        eq(issueExecutionRunRefs.refId, issueExecutionAttempts.refId),
        eq(issueExecutionRunRefs.refOrdinal, issueExecutionAttempts.refOrdinal),
      ),
    )
    .innerJoin(
      issueExecutionAuthorities,
      and(
        eq(issueExecutionAuthorities.id, issueExecutionRefs.issueExecutionAuthorityId),
        eq(issueExecutionAuthorities.companyId, issueExecutionRefs.companyId),
        eq(issueExecutionAuthorities.issueId, issueExecutionRefs.issueId),
        eq(issueExecutionAuthorities.ownershipEpoch, issueExecutionRefs.ownershipEpoch),
        eq(issueExecutionAuthorities.agentId, issueExecutionRefs.targetAgentId),
        eq(issueExecutionAuthorities.state, "current"),
      ),
    )
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.ownerKind, "agent"),
        inArray(issues.id, issueIds),
        currentProductivePromptPredicate(new Date()),
      ),
    );
  const byIssueId = new Map<string, CurrentIssueOwnerRunLinkage>();
  for (const row of rows as CurrentIssueOwnerRunLinkage[]) {
    const previous = byIssueId.get(row.issueId);
    if (!previous || row.createdAt > previous.createdAt) {
      byIssueId.set(row.issueId, row);
    }
  }
  return byIssueId;
}

export async function resolveCurrentIssueOwnerRunLinkage(
  database: Db,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly agentId?: string | null;
    readonly runId?: string | null;
  },
): Promise<CurrentIssueOwnerRunLinkage | null> {
  const linkage = (await resolveCurrentIssueOwnerRunLinkages(database, {
    companyId: input.companyId,
    issueIds: [input.issueId],
  })).get(input.issueId) ?? null;
  if (input.agentId && linkage?.agentId !== input.agentId) return null;
  if (input.runId && linkage?.runId !== input.runId) return null;
  return linkage;
}

function boundedRecords<T>(
  rows: readonly T[],
  limit: number,
): BoundedIssueExecutionRunRecords<T> {
  return {
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

function assertJoinedRunShape(input: {
  readonly run: IssueExecutionRunEnvelope;
  readonly controlRows: readonly IssueExecutionRunControl[];
  readonly refRows: readonly IssueExecutionRunRef[];
  readonly refsTruncated: boolean;
}): void {
  if (input.controlRows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run joined detail found duplicate singular control owners",
    );
  }
  if (input.controlRows.length !== 1 || input.refRows.length === 0) {
    throw new IssueExecutionRunInvariantViolation(
      "productive or consult run is missing its control or non-empty ref batch",
    );
  }
  const digest = input.refRows[0]!.batchDigest;
  input.refRows.forEach((ref, index) => {
    if (ref.refOrdinal !== index || ref.batchDigest !== digest) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref projection is non-contiguous or crosses batch digests",
      );
    }
  });
  if (!input.refsTruncated) {
    const uniqueRefs = new Set(input.refRows.map((ref) => ref.refId));
    if (uniqueRefs.size !== input.refRows.length) {
      throw new IssueExecutionRunInvariantViolation(
        "run ref projection contains duplicate members",
      );
    }
  }
}

/**
 * One bounded canonical join for REST, activity, and audit
 * projections. The caller owns authorization; this reader owns identical DB
 * bytes and structural redaction for every authorized consumer.
 */
async function readJoinedIssueExecutionRunDetail(
  database: Db,
  issueSessionStore: IssueSessionStore,
  input: ReadJoinedIssueExecutionRunDetailInput,
): Promise<JoinedIssueExecutionRunDetail | null> {
  assertRunIdentity(input);
  assertPageLimit(
    input.limit,
    MAX_RUN_DETAIL_OWNER_ROWS,
    "run detail owner limit",
  );
  const run = await readIssueExecutionRun(database, input);
  if (!run) return null;

  const [
    controlRows,
    refRows,
    segmentRows,
    sessionEventPage,
    sessionMessagePage,
    attemptRows,
    retryScheduleRows,
    leaseRows,
    processRows,
    cancellationRows,
    accountingRows,
    costRows,
    activityRows,
    watchdogDecisionRows,
    outputCommentRows,
    finalizationRows,
  ] = await Promise.all([
    database
      .select()
      .from(issueExecutionRunControls)
      .where(eq(issueExecutionRunControls.runId, input.runId))
      .limit(2),
    database
      .select()
      .from(issueExecutionRunRefs)
      .where(
        and(
          eq(issueExecutionRunRefs.companyId, input.companyId),
          eq(issueExecutionRunRefs.issueId, input.issueId),
          eq(issueExecutionRunRefs.runId, input.runId),
        ),
      )
      .orderBy(asc(issueExecutionRunRefs.refOrdinal))
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionPromptSegments)
      .where(
        and(
          eq(issueExecutionPromptSegments.companyId, input.companyId),
          eq(issueExecutionPromptSegments.issueId, input.issueId),
          eq(issueExecutionPromptSegments.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionPromptSegments.refOrdinal),
        asc(issueExecutionPromptSegments.segmentOrdinal),
      )
      .limit(input.limit + 1),
    issueSessionStore.pageEvents(
      {
        companyId: input.companyId,
        issueId: input.issueId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionEventCursor, limit: input.limit },
    ),
    issueSessionStore.pageMessages(
      {
        companyId: input.companyId,
        issueId: input.issueId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionMessageCursor, limit: input.limit },
    ),
    database
      .select()
      .from(issueExecutionAttempts)
      .where(
        and(
          eq(issueExecutionAttempts.companyId, input.companyId),
          eq(issueExecutionAttempts.issueId, input.issueId),
          eq(issueExecutionAttempts.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionAttempts.createdAt),
        asc(issueExecutionAttempts.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(issueExecutionAttemptRetrySchedules.issueId, input.issueId),
          eq(issueExecutionAttemptRetrySchedules.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionAttemptRetrySchedules.createdAt),
        asc(issueExecutionAttemptRetrySchedules.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionLeases)
      .where(
        and(
          eq(issueExecutionLeases.companyId, input.companyId),
          eq(issueExecutionLeases.issueId, input.issueId),
          eq(issueExecutionLeases.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionLeases.createdAt),
        asc(issueExecutionLeases.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionProcessFacts)
      .where(
        and(
          eq(issueExecutionProcessFacts.companyId, input.companyId),
          eq(issueExecutionProcessFacts.issueId, input.issueId),
          eq(issueExecutionProcessFacts.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionProcessFacts.createdAt),
        asc(issueExecutionProcessFacts.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionCancellationIntents)
      .where(
        and(
          eq(issueExecutionCancellationIntents.companyId, input.companyId),
          eq(issueExecutionCancellationIntents.issueId, input.issueId),
          eq(issueExecutionCancellationIntents.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionCancellationIntents.createdAt),
        asc(issueExecutionCancellationIntents.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(acpPromptAccounting)
      .where(
        and(
          eq(acpPromptAccounting.companyId, input.companyId),
          eq(acpPromptAccounting.issueId, input.issueId),
          eq(acpPromptAccounting.runId, input.runId),
        ),
      )
      .orderBy(asc(acpPromptAccounting.createdAt), asc(acpPromptAccounting.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, input.companyId),
          eq(costEvents.issueId, input.issueId),
          eq(costEvents.runId, input.runId),
        ),
      )
      .orderBy(asc(costEvents.createdAt), asc(costEvents.id))
      .limit(input.limit + 1),
    database
      .select({
        id: activityLog.id,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        responsibleUserId: activityLog.responsibleUserId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.runId, input.runId),
        ),
      )
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionWatchdogDecisions)
      .where(
        and(
          eq(issueExecutionWatchdogDecisions.companyId, input.companyId),
          eq(issueExecutionWatchdogDecisions.runId, input.runId),
        ),
      )
      .orderBy(
        asc(issueExecutionWatchdogDecisions.createdAt),
        asc(issueExecutionWatchdogDecisions.id),
      )
      .limit(input.limit + 1),
    database
      .select({
        commentId: issueCommentProjectionSources.commentId,
        messageId: issueCommentProjectionSources.messageId,
        sourceKind: issueCommentProjectionSources.sourceKind,
        projectedEventSeq: issueCommentProjectionSources.projectedEventSeq,
      })
      .from(issueCommentProjectionSources)
      .where(
        and(
          eq(issueCommentProjectionSources.companyId, input.companyId),
          eq(issueCommentProjectionSources.issueId, input.issueId),
          eq(issueCommentProjectionSources.runId, input.runId),
          inArray(issueCommentProjectionSources.sourceKind, [
            "run_output",
            "run_progress",
            "issue_update",
          ]),
        ),
      )
      .orderBy(
        asc(issueCommentProjectionSources.projectedEventSeq),
        asc(issueCommentProjectionSources.commentId),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(issueExecutionFinalizations)
      .where(
        and(
          eq(issueExecutionFinalizations.companyId, input.companyId),
          eq(issueExecutionFinalizations.runId, input.runId),
        ),
      )
      .limit(2),
  ]);

  if (finalizationRows.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run joined detail found duplicate finalizations",
    );
  }
  const finalization = finalizationRows[0] ?? null;
  const [promptDependencies, updateDependencies, liveness] =
    finalization
      ? await Promise.all([
          database
            .select()
            .from(issueExecutionFinalizationPromptDependencies)
            .where(
              eq(
                issueExecutionFinalizationPromptDependencies.finalizationId,
                finalization.id,
              ),
            )
            .orderBy(
              asc(
                issueExecutionFinalizationPromptDependencies.dependencyOrdinal,
              ),
            )
            .limit(input.limit + 1),
          database
            .select()
            .from(issueExecutionFinalizationUpdateDependencies)
            .where(
              eq(
                issueExecutionFinalizationUpdateDependencies.finalizationId,
                finalization.id,
              ),
            )
            .orderBy(
              asc(
                issueExecutionFinalizationUpdateDependencies.dependencyOrdinal,
              ),
            )
            .limit(input.limit + 1),
          database
            .select()
            .from(issueExecutionRunLivenessFacts)
            .where(
              and(
                eq(issueExecutionRunLivenessFacts.companyId, input.companyId),
                eq(issueExecutionRunLivenessFacts.runId, input.runId),
              ),
            )
            .limit(2),
        ])
      : [[], [], []] as const;
  if (liveness.length > 1) {
    throw new IssueExecutionRunInvariantViolation(
      "run joined detail found duplicate liveness facts",
    );
  }
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  if (
    terminal !==
      (finalization !== null && finalization.id === run.terminalFinalizationId)
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "run joined detail does not match its terminal finalization",
    );
  }
  if (finalization) {
    if (run.kind !== "productive") {
      if (finalization.runLivenessFactId !== null || liveness.length !== 0) {
        throw new IssueExecutionRunInvariantViolation(
          "nonproductive finalization cannot carry productive-run liveness",
        );
      }
    } else {
      const livenessFact = liveness[0] ?? null;
      if (
        finalization.runLivenessFactId === null ||
        !livenessFact ||
        livenessFact.id !== finalization.runLivenessFactId ||
        livenessFact.runId !== run.runId ||
        livenessFact.companyId !== run.companyId
      ) {
        throw new IssueExecutionRunInvariantViolation(
          "productive run finalization is missing its exact liveness fact",
        );
      }
    }
  }

  const refs = boundedRecords(refRows, input.limit);
  assertJoinedRunShape({
    run,
    controlRows,
    refRows: refs.items,
    refsTruncated: refs.truncated,
  });
  const redactedEvents = sessionEventPage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    type: row.type,
    data: redactIssueSessionPublicationValue(row.data) as unknown as Record<
      string,
      unknown
    >,
    createdAt: row.createdAt,
  }));
  const redactedMessages = sessionMessagePage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    modelStateSeq: row.modelStateSeq,
    type: row.type,
    data: redactIssueSessionPublicationValue(row.data) as unknown as Record<
      string,
      unknown
    >,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
  }));
  const redactedActivity = activityRows.map((row) =>
    redactIssueSessionPublicationValue(row),
  );
  return {
    run,
    control: controlRows[0] ?? null,
    refs,
    segments: boundedRecords(segmentRows, input.limit),
    sessionEvents: {
      items: redactedEvents,
      truncated: sessionEventPage.nextCursor !== null,
      nextCursor: sessionEventPage.nextCursor,
    },
    sessionMessages: {
      items: redactedMessages,
      truncated: sessionMessagePage.nextCursor !== null,
      nextCursor: sessionMessagePage.nextCursor,
    },
    attempts: boundedRecords(attemptRows, input.limit),
    retrySchedules: boundedRecords(retryScheduleRows, input.limit),
    leases: boundedRecords(leaseRows, input.limit),
    processFacts: boundedRecords(processRows, input.limit),
    cancellations: boundedRecords(cancellationRows, input.limit),
    accounting: boundedRecords(accountingRows, input.limit),
    costs: boundedRecords(costRows, input.limit),
    activity: boundedRecords(redactedActivity, input.limit),
    watchdogDecisions: boundedRecords(watchdogDecisionRows, input.limit),
    outputComments: boundedRecords(
      outputCommentRows.map((row) => ({
        commentId: row.commentId,
        messageId: row.messageId,
        sourceKind: row.sourceKind as IssueExecutionRunOutputCommentLink["sourceKind"],
        projectedEventSeq: Number(row.projectedEventSeq),
      })),
      input.limit,
    ),
    finalization: finalization
      ? {
          record: finalization,
          promptDependencies: boundedRecords(promptDependencies, input.limit),
          updateDependencies: boundedRecords(updateDependencies, input.limit),
          liveness: liveness[0] ?? null,
        }
      : null,
  };
}

/**
 * Lock and validate the sole run envelope before P14 locks its prompt-specific
 * control/attempt/lease/capability/correlation graph. No caller may query the
 * run table to reproduce this decision.
 */
export async function lockSteerableRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity & {
    readonly ownershipEpoch: number;
    readonly targetAgentId: string;
  },
): Promise<SteerableIssueExecutionRun> {
  const rows = await transaction
    .select()
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
      ),
    )
    .limit(1)
    .for("update");
  const run = rows[0];
  if (
    !run ||
    run.status !== "running" ||
    run.ownershipEpoch !== input.ownershipEpoch ||
    run.targetAgentId !== input.targetAgentId ||
    run.currentAttemptId === null ||
    run.currentLeaseId === null ||
    run.terminalFinalizationId !== null ||
    run.startedAt === null ||
    run.finishedAt !== null ||
    (run.kind === "productive" &&
      (run.executionMode !== "owner" ||
        run.issueExecutionAuthorityId === null ||
        run.consultExecutionId !== null)) ||
    (run.kind === "consult" &&
      (run.executionMode !== "consult" ||
        run.issueExecutionAuthorityId !== null ||
        run.consultExecutionId === null))
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "Selected run is not the exact active steerable issue execution",
    );
  }
  return {
    companyId: run.companyId,
    issueId: run.issueId,
    runId: run.id,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionWorkspaceBindingId: run.executionWorkspaceBindingId,
    executionMode: run.executionMode,
    issueExecutionAuthorityId: run.issueExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    currentAttemptId: run.currentAttemptId,
    currentLeaseId: run.currentLeaseId,
    cancellationIntentId: run.cancellationIntentId,
    terminalFinalizationId: null,
    startedAt: run.startedAt,
    finishedAt: null,
  };
}

/** Attach the exact P14 cancellation intent without taking ownership of it. */
export async function attachSteeringCancellationInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity & {
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly cancellationIntentId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        eq(issueExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(issueExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(issueExecutionRuns.cancellationIntentId),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning({ id: issueExecutionRuns.id });
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "Steering cancellation lost the exact active run attempt",
    );
  }
}

/**
 * Clear only the settled/reaped P14 attempt and its exact cancellation pointer
 * before the positive steering segment is rebound to a new attempt.
 */
export async function clearSteeringCancellationAndAttemptInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity & {
    readonly cancellationIntentId: string;
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(issueExecutionRuns)
    .set({
      currentAttemptId: null,
      currentLeaseId: null,
      cancellationIntentId: null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
        eq(issueExecutionRuns.status, "running"),
        eq(issueExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(issueExecutionRuns.currentLeaseId, input.expectedLeaseId),
        eq(
          issueExecutionRuns.cancellationIntentId,
          input.cancellationIntentId,
        ),
        isNull(issueExecutionRuns.terminalFinalizationId),
        isNull(issueExecutionRuns.finishedAt),
      ),
    )
    .returning({ id: issueExecutionRuns.id });
  if (!changed[0]) {
    throw new IssueExecutionRunInvariantViolation(
      "Steering rebound lost the exact cancelled run attempt",
    );
  }
}

/**
 * Re-lock the same active envelope after the cancellation transaction has
 * reaped and detached its old prompt attempt. This is the final lifecycle
 * fence before a persisted positive segment becomes resumable.
 */
export async function lockReboundSteeringRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: IssueExecutionRunIdentity & {
    readonly ownershipEpoch: number;
    readonly targetAgentId: string;
  },
): Promise<ReboundSteerableIssueExecutionRun> {
  const rows = await transaction
    .select()
    .from(issueExecutionRuns)
    .where(
      and(
        eq(issueExecutionRuns.id, input.runId),
        eq(issueExecutionRuns.companyId, input.companyId),
        eq(issueExecutionRuns.issueId, input.issueId),
      ),
    )
    .limit(1)
    .for("update");
  const run = rows[0];
  if (
    !run ||
    run.status !== "running" ||
    run.ownershipEpoch !== input.ownershipEpoch ||
    run.targetAgentId !== input.targetAgentId ||
    run.currentAttemptId !== null ||
    run.currentLeaseId !== null ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null ||
    run.startedAt === null ||
    run.finishedAt !== null ||
    (run.kind === "productive" &&
      (run.executionMode !== "owner" ||
        run.issueExecutionAuthorityId === null ||
        run.consultExecutionId !== null)) ||
    (run.kind === "consult" &&
      (run.executionMode !== "consult" ||
        run.issueExecutionAuthorityId !== null ||
        run.consultExecutionId === null))
  ) {
    throw new IssueExecutionRunInvariantViolation(
      "Steering segment cannot resume against the selected run lifecycle",
    );
  }
  return {
    companyId: run.companyId,
    issueId: run.issueId,
    runId: run.id,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionWorkspaceBindingId: run.executionWorkspaceBindingId,
    executionMode: run.executionMode,
    issueExecutionAuthorityId: run.issueExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: run.startedAt,
    finishedAt: null,
  };
}

export type IssueExecutionSteeringActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string };

/**
 * The sole selector-bearing continuation request. There is intentionally no
 * Session id, target ACP id, alias, or fallback selector in this contract.
 */
export interface RequestIssueExecutionSteeringInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly exactMessage: string;
  readonly sourceCommentId: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly actor: IssueExecutionSteeringActor;
}

export interface RequestedIssueExecutionSteering {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly interruptedSegmentOrdinal: number;
  readonly segmentOrdinal: number;
  readonly sourceCommentId: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly cancellationIntentId: string;
  readonly cancellation: IssueExecutionAttemptCancellationSignal;
}

export interface ReboundIssueExecutionSteering {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

export type IssueExecutionSteeringCancellationSettlement =
  | {
      readonly kind: "settled_and_reaped";
      readonly cancellationIntentId: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly cancellationIntentId: string;
      readonly reason: string;
    };

export type PendingIssueExecutionSteeringForSource =
  | {
      readonly kind: "requested";
      readonly request: RequestedIssueExecutionSteering;
    }
  | {
      readonly kind: "rebound";
      readonly rebound: ReboundIssueExecutionSteering;
    }
  | { readonly kind: "resumed" }
  | {
      readonly kind: "terminal";
      readonly result: IssueExecutionSteeringResult;
    }
  | { readonly kind: "ambiguous"; readonly reason: string };

export type ContinuedPendingIssueExecutionSteering =
  | {
      readonly kind: "continued_requested";
      readonly rebound: ReboundIssueExecutionSteering;
    }
  | {
      readonly kind: "continued_rebound";
      readonly rebound: ReboundIssueExecutionSteering;
    }
  | {
      readonly kind: "already_resumed";
    }
  | {
      readonly kind: "already_settled";
      readonly result: IssueExecutionSteeringResult;
    };

/**
 * Transactional DB owner for P14. `requestInTransaction` locks the exact run,
 * current run-control tuple, prompt, attempt/lease, capability, and steering
 * correlation; appends one positive segment; revokes the old capability; and
 * persists the exact-attempt steering cancellation intent in the caller's
 * comment transaction.
 */
export interface IssueExecutionSteeringRepository {
  requestInTransaction(
    transaction: IssueSessionDbTransaction,
    input: RequestIssueExecutionSteeringInput,
  ): Promise<RequestedIssueExecutionSteering>;
  recordCancellationSignal(input: {
    readonly request: RequestedIssueExecutionSteering;
    readonly delivered: boolean;
  }): Promise<void>;
  awaitCancellationSettlement(
    request: RequestedIssueExecutionSteering,
  ): Promise<IssueExecutionSteeringCancellationSettlement>;
  markAmbiguous(input: {
    readonly request: RequestedIssueExecutionSteering;
    readonly reason: string;
  }): Promise<void>;
  rebindAfterCancellation(
    request: RequestedIssueExecutionSteering,
  ): Promise<ReboundIssueExecutionSteering>;
  markResumeReady(
    rebound: ReboundIssueExecutionSteering,
  ): Promise<void>;
  findPendingForSource(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sourceCommentId: string;
  }): Promise<PendingIssueExecutionSteeringForSource>;
}

export interface IssueExecutionSteeringCancellationPort {
  /** Abort only the exact fenced attempt. False may mean natural settlement won. */
  signalAttemptCancellation(
    input: IssueExecutionAttemptCancellationSignal,
  ): boolean;
}

export interface IssueExecutionSteeringResumePort {
  /**
   * Schedule the persisted positive segment on the same Paperclip run. The
   * attempt executor resolves native resume or new-session launch from canonical state.
   */
  resumeSteering(input: ReboundIssueExecutionSteering): Promise<void>;
}

export interface IssueExecutionRunService {
  createRun(
    transaction: IssueSessionDbTransaction,
    input: CreateIssueExecutionRunInput,
  ): Promise<CreatedIssueExecutionRun>;
  lockRun(
    transaction: IssueSessionDbTransaction,
    input: IssueExecutionRunIdentity,
  ): Promise<IssueExecutionRunEnvelope>;
  readRun(
    input: IssueExecutionRunIdentity,
  ): Promise<IssueExecutionRunEnvelope | null>;
  lockActiveRunsForAgentsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
    },
  ): Promise<readonly IssueExecutionRunEnvelope[]>;
  lockActiveRunsForScopeInTransaction(
    transaction: IssueSessionDbTransaction,
    input:
      | {
          readonly companyId: string;
          readonly issueId: string;
          readonly ownershipEpoch: number;
        }
      | {
          readonly companyId: string;
          readonly issueId: string;
          readonly refIds: readonly string[];
        },
  ): Promise<readonly IssueExecutionRunEnvelope[]>;
  lockActiveAgentRunsForIssueEpochInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
    },
  ): Promise<readonly IssueExecutionRunEnvelope[]>;
  lockActiveRunsForBudgetScopeInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
    },
  ): Promise<readonly IssueExecutionRunEnvelope[]>;
  listResumedAgentSteeringLivenessActionsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: ResumedAgentSteeringLivenessSearch,
  ): Promise<readonly ResumedAgentSteeringLivenessSource[]>;
  transitionRunStatus(
    transaction: IssueSessionDbTransaction,
    input: TransitionIssueExecutionRunStatusInput,
  ): Promise<IssueExecutionRunEnvelope>;
  attachAttempt(
    transaction: IssueSessionDbTransaction,
    input: AttachIssueExecutionRunAttemptInput,
  ): Promise<IssueExecutionRunEnvelope>;
  detachAttempt(
    transaction: IssueSessionDbTransaction,
    input: DetachIssueExecutionRunAttemptInput,
  ): Promise<IssueExecutionRunEnvelope>;
  attachCancellation(
    transaction: IssueSessionDbTransaction,
    input: AttachIssueExecutionRunCancellationInput,
  ): Promise<IssueExecutionRunEnvelope>;
  detachCancellation(
    transaction: IssueSessionDbTransaction,
    input: DetachIssueExecutionRunCancellationInput,
  ): Promise<IssueExecutionRunEnvelope>;
  attachFinalization(
    transaction: IssueSessionDbTransaction,
    input: AttachIssueExecutionRunFinalizationInput,
  ): Promise<IssueExecutionRunEnvelope>;
  listForIssue(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<IssueExecutionRunListPage>;
  listForAgent(input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<IssueExecutionRunListPage>;
  listForActivity(input: {
    readonly companyId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<IssueExecutionRunListPage>;
  listForWorkTimeline(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly statuses?: readonly IssueExecutionRunStatus[];
    readonly cursor?: IssueExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<IssueExecutionRunListPage>;
  readJoinedRunDetail(
    input: ReadJoinedIssueExecutionRunDetailInput,
  ): Promise<JoinedIssueExecutionRunDetail | null>;
  requestSteeringInTransaction(
    transaction: IssueSessionDbTransaction,
    input: RequestIssueExecutionSteeringInput,
  ): Promise<RequestedIssueExecutionSteering>;
  continueSteering(
    request: RequestedIssueExecutionSteering,
  ): Promise<ReboundIssueExecutionSteering>;
  continuePendingSteeringForSource(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sourceCommentId: string;
  }): Promise<ContinuedPendingIssueExecutionSteering>;
}

export class IssueExecutionSteeringRejected extends Error {
  readonly code = "issue_execution_steering_rejected";

  constructor(
    message: string,
    readonly reason:
      | "invalid_request"
      | "cancellation_ambiguous"
      | "rebound_identity_mismatch"
      | "persisted_ambiguous",
  ) {
    super(message);
    this.name = "IssueExecutionSteeringRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionSteeringRejected(
      `${label} must be exact and non-empty`,
      "invalid_request",
    );
  }
}

function validateRequest(input: RequestIssueExecutionSteeringInput): void {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["run id", input.runId],
    ["target agent id", input.targetAgentId],
    ["source comment id", input.sourceCommentId],
    ["source message id", input.sourceMessageId],
  ] as const) {
    exactIdentity(value, label);
  }
  if (input.actor.kind === "user") {
    if (input.sourceInputId === null) {
      throw new IssueExecutionSteeringRejected(
        "human steering requires its exact source input",
        "invalid_request",
      );
    }
    exactIdentity(input.sourceInputId, "source input id");
    if (input.sourceInputId !== input.sourceMessageId) {
      throw new IssueExecutionSteeringRejected(
        "human steering source message and input must be identical",
        "invalid_request",
      );
    }
  } else if (input.sourceInputId !== null) {
    throw new IssueExecutionSteeringRejected(
      "agent steering is a synthetic Session message and has no source input",
      "invalid_request",
    );
  }
  if (input.ownershipEpoch < 1 || !Number.isSafeInteger(input.ownershipEpoch)) {
    throw new IssueExecutionSteeringRejected(
      "ownership epoch must be a positive integer",
      "invalid_request",
    );
  }
  if (input.exactMessage.length === 0) {
    throw new IssueExecutionSteeringRejected(
      "steering message must be non-empty",
      "invalid_request",
    );
  }
  exactIdentity(
    input.actor.kind === "user" ? input.actor.userId : input.actor.agentId,
    `${input.actor.kind} actor id`,
  );
}

function sameReboundIdentity(
  request: RequestedIssueExecutionSteering,
  rebound: ReboundIssueExecutionSteering,
): boolean {
  return request.companyId === rebound.companyId &&
    request.issueId === rebound.issueId &&
    request.ownershipEpoch === rebound.ownershipEpoch &&
    request.runId === rebound.runId &&
    request.targetAgentId === rebound.targetAgentId &&
    request.refId === rebound.refId &&
    request.refOrdinal === rebound.refOrdinal &&
    request.segmentOrdinal === rebound.segmentOrdinal;
}

/**
 * Canonical P14 orchestration. The comment/source and requested segment commit
 * first; the worker then signals the exact in-memory attempt, waits for the
 * old prompt's unambiguous protocol settlement and process reap, rebinds the
 * positive segment, and only then schedules its ACP continuation. It never
 * creates another Paperclip run and never builds context itself.
 */
export function createIssueExecutionRunService(options: {
  readonly database: Db;
  readonly issueSessionStore: IssueSessionStore;
  readonly repository: IssueExecutionSteeringRepository;
  readonly cancellation: IssueExecutionSteeringCancellationPort;
  readonly resume: IssueExecutionSteeringResumePort;
  readonly steeringResults: Pick<
    IssueExecutionSteeringResultBroker,
    "rebind" | "publish"
  >;
}): IssueExecutionRunService {
  async function continueRequestedSteering(
    request: RequestedIssueExecutionSteering,
  ): Promise<ReboundIssueExecutionSteering> {
    const continuationIdentity = {
      companyId: request.companyId,
      issueId: request.issueId,
      runId: request.runId,
      refId: request.refId,
      refOrdinal: request.refOrdinal,
      segmentOrdinal: request.segmentOrdinal,
    } as const;
    if (request.interruptedSegmentOrdinal > 0) {
      options.steeringResults.rebind(
        {
          ...continuationIdentity,
          segmentOrdinal: request.interruptedSegmentOrdinal,
        },
        continuationIdentity,
      );
    }
    const failContinuation = (reason: string) => {
      options.steeringResults.publish({
        ...continuationIdentity,
        outcome: "failed",
        response: "",
        reason,
      });
    };
    try {
      // A false signal is not itself failure: the old prompt may have settled
      // naturally between the transaction and the post-commit signal.
      const delivered =
        options.cancellation.signalAttemptCancellation(request.cancellation);
      await options.repository.recordCancellationSignal({
        request,
        delivered,
      });
      const settlement =
        await options.repository.awaitCancellationSettlement(request);
      if (settlement.kind === "ambiguous") {
        await options.repository.markAmbiguous({
          request,
          reason: settlement.reason,
        });
        throw new IssueExecutionSteeringRejected(
          "The selected run's current prompt did not settle unambiguously",
          "cancellation_ambiguous",
        );
      }
      const rebound = await options.repository.rebindAfterCancellation(request);
      if (!sameReboundIdentity(request, rebound)) {
        await options.repository.markAmbiguous({
          request,
          reason: "steering rebound crossed the requested run segment",
        });
        throw new IssueExecutionSteeringRejected(
          "Steering rebound crossed the requested run segment",
          "rebound_identity_mismatch",
        );
      }
      await options.repository.markResumeReady(rebound);
      await options.resume.resumeSteering(rebound);
      return rebound;
    } catch (error) {
      failContinuation(
        error instanceof Error
          ? error.message
          : "Steering continuation failed",
      );
      throw error;
    }
  }

  const service: IssueExecutionRunService = {
    createRun(transaction, input) {
      return createIssueExecutionRunInTransaction(transaction, input);
    },

    lockRun(transaction, input) {
      return lockIssueExecutionRunInTransaction(transaction, input);
    },

    readRun(input) {
      return readIssueExecutionRun(options.database, input);
    },

    async lockActiveRunsForAgentsInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      const agentIds = [...new Set(input.agentIds)];
      for (const agentId of agentIds) {
        assertExactRunIdentifier(agentId, "target agent id");
      }
      if (agentIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(issueExecutionRuns)
        .where(
          and(
            eq(issueExecutionRuns.companyId, input.companyId),
            inArray(issueExecutionRuns.targetAgentId, agentIds),
            inArray(issueExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
          ),
        )
        .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.issueId, "issue id");
      const byEpoch = "ownershipEpoch" in input;
      if (
        byEpoch &&
        (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)
      ) {
        throw new IssueExecutionRunInvariantViolation(
          "ownership epoch must be a positive integer",
        );
      }
      const refIds = byEpoch ? [] : [...new Set(input.refIds)];
      for (const refId of refIds) {
        assertExactRunIdentifier(refId, "execution ref id");
      }
      if (!byEpoch && refIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(issueExecutionRuns)
        .where(
          and(
            eq(issueExecutionRuns.companyId, input.companyId),
            eq(issueExecutionRuns.issueId, input.issueId),
            inArray(issueExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
            byEpoch
              ? eq(issueExecutionRuns.ownershipEpoch, input.ownershipEpoch)
              : sql`exists (
                  select 1
                  from ${issueExecutionRunRefs}
                  where ${issueExecutionRunRefs.companyId} = ${issueExecutionRuns.companyId}
                    and ${issueExecutionRunRefs.issueId} = ${issueExecutionRuns.issueId}
                    and ${issueExecutionRunRefs.runId} = ${issueExecutionRuns.id}
                    and ${inArray(issueExecutionRunRefs.refId, refIds)}
                )`,
          ),
        )
        .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveAgentRunsForIssueEpochInTransaction(
      transaction,
      input,
    ) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.issueId, "issue id");
      if (
        !Number.isSafeInteger(input.ownershipEpoch) ||
        input.ownershipEpoch < 1
      ) {
        throw new IssueExecutionRunInvariantViolation(
          "ownership epoch must be a positive integer",
        );
      }
      const rows = await transaction
        .select()
        .from(issueExecutionRuns)
        .where(
          and(
            eq(issueExecutionRuns.companyId, input.companyId),
            eq(issueExecutionRuns.issueId, input.issueId),
            eq(issueExecutionRuns.ownershipEpoch, input.ownershipEpoch),
            inArray(issueExecutionRuns.kind, ["productive", "consult"]),
            inArray(issueExecutionRuns.status, [
              "queued",
              "scheduled_retry",
              "running",
            ]),
          ),
        )
        .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForBudgetScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.scopeId, "budget scope id");
      if (input.scopeType === "company" && input.scopeId !== input.companyId) {
        throw new IssueExecutionRunInvariantViolation(
          "company budget scope must target its exact company",
        );
      }
      const rows = await transaction
        .select()
        .from(issueExecutionRuns)
        .where(
          and(
            eq(issueExecutionRuns.companyId, input.companyId),
            inArray(issueExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
            input.scopeType === "company"
              ? undefined
              : input.scopeType === "project"
                ? sql`exists (
                    select 1
                    from ${issues}
                    where ${issues.companyId} = ${issueExecutionRuns.companyId}
                      and ${issues.id} = ${issueExecutionRuns.issueId}
                      and ${issues.projectId} = ${input.scopeId}
                  )`
                : eq(issueExecutionRuns.targetAgentId, input.scopeId),
          ),
        )
        .orderBy(asc(issueExecutionRuns.createdAt), asc(issueExecutionRuns.id))
        .for("update");
      return Object.freeze(
        rows.map(projectRunEnvelope),
      );
    },

    listResumedAgentSteeringLivenessActionsInTransaction,

    transitionRunStatus(transaction, input) {
      return transitionIssueExecutionRunStatusInTransaction(
        transaction,
        input,
      );
    },

    attachAttempt(transaction, input) {
      return attachIssueExecutionRunAttemptInTransaction(transaction, input);
    },

    detachAttempt(transaction, input) {
      return detachIssueExecutionRunAttemptInTransaction(transaction, input);
    },

    attachCancellation(transaction, input) {
      return attachIssueExecutionRunCancellationInTransaction(
        transaction,
        input,
      );
    },

    detachCancellation(transaction, input) {
      return detachIssueExecutionRunCancellationInTransaction(
        transaction,
        input,
      );
    },

    attachFinalization(transaction, input) {
      return attachIssueExecutionRunFinalizationInTransaction(
        transaction,
        input,
      );
    },

    listForIssue(input) {
      return listIssueExecutionRunsForIssue(options.database, input);
    },

    listForAgent(input) {
      return listIssueExecutionRunsForAgent(options.database, input);
    },

    listForActivity(input) {
      return listIssueExecutionRunsForActivity(options.database, input);
    },

    listForWorkTimeline(input) {
      return listIssueExecutionRunsForWorkTimeline(options.database, input);
    },

    readJoinedRunDetail(input) {
      return readJoinedIssueExecutionRunDetail(
        options.database,
        options.issueSessionStore,
        input,
      );
    },

    async requestSteeringInTransaction(transaction, input) {
      validateRequest(input);
      return options.repository.requestInTransaction(transaction, input);
    },

    continueSteering(request) {
      return continueRequestedSteering(request);
    },

    async continuePendingSteeringForSource(input) {
      exactIdentity(input.companyId, "company id");
      exactIdentity(input.issueId, "issue id");
      exactIdentity(input.sourceCommentId, "source comment id");
      const pending = await options.repository.findPendingForSource(input);
      if (pending.kind === "resumed") {
        return { kind: "already_resumed" };
      }
      if (pending.kind === "terminal") {
        return { kind: "already_settled", result: pending.result };
      }
      if (pending.kind === "ambiguous") {
        throw new IssueExecutionSteeringRejected(
          pending.reason,
          "persisted_ambiguous",
        );
      }
      if (pending.kind === "requested") {
        const rebound = await continueRequestedSteering(pending.request);
        return { kind: "continued_requested", rebound };
      }
      // A persisted rebound has already crossed cancellation settlement and
      // process reap. Re-run the exact lifecycle fence idempotently before
      // scheduling only that same-run segment.
      try {
        await options.repository.markResumeReady(pending.rebound);
        await options.resume.resumeSteering(pending.rebound);
        return { kind: "continued_rebound", rebound: pending.rebound };
      } catch (error) {
        options.steeringResults.publish({
          companyId: pending.rebound.companyId,
          issueId: pending.rebound.issueId,
          runId: pending.rebound.runId,
          refId: pending.rebound.refId,
          refOrdinal: pending.rebound.refOrdinal,
          segmentOrdinal: pending.rebound.segmentOrdinal,
          outcome: "failed",
          response: "",
          reason:
            error instanceof Error
              ? error.message
              : "Steering continuation failed",
        });
        throw error;
      }
    },
  };
  return Object.freeze(service);
}
