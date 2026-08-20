import {
  agents,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
} from "@paperclipai/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import type { TaskExecutionPromptIdentity } from "./task-execution-attempt-executor.js";
import { classifyOrderedExecutionScopePair } from "./task-execution-initial-request-pair.js";
import { renderAgentInstructionBootstrap } from "./task-execution-initial-start-admission.js";
import {
  exactlyOne,
  reject,
  rejectAuthorityLoss,
  transactionClockTimestamp,
  type AttemptRow,
  type CorrelationRow,
  type InitialPromptCycleResolution,
  type LeaseRow,
  type RefRow,
} from "./task-execution-prompt-cycle-postgres-shared-part-1.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import { type TaskSessionDbTransaction } from "./task-session/event-store.js";

/** @internal Sole ordered-scope classifier and bootstrap-handoff resolver. */
export async function resolveInitialPromptCycleInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly currentRef: RefRow;
    readonly executionWorkspaceBindingId: string;
  },
): Promise<InitialPromptCycleResolution> {
  const current = input.currentRef;
  const grouped = await transaction
    .select()
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.companyId, current.companyId),
        eq(taskExecutionRefs.taskId, current.taskId),
        eq(taskExecutionRefs.sessionId, current.sessionId),
        eq(taskExecutionRefs.executionScopeId, current.executionScopeId),
        eq(taskExecutionRefs.executionLineageId, current.executionLineageId),
      ),
    )
    .orderBy(asc(taskExecutionRefs.laneOrdinal))
    .limit(3)
    .for("update");
  const pair = classifyOrderedExecutionScopePair(grouped);
  if (!pair) {
    if (grouped.length !== 1 || grouped[0]?.id !== current.id) {
      return { kind: "invalid" };
    }
    const target = await transaction
      .select({ instruction: agents.instruction })
      .from(agents)
      .where(and(eq(agents.companyId, current.companyId), eq(agents.id, current.targetAgentId)))
      .limit(2)
      .for("share");
    return target.length === 1
      ? {
          kind: "singleton",
          freshSessionAllowed:
            current.laneOrdinal === 0 && renderAgentInstructionBootstrap(target[0]!.instruction) === null,
        }
      : { kind: "invalid" };
  }
  if (pair.instruction.id === current.id) return { kind: "new" };
  if (pair.work.id !== current.id) return { kind: "invalid" };
  const predecessor = pair.instruction;
  if (predecessor.disposition !== "terminal") return { kind: "invalid" };
  const rows = await transaction
    .select({
      runId: taskExecutionRunRefs.runId,
      refOrdinal: taskExecutionRunRefs.refOrdinal,
      outcome: taskExecutionRunRefs.outcome,
      protocolSettlementState: taskExecutionRunRefs.protocolSettlementState,
      correlation: taskExecutionSessions,
    })
    .from(taskExecutionRunRefs)
    .leftJoin(
      taskExecutionSessions,
      and(
        eq(taskExecutionSessions.lastProtocolSettledRunId, taskExecutionRunRefs.runId),
        eq(taskExecutionSessions.lastProtocolSettledRefId, predecessor.id),
        eq(taskExecutionSessions.lastProtocolSettledRefOrdinal, taskExecutionRunRefs.refOrdinal),
        eq(taskExecutionSessions.companyId, current.companyId),
        eq(taskExecutionSessions.taskId, current.taskId),
        eq(taskExecutionSessions.ownershipEpoch, current.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, current.targetAgentId),
        eq(taskExecutionSessions.adapterConfigIdentity, current.adapterConfigRevisionId),
        eq(taskExecutionSessions.workspaceIdentity, input.executionWorkspaceBindingId),
        eq(
          taskExecutionSessions.targetFingerprint,
          localExecutionCorrelationFingerprint(current.adapterConfigRevisionId),
        ),
        eq(taskExecutionSessions.state, "eligible"),
      ),
    )
    .where(
      and(
        eq(taskExecutionRunRefs.refId, predecessor.id),
        inArray(taskExecutionRunRefs.protocolSettlementState, ["settled", "incomplete"]),
      ),
    )
    .limit(2)
    .for("update", { of: taskExecutionRunRefs });
  const terminalRows = rows.filter((row) => row.protocolSettlementState !== "not_sent");
  if (terminalRows.length !== 1) return { kind: "invalid" };
  const { correlation, refOrdinal, runId, outcome, protocolSettlementState } = terminalRows[0]!;
  if (protocolSettlementState !== "settled" || (outcome !== "succeeded" && outcome !== "refused")) {
    return { kind: "bootstrap_unavailable" };
  }
  if (!correlation) return { kind: "invalid" };
  const exactCorrelation =
    correlation.state === "eligible" &&
    correlation.laneKind === current.mode &&
    correlation.authorizedContextExposureDigest !== null;
  return exactCorrelation
    ? {
        kind: "bootstrap_resume",
        correlation,
        predecessor: { runId, refId: predecessor.id, refOrdinal },
      }
    : { kind: "invalid" };
}

/** @internal Transactional allocator shared by prompt preparation and its tests. */
export async function nextCorrelationGeneration(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
  },
): Promise<number> {
  const { identity } = input;
  const rows = await transaction
    .select({
      generation: taskExecutionSessions.correlationGeneration,
    })
    .from(taskExecutionSessions)
    .where(
      and(
        eq(taskExecutionSessions.companyId, identity.companyId),
        eq(taskExecutionSessions.taskId, identity.taskId),
        eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
        eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
        eq(taskExecutionSessions.workspaceIdentity, identity.executionWorkspaceBindingId),
        eq(taskExecutionSessions.laneKind, identity.laneKind),
      ),
    )
    .orderBy(desc(taskExecutionSessions.correlationGeneration))
    .limit(1)
    .for("update");
  const generation = (rows[0]?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
    reject("native correlation generation is exhausted");
  }
  return generation;
}

export async function assertCurrentAttempt(
  transaction: TaskSessionDbTransaction,
  runService: Pick<TaskExecutionRunService, "lockRun">,
  prompt: TaskExecutionPromptIdentity,
): Promise<{
  readonly attempt: AttemptRow;
  readonly lease: LeaseRow;
  readonly timestamp: Date;
}> {
  const run = await runService.lockRun(transaction, prompt);
  const controlRows = await transaction
    .select()
    .from(taskExecutionRunControls)
    .where(eq(taskExecutionRunControls.runId, prompt.runId))
    .limit(2)
    .for("update");
  const attemptRows = await transaction
    .select()
    .from(taskExecutionAttempts)
    .where(eq(taskExecutionAttempts.id, prompt.attemptId))
    .limit(2)
    .for("update");
  const leaseRows = await transaction
    .select()
    .from(taskExecutionLeases)
    .where(eq(taskExecutionLeases.id, prompt.leaseId))
    .limit(2)
    .for("update");
  const timestamp = await transactionClockTimestamp(transaction, "prompt authority serialization time");
  const attempt = exactlyOne(attemptRows, "prompt lost its exact attempt");
  const lease = exactlyOne(leaseRows, "prompt lost its exact lease");
  const control = exactlyOne(controlRows, "prompt lost its exact run control");
  if (
    run.kind !== prompt.runKind ||
    run.status !== "running" ||
    run.sessionId !== prompt.sessionId ||
    run.ownershipEpoch !== prompt.ownershipEpoch ||
    run.targetAgentId !== prompt.targetAgentId ||
    run.adapterConfigRevisionId !== prompt.adapterConfigRevisionId ||
    run.executionWorkspaceBindingId !== prompt.executionWorkspaceBindingId ||
    run.executionMode !== prompt.laneKind ||
    run.taskExecutionAuthorityId !== prompt.taskExecutionAuthorityId ||
    run.consultExecutionId !== prompt.consultExecutionId ||
    run.currentAttemptId !== prompt.attemptId ||
    run.currentLeaseId !== prompt.leaseId ||
    run.cancellationIntentId !== null ||
    control.currentRefId !== prompt.refId ||
    control.currentOrdinal !== prompt.refOrdinal ||
    attempt.runId !== prompt.runId ||
    attempt.runKind !== prompt.runKind ||
    attempt.refId !== prompt.refId ||
    attempt.refOrdinal !== prompt.refOrdinal ||
    attempt.attemptGeneration !== prompt.attemptGeneration ||
    attempt.state !== "running" ||
    lease.runId !== prompt.runId ||
    lease.attemptId !== prompt.attemptId ||
    lease.leaseGeneration !== prompt.leaseGeneration ||
    lease.state !== "active" ||
    lease.expiresAt <= timestamp
  ) {
    rejectAuthorityLoss(prompt, "prompt crossed its canonical run, attempt, lease, or control");
  }
  return { attempt, lease, timestamp };
}
