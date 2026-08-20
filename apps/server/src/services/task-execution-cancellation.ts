import { randomUUID } from "node:crypto";
import { createTaskExecutionCancellationServiceGroup1 } from "./task-execution-cancellation-group-1.js";
import { createTaskExecutionCancellationServiceGroup2 } from "./task-execution-cancellation-group-2.js";
import {
  type TaskExecutionCancellationServiceContext,
  type TaskExecutionCancellationServiceOptions,
  TERMINAL_RUN_STATUSES,
  pageActiveRuns,
  type TaskExecutionCancellationResult,
  attemptSignal,
  boundedReason,
  cancellationActorColumns,
  exactIdentifier,
  reject,
  terminalizedCancellationResult,
  type CancellationRow,
  type RequestedRunCancellation,
} from "./task-execution-cancellation-foundation.js";

import {
  companies,
  taskExecutionCancellationIntents,
  taskExecutionAttempts,
  taskExecutionLeases,
} from "@paperclipai/db";
import { and, inArray, eq } from "drizzle-orm";
import { resolveTaskExecutionRunIdentityById } from "./task-execution-run-service.js";
import {
  reconcileCompanySessionLifecycleOperationInTx,
  acknowledgeCompanyCancellationIntentsInTx,
  failCompanyCancellationIntentInTx,
  reconcileCompanyCancellationIntentInTx,
} from "./task-session-lifecycle.js";

export function createTaskExecutionCancellationServiceGroup3(
  context: TaskExecutionCancellationServiceContext,
  group1: ReturnType<typeof createTaskExecutionCancellationServiceGroup1>,
  group2: ReturnType<typeof createTaskExecutionCancellationServiceGroup2>,
) {
  const options = context;
  const { now } = context;
  const {
    processCancellableRun,
    requestLockedRunCancellationsInTransaction,
    requestAgentCancellationsWithFenceInTransaction,
    requestAgentCancellationsInTransaction,
    requestAgentSuspensionsInTransaction,
    validateBudgetScope,
    requestBudgetScopeSuspensionInTransaction,
    requestScopeCancellationsInTransaction,
    requestRunningTaskInterruptionsInTransaction,
  } = Object.assign({}, group1, group2);
  async function reconcileAcknowledgedIntent(
    intent: CancellationRow,
  ): Promise<TaskExecutionCancellationResult> {
    const run = await options.runService.readRun({
      companyId: intent.companyId,
      taskId: intent.taskId,
      runId: intent.runId,
    });
    if (!run) reject("cancellation intent lost its canonical run");
    const [attemptRows, leaseRows] = await Promise.all([
      options.database
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.id, intent.attemptId))
        .limit(2),
      intent.leaseId
        ? options.database
            .select()
            .from(taskExecutionLeases)
            .where(eq(taskExecutionLeases.id, intent.leaseId))
            .limit(2)
        : Promise.resolve([]),
    ]);
    if (attemptRows.length !== 1 || leaseRows.length > 1) {
      reject("cancellation intent has an ambiguous attempt or lease");
    }
    const attempt = attemptRows[0]!;
    const lease = leaseRows[0] ?? null;
    const signal = attemptSignal({ run, attempt, lease });
    if (signal) {
      options.dispatcher.signalAttemptCancellation(signal);
    }
    const workerActive = signal ? options.dispatcher.isAttemptActive(signal) : false;
    if (workerActive) {
      return {
        runId: run.runId,
        alreadyTerminal: false,
        cancellationIntentId: intent.id,
        state: "acknowledged",
      };
    }
    const reconciliationAt = now();
    const cancellationReason = `${intent.reasonKind}_cancellation`;
    const completion = await options.database.transaction((transaction) =>
      reconcileCompanyCancellationIntentInTx(transaction, {
        intentId: intent.id,
        now: reconciliationAt,
      }),
    );
    if (!completion) {
      return {
        runId: run.runId,
        alreadyTerminal: false,
        cancellationIntentId: intent.id,
        state: "acknowledged",
      };
    }
    await options.settlement.terminalizeCancelledRun({
      companyId: intent.companyId,
      taskId: intent.taskId,
      runId: intent.runId,
      reason: cancellationReason,
      finishedAt: reconciliationAt,
    });
    if (completion.operation) {
      await options.database.transaction((transaction) =>
        reconcileCompanySessionLifecycleOperationInTx(transaction, {
          companyId: intent.companyId,
          lifecycleOperationId: completion.operation!.id,
          now: reconciliationAt,
        }),
      );
    }
    return {
      runId: run.runId,
      alreadyTerminal: false,
      cancellationIntentId: intent.id,
      state: "completed",
    };
  }

  async function reconcileIntent(intentId: string): Promise<TaskExecutionCancellationResult | null> {
    exactIdentifier(intentId, "cancellation intent id");
    const initial = await options.database
      .select()
      .from(taskExecutionCancellationIntents)
      .where(eq(taskExecutionCancellationIntents.id, intentId))
      .limit(2);
    if (initial.length === 0) return null;
    if (initial.length !== 1) reject("cancellation intent identity is ambiguous");
    const intent = initial[0]!;
    if (intent.state === "completed" || intent.state === "failed") {
      return {
        runId: intent.runId,
        alreadyTerminal: intent.state === "completed",
        cancellationIntentId: intent.id,
        state: intent.state,
      };
    }
    const acknowledged = await options.database.transaction((transaction) =>
      acknowledgeCompanyCancellationIntentsInTx(transaction, {
        companyId: intent.companyId,
        intentIds: [intent.id],
        limit: 1,
        now: now(),
      }),
    );
    if (acknowledged.length !== 1) return null;
    try {
      return await reconcileAcknowledgedIntent(acknowledged[0]!);
    } catch (error) {
      const failureCode = boundedReason(
        error instanceof Error ? error.message : String(error),
        "cancellation_reconcile_failed",
      );
      await options.database.transaction((transaction) =>
        failCompanyCancellationIntentInTx(transaction, {
          intentId: intent.id,
          failureCode,
          now: now(),
        }),
      );
      throw error;
    }
  }

  async function reconcileRequestedCancellations(requested: {
    readonly companyId: string;
    readonly requests: readonly RequestedRunCancellation[];
  }): Promise<readonly TaskExecutionCancellationResult[]> {
    exactIdentifier(requested.companyId, "company id");
    const results: TaskExecutionCancellationResult[] = [];
    for (const request of requested.requests) {
      if (request.companyId !== requested.companyId) {
        reject("cancellation bundle crossed its company");
      }
      if (request.state === "terminalized") {
        results.push(await terminalizedCancellationResult(options.pluginDomainEvents, request));
        continue;
      }
      if (request.cancellationIntentId === null) {
        reject("requested prompt cancellation lost its durable intent");
      }
      const result = await reconcileIntent(request.cancellationIntentId);
      if (!result || result.runId !== request.runId) {
        reject("cancellation reconciliation crossed its requested run");
      }
      results.push(result);
    }
    return Object.freeze(results);
  }

  async function cancelRun(
    runId: string,
    reason = "Task execution was cancelled",
  ): Promise<TaskExecutionCancellationResult | null> {
    exactIdentifier(runId, "run id");
    const identity = await resolveTaskExecutionRunIdentityById(options.database, runId);
    if (!identity) return null;
    const cancellationReason = boundedReason(reason, "authority_cancellation");
    const created = await options.database.transaction(async (transaction) => {
      const run = await options.runService.lockRun(transaction, identity);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return { kind: "terminal" as const, run };
      }
      return {
        kind: "request" as const,
        request: await processCancellableRun(transaction, run, {
          reason: cancellationReason,
          at: now(),
          reasonKind: "authority",
          actor: cancellationActorColumns({ kind: "system" }),
        }),
      };
    });
    if (created.kind === "terminal") {
      return {
        runId,
        alreadyTerminal: true,
        cancellationIntentId: null,
        state: "terminal",
      };
    }
    if (created.request.state === "terminalized") {
      const result = await terminalizedCancellationResult(options.pluginDomainEvents, created.request);
      return { ...result, alreadyTerminal: false };
    }
    return reconcileIntent(created.request.cancellationIntentId);
  }

  async function cancelRunIds(runIds: readonly string[], reason: string) {
    const results = await Promise.all([...new Set(runIds)].map((runId) => cancelRun(runId, reason)));
    return results.filter((result): result is TaskExecutionCancellationResult => result !== null);
  }
  return {
    reconcileAcknowledgedIntent,
    reconcileIntent,
    reconcileRequestedCancellations,
    cancelRun,
    cancelRunIds,
  };
}

type CancellationCore = ReturnType<typeof createTaskExecutionCancellationServiceGroup1> &
  ReturnType<typeof createTaskExecutionCancellationServiceGroup2> &
  ReturnType<typeof createTaskExecutionCancellationServiceGroup3>;

export function createTaskExecutionCancellationPublicOperations(input: {
  readonly options: TaskExecutionCancellationServiceOptions;
  readonly now: () => Date;
  readonly core: CancellationCore;
}) {
  const { options, now, core } = input;

  async function reconcilePending(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = await options.database
      .select({ id: taskExecutionCancellationIntents.id })
      .from(taskExecutionCancellationIntents)
      .where(
        and(
          inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged"]),
          inArray(taskExecutionCancellationIntents.reasonKind, [
            "lifecycle",
            "authority",
            "timeout",
            "lease_expired",
          ]),
        ),
      )
      .limit(boundedLimit);
    const results = [];
    for (const row of rows) results.push(await core.reconcileIntent(row.id));
    return results.filter((result): result is TaskExecutionCancellationResult => result !== null);
  }

  async function reconcileCompanyLifecycle(input: {
    companyId: string;
    lifecycleOperationId: string;
    intentIds: readonly string[];
    runIds: readonly string[];
  }) {
    for (const intentId of input.intentIds) await core.reconcileIntent(intentId);
    for (const runId of input.runIds) {
      const identity = await resolveTaskExecutionRunIdentityById(options.database, runId);
      if (!identity || identity.companyId !== input.companyId) continue;
      const run = await options.runService.readRun(identity);
      if (
        run &&
        !TERMINAL_RUN_STATUSES.has(run.status) &&
        run.currentAttemptId === null &&
        run.currentLeaseId === null &&
        run.cancellationIntentId === null
      ) {
        await options.settlement.terminalizeCancelledRun({
          ...identity,
          reason: "lifecycle_cancellation",
          finishedAt: now(),
        });
      }
    }
    return options.database.transaction((transaction) =>
      reconcileCompanySessionLifecycleOperationInTx(transaction, {
        companyId: input.companyId,
        lifecycleOperationId: input.lifecycleOperationId,
        now: now(),
      }),
    );
  }

  async function suspendBudgetScopeWork(scope: {
    companyId: string;
    scopeType: "company" | "project" | "agent";
    scopeId: string;
  }) {
    const requested = await options.database.transaction((transaction) =>
      core.requestBudgetScopeSuspensionInTransaction(transaction, {
        ...scope,
        reason: "budget_hard_stop",
        actor: { kind: "system" },
        now: now(),
      }),
    );
    const settlements = await core.reconcileRequestedCancellations(requested);
    return { requested, settlements };
  }

  async function drainRunningRunsForShutdown(signal = "paperclip_worker_shutdown") {
    const companyRows = await options.database.select({ id: companies.id }).from(companies);
    const results = [];
    for (const company of companyRows) {
      const runs = await pageActiveRuns(options.runService, company.id);
      results.push(
        ...(await core.cancelRunIds(
          runs.map((run) => run.runId),
          signal,
        )),
      );
    }
    return results;
  }

  return {
    reconcilePending,
    reconcileCompanyLifecycle,
    suspendBudgetScopeWork,
    drainRunningRunsForShutdown,
  };
}

export * from "./task-execution-cancellation-foundation.js";

export function createTaskExecutionCancellationService(options: TaskExecutionCancellationServiceOptions) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const groupContext: TaskExecutionCancellationServiceContext = {
    ...options,
    now,
    idFactory,
  };
  const group1 = createTaskExecutionCancellationServiceGroup1(groupContext);
  const group2 = createTaskExecutionCancellationServiceGroup2(groupContext, group1);
  const group3 = createTaskExecutionCancellationServiceGroup3(groupContext, group1, group2);
  const core = Object.assign({}, group1, group2, group3);
  return Object.freeze({
    ...core,
    ...createTaskExecutionCancellationPublicOperations({
      options,
      now,
      core,
    }),
  });
}

export type TaskExecutionCancellationService = ReturnType<typeof createTaskExecutionCancellationService>;
