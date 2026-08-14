import {
  agents,
  taskBoardReopenCommands,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  tasks,
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
          instructionless: renderAgentInstructionBootstrap(target[0]!.instruction) === null,
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
        eq(taskExecutionSessions.lastProtocolSettledSegmentOrdinal, 0),
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
        inArray(taskExecutionSessions.state, ["eligible", "current"]),
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
  const exactCarry =
    correlation.purpose === "carry" &&
    correlation.state === "eligible" &&
    correlation.laneKind === current.mode &&
    correlation.runId === null &&
    correlation.currentRefId === null &&
    correlation.currentRefOrdinal === null &&
    correlation.currentSegmentOrdinal === null &&
    correlation.authorizedContextExposureDigest !== null;
  const exactActiveRun =
    correlation.purpose === "active_run_steering" &&
    correlation.state === "current" &&
    correlation.laneKind === null &&
    correlation.runId === runId &&
    correlation.currentRefId === predecessor.id &&
    correlation.currentRefOrdinal === refOrdinal &&
    correlation.currentSegmentOrdinal === 0 &&
    correlation.authorizedContextExposureDigest === null;
  return exactCarry || exactActiveRun
    ? {
        kind: "bootstrap_resume",
        correlation,
        predecessor: { runId, refId: predecessor.id, refOrdinal },
      }
    : { kind: "invalid" };
}

export async function selectSteeringResumeSourceCorrelation(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
    readonly correlationId: string;
    readonly carrySourceExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<CorrelationRow | null> {
  const { identity } = input;
  const rows = await transaction
    .select()
    .from(taskExecutionSessions)
    .where(
      and(
        eq(taskExecutionSessions.id, input.correlationId),
        eq(taskExecutionSessions.companyId, identity.companyId),
        eq(taskExecutionSessions.taskId, identity.taskId),
        eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
        eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
        eq(taskExecutionSessions.workspaceIdentity, identity.executionWorkspaceBindingId),
        eq(taskExecutionSessions.targetFingerprint, input.targetFingerprint),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) reject("steering resume source correlation is ambiguous");
  const row = rows[0] ?? null;
  if (!row) return null;
  const exactCarrySource =
    row.purpose === "carry" &&
    row.state === "eligible" &&
    row.laneKind === identity.laneKind &&
    row.runId === null &&
    row.currentRefId === null &&
    row.currentRefOrdinal === null &&
    row.currentSegmentOrdinal === null &&
    row.authorizedContextExposureDigest === input.carrySourceExposureDigest;
  const exactActiveRunSource =
    row.purpose === "active_run_steering" &&
    row.state === "current" &&
    row.laneKind === null &&
    row.runId === identity.runId &&
    row.currentRefId === identity.refId &&
    row.currentRefOrdinal === identity.refOrdinal &&
    row.currentSegmentOrdinal === identity.segmentOrdinal - 1 &&
    row.authorizedContextExposureDigest === null;
  return exactCarrySource || exactActiveRunSource ? row : null;
}

/** @internal Transactional allocator shared by prompt preparation and its tests. */
export async function nextCorrelationGeneration(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
    readonly carryContext: boolean;
  },
): Promise<number> {
  const { identity } = input;
  const rows = await transaction
    .select({
      generation: taskExecutionSessions.correlationGeneration,
    })
    .from(taskExecutionSessions)
    .where(
      input.carryContext
        ? and(
            eq(taskExecutionSessions.companyId, identity.companyId),
            eq(taskExecutionSessions.taskId, identity.taskId),
            eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
            eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
            eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
            eq(taskExecutionSessions.workspaceIdentity, identity.executionWorkspaceBindingId),
            eq(taskExecutionSessions.purpose, "carry"),
            eq(taskExecutionSessions.laneKind, identity.laneKind),
          )
        : and(
            eq(taskExecutionSessions.companyId, identity.companyId),
            eq(taskExecutionSessions.taskId, identity.taskId),
            eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
            eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
            eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
            eq(taskExecutionSessions.workspaceIdentity, identity.executionWorkspaceBindingId),
            eq(taskExecutionSessions.purpose, "active_run_steering"),
            eq(taskExecutionSessions.runId, identity.runId),
          ),
    )
    .orderBy(desc(taskExecutionSessions.correlationGeneration))
    .limit(1)
    .for("update");
  const reopenFences = await transaction
    .select({
      generation: taskBoardReopenCommands.continuityFenceGeneration,
    })
    .from(taskBoardReopenCommands)
    .where(
      and(
        eq(taskBoardReopenCommands.companyId, identity.companyId),
        eq(taskBoardReopenCommands.taskId, identity.taskId),
        eq(taskBoardReopenCommands.ownershipEpoch, identity.ownershipEpoch),
      ),
    )
    .orderBy(desc(taskBoardReopenCommands.continuityFenceGeneration))
    .limit(1)
    .for("update");
  const generation = Math.max(rows[0]?.generation ?? 0, reopenFences[0]?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
    reject("native correlation generation is exhausted");
  }
  return generation;
}

export async function lockBoardReopenContinuityFence(
  transaction: TaskSessionDbTransaction,
  identity: TaskExecutionPromptIdentity,
): Promise<number> {
  const lockedTask = await transaction
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, identity.companyId),
        eq(tasks.id, identity.taskId),
        eq(tasks.ownershipEpoch, identity.ownershipEpoch),
      ),
    )
    .limit(2)
    .for("update");
  if (lockedTask.length !== 1) {
    reject("prompt activation lost its exact task epoch");
  }
  const fences = await transaction
    .select({
      generation: taskBoardReopenCommands.continuityFenceGeneration,
    })
    .from(taskBoardReopenCommands)
    .where(
      and(
        eq(taskBoardReopenCommands.companyId, identity.companyId),
        eq(taskBoardReopenCommands.taskId, identity.taskId),
        eq(taskBoardReopenCommands.ownershipEpoch, identity.ownershipEpoch),
      ),
    )
    .orderBy(desc(taskBoardReopenCommands.continuityFenceGeneration))
    .limit(1)
    .for("update");
  return fences[0]?.generation ?? 0;
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
    control.currentSegmentOrdinal !== prompt.segmentOrdinal ||
    attempt.runId !== prompt.runId ||
    attempt.runKind !== prompt.runKind ||
    attempt.promptKind !== prompt.promptKind ||
    attempt.refId !== prompt.refId ||
    attempt.refOrdinal !== prompt.refOrdinal ||
    attempt.segmentOrdinal !== prompt.segmentOrdinal ||
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
