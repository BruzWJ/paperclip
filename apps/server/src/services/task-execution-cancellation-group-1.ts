import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { type TaskExecutionRunEnvelope } from "./task-execution-run-service.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import {
  boundedReason,
  cancellationActorColumns,
  exactDate,
  exactIdentifier,
  reject,
  type RequestedAgentRunCancellations,
  type RequestedRunCancellation,
  type TaskExecutionCancellationActor,
  type TaskExecutionCancellationServiceContext,
} from "./task-execution-cancellation-foundation.js";

export function createTaskExecutionCancellationServiceGroup1(
  context: TaskExecutionCancellationServiceContext,
) {
  const options = context;
  const { now, idFactory } = context;
  /**
   * Shared per-run cancellation step used by the locked-run and agent-fence
   * paths. Returns the request entry the caller records for this run.
   */
  async function processCancellableRun(
    transaction: TaskSessionDbTransaction,
    run: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly targetAgentId: string;
      readonly cancellationIntentId: string | null;
      readonly currentAttemptId: string | null;
      readonly currentLeaseId: string | null;
    },
    params: {
      readonly reason: string;
      readonly at: Date;
      readonly reasonKind: "authority" | "lifecycle";
      readonly actor: ReturnType<typeof cancellationActorColumns>;
    },
  ): Promise<RequestedRunCancellation> {
    if (run.cancellationIntentId !== null) {
      return {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        cancellationIntentId: run.cancellationIntentId,
        state: "intent_requested",
      };
    }
    if (run.currentAttemptId === null && run.currentLeaseId === null) {
      const terminalized = await options.settlement.terminalizeDetachedCancelledRunInTransaction(
        transaction,
        {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.runId,
          reason: params.reason,
          finishedAt: params.at,
        },
      );
      if (!terminalized) {
        reject("detached cancellation lost its nonterminal run");
      }
      return {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        cancellationIntentId: null,
        state: "terminalized",
        terminalEvent: {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.runId,
          agentId: run.targetAgentId,
          outcome: "cancelled",
          reason: params.reason,
          occurredAt: params.at,
        },
      };
    }
    if (run.currentAttemptId === null || run.currentLeaseId === null) {
      reject("active run has a partial prompt-attempt attachment");
    }
    const [attemptRows, leaseRows] = await Promise.all([
      transaction
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.id, run.currentAttemptId))
        .limit(2)
        .for("update"),
      transaction
        .select()
        .from(taskExecutionLeases)
        .where(eq(taskExecutionLeases.id, run.currentLeaseId))
        .limit(2)
        .for("update"),
    ]);
    if (attemptRows.length !== 1 || leaseRows.length !== 1) {
      reject("active run has an ambiguous attempt or lease");
    }
    const attempt = attemptRows[0]!;
    const lease = leaseRows[0]!;
    if (
      attempt.runId !== run.runId ||
      lease.runId !== run.runId ||
      lease.attemptId !== attempt.id ||
      lease.id !== run.currentLeaseId ||
      attempt.id !== run.currentAttemptId ||
      lease.state !== "active"
    ) {
      reject("active run cancellation crossed its exact attempt lease");
    }
    const cancellationIntentId = idFactory();
    await transaction.insert(taskExecutionCancellationIntents).values({
      id: cancellationIntentId,
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      attemptId: attempt.id,
      leaseId: lease.id,
      reasonKind: params.reasonKind,
      ...params.actor,
      state: "requested",
      requestedAt: params.at,
      acknowledgedAt: null,
      nativeCancellationSettledAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      createdAt: params.at,
    });
    await options.runService.attachCancellation(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      expectedAttemptId: attempt.id,
      expectedLeaseId: lease.id,
      cancellationIntentId,
      at: params.at,
    });
    return {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      cancellationIntentId,
      state: "intent_requested",
    };
  }

  async function requestLockedRunCancellationsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly runs: readonly TaskExecutionRunEnvelope[];
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly at: Date;
      readonly reasonKind?: "authority" | "lifecycle";
    },
  ): Promise<readonly RequestedRunCancellation[]> {
    const actor = cancellationActorColumns(input.actor);
    const requests: RequestedRunCancellation[] = [];
    for (const run of input.runs) {
      requests.push(
        await processCancellableRun(transaction, run, {
          reason: input.reason,
          at: input.at,
          reasonKind: input.reasonKind ?? "authority",
          actor,
        }),
      );
    }
    return Object.freeze(requests);
  }

  /**
   * Graph-locked agent termination boundary. The caller mutates agent
   * authority and requests every exact prompt cancellation in the same DB
   * transaction, then reconciles the returned identities after commit.
   */
  async function requestAgentCancellationsWithFenceInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
    fenceKind: "agents" | "suspended_agents",
  ): Promise<RequestedAgentRunCancellations> {
    exactIdentifier(input.companyId, "company id");
    const agentIds = [...new Set(input.agentIds)];
    for (const agentId of agentIds) {
      exactIdentifier(agentId, "cancelled agent id");
    }
    const reason = boundedReason(input.reason, "agent_authority_revoked");
    const at = exactDate(input.now, "agent cancellation request time");
    const actor = cancellationActorColumns(input.actor);
    if (agentIds.length === 0) {
      return Object.freeze({
        companyId: input.companyId,
        agentIds: Object.freeze([]),
        reason,
        fence: Object.freeze({
          refIds: Object.freeze([]),
          correlationIds: Object.freeze([]),
        }),
        requests: Object.freeze([]),
      });
    }

    const fence = await options.settlement.fenceRevokedExecutionAuthorityInTransaction(transaction, {
      companyId: input.companyId,
      selector: { kind: fenceKind, agentIds },
      reason,
      at,
    });
    const runRows = await options.runService.lockActiveRunsForAgentsInTransaction(transaction, {
      companyId: input.companyId,
      agentIds,
    });
    const requests: RequestedRunCancellation[] = [];
    for (const run of runRows) {
      requests.push(
        await processCancellableRun(transaction, run, {
          reason,
          at,
          reasonKind: "authority",
          actor,
        }),
      );
    }
    return Object.freeze({
      companyId: input.companyId,
      agentIds: Object.freeze(agentIds),
      reason,
      fence,
      requests: Object.freeze(requests),
    });
  }

  /** Permanent authority revocation for the selected tombstoned agent. */
  function requestAgentCancellationsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedAgentRunCancellations> {
    return requestAgentCancellationsWithFenceInTransaction(transaction, input, "agents");
  }

  /**
   * System-pause fence for descendants. Their queued execution refs and
   * target-session correlations are invalidated.
   */
  function requestAgentSuspensionsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedAgentRunCancellations> {
    return requestAgentCancellationsWithFenceInTransaction(transaction, input, "suspended_agents");
  }
  return {
    processCancellableRun,
    requestLockedRunCancellationsInTransaction,
    requestAgentCancellationsWithFenceInTransaction,
    requestAgentCancellationsInTransaction,
    requestAgentSuspensionsInTransaction,
  };
}
