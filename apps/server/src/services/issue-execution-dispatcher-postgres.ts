import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  companySessionLifecycleOperations,
  issueConsultExecutions,
  issueExecutionAttemptRetrySchedules,
  issueExecutionAttempts,
  issueExecutionCancellationIntents,
  issueExecutionHistoryViews,
  issueExecutionLanes,
  issueExecutionLeases,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issueSessions,
  issueSessionEvents,
  issueSessionInputDispositions,
  issueSessionMessages,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  IssueExecutionRef,
  IssueExecutionSessionOperation,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { contextDialDigest } from "./context-dial-resolver.js";
import { preserveCorrelationAfterNonProtocolClosure } from "./issue-execution-correlation-retention.js";
import type {
  IssueExecutionDispatcherRepository,
  IssueExecutionRetry,
  IssueExecutionTerminal,
  IssueExecutionTargetLaneIdentity,
  LeasedIssueExecutionRef,
} from "./issue-execution-dispatcher.js";
import {
  claimIssueExecutionAttemptRetryInTransaction,
  scheduleIssueExecutionAttemptRetryInTransaction,
} from "./issue-execution-attempt-retry-schedule-postgres.js";
import type { PostgresIssueExecutionFinalizationWriter } from "./issue-execution-finalization-postgres.js";
import {
  lockActiveProductiveRunForLaneInTransaction,
  lockIssueExecutionRunIfPresentInTransaction,
  readActiveIssueExecutionRefRunAvailability,
  readBlockedActiveIssueExecutionRefIds,
  readIssueExecutionLeaseBinding,
  readOccupiedIssueExecutionRefIds,
  terminalFinalizedIssueExecutionRunExistsSql,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";
import { createIssueSessionAdmissionService } from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { issueSessionMessageFromRow } from "./issue-session/projector.js";
import {
  resolveRuntimeToolTurn,
  type PostgresPromptCapabilityCompiler,
} from "./runtime-interface-compiler-db.js";
import {
  resolveInitialPromptCycleInTransaction,
  settleNonProtocolPromptInTransaction,
} from "./issue-execution-prompt-cycle-postgres.js";
import {
  isIssueExecutionRefDeliveryEligible,
  issueExecutionRefDeliveryEligibilitySql,
} from "./issue-execution-ref-delivery.js";
import {
  IssueConsultChainInvalid,
  lockAndValidateIssueConsultChain,
} from "./issue-consult-chain-postgres.js";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import {
  activeIssueTreePauseHoldExistsSql,
  lockIssueTreeExecutionGate,
} from "./issue-execution-lifecycle-gate.js";

export type PersistedIssueExecutionRefRow =
  typeof issueExecutionRefs.$inferSelect;
type RefRow = PersistedIssueExecutionRefRow;
type RunRow = IssueExecutionRunEnvelope;
type AttemptRow = typeof issueExecutionAttempts.$inferSelect;
type CancellationIntentRow =
  typeof issueExecutionCancellationIntents.$inferSelect;
type PromptCapabilityRow =
  typeof issueExecutionPromptCapabilities.$inferSelect;
type BasePromptOwnerRow = typeof issueExecutionRunRefs.$inferSelect;
type SteeringPromptOwnerRow =
  typeof issueExecutionPromptSegments.$inferSelect;
type PromptOwnerRow = BasePromptOwnerRow | SteeringPromptOwnerRow;
type LaneRefIdentity = Pick<
  RefRow,
  | "id"
  | "companyId"
  | "issueId"
  | "ownershipEpoch"
  | "targetAgentId"
  | "laneOrdinal"
>;

type LockedLaneLeaseClaim =
  | { readonly kind: "idle" }
  | {
      readonly kind: "retry";
      readonly ordinal: number;
      readonly leaseGeneration: number;
      readonly leaseId: string;
    };

type LeaseForLaneResult =
  | { readonly kind: "queued" }
  | {
      readonly kind: "leased";
      readonly lease: LeasedIssueExecutionRef;
      readonly run: RunRow;
    };

const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const MAX_CREATOR_UPDATE_BATCH = 32;

function targetLaneIdentity(
  ref: Pick<
    RefRow,
    | "companyId"
    | "issueId"
    | "sessionId"
    | "ownershipEpoch"
    | "targetAgentId"
  >,
): IssueExecutionTargetLaneIdentity {
  return Object.freeze({
    companyId: ref.companyId,
    issueId: ref.issueId,
    sessionId: ref.sessionId,
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
  });
}

export class PostgresIssueExecutionDispatchRejected extends Error {
  readonly code = "postgres_issue_execution_dispatch_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresIssueExecutionDispatchRejected";
  }
}

export interface PostgresIssueExecutionDispatcherRepositoryOptions {
  readonly database: Db;
  readonly runService: Pick<
    IssueExecutionRunService,
    | "createRun"
    | "lockRun"
    | "readRun"
    | "transitionRunStatus"
    | "attachAttempt"
    | "detachAttempt"
    | "detachCancellation"
  >;
  readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
  readonly finalizer: Pick<
    PostgresIssueExecutionFinalizationWriter,
    | "finalize"
    | "finalizeInTransaction"
  >;
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pluginDomainEvents: PluginDomainEventPublisher;
  readonly dispatchRef?: (refId: string) => Promise<void>;
}

export type IssueExecutionAuthorityFenceSelector =
  | {
      readonly kind: "agents";
      readonly agentIds: readonly string[];
    }
  | {
      readonly kind: "suspended_agents";
      readonly agentIds: readonly string[];
    }
  | {
      readonly kind: "ownership_epoch";
      readonly issueId: string;
      readonly ownershipEpoch: number;
    }
  | {
      readonly kind: "refs";
      readonly issueId: string;
      readonly refIds: readonly string[];
    }
  | {
      readonly kind: "budget_scope";
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
    };

export interface FencedIssueExecutionAuthority {
  readonly refIds: readonly string[];
  readonly correlationIds: readonly string[];
}

function reject(message: string): never {
  throw new PostgresIssueExecutionDispatchRejected(message);
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} is invalid`);
  }
  return value;
}

function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
}

type ExpiredPromptClosureDecision =
  | { readonly kind: "open" }
  | {
      readonly kind: "retry";
      readonly reason: IssueExecutionRetry["reason"];
      readonly retryAt: Date;
    }
  | {
      readonly kind: "terminal";
      readonly outcome: IssueExecutionTerminal["outcome"];
      readonly reason: string;
      readonly protocolSettled: boolean;
    };

export function classifyExpiredPromptClosure(input: {
  readonly owner: PromptOwnerRow;
  readonly capability: PromptCapabilityRow | null;
}): ExpiredPromptClosureDecision {
  const { owner, capability } = input;
  if (capability === null) {
    if (owner.protocolSettlementState !== null) {
      reject("settled expired prompt lost its exact capability decision");
    }
    return { kind: "open" };
  }
  if (capability.state !== "revoked") {
    if (
      capability.revocationReason !== null ||
      capability.revokedAt !== null ||
      owner.protocolSettlementState !== null
    ) {
      reject("expired prompt capability has an inconsistent closure shape");
    }
    return { kind: "open" };
  }
  if (
    capability.revocationReason === null ||
    capability.revokedAt === null
  ) {
    reject("revoked expired prompt lost its durable closure decision");
  }

  switch (capability.revocationReason) {
    case "pre_send_retry":
      if (
        owner.protocolSettlementState !== null ||
        owner.promptTransmissionPhase !== "not_transmitted" ||
        capability.activatedAt !== null ||
        capability.targetSessionCorrelationId !== null
      ) {
        reject("pre-send retry crossed its unactivated prompt generation");
      }
      return {
        kind: "retry",
        reason: "transport_transient",
        retryAt: new Date(capability.revokedAt.getTime() + 1_000),
      };
    case "pre_send_failure":
      if (
        owner.protocolSettlementState !== "not_sent" ||
        owner.promptTransmissionPhase !== "not_transmitted" ||
        owner.outcome !== "released_unsent"
      ) {
        reject("pre-send failure lost its durable not-sent settlement");
      }
      return {
        kind: "terminal",
        outcome: "failed",
        reason: "pre_send_failure",
        protocolSettled: false,
      };
    case "prompt_failed_incomplete":
      if (
        owner.protocolSettlementState !== "incomplete" ||
        owner.promptTransmissionPhase !== "transmitted" ||
        owner.outcome !== "failed"
      ) {
        reject("post-send failure lost its durable incomplete settlement");
      }
      return {
        kind: "terminal",
        outcome: "failed",
        reason: "prompt_failed_incomplete",
        protocolSettled: false,
      };
    case "prompt_cancelled_incomplete":
      if (
        owner.protocolSettlementState !== "incomplete" ||
        owner.promptTransmissionPhase !== "transmitted" ||
        owner.outcome !== "cancelled"
      ) {
        reject("post-send cancellation lost its durable incomplete settlement");
      }
      return {
        kind: "terminal",
        outcome: "cancelled",
        reason: "prompt_cancelled_incomplete",
        protocolSettled: false,
      };
    case "protocol_settled":
      if (
        owner.protocolSettlementState !== "settled" ||
        owner.promptTransmissionPhase !== "transmitted" ||
        (owner.outcome !== "succeeded" &&
          owner.outcome !== "refused" &&
          owner.outcome !== "cancelled")
      ) {
        reject("protocol-settled recovery lost its durable prompt outcome");
      }
      return {
        kind: "terminal",
        outcome: owner.outcome === "cancelled" ? "cancelled" : "succeeded",
        reason: capability.revocationReason,
        protocolSettled: true,
      };
    case "active_run_steering":
      if (owner.protocolSettlementState === null) {
        return { kind: "open" };
      }
      if (
        owner.promptTransmissionPhase !== "transmitted" ||
        owner.outcome !== "cancelled" ||
        (owner.protocolSettlementState !== "settled" &&
          owner.protocolSettlementState !== "incomplete")
      ) {
        reject("steering-revoked prompt has an invalid cancellation closure");
      }
      return {
        kind: "terminal",
        outcome: "cancelled",
        reason: "active_run_steering",
        protocolSettled: owner.protocolSettlementState === "settled",
      };
    default:
      reject("revoked expired prompt has no canonical recovery decision");
  }
}

/** Single canonical PostgreSQL-row to domain-ref projection. */
export function projectPersistedIssueExecutionRef(
  row: PersistedIssueExecutionRefRow,
): IssueExecutionRef {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    sessionId: row.sessionId,
    ownershipEpoch: row.ownershipEpoch,
    previousOwnershipEpoch: row.previousOwnershipEpoch,
    executionScopeId: row.executionScopeId,
    executionLineageId: row.executionLineageId,
    mode: row.mode,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceRecordId: row.sourceRecordId,
    messageKind: row.messageKind,
    messageId: row.sourceMessageId,
    exactMessage: row.exactMessage,
    deliveryIdempotencyKey: row.deliveryIdempotencyKey,
    targetAgentId: row.targetAgentId,
    laneOrdinal: row.laneOrdinal,
    issueExecutionAuthorityId: row.issueExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    contextEpoch: row.contextEpoch,
    historyViewId: row.historyViewId,
    admissionHighWaterSeq: row.admissionHighWaterSeq,
    inputId: row.inputId,
    admittedSeq: row.admittedSeq,
    promotedSeq: row.promotedSeq,
    counterpartIssueId: row.counterpartIssueId,
    counterpartAuthorityId: row.counterpartAuthorityId,
    counterpartOwnershipEpoch: row.counterpartOwnershipEpoch,
    consultCallerRefId: row.consultCallerRefId,
    consultChainToken: row.consultChainToken,
    disposition: row.disposition,
  };
}

function sameBatchScope(first: RefRow, candidate: RefRow): boolean {
  return candidate.sourceKind === "issue_update" &&
    candidate.companyId === first.companyId &&
    candidate.issueId === first.issueId &&
    candidate.sessionId === first.sessionId &&
    candidate.ownershipEpoch === first.ownershipEpoch &&
    candidate.executionScopeId === first.executionScopeId &&
    candidate.executionLineageId === first.executionLineageId &&
    candidate.mode === first.mode &&
    candidate.targetAgentId === first.targetAgentId &&
    candidate.issueExecutionAuthorityId === first.issueExecutionAuthorityId &&
    candidate.consultExecutionId === first.consultExecutionId &&
    candidate.adapterConfigRevisionId === first.adapterConfigRevisionId &&
    candidate.contextEpoch === first.contextEpoch &&
    candidate.disposition === "active" &&
    isIssueExecutionRefDeliveryEligible(candidate, "dispatch");
}

function leaseProjection(
  refs: readonly RefRow[],
  runId: string,
  attempt: AttemptRow,
  leaseId: string,
  leaseGeneration: number,
): LeasedIssueExecutionRef {
  const first = exactlyOne(refs.slice(0, 1), "attempt lost its first run ref");
  if (
    attempt.refOrdinal === null ||
    attempt.segmentOrdinal === null ||
    (attempt.promptKind !== "base" && attempt.promptKind !== "steering")
  ) {
    reject("productive lease lost its exact prompt identity");
  }
  const members = refs.map((row) => ({
    ref: projectPersistedIssueExecutionRef(row),
    leaseGeneration,
    attemptNumber: attempt.attemptGeneration,
  }));
  return Object.freeze({
    ref: projectPersistedIssueExecutionRef(first),
    companyId: first.companyId,
    issueId: first.issueId,
    runId,
    attemptId: attempt.id,
    promptKind: attempt.promptKind,
    sessionOperation: attempt.sessionOperation,
    refOrdinal: attempt.refOrdinal,
    segmentOrdinal: attempt.segmentOrdinal,
    leaseId,
    leaseGeneration,
    attemptNumber: attempt.attemptGeneration,
    batch: Object.freeze(members),
  });
}

async function lockLane(
  transaction: IssueSessionDbTransaction,
  ref: Pick<
    LaneRefIdentity,
    "companyId" | "issueId" | "ownershipEpoch" | "targetAgentId"
  >,
) {
  return exactlyOne(
    await transaction
      .select()
      .from(issueExecutionLanes)
      .where(
        and(
          eq(issueExecutionLanes.companyId, ref.companyId),
          eq(issueExecutionLanes.issueId, ref.issueId),
          eq(issueExecutionLanes.ownershipEpoch, ref.ownershipEpoch),
          eq(issueExecutionLanes.targetAgentId, ref.targetAgentId),
        ),
      )
      .limit(2)
      .for("update"),
    "execution ref lost its exact lane",
  );
}

async function lockLaneParents(
  transaction: IssueSessionDbTransaction,
  ref: Pick<LaneRefIdentity, "companyId" | "issueId"> & {
    readonly sessionId?: string;
  },
): Promise<void> {
  exactlyOne(
    await transaction
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, ref.companyId))
      .limit(2)
      .for("update"),
    "execution lane lost its company parent",
  );
  exactlyOne(
    await transaction
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, ref.companyId),
          eq(issues.id, ref.issueId),
        ),
      )
      .limit(2)
      .for("update"),
    "execution lane lost its issue parent",
  );
  if (ref.sessionId !== undefined) {
    exactlyOne(
      await transaction
        .select({ id: issueSessions.id })
        .from(issueSessions)
        .where(
          and(
            eq(issueSessions.companyId, ref.companyId),
            eq(issueSessions.issueId, ref.issueId),
            eq(issueSessions.id, ref.sessionId),
          ),
        )
        .limit(2)
        .for("update"),
      "execution lane lost its Session parent",
    );
  }
}

async function lockLaneLeaseClaim(
  transaction: IssueSessionDbTransaction,
  ref: RefRow,
  options: { readonly existingRun: boolean },
): Promise<LockedLaneLeaseClaim | null> {
  await lockLaneParents(transaction, ref);
  const lane = await lockLane(transaction, ref);
  const laneHead = await transaction
    .select({
      id: issueExecutionRefs.id,
      laneOrdinal: issueExecutionRefs.laneOrdinal,
    })
    .from(issueExecutionRefs)
    .where(
      and(
        eq(issueExecutionRefs.companyId, ref.companyId),
        eq(issueExecutionRefs.issueId, ref.issueId),
        eq(issueExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
        eq(issueExecutionRefs.targetAgentId, ref.targetAgentId),
        eq(issueExecutionRefs.disposition, "active"),
      ),
    )
    .orderBy(asc(issueExecutionRefs.laneOrdinal), asc(issueExecutionRefs.id))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !laneHead ||
    laneHead.id !== ref.id ||
    laneHead.laneOrdinal !== ref.laneOrdinal
  ) {
    if (options.existingRun) {
      reject("active run no longer owns the exact execution-lane head");
    }
    return null;
  }
  if (lane.activeOrdinal === null) {
    if (
      lane.activeLeaseGeneration !== null ||
      lane.activeLeaseId !== null
    ) {
      reject("idle execution lane retains an active lease fence");
    }
    return { kind: "idle" };
  }
  if (
    lane.activeLeaseGeneration === null ||
    lane.activeLeaseId === null
  ) {
    reject("active execution lane lost its lease fence");
  }
  if (
    !options.existingRun
  ) {
    return null;
  }
  if (lane.activeOrdinal !== ref.laneOrdinal) {
    reject("retry drifted from the lane's exact current ordinal");
  }
  return {
    kind: "retry",
    ordinal: lane.activeOrdinal,
    leaseGeneration: lane.activeLeaseGeneration,
    leaseId: lane.activeLeaseId,
  };
}

async function clearExactLaneClaim(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly ref: Pick<
      LaneRefIdentity,
      "companyId" | "issueId" | "ownershipEpoch" | "targetAgentId"
    >;
    readonly laneOrdinal: number;
    readonly leaseGeneration: number;
    readonly leaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  exactlyOne(
    await transaction
      .update(issueExecutionLanes)
      .set({
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(issueExecutionLanes.companyId, input.ref.companyId),
          eq(issueExecutionLanes.issueId, input.ref.issueId),
          eq(
            issueExecutionLanes.ownershipEpoch,
            input.ref.ownershipEpoch,
          ),
          eq(issueExecutionLanes.targetAgentId, input.ref.targetAgentId),
          eq(issueExecutionLanes.activeOrdinal, input.laneOrdinal),
          eq(
            issueExecutionLanes.activeLeaseGeneration,
            input.leaseGeneration,
          ),
          eq(issueExecutionLanes.activeLeaseId, input.leaseId),
        ),
      )
      .returning({ companyId: issueExecutionLanes.companyId }),
    "execution lane lost its exact ordinal and lease claim",
  );
}

async function assertLeaseLaneClaim(
  transaction: IssueSessionDbTransaction,
  lease: LeasedIssueExecutionRef,
  at: Date,
): Promise<void> {
  await lockLaneParents(transaction, lease.ref);
  const lane = await lockLane(transaction, lease.ref);
  const persistedRef = exactlyOne(
    await transaction
      .select()
      .from(issueExecutionRefs)
      .where(eq(issueExecutionRefs.id, lease.ref.id))
      .limit(2)
      .for("update"),
    "lease lost its persisted execution ref",
  );
  const member = exactlyOne(
    await transaction
      .select({ admissionOrder: issueExecutionRunRefs.admissionOrder })
      .from(issueExecutionRunRefs)
      .where(
        and(
          eq(issueExecutionRunRefs.runId, lease.runId),
          eq(issueExecutionRunRefs.refId, lease.ref.id),
          eq(issueExecutionRunRefs.refOrdinal, lease.refOrdinal),
        ),
      )
      .limit(2)
      .for("update"),
    "lease lost its exact run member",
  );
  const persistedLease = exactlyOne(
    await transaction
      .select()
      .from(issueExecutionLeases)
      .where(eq(issueExecutionLeases.id, lease.leaseId))
      .limit(2)
      .for("update"),
    "lease lost its exact persisted authority",
  );
  if (
    member.admissionOrder !== persistedRef.laneOrdinal ||
    lane.activeOrdinal !== member.admissionOrder ||
    lane.activeLeaseGeneration !== lease.leaseGeneration ||
    lane.activeLeaseId !== lease.leaseId ||
    persistedLease.attemptId !== lease.attemptId ||
    persistedLease.leaseGeneration !== lease.leaseGeneration ||
    persistedLease.state !== "active" ||
    persistedLease.expiresAt <= at
  ) {
    reject("lease no longer owns the exact lane claim");
  }
}

async function lockRunLaneClaimIfPresent(
  transaction: IssueSessionDbTransaction,
  runId: string,
): Promise<{
  readonly ref: LaneRefIdentity;
  readonly laneOrdinal: number;
  readonly leaseGeneration: number;
  readonly leaseId: string;
} | null> {
  const rows = await transaction
    .select({
      ref: issueExecutionRefs,
      laneOrdinal: issueExecutionLanes.activeOrdinal,
      leaseGeneration: issueExecutionLanes.activeLeaseGeneration,
      leaseId: issueExecutionLanes.activeLeaseId,
    })
    .from(issueExecutionLanes)
    .innerJoin(
      issueExecutionRefs,
      and(
        eq(issueExecutionRefs.companyId, issueExecutionLanes.companyId),
        eq(issueExecutionRefs.issueId, issueExecutionLanes.issueId),
        eq(
          issueExecutionRefs.ownershipEpoch,
          issueExecutionLanes.ownershipEpoch,
        ),
        eq(issueExecutionRefs.targetAgentId, issueExecutionLanes.targetAgentId),
        sql`${issueExecutionRefs.laneOrdinal} = ${issueExecutionLanes.activeOrdinal}`,
      ),
    )
    .innerJoin(
      issueExecutionRunRefs,
      and(
        eq(issueExecutionRunRefs.runId, runId),
        eq(issueExecutionRunRefs.refId, issueExecutionRefs.id),
      ),
    )
    .innerJoin(
      issueExecutionLeases,
      and(
        eq(issueExecutionLeases.id, issueExecutionLanes.activeLeaseId),
        eq(issueExecutionLeases.runId, issueExecutionRunRefs.runId),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  const claim = exactlyOne(rows, "run owns more than one active lane claim");
  if (
    claim.laneOrdinal === null ||
    claim.leaseGeneration === null ||
    claim.leaseId === null
  ) {
    reject("active run lane claim is incomplete");
  }
  await lockLaneParents(transaction, claim.ref);
  const lane = await lockLane(transaction, claim.ref);
  if (
    lane.activeOrdinal !== claim.laneOrdinal ||
    lane.activeLeaseGeneration !== claim.leaseGeneration ||
    lane.activeLeaseId !== claim.leaseId
  ) {
    reject("run lane claim changed while acquiring its canonical lock order");
  }
  return {
    ref: claim.ref,
    laneOrdinal: claim.laneOrdinal,
    leaseGeneration: claim.leaseGeneration,
    leaseId: claim.leaseId,
  };
}

async function compileCarryContext(
  compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">,
  run: RunRow,
): Promise<{
  readonly carryContext: boolean;
  readonly exposureDigest: string;
  readonly carrySourceExposureDigest: string;
}> {
  const compiled = await compiler.resolve({
    companyId: run.companyId,
    issueId: run.issueId,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    executionMode: run.executionMode,
    issueExecutionAuthorityId: run.issueExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
  });
  return {
    carryContext: compiled.contextDial.carry_context,
    exposureDigest: contextDialDigest(compiled.contextDial),
    // Explicit steering may cross only a carry_context toggle. The source
    // carry row still has to match every history/tool exposure cell that was
    // authorized when the interrupted prompt started.
    carrySourceExposureDigest: contextDialDigest({
      ...compiled.contextDial,
      carry_context: true,
    }),
  };
}

/** @internal Freezes the sole ACPX session operation for one exact prompt. */
export async function selectSessionOperation(
  transaction: IssueSessionDbTransaction,
  compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">,
  input: {
    readonly run: RunRow;
    readonly promptKind: "base" | "steering";
    readonly ref: RefRow;
    readonly refOrdinal: number;
    readonly segmentOrdinal: number;
  },
): Promise<IssueExecutionSessionOperation> {
  const run = input.run;
  const {
    carryContext,
    exposureDigest,
    carrySourceExposureDigest,
  } = await compileCarryContext(
    compiler,
    run,
  );
  const common = and(
    eq(issueExecutionSessions.companyId, run.companyId),
    eq(issueExecutionSessions.issueId, run.issueId),
    eq(issueExecutionSessions.ownershipEpoch, run.ownershipEpoch),
    eq(issueExecutionSessions.targetAgentId, run.targetAgentId),
    eq(issueExecutionSessions.adapterConfigIdentity, run.adapterConfigRevisionId),
    eq(issueExecutionSessions.workspaceIdentity, run.executionWorkspaceBindingId),
  );
  if (input.promptKind === "steering") {
    const segment = exactlyOne(
      await transaction
        .select({
          resumeSourceCorrelationId:
            issueExecutionPromptSegments.resumeSourceCorrelationId,
        })
        .from(issueExecutionPromptSegments)
        .where(
          and(
            eq(issueExecutionPromptSegments.companyId, run.companyId),
            eq(issueExecutionPromptSegments.issueId, run.issueId),
            eq(issueExecutionPromptSegments.runId, run.runId),
            eq(issueExecutionPromptSegments.refId, input.ref.id),
            eq(issueExecutionPromptSegments.refOrdinal, input.refOrdinal),
            eq(
              issueExecutionPromptSegments.segmentOrdinal,
              input.segmentOrdinal,
            ),
            eq(issueExecutionPromptSegments.steeringState, "resumed"),
            isNull(issueExecutionPromptSegments.protocolSettlementState),
          ),
        )
        .limit(2)
        .for("update"),
      "steering attempt lost its immutable resume source",
    );
    const sources = await transaction
      .select()
      .from(issueExecutionSessions)
      .where(
        and(
          common,
          eq(issueExecutionSessions.id, segment.resumeSourceCorrelationId),
        ),
      )
      .limit(2)
      .for("update");
    if (sources.length > 1) reject("steering resume source is ambiguous");
    const source = sources[0] ?? null;
    const exactCarrySource = source !== null &&
      source.purpose === "carry" &&
      source.state === "eligible" &&
      source.laneKind === run.executionMode &&
      source.runId === null &&
      source.currentRefId === null &&
      source.currentRefOrdinal === null &&
      source.currentSegmentOrdinal === null &&
      source.authorizedContextExposureDigest === carrySourceExposureDigest;
    const exactActiveRunSource = source !== null &&
      source.purpose === "active_run_steering" &&
      source.state === "current" &&
      source.laneKind === null &&
      source.runId === run.runId &&
      source.currentRefId === input.ref.id &&
      source.currentRefOrdinal === input.refOrdinal &&
      source.currentSegmentOrdinal === input.segmentOrdinal - 1 &&
      source.authorizedContextExposureDigest === null;
    if (exactCarrySource || exactActiveRunSource) return "steer_resume";
    reject("steering attempt lost its exact native resume source");
  }
  const initialCycle = await resolveInitialPromptCycleInTransaction(
    transaction,
    {
      currentRef: input.ref,
      executionWorkspaceBindingId: run.executionWorkspaceBindingId,
    },
  );
  if (initialCycle.kind === "invalid") {
    reject("bootstrap predecessor lost its exact settled native correlation");
  }
  if (initialCycle.kind === "new") return "new";
  if (initialCycle.kind === "bootstrap_resume") return "resume";
  if (initialCycle.kind === "bootstrap_unavailable") {
    reject("ordered session-start work lost its exact bootstrap correlation");
  }
  const eligible = carryContext
    ? await transaction
      .select({ id: issueExecutionSessions.id })
      .from(issueExecutionSessions)
      .where(
        and(
          common,
          eq(issueExecutionSessions.purpose, "carry"),
          eq(issueExecutionSessions.state, "eligible"),
          eq(issueExecutionSessions.laneKind, run.executionMode),
          eq(
            issueExecutionSessions.authorizedContextExposureDigest,
            exposureDigest,
          ),
        ),
      )
      .limit(2)
      .for("update")
    : [];
  if (eligible.length > 1) reject("carry target session is ambiguous");
  if (eligible.length === 1) {
    return "resume";
  }
  if (initialCycle.kind === "singleton" && initialCycle.instructionless) {
    return "new";
  }
  reject("instructed work lost its exact carry or ordered session start");
}

async function assertRefDispatchable(
  transaction: IssueSessionDbTransaction,
  ref: RefRow,
): Promise<void> {
  const [companyRows, issueRows, sessionRows, viewRows, lifecycleRows] =
    await Promise.all([
      transaction
        .select({ status: companies.status, integrity: companies.sessionIntegrityState })
        .from(companies)
        .where(eq(companies.id, ref.companyId))
        .limit(2)
        .for("share"),
      transaction
        .select({
          lifecycleStatus: issues.lifecycleStatus,
          ownerKind: issues.ownerKind,
          ownerAgentId: issues.ownerAgentId,
          ownershipEpoch: issues.ownershipEpoch,
        })
        .from(issues)
        .where(and(eq(issues.companyId, ref.companyId), eq(issues.id, ref.issueId)))
        .limit(2)
        .for("update"),
      transaction
        .select()
        .from(issueSessions)
        .where(
          and(
            eq(issueSessions.companyId, ref.companyId),
            eq(issueSessions.issueId, ref.issueId),
            eq(issueSessions.id, ref.sessionId),
          ),
        )
        .limit(2)
        .for("update"),
      transaction
        .select({ state: issueExecutionHistoryViews.state, refId: issueExecutionHistoryViews.refId })
        .from(issueExecutionHistoryViews)
        .where(eq(issueExecutionHistoryViews.id, ref.historyViewId))
        .limit(2)
        .for("update"),
      transaction
        .select({ id: companySessionLifecycleOperations.id })
        .from(companySessionLifecycleOperations)
        .where(
          and(
            eq(companySessionLifecycleOperations.companyId, ref.companyId),
            inArray(companySessionLifecycleOperations.status, [
              "fenced",
              "cancelling",
              "purge_ready",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
  const company = exactlyOne(companyRows, "execution ref lost its company");
  const issue = exactlyOne(issueRows, "execution ref lost its issue");
  const session = exactlyOne(sessionRows, "execution ref lost its Session");
  const view = exactlyOne(viewRows, "execution ref lost its history view");
  const ownerValid = ref.mode === "owner"
    ? issue.ownerKind === "agent" &&
      issue.ownerAgentId === ref.targetAgentId &&
      ref.issueExecutionAuthorityId !== null
    : ref.consultExecutionId !== null;
  if (
    company.status !== "active" ||
    company.integrity !== "ready" ||
    lifecycleRows.length !== 0 ||
    !["open", "blocked"].includes(issue.lifecycleStatus) ||
    issue.ownershipEpoch !== ref.ownershipEpoch ||
    !ownerValid ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !["empty", "current"].includes(view.state) ||
    view.refId !== ref.id ||
    ref.disposition !== "active" ||
    !isIssueExecutionRefDeliveryEligible(ref, "dispatch")
  ) {
    reject("execution ref is no longer current and dispatchable");
  }
  if (ref.mode === "consult") {
    if (!(await consultSourceRunIsFinalized(transaction, ref))) {
      reject("consult source run is not finalized");
    }
    try {
      await lockAndValidateIssueConsultChain(transaction, {
        ref,
        requireLiveAncestors: false,
        leafState: "active",
      });
    } catch (error) {
      if (error instanceof IssueConsultChainInvalid) {
        reject(error.message);
      }
      throw error;
    }
  }
}

async function consultSourceRunIsFinalized(
  transaction: IssueSessionDbTransaction,
  ref: Pick<RefRow, "companyId" | "issueId" | "mode" | "consultExecutionId">,
): Promise<boolean> {
  if (ref.mode === "owner") return true;
  if (ref.consultExecutionId === null) return false;
  const rows = await transaction
    .select({ sourceRunId: issueConsultExecutions.sourceRunId })
    .from(issueConsultExecutions)
    .where(
      and(
        eq(issueConsultExecutions.id, ref.consultExecutionId),
        eq(issueConsultExecutions.companyId, ref.companyId),
        eq(issueConsultExecutions.issueId, ref.issueId),
      ),
    )
    .limit(2)
    .for("share");
  const consult = rows.length === 1 ? rows[0]! : null;
  if (!consult) return false;
  const sourceRun = await lockIssueExecutionRunIfPresentInTransaction(
    transaction,
    {
      companyId: ref.companyId,
      issueId: ref.issueId,
      runId: consult.sourceRunId,
    },
  );
  return sourceRun?.terminalFinalizationId !== null;
}

async function createRunningLease(
  transaction: IssueSessionDbTransaction,
  options: {
    readonly runService: PostgresIssueExecutionDispatcherRepositoryOptions["runService"];
    readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
    readonly idFactory: () => string;
    readonly leaseTtlMs: number;
  },
  input: {
    readonly run: RunRow;
    readonly refs: readonly RefRow[];
    readonly workerId: string;
    readonly at: Date;
    readonly laneClaim: LockedLaneLeaseClaim;
  readonly pendingAttempt?: AttemptRow;
  },
): Promise<LeasedIssueExecutionRef> {
  const first = exactlyOne(input.refs.slice(0, 1), "run has no current ref");
  const control = exactlyOne(
    await transaction
      .select()
      .from(issueExecutionRunControls)
      .where(eq(issueExecutionRunControls.runId, input.run.runId))
      .limit(2)
      .for("update"),
    "productive run lost its current-prompt control",
  );
  if (
    control.currentRefId !== first.id ||
    control.currentOrdinal === null ||
    control.currentSegmentOrdinal === null
  ) {
    reject("run control does not select the leased prompt");
  }
  const promptKind = control.currentSegmentOrdinal === 0 ? "base" : "steering";
  const currentMember = exactlyOne(
    await transaction
      .select({ admissionOrder: issueExecutionRunRefs.admissionOrder })
      .from(issueExecutionRunRefs)
      .where(
        and(
          eq(issueExecutionRunRefs.runId, input.run.runId),
          eq(issueExecutionRunRefs.refId, first.id),
          eq(issueExecutionRunRefs.refOrdinal, control.currentOrdinal),
        ),
      )
      .limit(2)
      .for("update"),
    "attempt lost its run-ref membership",
  );
  if (currentMember.admissionOrder !== first.laneOrdinal) {
    reject("run member drifted from its immutable lane ordinal");
  }
  if (
    input.laneClaim.kind === "retry" &&
    input.laneClaim.ordinal !== currentMember.admissionOrder
  ) {
    reject("retry crossed its exact current lane ordinal");
  }
  const operation = input.pendingAttempt?.sessionOperation ??
    await selectSessionOperation(transaction, options.compiler, {
      run: input.run,
      promptKind,
      ref: first,
      refOrdinal: control.currentOrdinal,
      segmentOrdinal: control.currentSegmentOrdinal,
    });
  const generationRows = await transaction
    .select({ generation: issueExecutionAttempts.attemptGeneration })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.runId, input.run.runId),
        eq(issueExecutionAttempts.refId, first.id),
        eq(issueExecutionAttempts.refOrdinal, control.currentOrdinal),
        eq(issueExecutionAttempts.segmentOrdinal, control.currentSegmentOrdinal),
      ),
    )
    .orderBy(desc(issueExecutionAttempts.attemptGeneration))
    .limit(1)
    .for("update");
  const attempt = input.pendingAttempt
    ? exactlyOne(
        await transaction
          .update(issueExecutionAttempts)
          .set({ state: "running", startedAt: input.at })
          .where(
            and(
              eq(issueExecutionAttempts.id, input.pendingAttempt.id),
              eq(issueExecutionAttempts.state, "pending"),
            ),
          )
          .returning(),
        "pending retry attempt could not start",
      )
    : exactlyOne(
        await transaction
          .insert(issueExecutionAttempts)
          .values({
            id: options.idFactory(),
            companyId: input.run.companyId,
            issueId: input.run.issueId,
            sessionId: input.run.sessionId,
            runId: input.run.runId,
            runKind: input.run.kind,
            promptKind,
            sessionOperation: operation,
            refId: first.id,
            refOrdinal: control.currentOrdinal,
            segmentOrdinal: control.currentSegmentOrdinal,
            steeringSegmentOrdinal:
              promptKind === "steering" ? control.currentSegmentOrdinal : null,
            attemptGeneration: (generationRows[0]?.generation ?? 0) + 1,
            state: "running",
            startedAt: input.at,
            finishedAt: null,
            createdAt: input.at,
          })
          .returning(),
        "attempt creation did not return one row",
      );
  if (
    attempt.sessionOperation !== operation ||
    attempt.refId !== first.id ||
    attempt.refOrdinal !== control.currentOrdinal ||
    attempt.segmentOrdinal !== control.currentSegmentOrdinal
  ) {
    reject("attempt crossed its frozen prompt identity");
  }
  const leaseGeneration =
    input.laneClaim.kind === "retry"
      ? input.laneClaim.leaseGeneration + 1
      : 1;
  const leaseId = options.idFactory();
  exactlyOne(
    await transaction
      .insert(issueExecutionLeases)
      .values({
        id: leaseId,
        companyId: input.run.companyId,
        issueId: input.run.issueId,
        runId: input.run.runId,
        attemptId: attempt.id,
        leaseGeneration,
        workerId: input.workerId,
        state: "active",
        acquiredAt: input.at,
        renewedAt: null,
        expiresAt: new Date(input.at.getTime() + options.leaseTtlMs),
        releasedAt: null,
        createdAt: input.at,
      })
      .returning({ id: issueExecutionLeases.id }),
    "attempt lease creation did not return one row",
  );
  await options.runService.attachAttempt(transaction, {
    companyId: input.run.companyId,
    issueId: input.run.issueId,
    runId: input.run.runId,
    attemptId: attempt.id,
    leaseId,
    at: input.at,
  });
  exactlyOne(
    await transaction
      .update(issueExecutionLanes)
      .set({
        activeOrdinal: currentMember.admissionOrder,
        activeLeaseGeneration: leaseGeneration,
        activeLeaseId: leaseId,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(issueExecutionLanes.companyId, first.companyId),
          eq(issueExecutionLanes.issueId, first.issueId),
          eq(issueExecutionLanes.ownershipEpoch, first.ownershipEpoch),
          eq(issueExecutionLanes.targetAgentId, first.targetAgentId),
          input.laneClaim.kind === "idle"
            ? isNull(issueExecutionLanes.activeOrdinal)
            : eq(
                issueExecutionLanes.activeOrdinal,
                input.laneClaim.ordinal,
              ),
          input.laneClaim.kind === "idle"
            ? isNull(issueExecutionLanes.activeLeaseGeneration)
            : eq(
                issueExecutionLanes.activeLeaseGeneration,
                input.laneClaim.leaseGeneration,
              ),
          input.laneClaim.kind === "idle"
            ? isNull(issueExecutionLanes.activeLeaseId)
            : eq(
                issueExecutionLanes.activeLeaseId,
                input.laneClaim.leaseId,
              ),
        ),
      )
      .returning({ companyId: issueExecutionLanes.companyId }),
    "attempt could not bind its lane",
  );
  return leaseProjection(
    input.refs,
    input.run.runId,
    attempt,
    leaseId,
    leaseGeneration,
  );
}

async function currentRunRefs(
  transaction: IssueSessionDbTransaction,
  runId: string,
): Promise<RefRow[]> {
  return transaction
    .select({ ref: issueExecutionRefs })
    .from(issueExecutionRunRefs)
    .innerJoin(issueExecutionRefs, eq(issueExecutionRefs.id, issueExecutionRunRefs.refId))
    .where(eq(issueExecutionRunRefs.runId, runId))
    .orderBy(asc(issueExecutionRunRefs.refOrdinal))
    .then((rows) => rows.map((row) => row.ref));
}

async function findExistingRunForLane(
  transaction: IssueSessionDbTransaction,
  lane: IssueExecutionTargetLaneIdentity,
): Promise<RunRow | null> {
  await lockLaneParents(transaction, lane);
  await lockLane(transaction, lane);
  return lockActiveProductiveRunForLaneInTransaction(transaction, lane);
}

async function createRunForRef(
  transaction: IssueSessionDbTransaction,
  options: PostgresIssueExecutionDispatcherRepositoryOptions,
  ref: RefRow,
  at: Date,
  exactRetry?: {
    readonly retryOfRunId: string;
    readonly orderedRefs: readonly RefRow[];
    readonly sessionOperation: IssueExecutionSessionOperation;
  },
): Promise<{ readonly run: RunRow; readonly refs: readonly RefRow[] }> {
  let refs: readonly RefRow[];
  if (exactRetry) {
    if (
      exactRetry.orderedRefs.length === 0 ||
      exactRetry.orderedRefs[0]?.id !== ref.id ||
      new Set(exactRetry.orderedRefs.map((candidate) => candidate.id)).size !==
        exactRetry.orderedRefs.length
    ) {
      reject("released-run retry lost its exact ordered ref frontier");
    }
    refs = Object.freeze([...exactRetry.orderedRefs]);
  } else {
    const occupiedRefIds = await readOccupiedIssueExecutionRefIds(transaction, {
      companyId: ref.companyId,
      issueId: ref.issueId,
      sessionId: ref.sessionId,
    });
    const candidates = ref.sourceKind === "issue_update"
      ? await transaction
          .select()
          .from(issueExecutionRefs)
          .where(
            and(
              eq(issueExecutionRefs.companyId, ref.companyId),
              eq(issueExecutionRefs.issueId, ref.issueId),
              eq(issueExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
              eq(issueExecutionRefs.targetAgentId, ref.targetAgentId),
              eq(issueExecutionRefs.disposition, "active"),
              gte(issueExecutionRefs.laneOrdinal, ref.laneOrdinal),
            ),
          )
          .orderBy(asc(issueExecutionRefs.laneOrdinal))
          .limit(MAX_CREATOR_UPDATE_BATCH + 1)
          .for("update")
      : [ref];
    const firstIndex = candidates.findIndex(
      (candidate) => candidate.id === ref.id,
    );
    const ordered: RefRow[] = [];
    if (firstIndex >= 0) {
      const occupied = new Set(occupiedRefIds);
      for (const candidate of candidates.slice(firstIndex)) {
        if (
          ordered.length >= MAX_CREATOR_UPDATE_BATCH ||
          occupied.has(candidate.id) ||
          !isIssueExecutionRefDeliveryEligible(candidate, "dispatch") ||
          !sameBatchScope(ref, candidate)
        ) break;
        ordered.push(candidate);
      }
    }
    refs = ordered.length > 0 ? ordered : [ref];
  }
  for (const candidate of refs) await assertRefDispatchable(transaction, candidate);
  const workspace = exactlyOne(
    await transaction
      .select({ id: issueExecutionWorkspaceBindings.id })
      .from(issueExecutionWorkspaceBindings)
      .where(
        and(
          eq(issueExecutionWorkspaceBindings.companyId, ref.companyId),
          eq(issueExecutionWorkspaceBindings.issueId, ref.issueId),
          eq(issueExecutionWorkspaceBindings.sessionId, ref.sessionId),
          eq(issueExecutionWorkspaceBindings.ownershipEpoch, ref.ownershipEpoch),
        ),
      )
      .limit(2)
      .for("share"),
    "execution ref lost its exact workspace binding",
  );
  const baseRunInput = {
    companyId: ref.companyId,
    issueId: ref.issueId,
    sessionId: ref.sessionId,
    executionScopeId: ref.executionScopeId,
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    executionWorkspaceBindingId: workspace.id,
    orderedRefIds: refs.map((candidate) => candidate.id),
    retryOfRunId: exactRetry?.retryOfRunId ?? null,
    at,
  };
  const created = ref.mode === "owner"
    ? await options.runService.createRun(transaction, {
        kind: "productive",
        ...baseRunInput,
        issueExecutionAuthorityId: ref.issueExecutionAuthorityId!,
      })
    : await (async () => {
        const { sourceRunId } = exactlyOne(
          await transaction
            .select({ sourceRunId: issueConsultExecutions.sourceRunId })
            .from(issueConsultExecutions)
            .where(eq(issueConsultExecutions.id, ref.consultExecutionId!))
            .limit(2)
            .for("share"),
          "consult ref lost its parent run",
        );
        return options.runService.createRun(transaction, {
          kind: "consult",
          ...baseRunInput,
          consultExecutionId: ref.consultExecutionId!,
          parentRunId: sourceRunId,
        });
      })();
  exactlyOne(
    await transaction
      .update(issueExecutionRunControls)
      .set({
        currentRefId: refs[0]!.id,
        currentOrdinal: 0,
        currentSegmentOrdinal: 0,
      })
      .where(
        and(
          eq(issueExecutionRunControls.runId, created.run.runId),
          isNull(issueExecutionRunControls.currentRefId),
          isNull(issueExecutionRunControls.currentOrdinal),
          isNull(issueExecutionRunControls.currentSegmentOrdinal),
        ),
      )
      .returning({ runId: issueExecutionRunControls.runId }),
    "new run could not bind its first prompt",
  );
  if (exactRetry) {
    exactlyOne(
      await transaction
        .insert(issueExecutionAttempts)
        .values({
          id: options.idFactory?.() ?? randomUUID(),
          companyId: created.run.companyId,
          issueId: created.run.issueId,
          sessionId: created.run.sessionId,
          runId: created.run.runId,
          runKind: created.run.kind,
          promptKind: "base",
          sessionOperation: exactRetry.sessionOperation,
          refId: ref.id,
          refOrdinal: 0,
          segmentOrdinal: 0,
          steeringSegmentOrdinal: null,
          attemptGeneration: 1,
          state: "pending",
          startedAt: null,
          finishedAt: null,
          createdAt: at,
        })
        .returning({ id: issueExecutionAttempts.id }),
      "released-run retry could not freeze its pending successor attempt",
    );
  }
  const admission = createIssueSessionAdmissionService(options.database);
  await admission.appendNonDispatchSyntheticComment({
    companyId: ref.companyId,
    issueId: ref.issueId,
    sessionId: ref.sessionId,
    sourceKind: "issue_execution_run_progress",
    immutableSourceKey: `run-progress:${created.run.runId}`,
    sourceRecordId: created.run.runId,
    exactText: "",
    projectionKind: "run_progress",
    ownershipEpoch: ref.ownershipEpoch,
    agentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    runId: created.run.runId,
    comment: {
      author: { kind: "agent", agentId: ref.targetAgentId },
      producingRun: {
        runId: created.run.runId,
        adapterConfigRevisionId: ref.adapterConfigRevisionId,
      },
      replyToCommentId: null,
      steeringSegment: null,
    },
  }, transaction);
  const run = await options.runService.lockRun(transaction, {
    companyId: created.run.companyId,
    issueId: created.run.issueId,
    runId: created.run.runId,
  });
  return { run, refs };
}

async function releaseAttempt(
  transaction: IssueSessionDbTransaction,
  options: PostgresIssueExecutionDispatcherRepositoryOptions,
  lease: LeasedIssueExecutionRef,
  state: "settled" | "failed" | "cancelled",
  at: Date,
  detach: boolean,
): Promise<void> {
  exactlyOne(
    await transaction
      .update(issueExecutionAttempts)
      .set({ state, finishedAt: at })
      .where(
        and(
          eq(issueExecutionAttempts.id, lease.attemptId),
          eq(issueExecutionAttempts.runId, lease.runId),
          eq(issueExecutionAttempts.state, "running"),
        ),
      )
      .returning({ id: issueExecutionAttempts.id }),
    "attempt terminalization lost its exact running generation",
  );
  exactlyOne(
    await transaction
      .update(issueExecutionLeases)
      .set({ state: "released", releasedAt: at })
      .where(
        and(
          eq(issueExecutionLeases.id, lease.leaseId),
          eq(issueExecutionLeases.attemptId, lease.attemptId),
          eq(issueExecutionLeases.state, "active"),
        ),
      )
      .returning({ id: issueExecutionLeases.id }),
    "attempt terminalization lost its exact active lease",
  );
  if (detach) {
    await options.runService.detachAttempt(transaction, {
      companyId: lease.ref.companyId,
      issueId: lease.ref.issueId,
      runId: lease.runId,
      expectedAttemptId: lease.attemptId,
      expectedLeaseId: lease.leaseId,
      at,
    });
  }
}

async function settleUnsentSuffix(
  transaction: IssueSessionDbTransaction,
  runId: string,
  afterOrdinal: number,
  at: Date,
  idFactory: () => string,
): Promise<void> {
  const suffix = await transaction
    .select({ refOrdinal: issueExecutionRunRefs.refOrdinal })
    .from(issueExecutionRunRefs)
    .where(
      and(
        eq(issueExecutionRunRefs.runId, runId),
        sql`${issueExecutionRunRefs.refOrdinal} > ${afterOrdinal}`,
        isNull(issueExecutionRunRefs.protocolSettlementState),
      ),
    )
    .orderBy(asc(issueExecutionRunRefs.refOrdinal))
    .for("update");
  for (const member of suffix) {
    exactlyOne(
      await transaction
        .update(issueExecutionRunRefs)
        .set({
          outcome: "released_unsent",
          outcomeReferenceId: idFactory(),
          protocolSettlementState: "not_sent",
          settlementVersion: 1,
          settledAt: at,
        })
        .where(
          and(
            eq(issueExecutionRunRefs.runId, runId),
            eq(issueExecutionRunRefs.refOrdinal, member.refOrdinal),
            isNull(issueExecutionRunRefs.protocolSettlementState),
          ),
        )
        .returning({ runId: issueExecutionRunRefs.runId }),
      "run suffix settlement lost an untouched member",
    );
  }
}

async function loadRecoveredProtocolSettlement(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly run: RunRow;
    readonly owner: PromptOwnerRow;
    readonly segment: SteeringPromptOwnerRow | null;
  },
): Promise<{ readonly reason: string; readonly finalText: string }> {
  if (
    input.owner.protocolSettlementState !== "settled" ||
    input.owner.outcomeReferenceId === null ||
    input.owner.accountingId === null ||
    input.owner.costEventId === null
  ) {
    reject("protocol settlement recovery lost its accounting identity");
  }
  const event = exactlyOne(
    await transaction
      .select()
      .from(issueSessionEvents)
      .where(
        and(
          eq(issueSessionEvents.companyId, input.run.companyId),
          eq(issueSessionEvents.issueId, input.run.issueId),
          eq(issueSessionEvents.sessionId, input.run.sessionId),
          eq(issueSessionEvents.runId, input.run.runId),
          eq(issueSessionEvents.type, "session.next.step.ended.3"),
          eq(issueSessionEvents.sourceKind, "acp_prompt_settlement"),
          eq(issueSessionEvents.sourceId, input.owner.outcomeReferenceId),
          eq(issueSessionEvents.sourceRecordId, input.owner.accountingId),
        ),
      )
      .limit(2)
      .for("update"),
    "protocol settlement recovery lost its exact Step.Ended event",
  );
  const data = event.data as Record<string, unknown>;
  const assistantMessageId = data.assistantMessageID;
  const finish = data.finish;
  if (
    data.sessionID !== input.run.sessionId ||
    typeof assistantMessageId !== "string" ||
    assistantMessageId.length === 0 ||
    (finish !== "end_turn" &&
      finish !== "max_tokens" &&
      finish !== "max_turn_requests" &&
      finish !== "refusal" &&
      finish !== "cancelled") ||
    (finish === "refusal"
      ? input.owner.outcome !== "refused"
      : finish === "cancelled"
        ? input.owner.outcome !== "cancelled"
        : input.owner.outcome !== "succeeded") ||
    (input.segment !== null &&
      input.segment.terminalSessionMessageId !== assistantMessageId)
  ) {
    reject("protocol settlement recovery event crossed its durable owner");
  }
  const messageRow = exactlyOne(
    await transaction
      .select()
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.companyId, input.run.companyId),
          eq(issueSessionMessages.issueId, input.run.issueId),
          eq(issueSessionMessages.sessionId, input.run.sessionId),
          eq(issueSessionMessages.runId, input.run.runId),
          eq(issueSessionMessages.id, assistantMessageId),
          eq(issueSessionMessages.type, "assistant"),
        ),
      )
      .limit(2)
      .for("update"),
    "protocol settlement recovery lost its terminal assistant",
  );
  const message = issueSessionMessageFromRow(messageRow);
  if (message.type !== "assistant" || message.time.completed === undefined) {
    reject("protocol settlement recovery assistant is not terminal");
  }
  return {
    reason: finish,
    finalText: message.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join(""),
  };
}

async function completeTerminalPromptInTransaction(
  transaction: IssueSessionDbTransaction,
  options: PostgresIssueExecutionDispatcherRepositoryOptions,
  input: {
    readonly lease: LeasedIssueExecutionRef;
    readonly attempt: AttemptRow;
    readonly outcome: IssueExecutionTerminal["outcome"];
    readonly reason: string | null;
    readonly at: Date;
    readonly idFactory: () => string;
  },
): Promise<{
  readonly finalization: {
    readonly companyId: string;
    readonly issueId: string;
    readonly runId: string;
    readonly status: IssueExecutionTerminal["outcome"];
    readonly terminalReasonCode: string;
    readonly finishedAt: Date;
  } | null;
  readonly laneReleased: boolean;
  readonly autoCaptureRefId: string | null;
}> {
  if (
    input.attempt.refId !== input.lease.ref.id ||
    input.attempt.refOrdinal !== input.lease.refOrdinal ||
    input.attempt.segmentOrdinal !== input.lease.segmentOrdinal
  ) {
    reject("terminal progression crossed its exact prompt identity");
  }
  exactlyOne(
    await transaction
      .update(issueExecutionRefs)
      .set({ disposition: "terminal", updatedAt: input.at })
      .where(
        and(
          eq(issueExecutionRefs.id, input.lease.ref.id),
          eq(issueExecutionRefs.disposition, "active"),
        ),
      )
      .returning({ id: issueExecutionRefs.id }),
    "terminal progression lost its active execution ref",
  );
  exactlyOne(
    await transaction
      .update(issueExecutionHistoryViews)
      .set({ state: "terminal", finalizedAt: input.at, updatedAt: input.at })
      .where(
        and(
          eq(issueExecutionHistoryViews.id, input.lease.ref.historyViewId),
          inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: issueExecutionHistoryViews.id }),
    "terminal progression lost its active history view",
  );
  if (input.outcome === "succeeded") {
    const next = await transaction
      .select({
        refId: issueExecutionRunRefs.refId,
        refOrdinal: issueExecutionRunRefs.refOrdinal,
      })
      .from(issueExecutionRunRefs)
      .where(
        and(
          eq(issueExecutionRunRefs.runId, input.lease.runId),
          sql`${issueExecutionRunRefs.refOrdinal} > ${input.attempt.refOrdinal!}`,
          isNull(issueExecutionRunRefs.protocolSettlementState),
        ),
      )
      .orderBy(asc(issueExecutionRunRefs.refOrdinal))
      .limit(1)
      .for("update");
    if (next[0]) {
      exactlyOne(
        await transaction
          .update(issueExecutionRunControls)
          .set({
            currentRefId: next[0].refId,
            currentOrdinal: next[0].refOrdinal,
            currentSegmentOrdinal: 0,
          })
          .where(
            and(
              eq(issueExecutionRunControls.runId, input.lease.runId),
              eq(issueExecutionRunControls.currentRefId, input.lease.ref.id),
              eq(
                issueExecutionRunControls.currentOrdinal,
                input.lease.refOrdinal,
              ),
              eq(
                issueExecutionRunControls.currentSegmentOrdinal,
                input.lease.segmentOrdinal,
              ),
            ),
          )
          .returning({ runId: issueExecutionRunControls.runId }),
        "run could not advance to its next immutable member",
      );
      await clearExactLaneClaim(transaction, {
        ref: input.lease.ref,
        laneOrdinal: input.lease.ref.laneOrdinal,
        leaseGeneration: input.lease.leaseGeneration,
        leaseId: input.lease.leaseId,
        at: input.at,
      });
      return { finalization: null, laneReleased: true, autoCaptureRefId: null };
    }
  } else {
    await settleUnsentSuffix(
      transaction,
      input.lease.runId,
      input.attempt.refOrdinal!,
      input.at,
      input.idFactory,
    );
  }
  exactlyOne(
    await transaction
      .update(issueExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
        currentSegmentOrdinal: null,
      })
      .where(
        and(
          eq(issueExecutionRunControls.runId, input.lease.runId),
          eq(issueExecutionRunControls.currentRefId, input.lease.ref.id),
          eq(issueExecutionRunControls.currentOrdinal, input.lease.refOrdinal),
          eq(
            issueExecutionRunControls.currentSegmentOrdinal,
            input.lease.segmentOrdinal,
          ),
        ),
      )
      .returning({ runId: issueExecutionRunControls.runId }),
    "terminal run could not clear its prompt control",
  );
  const finalization = {
    companyId: input.lease.ref.companyId,
    issueId: input.lease.ref.issueId,
    runId: input.lease.runId,
    status: input.outcome,
    terminalReasonCode: (input.reason?.trim() || input.outcome).slice(0, 200),
    finishedAt: input.at,
  } as const;
  const finalized = await options.finalizer.finalizeInTransaction(
    transaction,
    finalization,
  );
  await clearExactLaneClaim(transaction, {
    ref: input.lease.ref,
    laneOrdinal: input.lease.ref.laneOrdinal,
    leaseGeneration: input.lease.leaseGeneration,
    leaseId: input.lease.leaseId,
    at: input.at,
  });
  return {
    finalization,
    laneReleased: true,
    autoCaptureRefId: finalized.autoCaptureRefId,
  };
}

export function createPostgresIssueExecutionDispatcherRepository(
  options: PostgresIssueExecutionDispatcherRepositoryOptions,
): IssueExecutionDispatcherRepository & {
  readonly terminalizeCancelledRun: (input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly runId: string;
    readonly reason: string;
    readonly finishedAt: Date;
  }) => Promise<void>;
  readonly terminalizeDetachedCancelledRunInTransaction: (
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ) => Promise<boolean>;
  readonly fenceRevokedExecutionAuthorityInTransaction: (
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: IssueExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
    },
  ) => Promise<FencedIssueExecutionAuthority>;
} {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000) {
    reject("attempt lease TTL must be at least one second");
  }

  type ExpiredRunRecovery =
    | { readonly kind: "current"; readonly run: RunRow }
    | { readonly kind: "retry_same_run"; readonly run: RunRow }
    | {
        readonly kind: "released_run";
        readonly retryRun: RunRow | null;
        readonly terminal: IssueExecutionTerminal;
      };

  function terminalEventForExpiredRun(
    run: RunRow,
    recovery: ExpiredRunRecovery,
    occurredAt: Date,
  ): AgentRunTerminalPluginEventInput | null {
    if (recovery.kind !== "released_run") return null;
    return {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      agentId: run.targetAgentId,
      outcome: recovery.terminal.outcome,
      reason: recovery.terminal.reason,
      occurredAt,
    };
  }

  async function recoverExpiredRunInTransaction(
    transaction: IssueSessionDbTransaction,
    run: RunRow,
    at: Date,
  ): Promise<ExpiredRunRecovery> {
    if (run.currentAttemptId === null || run.currentLeaseId === null) {
      return { kind: "current", run };
    }
    const cancellation = run.cancellationIntentId === null
      ? null
      : exactlyOne(
          await transaction
            .select()
            .from(issueExecutionCancellationIntents)
            .where(
              eq(
                issueExecutionCancellationIntents.id,
                run.cancellationIntentId,
              ),
            )
            .limit(2)
            .for("update"),
          "expired run lost its attached cancellation intent",
        );
    const steeringCancellation = cancellation?.reasonKind === "steering"
      ? cancellation
      : null;
    const nonSteeringCancellation =
      cancellation !== null && cancellation.reasonKind !== "steering"
        ? cancellation
        : null;
    const control = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionRunControls)
        .where(eq(issueExecutionRunControls.runId, run.runId))
        .limit(2)
        .for("update"),
      "expired run lost its exact prompt control",
    );
    if (
      control.currentRefId === null ||
      control.currentOrdinal === null ||
      control.currentSegmentOrdinal === null
    ) {
      reject("expired run lost its current prompt identity");
    }
    const member = exactlyOne(
      await transaction
        .select({
          row: issueExecutionRunRefs,
          ref: issueExecutionRefs,
        })
        .from(issueExecutionRunRefs)
        .innerJoin(
          issueExecutionRefs,
          eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
        )
        .where(
          and(
            eq(issueExecutionRunRefs.runId, run.runId),
            eq(issueExecutionRunRefs.refId, control.currentRefId),
            eq(issueExecutionRunRefs.refOrdinal, control.currentOrdinal),
          ),
        )
        .limit(2)
        .for("update"),
      "expired run lost its current immutable member",
    );
    const segment = control.currentSegmentOrdinal === 0
      ? null
      : exactlyOne(
          await transaction
            .select()
            .from(issueExecutionPromptSegments)
            .where(
              and(
                eq(issueExecutionPromptSegments.runId, run.runId),
                eq(
                  issueExecutionPromptSegments.refId,
                  control.currentRefId,
                ),
                eq(
                  issueExecutionPromptSegments.refOrdinal,
                  control.currentOrdinal,
                ),
                eq(
                  issueExecutionPromptSegments.segmentOrdinal,
                  control.currentSegmentOrdinal,
                ),
              ),
            )
            .limit(2)
            .for("update"),
          "expired run lost its current steering segment",
        );
    const attempt = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionAttempts)
        .where(eq(issueExecutionAttempts.id, run.currentAttemptId))
        .limit(2)
        .for("update"),
      "expired run lost its exact attempt",
    );
    const promptOwner = segment ?? member.row;
    const promptOwnerIsUnbound = promptOwner.attemptId === null &&
      promptOwner.capabilityConnectionId === null &&
      promptOwner.capabilityGeneration === null;
    const promptOwnerHasBoundShape = promptOwner.attemptId === attempt.id &&
      promptOwner.capabilityConnectionId !== null &&
      promptOwner.capabilityGeneration !== null;
    const lease = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionLeases)
        .where(eq(issueExecutionLeases.id, run.currentLeaseId))
        .limit(2)
        .for("update"),
      "expired run lost its exact lease",
    );
    if (lease.state !== "active" || lease.expiresAt > at) {
      return { kind: "current", run };
    }
    const pendingSteeringSegment = steeringCancellation === null
      ? null
      : exactlyOne(
          await transaction
            .select()
            .from(issueExecutionPromptSegments)
            .where(
              and(
                eq(issueExecutionPromptSegments.runId, run.runId),
                eq(issueExecutionPromptSegments.refId, control.currentRefId),
                eq(
                  issueExecutionPromptSegments.refOrdinal,
                  control.currentOrdinal,
                ),
                eq(
                  issueExecutionPromptSegments.segmentOrdinal,
                  control.currentSegmentOrdinal + 1,
                ),
                eq(
                  issueExecutionPromptSegments.cancellationIntentId,
                  steeringCancellation.id,
                ),
              ),
            )
            .limit(2)
            .for("update"),
          "expired steering cancellation lost its positive segment",
        );
    if (
      attempt.companyId !== run.companyId ||
      attempt.issueId !== run.issueId ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== run.runId ||
      attempt.runKind !== run.kind ||
      attempt.refId !== control.currentRefId ||
      attempt.refOrdinal !== control.currentOrdinal ||
      attempt.segmentOrdinal !== control.currentSegmentOrdinal ||
      attempt.state !== "running" ||
      lease.companyId !== run.companyId ||
      lease.issueId !== run.issueId ||
      lease.runId !== run.runId ||
      lease.attemptId !== attempt.id ||
      (cancellation !== null &&
        (cancellation.companyId !== run.companyId ||
          cancellation.issueId !== run.issueId ||
          cancellation.runId !== run.runId ||
          cancellation.attemptId !== attempt.id ||
          cancellation.leaseId !== lease.id ||
          (cancellation.state !== "requested" &&
            cancellation.state !== "acknowledged"))) ||
      (steeringCancellation !== null &&
        (
          pendingSteeringSegment === null ||
          pendingSteeringSegment.protocolSettlementState !== null ||
          (pendingSteeringSegment.steeringState !== "requested" &&
            pendingSteeringSegment.steeringState !== "sent"))) ||
      member.ref.companyId !== run.companyId ||
      member.ref.issueId !== run.issueId ||
      member.ref.sessionId !== run.sessionId ||
      member.ref.ownershipEpoch !== run.ownershipEpoch ||
      member.ref.targetAgentId !== run.targetAgentId ||
      member.ref.mode !== run.executionMode ||
      (run.executionMode === "owner"
        ? run.kind !== "productive" ||
          member.ref.issueExecutionAuthorityId === null ||
          run.issueExecutionAuthorityId !==
            member.ref.issueExecutionAuthorityId ||
          run.consultExecutionId !== null
        : run.kind !== "consult" ||
          member.ref.issueExecutionAuthorityId !== null ||
          member.ref.consultExecutionId === null ||
          run.issueExecutionAuthorityId !== null ||
          run.consultExecutionId !== member.ref.consultExecutionId) ||
      member.row.admissionOrder !== member.ref.laneOrdinal ||
      (segment === null) !== (attempt.promptKind === "base") ||
      (segment !== null && attempt.promptKind !== "steering") ||
      (!promptOwnerIsUnbound && !promptOwnerHasBoundShape) ||
      (segment !== null &&
        segment.steeringState !==
          (segment.protocolSettlementState === null
            ? "resumed"
            : "protocol_settled"))
    ) {
      reject("expired authority crossed its canonical prompt identity");
    }
    const nonProtocolPromptOwner = {
      promptKind: attempt.promptKind,
      runId: run.runId,
      refId: member.ref.id,
      refOrdinal: member.row.refOrdinal,
      segmentOrdinal: control.currentSegmentOrdinal,
      attemptId: attempt.id,
    } as const;

    const capabilities = await transaction
      .select()
      .from(issueExecutionPromptCapabilities)
      .where(
        and(
          eq(issueExecutionPromptCapabilities.runId, run.runId),
          eq(issueExecutionPromptCapabilities.attemptId, attempt.id),
          eq(issueExecutionPromptCapabilities.leaseId, lease.id),
          eq(
            issueExecutionPromptCapabilities.leaseGeneration,
            lease.leaseGeneration,
          ),
        ),
      )
      .for("update");
    const ownerCapabilities = promptOwnerIsUnbound
      ? []
      : capabilities.filter(
          (capability) =>
            capability.capabilityConnectionId ===
              promptOwner.capabilityConnectionId &&
            capability.capabilityGeneration ===
              promptOwner.capabilityGeneration,
        );
    if (
      (promptOwnerIsUnbound && capabilities.length !== 0) ||
      (!promptOwnerIsUnbound &&
        (capabilities.length !== 1 || ownerCapabilities.length !== 1))
    ) {
      reject("expired attempt lost its exact prompt capability owner");
    }
    const capability = ownerCapabilities[0] ?? null;
    if (
      capability !== null &&
      (capability.companyId !== run.companyId ||
        capability.issueId !== run.issueId ||
        capability.runId !== run.runId ||
        capability.runBatchDigest !== member.row.batchDigest ||
        capability.refId !== member.ref.id ||
        capability.refOrdinal !== member.row.refOrdinal ||
        capability.segmentOrdinal !== control.currentSegmentOrdinal ||
        capability.attemptId !== attempt.id ||
        capability.leaseId !== lease.id ||
        capability.leaseGeneration !== lease.leaseGeneration ||
        capability.ownershipEpoch !== run.ownershipEpoch ||
        capability.targetAgentId !== run.targetAgentId ||
        capability.laneKind !== run.executionMode ||
        capability.executionMode !== run.executionMode ||
        capability.issueExecutionAuthorityId !==
          run.issueExecutionAuthorityId ||
        capability.consultExecutionId !== run.consultExecutionId ||
        capability.adapterConfigIdentity !== run.adapterConfigRevisionId ||
        capability.workspaceIdentity !== run.executionWorkspaceBindingId)
    ) {
      reject("expired prompt capability crossed its exact run authority");
    }
    // Cancellation reconciliation owns only prompts that never minted an ACPX
    // capability. Once minted, expired-lease recovery must close that exact
    // prompt and cancellation in the same transaction.
    if (nonSteeringCancellation !== null && capability === null) {
      return { kind: "current", run };
    }
    const closureDecision = classifyExpiredPromptClosure({
      owner: promptOwner,
      capability,
    });
    const promptTransmitted =
      promptOwner.promptTransmissionPhase === "transmitted";
    if (steeringCancellation !== null && closureDecision.kind === "retry") {
      reject("steering cancellation cannot own a retry prompt closure");
    }
    const steeringCancellationRecovery = steeringCancellation === null
      ? null
      : closureDecision.kind === "open" && promptTransmitted
        ? "fail_run"
        : "continue_source";
    let consultChainRemainsLive = false;
    if (run.executionMode === "consult") {
      try {
        await lockAndValidateIssueConsultChain(transaction, {
          ref: member.ref,
          requireLiveAncestors: false,
          leafState: "active",
        });
        consultChainRemainsLive = true;
      } catch (error) {
        if (!(error instanceof IssueConsultChainInvalid)) throw error;
      }
    }
    const correlationIds = [
      ...new Set(
        capabilities
          .map((capability) => capability.targetSessionCorrelationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const capabilityAlreadyRevokedForSteering =
      capability?.state === "revoked" &&
      capability.revocationReason === "active_run_steering";
    if (
      steeringCancellation !== null &&
      !capabilityAlreadyRevokedForSteering
    ) {
      reject("expired steering cancellation lost its revoked capability");
    }
    if (
      closureDecision.kind === "open" &&
      !capabilityAlreadyRevokedForSteering
    ) {
      const revoked = await transaction
        .update(issueExecutionPromptCapabilities)
        .set({
          state: "revoked",
          revocationReason: "lease_expired",
          revokedAt: at,
        })
        .where(
          and(
            eq(issueExecutionPromptCapabilities.runId, run.runId),
            eq(issueExecutionPromptCapabilities.attemptId, attempt.id),
            eq(issueExecutionPromptCapabilities.leaseId, lease.id),
            inArray(issueExecutionPromptCapabilities.state, [
              "pending_setup",
              "active",
            ]),
          ),
        )
        .returning({
          capabilityConnectionId:
            issueExecutionPromptCapabilities.capabilityConnectionId,
        });
      if (capability !== null && revoked.length !== 1) {
        reject("expired attempt could not revoke its open prompt capability");
      }
    }
    if (
      (nonSteeringCancellation !== null &&
        closureDecision.kind !== "terminal") ||
      (steeringCancellationRecovery === "continue_source" &&
        closureDecision.kind === "open")
    ) {
      const incomplete = nonSteeringCancellation !== null && promptTransmitted;
      await settleNonProtocolPromptInTransaction(
        transaction,
        nonProtocolPromptOwner,
        incomplete
          ? {
              state: "incomplete",
              outcome: "ambiguous",
              referenceId: idFactory(),
              at,
            }
          : {
              state: "not_sent",
              outcome: "released_unsent",
              referenceId: idFactory(),
              at,
            },
      );
    }
    const attemptTerminalState = nonSteeringCancellation !== null
      ? "cancelled" as const
      : closureDecision.kind === "terminal"
        ? closureDecision.outcome === "succeeded"
          ? "settled" as const
          : closureDecision.outcome === "cancelled"
            ? "cancelled" as const
            : "failed" as const
        : "failed" as const;
    exactlyOne(
      await transaction
        .update(issueExecutionAttempts)
        .set({ state: attemptTerminalState, finishedAt: at })
        .where(
          and(
            eq(issueExecutionAttempts.id, attempt.id),
            eq(issueExecutionAttempts.state, "running"),
          ),
        )
        .returning({ id: issueExecutionAttempts.id }),
      "expired attempt lost its running generation",
    );
    exactlyOne(
      await transaction
        .update(issueExecutionLeases)
        .set({
          state: nonSteeringCancellation === null ? "expired" : "revoked",
          releasedAt: at,
        })
        .where(
          and(
            eq(issueExecutionLeases.id, lease.id),
            eq(issueExecutionLeases.attemptId, attempt.id),
            eq(issueExecutionLeases.leaseGeneration, lease.leaseGeneration),
            eq(issueExecutionLeases.state, "active"),
            lte(issueExecutionLeases.expiresAt, at),
          ),
        )
        .returning({ id: issueExecutionLeases.id }),
      "expired lease lost its exact compare-and-set fence",
    );
    const completeCancellation = async (
      intent: CancellationIntentRow,
    ): Promise<void> => {
      const steering = intent.reasonKind === "steering";
      exactlyOne(
        await transaction
          .update(issueExecutionCancellationIntents)
          .set({
            state: "completed",
            acknowledgedAt: intent.acknowledgedAt ?? at,
            completedAt: at,
          })
          .where(
            and(
              eq(issueExecutionCancellationIntents.id, intent.id),
              eq(issueExecutionCancellationIntents.companyId, run.companyId),
              eq(issueExecutionCancellationIntents.issueId, run.issueId),
              eq(issueExecutionCancellationIntents.runId, run.runId),
              eq(issueExecutionCancellationIntents.attemptId, attempt.id),
              eq(issueExecutionCancellationIntents.leaseId, lease.id),
              steering
                ? eq(issueExecutionCancellationIntents.reasonKind, "steering")
                : ne(issueExecutionCancellationIntents.reasonKind, "steering"),
              inArray(issueExecutionCancellationIntents.state, [
                "requested",
                "acknowledged",
              ]),
              steering
                ? isNull(
                    issueExecutionCancellationIntents.nativeCancellationSettledAt,
                  )
                : undefined,
              isNull(issueExecutionCancellationIntents.completedAt),
              isNull(issueExecutionCancellationIntents.failedAt),
              isNull(issueExecutionCancellationIntents.failureCode),
            ),
          )
          .returning({ id: issueExecutionCancellationIntents.id }),
        steering
          ? "expired transmitted steering orphan could not complete its request"
          : "expired cancellation could not complete its exact intent",
      );
      await options.runService.detachCancellation(transaction, {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
        expectedCancellationIntentId: intent.id,
        at,
      });
    };
    if (steeringCancellationRecovery === "continue_source") {
      // The old prompt is now durably closed and the exact attempt/lease is
      // terminal, but the run attachment and positive segment remain owned by
      // the steering intent. The source continuation performs the sole rebind.
      return { kind: "current", run };
    }
    if (steeringCancellationRecovery === "fail_run") {
      if (cancellation === null || pendingSteeringSegment === null) {
        reject("expired transmitted steering orphan lost its durable request");
      }
      exactlyOne(
        await transaction
          .update(issueExecutionPromptSegments)
          .set({
            steeringState: "protocol_settled",
            outcome: "released_unsent",
            outcomeReferenceId: idFactory(),
            protocolSettlementState: "not_sent",
            settlementVersion: 1,
            settledAt: at,
          })
          .where(
            and(
              eq(
                issueExecutionPromptSegments.companyId,
                pendingSteeringSegment.companyId,
              ),
              eq(
                issueExecutionPromptSegments.issueId,
                pendingSteeringSegment.issueId,
              ),
              eq(issueExecutionPromptSegments.runId, run.runId),
              eq(issueExecutionPromptSegments.refId, member.ref.id),
              eq(
                issueExecutionPromptSegments.refOrdinal,
                member.row.refOrdinal,
              ),
              eq(
                issueExecutionPromptSegments.segmentOrdinal,
                pendingSteeringSegment.segmentOrdinal,
              ),
              eq(
                issueExecutionPromptSegments.cancellationIntentId,
                cancellation.id,
              ),
              inArray(issueExecutionPromptSegments.steeringState, [
                "requested",
                "sent",
              ]),
              eq(
                issueExecutionPromptSegments.promptTransmissionPhase,
                "not_transmitted",
              ),
              isNull(issueExecutionPromptSegments.attemptId),
              isNull(issueExecutionPromptSegments.capabilityConnectionId),
              isNull(issueExecutionPromptSegments.capabilityGeneration),
              isNull(issueExecutionPromptSegments.protocolSettlementState),
            ),
          )
          .returning({ runId: issueExecutionPromptSegments.runId }),
        "expired transmitted steering orphan could not release its request",
      );
    }
    const cancellationToComplete = nonSteeringCancellation ??
      (steeringCancellationRecovery === "fail_run" ? cancellation : null);
    if (cancellationToComplete !== null) {
      await completeCancellation(cancellationToComplete);
    }
    await options.runService.detachAttempt(transaction, {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      expectedAttemptId: attempt.id,
      expectedLeaseId: lease.id,
      at,
    });

    const recoveredLease = leaseProjection(
      [member.ref],
      run.runId,
      attempt,
      lease.id,
      lease.leaseGeneration,
    );
    const abandonedConsult = run.executionMode === "consult" &&
      !consultChainRemainsLive;
    const revokeAbandonedConsult = async () => {
      if (!abandonedConsult || member.ref.consultExecutionId === null) return;
      exactlyOne(
        await transaction
          .update(issueConsultExecutions)
          .set({
            state: "revoked",
            closeReason: "worker_loss_chain_not_live",
            closedAt: at,
          })
          .where(
            and(
              eq(issueConsultExecutions.id, member.ref.consultExecutionId),
              eq(issueConsultExecutions.state, "active"),
            ),
          )
          .returning({ id: issueConsultExecutions.id }),
        "abandoned consult recovery lost its active execution",
      );
    };

    if (
      nonSteeringCancellation === null &&
      closureDecision.kind === "retry"
    ) {
      if (abandonedConsult) {
        await settleNonProtocolPromptInTransaction(
          transaction,
          nonProtocolPromptOwner,
          {
            state: "not_sent",
            outcome: "released_unsent",
            referenceId: idFactory(),
            at,
          },
        );
        await revokeAbandonedConsult();
        const terminal = {
          kind: "terminal" as const,
          outcome: "failed" as const,
          reason: "worker_loss_chain_not_live",
          finalText: null,
        };
        const completed = await completeTerminalPromptInTransaction(
          transaction,
          options,
          {
            lease: recoveredLease,
            attempt,
            outcome: terminal.outcome,
            reason: terminal.reason,
            at,
            idFactory,
          },
        );
        if (!completed.finalization) {
          reject("abandoned consult unexpectedly retained a batch successor");
        }
        return {
          kind: "released_run",
          retryRun: null,
          terminal,
        };
      }
      await scheduleIssueExecutionAttemptRetryInTransaction(transaction, {
        id: idFactory(),
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
        predecessorAttemptId: attempt.id,
        reasonCode: closureDecision.reason,
        retryAt: closureDecision.retryAt,
        at,
      });
      return {
        kind: "retry_same_run",
        run: await options.runService.lockRun(transaction, {
          companyId: run.companyId,
          issueId: run.issueId,
          runId: run.runId,
        }),
      };
    }

    if (
      nonSteeringCancellation === null &&
      closureDecision.kind === "terminal"
    ) {
      const protocol = closureDecision.protocolSettled
        ? await loadRecoveredProtocolSettlement(transaction, {
            run,
            owner: promptOwner,
            segment,
          })
        : null;
      const terminal = {
        kind: "terminal" as const,
        outcome: closureDecision.outcome,
        reason: protocol?.reason ?? closureDecision.reason,
        finalText: protocol?.finalText ?? null,
      };
      await revokeAbandonedConsult();
      const completed = await completeTerminalPromptInTransaction(
        transaction,
        options,
        {
          lease: recoveredLease,
          attempt,
          outcome: terminal.outcome,
          reason: terminal.reason,
          at,
          idFactory,
        },
      );
      if (completed.finalization === null) {
        return {
          kind: "retry_same_run",
          run: await options.runService.lockRun(transaction, {
            companyId: run.companyId,
            issueId: run.issueId,
            runId: run.runId,
          }),
        };
      }
      return {
        kind: "released_run",
        retryRun: null,
        terminal,
      };
    }

    if (
      closureDecision.kind !== "terminal" &&
      correlationIds.length > 0
    ) {
      const correlations = await transaction
        .select({
          id: issueExecutionSessions.id,
          purpose: issueExecutionSessions.purpose,
          state: issueExecutionSessions.state,
        })
        .from(issueExecutionSessions)
        .where(inArray(issueExecutionSessions.id, correlationIds))
        .for("update");
      if (
        correlations.length !== correlationIds.length ||
        correlations.some(
          (correlation) =>
            correlation.state !== "eligible" &&
            correlation.state !== "current",
        )
      ) {
        reject("expired attempt lost its exact activated correlation fence");
      }
      const turn = await resolveRuntimeToolTurn(
        transaction as unknown as Db,
        {
          companyId: run.companyId,
          issueId: run.issueId,
          ownershipEpoch: run.ownershipEpoch,
          targetAgentId: run.targetAgentId,
          executionMode: run.executionMode,
          issueExecutionAuthorityId: run.issueExecutionAuthorityId,
          consultExecutionId: run.consultExecutionId,
          refId: member.ref.id,
        },
      );
      const preserveCorrelation =
        preserveCorrelationAfterNonProtocolClosure({
          turn,
          carryContext: correlations.every(
            (correlation) => correlation.purpose === "carry",
          ),
        });
      if (!preserveCorrelation) {
        const superseded = await transaction
          .update(issueExecutionSessions)
          .set({
            state: "superseded",
            supersessionReason: promptTransmitted
              ? "prompt_failed_incomplete"
              : "lease_expired_before_prompt",
            supersededAt: at,
          })
          .where(
            and(
              inArray(issueExecutionSessions.id, correlationIds),
              inArray(issueExecutionSessions.state, ["eligible", "current"]),
            ),
          )
          .returning({ id: issueExecutionSessions.id });
        if (superseded.length !== correlationIds.length) {
          reject("expired attempt lost its exact activated correlation fence");
        }
      }
    }
    if (nonSteeringCancellation !== null) {
      await revokeAbandonedConsult();
      const cancellationReason =
        `${nonSteeringCancellation.reasonKind}_cancellation`;
      const completed = await completeTerminalPromptInTransaction(
        transaction,
        options,
        {
          lease: recoveredLease,
          attempt,
          outcome: "cancelled",
          reason: cancellationReason,
          at,
          idFactory,
        },
      );
      if (completed.finalization === null) {
        reject("expired cancellation unexpectedly retained a batch successor");
      }
      return {
        kind: "released_run",
        retryRun: null,
        terminal: {
          kind: "terminal",
          outcome: "cancelled",
          reason: cancellationReason,
          finalText: null,
        },
      };
    }
    if (
      !promptTransmitted &&
      attempt.promptKind === "steering" &&
      segment !== null
    ) {
      exactlyOne(
        await transaction
          .update(issueExecutionPromptSegments)
          .set({
            attemptId: null,
            capabilityConnectionId: null,
            capabilityGeneration: null,
          })
          .where(
            and(
              eq(issueExecutionPromptSegments.runId, run.runId),
              eq(issueExecutionPromptSegments.refId, member.ref.id),
              eq(
                issueExecutionPromptSegments.refOrdinal,
                member.row.refOrdinal,
              ),
              eq(
                issueExecutionPromptSegments.segmentOrdinal,
                segment.segmentOrdinal,
              ),
              isNull(issueExecutionPromptSegments.protocolSettlementState),
              promptOwnerIsUnbound
                ? and(
                    isNull(issueExecutionPromptSegments.attemptId),
                    isNull(
                      issueExecutionPromptSegments.capabilityConnectionId,
                    ),
                    isNull(issueExecutionPromptSegments.capabilityGeneration),
                  )
                : and(
                    eq(issueExecutionPromptSegments.attemptId, attempt.id),
                    eq(
                      issueExecutionPromptSegments.capabilityConnectionId,
                      promptOwner.capabilityConnectionId!,
                    ),
                    eq(
                      issueExecutionPromptSegments.capabilityGeneration,
                      promptOwner.capabilityGeneration!,
                    ),
                  ),
            ),
          )
          .returning({ runId: issueExecutionPromptSegments.runId }),
        "expired steering attempt could not clear its old prompt ownership",
      );
      const generationRows = await transaction
        .select({ generation: issueExecutionAttempts.attemptGeneration })
        .from(issueExecutionAttempts)
        .where(
          and(
            eq(issueExecutionAttempts.runId, attempt.runId),
            eq(issueExecutionAttempts.refId, attempt.refId!),
            eq(issueExecutionAttempts.refOrdinal, attempt.refOrdinal!),
            eq(issueExecutionAttempts.segmentOrdinal, attempt.segmentOrdinal!),
          ),
        )
        .orderBy(desc(issueExecutionAttempts.attemptGeneration))
        .limit(1)
        .for("update");
      exactlyOne(
        await transaction
          .insert(issueExecutionAttempts)
          .values({
            id: idFactory(),
            companyId: attempt.companyId,
            issueId: attempt.issueId,
            sessionId: attempt.sessionId,
            runId: attempt.runId,
            runKind: attempt.runKind,
            promptKind: attempt.promptKind,
            sessionOperation: attempt.sessionOperation,
            refId: attempt.refId,
            refOrdinal: attempt.refOrdinal,
            segmentOrdinal: attempt.segmentOrdinal,
            steeringSegmentOrdinal: attempt.steeringSegmentOrdinal,
            attemptGeneration: (generationRows[0]?.generation ?? 0) + 1,
            state: "pending",
            startedAt: null,
            finishedAt: null,
            createdAt: at,
          })
          .returning({ id: issueExecutionAttempts.id }),
        "expired steering attempt could not create its successor generation",
      );
      return {
        kind: "retry_same_run",
        run: await options.runService.lockRun(transaction, {
          companyId: run.companyId,
          issueId: run.issueId,
          runId: run.runId,
        }),
      };
    }

    let exactReleasedRetryRefs: readonly RefRow[] = Object.freeze([]);
    if (promptTransmitted) {
      await settleNonProtocolPromptInTransaction(
        transaction,
        nonProtocolPromptOwner,
        {
          state: "incomplete",
          outcome: "ambiguous",
          referenceId: idFactory(),
          at,
        },
      );
      await transaction
        .update(issueExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(
          and(
            eq(issueExecutionRefs.id, member.ref.id),
            eq(issueExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(issueExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            eq(issueExecutionHistoryViews.id, member.ref.historyViewId),
            inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
          ),
        );
      await settleUnsentSuffix(
        transaction,
        run.runId,
        member.row.refOrdinal,
        at,
        idFactory,
      );
    } else {
      const unsettled = await transaction
        .select({
          row: issueExecutionRunRefs,
          ref: issueExecutionRefs,
        })
        .from(issueExecutionRunRefs)
        .innerJoin(
          issueExecutionRefs,
          eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
        )
        .where(
          and(
            eq(issueExecutionRunRefs.runId, run.runId),
            gte(issueExecutionRunRefs.refOrdinal, member.row.refOrdinal),
          ),
        )
        .orderBy(asc(issueExecutionRunRefs.refOrdinal))
        .for("update");
      if (
        unsettled.length === 0 ||
        unsettled[0]!.ref.id !== member.ref.id ||
        unsettled[0]!.row.refOrdinal !== member.row.refOrdinal ||
        unsettled.some(
          (candidate, index) =>
            candidate.row.refOrdinal !== member.row.refOrdinal + index ||
            candidate.row.promptTransmissionPhase !== "not_transmitted" ||
            candidate.row.protocolSettlementState !== null,
        )
      ) {
        reject("expired pre-send run lost its exact released frontier");
      }
      for (const candidate of unsettled) {
        exactlyOne(
          await transaction
            .update(issueExecutionRunRefs)
            .set({
              outcome: "released_unsent",
              outcomeReferenceId: idFactory(),
              protocolSettlementState: "not_sent",
              settlementVersion: 1,
              settledAt: at,
            })
            .where(
              and(
                eq(issueExecutionRunRefs.runId, run.runId),
                eq(
                  issueExecutionRunRefs.refOrdinal,
                  candidate.row.refOrdinal,
                ),
                eq(
                  issueExecutionRunRefs.promptTransmissionPhase,
                  "not_transmitted",
                ),
                isNull(issueExecutionRunRefs.protocolSettlementState),
              ),
            )
            .returning({ runId: issueExecutionRunRefs.runId }),
          "expired pre-send run could not release an untouched member",
        );
      }
      if (run.executionMode === "owner" || consultChainRemainsLive) {
        exactReleasedRetryRefs = Object.freeze(
          unsettled.map((candidate) => candidate.ref),
        );
      } else {
        const refIds = unsettled.map((candidate) => candidate.ref.id);
        if (refIds.length > 0) {
          await transaction
            .update(issueExecutionRefs)
            .set({ disposition: "terminal", updatedAt: at })
            .where(
              and(
                inArray(issueExecutionRefs.id, refIds),
                eq(issueExecutionRefs.disposition, "active"),
              ),
            );
          await transaction
            .update(issueExecutionHistoryViews)
            .set({ state: "terminal", finalizedAt: at, updatedAt: at })
            .where(
              and(
                inArray(issueExecutionHistoryViews.refId, refIds),
                inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
              ),
            );
        }
      }
    }

    await revokeAbandonedConsult();

    exactlyOne(
      await transaction
        .update(issueExecutionRunControls)
        .set({
          currentRefId: null,
          currentOrdinal: null,
          currentSegmentOrdinal: null,
        })
        .where(
          and(
            eq(issueExecutionRunControls.runId, run.runId),
            eq(issueExecutionRunControls.currentRefId, member.ref.id),
            eq(
              issueExecutionRunControls.currentOrdinal,
              member.row.refOrdinal,
            ),
            eq(
              issueExecutionRunControls.currentSegmentOrdinal,
              control.currentSegmentOrdinal,
            ),
          ),
        )
        .returning({ runId: issueExecutionRunControls.runId }),
      "expired run could not clear its current prompt control",
    );
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      status: "failed",
      terminalReasonCode: promptTransmitted
        ? "worker_loss_after_prompt"
        : "worker_loss_before_prompt",
      finishedAt: at,
    });
    await clearExactLaneClaim(transaction, {
      ref: member.ref,
      laneOrdinal: member.row.admissionOrder,
      leaseGeneration: lease.leaseGeneration,
      leaseId: lease.id,
      at,
    });
    const retryRun = exactReleasedRetryRefs.length === 0
      ? null
      : (
          await createRunForRef(
            transaction,
            options,
            exactReleasedRetryRefs[0]!,
            at,
            {
              retryOfRunId: run.runId,
              orderedRefs: exactReleasedRetryRefs,
              sessionOperation: attempt.sessionOperation,
            },
          )
        ).run;
    return {
      kind: "released_run",
      retryRun,
      terminal: {
        kind: "terminal",
        outcome: "failed",
        reason: promptTransmitted
          ? "worker_loss_after_prompt"
          : "worker_loss_before_prompt",
        finalText: null,
      },
    };
  }

  type ExistingRunLeaseResult = LeaseForLaneResult | {
    readonly kind: "scheduled";
    readonly retryAt: Date;
  };

  async function leaseExistingRunInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly run: RunRow;
      readonly workerId: string;
      readonly at: Date;
      readonly mode: "owner" | "consult";
    },
  ): Promise<ExistingRunLeaseResult> {
    if (
      input.run.executionMode !== input.mode ||
      input.run.currentAttemptId !== null ||
      input.run.currentLeaseId !== null ||
      input.run.cancellationIntentId !== null
    ) return { kind: "queued" };
    let pendingAttempt: AttemptRow | undefined;
    let run = input.run;
    if (run.status === "scheduled_retry") {
      const scheduleRows = await transaction
        .select()
        .from(issueExecutionAttemptRetrySchedules)
        .where(
          and(
            eq(issueExecutionAttemptRetrySchedules.runId, run.runId),
            eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
          ),
        )
        .orderBy(asc(issueExecutionAttemptRetrySchedules.retryAt))
        .limit(2)
        .for("update");
      const schedule = exactlyOne(
        scheduleRows,
        "scheduled retry lost its exact due-time owner",
      );
      if (schedule.retryAt > input.at) {
        return { kind: "scheduled", retryAt: schedule.retryAt };
      }
      const claimed = await claimIssueExecutionAttemptRetryInTransaction(
        transaction,
        {
          companyId: run.companyId,
          issueId: run.issueId,
          runId: run.runId,
          scheduleId: schedule.id,
          at: input.at,
          successorAttemptId: idFactory(),
          revalidate: async ({ predecessor }) => {
            const ref = exactlyOne(
              await transaction
                .select()
                .from(issueExecutionRefs)
                .where(eq(issueExecutionRefs.id, predecessor.refId!))
                .limit(2),
              "retry lost its immutable ref",
            );
            if (!isIssueExecutionRefDeliveryEligible(ref, "dispatch")) {
              reject("retry ref is no longer delivery-eligible");
            }
          },
        },
      );
      pendingAttempt = claimed.successor;
      run = await options.runService.lockRun(transaction, {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
      });
    }
    if (!pendingAttempt) {
      const pendingRows = await transaction
        .select()
        .from(issueExecutionAttempts)
        .where(
          and(
            eq(issueExecutionAttempts.runId, run.runId),
            eq(issueExecutionAttempts.state, "pending"),
          ),
        )
        .orderBy(desc(issueExecutionAttempts.attemptGeneration))
        .limit(2)
        .for("update");
      if (pendingRows.length > 1) {
        reject("retry has more than one pending successor attempt");
      }
      pendingAttempt = pendingRows[0];
    }
    if (run.status === "queued") {
      await options.runService.transitionRunStatus(transaction, {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
        expectedStatus: "queued",
        status: "running",
        startedAt: run.startedAt ?? input.at,
        at: input.at,
      });
      run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? input.at,
      };
    }
    if (run.status !== "running") return { kind: "queued" };
    const refs = await currentRunRefs(transaction, run.runId);
    const control = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionRunControls)
        .where(eq(issueExecutionRunControls.runId, run.runId))
        .limit(2)
        .for("update"),
      "active run lost its prompt control",
    );
    const current = refs.find((ref) => ref.id === control.currentRefId);
    if (!current) {
      return { kind: "queued" };
    }
    if (!(await consultSourceRunIsFinalized(transaction, current))) {
      return { kind: "queued" };
    }
    const laneClaim = await lockLaneLeaseClaim(transaction, current, {
      existingRun: true,
    });
    if (!laneClaim) return { kind: "queued" };
    await assertRefDispatchable(transaction, current);
    const lease = await createRunningLease(
      transaction,
      {
        runService: options.runService,
        compiler: options.compiler,
        idFactory,
        leaseTtlMs,
      },
      {
        run,
        refs: [current],
        workerId: input.workerId,
        at: input.at,
        laneClaim,
        ...(pendingAttempt ? { pendingAttempt } : {}),
      },
    );
    const leasedRun = await options.runService.lockRun(transaction, {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
    });
    if (
      leasedRun.currentAttemptId !== lease.attemptId ||
      leasedRun.currentLeaseId !== lease.leaseId
    ) {
      reject("leased attempt lost its exact canonical run projection");
    }
    return { kind: "leased", lease, run: leasedRun };
  }

  async function leaseForLane(input: {
    readonly lane: IssueExecutionTargetLaneIdentity;
    readonly workerId: string;
    readonly at: Date;
  }): Promise<LeaseForLaneResult> {
    let recoveredTerminalEvent: AgentRunTerminalPluginEventInput | null = null;
    const result: LeaseForLaneResult = await options.database.transaction(
      async (transaction) => {
      await transaction
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.lane.companyId))
        .limit(1)
        .for("update");
      await lockIssueTreeExecutionGate(
        transaction,
        input.lane.companyId,
        input.lane.issueId,
      );
      const paused = await transaction
        .select({
          active: activeIssueTreePauseHoldExistsSql(
            input.lane.companyId,
            input.lane.issueId,
          ),
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.lane.companyId),
            eq(issues.id, input.lane.issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.active === true);
      if (paused) return { kind: "queued" };
      let existing = await findExistingRunForLane(
        transaction,
        input.lane,
      );
      if (existing) {
        const expiredRun = existing;
        const recovered = await recoverExpiredRunInTransaction(
          transaction,
          expiredRun,
          input.at,
        );
        recoveredTerminalEvent = terminalEventForExpiredRun(
          expiredRun,
          recovered,
          input.at,
        );
        if (recovered.kind === "released_run") {
          existing = recovered.retryRun;
        } else {
          existing = recovered.run;
        }
      }
      if (existing) {
        const leased = await leaseExistingRunInTransaction(transaction, {
          run: existing,
          workerId: input.workerId,
          at: input.at,
          mode: existing.executionMode,
        });
        return leased.kind === "scheduled" ? { kind: "queued" } : leased;
      }

      const occupiedRefIds = await readOccupiedIssueExecutionRefIds(
        transaction,
        {
          companyId: input.lane.companyId,
          issueId: input.lane.issueId,
          sessionId: input.lane.sessionId,
          ownershipEpoch: input.lane.ownershipEpoch,
          targetAgentId: input.lane.targetAgentId,
        },
      );
      const refRows = await transaction
        .select()
        .from(issueExecutionRefs)
        .where(
          and(
            eq(issueExecutionRefs.companyId, input.lane.companyId),
            eq(issueExecutionRefs.issueId, input.lane.issueId),
            eq(issueExecutionRefs.sessionId, input.lane.sessionId),
            eq(
              issueExecutionRefs.ownershipEpoch,
              input.lane.ownershipEpoch,
            ),
            eq(issueExecutionRefs.targetAgentId, input.lane.targetAgentId),
            eq(issueExecutionRefs.disposition, "active"),
            issueExecutionRefDeliveryEligibilitySql("dispatch"),
            occupiedRefIds.length === 0
              ? undefined
              : notInArray(issueExecutionRefs.id, [...occupiedRefIds]),
          ),
        )
        .orderBy(asc(issueExecutionRefs.laneOrdinal))
        .limit(1);
      const ref = refRows[0];
      if (!ref) return { kind: "queued" };
      if (!(await consultSourceRunIsFinalized(transaction, ref))) {
        return { kind: "queued" };
      }
      const laneClaim = await lockLaneLeaseClaim(transaction, ref, {
        existingRun: false,
      });
      if (!laneClaim) return { kind: "queued" };
      const created = await createRunForRef(transaction, options, ref, input.at);
      await options.runService.transitionRunStatus(transaction, {
        companyId: created.run.companyId,
        issueId: created.run.issueId,
        runId: created.run.runId,
        expectedStatus: "queued",
        status: "running",
        startedAt: input.at,
        at: input.at,
      });
      const running = { ...created.run, status: "running" as const, startedAt: input.at };
      const lease = await createRunningLease(transaction, {
        runService: options.runService,
        compiler: options.compiler,
        idFactory,
        leaseTtlMs,
      }, {
        run: running,
        refs: [created.refs[0]!],
        workerId: input.workerId,
        at: input.at,
        laneClaim,
      });
      const leasedRun = await options.runService.lockRun(transaction, {
        companyId: running.companyId,
        issueId: running.issueId,
        runId: running.runId,
      });
      if (
        leasedRun.currentAttemptId !== lease.attemptId ||
        leasedRun.currentLeaseId !== lease.leaseId
      ) {
        reject("new lease lost its exact canonical run projection");
      }
      return { kind: "leased", lease, run: leasedRun };
      },
    );
    if (recoveredTerminalEvent) {
      await publishAgentRunTerminalEvent(
        options.pluginDomainEvents,
        recoveredTerminalEvent,
      );
    }
    return result;
  }

  async function terminalizeDetachedCancelledRunInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ): Promise<boolean> {
    const at = validDate(input.finishedAt, "cancelled run terminal time");
    const laneClaim = await lockRunLaneClaimIfPresent(
      transaction,
      input.runId,
    );
    const run = await options.runService.lockRun(transaction, input);
    if (
      ["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(
        run.status,
      )
    ) {
      return false;
    }
    if (
      run.currentAttemptId !== null ||
      run.currentLeaseId !== null ||
      run.cancellationIntentId !== null
    ) {
      reject("cancelled run still owns an attempt, lease, or cancellation pointer");
    }
    const members = await transaction
      .select({
        refId: issueExecutionRunRefs.refId,
        refOrdinal: issueExecutionRunRefs.refOrdinal,
        promptTransmissionPhase:
          issueExecutionRunRefs.promptTransmissionPhase,
        protocolSettlementState:
          issueExecutionRunRefs.protocolSettlementState,
      })
      .from(issueExecutionRunRefs)
      .where(eq(issueExecutionRunRefs.runId, input.runId))
      .orderBy(asc(issueExecutionRunRefs.refOrdinal))
      .for("update");
    const unsettled = members.filter(
      (member) => member.protocolSettlementState === null,
    );
    const unsettledSegments = await transaction
      .select({
        refOrdinal: issueExecutionPromptSegments.refOrdinal,
        segmentOrdinal: issueExecutionPromptSegments.segmentOrdinal,
        promptTransmissionPhase:
          issueExecutionPromptSegments.promptTransmissionPhase,
      })
      .from(issueExecutionPromptSegments)
      .where(
        and(
          eq(issueExecutionPromptSegments.runId, input.runId),
          isNull(issueExecutionPromptSegments.protocolSettlementState),
        ),
      )
      .orderBy(
        asc(issueExecutionPromptSegments.refOrdinal),
        asc(issueExecutionPromptSegments.segmentOrdinal),
      )
      .for("update");
    if (
      unsettled.some(
        (member) => member.promptTransmissionPhase !== "not_transmitted",
      ) ||
      unsettledSegments.some(
        (segment) => segment.promptTransmissionPhase !== "not_transmitted",
      )
    ) {
      reject("cancelled run cannot release an unsettled transmitted prompt");
    }
    for (const member of unsettled) {
      exactlyOne(
        await transaction
          .update(issueExecutionRunRefs)
          .set({
            outcome: "released_unsent",
            outcomeReferenceId: idFactory(),
            protocolSettlementState: "not_sent",
            settlementVersion: 1,
            settledAt: at,
          })
          .where(
            and(
              eq(issueExecutionRunRefs.runId, input.runId),
              eq(issueExecutionRunRefs.refOrdinal, member.refOrdinal),
              eq(issueExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
              isNull(issueExecutionRunRefs.protocolSettlementState),
            ),
          )
          .returning({ runId: issueExecutionRunRefs.runId }),
        "cancelled run lost an unsettled prompt member",
      );
    }
    for (const segment of unsettledSegments) {
      exactlyOne(
        await transaction
          .update(issueExecutionPromptSegments)
          .set({
            steeringState: "protocol_settled",
            outcome: "released_unsent",
            outcomeReferenceId: idFactory(),
            protocolSettlementState: "not_sent",
            settlementVersion: 1,
            settledAt: at,
          })
          .where(
            and(
              eq(issueExecutionPromptSegments.runId, input.runId),
              eq(
                issueExecutionPromptSegments.refOrdinal,
                segment.refOrdinal,
              ),
              eq(
                issueExecutionPromptSegments.segmentOrdinal,
                segment.segmentOrdinal,
              ),
              eq(
                issueExecutionPromptSegments.promptTransmissionPhase,
                "not_transmitted",
              ),
              isNull(issueExecutionPromptSegments.protocolSettlementState),
            ),
          )
          .returning({ runId: issueExecutionPromptSegments.runId }),
        "cancelled run lost an unsettled steering segment",
      );
    }
    const refIds = [...new Set(members.map((member) => member.refId))];
    if (refIds.length > 0) {
      await transaction
        .update(issueExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(
          and(
            inArray(issueExecutionRefs.id, refIds),
            eq(issueExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(issueExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            inArray(issueExecutionHistoryViews.refId, refIds),
            inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
          ),
        );
    }
    await transaction
      .update(issueExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
        currentSegmentOrdinal: null,
      })
      .where(eq(issueExecutionRunControls.runId, input.runId));
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: input.companyId,
      issueId: input.issueId,
      runId: input.runId,
      status: "cancelled",
      terminalReasonCode: (input.reason.trim() || "cancelled").slice(0, 200),
      finishedAt: at,
    });
    if (laneClaim) {
      await clearExactLaneClaim(transaction, {
        ...laneClaim,
        at,
      });
    }
    return true;
  }

  async function fenceRevokedExecutionAuthorityInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: IssueExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<FencedIssueExecutionAuthority> {
    exactIdentifier(input.companyId, "authority fence company id");
    const at = validDate(input.at, "authority fence time");
    const reason = (input.reason.trim() || "execution_authority_revoked")
      .slice(0, 200);
    const selector = input.selector;
    let budgetIssueIds: readonly string[] = Object.freeze([]);
    if (selector.kind === "agents" || selector.kind === "suspended_agents") {
      for (const agentId of selector.agentIds) {
        exactIdentifier(agentId, "authority fence agent id");
      }
      if (selector.agentIds.length === 0) {
        return Object.freeze({
          refIds: Object.freeze([]),
          correlationIds: Object.freeze([]),
        });
      }
    } else if (selector.kind === "budget_scope") {
      exactIdentifier(selector.scopeId, "budget scope id");
      if (selector.scopeType === "company") {
        if (selector.scopeId !== input.companyId) {
          reject("company budget fence crossed its exact company");
        }
      } else if (selector.scopeType === "agent") {
        const agent = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, selector.scopeId),
            ),
          )
          .limit(2)
          .for("update");
        if (agent.length !== 1) reject("agent budget scope is not canonical");
      } else {
        const project = await transaction
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.companyId, input.companyId),
              eq(projects.id, selector.scopeId),
            ),
          )
          .limit(2)
          .for("update");
        if (project.length !== 1) reject("project budget scope is not canonical");
        budgetIssueIds = Object.freeze(
          (await transaction
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, input.companyId),
                eq(issues.projectId, selector.scopeId),
              ),
            )).map((issue) => issue.id),
        );
      }
    } else {
      exactIdentifier(selector.issueId, "authority fence issue id");
      if (selector.kind === "ownership_epoch") {
        if (
          !Number.isSafeInteger(selector.ownershipEpoch) ||
          selector.ownershipEpoch < 1
        ) {
          reject("authority fence ownership epoch must be positive");
        }
      } else {
        for (const refId of selector.refIds) {
          exactIdentifier(refId, "authority fence ref id");
        }
        if (selector.refIds.length === 0) {
          return Object.freeze({
            refIds: Object.freeze([]),
            correlationIds: Object.freeze([]),
          });
        }
      }
    }

    const refPredicate = selector.kind === "agents" ||
        selector.kind === "suspended_agents"
      ? inArray(issueExecutionRefs.targetAgentId, [...selector.agentIds])
      : selector.kind === "budget_scope"
        ? selector.scopeType === "company"
          ? sql<boolean>`true`
          : selector.scopeType === "agent"
            ? eq(issueExecutionRefs.targetAgentId, selector.scopeId)
            : budgetIssueIds.length === 0
              ? sql<boolean>`false`
              : inArray(issueExecutionRefs.issueId, [...budgetIssueIds])
      : selector.kind === "ownership_epoch"
        ? and(
            eq(issueExecutionRefs.issueId, selector.issueId),
            eq(issueExecutionRefs.ownershipEpoch, selector.ownershipEpoch),
          )
        : and(
            eq(issueExecutionRefs.issueId, selector.issueId),
            inArray(issueExecutionRefs.id, [...selector.refIds]),
          );
    const occupiedRefIds = await readOccupiedIssueExecutionRefIds(
      transaction,
      { companyId: input.companyId },
    );
    const refs = await transaction
      .select({
        id: issueExecutionRefs.id,
        companyId: issueExecutionRefs.companyId,
        issueId: issueExecutionRefs.issueId,
        ownershipEpoch: issueExecutionRefs.ownershipEpoch,
        targetAgentId: issueExecutionRefs.targetAgentId,
        laneOrdinal: issueExecutionRefs.laneOrdinal,
      })
      .from(issueExecutionRefs)
      .where(
        and(
          eq(issueExecutionRefs.companyId, input.companyId),
          eq(issueExecutionRefs.disposition, "active"),
          refPredicate,
          occupiedRefIds.length === 0
            ? undefined
            : notInArray(issueExecutionRefs.id, [...occupiedRefIds]),
        ),
      )
      .orderBy(asc(issueExecutionRefs.createdAt), asc(issueExecutionRefs.id))
      .for("update");
    const refIds = refs.map((ref) => ref.id);
    if (refIds.length > 0) {
      await transaction
        .update(issueExecutionRefs)
        .set({
          disposition: "invalidated",
          invalidationReason: reason,
          updatedAt: at,
        })
        .where(
          and(
            inArray(issueExecutionRefs.id, refIds),
            eq(issueExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(issueExecutionHistoryViews)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            inArray(issueExecutionHistoryViews.refId, refIds),
            inArray(issueExecutionHistoryViews.state, [
              "empty",
              "preparing",
              "current",
            ]),
          ),
        );
      await transaction
        .update(issueSessionInputDispositions)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          invalidatedBySourceKind: "issue_execution_authority_revocation",
          invalidatedBySourceId: reason,
        })
        .where(
          and(
            inArray(issueSessionInputDispositions.sourceRefId, refIds),
            eq(issueSessionInputDispositions.state, "active"),
          ),
        );
    }

    const correlationPredicate = selector.kind === "agents" ||
        selector.kind === "suspended_agents"
      ? inArray(issueExecutionSessions.targetAgentId, [...selector.agentIds])
      : selector.kind === "budget_scope"
        ? selector.scopeType === "company"
          ? sql<boolean>`true`
          : selector.scopeType === "agent"
            ? eq(issueExecutionSessions.targetAgentId, selector.scopeId)
            : budgetIssueIds.length === 0
              ? sql<boolean>`false`
              : inArray(issueExecutionSessions.issueId, [...budgetIssueIds])
      : selector.kind === "ownership_epoch"
        ? and(
            eq(issueExecutionSessions.issueId, selector.issueId),
            eq(issueExecutionSessions.ownershipEpoch, selector.ownershipEpoch),
          )
        : and(
            eq(issueExecutionSessions.issueId, selector.issueId),
            inArray(issueExecutionSessions.currentRefId, [...selector.refIds]),
          );
    const correlations = await transaction
      .update(issueExecutionSessions)
      .set({
        state: "superseded",
        supersessionReason: reason,
        supersededAt: at,
      })
      .where(
        and(
          eq(issueExecutionSessions.companyId, input.companyId),
          inArray(issueExecutionSessions.state, ["eligible", "current"]),
          correlationPredicate,
        ),
      )
      .returning({ id: issueExecutionSessions.id });

    return Object.freeze({
      refIds: Object.freeze(refIds),
      correlationIds: Object.freeze(correlations.map((row) => row.id)),
    });
  }

  const repository = {
    async recoverExpiredLeases(input: { now: Date; limit: number }) {
      const at = validDate(input.now, "expired lease recovery time");
      const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit)));
      const candidates = await options.database
        .select({
          leaseId: issueExecutionLeases.id,
          runId: issueExecutionLeases.runId,
          ref: issueExecutionRefs,
        })
        .from(issueExecutionLeases)
        .innerJoin(
          issueExecutionAttempts,
          eq(issueExecutionAttempts.id, issueExecutionLeases.attemptId),
        )
        .innerJoin(
          issueExecutionRefs,
          eq(issueExecutionRefs.id, issueExecutionAttempts.refId),
        )
        .where(
          and(
            eq(issueExecutionLeases.state, "active"),
            lte(issueExecutionLeases.expiresAt, at),
            eq(issueExecutionAttempts.state, "running"),
            inArray(issueExecutionAttempts.runKind, ["productive", "consult"]),
          ),
        )
        .orderBy(
          sql`case when ${issueExecutionAttempts.runKind} = 'productive' then 0 else 1 end`,
          asc(issueExecutionLeases.expiresAt),
          asc(issueExecutionLeases.id),
        )
        .limit(limit);
      const refIds: string[] = [];
      for (const candidate of candidates) {
        let recoveredTerminalEvent: AgentRunTerminalPluginEventInput | null = null;
        const recovered = await options.database.transaction(
          async (transaction) => {
            const run = await findExistingRunForLane(
              transaction,
              targetLaneIdentity(candidate.ref),
            );
            if (
              !run ||
              run.runId !== candidate.runId ||
              run.currentLeaseId !== candidate.leaseId
            ) return null;
            const result = await recoverExpiredRunInTransaction(
              transaction,
              run,
              at,
            );
            recoveredTerminalEvent = terminalEventForExpiredRun(
              run,
              result,
              at,
            );
            if (result.kind === "current") return null;
            const next = await transaction
              .select()
              .from(issueExecutionRefs)
              .where(
                and(
                  eq(issueExecutionRefs.companyId, candidate.ref.companyId),
                  eq(issueExecutionRefs.issueId, candidate.ref.issueId),
                  eq(
                    issueExecutionRefs.ownershipEpoch,
                    candidate.ref.ownershipEpoch,
                  ),
                  eq(
                    issueExecutionRefs.targetAgentId,
                    candidate.ref.targetAgentId,
                  ),
                  eq(issueExecutionRefs.disposition, "active"),
                ),
              )
              .orderBy(asc(issueExecutionRefs.laneOrdinal), asc(issueExecutionRefs.id))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            return next && await consultSourceRunIsFinalized(transaction, next)
              ? next.id
              : null;
          },
        );
        if (recoveredTerminalEvent) {
          await publishAgentRunTerminalEvent(
            options.pluginDomainEvents,
            recoveredTerminalEvent,
          );
        }
        if (recovered) refIds.push(recovered);
      }
      return { refIds: [...new Set(refIds)] };
    },

    async listDispatchableRefIds(input: { now: Date; limit: number }) {
      validDate(input.now, "dispatch discovery time");
      const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit)));
      const blockedRefIds = await readBlockedActiveIssueExecutionRefIds(
        options.database,
        { now: input.now },
      );
      const rows = await options.database
        .select({ id: issueExecutionRefs.id })
        .from(issueExecutionRefs)
        .innerJoin(issueExecutionHistoryViews, eq(issueExecutionHistoryViews.id, issueExecutionRefs.historyViewId))
        .innerJoin(issueSessions, eq(issueSessions.id, issueExecutionRefs.sessionId))
        .innerJoin(issues, eq(issues.id, issueExecutionRefs.issueId))
        .innerJoin(companies, eq(companies.id, issueExecutionRefs.companyId))
        .where(
          and(
            eq(issueExecutionRefs.disposition, "active"),
            issueExecutionRefDeliveryEligibilitySql("dispatch"),
            inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
            eq(issueSessions.integrityState, "ready"),
            isNotNull(issueSessions.refAdmittableAt),
            isNull(issueSessions.timeArchived),
            isNull(issueSessions.purgeFencedAt),
            eq(companies.status, "active"),
            eq(companies.sessionIntegrityState, "ready"),
            inArray(issues.lifecycleStatus, ["open", "blocked"]),
            sql`${issues.ownershipEpoch} = ${issueExecutionRefs.ownershipEpoch}`,
            or(
              and(
                eq(issueExecutionRefs.mode, "owner"),
                eq(issues.ownerKind, "agent"),
                sql`${issues.ownerAgentId} = ${issueExecutionRefs.targetAgentId}`,
                isNotNull(issueExecutionRefs.issueExecutionAuthorityId),
              ),
              and(
                eq(issueExecutionRefs.mode, "consult"),
                isNull(issueExecutionRefs.issueExecutionAuthorityId),
                isNotNull(issueExecutionRefs.consultExecutionId),
                sql`exists (
                  select 1
                  from ${issueConsultExecutions}
                  where ${issueConsultExecutions.id} = ${issueExecutionRefs.consultExecutionId}
                    and ${issueConsultExecutions.companyId} = ${issueExecutionRefs.companyId}
                    and ${issueConsultExecutions.issueId} = ${issueExecutionRefs.issueId}
                    and ${issueConsultExecutions.state} = 'active'
                    and ${terminalFinalizedIssueExecutionRunExistsSql(
                      issueConsultExecutions.companyId,
                      issueConsultExecutions.issueId,
                      issueConsultExecutions.sourceRunId,
                    )}
                )`,
              ),
            ),
            sql`not exists (
              select 1 from company_session_lifecycle_operations lifecycle
              where lifecycle.company_id = ${issueExecutionRefs.companyId}
                and lifecycle.status in ('fenced','cancelling','purge_ready')
            )`,
            sql`not (${activeIssueTreePauseHoldExistsSql(
              issueExecutionRefs.companyId,
              issueExecutionRefs.issueId,
            )})`,
            blockedRefIds.length === 0
              ? undefined
              : notInArray(issueExecutionRefs.id, [...blockedRefIds]),
          ),
        )
        .orderBy(asc(issueExecutionRefs.createdAt), asc(issueExecutionRefs.id))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    async resolveLaneForPersistedRef(refId: string) {
      exactIdentifier(refId, "execution ref id");
      const ref = await options.database
        .select({
          companyId: issueExecutionRefs.companyId,
          issueId: issueExecutionRefs.issueId,
          sessionId: issueExecutionRefs.sessionId,
          ownershipEpoch: issueExecutionRefs.ownershipEpoch,
          targetAgentId: issueExecutionRefs.targetAgentId,
          mode: issueExecutionRefs.mode,
          disposition: issueExecutionRefs.disposition,
        })
        .from(issueExecutionRefs)
        .where(eq(issueExecutionRefs.id, refId))
        .limit(2);
      if (ref.length > 1) reject("execution ref identity is ambiguous");
      if (!ref[0]) return null;
      const active = await readActiveIssueExecutionRefRunAvailability(
        options.database,
        { refId },
      );
      const settled = active === null
        ? await options.database
            .select({ outcome: issueExecutionRunRefs.outcome })
            .from(issueExecutionRunRefs)
            .where(
              and(
                eq(issueExecutionRunRefs.refId, refId),
                isNotNull(issueExecutionRunRefs.protocolSettlementState),
              ),
            )
            .orderBy(desc(issueExecutionRunRefs.settledAt))
            .limit(1)
        : [];
      const leaseState = active
        ? active.run.status === "scheduled_retry"
          ? "retryable" as const
          : active.run.currentLeaseId
            ? "leased" as const
            : "available" as const
        : settled[0]
          ? settled[0].outcome === "succeeded" ? "completed" as const : "failed" as const
          : "available" as const;
      return {
        lane: targetLaneIdentity(ref[0]),
        mode: ref[0].mode,
        disposition: ref[0].disposition,
        leaseState,
        leaseExpiresAt: active?.leaseExpiresAt ?? active?.retryAt ?? null,
      };
    },

    async leaseNextRef(input: {
      lane: IssueExecutionTargetLaneIdentity;
      workerId: string;
      now: Date;
    }) {
      const result = await leaseForLane({
        lane: input.lane,
        workerId: input.workerId,
        at: validDate(input.now, "lease time"),
      });
      return result.kind === "leased" ? result.lease : null;
    },

    async assertLeaseCurrent(lease: LeasedIssueExecutionRef) {
      const [row, laneRows] = await Promise.all([
        readIssueExecutionLeaseBinding(options.database, {
          companyId: lease.ref.companyId,
          issueId: lease.ref.issueId,
          runId: lease.runId,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
        }),
        options.database
          .select({
            activeOrdinal: issueExecutionLanes.activeOrdinal,
            activeLeaseGeneration:
              issueExecutionLanes.activeLeaseGeneration,
            activeLeaseId: issueExecutionLanes.activeLeaseId,
            laneOrdinal: issueExecutionRefs.laneOrdinal,
          })
          .from(issueExecutionRefs)
          .innerJoin(
            issueExecutionLanes,
            and(
              eq(
                issueExecutionLanes.companyId,
                issueExecutionRefs.companyId,
              ),
              eq(issueExecutionLanes.issueId, issueExecutionRefs.issueId),
              eq(
                issueExecutionLanes.ownershipEpoch,
                issueExecutionRefs.ownershipEpoch,
              ),
              eq(
                issueExecutionLanes.targetAgentId,
                issueExecutionRefs.targetAgentId,
              ),
            ),
          )
          .where(eq(issueExecutionRefs.id, lease.ref.id))
          .limit(2),
      ]);
      if (!row) reject("attempt lease is no longer resolvable");
      const lane = exactlyOne(
        laneRows,
        "attempt lease lost its exact execution lane",
      );
      if (
        row.run.status !== "running" ||
        row.run.currentAttemptId !== lease.attemptId ||
        row.run.currentLeaseId !== lease.leaseId ||
        row.attemptState !== "running" ||
        row.leaseState !== "active" ||
        row.leaseGeneration !== lease.leaseGeneration ||
        row.leaseExpiresAt <= now() ||
        row.currentRefId !== lease.ref.id ||
        lane.activeOrdinal !== lane.laneOrdinal ||
        lane.activeLeaseGeneration !== lease.leaseGeneration ||
        lane.activeLeaseId !== lease.leaseId
      ) reject("attempt lease is no longer current");
    },

    async markRetryable(input: {
      lease: LeasedIssueExecutionRef;
      reason: IssueExecutionRetry["reason"];
      retryAt: Date;
    }) {
      const at = validDate(now(), "retry settlement time");
      await options.database.transaction(async (transaction) => {
        await lockLaneParents(transaction, input.lease.ref);
        await lockLane(transaction, input.lease.ref);
        const run = await options.runService.lockRun(transaction, input.lease);
        if (run.cancellationIntentId !== null) {
          reject("a cancellation-bound attempt cannot enter retry");
        }
        await assertLeaseLaneClaim(transaction, input.lease, at);
        await releaseAttempt(transaction, options, input.lease, "failed", at, true);
        await scheduleIssueExecutionAttemptRetryInTransaction(transaction, {
          id: idFactory(),
          companyId: input.lease.ref.companyId,
          issueId: input.lease.ref.issueId,
          runId: input.lease.runId,
          predecessorAttemptId: input.lease.attemptId,
          reasonCode: input.reason,
          retryAt: validDate(input.retryAt, "retry due time"),
          at,
        });
      });
    },

    async markTerminal(input: {
      lease: LeasedIssueExecutionRef;
      outcome: IssueExecutionTerminal["outcome"];
      reason: string | null;
      finishedAt: Date;
    }) {
      const at = validDate(input.finishedAt, "attempt terminal time");
      const settlement = await options.database.transaction(async (transaction) => {
        await lockLaneParents(transaction, input.lease.ref);
        await lockLane(transaction, input.lease.ref);
        const run = await options.runService.lockRun(transaction, input.lease);
        await assertLeaseLaneClaim(transaction, input.lease, at);
        const cancellation = run.cancellationIntentId
          ? exactlyOne(
              await transaction
                .select()
                .from(issueExecutionCancellationIntents)
                .where(eq(issueExecutionCancellationIntents.id, run.cancellationIntentId))
                .limit(2)
                .for("update"),
              "run lost its attached cancellation intent",
            )
          : null;
        const attemptState = input.outcome === "succeeded"
          ? "settled" as const
          : input.outcome === "cancelled"
            ? "cancelled" as const
            : "failed" as const;
        await releaseAttempt(
          transaction,
          options,
          input.lease,
          attemptState,
          at,
          cancellation === null,
        );
        let completed: Awaited<
          ReturnType<typeof completeTerminalPromptInTransaction>
        >;
        if (cancellation) {
          completed = {
            finalization: null,
            laneReleased: false,
            autoCaptureRefId: null,
          };
        } else {
          const attempt = exactlyOne(
            await transaction
              .select()
              .from(issueExecutionAttempts)
              .where(eq(issueExecutionAttempts.id, input.lease.attemptId))
              .limit(2)
              .for("update"),
            "terminal attempt disappeared",
          );
          completed = await completeTerminalPromptInTransaction(
            transaction,
            options,
            {
              lease: input.lease,
              attempt,
              outcome: input.outcome,
              reason: input.reason,
              at,
              idFactory,
            },
          );
        }
        return completed;
      });
      if (settlement.finalization) {
        await publishAgentRunTerminalEvent(options.pluginDomainEvents, {
          companyId: settlement.finalization.companyId,
          issueId: settlement.finalization.issueId,
          runId: settlement.finalization.runId,
          agentId: input.lease.ref.targetAgentId,
          outcome: settlement.finalization.status,
          reason: input.reason,
          occurredAt: settlement.finalization.finishedAt,
        });
      }
      if (settlement.autoCaptureRefId && options.dispatchRef) {
        void options.dispatchRef(settlement.autoCaptureRefId);
      }
      return {
        laneReleased: settlement.laneReleased,
      };
    },

    async terminalizeCancelledRun(input: {
      companyId: string;
      issueId: string;
      runId: string;
      reason: string;
      finishedAt: Date;
    }) {
      const terminalized = await options.database.transaction((transaction) =>
        terminalizeDetachedCancelledRunInTransaction(transaction, input));
      if (!terminalized) return;
      const run = await options.runService.readRun(input);
      if (!run) {
        reject("terminalized cancellation lost its canonical run");
      }
      await publishAgentRunTerminalEvent(options.pluginDomainEvents, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: run.targetAgentId,
        outcome: "cancelled",
        reason: input.reason,
        occurredAt: input.finishedAt,
      });
    },

    terminalizeDetachedCancelledRunInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,

  } satisfies IssueExecutionDispatcherRepository & {
    terminalizeCancelledRun(input: {
      companyId: string;
      issueId: string;
      runId: string;
      reason: string;
      finishedAt: Date;
    }): Promise<void>;
    terminalizeDetachedCancelledRunInTransaction(
      transaction: IssueSessionDbTransaction,
      input: {
        companyId: string;
        issueId: string;
        runId: string;
        reason: string;
        finishedAt: Date;
      },
    ): Promise<boolean>;
    fenceRevokedExecutionAuthorityInTransaction(
      transaction: IssueSessionDbTransaction,
      input: {
        companyId: string;
        selector: IssueExecutionAuthorityFenceSelector;
        reason: string;
        at: Date;
      },
    ): Promise<FencedIssueExecutionAuthority>;
  };
  return repository;
}

export type PostgresIssueExecutionDispatcherRepository = ReturnType<
  typeof createPostgresIssueExecutionDispatcherRepository
>;
