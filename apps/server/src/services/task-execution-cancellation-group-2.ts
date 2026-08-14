import { createTaskExecutionCancellationServiceGroup1 } from "./task-execution-cancellation-group-1.js";
import {
  boundedReason,
  exactDate,
  exactIdentifier,
  reject,
  type RequestedBudgetScopeSuspension,
  type RequestedRunningTaskInterruptions,
  type RequestedScopedRunCancellations,
  type TaskExecutionCancellationActor,
  type TaskExecutionCancellationServiceContext,
} from "./task-execution-cancellation-foundation.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function createTaskExecutionCancellationServiceGroup2(
  context: TaskExecutionCancellationServiceContext,
  group1: ReturnType<typeof createTaskExecutionCancellationServiceGroup1>,
) {
  const options = context;
  const { now } = context;
  const {
    processCancellableRun,
    requestLockedRunCancellationsInTransaction,
    requestAgentCancellationsWithFenceInTransaction,
    requestAgentCancellationsInTransaction,
    requestAgentSuspensionsInTransaction,
  } = Object.assign({}, group1);
  function validateBudgetScope(input: {
    readonly companyId: string;
    readonly scopeType: "company" | "project" | "agent";
    readonly scopeId: string;
  }): void {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.scopeId, "budget scope id");
    if (input.scopeType === "company" && input.scopeId !== input.companyId) {
      reject("company budget scope must target its exact company");
    }
  }

  async function requestBudgetScopeSuspensionInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
      readonly reason?: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedBudgetScopeSuspension> {
    validateBudgetScope(input);
    const at = exactDate(input.now, "budget suspension time");
    const reason = boundedReason(input.reason, "budget_hard_stop");
    const fence = await options.settlement.fenceRevokedExecutionAuthorityInTransaction(transaction, {
      companyId: input.companyId,
      selector: {
        kind: "budget_scope",
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
      reason,
      at,
    });
    const runs = await options.runService.lockActiveRunsForBudgetScopeInTransaction(transaction, {
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    });
    const requests = await requestLockedRunCancellationsInTransaction(transaction, {
      runs,
      reason,
      actor: input.actor,
      at,
      reasonKind: "lifecycle",
    });
    return Object.freeze({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      reason,
      fence,
      requests,
    });
  }

  async function requestScopeCancellationsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly selector:
        | { readonly kind: "ownership_epoch"; readonly ownershipEpoch: number }
        | { readonly kind: "refs"; readonly refIds: readonly string[] };
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedScopedRunCancellations> {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.taskId, "task id");
    const reason = boundedReason(input.reason, "execution_authority_revoked");
    const at = exactDate(input.now, "scope cancellation request time");
    const selector =
      input.selector.kind === "ownership_epoch"
        ? (() => {
            if (!Number.isSafeInteger(input.selector.ownershipEpoch) || input.selector.ownershipEpoch < 1) {
              reject("ownership epoch must be a positive integer");
            }
            return Object.freeze({
              kind: "ownership_epoch" as const,
              ownershipEpoch: input.selector.ownershipEpoch,
            });
          })()
        : (() => {
            const refIds = [...new Set(input.selector.refIds)];
            for (const refId of refIds) {
              exactIdentifier(refId, "execution ref id");
            }
            return Object.freeze({
              kind: "refs" as const,
              refIds: Object.freeze(refIds),
            });
          })();
    // Finalization owns the run row before it can publish a routed ref. Keep
    // the same run -> ref lock order here so the fence observes every ref
    // committed by a finalizer that was already in flight.
    const runs = await options.runService.lockActiveRunsForScopeInTransaction(
      transaction,
      selector.kind === "ownership_epoch"
        ? {
            companyId: input.companyId,
            taskId: input.taskId,
            ownershipEpoch: selector.ownershipEpoch,
          }
        : {
            companyId: input.companyId,
            taskId: input.taskId,
            refIds: selector.refIds,
          },
    );
    const fence = await options.settlement.fenceRevokedExecutionAuthorityInTransaction(
      transaction,
      selector.kind === "ownership_epoch"
        ? {
            companyId: input.companyId,
            selector: {
              kind: "ownership_epoch",
              taskId: input.taskId,
              ownershipEpoch: selector.ownershipEpoch,
            },
            reason,
            at,
          }
        : {
            companyId: input.companyId,
            selector: {
              kind: "refs",
              taskId: input.taskId,
              refIds: selector.refIds,
            },
            reason,
            at,
          },
    );
    const requests = await requestLockedRunCancellationsInTransaction(transaction, {
      runs,
      reason,
      actor: input.actor,
      at,
    });
    return Object.freeze({
      companyId: input.companyId,
      taskId: input.taskId,
      selector,
      reason,
      fence,
      requests,
    });
  }

  async function requestRunningTaskInterruptionsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly ownershipEpoch: number;
      readonly reason: string;
      readonly actor: TaskExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedRunningTaskInterruptions> {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.taskId, "task id");
    if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
      reject("ownership epoch must be a positive integer");
    }
    const reason = boundedReason(input.reason, "task_execution_paused");
    const at = exactDate(input.now, "running task interruption time");
    const runs = await options.runService.lockActiveRunsForScopeInTransaction(transaction, {
      companyId: input.companyId,
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
    });
    const requests = await requestLockedRunCancellationsInTransaction(transaction, {
      runs: runs.filter((run) => run.status === "running"),
      reason,
      actor: input.actor,
      at,
      reasonKind: "lifecycle",
    });
    return Object.freeze({
      companyId: input.companyId,
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
      reason,
      requests,
    });
  }
  return {
    validateBudgetScope,
    requestBudgetScopeSuspensionInTransaction,
    requestScopeCancellationsInTransaction,
    requestRunningTaskInterruptionsInTransaction,
  };
}
