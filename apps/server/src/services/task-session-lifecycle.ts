import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  assets,
  companies,
  companyLogos,
  companyMemberships,
  companySecrets,
  companySessionLifecycleOperations,
  companySkills,
  costEvents,
  documentRevisions,
  documents,
  localExecutionLeases,
  financeEvents,
  goals,
  invites,
  taskCommentProjectionSources,
  taskComments,
  taskConsultExecutions,
  taskCreatorEdgeReceivability,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionAuthorities,
  taskExecutionCancellationIntents,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionHistoryViewMessages,
  taskExecutionHistoryViews,
  taskExecutionLanes,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  taskInboxArchives,
  taskReadStates,
  tasks,
  taskSessionInputDispositions,
  taskSessions,
  taskUpdates,
  joinRequests,
  pluginWithdrawalOperations,
  principalPermissionGrants,
  projects,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
  runtimeAgentConfigurationAudits,
  systemEscalationIdentities,
  type Db,
} from "@paperclipai/db";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  attachTaskExecutionRunCancellationInTransaction,
  detachTaskExecutionRunAttemptInTransaction,
  detachTaskExecutionRunCancellationInTransaction,
  lockTaskExecutionRunInTransaction,
  purgeCompanyTaskExecutionRunsInTransaction,
} from "./task-execution-run-service.js";
import {
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
} from "./task-session/store.js";

type CompanySessionLifecycleTx =
  Parameters<Parameters<Db["transaction"]>[0]>[0];
type PostgresLifecycleOperation =
  typeof companySessionLifecycleOperations.$inferSelect;
type PostgresCancellationIntent =
  typeof taskExecutionCancellationIntents.$inferSelect;

const ACTIVE_ATTEMPT_STATES = ["pending", "leased", "running"] as const;
const LIVE_CAPABILITY_STATES = ["pending_setup", "active"] as const;
const LIVE_NATIVE_SESSION_STATES = ["eligible", "current"] as const;

const LIFECYCLE_SNAPSHOT_VERSION =
  "company-session-lifecycle/v1" as const;

interface LifecycleAttemptSnapshot {
  readonly intentId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string | null;
}

export interface CompanySessionLifecycleRun {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
}

interface LifecycleGraphSnapshot extends Record<string, unknown> {
  readonly version: typeof LIFECYCLE_SNAPSHOT_VERSION;
  readonly sessionIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly runs: readonly CompanySessionLifecycleRun[];
  readonly attempts: readonly LifecycleAttemptSnapshot[];
}

export interface CompanySessionLifecycleActor {
  readonly requestedByAgentId?: string | null;
  readonly requestedByUserId?: string | null;
}

export interface CompanySessionLifecycleBeginResult {
  readonly operation: PostgresLifecycleOperation;
  readonly intents: readonly PostgresCancellationIntent[];
  readonly runs: readonly CompanySessionLifecycleRun[];
  readonly created: boolean;
}

function sessionDepth(
  sessionId: string,
  parentById: ReadonlyMap<string, string | null>,
): number {
  let current = sessionId;
  let depth = 0;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) {
      throw new TaskSessionInvariantError(
        `Canonical Session parent cycle includes ${current}`,
      );
    }
    visited.add(current);
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent)) return depth;
    current = parent;
    depth += 1;
  }
}

async function lockCompanySessionLifecycle(
  tx: CompanySessionLifecycleTx,
  companyId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${companyId}, 0))`,
  );
  await tx.execute(
    sql`select ${companies.id} from ${companies}
      where ${companies.id} = ${companyId}
      for update`,
  );
}

async function lockSessionsParentFirst(
  tx: CompanySessionLifecycleTx,
  companyId: string,
): Promise<Array<typeof taskSessions.$inferSelect>> {
  const rows = await tx
    .select()
    .from(taskSessions)
    .where(eq(taskSessions.companyId, companyId));
  const parentById = new Map(
    rows.map((row) => [row.id, row.parentSessionId] as const),
  );
  rows.sort(
    (left, right) =>
      sessionDepth(left.id, parentById) -
        sessionDepth(right.id, parentById) ||
      left.id.localeCompare(right.id),
  );
  for (const row of rows) {
    await tx.execute(
      sql`select ${taskSessions.id} from ${taskSessions}
        where ${taskSessions.companyId} = ${companyId}
          and ${taskSessions.id} = ${row.id}
        for update`,
    );
  }
  return rows;
}

function lifecycleActor(
  actor: CompanySessionLifecycleActor | undefined,
): {
  actorKind: "system" | "user" | "agent";
  actorUserId: string | null;
  actorAgentId: string | null;
} {
  const userId = actor?.requestedByUserId ?? null;
  const agentId = actor?.requestedByAgentId ?? null;
  if (userId && agentId) {
    throw new TaskSessionLifecycleConflict(
      "A company lifecycle operation must have one exact actor",
    );
  }
  return userId
    ? { actorKind: "user", actorUserId: userId, actorAgentId: null }
    : agentId
      ? { actorKind: "agent", actorUserId: null, actorAgentId: agentId }
      : { actorKind: "system", actorUserId: null, actorAgentId: null };
}

function parseLifecycleSnapshot(
  operation: PostgresLifecycleOperation,
): LifecycleGraphSnapshot {
  const value = operation.sessionGraphSnapshot;
  if (
    !value ||
    value.version !== LIFECYCLE_SNAPSHOT_VERSION ||
    !Array.isArray(value.sessionIds) ||
    !Array.isArray(value.taskIds) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.attempts)
  ) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} has a non-canonical graph snapshot`,
    );
  }
  const strings = (items: unknown[]): items is string[] =>
    items.every((item) => typeof item === "string" && item.length > 0);
  if (!strings(value.sessionIds) || !strings(value.taskIds)) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} has invalid Session identities`,
    );
  }
  const runs: CompanySessionLifecycleRun[] = value.runs.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new TaskSessionInvariantError(
        `Lifecycle operation ${operation.id} has invalid run ${index}`,
      );
    }
    const row = item as Record<string, unknown>;
    for (const key of ["companyId", "taskId", "runId"] as const) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        throw new TaskSessionInvariantError(
          `Lifecycle operation ${operation.id} has invalid run ${key}`,
        );
      }
    }
    return row as unknown as CompanySessionLifecycleRun;
  });
  const attempts: LifecycleAttemptSnapshot[] = value.attempts.map(
    (item, index) => {
      if (!item || typeof item !== "object") {
        throw new TaskSessionInvariantError(
          `Lifecycle operation ${operation.id} has invalid attempt ${index}`,
        );
      }
      const row = item as Record<string, unknown>;
      for (const key of [
        "intentId",
        "companyId",
        "taskId",
        "sessionId",
        "runId",
        "attemptId",
      ] as const) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw new TaskSessionInvariantError(
            `Lifecycle operation ${operation.id} has invalid ${key}`,
          );
        }
      }
      if (row.leaseId !== null && typeof row.leaseId !== "string") {
        throw new TaskSessionInvariantError(
          `Lifecycle operation ${operation.id} has invalid leaseId`,
        );
      }
      return row as unknown as LifecycleAttemptSnapshot;
    },
  );
  return {
    version: LIFECYCLE_SNAPSHOT_VERSION,
    sessionIds: value.sessionIds,
    taskIds: value.taskIds,
    runs,
    attempts,
  };
}

async function operationIntents(
  tx: CompanySessionLifecycleTx,
  operation: PostgresLifecycleOperation,
): Promise<PostgresCancellationIntent[]> {
  const ids = parseLifecycleSnapshot(operation).attempts.map(
    (attempt) => attempt.intentId,
  );
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, operation.companyId),
        inArray(taskExecutionCancellationIntents.id, ids),
      ),
    )
    .orderBy(asc(taskExecutionCancellationIntents.id));
  if (rows.length !== ids.length) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} lost a retained cancellation intent`,
    );
  }
  return rows;
}

async function latestLifecycleOperation(
  tx: CompanySessionLifecycleTx,
  companyId: string,
  operation: "archive" | "hard_delete",
): Promise<PostgresLifecycleOperation | null> {
  return tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, companyId),
        eq(companySessionLifecycleOperations.operation, operation),
      ),
    )
    .orderBy(
      sql`${companySessionLifecycleOperations.generation} desc`,
      asc(companySessionLifecycleOperations.id),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function refreshLifecycleOperationAfterCancellationInTx(
  tx: CompanySessionLifecycleTx,
  operation: PostgresLifecycleOperation,
  now: Date,
): Promise<PostgresLifecycleOperation> {
  if (["completed", "purge_ready", "failed"].includes(operation.status)) {
    return operation;
  }
  const intents = await operationIntents(tx, operation);
  const failed = intents.find((intent) => intent.state === "failed");
  const snapshot = parseLifecycleSnapshot(operation);
  let archivedRunsSettled = true;
  if (operation.operation === "archive") {
    for (const identity of snapshot.runs) {
      const run = await lockTaskExecutionRunInTransaction(tx, identity);
      if (["queued", "scheduled_retry", "running"].includes(run.status)) {
        archivedRunsSettled = false;
      }
    }
  }
  const drained =
    intents.every((intent) => intent.state === "completed") &&
    archivedRunsSettled;
  const status = failed
    ? "failed"
    : drained
      ? operation.operation === "hard_delete"
        ? "purge_ready"
        : "completed"
      : intents.length > 0
        ? "cancelling"
        : "fenced";
  const failureReason = failed?.failureCode ?? null;
  const updated = await tx
    .update(companySessionLifecycleOperations)
    .set({
      status,
      cancellingAt:
        status === "cancelling"
          ? operation.cancellingAt ?? now
          : operation.cancellingAt,
      purgeReadyAt: status === "purge_ready" ? now : null,
      completedAt: status === "completed" ? now : null,
      failedAt: status === "failed" ? now : null,
      failureReason,
      updatedAt: now,
    })
    .where(eq(companySessionLifecycleOperations.id, operation.id))
    .returning()
    .then((rows) => rows[0]);
  if (!updated) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} disappeared while settling cancellation`,
    );
  }
  return updated;
}

async function activeOperationForIntent(
  tx: CompanySessionLifecycleTx,
  intent: PostgresCancellationIntent,
): Promise<PostgresLifecycleOperation | null> {
  const operations = await tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, intent.companyId))
    .orderBy(
      sql`${companySessionLifecycleOperations.generation} desc`,
      asc(companySessionLifecycleOperations.id),
    );
  for (const operation of operations) {
    if (
      parseLifecycleSnapshot(operation).attempts.some(
        (attempt) => attempt.intentId === intent.id,
      )
    ) {
      return operation;
    }
  }
  return null;
}

async function fenceCompanySessionGraphInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly lifecycleOperationId: string;
    readonly operation: "archive" | "hard_delete";
    readonly now: Date;
    readonly fenceToken: string;
    readonly actor?: CompanySessionLifecycleActor;
  },
): Promise<CompanySessionLifecycleBeginResult | null> {
  await lockCompanySessionLifecycle(tx, input.companyId);
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) return null;

  const existing = await latestLifecycleOperation(
    tx,
    input.companyId,
    input.operation,
  );
  if (
    existing &&
    (company.sessionIntegrityState === "archive_fenced" ||
      existing.status !== "completed" ||
      input.operation === "hard_delete")
  ) {
    return {
      operation: existing,
      intents: await operationIntents(tx, existing),
      runs: parseLifecycleSnapshot(existing).runs,
      created: false,
    };
  }

  const otherActive = await tx
    .select({ id: companySessionLifecycleOperations.id })
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, input.companyId),
        inArray(companySessionLifecycleOperations.status, [
          "fenced",
          "cancelling",
          "purge_ready",
        ]),
      ),
    )
    .limit(1);
  if (otherActive[0]) {
    throw new TaskSessionLifecycleConflict(
      "A company Session lifecycle operation is already active",
      { companyId: input.companyId, operationId: otherActive[0].id },
    );
  }

  const sessions = await lockSessionsParentFirst(tx, input.companyId);
  const attempts = await tx
    .select()
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.companyId, input.companyId),
        inArray(taskExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
      ),
    )
    .orderBy(asc(taskExecutionAttempts.id))
    .for("update");
  const attemptIds = attempts.map((attempt) => attempt.id);
  const leases = attemptIds.length
    ? await tx
        .select()
        .from(taskExecutionLeases)
        .where(inArray(taskExecutionLeases.attemptId, attemptIds))
        .orderBy(asc(taskExecutionLeases.id))
        .for("update")
    : [];
  const existingIntents = attemptIds.length
    ? await tx
        .select()
        .from(taskExecutionCancellationIntents)
        .where(inArray(taskExecutionCancellationIntents.attemptId, attemptIds))
        .orderBy(asc(taskExecutionCancellationIntents.id))
        .for("update")
    : [];
  const leaseByAttempt = new Map(
    leases.map((lease) => [lease.attemptId, lease] as const),
  );
  const intentByAttempt = new Map(
    existingIntents.map((intent) => [intent.attemptId, intent] as const),
  );
  const actor = lifecycleActor(input.actor);

  const openRunRefs = await tx
    .select({
      companyId: taskExecutionRunRefs.companyId,
      taskId: taskExecutionRunRefs.taskId,
      runId: taskExecutionRunRefs.runId,
    })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.companyId),
        isNull(taskExecutionRunRefs.protocolSettlementState),
      ),
    );
  const candidateRunIdentities = new Map<
    string,
    CompanySessionLifecycleRun
  >();
  for (const identity of [
    ...attempts.map((attempt) => ({
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    })),
    ...openRunRefs,
  ]) {
    candidateRunIdentities.set(identity.runId, identity);
  }
  const activeRuns: CompanySessionLifecycleRun[] = [];
  for (const identity of [...candidateRunIdentities.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId),
  )) {
    const run = await lockTaskExecutionRunInTransaction(tx, identity);
    if (["queued", "scheduled_retry", "running"].includes(run.status)) {
      activeRuns.push(identity);
    }
  }

  const pendingInserts: Array<
    typeof taskExecutionCancellationIntents.$inferInsert
  > = [];
  const attemptSnapshots: LifecycleAttemptSnapshot[] = [];
  for (const attempt of attempts) {
    const run = await lockTaskExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    });
    if (
      run.sessionId !== attempt.sessionId ||
      run.kind !== attempt.runKind
    ) {
      throw new TaskSessionLifecycleConflict(
        "Lifecycle cancellation crossed the exact run/attempt scope",
        { runId: run.runId, attemptId: attempt.id },
      );
    }
    const lease = leaseByAttempt.get(attempt.id) ?? null;
    if (
      attempt.state !== "pending" &&
      (!lease || lease.state !== "active")
    ) {
      throw new TaskSessionLifecycleConflict(
        "A leased or running attempt requires its exact active lease",
        { runId: attempt.runId, attemptId: attempt.id },
      );
    }
    const existingIntent = intentByAttempt.get(attempt.id) ?? null;
    if (
      existingIntent &&
      !["requested", "acknowledged"].includes(existingIntent.state)
    ) {
      throw new TaskSessionLifecycleConflict(
        "An active attempt has a terminal cancellation intent",
        { attemptId: attempt.id, intentId: existingIntent.id },
      );
    }
    const intentId = existingIntent?.id ?? randomUUID();
    if (!existingIntent) {
      pendingInserts.push({
        id: intentId,
        companyId: attempt.companyId,
        taskId: attempt.taskId,
        runId: attempt.runId,
        attemptId: attempt.id,
        leaseId: lease?.id ?? null,
        reasonKind: "lifecycle",
        ...actor,
        state: "requested",
        requestedAt: input.now,
        createdAt: input.now,
      });
    }
    attemptSnapshots.push({
      intentId,
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      sessionId: attempt.sessionId,
      runId: attempt.runId,
      attemptId: attempt.id,
      leaseId: lease?.id ?? null,
    });
  }

  const previousOperations = await tx
    .select({ generation: companySessionLifecycleOperations.generation })
    .from(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, input.companyId));
  const generation =
    Math.max(
      company.sessionLifecycleGeneration,
      ...previousOperations.map((operation) => operation.generation),
    ) + 1;
  const initialStatus =
    attemptSnapshots.length > 0
      ? "cancelling"
      : input.operation === "hard_delete"
        ? "purge_ready"
        : activeRuns.length > 0
          ? "fenced"
          : "completed";
  const snapshot: LifecycleGraphSnapshot = {
    version: LIFECYCLE_SNAPSHOT_VERSION,
    sessionIds: sessions.map((session) => session.id),
    taskIds: [...new Set(sessions.map((session) => session.taskId))],
    runs: activeRuns,
    attempts: attemptSnapshots,
  };
  const insertedOperation = await tx
    .insert(companySessionLifecycleOperations)
    .values({
      id: input.lifecycleOperationId,
      companyId: input.companyId,
      generation,
      operation: input.operation,
      status: initialStatus,
      fenceToken: input.fenceToken,
      sessionGraphSnapshot: snapshot,
      requestedByAgentId: input.actor?.requestedByAgentId ?? null,
      requestedByUserId: input.actor?.requestedByUserId ?? null,
      fencedAt: input.now,
      cancellingAt: attemptSnapshots.length ? input.now : null,
      purgeReadyAt:
        initialStatus === "purge_ready" ? input.now : null,
      completedAt: initialStatus === "completed" ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .then((rows) => rows[0]);
  if (!insertedOperation) {
    throw new TaskSessionInvariantError(
      "Company Session lifecycle operation was not persisted",
    );
  }
  if (pendingInserts.length > 0) {
    await tx.insert(taskExecutionCancellationIntents).values(pendingInserts);
  }

  for (const attempt of attemptSnapshots) {
    if (!attempt.leaseId) continue;
    const run = await lockTaskExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    });
    if (run.cancellationIntentId === attempt.intentId) continue;
    if (
      run.status === "running" &&
      run.currentAttemptId === attempt.attemptId &&
      run.currentLeaseId === attempt.leaseId &&
      run.cancellationIntentId === null
    ) {
      await attachTaskExecutionRunCancellationInTransaction(tx, {
        companyId: attempt.companyId,
        taskId: attempt.taskId,
        runId: attempt.runId,
        expectedAttemptId: attempt.attemptId,
        expectedLeaseId: attempt.leaseId,
        cancellationIntentId: attempt.intentId,
        at: input.now,
      });
      continue;
    }
    if (run.cancellationIntentId !== null) {
      throw new TaskSessionLifecycleConflict(
        "Lifecycle cancellation found another run cancellation pointer",
        { runId: run.runId, cancellationIntentId: run.cancellationIntentId },
      );
    }
  }

  const invalidationReason =
    input.operation === "hard_delete"
      ? "company_hard_delete"
      : "company_archive";
  await tx
    .update(companies)
    .set({
      status: "archived",
      sessionIntegrityState:
        input.operation === "hard_delete"
          ? "hard_delete_fenced"
          : "archive_fenced",
      sessionIntegrityReadyAt: null,
      sessionLifecycleGeneration: generation,
      hardDeleteFencedAt:
        input.operation === "hard_delete" ? input.now : null,
      updatedAt: input.now,
    })
    .where(eq(companies.id, input.companyId));
  await tx
    .update(taskSessions)
    .set({
      integrityState:
        input.operation === "hard_delete" ? "purge_fenced" : "archived",
      refAdmittableAt: null,
      timeArchived: input.now,
      purgeFencedAt:
        input.operation === "hard_delete" ? input.now : null,
      timeUpdated: input.now,
    })
    .where(eq(taskSessions.companyId, input.companyId));
  await tx
    .update(taskExecutionRefs)
    .set({
      disposition: "invalidated",
      invalidationReason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionRefs.companyId, input.companyId),
        eq(taskExecutionRefs.disposition, "active"),
      ),
    );
  await tx
    .update(taskSessionInputDispositions)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      invalidatedBySourceKind: "company_lifecycle",
      invalidatedBySourceId: input.lifecycleOperationId,
    })
    .where(
      and(
        eq(taskSessionInputDispositions.companyId, input.companyId),
        eq(taskSessionInputDispositions.state, "active"),
      ),
    );
  await tx
    .update(taskExecutionHistoryViews)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionHistoryViews.companyId, input.companyId),
        inArray(taskExecutionHistoryViews.state, [
          "empty",
          "preparing",
          "current",
        ]),
      ),
    );
  await tx
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: invalidationReason,
      supersededAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionSessions.companyId, input.companyId),
        inArray(taskExecutionSessions.state, [
          ...LIVE_NATIVE_SESSION_STATES,
        ]),
      ),
    );
  await tx
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: invalidationReason,
      revokedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        inArray(taskExecutionPromptCapabilities.state, [
          ...LIVE_CAPABILITY_STATES,
        ]),
      ),
    );
  await tx
    .update(taskExecutionLeases)
    .set({ state: "revoked", releasedAt: input.now })
    .where(
      and(
        eq(taskExecutionLeases.companyId, input.companyId),
        eq(taskExecutionLeases.state, "active"),
      ),
    );
  await tx
    .update(taskExecutionAttemptRetrySchedules)
    .set({ state: "cancelled", cancelledAt: input.now })
    .where(
      and(
        eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    );
  await tx
    .update(taskConsultExecutions)
    .set({
      state: "cancelled",
      closeReason: invalidationReason,
      closedAt: input.now,
    })
    .where(
      and(
        eq(taskConsultExecutions.companyId, input.companyId),
        eq(taskConsultExecutions.state, "active"),
      ),
    );

  return {
    operation: insertedOperation,
    intents: await operationIntents(tx, insertedOperation),
    runs: activeRuns,
    created: true,
  };
}

export async function archiveCompanySessionGraphInTx(
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
    operation: "archive",
    now: options.now ?? new Date(),
    fenceToken: options.fenceToken ?? randomUUID(),
    actor: options.actor,
  });
}

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
        eq(
          companySessionLifecycleOperations.id,
          input.lifecycleOperationId,
        ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!operation) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${input.lifecycleOperationId} does not exist`,
    );
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
    throw new TaskSessionLifecycleConflict(
      "Company reactivation cannot resolve its company",
      input,
    );
  }
  if (company.sessionIntegrityState === "hard_delete_fenced") {
    throw new TaskSessionLifecycleConflict(
      "A hard-delete-fenced company cannot be reactivated",
      input,
    );
  }
  const archive = await latestLifecycleOperation(
    tx,
    input.companyId,
    "archive",
  );
  if (
    company.sessionIntegrityState !== "archive_fenced" ||
    !archive ||
    archive.status !== "completed"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Company reactivation requires a completed archive fence",
      {
        companyId: input.companyId,
        integrityState: company.sessionIntegrityState,
        archiveStatus: archive?.status ?? null,
      },
    );
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
    .where(
      and(
        eq(taskSessions.companyId, input.companyId),
        eq(taskSessions.integrityState, "archived"),
      ),
    );
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
    throw new TaskSessionLifecycleConflict(
      "Cancellation claim limit must be between 1 and 1000",
    );
  }
  const now = input.now ?? new Date();
  await lockCompanySessionLifecycle(tx, input.companyId);
  const candidates = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        inArray(taskExecutionCancellationIntents.state, [
          "requested",
          "acknowledged",
        ]),
        input.intentIds?.length
          ? inArray(taskExecutionCancellationIntents.id, [
              ...input.intentIds,
            ])
          : undefined,
      ),
    )
    .orderBy(
      asc(taskExecutionCancellationIntents.requestedAt),
      asc(taskExecutionCancellationIntents.id),
    )
    .limit(input.limit)
    .for("update", {
      of: taskExecutionCancellationIntents,
      skipLocked: true,
    });
  if (candidates.length === 0) return [];
  const requestedIds = candidates
    .filter((intent) => intent.state === "requested")
    .map((intent) => intent.id);
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
    .orderBy(
      asc(taskExecutionCancellationIntents.requestedAt),
      asc(taskExecutionCancellationIntents.id),
    );
}

export async function reconcileCompanyCancellationIntentInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly intentId: string;
    readonly now?: Date;
  },
): Promise<{
  readonly intent: PostgresCancellationIntent;
  readonly operation: PostgresLifecycleOperation | null;
} | null> {
  const now = input.now ?? new Date();
  const initial = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!initial) {
    throw new TaskSessionInvariantError(
      `Cancellation intent ${input.intentId} does not exist`,
    );
  }
  await lockCompanySessionLifecycle(tx, initial.companyId);
  const intent = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!intent) {
    throw new TaskSessionInvariantError(
      `Cancellation intent ${input.intentId} disappeared while locking`,
    );
  }
  if (intent.state === "completed") {
    return {
      intent,
      operation: await activeOperationForIntent(tx, intent),
    };
  }
  if (intent.state !== "acknowledged") {
    throw new TaskSessionLifecycleConflict(
      "Cancellation completion requires an acknowledged intent",
      { intentId: intent.id, state: intent.state },
    );
  }
  const run = await lockTaskExecutionRunInTransaction(tx, {
    companyId: intent.companyId,
    taskId: intent.taskId,
    runId: intent.runId,
  });
  const attempt = await tx
    .select()
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, intent.attemptId),
        eq(taskExecutionAttempts.companyId, intent.companyId),
        eq(taskExecutionAttempts.taskId, intent.taskId),
        eq(taskExecutionAttempts.runId, intent.runId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!attempt) {
    throw new TaskSessionInvariantError(
      `Cancellation intent ${intent.id} lost attempt ${intent.attemptId}`,
    );
  }
  if (
    attempt.state === "running" &&
    intent.nativeCancellationSettledAt === null
  ) {
    if (
      !intent.leaseId ||
      run.status !== "running" ||
      run.cancellationIntentId !== intent.id ||
      run.currentAttemptId !== intent.attemptId ||
      run.currentLeaseId !== intent.leaseId
    ) {
      throw new TaskSessionLifecycleConflict(
        "Cancellation crossed the current run authority",
        { intentId: intent.id, runId: intent.runId },
      );
    }
    const lease = await tx
      .select({
        id: taskExecutionLeases.id,
        state: taskExecutionLeases.state,
        expiredAtDatabaseClock:
          sql<boolean>`${taskExecutionLeases.expiresAt} <= clock_timestamp()`,
      })
      .from(taskExecutionLeases)
      .where(
        and(
          eq(taskExecutionLeases.id, intent.leaseId),
          eq(taskExecutionLeases.companyId, intent.companyId),
          eq(taskExecutionLeases.taskId, intent.taskId),
          eq(taskExecutionLeases.runId, intent.runId),
          eq(taskExecutionLeases.attemptId, intent.attemptId),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!lease) {
      throw new TaskSessionInvariantError(
        `Cancellation intent ${intent.id} lost lease ${intent.leaseId}`,
      );
    }
    if (lease.state !== "active") {
      throw new TaskSessionLifecycleConflict(
        "Cancellation lease is no longer active",
        { intentId: intent.id, leaseId: lease.id },
      );
    }
    if (!lease.expiredAtDatabaseClock) return null;
    const capability = await tx
      .select({
        capabilityConnectionId:
          taskExecutionPromptCapabilities.capabilityConnectionId,
      })
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, intent.companyId),
          eq(taskExecutionPromptCapabilities.taskId, intent.taskId),
          eq(taskExecutionPromptCapabilities.runId, intent.runId),
          eq(taskExecutionPromptCapabilities.attemptId, intent.attemptId),
          eq(taskExecutionPromptCapabilities.leaseId, intent.leaseId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // Capability mint owns this same run lock and precedes every ACPX call.
    if (capability) return null;
  }
  if (intent.leaseId) {
    await tx
      .update(taskExecutionLeases)
      .set({ state: "revoked", releasedAt: now })
      .where(
        and(
          eq(taskExecutionLeases.id, intent.leaseId),
          eq(taskExecutionLeases.attemptId, intent.attemptId),
          eq(taskExecutionLeases.state, "active"),
        ),
      );
  }
  if (
    ACTIVE_ATTEMPT_STATES.includes(
      attempt.state as (typeof ACTIVE_ATTEMPT_STATES)[number],
    )
  ) {
    await tx
      .update(taskExecutionAttempts)
      .set({ state: "cancelled", finishedAt: now })
      .where(eq(taskExecutionAttempts.id, attempt.id));
  }
  const completed = await tx
    .update(taskExecutionCancellationIntents)
    .set({
      state: "completed",
      completedAt: now,
      failedAt: null,
      failureCode: null,
    })
    .where(eq(taskExecutionCancellationIntents.id, intent.id))
    .returning()
    .then((rows) => rows[0]);
  if (!completed) {
    throw new TaskSessionInvariantError(
      `Cancellation intent ${intent.id} was not completed`,
    );
  }

  const detachedRun = run.cancellationIntentId === intent.id
    ? await detachTaskExecutionRunCancellationInTransaction(tx, {
        companyId: intent.companyId,
        taskId: intent.taskId,
        runId: intent.runId,
        expectedCancellationIntentId: intent.id,
        at: now,
      })
    : run;
  if (
    run.cancellationIntentId !== null &&
    run.cancellationIntentId !== intent.id
  ) {
    throw new TaskSessionLifecycleConflict(
      "Cancellation completion crossed another run cancellation pointer",
      { runId: run.runId, cancellationIntentId: run.cancellationIntentId },
    );
  }
  if (
    intent.leaseId &&
    detachedRun.currentAttemptId === intent.attemptId &&
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    await detachTaskExecutionRunAttemptInTransaction(tx, {
      companyId: intent.companyId,
      taskId: intent.taskId,
      runId: intent.runId,
      expectedAttemptId: intent.attemptId,
      expectedLeaseId: intent.leaseId,
      at: now,
    });
  } else if (
    detachedRun.currentAttemptId === intent.attemptId ||
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    throw new TaskSessionLifecycleConflict(
      "Cancellation completion found a partial run attempt pointer",
      { runId: detachedRun.runId, attemptId: intent.attemptId },
    );
  }

  return {
    intent: completed,
    operation: await activeOperationForIntent(tx, completed),
  };
}

export async function failCompanyCancellationIntentInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly intentId: string;
    readonly failureCode: string;
    readonly now?: Date;
  },
): Promise<PostgresCancellationIntent> {
  const failureCode = input.failureCode.trim();
  if (failureCode.length < 1 || failureCode.length > 200) {
    throw new TaskSessionLifecycleConflict(
      "Cancellation failure code must contain 1 to 200 characters",
    );
  }
  const now = input.now ?? new Date();
  const initial = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!initial) {
    throw new TaskSessionInvariantError(
      `Cancellation intent ${input.intentId} does not exist`,
    );
  }
  await lockCompanySessionLifecycle(tx, initial.companyId);
  const failed = await tx
    .update(taskExecutionCancellationIntents)
    .set({ state: "failed", failedAt: now, failureCode })
    .where(
      and(
        eq(taskExecutionCancellationIntents.id, input.intentId),
        eq(taskExecutionCancellationIntents.state, "acknowledged"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!failed) {
    throw new TaskSessionLifecycleConflict(
      "Only an acknowledged cancellation intent may fail",
      { intentId: input.intentId },
    );
  }
  const operation = await activeOperationForIntent(tx, failed);
  if (operation) {
    await refreshLifecycleOperationAfterCancellationInTx(tx, operation, now);
  }
  return failed;
}

/**
 * The one hard-delete exception to the closed run-service mutation surface.
 * Every gate is checked before the first DELETE and PostgreSQL rolls the whole
 * company-scoped transaction back on any ownership/FK invariant failure.
 */
export async function purgeCompanySessionGraphInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly lifecycleOperationId: string;
    readonly now?: Date;
  },
): Promise<{ readonly companyId: string; readonly generation: number; readonly purged: true }> {
  await lockCompanySessionLifecycle(tx, input.companyId);
  const company = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) {
    throw new TaskSessionLifecycleConflict(
      "Company purge cannot resolve its fenced company",
      input,
    );
  }
  const operation = await tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, input.companyId),
        eq(
          companySessionLifecycleOperations.id,
          input.lifecycleOperationId,
        ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !operation ||
    operation.operation !== "hard_delete" ||
    operation.status !== "purge_ready"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Company purge requires its purge-ready hard-delete operation",
      {
        ...input,
        operation: operation?.operation ?? null,
        status: operation?.status ?? null,
      },
    );
  }
  const snapshot = parseLifecycleSnapshot(operation);
  const intents = await operationIntents(tx, operation);
  const uncompletedIntent = intents.find(
    (intent) => intent.state !== "completed",
  );

  const [
    activeAttempt,
    activeLease,
    liveCapability,
    liveNativeSession,
    activeRef,
    activeConsult,
    scheduledRetry,
    activeLane,
    activeLocalRunLease,
  ] = await Promise.all([
    tx
      .select({ id: taskExecutionAttempts.id })
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.companyId, input.companyId),
          inArray(taskExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionLeases.id })
      .from(taskExecutionLeases)
      .where(
        and(
          eq(taskExecutionLeases.companyId, input.companyId),
          eq(taskExecutionLeases.state, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionPromptCapabilities.capabilityConnectionId })
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, input.companyId),
          inArray(taskExecutionPromptCapabilities.state, [
            ...LIVE_CAPABILITY_STATES,
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionSessions.id })
      .from(taskExecutionSessions)
      .where(
        and(
          eq(taskExecutionSessions.companyId, input.companyId),
          inArray(taskExecutionSessions.state, [
            ...LIVE_NATIVE_SESSION_STATES,
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionRefs.id })
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.disposition, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskConsultExecutions.id })
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.companyId, input.companyId),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionAttemptRetrySchedules.id })
      .from(taskExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
        ),
      )
      .limit(1),
    tx
      .select({ leaseId: taskExecutionLanes.activeLeaseId })
      .from(taskExecutionLanes)
      .where(
        and(
          eq(taskExecutionLanes.companyId, input.companyId),
          isNotNull(taskExecutionLanes.activeOrdinal),
        ),
      )
      .limit(1),
    tx
      .select({ id: localExecutionLeases.id })
      .from(localExecutionLeases)
      .where(
        and(
          eq(localExecutionLeases.companyId, input.companyId),
          eq(localExecutionLeases.status, "active"),
        ),
      )
      .limit(1),
  ]);
  if (
    uncompletedIntent ||
    activeAttempt[0] ||
    activeLease[0] ||
    liveCapability[0] ||
    liveNativeSession[0] ||
    activeRef[0] ||
    activeConsult[0] ||
    scheduledRetry[0] ||
    activeLane[0] ||
    activeLocalRunLease[0]
  ) {
    throw new TaskSessionLifecycleConflict(
      "Company Session graph purge is not cancellation-safe",
      {
        companyId: input.companyId,
        lifecycleOperationId: operation.id,
        uncompletedIntentId: uncompletedIntent?.id ?? null,
        activeAttemptId: activeAttempt[0]?.id ?? null,
        activeLeaseId: activeLease[0]?.id ?? null,
        liveCapabilityId: liveCapability[0]?.id ?? null,
        liveNativeSessionId: liveNativeSession[0]?.id ?? null,
        activeRefId: activeRef[0]?.id ?? null,
        activeConsultId: activeConsult[0]?.id ?? null,
        scheduledRetryId: scheduledRetry[0]?.id ?? null,
        activeLaneLeaseId: activeLane[0]?.leaseId ?? null,
        activeLocalRunLeaseId: activeLocalRunLease[0]?.id ?? null,
      },
    );
  }

  const sessions = await lockSessionsParentFirst(tx, input.companyId);
  const parentById = new Map(
    sessions.map((session) => [session.id, session.parentSessionId] as const),
  );

  // External run restrictors are removed before the canonical run roots.
  await tx
    .delete(taskExecutionFinalizationUpdateDependencies)
    .where(
      eq(
        taskExecutionFinalizationUpdateDependencies.companyId,
        input.companyId,
      ),
    );
  await tx
    .delete(taskExecutionFinalizationPromptDependencies)
    .where(
      eq(
        taskExecutionFinalizationPromptDependencies.companyId,
        input.companyId,
      ),
    );
  await tx
    .delete(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.companyId, input.companyId));
  await tx
    .delete(taskExecutionLeases)
    .where(eq(taskExecutionLeases.companyId, input.companyId));
  await tx
    .delete(taskExecutionAttemptRetrySchedules)
    .where(eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId));
  await tx
    .delete(taskExecutionAttempts)
    .where(eq(taskExecutionAttempts.companyId, input.companyId));
  await tx
    .delete(taskCommentProjectionSources)
    .where(eq(taskCommentProjectionSources.companyId, input.companyId));
  await purgeCompanyTaskExecutionRunsInTransaction(tx, {
    companyId: input.companyId,
  });

  // Native correlations and Session projections no longer restrict a run.
  await tx
    .delete(taskExecutionSessions)
    .where(eq(taskExecutionSessions.companyId, input.companyId));
  await tx
    .delete(taskExecutionHistoryViewMessages)
    .where(eq(taskExecutionHistoryViewMessages.companyId, input.companyId));
  for (const sessionId of [...snapshot.sessionIds].sort(
    (left, right) =>
      sessionDepth(right, parentById) - sessionDepth(left, parentById) ||
      left.localeCompare(right),
  )) {
    await tx
      .delete(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, input.companyId),
          eq(taskSessions.id, sessionId),
        ),
      );
  }

  await tx.delete(activityLog).where(eq(activityLog.companyId, input.companyId));
  await tx.delete(financeEvents).where(eq(financeEvents.companyId, input.companyId));
  await tx.delete(costEvents).where(eq(costEvents.companyId, input.companyId));
  await tx.delete(pluginWithdrawalOperations).where(eq(pluginWithdrawalOperations.companyId, input.companyId));
  await tx.delete(taskUpdates).where(eq(taskUpdates.companyId, input.companyId));
  await tx.delete(taskReadStates).where(eq(taskReadStates.companyId, input.companyId));
  await tx.delete(taskInboxArchives).where(eq(taskInboxArchives.companyId, input.companyId));
  await tx.delete(approvalComments).where(eq(approvalComments.companyId, input.companyId));
  await tx.delete(approvals).where(eq(approvals.companyId, input.companyId));
  await tx.delete(documentRevisions).where(eq(documentRevisions.companyId, input.companyId));
  await tx.delete(taskComments).where(eq(taskComments.companyId, input.companyId));
  await tx.delete(systemEscalationIdentities).where(eq(systemEscalationIdentities.companyId, input.companyId));
  await tx.delete(taskCreatorEdgeReceivability).where(eq(taskCreatorEdgeReceivability.companyId, input.companyId));
  await tx.delete(taskExecutionAuthorities).where(eq(taskExecutionAuthorities.companyId, input.companyId));
  await tx.delete(taskExecutionWorkspaceBindings).where(eq(taskExecutionWorkspaceBindings.companyId, input.companyId));
  await tx.delete(companySecrets).where(eq(companySecrets.companyId, input.companyId));
  await tx.delete(joinRequests).where(eq(joinRequests.companyId, input.companyId));
  await tx.delete(invites).where(eq(invites.companyId, input.companyId));
  await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, input.companyId));
  await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, input.companyId));
  await tx.delete(companySkills).where(eq(companySkills.companyId, input.companyId));
  await tx.delete(routineRuns).where(eq(routineRuns.companyId, input.companyId));
  await tx.delete(routineTriggers).where(eq(routineTriggers.companyId, input.companyId));
  await tx.delete(routineRevisions).where(eq(routineRevisions.companyId, input.companyId));
  await tx.delete(routines).where(eq(routines.companyId, input.companyId));
  await tx.delete(documents).where(eq(documents.companyId, input.companyId));
  await tx.delete(tasks).where(eq(tasks.companyId, input.companyId));
  await tx.delete(companyLogos).where(eq(companyLogos.companyId, input.companyId));
  await tx.delete(assets).where(eq(assets.companyId, input.companyId));
  await tx.delete(goals).where(eq(goals.companyId, input.companyId));
  await tx.delete(projects).where(eq(projects.companyId, input.companyId));
  await tx
    .delete(runtimeAgentConfigurationAudits)
    .where(eq(runtimeAgentConfigurationAudits.companyId, input.companyId));
  await tx
    .update(agents)
    .set({
      currentAdapterConfigRevisionId: null,
      reportsTo: null,
    })
    .where(eq(agents.companyId, input.companyId));
  await tx.delete(agents).where(eq(agents.companyId, input.companyId));
  await tx
    .delete(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, input.companyId));
  const deleted = await tx
    .delete(companies)
    .where(eq(companies.id, input.companyId))
    .returning({ id: companies.id });
  if (!deleted[0]) {
    throw new TaskSessionInvariantError(
      `Fenced company ${input.companyId} disappeared during purge`,
    );
  }
  return {
    companyId: input.companyId,
    generation: operation.generation,
    purged: true,
  };
}
