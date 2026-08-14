import {
  companies,
  companySessionLifecycleOperations,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskSessions,
} from "@paperclipai/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  type CompanySessionLifecycleActor,
  type CompanySessionLifecycleBeginResult,
  type CompanySessionLifecycleTx,
  type PostgresCancellationIntent,
  type PostgresLifecycleOperation,
  ACTIVE_ATTEMPT_STATES,
  latestLifecycleOperation,
  lockCompanySessionLifecycle,
  lockSessionsParentFirst,
  refreshLifecycleOperationAfterCancellationInTx,
} from "./task-session-lifecycle-part-1.js";
import { fenceCompanySessionGraphInTx } from "./task-session-lifecycle-part-2.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./task-session/store.js";

export async function beginCompanyHardDeleteInTx(
  tx: CompanySessionLifecycleTx,
  companyId: string,
  lifecycleOperationId: string,
  options: {
    readonly now?: Date;
    readonly fenceToken?: string;
    readonly actor?: CompanySessionLifecycleActor;
  } = {},
): Promise<CompanySessionLifecycleBeginResult | null> {
  return fenceCompanySessionGraphInTx(tx, {
    companyId,
    lifecycleOperationId,
    operation: "hard_delete",
    now: options.now ?? new Date(),
    fenceToken: options.fenceToken ?? randomUUID(),
    actor: options.actor,
  });
}

/**
 * Re-evaluates a fenced operation after the ordinary run-finalization owner
 * has terminalized every cancelled archive run. It creates no cancellation,
 * run, finalization, or compatibility state of its own.
 */
export async function reconcileCompanySessionLifecycleOperationInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly lifecycleOperationId: string;
    readonly now?: Date;
  },
): Promise<PostgresLifecycleOperation> {
  const now = input.now ?? new Date();
  await lockCompanySessionLifecycle(tx, input.companyId);
  const operation = await tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, input.companyId),
        eq(companySessionLifecycleOperations.id, input.lifecycleOperationId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!operation) {
    throw new TaskSessionInvariantError(`Lifecycle operation ${input.lifecycleOperationId} does not exist`);
  }
  return refreshLifecycleOperationAfterCancellationInTx(tx, operation, now);
}

export async function reactivateCompanySessionGraphInTx(
  tx: CompanySessionLifecycleTx,
  input: { readonly companyId: string; readonly now?: Date },
): Promise<{ readonly companyId: string; readonly generation: number }> {
  const now = input.now ?? new Date();
  await lockCompanySessionLifecycle(tx, input.companyId);
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) {
    throw new TaskSessionLifecycleConflict("Company reactivation cannot resolve its company", input);
  }
  if (company.sessionIntegrityState === "hard_delete_fenced") {
    throw new TaskSessionLifecycleConflict("A hard-delete-fenced company cannot be reactivated", input);
  }
  const archive = await latestLifecycleOperation(tx, input.companyId, "archive");
  if (company.sessionIntegrityState !== "archive_fenced" || !archive || archive.status !== "completed") {
    throw new TaskSessionLifecycleConflict("Company reactivation requires a completed archive fence", {
      companyId: input.companyId,
      integrityState: company.sessionIntegrityState,
      archiveStatus: archive?.status ?? null,
    });
  }
  const activeAttempts = await tx
    .select({ id: taskExecutionAttempts.id })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.companyId, input.companyId),
        inArray(taskExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
      ),
    )
    .limit(1);
  if (activeAttempts[0]) {
    throw new TaskSessionLifecycleConflict(
      "Company reactivation requires cancellation to be fully reconciled",
      { companyId: input.companyId, attemptId: activeAttempts[0].id },
    );
  }
  await lockSessionsParentFirst(tx, input.companyId);
  await tx
    .update(companies)
    .set({
      status: "active",
      sessionIntegrityState: "ready",
      sessionIntegrityReadyAt: now,
      hardDeleteFencedAt: null,
      updatedAt: now,
    })
    .where(eq(companies.id, input.companyId));
  await tx
    .update(taskSessions)
    .set({
      integrityState: "ready",
      refAdmittableAt: now,
      timeArchived: null,
      purgeFencedAt: null,
      timeUpdated: now,
    })
    .where(and(eq(taskSessions.companyId, input.companyId), eq(taskSessions.integrityState, "archived")));
  return { companyId: input.companyId, generation: archive.generation };
}

/**
 * Claims durable cancellation work without inventing a second worker-lease
 * schema. Acknowledged rows remain restart-safe and every stop operation must
 * therefore be idempotent for the exact attempt/lease identity.
 */
export async function acknowledgeCompanyCancellationIntentsInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly limit: number;
    readonly intentIds?: readonly string[];
    readonly now?: Date;
  },
): Promise<PostgresCancellationIntent[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new TaskSessionLifecycleConflict("Cancellation claim limit must be between 1 and 1000");
  }
  const now = input.now ?? new Date();
  await lockCompanySessionLifecycle(tx, input.companyId);
  const candidates = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged"]),
        input.intentIds?.length
          ? inArray(taskExecutionCancellationIntents.id, [...input.intentIds])
          : undefined,
      ),
    )
    .orderBy(asc(taskExecutionCancellationIntents.requestedAt), asc(taskExecutionCancellationIntents.id))
    .limit(input.limit)
    .for("update", {
      of: taskExecutionCancellationIntents,
      skipLocked: true,
    });
  if (candidates.length === 0) return [];
  const requestedIds = candidates.filter((intent) => intent.state === "requested").map((intent) => intent.id);
  if (requestedIds.length > 0) {
    await tx
      .update(taskExecutionCancellationIntents)
      .set({ state: "acknowledged", acknowledgedAt: now })
      .where(inArray(taskExecutionCancellationIntents.id, requestedIds));
  }
  return tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(
      inArray(
        taskExecutionCancellationIntents.id,
        candidates.map((intent) => intent.id),
      ),
    )
    .orderBy(asc(taskExecutionCancellationIntents.requestedAt), asc(taskExecutionCancellationIntents.id));
}
export * from "./task-session-lifecycle-part-1.js";
export * from "./task-session-lifecycle-part-2.js";
export * from "./task-session-lifecycle-part-3-section-2.js";
export * from "./task-session-lifecycle-part-4.js";
