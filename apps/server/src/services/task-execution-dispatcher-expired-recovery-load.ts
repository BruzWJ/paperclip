import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import type { PostgresTaskExecutionDispatcherRepositoryContext } from "./task-execution-dispatcher-postgres-part-6.js";
import {
  RunRow,
  classifyExpiredPromptClosure,
  exactlyOne,
  reject,
} from "./task-execution-dispatcher-postgres-part-1.js";

export async function loadExpiredRunRecoveryPrompt(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
  transaction: TaskSessionDbTransaction,
  run: RunRow,
  at: Date,
) {
  const options = context;
  const { idFactory } = context;
  if (run.currentAttemptId === null || run.currentLeaseId === null) {
    return { kind: "complete" as const, result: { kind: "current", run } };
  }
  const cancellation =
    run.cancellationIntentId === null
      ? null
      : exactlyOne(
          await transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(eq(taskExecutionCancellationIntents.id, run.cancellationIntentId))
            .limit(2)
            .for("update"),
          "expired run lost its attached cancellation intent",
        );
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
    control.currentOrdinal === null
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
      .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionRunRefs.refId))
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
  const attempt = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionAttempts)
      .where(eq(taskExecutionAttempts.id, run.currentAttemptId))
      .limit(2)
      .for("update"),
    "expired run lost its exact attempt",
  );
  const promptOwner = member.row;
  const promptOwnerIsUnbound =
    promptOwner.attemptId === null &&
    promptOwner.capabilityConnectionId === null &&
    promptOwner.capabilityGeneration === null;
  const promptOwnerHasBoundShape =
    promptOwner.attemptId === attempt.id &&
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
    return { kind: "complete" as const, result: { kind: "current", run } };
  }
  if (
    attempt.companyId !== run.companyId ||
    attempt.taskId !== run.taskId ||
    attempt.sessionId !== run.sessionId ||
    attempt.runId !== run.runId ||
    attempt.runKind !== run.kind ||
    attempt.refId !== control.currentRefId ||
    attempt.refOrdinal !== control.currentOrdinal ||
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
        (cancellation.state !== "requested" && cancellation.state !== "acknowledged"))) ||
    member.ref.companyId !== run.companyId ||
    member.ref.taskId !== run.taskId ||
    member.ref.sessionId !== run.sessionId ||
    member.ref.ownershipEpoch !== run.ownershipEpoch ||
    member.ref.targetAgentId !== run.targetAgentId ||
    member.ref.mode !== run.executionMode ||
    (run.executionMode === "owner"
      ? run.kind !== "productive" ||
        member.ref.taskExecutionAuthorityId === null ||
        run.taskExecutionAuthorityId !== member.ref.taskExecutionAuthorityId ||
        run.consultExecutionId !== null
      : run.kind !== "consult" ||
        member.ref.taskExecutionAuthorityId !== null ||
        member.ref.consultExecutionId === null ||
        run.taskExecutionAuthorityId !== null ||
        run.consultExecutionId !== member.ref.consultExecutionId) ||
    member.row.admissionOrder !== member.ref.laneOrdinal ||
    (!promptOwnerIsUnbound && !promptOwnerHasBoundShape)
  ) {
    reject("expired authority crossed its canonical prompt identity");
  }
  const nonProtocolPromptOwner = {
    runId: run.runId,
    refId: member.ref.id,
    refOrdinal: member.row.refOrdinal,
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
        eq(taskExecutionPromptCapabilities.leaseGeneration, lease.leaseGeneration),
      ),
    )
    .for("update");
  const ownerCapabilities = promptOwnerIsUnbound
    ? []
    : capabilities.filter(
        (capability) =>
          capability.capabilityConnectionId === promptOwner.capabilityConnectionId &&
          capability.capabilityGeneration === promptOwner.capabilityGeneration,
      );
  if (
    (promptOwnerIsUnbound && capabilities.length !== 0) ||
    (!promptOwnerIsUnbound && (capabilities.length !== 1 || ownerCapabilities.length !== 1))
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
      capability.attemptId !== attempt.id ||
      capability.leaseId !== lease.id ||
      capability.leaseGeneration !== lease.leaseGeneration ||
      capability.ownershipEpoch !== run.ownershipEpoch ||
      capability.targetAgentId !== run.targetAgentId ||
      capability.laneKind !== run.executionMode ||
      capability.executionMode !== run.executionMode ||
      capability.taskExecutionAuthorityId !== run.taskExecutionAuthorityId ||
      capability.consultExecutionId !== run.consultExecutionId ||
      capability.adapterConfigIdentity !== run.adapterConfigRevisionId ||
      capability.workspaceIdentity !== run.executionWorkspaceBindingId)
  ) {
    reject("expired prompt capability crossed its exact run authority");
  }
  // Cancellation reconciliation owns only prompts that never minted an ACPX
  // capability. Once minted, expired-lease recovery must close that exact
  // prompt and cancellation in the same transaction.
  if (cancellation !== null && capability === null) {
    return { kind: "complete" as const, result: { kind: "current", run } };
  }
  const closureDecision = classifyExpiredPromptClosure({
    owner: promptOwner,
    capability,
  });
  const promptTransmitted = promptOwner.promptTransmissionPhase === "transmitted";
  return {
    kind: "continue" as const,
    cancellation,
    control,
    member,
    attempt,
    promptOwner,
    promptOwnerIsUnbound,
    promptOwnerHasBoundShape,
    lease,
    nonProtocolPromptOwner,
    capabilities,
    ownerCapabilities,
    capability,
    closureDecision,
    promptTransmitted,
  };
}
