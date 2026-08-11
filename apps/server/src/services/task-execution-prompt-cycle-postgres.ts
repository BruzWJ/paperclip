import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  agentAdapterConfigRevisions,
  taskBoardReopenCommands,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  taskSessionInputs,
  taskSessionMessages,
  tasks,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  TaskSession,
} from "@paperclipai/shared";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { settleAcpPromptInTransaction } from "./acp-prompt-settlement.js";
import type { BudgetEnforcementScope } from "./budgets.js";
import { contextDialDigest } from "./context-dial-resolver.js";
import { preserveCorrelationAfterNonProtocolClosure } from "./task-execution-correlation-retention.js";
import {
  TaskExecutionPromptAuthorityLost,
} from "./task-execution-attempt-executor.js";
import { classifyOrderedExecutionScopePair } from "./task-execution-initial-request-pair.js";
import { renderAgentInstructionBootstrap } from "./task-execution-initial-start-admission.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import type {
  TaskExecutionAttemptLease,
  TaskExecutionPromptCapabilityIdentity,
  TaskExecutionPromptCycleRepository,
  TaskExecutionPromptIdentity,
  ResolvedTaskExecutionPrompt,
} from "./task-execution-attempt-executor.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import {
  lockTaskSessionProjectionRoot,
  reserveTaskSessionEventSequence,
  reserveTaskSessionMessageId,
  type TaskSessionDbTransaction,
} from "./task-session/event-store.js";
import { publishTaskSessionEventInTx } from "./task-session/publication.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import type { AcpCorrelationScope, StoredAcpSessionCorrelation } from "./native-correlation.js";
import { mintPromptCapabilityBearer } from "./prompt-capability-gateway.js";
import type { PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import { runtimeInterfaceDigest } from "./runtime-interface-compiler.js";

const DEFAULT_CAPABILITY_TTL_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

export interface PostgresTaskExecutionPromptCycleOptions {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun">;
  readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
  readonly capabilityEndpoint: string;
  readonly idFactory?: () => string;
  readonly capabilityTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly suspendBudgetScopes?: (
    scopes: readonly BudgetEnforcementScope[],
  ) => Promise<void>;
}

export class PostgresTaskExecutionPromptCycleRejected extends Error {
  readonly code = "postgres_task_execution_prompt_cycle_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionPromptCycleRejected";
  }
}

type AttemptRow = typeof taskExecutionAttempts.$inferSelect;
type LeaseRow = typeof taskExecutionLeases.$inferSelect;
type RefRow = typeof taskExecutionRefs.$inferSelect;
type CorrelationRow = typeof taskExecutionSessions.$inferSelect;

type InitialPromptCycleResolution =
  | { readonly kind: "singleton"; readonly instructionless: boolean }
  | { readonly kind: "new" }
  | { readonly kind: "bootstrap_unavailable" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "bootstrap_resume";
      readonly correlation: CorrelationRow;
      readonly predecessor: {
        readonly runId: string;
        readonly refId: string;
        readonly refOrdinal: number;
      };
    };

function reject(message: string): never {
  throw new PostgresTaskExecutionPromptCycleRejected(message);
}

function rejectAuthorityLoss(
  lease: TaskExecutionAttemptLease,
  message: string,
): never {
  throw new TaskExecutionPromptAuthorityLost(
    lease,
    new PostgresTaskExecutionPromptCycleRejected(message),
  );
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(sha256(`${namespace}\0${value}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} is invalid`);
  }
  return value;
}

async function transactionClockTimestamp(
  transaction: TaskSessionDbTransaction,
  label: string,
): Promise<Date> {
  const rows = Array.from(
    await transaction.execute(sql<{ timestampMs: number }>`
      select (extract(epoch from clock_timestamp()) * 1000)::double precision
        as "timestampMs"
    `),
  );
  return validDate(new Date(Number(rows[0]?.timestampMs)), label);
}

function boundedReason(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 200);
  return normalized || fallback;
}

function promptCompileScope(prompt: TaskExecutionPromptIdentity) {
  return {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
    ownershipEpoch: prompt.ownershipEpoch,
    targetAgentId: prompt.targetAgentId,
    executionMode: prompt.laneKind,
    taskExecutionAuthorityId: prompt.taskExecutionAuthorityId,
    consultExecutionId: prompt.consultExecutionId,
    sessionId: prompt.sessionId,
    runId: prompt.runId,
    attemptId: prompt.attemptId,
    refId: prompt.refId,
    refOrdinal: prompt.refOrdinal,
    segmentOrdinal: prompt.segmentOrdinal,
  } as const;
}

function sourceTextFromPrompt(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("steering input lost its canonical prompt");
  }
  const prompt = value as Record<string, unknown>;
  if (
    typeof prompt.text !== "string" ||
    prompt.text.length === 0 ||
    (prompt.files !== undefined &&
      (!Array.isArray(prompt.files) || prompt.files.length !== 0)) ||
    (prompt.agents !== undefined &&
      (!Array.isArray(prompt.agents) || prompt.agents.length !== 0))
  ) {
    reject("steering input contains a non-text provider prompt");
  }
  return prompt.text;
}

function scopeFromCorrelationRow(row: CorrelationRow): AcpCorrelationScope {
  const common = {
    companyId: row.companyId,
    taskId: row.taskId,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    adapterConfigIdentity: row.adapterConfigIdentity,
    workspaceIdentity: row.workspaceIdentity,
    targetFingerprint: row.targetFingerprint,
    correlationGeneration: row.correlationGeneration,
  } as const;
  if (row.purpose === "carry") {
    if (!row.laneKind || !row.authorizedContextExposureDigest) {
      reject("stored carry correlation has an invalid checked shape");
    }
    return {
      ...common,
      purpose: "carry",
      laneKind: row.laneKind,
      authorizedContextExposureDigest: row.authorizedContextExposureDigest,
    };
  }
  if (
    !row.runId ||
    !row.currentRefId ||
    row.currentRefOrdinal === null ||
    row.currentSegmentOrdinal === null
  ) {
    reject("stored steering correlation has an invalid checked shape");
  }
  return {
    ...common,
    purpose: "active_run_steering",
    runId: row.runId,
    currentRefId: row.currentRefId,
    currentRefOrdinal: row.currentRefOrdinal,
    currentSegmentOrdinal: row.currentSegmentOrdinal,
  };
}

function storedCorrelation(row: CorrelationRow): StoredAcpSessionCorrelation {
  if (
    (row.purpose === "carry" && row.state !== "eligible") ||
    (row.purpose === "active_run_steering" && row.state !== "current")
  ) {
    reject("selected native correlation is not current for its purpose");
  }
  return {
    id: row.id,
    state: row.state as "eligible" | "current",
    scope: scopeFromCorrelationRow(row),
    envelopeVersion: row.envelopeVersion,
    codecKind: row.codecKind,
    ciphertext: row.protectedTargetSession,
    digest: row.protectedTargetSessionDigest,
  };
}

async function selectCurrentCorrelation(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
    readonly carryContext: boolean;
    readonly effectiveContextExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<CorrelationRow | null> {
  const { identity } = input;
  const common = and(
    eq(taskExecutionSessions.companyId, identity.companyId),
    eq(taskExecutionSessions.taskId, identity.taskId),
    eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
    eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
    eq(
      taskExecutionSessions.adapterConfigIdentity,
      identity.adapterConfigRevisionId,
    ),
    eq(
      taskExecutionSessions.workspaceIdentity,
      identity.executionWorkspaceBindingId,
    ),
    eq(taskExecutionSessions.targetFingerprint, input.targetFingerprint),
  );
  const rows = input.carryContext
    ? await transaction
        .select()
        .from(taskExecutionSessions)
        .where(
          and(
            common,
            eq(taskExecutionSessions.purpose, "carry"),
            eq(taskExecutionSessions.state, "eligible"),
            eq(taskExecutionSessions.laneKind, identity.laneKind),
            eq(
              taskExecutionSessions.authorizedContextExposureDigest,
              input.effectiveContextExposureDigest,
            ),
          ),
        )
        .limit(2)
        .for("update")
    : await transaction
        .select()
        .from(taskExecutionSessions)
        .where(
          and(
            common,
            eq(taskExecutionSessions.purpose, "active_run_steering"),
            eq(taskExecutionSessions.state, "current"),
            eq(taskExecutionSessions.runId, identity.runId),
          ),
        )
        .limit(2)
        .for("update");
  if (rows.length > 1) reject("native correlation logical key is ambiguous");
  return rows[0] ?? null;
}

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
    const target = await transaction.select({ instruction: agents.instruction })
      .from(agents).where(and(
        eq(agents.companyId, current.companyId),
        eq(agents.id, current.targetAgentId),
      )).limit(2).for("share");
    return target.length === 1
      ? {
          kind: "singleton",
          instructionless:
            renderAgentInstructionBootstrap(target[0]!.instruction) === null,
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
        eq(
          taskExecutionSessions.lastProtocolSettledRunId,
          taskExecutionRunRefs.runId,
        ),
        eq(taskExecutionSessions.lastProtocolSettledRefId, predecessor.id),
        eq(
          taskExecutionSessions.lastProtocolSettledRefOrdinal,
          taskExecutionRunRefs.refOrdinal,
        ),
        eq(taskExecutionSessions.lastProtocolSettledSegmentOrdinal, 0),
        eq(taskExecutionSessions.companyId, current.companyId),
        eq(taskExecutionSessions.taskId, current.taskId),
        eq(taskExecutionSessions.ownershipEpoch, current.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, current.targetAgentId),
        eq(
          taskExecutionSessions.adapterConfigIdentity,
          current.adapterConfigRevisionId,
        ),
        eq(
          taskExecutionSessions.workspaceIdentity,
          input.executionWorkspaceBindingId,
        ),
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
        inArray(taskExecutionRunRefs.protocolSettlementState, [
          "settled",
          "incomplete",
        ]),
      ),
    )
    .limit(2)
    .for("update", { of: taskExecutionRunRefs });
  const terminalRows = rows.filter(
    (row) => row.protocolSettlementState !== "not_sent",
  );
  if (terminalRows.length !== 1) return { kind: "invalid" };
  const {
    correlation,
    refOrdinal,
    runId,
    outcome,
    protocolSettlementState,
  } = terminalRows[0]!;
  if (
    protocolSettlementState !== "settled" ||
    (outcome !== "succeeded" && outcome !== "refused")
  ) {
    return { kind: "bootstrap_unavailable" };
  }
  if (!correlation) return { kind: "invalid" };
  const exactCarry = correlation.purpose === "carry" &&
    correlation.state === "eligible" &&
    correlation.laneKind === current.mode &&
    correlation.runId === null &&
    correlation.currentRefId === null &&
    correlation.currentRefOrdinal === null &&
    correlation.currentSegmentOrdinal === null &&
    correlation.authorizedContextExposureDigest !== null;
  const exactActiveRun = correlation.purpose === "active_run_steering" &&
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

async function selectSteeringResumeSourceCorrelation(
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
        eq(
          taskExecutionSessions.adapterConfigIdentity,
          identity.adapterConfigRevisionId,
        ),
        eq(
          taskExecutionSessions.workspaceIdentity,
          identity.executionWorkspaceBindingId,
        ),
        eq(taskExecutionSessions.targetFingerprint, input.targetFingerprint),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) reject("steering resume source correlation is ambiguous");
  const row = rows[0] ?? null;
  if (!row) return null;
  const exactCarrySource = row.purpose === "carry" &&
    row.state === "eligible" &&
    row.laneKind === identity.laneKind &&
    row.runId === null &&
    row.currentRefId === null &&
    row.currentRefOrdinal === null &&
    row.currentSegmentOrdinal === null &&
    row.authorizedContextExposureDigest === input.carrySourceExposureDigest;
  const exactActiveRunSource = row.purpose === "active_run_steering" &&
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
      .select({ generation: taskExecutionSessions.correlationGeneration })
      .from(taskExecutionSessions)
      .where(
        input.carryContext
          ? and(
              eq(taskExecutionSessions.companyId, identity.companyId),
              eq(taskExecutionSessions.taskId, identity.taskId),
              eq(
                taskExecutionSessions.ownershipEpoch,
                identity.ownershipEpoch,
              ),
              eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
              eq(
                taskExecutionSessions.adapterConfigIdentity,
                identity.adapterConfigRevisionId,
              ),
              eq(
                taskExecutionSessions.workspaceIdentity,
                identity.executionWorkspaceBindingId,
              ),
              eq(taskExecutionSessions.purpose, "carry"),
              eq(taskExecutionSessions.laneKind, identity.laneKind),
            )
          : and(
              eq(taskExecutionSessions.companyId, identity.companyId),
              eq(taskExecutionSessions.taskId, identity.taskId),
              eq(
                taskExecutionSessions.ownershipEpoch,
                identity.ownershipEpoch,
              ),
              eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
              eq(
                taskExecutionSessions.adapterConfigIdentity,
                identity.adapterConfigRevisionId,
              ),
              eq(
                taskExecutionSessions.workspaceIdentity,
                identity.executionWorkspaceBindingId,
              ),
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
        eq(
          taskBoardReopenCommands.ownershipEpoch,
          identity.ownershipEpoch,
        ),
      ),
    )
    .orderBy(desc(taskBoardReopenCommands.continuityFenceGeneration))
    .limit(1)
    .for("update");
  const generation = Math.max(
    rows[0]?.generation ?? 0,
    reopenFences[0]?.generation ?? 0,
  ) + 1;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > 2_147_483_647
  ) {
    reject("native correlation generation is exhausted");
  }
  return generation;
}

async function lockBoardReopenContinuityFence(
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
        eq(
          taskBoardReopenCommands.ownershipEpoch,
          identity.ownershipEpoch,
        ),
      ),
    )
    .orderBy(desc(taskBoardReopenCommands.continuityFenceGeneration))
    .limit(1)
    .for("update");
  return fences[0]?.generation ?? 0;
}

async function assertCurrentAttempt(
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
  const timestamp = await transactionClockTimestamp(
    transaction,
    "prompt authority serialization time",
  );
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
    rejectAuthorityLoss(
      prompt,
      "prompt crossed its canonical run, attempt, lease, or control",
    );
  }
  return { attempt, lease, timestamp };
}

async function lockCapability(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
) {
  const rows = await transaction
    .select()
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(
          taskExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          taskExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
        eq(taskExecutionPromptCapabilities.companyId, prompt.companyId),
        eq(taskExecutionPromptCapabilities.taskId, prompt.taskId),
        eq(taskExecutionPromptCapabilities.runId, prompt.runId),
        eq(taskExecutionPromptCapabilities.refId, prompt.refId),
        eq(taskExecutionPromptCapabilities.refOrdinal, prompt.refOrdinal),
        eq(
          taskExecutionPromptCapabilities.segmentOrdinal,
          prompt.segmentOrdinal,
        ),
        eq(taskExecutionPromptCapabilities.attemptId, prompt.attemptId),
        eq(taskExecutionPromptCapabilities.leaseId, prompt.leaseId),
      ),
    )
    .limit(2)
    .for("update");
  return exactlyOne(rows, "prompt capability generation is missing or crossed");
}

async function revokeCapability(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
  reason: string,
  at: Date,
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: boundedReason(reason, "prompt_closed"),
      revokedAt: at,
    })
    .where(
      and(
        eq(
          taskExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          taskExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
        eq(taskExecutionPromptCapabilities.runId, prompt.runId),
        inArray(taskExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    )
    .returning({
      capabilityConnectionId:
        taskExecutionPromptCapabilities.capabilityConnectionId,
    });
  if (changed.length !== 1) reject("prompt capability could not be revoked exactly once");
}

async function supersedeCorrelation(
  transaction: TaskSessionDbTransaction,
  correlationId: string | null,
  reason: string,
  at: Date,
): Promise<void> {
  if (!correlationId) return;
  await transaction
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: boundedReason(reason, "prompt_closed"),
      supersededAt: at,
    })
    .where(
      and(
        eq(taskExecutionSessions.id, correlationId),
        inArray(taskExecutionSessions.state, ["eligible", "current"]),
      ),
    );
}

async function recordNativeCancellationSettlement(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  at: Date,
): Promise<boolean> {
  const changed = await transaction
    .update(taskExecutionCancellationIntents)
    .set({ nativeCancellationSettledAt: at })
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, prompt.companyId),
        eq(taskExecutionCancellationIntents.taskId, prompt.taskId),
        eq(taskExecutionCancellationIntents.runId, prompt.runId),
        eq(taskExecutionCancellationIntents.attemptId, prompt.attemptId),
        eq(taskExecutionCancellationIntents.leaseId, prompt.leaseId),
        inArray(taskExecutionCancellationIntents.state, [
          "requested",
          "acknowledged",
        ]),
        sql`${taskExecutionCancellationIntents.nativeCancellationSettledAt} is null`,
      ),
    )
    .returning({ id: taskExecutionCancellationIntents.id });
  if (changed.length > 1) {
    reject("native ACPX cancellation matched multiple active intents");
  }
  return changed.length === 1;
}

type NonProtocolPromptOwner = Pick<
  TaskExecutionPromptIdentity,
  | "promptKind"
  | "runId"
  | "refId"
  | "refOrdinal"
  | "segmentOrdinal"
  | "attemptId"
>;

/** @internal Sole base/steering owner settlement for a non-protocol closure. */
export async function settleNonProtocolPromptInTransaction(
  transaction: TaskSessionDbTransaction,
  prompt: NonProtocolPromptOwner,
  input: {
    readonly state: "not_sent" | "incomplete";
    readonly outcome:
      | "released_unsent"
      | "ambiguous"
      | "failed"
      | "cancelled";
    readonly referenceId: string;
    readonly at: Date;
  },
): Promise<void> {
  const values = {
    outcome: input.outcome,
    outcomeReferenceId: input.referenceId,
    protocolSettlementState: input.state,
    settlementVersion: 1,
    settledAt: input.at,
  } as const;
  const rows = prompt.promptKind === "base"
    ? await transaction
        .update(taskExecutionRunRefs)
        .set(values)
        .where(
          and(
            eq(taskExecutionRunRefs.runId, prompt.runId),
            eq(taskExecutionRunRefs.refId, prompt.refId),
            eq(taskExecutionRunRefs.refOrdinal, prompt.refOrdinal),
            eq(taskExecutionRunRefs.attemptId, prompt.attemptId),
            eq(
              taskExecutionRunRefs.promptTransmissionPhase,
              input.state === "not_sent" ? "not_transmitted" : "transmitted",
            ),
            sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
          ),
        )
        .returning({ runId: taskExecutionRunRefs.runId })
    : await transaction
        .update(taskExecutionPromptSegments)
        .set({ ...values, steeringState: "protocol_settled" })
        .where(
          and(
            eq(taskExecutionPromptSegments.runId, prompt.runId),
            eq(taskExecutionPromptSegments.refId, prompt.refId),
            eq(taskExecutionPromptSegments.refOrdinal, prompt.refOrdinal),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
              prompt.segmentOrdinal,
            ),
            eq(taskExecutionPromptSegments.attemptId, prompt.attemptId),
            eq(
              taskExecutionPromptSegments.promptTransmissionPhase,
              input.state === "not_sent" ? "not_transmitted" : "transmitted",
            ),
            sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
          ),
        )
        .returning({ runId: taskExecutionPromptSegments.runId });
  if (rows.length !== 1) reject("non-protocol prompt settlement lost its exact owner");
}

async function ensureAssistantStarted(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  at: Date,
): Promise<string> {
  const scope = {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
    sessionId: prompt.sessionId,
  };
  const assistantMessageId = await reserveTaskSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${prompt.attemptId}:assistant`,
  );
  const existing = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, prompt.companyId),
        eq(taskSessionMessages.taskId, prompt.taskId),
        eq(taskSessionMessages.sessionId, prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(2)
    .for("update");
  if (existing.length > 1) reject("assistant message identity is ambiguous");
  if (existing[0]) {
    const message = taskSessionMessageFromRow(existing[0]);
    if (
      message.type !== "assistant" ||
      message.time.completed !== undefined ||
      existing[0].runId !== prompt.runId
    ) {
      reject("assistant message is not the unfinished exact prompt assistant");
    }
    return assistantMessageId;
  }
  const revision = exactlyOne(
    await transaction
      .select({ acpConfiguration: agentAdapterConfigRevisions.acpConfiguration })
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.id, prompt.adapterConfigRevisionId),
          eq(agentAdapterConfigRevisions.companyId, prompt.companyId),
          eq(agentAdapterConfigRevisions.agentId, prompt.targetAgentId),
        ),
      )
      .limit(2),
    "assistant start lost its immutable adapter revision",
  );
  const configuration = agentAdapterAcpConfigurationSchema.parse(
    revision.acpConfiguration,
  );
  const immutableSourceKey = `acp_prompt_update:${prompt.attemptId}:0:${TaskSession.Event.Step.Started.type}`;
  const { seq } = await reserveTaskSessionEventSequence(transaction, scope);
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: `evt_${sha256(immutableSourceKey).slice(0, 40)}`,
      sessionId: prompt.sessionId,
      seq,
      type: TaskSession.Event.Step.Started.type,
      data: {
        timestamp: at.getTime(),
        sessionID: prompt.sessionId,
        assistantMessageID: assistantMessageId,
        agent: prompt.targetAgentId,
        ...(configuration.model === null
          ? {}
          : {
              model: {
                id: configuration.model.id,
                providerID: configuration.launchProfile.registryName,
              },
            }),
      },
    },
    envelope: {
      companyId: prompt.companyId,
      taskId: prompt.taskId,
      runId: prompt.runId,
      ownershipEpoch: prompt.ownershipEpoch,
      agentId: prompt.targetAgentId,
      adapterConfigRevisionId: prompt.adapterConfigRevisionId,
      sourceKind: "acp_prompt_update",
      sourceId: prompt.attemptId,
      immutableSourceKey,
      sourceRecordId: prompt.attemptId,
      sourceIdentityDigest: sha256([
        prompt.companyId,
        prompt.taskId,
        prompt.sessionId,
        prompt.runId,
        prompt.attemptId,
        TaskSession.Event.Step.Started.type,
      ].join(":")),
      createdAt: at,
    },
  });
  return assistantMessageId;
}

async function terminalAssistantText(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
): Promise<string> {
  const row = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, prompt.companyId),
        eq(taskSessionMessages.taskId, prompt.taskId),
        eq(taskSessionMessages.sessionId, prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return "";
  const message = taskSessionMessageFromRow(row);
  if (message.type !== "assistant" || message.time.completed === undefined) return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function terminalOutcome(
  stopReason: string,
): "succeeded" | "failed" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "error") return "failed";
  return "succeeded";
}

export function createPostgresTaskExecutionPromptCycleRepository(
  options: PostgresTaskExecutionPromptCycleOptions,
): TaskExecutionPromptCycleRepository {
  const idFactory = options.idFactory ?? randomUUID;
  const capabilityTtlMs =
    options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1) {
    reject("prompt capability TTL must be a positive integer");
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000) {
    reject("attempt lease TTL must be at least one second");
  }
  const leaseRenewalIntervalMs = Math.max(
    1,
    Math.floor(Math.min(leaseTtlMs, capabilityTtlMs) / 3),
  );
  const endpoint = new URL(options.capabilityEndpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    reject("prompt capability endpoint must use HTTP transport");
  }

  const repository: TaskExecutionPromptCycleRepository = {
    async resolve(lease) {
      return options.database.transaction(async (transaction) => {
        const run = await options.runService.lockRun(transaction, lease);
        if (
          run.status !== "running" ||
          run.currentAttemptId !== lease.attemptId ||
          run.currentLeaseId !== lease.leaseId
        ) {
          rejectAuthorityLoss(
            lease,
            "attempt lease is no longer current on its productive or consult run",
          );
        }
        const controlRows = await transaction
          .select()
          .from(taskExecutionRunControls)
          .where(eq(taskExecutionRunControls.runId, run.runId))
          .limit(2)
          .for("update");
        const attemptRows = await transaction
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.id, lease.attemptId))
          .limit(2)
          .for("update");
        const leaseRows = await transaction
          .select()
          .from(taskExecutionLeases)
          .where(eq(taskExecutionLeases.id, lease.leaseId))
          .limit(2)
          .for("update");
        const timestamp = await transactionClockTimestamp(
          transaction,
          "prompt resolution time",
        );
        const attempt = exactlyOne(attemptRows, "attempt lease lost its attempt");
        const persistedLease = exactlyOne(leaseRows, "attempt lease lost its lease");
        const control = exactlyOne(controlRows, "run lost its current-prompt control");
        if (
          attempt.refId === null ||
          attempt.refOrdinal === null ||
          attempt.segmentOrdinal === null ||
          (attempt.promptKind !== "base" && attempt.promptKind !== "steering")
        ) {
          reject("attempt lost its canonical productive prompt shape");
        }
        if (
          attempt.companyId !== run.companyId ||
          attempt.taskId !== run.taskId ||
          attempt.sessionId !== run.sessionId ||
          attempt.runId !== run.runId ||
          attempt.runKind !== run.kind ||
          attempt.state !== "running" ||
          persistedLease.attemptId !== attempt.id ||
          persistedLease.leaseGeneration !== lease.leaseGeneration ||
          persistedLease.state !== "active" ||
          persistedLease.expiresAt <= timestamp ||
          control.currentRefId !== attempt.refId ||
          control.currentOrdinal !== attempt.refOrdinal ||
          control.currentSegmentOrdinal !== attempt.segmentOrdinal
        ) {
          rejectAuthorityLoss(
            lease,
            "attempt, lease, and current prompt are no longer one exact identity",
          );
        }
        const identity: TaskExecutionPromptIdentity = Object.freeze({
          companyId: run.companyId,
          taskId: run.taskId,
          sessionId: run.sessionId,
          runId: run.runId,
          attemptId: attempt.id,
          leaseId: persistedLease.id,
          leaseGeneration: persistedLease.leaseGeneration,
          ownershipEpoch: run.ownershipEpoch,
          executionScopeId: run.executionScopeId,
          runBatchDigest: "",
          runKind: run.kind,
          promptKind: attempt.promptKind,
          refId: attempt.refId,
          refOrdinal: attempt.refOrdinal,
          segmentOrdinal: attempt.segmentOrdinal,
          attemptGeneration: attempt.attemptGeneration,
          targetAgentId: run.targetAgentId,
          laneKind: run.executionMode,
          taskExecutionAuthorityId: run.taskExecutionAuthorityId,
          consultExecutionId: run.consultExecutionId,
          adapterConfigRevisionId: run.adapterConfigRevisionId,
          executionWorkspaceBindingId: run.executionWorkspaceBindingId,
        });
        const memberRows = await transaction
          .select()
          .from(taskExecutionRunRefs)
          .where(
            and(
              eq(taskExecutionRunRefs.runId, identity.runId),
              eq(taskExecutionRunRefs.refId, identity.refId),
              eq(taskExecutionRunRefs.refOrdinal, identity.refOrdinal),
            ),
          )
          .limit(2)
          .for("update");
        const sourceRows = await transaction
          .select()
          .from(taskExecutionRefs)
          .where(eq(taskExecutionRefs.id, identity.refId))
          .limit(2)
          .for("update");
        const revisionRows = await transaction
          .select()
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(agentAdapterConfigRevisions.id, identity.adapterConfigRevisionId),
              eq(agentAdapterConfigRevisions.companyId, identity.companyId),
              eq(agentAdapterConfigRevisions.agentId, identity.targetAgentId),
            ),
          )
          .limit(2);
        const workspaceRows = await transaction
          .select()
          .from(taskExecutionWorkspaceBindings)
          .where(
            and(
              eq(
                taskExecutionWorkspaceBindings.id,
                identity.executionWorkspaceBindingId,
              ),
              eq(taskExecutionWorkspaceBindings.companyId, identity.companyId),
              eq(taskExecutionWorkspaceBindings.taskId, identity.taskId),
              eq(taskExecutionWorkspaceBindings.sessionId, identity.sessionId),
              eq(
                taskExecutionWorkspaceBindings.ownershipEpoch,
                identity.ownershipEpoch,
              ),
            ),
          )
          .limit(2);
        const member = exactlyOne(memberRows, "current prompt lost its run-ref member");
        const source = exactlyOne(sourceRows, "current prompt lost its immutable ref");
        const revision = exactlyOne(revisionRows, "current prompt lost its adapter revision");
        const workspace = exactlyOne(workspaceRows, "current prompt lost its workspace binding");
        if (
          source.companyId !== identity.companyId ||
          source.taskId !== identity.taskId ||
          source.sessionId !== identity.sessionId ||
          source.ownershipEpoch !== identity.ownershipEpoch ||
          source.mode !== identity.laneKind ||
          source.targetAgentId !== identity.targetAgentId ||
          source.taskExecutionAuthorityId !== identity.taskExecutionAuthorityId ||
          source.consultExecutionId !== identity.consultExecutionId ||
          source.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
          source.disposition !== "active" ||
          member.protocolSettlementState !== null
        ) {
          reject("current prompt crossed its immutable ref scope");
        }
        const completeIdentity: TaskExecutionPromptIdentity = Object.freeze({
          ...identity,
          runBatchDigest: member.batchDigest,
        });
        let sourceMessageId = source.sourceMessageId;
        let sourceMessageSeq: number;
        let sourceText = source.exactMessage;
        let steeringResumeSourceCorrelationId: string | null = null;
        if (attempt.promptKind === "steering") {
          const segment = exactlyOne(
            await transaction
              .select()
              .from(taskExecutionPromptSegments)
              .where(
                and(
                  eq(taskExecutionPromptSegments.runId, identity.runId),
                  eq(taskExecutionPromptSegments.refId, identity.refId),
                  eq(taskExecutionPromptSegments.refOrdinal, identity.refOrdinal),
                  eq(
                    taskExecutionPromptSegments.segmentOrdinal,
                    identity.segmentOrdinal,
                  ),
                ),
              )
              .limit(2)
              .for("update"),
            "current steering segment is missing",
          );
          if (
            segment.sourceMessageId.length === 0 ||
            segment.resumeSourceCorrelationId.length === 0 ||
            segment.protocolSettlementState !== null ||
            segment.steeringState !== "resumed"
          ) {
            reject("current steering segment is not resume-ready");
          }
          const sourceMessageRow = exactlyOne(
            await transaction
              .select()
              .from(taskSessionMessages)
              .where(
                and(
                  eq(taskSessionMessages.companyId, identity.companyId),
                  eq(taskSessionMessages.taskId, identity.taskId),
                  eq(taskSessionMessages.sessionId, identity.sessionId),
                  eq(taskSessionMessages.id, segment.sourceMessageId),
                ),
              )
              .limit(2)
              .for("update"),
            "steering segment lost its canonical Session message",
          );
          const sourceMessage = taskSessionMessageFromRow(sourceMessageRow);
          sourceMessageId = sourceMessageRow.id;
          sourceMessageSeq = sourceMessageRow.seq;
          if (sourceMessage.type === "user") {
            if (
              segment.sourceInputId !== sourceMessage.id ||
              (sourceMessage.files !== undefined &&
                sourceMessage.files.length !== 0) ||
              (sourceMessage.agents !== undefined &&
                sourceMessage.agents.length !== 0)
            ) {
              reject("human steering message lost its exact source input identity");
            }
            const steeringInput = exactlyOne(
              await transaction
                .select()
                .from(taskSessionInputs)
                .where(
                  and(
                    eq(taskSessionInputs.companyId, identity.companyId),
                    eq(taskSessionInputs.taskId, identity.taskId),
                    eq(taskSessionInputs.sessionId, identity.sessionId),
                    eq(taskSessionInputs.id, segment.sourceInputId),
                  ),
                )
                .limit(2)
                .for("update"),
              "human steering segment lost its promoted Session input",
            );
            if (
              steeringInput.delivery !== "steer" ||
              steeringInput.promotedSeq === null ||
              sourceTextFromPrompt(steeringInput.prompt) !== sourceMessage.text
            ) {
              reject("human steering input changed after positive promotion");
            }
            sourceText = sourceMessage.text;
          } else if (
            sourceMessage.type === "synthetic" &&
            segment.sourceInputId === null
          ) {
            sourceText = sourceMessage.text;
          } else {
            reject("steering source must be one canonical user or synthetic message");
          }
          steeringResumeSourceCorrelationId = segment.resumeSourceCorrelationId;
        } else {
          const sourceMessageRow = exactlyOne(
            await transaction
              .select()
              .from(taskSessionMessages)
              .where(
                and(
                  eq(taskSessionMessages.companyId, identity.companyId),
                  eq(taskSessionMessages.taskId, identity.taskId),
                  eq(taskSessionMessages.sessionId, identity.sessionId),
                  eq(taskSessionMessages.id, sourceMessageId),
                ),
              )
              .limit(2)
              .for("update"),
            "current prompt lost its canonical Session source message",
          );
          const sourceMessage = taskSessionMessageFromRow(sourceMessageRow);
          const sourceShapeMatches = source.messageKind === "user"
            ? sourceMessage.type === "user" &&
              sourceMessage.id === source.inputId &&
              sourceMessage.text === source.exactMessage
            : source.messageKind === "synthetic" &&
              sourceMessage.type === "synthetic" &&
              source.inputId === null &&
              sourceMessage.text === source.exactMessage;
          if (!sourceShapeMatches) {
            reject("current prompt source changed after immutable admission");
          }
          sourceMessageSeq = sourceMessageRow.seq;
        }
        if (!Number.isSafeInteger(sourceMessageSeq) || sourceMessageSeq < 0) {
          reject("current prompt source has an invalid Session sequence");
        }
        const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
          revision.acpConfiguration,
        );
        const compileInput = await options.compiler.resolve(
          promptCompileScope(completeIdentity),
        );
        const effectiveContextExposureDigest = contextDialDigest(
          compileInput.contextDial,
        );
        const carrySourceExposureDigest = contextDialDigest({
          ...compileInput.contextDial,
          carry_context: true,
        });
        const effectiveToolsDigest = runtimeInterfaceDigest(compileInput);
        const carryContext = compileInput.contextDial.carry_context;
        const targetFingerprint = localExecutionCorrelationFingerprint(
          identity.adapterConfigRevisionId,
        );
        const initialCycle = attempt.promptKind === "base"
          ? await resolveInitialPromptCycleInTransaction(transaction, {
              currentRef: source,
              executionWorkspaceBindingId:
                identity.executionWorkspaceBindingId,
            })
          : null;
        const operationMatchesCycle = initialCycle === null ||
          (attempt.sessionOperation === "new"
            ? initialCycle.kind === "new" ||
              (initialCycle.kind === "singleton" &&
                initialCycle.instructionless)
            : attempt.sessionOperation === "resume"
              ? initialCycle.kind === "bootstrap_resume" ||
                initialCycle.kind === "singleton"
              : false);
        if (initialCycle?.kind === "invalid" ||
          initialCycle?.kind === "bootstrap_unavailable" ||
          !operationMatchesCycle) {
          reject("initial prompt cycle no longer matches the frozen session operation");
        }
        const selectedCorrelation = attempt.sessionOperation === "resume"
          ? initialCycle?.kind === "bootstrap_resume"
            ? initialCycle.correlation
            : await selectCurrentCorrelation(transaction, {
                identity: completeIdentity,
                carryContext: true,
                effectiveContextExposureDigest,
                targetFingerprint,
              })
          : attempt.sessionOperation === "steer_resume"
            ? steeringResumeSourceCorrelationId === null
              ? reject("steering resume lost its immutable source correlation")
              : await selectSteeringResumeSourceCorrelation(transaction, {
                  identity: completeIdentity,
                  correlationId: steeringResumeSourceCorrelationId,
                  carrySourceExposureDigest,
                  targetFingerprint,
                })
            : null;
        if (
          ((attempt.sessionOperation === "resume" ||
            attempt.sessionOperation === "steer_resume") &&
            !selectedCorrelation) ||
          (attempt.sessionOperation === "new" && selectedCorrelation)
        ) {
          reject("frozen session operation no longer matches native correlation state");
        }
        const activationCorrelationScope: AcpCorrelationScope = carryContext
          ? {
              purpose: "carry",
              companyId: identity.companyId,
              taskId: identity.taskId,
              ownershipEpoch: identity.ownershipEpoch,
              targetAgentId: identity.targetAgentId,
              adapterConfigIdentity: identity.adapterConfigRevisionId,
              workspaceIdentity: identity.executionWorkspaceBindingId,
              targetFingerprint,
              correlationGeneration: await nextCorrelationGeneration(
                transaction,
                { identity: completeIdentity, carryContext: true },
              ),
              laneKind: identity.laneKind,
              authorizedContextExposureDigest:
                effectiveContextExposureDigest,
            }
          : {
              purpose: "active_run_steering",
              companyId: identity.companyId,
              taskId: identity.taskId,
              ownershipEpoch: identity.ownershipEpoch,
              targetAgentId: identity.targetAgentId,
              adapterConfigIdentity: identity.adapterConfigRevisionId,
              workspaceIdentity: identity.executionWorkspaceBindingId,
              targetFingerprint,
              correlationGeneration: await nextCorrelationGeneration(
                transaction,
                { identity: completeIdentity, carryContext: false },
              ),
              runId: identity.runId,
              currentRefId: identity.refId,
              currentRefOrdinal: identity.refOrdinal,
              currentSegmentOrdinal: identity.segmentOrdinal,
            };
        return Object.freeze({
          identity: completeIdentity,
          turn: compileInput.turn,
          sessionOperation: attempt.sessionOperation,
          sourceMessageId,
          sourceMessageSeq,
          sourceText,
          contextAccess: Object.freeze({ ...compileInput.contextDial }),
          carryContext,
          storedCorrelation: selectedCorrelation
            ? storedCorrelation(selectedCorrelation)
            : null,
          bootstrapPredecessor: initialCycle?.kind === "bootstrap_resume"
            ? initialCycle.predecessor
            : null,
          activationCorrelationScope,
          effectiveContextExposureDigest,
          carrySourceExposureDigest,
          effectiveToolsDigest,
          acpConfiguration,
          target: {
            companyId: identity.companyId,
            taskId: identity.taskId,
            runId: identity.runId,
            targetAgentId: identity.targetAgentId,
            adapterConfigRevisionId: identity.adapterConfigRevisionId,
            executionWorkspaceBindingId:
              identity.executionWorkspaceBindingId,
            acpConfiguration,
            hostCwd: workspace.absoluteCwd,
            localWorkspaceCwd: workspace.absoluteCwd,
            targetAdditionalDirectories: Object.freeze([]),
          },
          leaseRenewalIntervalMs,
        });
      });
    },

    async renewPromptAuthority(prompt) {
      return options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const capabilityRows = await transaction
          .select()
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(
                taskExecutionPromptCapabilities.companyId,
                prompt.identity.companyId,
              ),
              eq(
                taskExecutionPromptCapabilities.taskId,
                prompt.identity.taskId,
              ),
              eq(taskExecutionPromptCapabilities.runId, prompt.identity.runId),
              eq(taskExecutionPromptCapabilities.refId, prompt.identity.refId),
              eq(
                taskExecutionPromptCapabilities.refOrdinal,
                prompt.identity.refOrdinal,
              ),
              eq(
                taskExecutionPromptCapabilities.segmentOrdinal,
                prompt.identity.segmentOrdinal,
              ),
              eq(
                taskExecutionPromptCapabilities.attemptId,
                prompt.identity.attemptId,
              ),
              eq(taskExecutionPromptCapabilities.leaseId, prompt.identity.leaseId),
              eq(
                taskExecutionPromptCapabilities.leaseGeneration,
                prompt.identity.leaseGeneration,
              ),
            ),
          )
          .limit(2)
          .for("update");
        const timestamp = await transactionClockTimestamp(
          transaction,
          "prompt authority renewal time",
        );
        if (capabilityRows.length > 1) {
          reject("prompt authority renewal found ambiguous capabilities");
        }
        const liveCapability = capabilityRows[0]?.state === "pending_setup" ||
            capabilityRows[0]?.state === "active"
          ? capabilityRows[0]
          : null;
        if (lease.expiresAt <= timestamp) {
          rejectAuthorityLoss(
            prompt.identity,
            "prompt authority renewal cannot revive an expired lease",
          );
        }
        if (liveCapability && liveCapability.expiresAt <= timestamp) {
          rejectAuthorityLoss(
            prompt.identity,
            "prompt authority renewal cannot revive an expired capability",
          );
        }
        const expiresAt = new Date(timestamp.getTime() + leaseTtlMs);
        const renewed = await transaction
          .update(taskExecutionLeases)
          .set({ renewedAt: timestamp, expiresAt })
          .where(
            and(
              eq(taskExecutionLeases.id, prompt.identity.leaseId),
              eq(taskExecutionLeases.attemptId, prompt.identity.attemptId),
              eq(
                taskExecutionLeases.leaseGeneration,
                prompt.identity.leaseGeneration,
              ),
              eq(taskExecutionLeases.state, "active"),
              gt(taskExecutionLeases.expiresAt, timestamp),
            ),
          )
          .returning({ id: taskExecutionLeases.id });
        if (renewed.length !== 1) {
          rejectAuthorityLoss(
            prompt.identity,
            "attempt lease renewal lost its compare-and-set fence",
          );
        }
        const capabilityExpiresAt = new Date(
          Math.min(
            expiresAt.getTime(),
            timestamp.getTime() + capabilityTtlMs,
          ),
        );
        if (liveCapability) {
          const capabilityRenewed = await transaction
            .update(taskExecutionPromptCapabilities)
            .set({ expiresAt: capabilityExpiresAt })
            .where(
              and(
                eq(
                  taskExecutionPromptCapabilities.capabilityConnectionId,
                  liveCapability.capabilityConnectionId,
                ),
                eq(
                  taskExecutionPromptCapabilities.capabilityGeneration,
                  liveCapability.capabilityGeneration,
                ),
                inArray(taskExecutionPromptCapabilities.state, [
                  "pending_setup",
                  "active",
                ]),
                gt(taskExecutionPromptCapabilities.expiresAt, timestamp),
              ),
            )
            .returning({
              capabilityConnectionId:
                taskExecutionPromptCapabilities.capabilityConnectionId,
            });
          if (capabilityRenewed.length !== 1) {
            rejectAuthorityLoss(
              prompt.identity,
              "prompt capability renewal lost its compare-and-set fence",
            );
          }
        }
      });
    },

    async mintPendingCapability(prompt) {
      const compileInput = await options.compiler.resolve(
        promptCompileScope(prompt.identity),
      );
      if (
        compileInput.turn !== prompt.turn ||
        contextDialDigest(compileInput.contextDial) !==
          prompt.effectiveContextExposureDigest ||
        runtimeInterfaceDigest(compileInput) !== prompt.effectiveToolsDigest
      ) {
        reject("runtime interface changed before capability mint");
      }
      const bearer = mintPromptCapabilityBearer();
      const bearerHash = sha256(bearer);
      return options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const generationRows = await transaction
          .select({
            capabilityGeneration:
              taskExecutionPromptCapabilities.capabilityGeneration,
          })
          .from(taskExecutionPromptCapabilities)
          .where(eq(taskExecutionPromptCapabilities.runId, prompt.identity.runId))
          .orderBy(desc(taskExecutionPromptCapabilities.capabilityGeneration))
          .limit(1)
          .for("update");
        const timestamp = await transactionClockTimestamp(
          transaction,
          "capability creation time",
        );
        const capabilityGeneration =
          (generationRows[0]?.capabilityGeneration ?? 0) + 1;
        const capabilityConnectionId = idFactory();
        const expiresAt = new Date(
          Math.min(
            lease.expiresAt.getTime(),
            timestamp.getTime() + capabilityTtlMs,
          ),
        );
        if (expiresAt <= timestamp) reject("prompt lease expired before capability mint");
        const ownerRows = prompt.identity.promptKind === "base"
          ? await transaction
              .update(taskExecutionRunRefs)
              .set({
                attemptId: prompt.identity.attemptId,
                capabilityConnectionId,
                capabilityGeneration,
              })
              .where(
                and(
                  eq(taskExecutionRunRefs.runId, prompt.identity.runId),
                  eq(taskExecutionRunRefs.refId, prompt.identity.refId),
                  eq(taskExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
                  sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: taskExecutionRunRefs.runId })
          : await transaction
              .update(taskExecutionPromptSegments)
              .set({
                attemptId: prompt.identity.attemptId,
                capabilityConnectionId,
                capabilityGeneration,
              })
              .where(
                and(
                  eq(taskExecutionPromptSegments.runId, prompt.identity.runId),
                  eq(taskExecutionPromptSegments.refId, prompt.identity.refId),
                  eq(
                    taskExecutionPromptSegments.refOrdinal,
                    prompt.identity.refOrdinal,
                  ),
                  eq(
                    taskExecutionPromptSegments.segmentOrdinal,
                    prompt.identity.segmentOrdinal,
                  ),
                  eq(taskExecutionPromptSegments.steeringState, "resumed"),
                  sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: taskExecutionPromptSegments.runId });
        if (ownerRows.length !== 1) reject("capability mint lost its prompt owner");
        await transaction.insert(taskExecutionPromptCapabilities).values({
          companyId: prompt.identity.companyId,
          capabilityConnectionId,
          capabilityGeneration,
          runId: prompt.identity.runId,
          runBatchDigest: prompt.identity.runBatchDigest,
          refId: prompt.identity.refId,
          refOrdinal: prompt.identity.refOrdinal,
          segmentOrdinal: prompt.identity.segmentOrdinal,
          attemptId: prompt.identity.attemptId,
          leaseId: prompt.identity.leaseId,
          leaseGeneration: prompt.identity.leaseGeneration,
          workerProcessIdentity: idFactory(),
          taskId: prompt.identity.taskId,
          ownershipEpoch: prompt.identity.ownershipEpoch,
          targetAgentId: prompt.identity.targetAgentId,
          laneKind: prompt.identity.laneKind,
          executionMode: prompt.identity.laneKind,
          taskExecutionAuthorityId:
            prompt.identity.taskExecutionAuthorityId,
          consultExecutionId: prompt.identity.consultExecutionId,
          adapterConfigIdentity:
            prompt.identity.adapterConfigRevisionId,
          workspaceIdentity:
            prompt.identity.executionWorkspaceBindingId,
          targetSessionCorrelationId: null,
          effectiveContextExposureDigest:
            prompt.effectiveContextExposureDigest,
          effectiveToolsDigest: prompt.effectiveToolsDigest,
          bearerHash,
          state: "pending_setup",
          expiresAt,
          activatedAt: null,
          revocationReason: null,
          revokedAt: null,
          createdAt: timestamp,
        });
        return Object.freeze({
          capabilityConnectionId,
          capabilityGeneration,
          endpoint: endpoint.toString(),
          bearer,
        });
      });
    },

    async activatePrompt({ prompt, capability, correlation }) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const currentCapability = await lockCapability(
          transaction,
          prompt.identity,
          capability,
        );
        const scope = prompt.activationCorrelationScope;
        const continuityFenceGeneration =
          await lockBoardReopenContinuityFence(
            transaction,
            prompt.identity,
          );
        if (scope.correlationGeneration <= continuityFenceGeneration) {
          reject(
            "prompt activation correlation does not clear the latest board-reopen continuity fence",
          );
        }
        const timestamp = await transactionClockTimestamp(
          transaction,
          "prompt activation time",
        );
        if (
          lease.expiresAt <= timestamp ||
          currentCapability.state !== "pending_setup" ||
          currentCapability.targetSessionCorrelationId !== null ||
          currentCapability.activatedAt !== null ||
          currentCapability.expiresAt <= timestamp
        ) {
          reject("capability is not pending exact prompt activation");
        }
        const old = await selectCurrentCorrelation(transaction, {
          identity: prompt.identity,
          carryContext: prompt.carryContext,
          effectiveContextExposureDigest:
            prompt.effectiveContextExposureDigest,
          targetFingerprint: scope.targetFingerprint,
        });
        const incompatibleCarryRows = !prompt.carryContext
          ? await transaction
              .select({ id: taskExecutionSessions.id })
              .from(taskExecutionSessions)
              .where(
                and(
                  eq(taskExecutionSessions.companyId, prompt.identity.companyId),
                  eq(taskExecutionSessions.taskId, prompt.identity.taskId),
                  eq(
                    taskExecutionSessions.ownershipEpoch,
                    prompt.identity.ownershipEpoch,
                  ),
                  eq(
                    taskExecutionSessions.targetAgentId,
                    prompt.identity.targetAgentId,
                  ),
                  eq(
                    taskExecutionSessions.adapterConfigIdentity,
                    prompt.identity.adapterConfigRevisionId,
                  ),
                  eq(
                    taskExecutionSessions.workspaceIdentity,
                    prompt.identity.executionWorkspaceBindingId,
                  ),
                  eq(taskExecutionSessions.purpose, "carry"),
                  eq(taskExecutionSessions.state, "eligible"),
                  eq(taskExecutionSessions.laneKind, prompt.identity.laneKind),
                ),
              )
              .limit(2)
              .for("update")
          : [];
        if (incompatibleCarryRows.length > 1) {
          reject("false-carry activation found ambiguous stale carry state");
        }
        const replacedCorrelationIds = new Set<string>([
          ...(old ? [old.id] : []),
          ...(prompt.storedCorrelation ? [prompt.storedCorrelation.id] : []),
          ...incompatibleCarryRows.map((row) => row.id),
        ]);
        for (const correlationId of replacedCorrelationIds) {
          await supersedeCorrelation(
            transaction,
            correlationId,
            "generation_replaced",
            timestamp,
          );
        }
        const cursorSourceId = prompt.storedCorrelation?.id ?? old?.id ?? null;
        const oldCursor = cursorSourceId
          ? await transaction
              .select()
              .from(taskExecutionSessions)
              .where(eq(taskExecutionSessions.id, cursorSourceId))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const correlationId = idFactory();
        await transaction.insert(taskExecutionSessions).values({
          id: correlationId,
          companyId: prompt.identity.companyId,
          taskId: prompt.identity.taskId,
          ownershipEpoch: prompt.identity.ownershipEpoch,
          purpose: scope.purpose,
          state: scope.purpose === "carry" ? "eligible" : "current",
          targetAgentId: prompt.identity.targetAgentId,
          adapterConfigIdentity: prompt.identity.adapterConfigRevisionId,
          workspaceIdentity: prompt.identity.executionWorkspaceBindingId,
          laneKind: scope.purpose === "carry" ? scope.laneKind : null,
          runId: scope.purpose === "active_run_steering" ? scope.runId : null,
          currentRefId:
            scope.purpose === "active_run_steering"
              ? scope.currentRefId
              : null,
          currentRefOrdinal:
            scope.purpose === "active_run_steering"
              ? scope.currentRefOrdinal
              : null,
          currentSegmentOrdinal:
            scope.purpose === "active_run_steering"
              ? scope.currentSegmentOrdinal
              : null,
          authorizedContextExposureDigest:
            scope.purpose === "carry"
              ? scope.authorizedContextExposureDigest
              : null,
          envelopeVersion: correlation.envelopeVersion,
          codecKind: correlation.codecKind,
          acpWireProtocolVersion: 1,
          protectedTargetSession: correlation.ciphertext,
          protectedTargetSessionDigest: correlation.digest,
          targetFingerprint: scope.targetFingerprint,
          correlationGeneration: scope.correlationGeneration,
          lastProtocolSettledRunId:
            oldCursor?.lastProtocolSettledRunId ?? null,
          lastProtocolSettledRefId:
            oldCursor?.lastProtocolSettledRefId ?? null,
          lastProtocolSettledRefOrdinal:
            oldCursor?.lastProtocolSettledRefOrdinal ?? null,
          lastProtocolSettledSegmentOrdinal:
            oldCursor?.lastProtocolSettledSegmentOrdinal ?? null,
          costCursorState: oldCursor?.costCursorState ?? "unanchored",
          costCursorAmount: oldCursor?.costCursorAmount ?? null,
          costCursorCurrency: oldCursor?.costCursorCurrency ?? null,
          supersessionReason: null,
          supersededAt: null,
          createdAt: timestamp,
        });
        const activated = await transaction
          .update(taskExecutionPromptCapabilities)
          .set({
            state: "active",
            targetSessionCorrelationId: correlationId,
            activatedAt: timestamp,
          })
          .where(
            and(
              eq(
                taskExecutionPromptCapabilities.capabilityConnectionId,
                capability.capabilityConnectionId,
              ),
              eq(
                taskExecutionPromptCapabilities.capabilityGeneration,
                capability.capabilityGeneration,
              ),
              eq(taskExecutionPromptCapabilities.state, "pending_setup"),
            ),
          )
          .returning({
            capabilityConnectionId:
              taskExecutionPromptCapabilities.capabilityConnectionId,
          });
        if (activated.length !== 1) reject("prompt activation lost its capability");
        if (prompt.identity.promptKind === "steering") {
          const updated = await transaction
            .update(taskExecutionPromptSegments)
            .set({
              targetSessionGeneration: scope.correlationGeneration,
              resumedAt: sql`coalesce(
                ${taskExecutionPromptSegments.resumedAt},
                greatest(
                  ${sql.param(timestamp, taskExecutionPromptSegments.resumedAt)},
                  ${taskExecutionPromptSegments.createdAt} + interval '1 millisecond'
                )
              )`,
            })
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, prompt.identity.runId),
                eq(taskExecutionPromptSegments.refId, prompt.identity.refId),
                eq(
                  taskExecutionPromptSegments.refOrdinal,
                  prompt.identity.refOrdinal,
                ),
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  prompt.identity.segmentOrdinal,
                ),
                eq(taskExecutionPromptSegments.attemptId, prompt.identity.attemptId),
              ),
            )
            .returning({
              runId: taskExecutionPromptSegments.runId,
            });
          if (updated.length !== 1) reject("steering activation lost its segment");
        }
      });
    },

    async beginPromptTransmission({ prompt, capability }) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const currentCapability = await lockCapability(
          transaction,
          prompt.identity,
          capability,
        );
        const timestamp = await transactionClockTimestamp(
          transaction,
          "prompt transmission time",
        );
        if (
          lease.expiresAt <= timestamp ||
          currentCapability.state !== "active" ||
          !currentCapability.targetSessionCorrelationId ||
          currentCapability.expiresAt <= timestamp
        ) {
          reject("prompt transmission requires one active capability");
        }
        const changed = prompt.identity.promptKind === "base"
          ? await transaction
              .update(taskExecutionRunRefs)
              .set({ promptTransmissionPhase: "transmitted" })
              .where(
                and(
                  eq(taskExecutionRunRefs.runId, prompt.identity.runId),
                  eq(taskExecutionRunRefs.refId, prompt.identity.refId),
                  eq(taskExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
                  eq(taskExecutionRunRefs.attemptId, prompt.identity.attemptId),
                  eq(taskExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
                  sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: taskExecutionRunRefs.runId })
          : await transaction
              .update(taskExecutionPromptSegments)
              .set({ promptTransmissionPhase: "transmitted" })
              .where(
                and(
                  eq(taskExecutionPromptSegments.runId, prompt.identity.runId),
                  eq(taskExecutionPromptSegments.refId, prompt.identity.refId),
                  eq(
                    taskExecutionPromptSegments.refOrdinal,
                    prompt.identity.refOrdinal,
                  ),
                  eq(
                    taskExecutionPromptSegments.segmentOrdinal,
                    prompt.identity.segmentOrdinal,
                  ),
                  eq(taskExecutionPromptSegments.attemptId, prompt.identity.attemptId),
                  eq(
                    taskExecutionPromptSegments.promptTransmissionPhase,
                    "not_transmitted",
                  ),
                  sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: taskExecutionPromptSegments.runId });
        if (changed.length !== 1) reject("prompt transmission was not monotonic");
      });
    },

    async closePrompt({ prompt, capability, outcome }) {
      let budgetScopes: readonly BudgetEnforcementScope[] = Object.freeze([]);
      const result = await options.database.transaction(async (transaction) => {
        // Closure may publish the assistant boundary. Lock its FK parents and
        // Session checkpoint before revalidating the run and capability.
        await lockTaskSessionProjectionRoot(transaction, {
          companyId: prompt.identity.companyId,
          taskId: prompt.identity.taskId,
          sessionId: prompt.identity.sessionId,
        });
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const currentCapability = await lockCapability(
          transaction,
          prompt.identity,
          capability,
        );
        const timestamp = await transactionClockTimestamp(
          transaction,
          "prompt closure time",
        );
        const nativeCancellation = outcome.kind === "cancelled";
        const preserveCorrelation =
          preserveCorrelationAfterNonProtocolClosure({
            turn: prompt.turn,
            carryContext: prompt.carryContext,
          });
        if (
          (outcome.kind === "cancelled" &&
            outcome.settlement !== null &&
            outcome.settlement.stopReason !== "cancelled") ||
          (outcome.kind === "settled" &&
            outcome.settlement.stopReason === "cancelled")
        ) {
          reject("prompt cancellation closure disagrees with ACPX result status");
        }
        const steeringCancellationCapability =
          currentCapability.state === "revoked" &&
          currentCapability.revocationReason === "active_run_steering" &&
          currentCapability.revokedAt !== null &&
          nativeCancellation;
        if (
          lease.expiresAt <= timestamp ||
          (currentCapability.state !== "pending_setup" &&
            currentCapability.state !== "active" &&
            !steeringCancellationCapability) ||
          currentCapability.expiresAt <= timestamp
        ) {
          reject("prompt closure requires one live capability generation");
        }
        const protocolSettlement = outcome.kind === "settled"
          ? outcome.settlement
          : outcome.kind === "cancelled"
            ? outcome.settlement
            : null;
        if (protocolSettlement !== null) {
          if (
            currentCapability.state !== "active" &&
            !steeringCancellationCapability
          ) {
            reject("protocol settlement requires an active capability");
          }
          const assistantMessageId = await ensureAssistantStarted(
            transaction,
            prompt.identity,
            timestamp,
          );
          const { seq } = await reserveTaskSessionEventSequence(transaction, {
            companyId: prompt.identity.companyId,
            taskId: prompt.identity.taskId,
            sessionId: prompt.identity.sessionId,
          });
          const settlementReferenceId = deterministicUuid(
            "paperclip-acp-prompt-settlement",
            `${prompt.identity.attemptId}:${capability.capabilityGeneration}`,
          );
          const settled = await settleAcpPromptInTransaction(transaction, {
            identity: prompt.identity.promptKind === "base" ? {
              companyId: prompt.identity.companyId,
              taskId: prompt.identity.taskId,
              sessionId: prompt.identity.sessionId,
              agentId: prompt.identity.targetAgentId,
              runId: prompt.identity.runId,
              runKind: prompt.identity.runKind,
              promptKind: "base" as const,
              refId: prompt.identity.refId,
              runOrdinal: prompt.identity.refOrdinal,
              segmentOrdinal: 0 as const,
              attemptId: prompt.identity.attemptId,
              adapterConfigRevisionId:
                prompt.identity.adapterConfigRevisionId,
            } : {
              companyId: prompt.identity.companyId,
              taskId: prompt.identity.taskId,
              sessionId: prompt.identity.sessionId,
              agentId: prompt.identity.targetAgentId,
              runId: prompt.identity.runId,
              runKind: prompt.identity.runKind,
              promptKind: "steering" as const,
              refId: prompt.identity.refId,
              runOrdinal: prompt.identity.refOrdinal,
              segmentOrdinal: prompt.identity.segmentOrdinal,
              attemptId: prompt.identity.attemptId,
              adapterConfigRevisionId:
                prompt.identity.adapterConfigRevisionId,
            },
            settlement: protocolSettlement,
            promptSettlementReferenceId: settlementReferenceId,
            terminalUsageReference:
              `acp-prompt:${prompt.identity.attemptId}:terminal-usage`,
            terminalStopReference:
              `acp-prompt:${prompt.identity.attemptId}:terminal-stop`,
            stepEnded: {
              eventId:
                `evt_${sha256(`acp-prompt:${prompt.identity.attemptId}:step-ended`).slice(0, 40)}`,
              eventSeq: seq,
              assistantMessageId,
            },
            settledAt: timestamp,
          });
          budgetScopes = settled.budgetSuspensionScopes;
          if (nativeCancellation) {
            const recordedCancellation = await recordNativeCancellationSettlement(
              transaction,
              prompt.identity,
              timestamp,
            );
            if (steeringCancellationCapability && !recordedCancellation) {
              reject("steering cancellation lost its exact active intent");
            }
          }
          if (!steeringCancellationCapability) {
            await revokeCapability(
              transaction,
              prompt.identity,
              capability,
              "protocol_settled",
              timestamp,
            );
          }
          const finalText = await terminalAssistantText(
            transaction,
            prompt.identity,
            assistantMessageId,
          );
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: terminalOutcome(protocolSettlement.stopReason),
              reason: protocolSettlement.stopReason,
              finalText,
            },
          };
        }
        if (outcome.kind === "cancelled") {
          if (
            currentCapability.state !== "active" &&
            !steeringCancellationCapability
          ) {
            reject("native cancellation has no exact active capability");
          }
          await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
            state: "incomplete",
            outcome: "cancelled",
            referenceId: deterministicUuid(
              "paperclip-acp-prompt-incomplete",
              prompt.identity.attemptId,
            ),
            at: timestamp,
          });
          const recordedCancellation = await recordNativeCancellationSettlement(
            transaction,
            prompt.identity,
            timestamp,
          );
          if (steeringCancellationCapability && !recordedCancellation) {
            reject("steering cancellation lost its exact active intent");
          }
          if (!steeringCancellationCapability) {
            await revokeCapability(
              transaction,
              prompt.identity,
              capability,
              "prompt_cancelled_incomplete",
              timestamp,
            );
            if (!preserveCorrelation) {
              await supersedeCorrelation(
                transaction,
                currentCapability.targetSessionCorrelationId,
                "prompt_cancelled_incomplete",
                timestamp,
              );
            }
          }
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: "cancelled" as const,
              reason: "cancelled",
            },
          };
        }
        if (outcome.kind !== "error") {
          reject("protocol settlement closure did not commit");
        }
        const correlationId = currentCapability.targetSessionCorrelationId;
        if (!outcome.promptTransmitted) {
          const retryable =
            outcome.failure === "runtime" &&
            currentCapability.state === "pending_setup" &&
            prompt.sessionOperation === "new";
          await revokeCapability(
            transaction,
            prompt.identity,
            capability,
            retryable ? "pre_send_retry" : "pre_send_failure",
            timestamp,
          );
          if (retryable) {
            return {
              kind: "dispatch" as const,
              result: {
                kind: "retry" as const,
                reason: "transport_transient" as const,
                retryAt: new Date(timestamp.getTime() + 1_000),
              },
            };
          }
          if (!preserveCorrelation) {
            await supersedeCorrelation(
              transaction,
              prompt.storedCorrelation?.id ?? correlationId,
              "pre_send_failure",
              timestamp,
            );
          }
          await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
            state: "not_sent",
            outcome: "released_unsent",
            referenceId: deterministicUuid(
              "paperclip-acp-prompt-not-sent",
              prompt.identity.attemptId,
            ),
            at: timestamp,
          });
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: "failed" as const,
              reason: boundedReason(outcome.message, "pre_send_failure"),
            },
          };
        }
        if (currentCapability.state !== "active") {
          reject("post-send failure has no active exact capability");
        }
        await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
          state: "incomplete",
          outcome: "failed",
          referenceId: deterministicUuid(
            "paperclip-acp-prompt-incomplete",
            prompt.identity.attemptId,
          ),
          at: timestamp,
        });
        await revokeCapability(
          transaction,
          prompt.identity,
          capability,
          "prompt_failed_incomplete",
          timestamp,
        );
        if (!preserveCorrelation) {
          await supersedeCorrelation(
            transaction,
            correlationId,
            "prompt_failed_incomplete",
            timestamp,
          );
        }
        return {
          kind: "dispatch" as const,
          result: {
            kind: "terminal" as const,
            outcome: "failed" as const,
            reason: boundedReason(outcome.message, "post_send_incomplete"),
          },
        };
      });
      if (budgetScopes.length > 0) {
        await options.suspendBudgetScopes?.(budgetScopes);
      }
      return result;
    },

  };
  return Object.freeze(repository);
}
