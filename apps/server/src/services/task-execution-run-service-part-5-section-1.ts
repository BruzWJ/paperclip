import {
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionRuns,
} from "@paperclipai/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { isTaskExecutionRefDeliveryEligible } from "./task-execution-ref-delivery.js";
import * as runContracts from "./task-execution-run-service-part-1-section-1.js";
import { assertCreationInput, assertRelatedRunScope } from "./task-execution-run-service-part-4-section-1.js";
import {
  computeTaskExecutionRunBatchDigest,
  projectRunEnvelope,
  selectExactRunRow,
} from "./task-execution-run-service-part-2-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/**
 * Creates the envelope and the complete productive/consult membership under
 * one caller-owned transaction. The caller must already hold the lane
 * admission fence; this function locks every named ref before deriving order.
 */
export async function createTaskExecutionRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: runContracts.CreateTaskExecutionRunInput,
): Promise<runContracts.CreatedTaskExecutionRun> {
  assertCreationInput(input);

  if (input.kind === "consult") {
    const parent = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.parentRunId,
      },
      true,
    );
    if (!parent) {
      throw new runContracts.TaskExecutionRunInvariantViolation("consult parent run does not exist");
    }
    assertRelatedRunScope(projectRunEnvelope(parent), input, "parent");
  }
  if (input.retryOfRunId) {
    const retry = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.retryOfRunId,
      },
      true,
    );
    if (!retry) {
      throw new runContracts.TaskExecutionRunInvariantViolation("retry source run does not exist");
    }
    assertRelatedRunScope(projectRunEnvelope(retry), input, "retry");
    const existingSuccessor = await transaction
      .select({ id: taskExecutionRuns.id })
      .from(taskExecutionRuns)
      .where(
        and(
          eq(taskExecutionRuns.companyId, input.companyId),
          eq(taskExecutionRuns.taskId, input.taskId),
          eq(taskExecutionRuns.retryOfRunId, input.retryOfRunId),
        ),
      )
      .limit(1)
      .for("update");
    if (existingSuccessor.length > 0) {
      throw new runContracts.TaskExecutionRunInvariantViolation(
        "retry source run already owns its exact successor",
      );
    }
  }

  let lockedRefs: (typeof taskExecutionRefs.$inferSelect)[] = [];
  let batchDigest: string | null = null;
  {
    const rows = await transaction
      .select()
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.taskId, input.taskId),
          eq(taskExecutionRefs.sessionId, input.sessionId),
          inArray(taskExecutionRefs.id, [...input.orderedRefIds]),
        ),
      )
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    lockedRefs = input.orderedRefIds.map((refId) => {
      const ref = byId.get(refId);
      if (!ref) {
        throw new runContracts.TaskExecutionRunInvariantViolation(
          "run ref batch contains an identity outside the exact Session scope",
        );
      }
      return ref;
    });
    if (rows.length !== lockedRefs.length) {
      throw new runContracts.TaskExecutionRunInvariantViolation(
        "run ref batch did not lock one exact row per identity",
      );
    }
    for (const ref of lockedRefs) {
      const correctBranch =
        input.kind === "productive"
          ? ref.mode === "owner" &&
            ref.taskExecutionAuthorityId === input.taskExecutionAuthorityId &&
            ref.consultExecutionId === null
          : ref.mode === "consult" &&
            ref.taskExecutionAuthorityId === null &&
            ref.consultExecutionId === input.consultExecutionId;
      if (
        !correctBranch ||
        ref.disposition !== "active" ||
        ref.ownershipEpoch !== input.ownershipEpoch ||
        ref.executionScopeId !== input.executionScopeId ||
        ref.targetAgentId !== input.targetAgentId ||
        ref.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
        !isTaskExecutionRefDeliveryEligible(ref, "dispatch")
      ) {
        throw new runContracts.TaskExecutionRunInvariantViolation(
          "run ref batch crossed its locked execution identity or admission state",
        );
      }
    }
    batchDigest = computeTaskExecutionRunBatchDigest(
      lockedRefs.map((ref) => ({
        refId: ref.id,
        messageKind: ref.messageKind,
        sourceMessageId: ref.sourceMessageId,
        admissionOrder: ref.laneOrdinal,
        admissionVersion: ref.admissionHighWaterSeq + 1,
      })),
    );
  }

  const insertedRuns = await transaction
    .insert(taskExecutionRuns)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      executionScopeId: input.executionScopeId,
      kind: input.kind,
      status: "queued",
      ownershipEpoch: input.ownershipEpoch,
      targetAgentId: input.targetAgentId,
      adapterConfigRevisionId: input.adapterConfigRevisionId,
      executionWorkspaceBindingId: input.executionWorkspaceBindingId,
      executionMode: input.kind === "productive" ? "owner" : "consult",
      taskExecutionAuthorityId: input.kind === "productive" ? input.taskExecutionAuthorityId : null,
      consultExecutionId: input.kind === "consult" ? input.consultExecutionId : null,
      parentRunId: input.kind === "consult" ? input.parentRunId : null,
      retryOfRunId: input.retryOfRunId ?? null,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning();
  const insertedRun = insertedRuns[0];
  if (!insertedRun) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run creation did not return the canonical envelope",
    );
  }

  const insertedRefs = await transaction
    .insert(taskExecutionRunRefs)
    .values(
      lockedRefs.map((ref, refOrdinal) => ({
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        runId: insertedRun.id,
        refId: ref.id,
        refOrdinal,
        admissionOrder: ref.laneOrdinal,
        batchDigest: batchDigest!,
        inputId: ref.inputId,
        createdAt: input.at,
      })),
    )
    .returning();
  if (insertedRefs.length !== lockedRefs.length) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run creation did not persist its complete immutable ref batch",
    );
  }
  await transaction.insert(taskExecutionRunControls).values({
    runId: insertedRun.id,
    currentRefId: null,
    currentOrdinal: null,
    currentSegmentOrdinal: null,
  });
  return {
    run: projectRunEnvelope(insertedRun),
    refs: insertedRefs,
    batchDigest,
  };
}

export async function transitionTaskExecutionRunStatusInTransaction(
  transaction: TaskSessionDbTransaction,
  input: runContracts.TransitionTaskExecutionRunStatusInput,
): Promise<runContracts.TaskExecutionRunEnvelope> {
  runContracts.assertRunIdentity(input);
  runContracts.assertDate(input.at, "run transition time");
  if (input.status === "running") {
    runContracts.assertDate(input.startedAt, "run start time");
    if (input.startedAt > input.at) {
      throw new runContracts.TaskExecutionRunInvariantViolation(
        "run start time cannot follow its running transition",
      );
    }
  }
  const predicates = [
    eq(taskExecutionRuns.id, input.runId),
    eq(taskExecutionRuns.companyId, input.companyId),
    eq(taskExecutionRuns.taskId, input.taskId),
    eq(taskExecutionRuns.status, input.expectedStatus),
    isNull(taskExecutionRuns.terminalFinalizationId),
    isNull(taskExecutionRuns.finishedAt),
  ];
  if (input.status === "running") {
    predicates.push(
      input.startedAt.getTime() === input.at.getTime()
        ? or(isNull(taskExecutionRuns.startedAt), eq(taskExecutionRuns.startedAt, input.startedAt))!
        : eq(taskExecutionRuns.startedAt, input.startedAt),
    );
  }
  if (input.status !== "running") {
    predicates.push(
      isNull(taskExecutionRuns.currentAttemptId),
      isNull(taskExecutionRuns.currentLeaseId),
      isNull(taskExecutionRuns.cancellationIntentId),
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      status: input.status,
      ...(input.status === "running" ? { startedAt: input.startedAt } : {}),
      updatedAt: input.at,
    })
    .where(and(...predicates))
    .returning();
  if (!changed[0]) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      `run cannot transition from ${input.expectedStatus} to ${input.status}`,
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachTaskExecutionRunAttemptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: runContracts.AttachTaskExecutionRunAttemptInput,
): Promise<runContracts.TaskExecutionRunEnvelope> {
  runContracts.assertRunIdentity(input);
  runContracts.assertExactRunIdentifier(input.attemptId, "attempt id");
  runContracts.assertExactRunIdentifier(input.leaseId, "lease id");
  runContracts.assertDate(input.at, "attempt attachment time");
  const attempts = await transaction
    .select({
      id: taskExecutionAttempts.id,
      state: taskExecutionAttempts.state,
    })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, input.attemptId),
        eq(taskExecutionAttempts.companyId, input.companyId),
        eq(taskExecutionAttempts.taskId, input.taskId),
        eq(taskExecutionAttempts.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  const leases = await transaction
    .select({
      id: taskExecutionLeases.id,
      attemptId: taskExecutionLeases.attemptId,
      state: taskExecutionLeases.state,
    })
    .from(taskExecutionLeases)
    .where(
      and(
        eq(taskExecutionLeases.id, input.leaseId),
        eq(taskExecutionLeases.companyId, input.companyId),
        eq(taskExecutionLeases.taskId, input.taskId),
        eq(taskExecutionLeases.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !attempts[0] ||
    !leases[0] ||
    !["leased", "running"].includes(attempts[0].state) ||
    leases[0].attemptId !== input.attemptId ||
    leases[0].state !== "active"
  ) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run attempt attachment does not target one exact active attempt/lease pair",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      currentAttemptId: input.attemptId,
      currentLeaseId: input.leaseId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        isNull(taskExecutionRuns.currentAttemptId),
        isNull(taskExecutionRuns.currentLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run cannot attach the selected attempt and lease",
    );
  }
  return projectRunEnvelope(changed[0]);
}
