import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  companySessionLifecycleOperations,
  taskConsultExecutions,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionHistoryViews,
  taskExecutionLanes,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  taskSessions,
  taskSessionEvents,
  taskSessionInputDispositions,
  taskSessionMessages,
  tasks,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  TaskExecutionRef,
  TaskExecutionSessionOperation,
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
import { preserveCorrelationAfterNonProtocolClosure } from "./task-execution-correlation-retention.js";
import type {
  TaskExecutionDispatcherRepository,
  TaskExecutionRetry,
  TaskExecutionTerminal,
  TaskExecutionTargetLaneIdentity,
  LeasedTaskExecutionRef,
} from "./task-execution-dispatcher.js";
import {
  claimTaskExecutionAttemptRetryInTransaction,
  scheduleTaskExecutionAttemptRetryInTransaction,
} from "./task-execution-attempt-retry-schedule-postgres.js";
import type { PostgresTaskExecutionFinalizationWriter } from "./task-execution-finalization-postgres.js";
import {
  lockActiveProductiveRunForLaneInTransaction,
  lockTaskExecutionRunIfPresentInTransaction,
  readActiveTaskExecutionRefRunAvailability,
  readBlockedActiveTaskExecutionRefIds,
  readTaskExecutionLeaseBinding,
  readOccupiedTaskExecutionRefIds,
  terminalFinalizedTaskExecutionRunExistsSql,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunService,
} from "./task-execution-run-service.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import {
  resolveRuntimeToolTurn,
  type PostgresPromptCapabilityCompiler,
} from "./runtime-interface-compiler-db.js";
import {
  resolveInitialPromptCycleInTransaction,
  settleNonProtocolPromptInTransaction,
} from "./task-execution-prompt-cycle-postgres.js";
import {
  isTaskExecutionRefDeliveryEligible,
  taskExecutionRefDeliveryEligibilitySql,
} from "./task-execution-ref-delivery.js";
import {
  TaskConsultChainInvalid,
  lockAndValidateTaskConsultChain,
} from "./task-consult-chain-postgres.js";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import {
  activeTaskTreePauseHoldExistsSql,
  lockTaskTreeExecutionGate,
} from "./task-execution-lifecycle-gate.js";

export type PersistedTaskExecutionRefRow =
  typeof taskExecutionRefs.$inferSelect;
type RefRow = PersistedTaskExecutionRefRow;
type RunRow = TaskExecutionRunEnvelope;
type AttemptRow = typeof taskExecutionAttempts.$inferSelect;
type CancellationIntentRow =
  typeof taskExecutionCancellationIntents.$inferSelect;
type PromptCapabilityRow =
  typeof taskExecutionPromptCapabilities.$inferSelect;
type BasePromptOwnerRow = typeof taskExecutionRunRefs.$inferSelect;
type SteeringPromptOwnerRow =
  typeof taskExecutionPromptSegments.$inferSelect;
type PromptOwnerRow = BasePromptOwnerRow | SteeringPromptOwnerRow;
type LaneRefIdentity = Pick<
  RefRow,
  | "id"
  | "companyId"
  | "taskId"
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
      readonly lease: LeasedTaskExecutionRef;
      readonly run: RunRow;
    };

const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const MAX_CREATOR_UPDATE_BATCH = 32;

function targetLaneIdentity(
  ref: Pick<
    RefRow,
    | "companyId"
    | "taskId"
    | "sessionId"
    | "ownershipEpoch"
    | "targetAgentId"
  >,
): TaskExecutionTargetLaneIdentity {
  return Object.freeze({
    companyId: ref.companyId,
    taskId: ref.taskId,
    sessionId: ref.sessionId,
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
  });
}

export class PostgresTaskExecutionDispatchRejected extends Error {
  readonly code = "postgres_task_execution_dispatch_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionDispatchRejected";
  }
}

export interface PostgresTaskExecutionDispatcherRepositoryOptions {
  readonly database: Db;
  readonly runService: Pick<
    TaskExecutionRunService,
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
    PostgresTaskExecutionFinalizationWriter,
    | "finalize"
    | "finalizeInTransaction"
  >;
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pluginDomainEvents: PluginDomainEventPublisher;
  readonly dispatchRef?: (refId: string) => Promise<void>;
}

export type TaskExecutionAuthorityFenceSelector =
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
      readonly taskId: string;
      readonly ownershipEpoch: number;
    }
  | {
      readonly kind: "refs";
      readonly taskId: string;
      readonly refIds: readonly string[];
    }
  | {
      readonly kind: "budget_scope";
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
    };

export interface FencedTaskExecutionAuthority {
  readonly refIds: readonly string[];
  readonly correlationIds: readonly string[];
}

function reject(message: string): never {
  throw new PostgresTaskExecutionDispatchRejected(message);
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
      readonly reason: TaskExecutionRetry["reason"];
      readonly retryAt: Date;
    }
  | {
      readonly kind: "terminal";
      readonly outcome: TaskExecutionTerminal["outcome"];
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
export function projectPersistedTaskExecutionRef(
  row: PersistedTaskExecutionRefRow,
): TaskExecutionRef {
  return {
    id: row.id,
    companyId: row.companyId,
    taskId: row.taskId,
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
    taskExecutionAuthorityId: row.taskExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    contextEpoch: row.contextEpoch,
    historyViewId: row.historyViewId,
    admissionHighWaterSeq: row.admissionHighWaterSeq,
    inputId: row.inputId,
    admittedSeq: row.admittedSeq,
    promotedSeq: row.promotedSeq,
    counterpartTaskId: row.counterpartTaskId,
    counterpartAuthorityId: row.counterpartAuthorityId,
    counterpartOwnershipEpoch: row.counterpartOwnershipEpoch,
    consultCallerRefId: row.consultCallerRefId,
    consultChainToken: row.consultChainToken,
    disposition: row.disposition,
  };
}

function sameBatchScope(first: RefRow, candidate: RefRow): boolean {
  return candidate.sourceKind === "task_update" &&
    candidate.companyId === first.companyId &&
    candidate.taskId === first.taskId &&
    candidate.sessionId === first.sessionId &&
    candidate.ownershipEpoch === first.ownershipEpoch &&
    candidate.executionScopeId === first.executionScopeId &&
    candidate.executionLineageId === first.executionLineageId &&
    candidate.mode === first.mode &&
    candidate.targetAgentId === first.targetAgentId &&
    candidate.taskExecutionAuthorityId === first.taskExecutionAuthorityId &&
    candidate.consultExecutionId === first.consultExecutionId &&
    candidate.adapterConfigRevisionId === first.adapterConfigRevisionId &&
    candidate.contextEpoch === first.contextEpoch &&
    candidate.disposition === "active" &&
    isTaskExecutionRefDeliveryEligible(candidate, "dispatch");
}

function leaseProjection(
  refs: readonly RefRow[],
  runId: string,
  attempt: AttemptRow,
  leaseId: string,
  leaseGeneration: number,
): LeasedTaskExecutionRef {
  const first = exactlyOne(refs.slice(0, 1), "attempt lost its first run ref");
  if (
    attempt.refOrdinal === null ||
    attempt.segmentOrdinal === null ||
    (attempt.promptKind !== "base" && attempt.promptKind !== "steering")
  ) {
    reject("productive lease lost its exact prompt identity");
  }
  const members = refs.map((row) => ({
    ref: projectPersistedTaskExecutionRef(row),
    leaseGeneration,
    attemptNumber: attempt.attemptGeneration,
  }));
  return Object.freeze({
    ref: projectPersistedTaskExecutionRef(first),
    companyId: first.companyId,
    taskId: first.taskId,
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
  transaction: TaskSessionDbTransaction,
  ref: Pick<
    LaneRefIdentity,
    "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId"
  >,
) {
  return exactlyOne(
    await transaction
      .select()
      .from(taskExecutionLanes)
      .where(
        and(
          eq(taskExecutionLanes.companyId, ref.companyId),
          eq(taskExecutionLanes.taskId, ref.taskId),
          eq(taskExecutionLanes.ownershipEpoch, ref.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, ref.targetAgentId),
        ),
      )
      .limit(2)
      .for("update"),
    "execution ref lost its exact lane",
  );
}

async function lockLaneParents(
  transaction: TaskSessionDbTransaction,
  ref: Pick<LaneRefIdentity, "companyId" | "taskId"> & {
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
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ref.companyId),
          eq(tasks.id, ref.taskId),
        ),
      )
      .limit(2)
      .for("update"),
    "execution lane lost its task parent",
  );
  if (ref.sessionId !== undefined) {
    exactlyOne(
      await transaction
        .select({ id: taskSessions.id })
        .from(taskSessions)
        .where(
          and(
            eq(taskSessions.companyId, ref.companyId),
            eq(taskSessions.taskId, ref.taskId),
            eq(taskSessions.id, ref.sessionId),
          ),
        )
        .limit(2)
        .for("update"),
      "execution lane lost its Session parent",
    );
  }
}

async function lockLaneLeaseClaim(
  transaction: TaskSessionDbTransaction,
  ref: RefRow,
  options: { readonly existingRun: boolean },
): Promise<LockedLaneLeaseClaim | null> {
  await lockLaneParents(transaction, ref);
  const lane = await lockLane(transaction, ref);
  const laneHead = await transaction
    .select({
      id: taskExecutionRefs.id,
      laneOrdinal: taskExecutionRefs.laneOrdinal,
    })
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.companyId, ref.companyId),
        eq(taskExecutionRefs.taskId, ref.taskId),
        eq(taskExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, ref.targetAgentId),
        eq(taskExecutionRefs.disposition, "active"),
      ),
    )
    .orderBy(asc(taskExecutionRefs.laneOrdinal), asc(taskExecutionRefs.id))
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
  transaction: TaskSessionDbTransaction,
  input: {
    readonly ref: Pick<
      LaneRefIdentity,
      "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId"
    >;
    readonly laneOrdinal: number;
    readonly leaseGeneration: number;
    readonly leaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  exactlyOne(
    await transaction
      .update(taskExecutionLanes)
      .set({
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(taskExecutionLanes.companyId, input.ref.companyId),
          eq(taskExecutionLanes.taskId, input.ref.taskId),
          eq(
            taskExecutionLanes.ownershipEpoch,
            input.ref.ownershipEpoch,
          ),
          eq(taskExecutionLanes.targetAgentId, input.ref.targetAgentId),
          eq(taskExecutionLanes.activeOrdinal, input.laneOrdinal),
          eq(
            taskExecutionLanes.activeLeaseGeneration,
            input.leaseGeneration,
          ),
          eq(taskExecutionLanes.activeLeaseId, input.leaseId),
        ),
      )
      .returning({ companyId: taskExecutionLanes.companyId }),
    "execution lane lost its exact ordinal and lease claim",
  );
}

async function assertLeaseLaneClaim(
  transaction: TaskSessionDbTransaction,
  lease: LeasedTaskExecutionRef,
  at: Date,
): Promise<void> {
  await lockLaneParents(transaction, lease.ref);
  const lane = await lockLane(transaction, lease.ref);
  const persistedRef = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionRefs)
      .where(eq(taskExecutionRefs.id, lease.ref.id))
      .limit(2)
      .for("update"),
    "lease lost its persisted execution ref",
  );
  const member = exactlyOne(
    await transaction
      .select({ admissionOrder: taskExecutionRunRefs.admissionOrder })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, lease.runId),
          eq(taskExecutionRunRefs.refId, lease.ref.id),
          eq(taskExecutionRunRefs.refOrdinal, lease.refOrdinal),
        ),
      )
      .limit(2)
      .for("update"),
    "lease lost its exact run member",
  );
  const persistedLease = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionLeases)
      .where(eq(taskExecutionLeases.id, lease.leaseId))
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
  transaction: TaskSessionDbTransaction,
  runId: string,
): Promise<{
  readonly ref: LaneRefIdentity;
  readonly laneOrdinal: number;
  readonly leaseGeneration: number;
  readonly leaseId: string;
} | null> {
  const rows = await transaction
    .select({
      ref: taskExecutionRefs,
      laneOrdinal: taskExecutionLanes.activeOrdinal,
      leaseGeneration: taskExecutionLanes.activeLeaseGeneration,
      leaseId: taskExecutionLanes.activeLeaseId,
    })
    .from(taskExecutionLanes)
    .innerJoin(
      taskExecutionRefs,
      and(
        eq(taskExecutionRefs.companyId, taskExecutionLanes.companyId),
        eq(taskExecutionRefs.taskId, taskExecutionLanes.taskId),
        eq(
          taskExecutionRefs.ownershipEpoch,
          taskExecutionLanes.ownershipEpoch,
        ),
        eq(taskExecutionRefs.targetAgentId, taskExecutionLanes.targetAgentId),
        sql`${taskExecutionRefs.laneOrdinal} = ${taskExecutionLanes.activeOrdinal}`,
      ),
    )
    .innerJoin(
      taskExecutionRunRefs,
      and(
        eq(taskExecutionRunRefs.runId, runId),
        eq(taskExecutionRunRefs.refId, taskExecutionRefs.id),
      ),
    )
    .innerJoin(
      taskExecutionLeases,
      and(
        eq(taskExecutionLeases.id, taskExecutionLanes.activeLeaseId),
        eq(taskExecutionLeases.runId, taskExecutionRunRefs.runId),
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
    taskId: run.taskId,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
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
  transaction: TaskSessionDbTransaction,
  compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">,
  input: {
    readonly run: RunRow;
    readonly promptKind: "base" | "steering";
    readonly ref: RefRow;
    readonly refOrdinal: number;
    readonly segmentOrdinal: number;
  },
): Promise<TaskExecutionSessionOperation> {
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
    eq(taskExecutionSessions.companyId, run.companyId),
    eq(taskExecutionSessions.taskId, run.taskId),
    eq(taskExecutionSessions.ownershipEpoch, run.ownershipEpoch),
    eq(taskExecutionSessions.targetAgentId, run.targetAgentId),
    eq(taskExecutionSessions.adapterConfigIdentity, run.adapterConfigRevisionId),
    eq(taskExecutionSessions.workspaceIdentity, run.executionWorkspaceBindingId),
  );
  if (input.promptKind === "steering") {
    const segment = exactlyOne(
      await transaction
        .select({
          resumeSourceCorrelationId:
            taskExecutionPromptSegments.resumeSourceCorrelationId,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.companyId, run.companyId),
            eq(taskExecutionPromptSegments.taskId, run.taskId),
            eq(taskExecutionPromptSegments.runId, run.runId),
            eq(taskExecutionPromptSegments.refId, input.ref.id),
            eq(taskExecutionPromptSegments.refOrdinal, input.refOrdinal),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
              input.segmentOrdinal,
            ),
            eq(taskExecutionPromptSegments.steeringState, "resumed"),
            isNull(taskExecutionPromptSegments.protocolSettlementState),
          ),
        )
        .limit(2)
        .for("update"),
      "steering attempt lost its immutable resume source",
    );
    const sources = await transaction
      .select()
      .from(taskExecutionSessions)
      .where(
        and(
          common,
          eq(taskExecutionSessions.id, segment.resumeSourceCorrelationId),
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
      .select({ id: taskExecutionSessions.id })
      .from(taskExecutionSessions)
      .where(
        and(
          common,
          eq(taskExecutionSessions.purpose, "carry"),
          eq(taskExecutionSessions.state, "eligible"),
          eq(taskExecutionSessions.laneKind, run.executionMode),
          eq(
            taskExecutionSessions.authorizedContextExposureDigest,
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
  transaction: TaskSessionDbTransaction,
  ref: RefRow,
): Promise<void> {
  const [companyRows, taskRows, sessionRows, viewRows, lifecycleRows] =
    await Promise.all([
      transaction
        .select({ status: companies.status, integrity: companies.sessionIntegrityState })
        .from(companies)
        .where(eq(companies.id, ref.companyId))
        .limit(2)
        .for("share"),
      transaction
        .select({
          lifecycleStatus: tasks.lifecycleStatus,
          ownerKind: tasks.ownerKind,
          ownerAgentId: tasks.ownerAgentId,
          ownershipEpoch: tasks.ownershipEpoch,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, ref.companyId), eq(tasks.id, ref.taskId)))
        .limit(2)
        .for("update"),
      transaction
        .select()
        .from(taskSessions)
        .where(
          and(
            eq(taskSessions.companyId, ref.companyId),
            eq(taskSessions.taskId, ref.taskId),
            eq(taskSessions.id, ref.sessionId),
          ),
        )
        .limit(2)
        .for("update"),
      transaction
        .select({ state: taskExecutionHistoryViews.state, refId: taskExecutionHistoryViews.refId })
        .from(taskExecutionHistoryViews)
        .where(eq(taskExecutionHistoryViews.id, ref.historyViewId))
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
  const task = exactlyOne(taskRows, "execution ref lost its task");
  const session = exactlyOne(sessionRows, "execution ref lost its Session");
  const view = exactlyOne(viewRows, "execution ref lost its history view");
  const ownerValid = ref.mode === "owner"
    ? task.ownerKind === "agent" &&
      task.ownerAgentId === ref.targetAgentId &&
      ref.taskExecutionAuthorityId !== null
    : ref.consultExecutionId !== null;
  if (
    company.status !== "active" ||
    company.integrity !== "ready" ||
    lifecycleRows.length !== 0 ||
    !["open", "blocked"].includes(task.lifecycleStatus) ||
    task.ownershipEpoch !== ref.ownershipEpoch ||
    !ownerValid ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !["empty", "current"].includes(view.state) ||
    view.refId !== ref.id ||
    ref.disposition !== "active" ||
    !isTaskExecutionRefDeliveryEligible(ref, "dispatch")
  ) {
    reject("execution ref is no longer current and dispatchable");
  }
  if (ref.mode === "consult") {
    if (!(await consultSourceRunIsFinalized(transaction, ref))) {
      reject("consult source run is not finalized");
    }
    try {
      await lockAndValidateTaskConsultChain(transaction, {
        ref,
        requireLiveAncestors: false,
        leafState: "active",
      });
    } catch (error) {
      if (error instanceof TaskConsultChainInvalid) {
        reject(error.message);
      }
      throw error;
    }
  }
}

async function consultSourceRunIsFinalized(
  transaction: TaskSessionDbTransaction,
  ref: Pick<RefRow, "companyId" | "taskId" | "mode" | "consultExecutionId">,
): Promise<boolean> {
  if (ref.mode === "owner") return true;
  if (ref.consultExecutionId === null) return false;
  const rows = await transaction
    .select({ sourceRunId: taskConsultExecutions.sourceRunId })
    .from(taskConsultExecutions)
    .where(
      and(
        eq(taskConsultExecutions.id, ref.consultExecutionId),
        eq(taskConsultExecutions.companyId, ref.companyId),
        eq(taskConsultExecutions.taskId, ref.taskId),
      ),
    )
    .limit(2)
    .for("share");
  const consult = rows.length === 1 ? rows[0]! : null;
  if (!consult) return false;
  const sourceRun = await lockTaskExecutionRunIfPresentInTransaction(
    transaction,
    {
      companyId: ref.companyId,
      taskId: ref.taskId,
      runId: consult.sourceRunId,
    },
  );
  return sourceRun?.terminalFinalizationId !== null;
}

async function createRunningLease(
  transaction: TaskSessionDbTransaction,
  options: {
    readonly runService: PostgresTaskExecutionDispatcherRepositoryOptions["runService"];
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
): Promise<LeasedTaskExecutionRef> {
  const first = exactlyOne(input.refs.slice(0, 1), "run has no current ref");
  const control = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionRunControls)
      .where(eq(taskExecutionRunControls.runId, input.run.runId))
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
      .select({ admissionOrder: taskExecutionRunRefs.admissionOrder })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, input.run.runId),
          eq(taskExecutionRunRefs.refId, first.id),
          eq(taskExecutionRunRefs.refOrdinal, control.currentOrdinal),
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
    .select({ generation: taskExecutionAttempts.attemptGeneration })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.runId, input.run.runId),
        eq(taskExecutionAttempts.refId, first.id),
        eq(taskExecutionAttempts.refOrdinal, control.currentOrdinal),
        eq(taskExecutionAttempts.segmentOrdinal, control.currentSegmentOrdinal),
      ),
    )
    .orderBy(desc(taskExecutionAttempts.attemptGeneration))
    .limit(1)
    .for("update");
  const attempt = input.pendingAttempt
    ? exactlyOne(
        await transaction
          .update(taskExecutionAttempts)
          .set({ state: "running", startedAt: input.at })
          .where(
            and(
              eq(taskExecutionAttempts.id, input.pendingAttempt.id),
              eq(taskExecutionAttempts.state, "pending"),
            ),
          )
          .returning(),
        "pending retry attempt could not start",
      )
    : exactlyOne(
        await transaction
          .insert(taskExecutionAttempts)
          .values({
            id: options.idFactory(),
            companyId: input.run.companyId,
            taskId: input.run.taskId,
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
      .insert(taskExecutionLeases)
      .values({
        id: leaseId,
        companyId: input.run.companyId,
        taskId: input.run.taskId,
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
      .returning({ id: taskExecutionLeases.id }),
    "attempt lease creation did not return one row",
  );
  await options.runService.attachAttempt(transaction, {
    companyId: input.run.companyId,
    taskId: input.run.taskId,
    runId: input.run.runId,
    attemptId: attempt.id,
    leaseId,
    at: input.at,
  });
  exactlyOne(
    await transaction
      .update(taskExecutionLanes)
      .set({
        activeOrdinal: currentMember.admissionOrder,
        activeLeaseGeneration: leaseGeneration,
        activeLeaseId: leaseId,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(taskExecutionLanes.companyId, first.companyId),
          eq(taskExecutionLanes.taskId, first.taskId),
          eq(taskExecutionLanes.ownershipEpoch, first.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, first.targetAgentId),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeOrdinal)
            : eq(
                taskExecutionLanes.activeOrdinal,
                input.laneClaim.ordinal,
              ),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeLeaseGeneration)
            : eq(
                taskExecutionLanes.activeLeaseGeneration,
                input.laneClaim.leaseGeneration,
              ),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeLeaseId)
            : eq(
                taskExecutionLanes.activeLeaseId,
                input.laneClaim.leaseId,
              ),
        ),
      )
      .returning({ companyId: taskExecutionLanes.companyId }),
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
  transaction: TaskSessionDbTransaction,
  runId: string,
): Promise<RefRow[]> {
  return transaction
    .select({ ref: taskExecutionRefs })
    .from(taskExecutionRunRefs)
    .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionRunRefs.refId))
    .where(eq(taskExecutionRunRefs.runId, runId))
    .orderBy(asc(taskExecutionRunRefs.refOrdinal))
    .then((rows) => rows.map((row) => row.ref));
}

async function findExistingRunForLane(
  transaction: TaskSessionDbTransaction,
  lane: TaskExecutionTargetLaneIdentity,
): Promise<RunRow | null> {
  await lockLaneParents(transaction, lane);
  await lockLane(transaction, lane);
  return lockActiveProductiveRunForLaneInTransaction(transaction, lane);
}

async function createRunForRef(
  transaction: TaskSessionDbTransaction,
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  ref: RefRow,
  at: Date,
  exactRetry?: {
    readonly retryOfRunId: string;
    readonly orderedRefs: readonly RefRow[];
    readonly sessionOperation: TaskExecutionSessionOperation;
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
    const occupiedRefIds = await readOccupiedTaskExecutionRefIds(transaction, {
      companyId: ref.companyId,
      taskId: ref.taskId,
      sessionId: ref.sessionId,
    });
    const candidates = ref.sourceKind === "task_update"
      ? await transaction
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, ref.companyId),
              eq(taskExecutionRefs.taskId, ref.taskId),
              eq(taskExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
              eq(taskExecutionRefs.targetAgentId, ref.targetAgentId),
              eq(taskExecutionRefs.disposition, "active"),
              gte(taskExecutionRefs.laneOrdinal, ref.laneOrdinal),
            ),
          )
          .orderBy(asc(taskExecutionRefs.laneOrdinal))
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
          !isTaskExecutionRefDeliveryEligible(candidate, "dispatch") ||
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
      .select({ id: taskExecutionWorkspaceBindings.id })
      .from(taskExecutionWorkspaceBindings)
      .where(
        and(
          eq(taskExecutionWorkspaceBindings.companyId, ref.companyId),
          eq(taskExecutionWorkspaceBindings.taskId, ref.taskId),
          eq(taskExecutionWorkspaceBindings.sessionId, ref.sessionId),
          eq(taskExecutionWorkspaceBindings.ownershipEpoch, ref.ownershipEpoch),
        ),
      )
      .limit(2)
      .for("share"),
    "execution ref lost its exact workspace binding",
  );
  const baseRunInput = {
    companyId: ref.companyId,
    taskId: ref.taskId,
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
        taskExecutionAuthorityId: ref.taskExecutionAuthorityId!,
      })
    : await (async () => {
        const { sourceRunId } = exactlyOne(
          await transaction
            .select({ sourceRunId: taskConsultExecutions.sourceRunId })
            .from(taskConsultExecutions)
            .where(eq(taskConsultExecutions.id, ref.consultExecutionId!))
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
      .update(taskExecutionRunControls)
      .set({
        currentRefId: refs[0]!.id,
        currentOrdinal: 0,
        currentSegmentOrdinal: 0,
      })
      .where(
        and(
          eq(taskExecutionRunControls.runId, created.run.runId),
          isNull(taskExecutionRunControls.currentRefId),
          isNull(taskExecutionRunControls.currentOrdinal),
          isNull(taskExecutionRunControls.currentSegmentOrdinal),
        ),
      )
      .returning({ runId: taskExecutionRunControls.runId }),
    "new run could not bind its first prompt",
  );
  if (exactRetry) {
    exactlyOne(
      await transaction
        .insert(taskExecutionAttempts)
        .values({
          id: options.idFactory?.() ?? randomUUID(),
          companyId: created.run.companyId,
          taskId: created.run.taskId,
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
        .returning({ id: taskExecutionAttempts.id }),
      "released-run retry could not freeze its pending successor attempt",
    );
  }
  const admission = createTaskSessionAdmissionService(options.database);
  await admission.appendNonDispatchSyntheticComment({
    companyId: ref.companyId,
    taskId: ref.taskId,
    sessionId: ref.sessionId,
    sourceKind: "task_execution_run_progress",
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
    taskId: created.run.taskId,
    runId: created.run.runId,
  });
  return { run, refs };
}

async function releaseAttempt(
  transaction: TaskSessionDbTransaction,
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  lease: LeasedTaskExecutionRef,
  state: "settled" | "failed" | "cancelled",
  at: Date,
  detach: boolean,
): Promise<void> {
  exactlyOne(
    await transaction
      .update(taskExecutionAttempts)
      .set({ state, finishedAt: at })
      .where(
        and(
          eq(taskExecutionAttempts.id, lease.attemptId),
          eq(taskExecutionAttempts.runId, lease.runId),
          eq(taskExecutionAttempts.state, "running"),
        ),
      )
      .returning({ id: taskExecutionAttempts.id }),
    "attempt terminalization lost its exact running generation",
  );
  exactlyOne(
    await transaction
      .update(taskExecutionLeases)
      .set({ state: "released", releasedAt: at })
      .where(
        and(
          eq(taskExecutionLeases.id, lease.leaseId),
          eq(taskExecutionLeases.attemptId, lease.attemptId),
          eq(taskExecutionLeases.state, "active"),
        ),
      )
      .returning({ id: taskExecutionLeases.id }),
    "attempt terminalization lost its exact active lease",
  );
  if (detach) {
    await options.runService.detachAttempt(transaction, {
      companyId: lease.ref.companyId,
      taskId: lease.ref.taskId,
      runId: lease.runId,
      expectedAttemptId: lease.attemptId,
      expectedLeaseId: lease.leaseId,
      at,
    });
  }
}

async function settleUnsentSuffix(
  transaction: TaskSessionDbTransaction,
  runId: string,
  afterOrdinal: number,
  at: Date,
  idFactory: () => string,
): Promise<void> {
  const suffix = await transaction
    .select({ refOrdinal: taskExecutionRunRefs.refOrdinal })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.runId, runId),
        sql`${taskExecutionRunRefs.refOrdinal} > ${afterOrdinal}`,
        isNull(taskExecutionRunRefs.protocolSettlementState),
      ),
    )
    .orderBy(asc(taskExecutionRunRefs.refOrdinal))
    .for("update");
  for (const member of suffix) {
    exactlyOne(
      await transaction
        .update(taskExecutionRunRefs)
        .set({
          outcome: "released_unsent",
          outcomeReferenceId: idFactory(),
          protocolSettlementState: "not_sent",
          settlementVersion: 1,
          settledAt: at,
        })
        .where(
          and(
            eq(taskExecutionRunRefs.runId, runId),
            eq(taskExecutionRunRefs.refOrdinal, member.refOrdinal),
            isNull(taskExecutionRunRefs.protocolSettlementState),
          ),
        )
        .returning({ runId: taskExecutionRunRefs.runId }),
      "run suffix settlement lost an untouched member",
    );
  }
}

async function loadRecoveredProtocolSettlement(
  transaction: TaskSessionDbTransaction,
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
      .from(taskSessionEvents)
      .where(
        and(
          eq(taskSessionEvents.companyId, input.run.companyId),
          eq(taskSessionEvents.taskId, input.run.taskId),
          eq(taskSessionEvents.sessionId, input.run.sessionId),
          eq(taskSessionEvents.runId, input.run.runId),
          eq(taskSessionEvents.type, "session.next.step.ended.3"),
          eq(taskSessionEvents.sourceKind, "acp_prompt_settlement"),
          eq(taskSessionEvents.sourceId, input.owner.outcomeReferenceId),
          eq(taskSessionEvents.sourceRecordId, input.owner.accountingId),
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
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.companyId, input.run.companyId),
          eq(taskSessionMessages.taskId, input.run.taskId),
          eq(taskSessionMessages.sessionId, input.run.sessionId),
          eq(taskSessionMessages.runId, input.run.runId),
          eq(taskSessionMessages.id, assistantMessageId),
          eq(taskSessionMessages.type, "assistant"),
        ),
      )
      .limit(2)
      .for("update"),
    "protocol settlement recovery lost its terminal assistant",
  );
  const message = taskSessionMessageFromRow(messageRow);
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
  transaction: TaskSessionDbTransaction,
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  input: {
    readonly lease: LeasedTaskExecutionRef;
    readonly attempt: AttemptRow;
    readonly outcome: TaskExecutionTerminal["outcome"];
    readonly reason: string | null;
    readonly at: Date;
    readonly idFactory: () => string;
  },
): Promise<{
  readonly finalization: {
    readonly companyId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly status: TaskExecutionTerminal["outcome"];
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
      .update(taskExecutionRefs)
      .set({ disposition: "terminal", updatedAt: input.at })
      .where(
        and(
          eq(taskExecutionRefs.id, input.lease.ref.id),
          eq(taskExecutionRefs.disposition, "active"),
        ),
      )
      .returning({ id: taskExecutionRefs.id }),
    "terminal progression lost its active execution ref",
  );
  exactlyOne(
    await transaction
      .update(taskExecutionHistoryViews)
      .set({ state: "terminal", finalizedAt: input.at, updatedAt: input.at })
      .where(
        and(
          eq(taskExecutionHistoryViews.id, input.lease.ref.historyViewId),
          inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: taskExecutionHistoryViews.id }),
    "terminal progression lost its active history view",
  );
  if (input.outcome === "succeeded") {
    const next = await transaction
      .select({
        refId: taskExecutionRunRefs.refId,
        refOrdinal: taskExecutionRunRefs.refOrdinal,
      })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, input.lease.runId),
          sql`${taskExecutionRunRefs.refOrdinal} > ${input.attempt.refOrdinal!}`,
          isNull(taskExecutionRunRefs.protocolSettlementState),
        ),
      )
      .orderBy(asc(taskExecutionRunRefs.refOrdinal))
      .limit(1)
      .for("update");
    if (next[0]) {
      exactlyOne(
        await transaction
          .update(taskExecutionRunControls)
          .set({
            currentRefId: next[0].refId,
            currentOrdinal: next[0].refOrdinal,
            currentSegmentOrdinal: 0,
          })
          .where(
            and(
              eq(taskExecutionRunControls.runId, input.lease.runId),
              eq(taskExecutionRunControls.currentRefId, input.lease.ref.id),
              eq(
                taskExecutionRunControls.currentOrdinal,
                input.lease.refOrdinal,
              ),
              eq(
                taskExecutionRunControls.currentSegmentOrdinal,
                input.lease.segmentOrdinal,
              ),
            ),
          )
          .returning({ runId: taskExecutionRunControls.runId }),
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
      .update(taskExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
        currentSegmentOrdinal: null,
      })
      .where(
        and(
          eq(taskExecutionRunControls.runId, input.lease.runId),
          eq(taskExecutionRunControls.currentRefId, input.lease.ref.id),
          eq(taskExecutionRunControls.currentOrdinal, input.lease.refOrdinal),
          eq(
            taskExecutionRunControls.currentSegmentOrdinal,
            input.lease.segmentOrdinal,
          ),
        ),
      )
      .returning({ runId: taskExecutionRunControls.runId }),
    "terminal run could not clear its prompt control",
  );
  const finalization = {
    companyId: input.lease.ref.companyId,
    taskId: input.lease.ref.taskId,
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

export function createPostgresTaskExecutionDispatcherRepository(
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
): TaskExecutionDispatcherRepository & {
  readonly terminalizeCancelledRun: (input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
    readonly finishedAt: Date;
  }) => Promise<void>;
  readonly terminalizeDetachedCancelledRunInTransaction: (
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ) => Promise<boolean>;
  readonly fenceRevokedExecutionAuthorityInTransaction: (
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: TaskExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
    },
  ) => Promise<FencedTaskExecutionAuthority>;
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
        readonly terminal: TaskExecutionTerminal;
      };

  function terminalEventForExpiredRun(
    run: RunRow,
    recovery: ExpiredRunRecovery,
    occurredAt: Date,
  ): AgentRunTerminalPluginEventInput | null {
    if (recovery.kind !== "released_run") return null;
    return {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.targetAgentId,
      outcome: recovery.terminal.outcome,
      reason: recovery.terminal.reason,
      occurredAt,
    };
  }

  async function recoverExpiredRunInTransaction(
    transaction: TaskSessionDbTransaction,
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
            .from(taskExecutionCancellationIntents)
            .where(
              eq(
                taskExecutionCancellationIntents.id,
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
        .from(taskExecutionRunControls)
        .where(eq(taskExecutionRunControls.runId, run.runId))
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
          row: taskExecutionRunRefs,
          ref: taskExecutionRefs,
        })
        .from(taskExecutionRunRefs)
        .innerJoin(
          taskExecutionRefs,
          eq(taskExecutionRefs.id, taskExecutionRunRefs.refId),
        )
        .where(
          and(
            eq(taskExecutionRunRefs.runId, run.runId),
            eq(taskExecutionRunRefs.refId, control.currentRefId),
            eq(taskExecutionRunRefs.refOrdinal, control.currentOrdinal),
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
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, run.runId),
                eq(
                  taskExecutionPromptSegments.refId,
                  control.currentRefId,
                ),
                eq(
                  taskExecutionPromptSegments.refOrdinal,
                  control.currentOrdinal,
                ),
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
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
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.id, run.currentAttemptId))
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
        .from(taskExecutionLeases)
        .where(eq(taskExecutionLeases.id, run.currentLeaseId))
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
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, run.runId),
                eq(taskExecutionPromptSegments.refId, control.currentRefId),
                eq(
                  taskExecutionPromptSegments.refOrdinal,
                  control.currentOrdinal,
                ),
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  control.currentSegmentOrdinal + 1,
                ),
                eq(
                  taskExecutionPromptSegments.cancellationIntentId,
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
      attempt.taskId !== run.taskId ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== run.runId ||
      attempt.runKind !== run.kind ||
      attempt.refId !== control.currentRefId ||
      attempt.refOrdinal !== control.currentOrdinal ||
      attempt.segmentOrdinal !== control.currentSegmentOrdinal ||
      attempt.state !== "running" ||
      lease.companyId !== run.companyId ||
      lease.taskId !== run.taskId ||
      lease.runId !== run.runId ||
      lease.attemptId !== attempt.id ||
      (cancellation !== null &&
        (cancellation.companyId !== run.companyId ||
          cancellation.taskId !== run.taskId ||
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
      member.ref.taskId !== run.taskId ||
      member.ref.sessionId !== run.sessionId ||
      member.ref.ownershipEpoch !== run.ownershipEpoch ||
      member.ref.targetAgentId !== run.targetAgentId ||
      member.ref.mode !== run.executionMode ||
      (run.executionMode === "owner"
        ? run.kind !== "productive" ||
          member.ref.taskExecutionAuthorityId === null ||
          run.taskExecutionAuthorityId !==
            member.ref.taskExecutionAuthorityId ||
          run.consultExecutionId !== null
        : run.kind !== "consult" ||
          member.ref.taskExecutionAuthorityId !== null ||
          member.ref.consultExecutionId === null ||
          run.taskExecutionAuthorityId !== null ||
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
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.runId, run.runId),
          eq(taskExecutionPromptCapabilities.attemptId, attempt.id),
          eq(taskExecutionPromptCapabilities.leaseId, lease.id),
          eq(
            taskExecutionPromptCapabilities.leaseGeneration,
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
        capability.taskId !== run.taskId ||
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
        capability.taskExecutionAuthorityId !==
          run.taskExecutionAuthorityId ||
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
        await lockAndValidateTaskConsultChain(transaction, {
          ref: member.ref,
          requireLiveAncestors: false,
          leafState: "active",
        });
        consultChainRemainsLive = true;
      } catch (error) {
        if (!(error instanceof TaskConsultChainInvalid)) throw error;
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
        .update(taskExecutionPromptCapabilities)
        .set({
          state: "revoked",
          revocationReason: "lease_expired",
          revokedAt: at,
        })
        .where(
          and(
            eq(taskExecutionPromptCapabilities.runId, run.runId),
            eq(taskExecutionPromptCapabilities.attemptId, attempt.id),
            eq(taskExecutionPromptCapabilities.leaseId, lease.id),
            inArray(taskExecutionPromptCapabilities.state, [
              "pending_setup",
              "active",
            ]),
          ),
        )
        .returning({
          capabilityConnectionId:
            taskExecutionPromptCapabilities.capabilityConnectionId,
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
        .update(taskExecutionAttempts)
        .set({ state: attemptTerminalState, finishedAt: at })
        .where(
          and(
            eq(taskExecutionAttempts.id, attempt.id),
            eq(taskExecutionAttempts.state, "running"),
          ),
        )
        .returning({ id: taskExecutionAttempts.id }),
      "expired attempt lost its running generation",
    );
    exactlyOne(
      await transaction
        .update(taskExecutionLeases)
        .set({
          state: nonSteeringCancellation === null ? "expired" : "revoked",
          releasedAt: at,
        })
        .where(
          and(
            eq(taskExecutionLeases.id, lease.id),
            eq(taskExecutionLeases.attemptId, attempt.id),
            eq(taskExecutionLeases.leaseGeneration, lease.leaseGeneration),
            eq(taskExecutionLeases.state, "active"),
            lte(taskExecutionLeases.expiresAt, at),
          ),
        )
        .returning({ id: taskExecutionLeases.id }),
      "expired lease lost its exact compare-and-set fence",
    );
    const completeCancellation = async (
      intent: CancellationIntentRow,
    ): Promise<void> => {
      const steering = intent.reasonKind === "steering";
      exactlyOne(
        await transaction
          .update(taskExecutionCancellationIntents)
          .set({
            state: "completed",
            acknowledgedAt: intent.acknowledgedAt ?? at,
            completedAt: at,
          })
          .where(
            and(
              eq(taskExecutionCancellationIntents.id, intent.id),
              eq(taskExecutionCancellationIntents.companyId, run.companyId),
              eq(taskExecutionCancellationIntents.taskId, run.taskId),
              eq(taskExecutionCancellationIntents.runId, run.runId),
              eq(taskExecutionCancellationIntents.attemptId, attempt.id),
              eq(taskExecutionCancellationIntents.leaseId, lease.id),
              steering
                ? eq(taskExecutionCancellationIntents.reasonKind, "steering")
                : ne(taskExecutionCancellationIntents.reasonKind, "steering"),
              inArray(taskExecutionCancellationIntents.state, [
                "requested",
                "acknowledged",
              ]),
              steering
                ? isNull(
                    taskExecutionCancellationIntents.nativeCancellationSettledAt,
                  )
                : undefined,
              isNull(taskExecutionCancellationIntents.completedAt),
              isNull(taskExecutionCancellationIntents.failedAt),
              isNull(taskExecutionCancellationIntents.failureCode),
            ),
          )
          .returning({ id: taskExecutionCancellationIntents.id }),
        steering
          ? "expired transmitted steering orphan could not complete its request"
          : "expired cancellation could not complete its exact intent",
      );
      await options.runService.detachCancellation(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
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
          .update(taskExecutionPromptSegments)
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
                taskExecutionPromptSegments.companyId,
                pendingSteeringSegment.companyId,
              ),
              eq(
                taskExecutionPromptSegments.taskId,
                pendingSteeringSegment.taskId,
              ),
              eq(taskExecutionPromptSegments.runId, run.runId),
              eq(taskExecutionPromptSegments.refId, member.ref.id),
              eq(
                taskExecutionPromptSegments.refOrdinal,
                member.row.refOrdinal,
              ),
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                pendingSteeringSegment.segmentOrdinal,
              ),
              eq(
                taskExecutionPromptSegments.cancellationIntentId,
                cancellation.id,
              ),
              inArray(taskExecutionPromptSegments.steeringState, [
                "requested",
                "sent",
              ]),
              eq(
                taskExecutionPromptSegments.promptTransmissionPhase,
                "not_transmitted",
              ),
              isNull(taskExecutionPromptSegments.attemptId),
              isNull(taskExecutionPromptSegments.capabilityConnectionId),
              isNull(taskExecutionPromptSegments.capabilityGeneration),
              isNull(taskExecutionPromptSegments.protocolSettlementState),
            ),
          )
          .returning({ runId: taskExecutionPromptSegments.runId }),
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
      taskId: run.taskId,
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
          .update(taskConsultExecutions)
          .set({
            state: "revoked",
            closeReason: "worker_loss_chain_not_live",
            closedAt: at,
          })
          .where(
            and(
              eq(taskConsultExecutions.id, member.ref.consultExecutionId),
              eq(taskConsultExecutions.state, "active"),
            ),
          )
          .returning({ id: taskConsultExecutions.id }),
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
      await scheduleTaskExecutionAttemptRetryInTransaction(transaction, {
        id: idFactory(),
        companyId: run.companyId,
        taskId: run.taskId,
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
          taskId: run.taskId,
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
            taskId: run.taskId,
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
          id: taskExecutionSessions.id,
          purpose: taskExecutionSessions.purpose,
          state: taskExecutionSessions.state,
        })
        .from(taskExecutionSessions)
        .where(inArray(taskExecutionSessions.id, correlationIds))
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
          taskId: run.taskId,
          ownershipEpoch: run.ownershipEpoch,
          targetAgentId: run.targetAgentId,
          executionMode: run.executionMode,
          taskExecutionAuthorityId: run.taskExecutionAuthorityId,
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
          .update(taskExecutionSessions)
          .set({
            state: "superseded",
            supersessionReason: promptTransmitted
              ? "prompt_failed_incomplete"
              : "lease_expired_before_prompt",
            supersededAt: at,
          })
          .where(
            and(
              inArray(taskExecutionSessions.id, correlationIds),
              inArray(taskExecutionSessions.state, ["eligible", "current"]),
            ),
          )
          .returning({ id: taskExecutionSessions.id });
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
          .update(taskExecutionPromptSegments)
          .set({
            attemptId: null,
            capabilityConnectionId: null,
            capabilityGeneration: null,
          })
          .where(
            and(
              eq(taskExecutionPromptSegments.runId, run.runId),
              eq(taskExecutionPromptSegments.refId, member.ref.id),
              eq(
                taskExecutionPromptSegments.refOrdinal,
                member.row.refOrdinal,
              ),
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                segment.segmentOrdinal,
              ),
              isNull(taskExecutionPromptSegments.protocolSettlementState),
              promptOwnerIsUnbound
                ? and(
                    isNull(taskExecutionPromptSegments.attemptId),
                    isNull(
                      taskExecutionPromptSegments.capabilityConnectionId,
                    ),
                    isNull(taskExecutionPromptSegments.capabilityGeneration),
                  )
                : and(
                    eq(taskExecutionPromptSegments.attemptId, attempt.id),
                    eq(
                      taskExecutionPromptSegments.capabilityConnectionId,
                      promptOwner.capabilityConnectionId!,
                    ),
                    eq(
                      taskExecutionPromptSegments.capabilityGeneration,
                      promptOwner.capabilityGeneration!,
                    ),
                  ),
            ),
          )
          .returning({ runId: taskExecutionPromptSegments.runId }),
        "expired steering attempt could not clear its old prompt ownership",
      );
      const generationRows = await transaction
        .select({ generation: taskExecutionAttempts.attemptGeneration })
        .from(taskExecutionAttempts)
        .where(
          and(
            eq(taskExecutionAttempts.runId, attempt.runId),
            eq(taskExecutionAttempts.refId, attempt.refId!),
            eq(taskExecutionAttempts.refOrdinal, attempt.refOrdinal!),
            eq(taskExecutionAttempts.segmentOrdinal, attempt.segmentOrdinal!),
          ),
        )
        .orderBy(desc(taskExecutionAttempts.attemptGeneration))
        .limit(1)
        .for("update");
      exactlyOne(
        await transaction
          .insert(taskExecutionAttempts)
          .values({
            id: idFactory(),
            companyId: attempt.companyId,
            taskId: attempt.taskId,
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
          .returning({ id: taskExecutionAttempts.id }),
        "expired steering attempt could not create its successor generation",
      );
      return {
        kind: "retry_same_run",
        run: await options.runService.lockRun(transaction, {
          companyId: run.companyId,
          taskId: run.taskId,
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
        .update(taskExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(
          and(
            eq(taskExecutionRefs.id, member.ref.id),
            eq(taskExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(taskExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            eq(taskExecutionHistoryViews.id, member.ref.historyViewId),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
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
          row: taskExecutionRunRefs,
          ref: taskExecutionRefs,
        })
        .from(taskExecutionRunRefs)
        .innerJoin(
          taskExecutionRefs,
          eq(taskExecutionRefs.id, taskExecutionRunRefs.refId),
        )
        .where(
          and(
            eq(taskExecutionRunRefs.runId, run.runId),
            gte(taskExecutionRunRefs.refOrdinal, member.row.refOrdinal),
          ),
        )
        .orderBy(asc(taskExecutionRunRefs.refOrdinal))
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
            .update(taskExecutionRunRefs)
            .set({
              outcome: "released_unsent",
              outcomeReferenceId: idFactory(),
              protocolSettlementState: "not_sent",
              settlementVersion: 1,
              settledAt: at,
            })
            .where(
              and(
                eq(taskExecutionRunRefs.runId, run.runId),
                eq(
                  taskExecutionRunRefs.refOrdinal,
                  candidate.row.refOrdinal,
                ),
                eq(
                  taskExecutionRunRefs.promptTransmissionPhase,
                  "not_transmitted",
                ),
                isNull(taskExecutionRunRefs.protocolSettlementState),
              ),
            )
            .returning({ runId: taskExecutionRunRefs.runId }),
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
            .update(taskExecutionRefs)
            .set({ disposition: "terminal", updatedAt: at })
            .where(
              and(
                inArray(taskExecutionRefs.id, refIds),
                eq(taskExecutionRefs.disposition, "active"),
              ),
            );
          await transaction
            .update(taskExecutionHistoryViews)
            .set({ state: "terminal", finalizedAt: at, updatedAt: at })
            .where(
              and(
                inArray(taskExecutionHistoryViews.refId, refIds),
                inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
              ),
            );
        }
      }
    }

    await revokeAbandonedConsult();

    exactlyOne(
      await transaction
        .update(taskExecutionRunControls)
        .set({
          currentRefId: null,
          currentOrdinal: null,
          currentSegmentOrdinal: null,
        })
        .where(
          and(
            eq(taskExecutionRunControls.runId, run.runId),
            eq(taskExecutionRunControls.currentRefId, member.ref.id),
            eq(
              taskExecutionRunControls.currentOrdinal,
              member.row.refOrdinal,
            ),
            eq(
              taskExecutionRunControls.currentSegmentOrdinal,
              control.currentSegmentOrdinal,
            ),
          ),
        )
        .returning({ runId: taskExecutionRunControls.runId }),
      "expired run could not clear its current prompt control",
    );
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
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
    transaction: TaskSessionDbTransaction,
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
        .from(taskExecutionAttemptRetrySchedules)
        .where(
          and(
            eq(taskExecutionAttemptRetrySchedules.runId, run.runId),
            eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
          ),
        )
        .orderBy(asc(taskExecutionAttemptRetrySchedules.retryAt))
        .limit(2)
        .for("update");
      const schedule = exactlyOne(
        scheduleRows,
        "scheduled retry lost its exact due-time owner",
      );
      if (schedule.retryAt > input.at) {
        return { kind: "scheduled", retryAt: schedule.retryAt };
      }
      const claimed = await claimTaskExecutionAttemptRetryInTransaction(
        transaction,
        {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.runId,
          scheduleId: schedule.id,
          at: input.at,
          successorAttemptId: idFactory(),
          revalidate: async ({ predecessor }) => {
            const ref = exactlyOne(
              await transaction
                .select()
                .from(taskExecutionRefs)
                .where(eq(taskExecutionRefs.id, predecessor.refId!))
                .limit(2),
              "retry lost its immutable ref",
            );
            if (!isTaskExecutionRefDeliveryEligible(ref, "dispatch")) {
              reject("retry ref is no longer delivery-eligible");
            }
          },
        },
      );
      pendingAttempt = claimed.successor;
      run = await options.runService.lockRun(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
      });
    }
    if (!pendingAttempt) {
      const pendingRows = await transaction
        .select()
        .from(taskExecutionAttempts)
        .where(
          and(
            eq(taskExecutionAttempts.runId, run.runId),
            eq(taskExecutionAttempts.state, "pending"),
          ),
        )
        .orderBy(desc(taskExecutionAttempts.attemptGeneration))
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
        taskId: run.taskId,
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
        .from(taskExecutionRunControls)
        .where(eq(taskExecutionRunControls.runId, run.runId))
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
      taskId: run.taskId,
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
    readonly lane: TaskExecutionTargetLaneIdentity;
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
      await lockTaskTreeExecutionGate(
        transaction,
        input.lane.companyId,
        input.lane.taskId,
      );
      const paused = await transaction
        .select({
          active: activeTaskTreePauseHoldExistsSql(
            input.lane.companyId,
            input.lane.taskId,
          ),
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, input.lane.companyId),
            eq(tasks.id, input.lane.taskId),
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

      const occupiedRefIds = await readOccupiedTaskExecutionRefIds(
        transaction,
        {
          companyId: input.lane.companyId,
          taskId: input.lane.taskId,
          sessionId: input.lane.sessionId,
          ownershipEpoch: input.lane.ownershipEpoch,
          targetAgentId: input.lane.targetAgentId,
        },
      );
      const refRows = await transaction
        .select()
        .from(taskExecutionRefs)
        .where(
          and(
            eq(taskExecutionRefs.companyId, input.lane.companyId),
            eq(taskExecutionRefs.taskId, input.lane.taskId),
            eq(taskExecutionRefs.sessionId, input.lane.sessionId),
            eq(
              taskExecutionRefs.ownershipEpoch,
              input.lane.ownershipEpoch,
            ),
            eq(taskExecutionRefs.targetAgentId, input.lane.targetAgentId),
            eq(taskExecutionRefs.disposition, "active"),
            taskExecutionRefDeliveryEligibilitySql("dispatch"),
            occupiedRefIds.length === 0
              ? undefined
              : notInArray(taskExecutionRefs.id, [...occupiedRefIds]),
          ),
        )
        .orderBy(asc(taskExecutionRefs.laneOrdinal))
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
        taskId: created.run.taskId,
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
        taskId: running.taskId,
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
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
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
        refId: taskExecutionRunRefs.refId,
        refOrdinal: taskExecutionRunRefs.refOrdinal,
        promptTransmissionPhase:
          taskExecutionRunRefs.promptTransmissionPhase,
        protocolSettlementState:
          taskExecutionRunRefs.protocolSettlementState,
      })
      .from(taskExecutionRunRefs)
      .where(eq(taskExecutionRunRefs.runId, input.runId))
      .orderBy(asc(taskExecutionRunRefs.refOrdinal))
      .for("update");
    const unsettled = members.filter(
      (member) => member.protocolSettlementState === null,
    );
    const unsettledSegments = await transaction
      .select({
        refOrdinal: taskExecutionPromptSegments.refOrdinal,
        segmentOrdinal: taskExecutionPromptSegments.segmentOrdinal,
        promptTransmissionPhase:
          taskExecutionPromptSegments.promptTransmissionPhase,
      })
      .from(taskExecutionPromptSegments)
      .where(
        and(
          eq(taskExecutionPromptSegments.runId, input.runId),
          isNull(taskExecutionPromptSegments.protocolSettlementState),
        ),
      )
      .orderBy(
        asc(taskExecutionPromptSegments.refOrdinal),
        asc(taskExecutionPromptSegments.segmentOrdinal),
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
          .update(taskExecutionRunRefs)
          .set({
            outcome: "released_unsent",
            outcomeReferenceId: idFactory(),
            protocolSettlementState: "not_sent",
            settlementVersion: 1,
            settledAt: at,
          })
          .where(
            and(
              eq(taskExecutionRunRefs.runId, input.runId),
              eq(taskExecutionRunRefs.refOrdinal, member.refOrdinal),
              eq(taskExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
              isNull(taskExecutionRunRefs.protocolSettlementState),
            ),
          )
          .returning({ runId: taskExecutionRunRefs.runId }),
        "cancelled run lost an unsettled prompt member",
      );
    }
    for (const segment of unsettledSegments) {
      exactlyOne(
        await transaction
          .update(taskExecutionPromptSegments)
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
              eq(taskExecutionPromptSegments.runId, input.runId),
              eq(
                taskExecutionPromptSegments.refOrdinal,
                segment.refOrdinal,
              ),
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                segment.segmentOrdinal,
              ),
              eq(
                taskExecutionPromptSegments.promptTransmissionPhase,
                "not_transmitted",
              ),
              isNull(taskExecutionPromptSegments.protocolSettlementState),
            ),
          )
          .returning({ runId: taskExecutionPromptSegments.runId }),
        "cancelled run lost an unsettled steering segment",
      );
    }
    const refIds = [...new Set(members.map((member) => member.refId))];
    if (refIds.length > 0) {
      await transaction
        .update(taskExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(
          and(
            inArray(taskExecutionRefs.id, refIds),
            eq(taskExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(taskExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            inArray(taskExecutionHistoryViews.refId, refIds),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
          ),
        );
    }
    await transaction
      .update(taskExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
        currentSegmentOrdinal: null,
      })
      .where(eq(taskExecutionRunControls.runId, input.runId));
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: input.companyId,
      taskId: input.taskId,
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
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: TaskExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<FencedTaskExecutionAuthority> {
    exactIdentifier(input.companyId, "authority fence company id");
    const at = validDate(input.at, "authority fence time");
    const reason = (input.reason.trim() || "execution_authority_revoked")
      .slice(0, 200);
    const selector = input.selector;
    let budgetTaskIds: readonly string[] = Object.freeze([]);
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
        budgetTaskIds = Object.freeze(
          (await transaction
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, input.companyId),
                eq(tasks.projectId, selector.scopeId),
              ),
            )).map((task) => task.id),
        );
      }
    } else {
      exactIdentifier(selector.taskId, "authority fence task id");
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
      ? inArray(taskExecutionRefs.targetAgentId, [...selector.agentIds])
      : selector.kind === "budget_scope"
        ? selector.scopeType === "company"
          ? sql<boolean>`true`
          : selector.scopeType === "agent"
            ? eq(taskExecutionRefs.targetAgentId, selector.scopeId)
            : budgetTaskIds.length === 0
              ? sql<boolean>`false`
              : inArray(taskExecutionRefs.taskId, [...budgetTaskIds])
      : selector.kind === "ownership_epoch"
        ? and(
            eq(taskExecutionRefs.taskId, selector.taskId),
            eq(taskExecutionRefs.ownershipEpoch, selector.ownershipEpoch),
          )
        : and(
            eq(taskExecutionRefs.taskId, selector.taskId),
            inArray(taskExecutionRefs.id, [...selector.refIds]),
          );
    const occupiedRefIds = await readOccupiedTaskExecutionRefIds(
      transaction,
      { companyId: input.companyId },
    );
    const refs = await transaction
      .select({
        id: taskExecutionRefs.id,
        companyId: taskExecutionRefs.companyId,
        taskId: taskExecutionRefs.taskId,
        ownershipEpoch: taskExecutionRefs.ownershipEpoch,
        targetAgentId: taskExecutionRefs.targetAgentId,
        laneOrdinal: taskExecutionRefs.laneOrdinal,
      })
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.disposition, "active"),
          refPredicate,
          occupiedRefIds.length === 0
            ? undefined
            : notInArray(taskExecutionRefs.id, [...occupiedRefIds]),
        ),
      )
      .orderBy(asc(taskExecutionRefs.createdAt), asc(taskExecutionRefs.id))
      .for("update");
    const refIds = refs.map((ref) => ref.id);
    if (refIds.length > 0) {
      await transaction
        .update(taskExecutionRefs)
        .set({
          disposition: "invalidated",
          invalidationReason: reason,
          updatedAt: at,
        })
        .where(
          and(
            inArray(taskExecutionRefs.id, refIds),
            eq(taskExecutionRefs.disposition, "active"),
          ),
        );
      await transaction
        .update(taskExecutionHistoryViews)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            inArray(taskExecutionHistoryViews.refId, refIds),
            inArray(taskExecutionHistoryViews.state, [
              "empty",
              "preparing",
              "current",
            ]),
          ),
        );
      await transaction
        .update(taskSessionInputDispositions)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          invalidatedBySourceKind: "task_execution_authority_revocation",
          invalidatedBySourceId: reason,
        })
        .where(
          and(
            inArray(taskSessionInputDispositions.sourceRefId, refIds),
            eq(taskSessionInputDispositions.state, "active"),
          ),
        );
    }

    const correlationPredicate = selector.kind === "agents" ||
        selector.kind === "suspended_agents"
      ? inArray(taskExecutionSessions.targetAgentId, [...selector.agentIds])
      : selector.kind === "budget_scope"
        ? selector.scopeType === "company"
          ? sql<boolean>`true`
          : selector.scopeType === "agent"
            ? eq(taskExecutionSessions.targetAgentId, selector.scopeId)
            : budgetTaskIds.length === 0
              ? sql<boolean>`false`
              : inArray(taskExecutionSessions.taskId, [...budgetTaskIds])
      : selector.kind === "ownership_epoch"
        ? and(
            eq(taskExecutionSessions.taskId, selector.taskId),
            eq(taskExecutionSessions.ownershipEpoch, selector.ownershipEpoch),
          )
        : and(
            eq(taskExecutionSessions.taskId, selector.taskId),
            inArray(taskExecutionSessions.currentRefId, [...selector.refIds]),
          );
    const correlations = await transaction
      .update(taskExecutionSessions)
      .set({
        state: "superseded",
        supersessionReason: reason,
        supersededAt: at,
      })
      .where(
        and(
          eq(taskExecutionSessions.companyId, input.companyId),
          inArray(taskExecutionSessions.state, ["eligible", "current"]),
          correlationPredicate,
        ),
      )
      .returning({ id: taskExecutionSessions.id });

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
          leaseId: taskExecutionLeases.id,
          runId: taskExecutionLeases.runId,
          ref: taskExecutionRefs,
        })
        .from(taskExecutionLeases)
        .innerJoin(
          taskExecutionAttempts,
          eq(taskExecutionAttempts.id, taskExecutionLeases.attemptId),
        )
        .innerJoin(
          taskExecutionRefs,
          eq(taskExecutionRefs.id, taskExecutionAttempts.refId),
        )
        .where(
          and(
            eq(taskExecutionLeases.state, "active"),
            lte(taskExecutionLeases.expiresAt, at),
            eq(taskExecutionAttempts.state, "running"),
            inArray(taskExecutionAttempts.runKind, ["productive", "consult"]),
          ),
        )
        .orderBy(
          sql`case when ${taskExecutionAttempts.runKind} = 'productive' then 0 else 1 end`,
          asc(taskExecutionLeases.expiresAt),
          asc(taskExecutionLeases.id),
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
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, candidate.ref.companyId),
                  eq(taskExecutionRefs.taskId, candidate.ref.taskId),
                  eq(
                    taskExecutionRefs.ownershipEpoch,
                    candidate.ref.ownershipEpoch,
                  ),
                  eq(
                    taskExecutionRefs.targetAgentId,
                    candidate.ref.targetAgentId,
                  ),
                  eq(taskExecutionRefs.disposition, "active"),
                ),
              )
              .orderBy(asc(taskExecutionRefs.laneOrdinal), asc(taskExecutionRefs.id))
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
      const blockedRefIds = await readBlockedActiveTaskExecutionRefIds(
        options.database,
        { now: input.now },
      );
      const rows = await options.database
        .select({ id: taskExecutionRefs.id })
        .from(taskExecutionRefs)
        .innerJoin(taskExecutionHistoryViews, eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId))
        .innerJoin(taskSessions, eq(taskSessions.id, taskExecutionRefs.sessionId))
        .innerJoin(tasks, eq(tasks.id, taskExecutionRefs.taskId))
        .innerJoin(companies, eq(companies.id, taskExecutionRefs.companyId))
        .where(
          and(
            eq(taskExecutionRefs.disposition, "active"),
            taskExecutionRefDeliveryEligibilitySql("dispatch"),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
            eq(taskSessions.integrityState, "ready"),
            isNotNull(taskSessions.refAdmittableAt),
            isNull(taskSessions.timeArchived),
            isNull(taskSessions.purgeFencedAt),
            eq(companies.status, "active"),
            eq(companies.sessionIntegrityState, "ready"),
            inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            sql`${tasks.ownershipEpoch} = ${taskExecutionRefs.ownershipEpoch}`,
            or(
              and(
                eq(taskExecutionRefs.mode, "owner"),
                eq(tasks.ownerKind, "agent"),
                sql`${tasks.ownerAgentId} = ${taskExecutionRefs.targetAgentId}`,
                isNotNull(taskExecutionRefs.taskExecutionAuthorityId),
              ),
              and(
                eq(taskExecutionRefs.mode, "consult"),
                isNull(taskExecutionRefs.taskExecutionAuthorityId),
                isNotNull(taskExecutionRefs.consultExecutionId),
                sql`exists (
                  select 1
                  from ${taskConsultExecutions}
                  where ${taskConsultExecutions.id} = ${taskExecutionRefs.consultExecutionId}
                    and ${taskConsultExecutions.companyId} = ${taskExecutionRefs.companyId}
                    and ${taskConsultExecutions.taskId} = ${taskExecutionRefs.taskId}
                    and ${taskConsultExecutions.state} = 'active'
                    and ${terminalFinalizedTaskExecutionRunExistsSql(
                      taskConsultExecutions.companyId,
                      taskConsultExecutions.taskId,
                      taskConsultExecutions.sourceRunId,
                    )}
                )`,
              ),
            ),
            sql`not exists (
              select 1 from company_session_lifecycle_operations lifecycle
              where lifecycle.company_id = ${taskExecutionRefs.companyId}
                and lifecycle.status in ('fenced','cancelling','purge_ready')
            )`,
            sql`not (${activeTaskTreePauseHoldExistsSql(
              taskExecutionRefs.companyId,
              taskExecutionRefs.taskId,
            )})`,
            blockedRefIds.length === 0
              ? undefined
              : notInArray(taskExecutionRefs.id, [...blockedRefIds]),
          ),
        )
        .orderBy(asc(taskExecutionRefs.createdAt), asc(taskExecutionRefs.id))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    async resolveLaneForPersistedRef(refId: string) {
      exactIdentifier(refId, "execution ref id");
      const ref = await options.database
        .select({
          companyId: taskExecutionRefs.companyId,
          taskId: taskExecutionRefs.taskId,
          sessionId: taskExecutionRefs.sessionId,
          ownershipEpoch: taskExecutionRefs.ownershipEpoch,
          targetAgentId: taskExecutionRefs.targetAgentId,
          mode: taskExecutionRefs.mode,
          disposition: taskExecutionRefs.disposition,
        })
        .from(taskExecutionRefs)
        .where(eq(taskExecutionRefs.id, refId))
        .limit(2);
      if (ref.length > 1) reject("execution ref identity is ambiguous");
      if (!ref[0]) return null;
      const active = await readActiveTaskExecutionRefRunAvailability(
        options.database,
        { refId },
      );
      const settled = active === null
        ? await options.database
            .select({ outcome: taskExecutionRunRefs.outcome })
            .from(taskExecutionRunRefs)
            .where(
              and(
                eq(taskExecutionRunRefs.refId, refId),
                isNotNull(taskExecutionRunRefs.protocolSettlementState),
              ),
            )
            .orderBy(desc(taskExecutionRunRefs.settledAt))
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
      lane: TaskExecutionTargetLaneIdentity;
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

    async assertLeaseCurrent(lease: LeasedTaskExecutionRef) {
      const [row, laneRows] = await Promise.all([
        readTaskExecutionLeaseBinding(options.database, {
          companyId: lease.ref.companyId,
          taskId: lease.ref.taskId,
          runId: lease.runId,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
        }),
        options.database
          .select({
            activeOrdinal: taskExecutionLanes.activeOrdinal,
            activeLeaseGeneration:
              taskExecutionLanes.activeLeaseGeneration,
            activeLeaseId: taskExecutionLanes.activeLeaseId,
            laneOrdinal: taskExecutionRefs.laneOrdinal,
          })
          .from(taskExecutionRefs)
          .innerJoin(
            taskExecutionLanes,
            and(
              eq(
                taskExecutionLanes.companyId,
                taskExecutionRefs.companyId,
              ),
              eq(taskExecutionLanes.taskId, taskExecutionRefs.taskId),
              eq(
                taskExecutionLanes.ownershipEpoch,
                taskExecutionRefs.ownershipEpoch,
              ),
              eq(
                taskExecutionLanes.targetAgentId,
                taskExecutionRefs.targetAgentId,
              ),
            ),
          )
          .where(eq(taskExecutionRefs.id, lease.ref.id))
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
      lease: LeasedTaskExecutionRef;
      reason: TaskExecutionRetry["reason"];
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
        await scheduleTaskExecutionAttemptRetryInTransaction(transaction, {
          id: idFactory(),
          companyId: input.lease.ref.companyId,
          taskId: input.lease.ref.taskId,
          runId: input.lease.runId,
          predecessorAttemptId: input.lease.attemptId,
          reasonCode: input.reason,
          retryAt: validDate(input.retryAt, "retry due time"),
          at,
        });
      });
    },

    async markTerminal(input: {
      lease: LeasedTaskExecutionRef;
      outcome: TaskExecutionTerminal["outcome"];
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
                .from(taskExecutionCancellationIntents)
                .where(eq(taskExecutionCancellationIntents.id, run.cancellationIntentId))
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
              .from(taskExecutionAttempts)
              .where(eq(taskExecutionAttempts.id, input.lease.attemptId))
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
          taskId: settlement.finalization.taskId,
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
      taskId: string;
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
        taskId: input.taskId,
        runId: input.runId,
        agentId: run.targetAgentId,
        outcome: "cancelled",
        reason: input.reason,
        occurredAt: input.finishedAt,
      });
    },

    terminalizeDetachedCancelledRunInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,

  } satisfies TaskExecutionDispatcherRepository & {
    terminalizeCancelledRun(input: {
      companyId: string;
      taskId: string;
      runId: string;
      reason: string;
      finishedAt: Date;
    }): Promise<void>;
    terminalizeDetachedCancelledRunInTransaction(
      transaction: TaskSessionDbTransaction,
      input: {
        companyId: string;
        taskId: string;
        runId: string;
        reason: string;
        finishedAt: Date;
      },
    ): Promise<boolean>;
    fenceRevokedExecutionAuthorityInTransaction(
      transaction: TaskSessionDbTransaction,
      input: {
        companyId: string;
        selector: TaskExecutionAuthorityFenceSelector;
        reason: string;
        at: Date;
      },
    ): Promise<FencedTaskExecutionAuthority>;
  };
  return repository;
}

export type PostgresTaskExecutionDispatcherRepository = ReturnType<
  typeof createPostgresTaskExecutionDispatcherRepository
>;
