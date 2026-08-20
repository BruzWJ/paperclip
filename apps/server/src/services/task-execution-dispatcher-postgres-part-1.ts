import {
  Db,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunRefs,
} from "@paperclipai/db";
import type { TaskExecutionRef } from "@paperclipai/shared";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import { type PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import type {
  LeasedTaskExecutionRef,
  TaskExecutionRetry,
  TaskExecutionTargetLaneIdentity,
  TaskExecutionTerminal,
} from "./task-execution-dispatcher.js";
import type { PostgresTaskExecutionFinalizationWriter } from "./task-execution-finalization-postgres.js";
import { isTaskExecutionRefDeliveryEligible } from "./task-execution-ref-delivery.js";
import type { TaskExecutionRunEnvelope } from "./task-execution-run-service-part-1-section-1.js";
import type { TaskExecutionRunService } from "./task-execution-run-service-part-10.js";

export type PersistedTaskExecutionRefRow = typeof taskExecutionRefs.$inferSelect;

export type RefRow = PersistedTaskExecutionRefRow;

export type RunRow = TaskExecutionRunEnvelope;

export type AttemptRow = typeof taskExecutionAttempts.$inferSelect;

export type CancellationIntentRow = typeof taskExecutionCancellationIntents.$inferSelect;

export type PromptCapabilityRow = typeof taskExecutionPromptCapabilities.$inferSelect;

export type PromptOwnerRow = typeof taskExecutionRunRefs.$inferSelect;

export type LaneRefIdentity = Pick<
  RefRow,
  "id" | "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId" | "laneOrdinal"
>;

export type LockedLaneLeaseClaim =
  | { readonly kind: "idle" }
  | {
      readonly kind: "retry";
      readonly ordinal: number;
      readonly leaseGeneration: number;
      readonly leaseId: string;
    };

export type LeaseForLaneResult =
  | { readonly kind: "queued" }
  | {
      readonly kind: "leased";
      readonly lease: LeasedTaskExecutionRef;
      readonly run: RunRow;
    };

export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

export const MAX_CREATOR_UPDATE_BATCH = 32;

export function targetLaneIdentity(
  ref: Pick<RefRow, "companyId" | "taskId" | "sessionId" | "ownershipEpoch" | "targetAgentId">,
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
  readonly finalizer: Pick<PostgresTaskExecutionFinalizationWriter, "finalize" | "finalizeInTransaction">;
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

export function reject(message: string): never {
  throw new PostgresTaskExecutionDispatchRejected(message);
}

export function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

export function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} is invalid`);
  }
  return value;
}

export function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
}

export type ExpiredPromptClosureDecision =
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
  if (capability.revocationReason === null || capability.revokedAt === null) {
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
        (owner.outcome !== "succeeded" && owner.outcome !== "refused" && owner.outcome !== "cancelled")
      ) {
        reject("protocol-settled recovery lost its durable prompt outcome");
      }
      return {
        kind: "terminal",
        outcome: owner.outcome === "cancelled" ? "cancelled" : "succeeded",
        reason: capability.revocationReason,
        protocolSettled: true,
      };
    default:
      reject("revoked expired prompt has no canonical recovery decision");
  }
}

/** Single canonical PostgreSQL-row to domain-ref projection. */
export function projectPersistedTaskExecutionRef(row: PersistedTaskExecutionRefRow): TaskExecutionRef {
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

export function sameBatchScope(first: RefRow, candidate: RefRow): boolean {
  return (
    candidate.sourceKind === "task_update" &&
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
    isTaskExecutionRefDeliveryEligible(candidate, "dispatch")
  );
}

export function leaseProjection(
  refs: readonly RefRow[],
  runId: string,
  attempt: AttemptRow,
  leaseId: string,
  leaseGeneration: number,
): LeasedTaskExecutionRef {
  const first = exactlyOne(refs.slice(0, 1), "attempt lost its first run ref");
  if (attempt.refOrdinal === null) {
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
    sessionOperation: attempt.sessionOperation,
    refOrdinal: attempt.refOrdinal,
    leaseId,
    leaseGeneration,
    attemptNumber: attempt.attemptGeneration,
    batch: Object.freeze(members),
  });
}
