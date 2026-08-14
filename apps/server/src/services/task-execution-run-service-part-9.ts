import { taskExecutionRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import type { TaskExecutionAttemptCancellationSignal } from "./task-execution-dispatcher.js";
import {
  type ReboundSteerableTaskExecutionRun,
  type TaskExecutionRunIdentity,
  TaskExecutionRunInvariantViolation,
} from "./task-execution-run-service-part-1-section-1.js";
import type { TaskExecutionSteeringResult } from "./task-execution-steering-results.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/** Attach the exact P14 cancellation intent without taking ownership of it. */
export async function attachSteeringCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly cancellationIntentId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(taskExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(taskExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning({ id: taskExecutionRuns.id });
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("Steering cancellation lost the exact active run attempt");
  }
}

/**
 * Clear only the settled P14 attempt and its exact cancellation pointer
 * before the positive steering segment is rebound to a new attempt.
 */
export async function clearSteeringCancellationAndAttemptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly cancellationIntentId: string;
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      currentAttemptId: null,
      currentLeaseId: null,
      cancellationIntentId: null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(taskExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(taskExecutionRuns.currentLeaseId, input.expectedLeaseId),
        eq(taskExecutionRuns.cancellationIntentId, input.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning({ id: taskExecutionRuns.id });
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("Steering rebound lost the exact cancelled run attempt");
  }
}

/**
 * Re-lock the same active envelope after the cancellation transaction has
 * settled and detached its old prompt attempt. This is the final lifecycle
 * fence before a persisted positive segment becomes resumable.
 */
export async function lockReboundSteeringRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly ownershipEpoch: number;
    readonly targetAgentId: string;
  },
): Promise<ReboundSteerableTaskExecutionRun> {
  const rows = await transaction
    .select()
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
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
        run.taskExecutionAuthorityId === null ||
        run.consultExecutionId !== null)) ||
    (run.kind === "consult" &&
      (run.executionMode !== "consult" ||
        run.taskExecutionAuthorityId !== null ||
        run.consultExecutionId === null))
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "Steering segment cannot resume against the selected run lifecycle",
    );
  }
  return {
    companyId: run.companyId,
    taskId: run.taskId,
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
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: run.startedAt,
    finishedAt: null,
  };
}

export type TaskExecutionSteeringActor =
  { readonly kind: "user"; readonly userId: string } | { readonly kind: "agent"; readonly agentId: string };

/**
 * The sole selector-bearing continuation request. There is intentionally no
 * Session id, target ACP id, alias, or fallback selector in this contract.
 */
export interface RequestTaskExecutionSteeringInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly exactMessage: string;
  readonly sourceCommentId: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly actor: TaskExecutionSteeringActor;
}

export interface RequestedTaskExecutionSteering {
  readonly companyId: string;
  readonly taskId: string;
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
  readonly cancellation: TaskExecutionAttemptCancellationSignal;
}

export interface ReboundTaskExecutionSteering {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

export type TaskExecutionSteeringCancellationSettlement =
  | {
      readonly kind: "settled";
      readonly cancellationIntentId: string;
    }
  | {
      /** The exact old prompt is still open; durable recovery may retry. */
      readonly kind: "pending";
      readonly cancellationIntentId: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly cancellationIntentId: string;
      readonly reason: string;
    };

export type PendingTaskExecutionSteeringForSource =
  | {
      readonly kind: "requested";
      readonly request: RequestedTaskExecutionSteering;
    }
  | {
      readonly kind: "rebound";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | { readonly kind: "resumed" }
  | {
      readonly kind: "terminal";
      readonly result: TaskExecutionSteeringResult;
    }
  | { readonly kind: "ambiguous"; readonly reason: string };

export type ContinuedPendingTaskExecutionSteering =
  | {
      readonly kind: "continued_requested";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | {
      readonly kind: "continued_rebound";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | {
      readonly kind: "already_resumed";
    }
  | {
      readonly kind: "already_settled";
      readonly result: TaskExecutionSteeringResult;
    }
  | {
      /** The source remains durably requested and will be retried by recovery. */
      readonly kind: "still_pending";
    };

export interface RecoverableTaskExecutionSteeringSource {
  readonly companyId: string;
  readonly taskId: string;
  readonly sourceCommentId: string;
}

/**
 * Transactional DB owner for P14. `requestInTransaction` locks the exact run,
 * current run-control tuple, prompt, attempt/lease, capability, and steering
 * correlation; appends one positive segment; revokes the old capability; and
 * persists the exact-attempt steering cancellation intent in the caller's
 * comment transaction.
 */
export interface TaskExecutionSteeringRepository {
  requestInTransaction(
    transaction: TaskSessionDbTransaction,
    input: RequestTaskExecutionSteeringInput,
  ): Promise<RequestedTaskExecutionSteering>;
  recordCancellationSignal(input: {
    readonly request: RequestedTaskExecutionSteering;
    readonly delivered: boolean;
  }): Promise<void>;
  awaitCancellationSettlement(
    request: RequestedTaskExecutionSteering,
  ): Promise<TaskExecutionSteeringCancellationSettlement>;
  markAmbiguous(input: {
    readonly request: RequestedTaskExecutionSteering;
    readonly reason: string;
  }): Promise<void>;
  rebindAfterCancellation(request: RequestedTaskExecutionSteering): Promise<ReboundTaskExecutionSteering>;
  markResumeReady(rebound: ReboundTaskExecutionSteering): Promise<void>;
  findPendingForSource(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sourceCommentId: string;
  }): Promise<PendingTaskExecutionSteeringForSource>;
  listRecoverableSources(limit: number): Promise<readonly RecoverableTaskExecutionSteeringSource[]>;
}

export interface TaskExecutionSteeringCancellationPort {
  /** Abort only the exact fenced attempt. False may mean natural settlement won. */
  signalAttemptCancellation(input: TaskExecutionAttemptCancellationSignal): boolean;
}

export interface TaskExecutionSteeringResumePort {
  /**
   * Schedule the persisted positive segment on the same Paperclip run. The
   * attempt executor resolves native resume or new-session launch from canonical state.
   */
  resumeSteering(input: ReboundTaskExecutionSteering): Promise<void>;
}
