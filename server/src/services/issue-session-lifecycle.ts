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
  creatorDeliveries,
  documentRevisions,
  documents,
  environmentLeases,
  financeEvents,
  goals,
  invites,
  issueCommentProjectionSources,
  issueComments,
  issueConsultExecutions,
  issueCreatorEdgeReceivability,
  issueExecutionAttemptRetrySchedules,
  issueExecutionAttempts,
  issueExecutionAuthorities,
  issueExecutionCancellationIntents,
  issueExecutionFinalizationDeliveryDependencies,
  issueExecutionFinalizationPromptDependencies,
  issueExecutionFinalizationUpdateDependencies,
  issueExecutionHistoryViewMessages,
  issueExecutionHistoryViews,
  issueExecutionLanes,
  issueExecutionLeases,
  issueExecutionProcessFacts,
  issueExecutionPromptCapabilities,
  issueExecutionRefs,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issueInboxArchives,
  issueReadStates,
  issues,
  issueSessionInputDispositions,
  issueSessions,
  issueUpdates,
  joinRequests,
  pluginCreatorDeliveries,
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
  attachIssueExecutionRunCancellationInTransaction,
  detachIssueExecutionRunAttemptInTransaction,
  detachIssueExecutionRunCancellationInTransaction,
  lockIssueExecutionRunInTransaction,
  purgeCompanyIssueExecutionRunsInTransaction,
} from "./issue-execution-run-service.js";
import {
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
} from "./issue-session/store.js";

type CompanySessionLifecycleTx =
  Parameters<Parameters<Db["transaction"]>[0]>[0];
type PostgresLifecycleOperation =
  typeof companySessionLifecycleOperations.$inferSelect;
type PostgresCancellationIntent =
  typeof issueExecutionCancellationIntents.$inferSelect;

const ACTIVE_ATTEMPT_STATES = ["pending", "leased", "running"] as const;
const LIVE_PROCESS_STATES = ["starting", "running"] as const;
const LIVE_CAPABILITY_STATES = ["pending_setup", "active"] as const;
const LIVE_NATIVE_SESSION_STATES = ["eligible", "current"] as const;

const LIFECYCLE_SNAPSHOT_VERSION =
  "company-session-lifecycle/v1" as const;

interface LifecycleAttemptSnapshot {
  readonly intentId: string;
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string | null;
  readonly processFactId: string | null;
}

export interface CompanySessionLifecycleRun {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
}

interface LifecycleGraphSnapshot extends Record<string, unknown> {
  readonly version: typeof LIFECYCLE_SNAPSHOT_VERSION;
  readonly sessionIds: readonly string[];
  readonly issueIds: readonly string[];
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

export interface CancellationAbsenceProof {
  readonly inMemoryExecutionAbsent: true;
  readonly nativeSessionCancellation: "not_required" | "sent";
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
      throw new IssueSessionInvariantError(
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
): Promise<Array<typeof issueSessions.$inferSelect>> {
  const rows = await tx
    .select()
    .from(issueSessions)
    .where(eq(issueSessions.companyId, companyId));
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
      sql`select ${issueSessions.id} from ${issueSessions}
        where ${issueSessions.companyId} = ${companyId}
          and ${issueSessions.id} = ${row.id}
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
    throw new IssueSessionLifecycleConflict(
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
    !Array.isArray(value.issueIds) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.attempts)
  ) {
    throw new IssueSessionInvariantError(
      `Lifecycle operation ${operation.id} has a non-canonical graph snapshot`,
    );
  }
  const strings = (items: unknown[]): items is string[] =>
    items.every((item) => typeof item === "string" && item.length > 0);
  if (!strings(value.sessionIds) || !strings(value.issueIds)) {
    throw new IssueSessionInvariantError(
      `Lifecycle operation ${operation.id} has invalid Session identities`,
    );
  }
  const runs: CompanySessionLifecycleRun[] = value.runs.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new IssueSessionInvariantError(
        `Lifecycle operation ${operation.id} has invalid run ${index}`,
      );
    }
    const row = item as Record<string, unknown>;
    for (const key of ["companyId", "issueId", "runId"] as const) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        throw new IssueSessionInvariantError(
          `Lifecycle operation ${operation.id} has invalid run ${key}`,
        );
      }
    }
    return row as unknown as CompanySessionLifecycleRun;
  });
  const attempts: LifecycleAttemptSnapshot[] = value.attempts.map(
    (item, index) => {
      if (!item || typeof item !== "object") {
        throw new IssueSessionInvariantError(
          `Lifecycle operation ${operation.id} has invalid attempt ${index}`,
        );
      }
      const row = item as Record<string, unknown>;
      for (const key of [
        "intentId",
        "companyId",
        "issueId",
        "sessionId",
        "runId",
        "attemptId",
      ] as const) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw new IssueSessionInvariantError(
            `Lifecycle operation ${operation.id} has invalid ${key}`,
          );
        }
      }
      for (const key of ["leaseId", "processFactId"] as const) {
        if (row[key] !== null && typeof row[key] !== "string") {
          throw new IssueSessionInvariantError(
            `Lifecycle operation ${operation.id} has invalid ${key}`,
          );
        }
      }
      return row as unknown as LifecycleAttemptSnapshot;
    },
  );
  return {
    version: LIFECYCLE_SNAPSHOT_VERSION,
    sessionIds: value.sessionIds,
    issueIds: value.issueIds,
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
    .from(issueExecutionCancellationIntents)
    .where(
      and(
        eq(issueExecutionCancellationIntents.companyId, operation.companyId),
        inArray(issueExecutionCancellationIntents.id, ids),
      ),
    )
    .orderBy(asc(issueExecutionCancellationIntents.id));
  if (rows.length !== ids.length) {
    throw new IssueSessionInvariantError(
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
      const run = await lockIssueExecutionRunInTransaction(tx, identity);
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
    throw new IssueSessionInvariantError(
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
    throw new IssueSessionLifecycleConflict(
      "A company Session lifecycle operation is already active",
      { companyId: input.companyId, operationId: otherActive[0].id },
    );
  }

  const sessions = await lockSessionsParentFirst(tx, input.companyId);
  const attempts = await tx
    .select()
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.companyId, input.companyId),
        inArray(issueExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
      ),
    )
    .orderBy(asc(issueExecutionAttempts.id))
    .for("update");
  const attemptIds = attempts.map((attempt) => attempt.id);
  const leases = attemptIds.length
    ? await tx
        .select()
        .from(issueExecutionLeases)
        .where(inArray(issueExecutionLeases.attemptId, attemptIds))
        .orderBy(asc(issueExecutionLeases.id))
        .for("update")
    : [];
  const processes = attemptIds.length
    ? await tx
        .select()
        .from(issueExecutionProcessFacts)
        .where(inArray(issueExecutionProcessFacts.attemptId, attemptIds))
        .orderBy(asc(issueExecutionProcessFacts.id))
        .for("update")
    : [];
  const existingIntents = attemptIds.length
    ? await tx
        .select()
        .from(issueExecutionCancellationIntents)
        .where(inArray(issueExecutionCancellationIntents.attemptId, attemptIds))
        .orderBy(asc(issueExecutionCancellationIntents.id))
        .for("update")
    : [];
  const leaseByAttempt = new Map(
    leases.map((lease) => [lease.attemptId, lease] as const),
  );
  const processByAttempt = new Map(
    processes.map((process) => [process.attemptId, process] as const),
  );
  const intentByAttempt = new Map(
    existingIntents.map((intent) => [intent.attemptId, intent] as const),
  );
  const actor = lifecycleActor(input.actor);

  const openRunRefs = await tx
    .select({
      companyId: issueExecutionRunRefs.companyId,
      issueId: issueExecutionRunRefs.issueId,
      runId: issueExecutionRunRefs.runId,
    })
    .from(issueExecutionRunRefs)
    .where(
      and(
        eq(issueExecutionRunRefs.companyId, input.companyId),
        isNull(issueExecutionRunRefs.protocolSettlementState),
      ),
    );
  const candidateRunIdentities = new Map<
    string,
    CompanySessionLifecycleRun
  >();
  for (const identity of [
    ...attempts.map((attempt) => ({
      companyId: attempt.companyId,
      issueId: attempt.issueId,
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
    const run = await lockIssueExecutionRunInTransaction(tx, identity);
    if (["queued", "scheduled_retry", "running"].includes(run.status)) {
      activeRuns.push(identity);
    }
  }

  const pendingInserts: Array<
    typeof issueExecutionCancellationIntents.$inferInsert
  > = [];
  const attemptSnapshots: LifecycleAttemptSnapshot[] = [];
  for (const attempt of attempts) {
    const run = await lockIssueExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      issueId: attempt.issueId,
      runId: attempt.runId,
    });
    if (
      run.sessionId !== attempt.sessionId ||
      run.kind !== attempt.runKind
    ) {
      throw new IssueSessionLifecycleConflict(
        "Lifecycle cancellation crossed the exact run/attempt scope",
        { runId: run.runId, attemptId: attempt.id },
      );
    }
    const lease = leaseByAttempt.get(attempt.id) ?? null;
    const process = processByAttempt.get(attempt.id) ?? null;
    if (
      attempt.state !== "pending" &&
      (!lease || lease.state !== "active")
    ) {
      throw new IssueSessionLifecycleConflict(
        "A leased or running attempt requires its exact active lease",
        { runId: attempt.runId, attemptId: attempt.id },
      );
    }
    if (process && (!lease || process.leaseId !== lease.id)) {
      throw new IssueSessionLifecycleConflict(
        "A retained process fact crossed its exact attempt lease",
        { runId: attempt.runId, attemptId: attempt.id },
      );
    }
    const existingIntent = intentByAttempt.get(attempt.id) ?? null;
    if (
      existingIntent &&
      !["requested", "acknowledged"].includes(existingIntent.state)
    ) {
      throw new IssueSessionLifecycleConflict(
        "An active attempt has a terminal cancellation intent",
        { attemptId: attempt.id, intentId: existingIntent.id },
      );
    }
    const intentId = existingIntent?.id ?? randomUUID();
    if (!existingIntent) {
      pendingInserts.push({
        id: intentId,
        companyId: attempt.companyId,
        issueId: attempt.issueId,
        runId: attempt.runId,
        attemptId: attempt.id,
        leaseId: lease?.id ?? null,
        processFactId: process?.id ?? null,
        reasonKind: "lifecycle",
        ...actor,
        state: "requested",
        requestedAt: input.now,
        processTerminationRequestedAt: process ? input.now : null,
        createdAt: input.now,
      });
    }
    attemptSnapshots.push({
      intentId,
      companyId: attempt.companyId,
      issueId: attempt.issueId,
      sessionId: attempt.sessionId,
      runId: attempt.runId,
      attemptId: attempt.id,
      leaseId: lease?.id ?? null,
      processFactId: process?.id ?? null,
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
    issueIds: [...new Set(sessions.map((session) => session.issueId))],
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
    throw new IssueSessionInvariantError(
      "Company Session lifecycle operation was not persisted",
    );
  }
  if (pendingInserts.length > 0) {
    await tx.insert(issueExecutionCancellationIntents).values(pendingInserts);
  }

  for (const attempt of attemptSnapshots) {
    if (!attempt.leaseId) continue;
    const run = await lockIssueExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      issueId: attempt.issueId,
      runId: attempt.runId,
    });
    if (run.cancellationIntentId === attempt.intentId) continue;
    if (
      run.status === "running" &&
      run.currentAttemptId === attempt.attemptId &&
      run.currentLeaseId === attempt.leaseId &&
      run.cancellationIntentId === null
    ) {
      await attachIssueExecutionRunCancellationInTransaction(tx, {
        companyId: attempt.companyId,
        issueId: attempt.issueId,
        runId: attempt.runId,
        expectedAttemptId: attempt.attemptId,
        expectedLeaseId: attempt.leaseId,
        cancellationIntentId: attempt.intentId,
        at: input.now,
      });
      continue;
    }
    if (run.cancellationIntentId !== null) {
      throw new IssueSessionLifecycleConflict(
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
    .update(issueSessions)
    .set({
      integrityState:
        input.operation === "hard_delete" ? "purge_fenced" : "archived",
      refAdmittableAt: null,
      timeArchived: input.now,
      purgeFencedAt:
        input.operation === "hard_delete" ? input.now : null,
      timeUpdated: input.now,
    })
    .where(eq(issueSessions.companyId, input.companyId));
  await tx
    .update(issueExecutionRefs)
    .set({
      disposition: "invalidated",
      invalidationReason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(issueExecutionRefs.companyId, input.companyId),
        eq(issueExecutionRefs.disposition, "active"),
      ),
    );
  await tx
    .update(issueSessionInputDispositions)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      invalidatedBySourceKind: "company_lifecycle",
      invalidatedBySourceId: input.lifecycleOperationId,
    })
    .where(
      and(
        eq(issueSessionInputDispositions.companyId, input.companyId),
        eq(issueSessionInputDispositions.state, "active"),
      ),
    );
  await tx
    .update(issueExecutionHistoryViews)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(issueExecutionHistoryViews.companyId, input.companyId),
        inArray(issueExecutionHistoryViews.state, [
          "empty",
          "preparing",
          "current",
        ]),
      ),
    );
  await tx
    .update(issueExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: invalidationReason,
      supersededAt: input.now,
    })
    .where(
      and(
        eq(issueExecutionSessions.companyId, input.companyId),
        inArray(issueExecutionSessions.state, [
          ...LIVE_NATIVE_SESSION_STATES,
        ]),
      ),
    );
  await tx
    .update(issueExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: invalidationReason,
      revokedAt: input.now,
    })
    .where(
      and(
        eq(issueExecutionPromptCapabilities.companyId, input.companyId),
        inArray(issueExecutionPromptCapabilities.state, [
          ...LIVE_CAPABILITY_STATES,
        ]),
      ),
    );
  await tx
    .update(issueExecutionLeases)
    .set({ state: "revoked", releasedAt: input.now })
    .where(
      and(
        eq(issueExecutionLeases.companyId, input.companyId),
        eq(issueExecutionLeases.state, "active"),
      ),
    );
  await tx
    .update(issueExecutionAttemptRetrySchedules)
    .set({ state: "cancelled", cancelledAt: input.now })
    .where(
      and(
        eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId),
        eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    );
  await tx
    .update(issueConsultExecutions)
    .set({
      state: "cancelled",
      closeReason: invalidationReason,
      closedAt: input.now,
    })
    .where(
      and(
        eq(issueConsultExecutions.companyId, input.companyId),
        eq(issueConsultExecutions.state, "active"),
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
    throw new IssueSessionInvariantError(
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
    throw new IssueSessionLifecycleConflict(
      "Company reactivation cannot resolve its company",
      input,
    );
  }
  if (company.sessionIntegrityState === "hard_delete_fenced") {
    throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
      "Company reactivation requires a completed archive fence",
      {
        companyId: input.companyId,
        integrityState: company.sessionIntegrityState,
        archiveStatus: archive?.status ?? null,
      },
    );
  }
  const activeAttempts = await tx
    .select({ id: issueExecutionAttempts.id })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.companyId, input.companyId),
        inArray(issueExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
      ),
    )
    .limit(1);
  if (activeAttempts[0]) {
    throw new IssueSessionLifecycleConflict(
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
    .update(issueSessions)
    .set({
      integrityState: "ready",
      refAdmittableAt: now,
      timeArchived: null,
      purgeFencedAt: null,
      timeUpdated: now,
    })
    .where(
      and(
        eq(issueSessions.companyId, input.companyId),
        eq(issueSessions.integrityState, "archived"),
      ),
    );
  return { companyId: input.companyId, generation: archive.generation };
}

/**
 * Claims durable cancellation work without inventing a second worker-lease
 * schema. Acknowledged rows remain restart-safe and every stop operation must
 * therefore be idempotent for the exact attempt/process identity.
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
    throw new IssueSessionLifecycleConflict(
      "Cancellation claim limit must be between 1 and 1000",
    );
  }
  const now = input.now ?? new Date();
  await lockCompanySessionLifecycle(tx, input.companyId);
  const candidates = await tx
    .select()
    .from(issueExecutionCancellationIntents)
    .where(
      and(
        eq(issueExecutionCancellationIntents.companyId, input.companyId),
        inArray(issueExecutionCancellationIntents.state, [
          "requested",
          "acknowledged",
        ]),
        input.intentIds?.length
          ? inArray(issueExecutionCancellationIntents.id, [
              ...input.intentIds,
            ])
          : undefined,
      ),
    )
    .orderBy(
      asc(issueExecutionCancellationIntents.requestedAt),
      asc(issueExecutionCancellationIntents.id),
    )
    .limit(input.limit)
    .for("update", {
      of: issueExecutionCancellationIntents,
      skipLocked: true,
    });
  if (candidates.length === 0) return [];
  const requestedIds = candidates
    .filter((intent) => intent.state === "requested")
    .map((intent) => intent.id);
  if (requestedIds.length > 0) {
    await tx
      .update(issueExecutionCancellationIntents)
      .set({ state: "acknowledged", acknowledgedAt: now })
      .where(inArray(issueExecutionCancellationIntents.id, requestedIds));
  }
  return tx
    .select()
    .from(issueExecutionCancellationIntents)
    .where(
      inArray(
        issueExecutionCancellationIntents.id,
        candidates.map((intent) => intent.id),
      ),
    )
    .orderBy(
      asc(issueExecutionCancellationIntents.requestedAt),
      asc(issueExecutionCancellationIntents.id),
    );
}

export async function completeCompanyCancellationIntentInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly intentId: string;
    readonly proof: CancellationAbsenceProof;
    readonly now?: Date;
  },
): Promise<{
  readonly intent: PostgresCancellationIntent;
  readonly operation: PostgresLifecycleOperation | null;
}> {
  const now = input.now ?? new Date();
  const initial = await tx
    .select()
    .from(issueExecutionCancellationIntents)
    .where(eq(issueExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!initial) {
    throw new IssueSessionInvariantError(
      `Cancellation intent ${input.intentId} does not exist`,
    );
  }
  await lockCompanySessionLifecycle(tx, initial.companyId);
  const intent = await tx
    .select()
    .from(issueExecutionCancellationIntents)
    .where(eq(issueExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!intent) {
    throw new IssueSessionInvariantError(
      `Cancellation intent ${input.intentId} disappeared while locking`,
    );
  }
  const operation = await activeOperationForIntent(tx, intent);
  if (intent.state === "completed") {
    return {
      intent,
      operation: operation
        ? await refreshLifecycleOperationAfterCancellationInTx(
            tx,
            operation,
            now,
          )
        : null,
    };
  }
  if (intent.state !== "acknowledged") {
    throw new IssueSessionLifecycleConflict(
      "Cancellation completion requires an acknowledged intent",
      { intentId: intent.id, state: intent.state },
    );
  }
  if (input.proof.inMemoryExecutionAbsent !== true) {
    throw new IssueSessionLifecycleConflict(
      "Cancellation completion requires exact in-memory absence",
      { intentId: intent.id },
    );
  }
  const attempt = await tx
    .select()
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.id, intent.attemptId),
        eq(issueExecutionAttempts.companyId, intent.companyId),
        eq(issueExecutionAttempts.issueId, intent.issueId),
        eq(issueExecutionAttempts.runId, intent.runId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!attempt) {
    throw new IssueSessionInvariantError(
      `Cancellation intent ${intent.id} lost attempt ${intent.attemptId}`,
    );
  }
  if (
    attempt.state === "running" &&
    input.proof.nativeSessionCancellation !== "sent"
  ) {
    throw new IssueSessionLifecycleConflict(
      "A running attempt requires an exact native-session cancellation signal",
      { intentId: intent.id, attemptId: attempt.id },
    );
  }
  const processFact = intent.processFactId
    ? await tx
        .select()
        .from(issueExecutionProcessFacts)
        .where(
          and(
            eq(issueExecutionProcessFacts.id, intent.processFactId),
            eq(issueExecutionProcessFacts.companyId, intent.companyId),
            eq(issueExecutionProcessFacts.issueId, intent.issueId),
            eq(issueExecutionProcessFacts.runId, intent.runId),
            eq(issueExecutionProcessFacts.attemptId, intent.attemptId),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : null;
  if (
    intent.processFactId &&
    (!processFact ||
      LIVE_PROCESS_STATES.includes(
        processFact.state as (typeof LIVE_PROCESS_STATES)[number],
      ))
  ) {
    throw new IssueSessionLifecycleConflict(
      "Cancellation cannot complete while its exact process is live or missing",
      { intentId: intent.id, processFactId: intent.processFactId },
    );
  }

  if (intent.leaseId) {
    await tx
      .update(issueExecutionLeases)
      .set({ state: "revoked", releasedAt: now })
      .where(
        and(
          eq(issueExecutionLeases.id, intent.leaseId),
          eq(issueExecutionLeases.attemptId, intent.attemptId),
          eq(issueExecutionLeases.state, "active"),
        ),
      );
  }
  if (
    ACTIVE_ATTEMPT_STATES.includes(
      attempt.state as (typeof ACTIVE_ATTEMPT_STATES)[number],
    )
  ) {
    await tx
      .update(issueExecutionAttempts)
      .set({ state: "cancelled", finishedAt: now })
      .where(eq(issueExecutionAttempts.id, attempt.id));
  }
  const completed = await tx
    .update(issueExecutionCancellationIntents)
    .set({
      state: "completed",
      sessionCancelSentAt:
        input.proof.nativeSessionCancellation === "sent"
          ? intent.sessionCancelSentAt ?? now
          : intent.sessionCancelSentAt,
      processTerminatedAt: processFact ? now : null,
      completedAt: now,
      failedAt: null,
      failureCode: null,
    })
    .where(eq(issueExecutionCancellationIntents.id, intent.id))
    .returning()
    .then((rows) => rows[0]);
  if (!completed) {
    throw new IssueSessionInvariantError(
      `Cancellation intent ${intent.id} was not completed`,
    );
  }

  const run = await lockIssueExecutionRunInTransaction(tx, {
    companyId: intent.companyId,
    issueId: intent.issueId,
    runId: intent.runId,
  });
  if (run.cancellationIntentId === intent.id) {
    await detachIssueExecutionRunCancellationInTransaction(tx, {
      companyId: intent.companyId,
      issueId: intent.issueId,
      runId: intent.runId,
      expectedCancellationIntentId: intent.id,
      at: now,
    });
  } else if (run.cancellationIntentId !== null) {
    throw new IssueSessionLifecycleConflict(
      "Cancellation completion crossed another run cancellation pointer",
      { runId: run.runId, cancellationIntentId: run.cancellationIntentId },
    );
  }
  const detachedRun = await lockIssueExecutionRunInTransaction(tx, {
    companyId: intent.companyId,
    issueId: intent.issueId,
    runId: intent.runId,
  });
  if (
    intent.leaseId &&
    detachedRun.currentAttemptId === intent.attemptId &&
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    await detachIssueExecutionRunAttemptInTransaction(tx, {
      companyId: intent.companyId,
      issueId: intent.issueId,
      runId: intent.runId,
      expectedAttemptId: intent.attemptId,
      expectedLeaseId: intent.leaseId,
      at: now,
    });
  } else if (
    detachedRun.currentAttemptId === intent.attemptId ||
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    throw new IssueSessionLifecycleConflict(
      "Cancellation completion found a partial run attempt pointer",
      { runId: detachedRun.runId, attemptId: intent.attemptId },
    );
  }

  return {
    intent: completed,
    operation: operation
      ? await refreshLifecycleOperationAfterCancellationInTx(
          tx,
          operation,
          now,
        )
      : null,
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
    throw new IssueSessionLifecycleConflict(
      "Cancellation failure code must contain 1 to 200 characters",
    );
  }
  const now = input.now ?? new Date();
  const initial = await tx
    .select()
    .from(issueExecutionCancellationIntents)
    .where(eq(issueExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!initial) {
    throw new IssueSessionInvariantError(
      `Cancellation intent ${input.intentId} does not exist`,
    );
  }
  await lockCompanySessionLifecycle(tx, initial.companyId);
  const failed = await tx
    .update(issueExecutionCancellationIntents)
    .set({ state: "failed", failedAt: now, failureCode })
    .where(
      and(
        eq(issueExecutionCancellationIntents.id, input.intentId),
        eq(issueExecutionCancellationIntents.state, "acknowledged"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!failed) {
    throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
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
    liveProcess,
    liveCapability,
    liveNativeSession,
    activeRef,
    activeConsult,
    scheduledRetry,
    activeLane,
    activeRemoteExecution,
  ] = await Promise.all([
    tx
      .select({ id: issueExecutionAttempts.id })
      .from(issueExecutionAttempts)
      .where(
        and(
          eq(issueExecutionAttempts.companyId, input.companyId),
          inArray(issueExecutionAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionLeases.id })
      .from(issueExecutionLeases)
      .where(
        and(
          eq(issueExecutionLeases.companyId, input.companyId),
          eq(issueExecutionLeases.state, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionProcessFacts.id })
      .from(issueExecutionProcessFacts)
      .where(
        and(
          eq(issueExecutionProcessFacts.companyId, input.companyId),
          inArray(issueExecutionProcessFacts.state, [...LIVE_PROCESS_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionPromptCapabilities.capabilityConnectionId })
      .from(issueExecutionPromptCapabilities)
      .where(
        and(
          eq(issueExecutionPromptCapabilities.companyId, input.companyId),
          inArray(issueExecutionPromptCapabilities.state, [
            ...LIVE_CAPABILITY_STATES,
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionSessions.id })
      .from(issueExecutionSessions)
      .where(
        and(
          eq(issueExecutionSessions.companyId, input.companyId),
          inArray(issueExecutionSessions.state, [
            ...LIVE_NATIVE_SESSION_STATES,
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionRefs.id })
      .from(issueExecutionRefs)
      .where(
        and(
          eq(issueExecutionRefs.companyId, input.companyId),
          eq(issueExecutionRefs.disposition, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueConsultExecutions.id })
      .from(issueConsultExecutions)
      .where(
        and(
          eq(issueConsultExecutions.companyId, input.companyId),
          eq(issueConsultExecutions.state, "active"),
        ),
      )
      .limit(1),
    tx
      .select({ id: issueExecutionAttemptRetrySchedules.id })
      .from(issueExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(issueExecutionAttemptRetrySchedules.state, "scheduled"),
        ),
      )
      .limit(1),
    tx
      .select({ leaseId: issueExecutionLanes.activeLeaseId })
      .from(issueExecutionLanes)
      .where(
        and(
          eq(issueExecutionLanes.companyId, input.companyId),
          isNotNull(issueExecutionLanes.activeOrdinal),
        ),
      )
      .limit(1),
    tx
      .select({ id: environmentLeases.id })
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.status, "active"),
          isNotNull(environmentLeases.runId),
        ),
      )
      .limit(1),
  ]);
  if (
    uncompletedIntent ||
    activeAttempt[0] ||
    activeLease[0] ||
    liveProcess[0] ||
    liveCapability[0] ||
    liveNativeSession[0] ||
    activeRef[0] ||
    activeConsult[0] ||
    scheduledRetry[0] ||
    activeLane[0] ||
    activeRemoteExecution[0]
  ) {
    throw new IssueSessionLifecycleConflict(
      "Company Session graph purge is not cancellation-safe",
      {
        companyId: input.companyId,
        lifecycleOperationId: operation.id,
        uncompletedIntentId: uncompletedIntent?.id ?? null,
        activeAttemptId: activeAttempt[0]?.id ?? null,
        activeLeaseId: activeLease[0]?.id ?? null,
        liveProcessFactId: liveProcess[0]?.id ?? null,
        liveCapabilityId: liveCapability[0]?.id ?? null,
        liveNativeSessionId: liveNativeSession[0]?.id ?? null,
        activeRefId: activeRef[0]?.id ?? null,
        activeConsultId: activeConsult[0]?.id ?? null,
        scheduledRetryId: scheduledRetry[0]?.id ?? null,
        activeLaneLeaseId: activeLane[0]?.leaseId ?? null,
        activeRemoteExecutionId: activeRemoteExecution[0]?.id ?? null,
      },
    );
  }

  const sessions = await lockSessionsParentFirst(tx, input.companyId);
  const parentById = new Map(
    sessions.map((session) => [session.id, session.parentSessionId] as const),
  );

  // External run restrictors are removed before the canonical run roots.
  await tx
    .delete(issueExecutionFinalizationDeliveryDependencies)
    .where(
      eq(
        issueExecutionFinalizationDeliveryDependencies.companyId,
        input.companyId,
      ),
    );
  await tx
    .delete(issueExecutionFinalizationUpdateDependencies)
    .where(
      eq(
        issueExecutionFinalizationUpdateDependencies.companyId,
        input.companyId,
      ),
    );
  await tx
    .delete(issueExecutionFinalizationPromptDependencies)
    .where(
      eq(
        issueExecutionFinalizationPromptDependencies.companyId,
        input.companyId,
      ),
    );
  await tx
    .delete(issueExecutionCancellationIntents)
    .where(eq(issueExecutionCancellationIntents.companyId, input.companyId));
  await tx
    .delete(issueExecutionProcessFacts)
    .where(eq(issueExecutionProcessFacts.companyId, input.companyId));
  await tx
    .delete(issueExecutionLeases)
    .where(eq(issueExecutionLeases.companyId, input.companyId));
  await tx
    .delete(issueExecutionAttemptRetrySchedules)
    .where(eq(issueExecutionAttemptRetrySchedules.companyId, input.companyId));
  await tx
    .delete(issueExecutionAttempts)
    .where(eq(issueExecutionAttempts.companyId, input.companyId));
  await tx
    .delete(issueCommentProjectionSources)
    .where(eq(issueCommentProjectionSources.companyId, input.companyId));
  await purgeCompanyIssueExecutionRunsInTransaction(tx, {
    companyId: input.companyId,
  });

  // Native correlations and Session projections no longer restrict a run.
  await tx
    .delete(issueExecutionSessions)
    .where(eq(issueExecutionSessions.companyId, input.companyId));
  await tx
    .delete(issueExecutionHistoryViewMessages)
    .where(eq(issueExecutionHistoryViewMessages.companyId, input.companyId));
  for (const sessionId of [...snapshot.sessionIds].sort(
    (left, right) =>
      sessionDepth(right, parentById) - sessionDepth(left, parentById) ||
      left.localeCompare(right),
  )) {
    await tx
      .delete(issueSessions)
      .where(
        and(
          eq(issueSessions.companyId, input.companyId),
          eq(issueSessions.id, sessionId),
        ),
      );
  }

  await tx.delete(activityLog).where(eq(activityLog.companyId, input.companyId));
  await tx.delete(financeEvents).where(eq(financeEvents.companyId, input.companyId));
  await tx.delete(costEvents).where(eq(costEvents.companyId, input.companyId));
  await tx.delete(pluginCreatorDeliveries).where(eq(pluginCreatorDeliveries.companyId, input.companyId));
  await tx.delete(creatorDeliveries).where(eq(creatorDeliveries.companyId, input.companyId));
  await tx.delete(pluginWithdrawalOperations).where(eq(pluginWithdrawalOperations.companyId, input.companyId));
  await tx.delete(issueUpdates).where(eq(issueUpdates.companyId, input.companyId));
  await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, input.companyId));
  await tx.delete(issueInboxArchives).where(eq(issueInboxArchives.companyId, input.companyId));
  await tx.delete(approvalComments).where(eq(approvalComments.companyId, input.companyId));
  await tx.delete(approvals).where(eq(approvals.companyId, input.companyId));
  await tx.delete(documentRevisions).where(eq(documentRevisions.companyId, input.companyId));
  await tx.delete(issueComments).where(eq(issueComments.companyId, input.companyId));
  await tx.delete(systemEscalationIdentities).where(eq(systemEscalationIdentities.companyId, input.companyId));
  await tx.delete(issueCreatorEdgeReceivability).where(eq(issueCreatorEdgeReceivability.companyId, input.companyId));
  await tx.delete(issueExecutionAuthorities).where(eq(issueExecutionAuthorities.companyId, input.companyId));
  await tx.delete(issueExecutionWorkspaceBindings).where(eq(issueExecutionWorkspaceBindings.companyId, input.companyId));
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
  await tx.delete(issues).where(eq(issues.companyId, input.companyId));
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
      defaultEnvironmentId: null,
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
    throw new IssueSessionInvariantError(
      `Fenced company ${input.companyId} disappeared during purge`,
    );
  }
  return {
    companyId: input.companyId,
    generation: operation.generation,
    purged: true,
  };
}
