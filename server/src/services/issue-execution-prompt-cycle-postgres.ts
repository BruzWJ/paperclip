import { createHash, randomUUID } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  issueBoardReopenCommands,
  issueExecutionAttempts,
  issueExecutionCancellationIntents,
  issueExecutionLeases,
  issueExecutionProcessFacts,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issueSessionEvents,
  issueSessionInputs,
  issueSessionMessages,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  IssueSession,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  settleAcpPromptInTransaction,
} from "./acp-prompt-settlement.js";
import type { BudgetEnforcementScope } from "./budgets.js";
import { contextDialDigest } from "./context-dial-resolver.js";
import {
  fenceCompanySkillMaterializationReferenceInTransaction,
  resolveCompanySkillMaterializationRevisionInTransaction,
} from "./company-skill-materialization-lifecycle.js";
import {
  IssueExecutionPromptAuthorityLost,
} from "./issue-execution-attempt-executor.js";
import type {
  IssueExecutionAttemptLease,
  IssueExecutionPromptCapabilityIdentity,
  IssueExecutionPromptClosure,
  IssueExecutionPromptCycleRepository,
  IssueExecutionPromptIdentity,
  IssueExecutionSubprocessObservation,
  ResolvedIssueExecutionPrompt,
} from "./issue-execution-attempt-executor.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";
import { recordIssueLivenessActionInTransaction } from "./issue-liveness-reconciliation.js";
import {
  reserveIssueSessionEventSequence,
  reserveIssueSessionMessageId,
  type IssueSessionDbTransaction,
} from "./issue-session/event-store.js";
import { publishIssueSessionEventInTx } from "./issue-session/publication.js";
import { issueSessionMessageFromRow } from "./issue-session/projector.js";
import type { AcpCorrelationScope, StoredAcpSessionCorrelation } from "./native-correlation.js";
import { mintPromptCapabilityBearer } from "./prompt-capability-gateway.js";
import type { PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import { runtimeInterfaceDigest } from "./runtime-interface-compiler.js";

const DEFAULT_CAPABILITY_TTL_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

export interface PostgresIssueExecutionPromptCycleOptions {
  readonly database: Db;
  readonly runService: Pick<IssueExecutionRunService, "lockRun">;
  readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
  readonly capabilityEndpoint: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly capabilityTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly suspendBudgetScopes?: (
    scopes: readonly BudgetEnforcementScope[],
  ) => Promise<void>;
}

export class PostgresIssueExecutionPromptCycleRejected extends Error {
  readonly code = "postgres_issue_execution_prompt_cycle_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresIssueExecutionPromptCycleRejected";
  }
}

type AttemptRow = typeof issueExecutionAttempts.$inferSelect;
type LeaseRow = typeof issueExecutionLeases.$inferSelect;
type CorrelationRow = typeof issueExecutionSessions.$inferSelect;

function reject(message: string): never {
  throw new PostgresIssueExecutionPromptCycleRejected(message);
}

function rejectAuthorityLoss(
  lease: IssueExecutionAttemptLease,
  message: string,
): never {
  throw new IssueExecutionPromptAuthorityLost(
    lease,
    new PostgresIssueExecutionPromptCycleRejected(message),
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
  transaction: IssueSessionDbTransaction,
  label: string,
): Promise<Date> {
  const rows = Array.from(
    await transaction.execute(sql<{ timestamp: Date }>`
      select clock_timestamp() as "timestamp"
    `),
  );
  return validDate(rows[0]?.timestamp, label);
}

function boundedReason(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 200);
  return normalized || fallback;
}

function promptCompileScope(prompt: IssueExecutionPromptIdentity) {
  return {
    companyId: prompt.companyId,
    issueId: prompt.issueId,
    ownershipEpoch: prompt.ownershipEpoch,
    targetAgentId: prompt.targetAgentId,
    executionMode: prompt.laneKind,
    issueExecutionAuthorityId: prompt.issueExecutionAuthorityId,
    consultExecutionId: prompt.consultExecutionId,
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
    issueId: row.issueId,
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
  transaction: IssueSessionDbTransaction,
  input: {
    readonly identity: IssueExecutionPromptIdentity;
    readonly carryContext: boolean;
    readonly effectiveContextExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<CorrelationRow | null> {
  const { identity } = input;
  const common = and(
    eq(issueExecutionSessions.companyId, identity.companyId),
    eq(issueExecutionSessions.issueId, identity.issueId),
    eq(issueExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
    eq(issueExecutionSessions.targetAgentId, identity.targetAgentId),
    eq(
      issueExecutionSessions.adapterConfigIdentity,
      identity.adapterConfigRevisionId,
    ),
    eq(
      issueExecutionSessions.workspaceIdentity,
      identity.executionWorkspaceBindingId,
    ),
    eq(issueExecutionSessions.targetFingerprint, input.targetFingerprint),
  );
  const rows = input.carryContext
    ? await transaction
        .select()
        .from(issueExecutionSessions)
        .where(
          and(
            common,
            eq(issueExecutionSessions.purpose, "carry"),
            eq(issueExecutionSessions.state, "eligible"),
            eq(issueExecutionSessions.laneKind, identity.laneKind),
            eq(
              issueExecutionSessions.authorizedContextExposureDigest,
              input.effectiveContextExposureDigest,
            ),
          ),
        )
        .limit(2)
        .for("update")
    : await transaction
        .select()
        .from(issueExecutionSessions)
        .where(
          and(
            common,
            eq(issueExecutionSessions.purpose, "active_run_steering"),
            eq(issueExecutionSessions.state, "current"),
            eq(issueExecutionSessions.runId, identity.runId),
          ),
        )
        .limit(2)
        .for("update");
  if (rows.length > 1) reject("native correlation logical key is ambiguous");
  return rows[0] ?? null;
}

async function selectSteeringResumeSourceCorrelation(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly identity: IssueExecutionPromptIdentity;
    readonly correlationId: string;
    readonly carrySourceExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<CorrelationRow | null> {
  const { identity } = input;
  const rows = await transaction
    .select()
    .from(issueExecutionSessions)
    .where(
      and(
        eq(issueExecutionSessions.id, input.correlationId),
        eq(issueExecutionSessions.companyId, identity.companyId),
        eq(issueExecutionSessions.issueId, identity.issueId),
        eq(issueExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
        eq(issueExecutionSessions.targetAgentId, identity.targetAgentId),
        eq(
          issueExecutionSessions.adapterConfigIdentity,
          identity.adapterConfigRevisionId,
        ),
        eq(
          issueExecutionSessions.workspaceIdentity,
          identity.executionWorkspaceBindingId,
        ),
        eq(issueExecutionSessions.targetFingerprint, input.targetFingerprint),
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
  transaction: IssueSessionDbTransaction,
  input: {
    readonly identity: IssueExecutionPromptIdentity;
    readonly carryContext: boolean;
  },
): Promise<number> {
  const { identity } = input;
  const rows = await transaction
      .select({ generation: issueExecutionSessions.correlationGeneration })
      .from(issueExecutionSessions)
      .where(
        input.carryContext
          ? and(
              eq(issueExecutionSessions.companyId, identity.companyId),
              eq(issueExecutionSessions.issueId, identity.issueId),
              eq(
                issueExecutionSessions.ownershipEpoch,
                identity.ownershipEpoch,
              ),
              eq(issueExecutionSessions.targetAgentId, identity.targetAgentId),
              eq(
                issueExecutionSessions.adapterConfigIdentity,
                identity.adapterConfigRevisionId,
              ),
              eq(
                issueExecutionSessions.workspaceIdentity,
                identity.executionWorkspaceBindingId,
              ),
              eq(issueExecutionSessions.purpose, "carry"),
              eq(issueExecutionSessions.laneKind, identity.laneKind),
            )
          : and(
              eq(issueExecutionSessions.companyId, identity.companyId),
              eq(issueExecutionSessions.issueId, identity.issueId),
              eq(
                issueExecutionSessions.ownershipEpoch,
                identity.ownershipEpoch,
              ),
              eq(issueExecutionSessions.targetAgentId, identity.targetAgentId),
              eq(
                issueExecutionSessions.adapterConfigIdentity,
                identity.adapterConfigRevisionId,
              ),
              eq(
                issueExecutionSessions.workspaceIdentity,
                identity.executionWorkspaceBindingId,
              ),
              eq(issueExecutionSessions.purpose, "active_run_steering"),
              eq(issueExecutionSessions.runId, identity.runId),
            ),
      )
      .orderBy(desc(issueExecutionSessions.correlationGeneration))
      .limit(1)
      .for("update");
  const reopenFences = await transaction
    .select({
      generation: issueBoardReopenCommands.continuityFenceGeneration,
    })
    .from(issueBoardReopenCommands)
    .where(
      and(
        eq(issueBoardReopenCommands.companyId, identity.companyId),
        eq(issueBoardReopenCommands.issueId, identity.issueId),
        eq(
          issueBoardReopenCommands.ownershipEpoch,
          identity.ownershipEpoch,
        ),
      ),
    )
    .orderBy(desc(issueBoardReopenCommands.continuityFenceGeneration))
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
  transaction: IssueSessionDbTransaction,
  identity: IssueExecutionPromptIdentity,
): Promise<number> {
  const lockedIssue = await transaction
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, identity.companyId),
        eq(issues.id, identity.issueId),
        eq(issues.ownershipEpoch, identity.ownershipEpoch),
      ),
    )
    .limit(2)
    .for("update");
  if (lockedIssue.length !== 1) {
    reject("prompt activation lost its exact issue epoch");
  }
  const fences = await transaction
    .select({
      generation: issueBoardReopenCommands.continuityFenceGeneration,
    })
    .from(issueBoardReopenCommands)
    .where(
      and(
        eq(issueBoardReopenCommands.companyId, identity.companyId),
        eq(issueBoardReopenCommands.issueId, identity.issueId),
        eq(
          issueBoardReopenCommands.ownershipEpoch,
          identity.ownershipEpoch,
        ),
      ),
    )
    .orderBy(desc(issueBoardReopenCommands.continuityFenceGeneration))
    .limit(1)
    .for("update");
  return fences[0]?.generation ?? 0;
}

async function assertCurrentAttempt(
  transaction: IssueSessionDbTransaction,
  runService: Pick<IssueExecutionRunService, "lockRun">,
  prompt: IssueExecutionPromptIdentity,
): Promise<{
  readonly attempt: AttemptRow;
  readonly lease: LeaseRow;
  readonly timestamp: Date;
}> {
  const run = await runService.lockRun(transaction, prompt);
  const controlRows = await transaction
    .select()
    .from(issueExecutionRunControls)
    .where(eq(issueExecutionRunControls.runId, prompt.runId))
    .limit(2)
    .for("update");
  const attemptRows = await transaction
    .select()
    .from(issueExecutionAttempts)
    .where(eq(issueExecutionAttempts.id, prompt.attemptId))
    .limit(2)
    .for("update");
  const leaseRows = await transaction
    .select()
    .from(issueExecutionLeases)
    .where(eq(issueExecutionLeases.id, prompt.leaseId))
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
    run.issueExecutionAuthorityId !== prompt.issueExecutionAuthorityId ||
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
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  capability: IssueExecutionPromptCapabilityIdentity,
) {
  const rows = await transaction
    .select()
    .from(issueExecutionPromptCapabilities)
    .where(
      and(
        eq(
          issueExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          issueExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
        eq(issueExecutionPromptCapabilities.companyId, prompt.companyId),
        eq(issueExecutionPromptCapabilities.issueId, prompt.issueId),
        eq(issueExecutionPromptCapabilities.runId, prompt.runId),
        eq(issueExecutionPromptCapabilities.refId, prompt.refId),
        eq(issueExecutionPromptCapabilities.refOrdinal, prompt.refOrdinal),
        eq(
          issueExecutionPromptCapabilities.segmentOrdinal,
          prompt.segmentOrdinal,
        ),
        eq(issueExecutionPromptCapabilities.attemptId, prompt.attemptId),
        eq(issueExecutionPromptCapabilities.leaseId, prompt.leaseId),
      ),
    )
    .limit(2)
    .for("update");
  return exactlyOne(rows, "prompt capability generation is missing or crossed");
}

async function revokeCapability(
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  capability: IssueExecutionPromptCapabilityIdentity,
  reason: string,
  at: Date,
): Promise<void> {
  const changed = await transaction
    .update(issueExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: boundedReason(reason, "prompt_closed"),
      revokedAt: at,
    })
    .where(
      and(
        eq(
          issueExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          issueExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
        eq(issueExecutionPromptCapabilities.runId, prompt.runId),
        inArray(issueExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    )
    .returning({
      capabilityConnectionId:
        issueExecutionPromptCapabilities.capabilityConnectionId,
    });
  if (changed.length !== 1) reject("prompt capability could not be revoked exactly once");
}

async function supersedeCorrelation(
  transaction: IssueSessionDbTransaction,
  correlationId: string | null,
  reason: string,
  at: Date,
): Promise<void> {
  if (!correlationId) return;
  await transaction
    .update(issueExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: boundedReason(reason, "prompt_closed"),
      supersededAt: at,
    })
    .where(
      and(
        eq(issueExecutionSessions.id, correlationId),
        inArray(issueExecutionSessions.state, ["eligible", "current"]),
      ),
    );
}

async function settleNonProtocolPrompt(
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  input: {
    readonly state: "not_sent" | "incomplete";
    readonly outcome: "released_unsent" | "failed" | "cancelled";
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
        .update(issueExecutionRunRefs)
        .set(values)
        .where(
          and(
            eq(issueExecutionRunRefs.runId, prompt.runId),
            eq(issueExecutionRunRefs.refId, prompt.refId),
            eq(issueExecutionRunRefs.refOrdinal, prompt.refOrdinal),
            eq(issueExecutionRunRefs.attemptId, prompt.attemptId),
            eq(
              issueExecutionRunRefs.promptTransmissionPhase,
              input.state === "not_sent" ? "not_transmitted" : "transmitted",
            ),
            sql`${issueExecutionRunRefs.protocolSettlementState} is null`,
          ),
        )
        .returning({ runId: issueExecutionRunRefs.runId })
    : await transaction
        .update(issueExecutionPromptSegments)
        .set({ ...values, steeringState: "protocol_settled" })
        .where(
          and(
            eq(issueExecutionPromptSegments.runId, prompt.runId),
            eq(issueExecutionPromptSegments.refId, prompt.refId),
            eq(issueExecutionPromptSegments.refOrdinal, prompt.refOrdinal),
            eq(
              issueExecutionPromptSegments.segmentOrdinal,
              prompt.segmentOrdinal,
            ),
            eq(issueExecutionPromptSegments.attemptId, prompt.attemptId),
            eq(
              issueExecutionPromptSegments.promptTransmissionPhase,
              input.state === "not_sent" ? "not_transmitted" : "transmitted",
            ),
            sql`${issueExecutionPromptSegments.protocolSettlementState} is null`,
          ),
        )
        .returning({ runId: issueExecutionPromptSegments.runId });
  if (rows.length !== 1) reject("non-protocol prompt settlement lost its exact owner");
}

async function ensureAssistantStarted(
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  at: Date,
): Promise<string> {
  const scope = {
    companyId: prompt.companyId,
    issueId: prompt.issueId,
    sessionId: prompt.sessionId,
  };
  const assistantMessageId = await reserveIssueSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${prompt.attemptId}:assistant`,
  );
  const existing = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, prompt.companyId),
        eq(issueSessionMessages.issueId, prompt.issueId),
        eq(issueSessionMessages.sessionId, prompt.sessionId),
        eq(issueSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(2)
    .for("update");
  if (existing.length > 1) reject("assistant message identity is ambiguous");
  if (existing[0]) {
    const message = issueSessionMessageFromRow(existing[0]);
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
  const immutableSourceKey = `acp_prompt_update:${prompt.attemptId}:0:${IssueSession.Event.Step.Started.type}`;
  const { seq } = await reserveIssueSessionEventSequence(transaction, scope);
  await publishIssueSessionEventInTx(transaction, {
    event: {
      id: `evt_${sha256(immutableSourceKey).slice(0, 40)}`,
      sessionId: prompt.sessionId,
      seq,
      type: IssueSession.Event.Step.Started.type,
      data: {
        timestamp: at.getTime(),
        sessionID: prompt.sessionId,
        assistantMessageID: assistantMessageId,
        agent: prompt.targetAgentId,
        model: {
          id: configuration.model.id,
          providerID: configuration.launchProfile.registryName,
        },
      },
    },
    envelope: {
      companyId: prompt.companyId,
      issueId: prompt.issueId,
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
        prompt.issueId,
        prompt.sessionId,
        prompt.runId,
        prompt.attemptId,
        IssueSession.Event.Step.Started.type,
      ].join(":")),
      createdAt: at,
    },
  });
  return assistantMessageId;
}

async function terminalAssistantText(
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  assistantMessageId: string,
): Promise<string> {
  const row = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, prompt.companyId),
        eq(issueSessionMessages.issueId, prompt.issueId),
        eq(issueSessionMessages.sessionId, prompt.sessionId),
        eq(issueSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return "";
  const message = issueSessionMessageFromRow(row);
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

export function createPostgresIssueExecutionPromptCycleRepository(
  options: PostgresIssueExecutionPromptCycleOptions,
): IssueExecutionPromptCycleRepository {
  const now = options.now ?? (() => new Date());
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

  const repository: IssueExecutionPromptCycleRepository = {
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
          .from(issueExecutionRunControls)
          .where(eq(issueExecutionRunControls.runId, run.runId))
          .limit(2)
          .for("update");
        const attemptRows = await transaction
          .select()
          .from(issueExecutionAttempts)
          .where(eq(issueExecutionAttempts.id, lease.attemptId))
          .limit(2)
          .for("update");
        const leaseRows = await transaction
          .select()
          .from(issueExecutionLeases)
          .where(eq(issueExecutionLeases.id, lease.leaseId))
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
          attempt.issueId !== run.issueId ||
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
        const identity: IssueExecutionPromptIdentity = Object.freeze({
          companyId: run.companyId,
          issueId: run.issueId,
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
          issueExecutionAuthorityId: run.issueExecutionAuthorityId,
          consultExecutionId: run.consultExecutionId,
          adapterConfigRevisionId: run.adapterConfigRevisionId,
          executionWorkspaceBindingId: run.executionWorkspaceBindingId,
        });
        const memberRows = await transaction
          .select()
          .from(issueExecutionRunRefs)
          .where(
            and(
              eq(issueExecutionRunRefs.runId, identity.runId),
              eq(issueExecutionRunRefs.refId, identity.refId),
              eq(issueExecutionRunRefs.refOrdinal, identity.refOrdinal),
            ),
          )
          .limit(2)
          .for("update");
        const sourceRows = await transaction
          .select()
          .from(issueExecutionRefs)
          .where(eq(issueExecutionRefs.id, identity.refId))
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
          .from(issueExecutionWorkspaceBindings)
          .where(
            and(
              eq(
                issueExecutionWorkspaceBindings.id,
                identity.executionWorkspaceBindingId,
              ),
              eq(issueExecutionWorkspaceBindings.companyId, identity.companyId),
              eq(issueExecutionWorkspaceBindings.issueId, identity.issueId),
              eq(issueExecutionWorkspaceBindings.sessionId, identity.sessionId),
              eq(
                issueExecutionWorkspaceBindings.ownershipEpoch,
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
          source.issueId !== identity.issueId ||
          source.sessionId !== identity.sessionId ||
          source.ownershipEpoch !== identity.ownershipEpoch ||
          source.mode !== identity.laneKind ||
          source.targetAgentId !== identity.targetAgentId ||
          source.issueExecutionAuthorityId !== identity.issueExecutionAuthorityId ||
          source.consultExecutionId !== identity.consultExecutionId ||
          source.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
          source.disposition !== "active" ||
          member.protocolSettlementState !== null
        ) {
          reject("current prompt crossed its immutable ref scope");
        }
        const completeIdentity: IssueExecutionPromptIdentity = Object.freeze({
          ...identity,
          runBatchDigest: member.batchDigest,
        });
        let sourceText = source.exactMessage;
        let steeringResumeSourceCorrelationId: string | null = null;
        if (attempt.promptKind === "steering") {
          const segment = exactlyOne(
            await transaction
              .select()
              .from(issueExecutionPromptSegments)
              .where(
                and(
                  eq(issueExecutionPromptSegments.runId, identity.runId),
                  eq(issueExecutionPromptSegments.refId, identity.refId),
                  eq(issueExecutionPromptSegments.refOrdinal, identity.refOrdinal),
                  eq(
                    issueExecutionPromptSegments.segmentOrdinal,
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
              .from(issueSessionMessages)
              .where(
                and(
                  eq(issueSessionMessages.companyId, identity.companyId),
                  eq(issueSessionMessages.issueId, identity.issueId),
                  eq(issueSessionMessages.sessionId, identity.sessionId),
                  eq(issueSessionMessages.id, segment.sourceMessageId),
                ),
              )
              .limit(2)
              .for("update"),
            "steering segment lost its canonical Session message",
          );
          const sourceMessage = issueSessionMessageFromRow(sourceMessageRow);
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
                .from(issueSessionInputs)
                .where(
                  and(
                    eq(issueSessionInputs.companyId, identity.companyId),
                    eq(issueSessionInputs.issueId, identity.issueId),
                    eq(issueSessionInputs.sessionId, identity.sessionId),
                    eq(issueSessionInputs.id, segment.sourceInputId),
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
        }
        const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
          revision.acpConfiguration,
        );
        const companySkillLaunchChannel = (
          await resolveCompanySkillMaterializationRevisionInTransaction(
            transaction,
            {
              companyId: identity.companyId,
              agentId: identity.targetAgentId,
              adapterConfigRevisionId: identity.adapterConfigRevisionId,
            },
          )
        ).launchChannel;
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
        const targetFingerprint =
          acpConfiguration.executionTargetSelector.executionTargetDigest;
        const selectedCorrelation = attempt.sessionOperation === "resume"
          ? await selectCurrentCorrelation(transaction, {
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
              issueId: identity.issueId,
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
              issueId: identity.issueId,
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
          sessionOperation: attempt.sessionOperation,
          sourceText,
          carryContext,
          storedCorrelation: selectedCorrelation
            ? storedCorrelation(selectedCorrelation)
            : null,
          activationCorrelationScope,
          effectiveContextExposureDigest,
          carrySourceExposureDigest,
          effectiveToolsDigest,
          acpConfiguration,
          companySkills: companySkillLaunchChannel,
          target: {
            companyId: identity.companyId,
            issueId: identity.issueId,
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
          timeoutSec: null,
          runtimeRootDir: null,
          localProcessSandbox: null,
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
          .from(issueExecutionPromptCapabilities)
          .where(
            and(
              eq(
                issueExecutionPromptCapabilities.companyId,
                prompt.identity.companyId,
              ),
              eq(
                issueExecutionPromptCapabilities.issueId,
                prompt.identity.issueId,
              ),
              eq(issueExecutionPromptCapabilities.runId, prompt.identity.runId),
              eq(issueExecutionPromptCapabilities.refId, prompt.identity.refId),
              eq(
                issueExecutionPromptCapabilities.refOrdinal,
                prompt.identity.refOrdinal,
              ),
              eq(
                issueExecutionPromptCapabilities.segmentOrdinal,
                prompt.identity.segmentOrdinal,
              ),
              eq(
                issueExecutionPromptCapabilities.attemptId,
                prompt.identity.attemptId,
              ),
              eq(issueExecutionPromptCapabilities.leaseId, prompt.identity.leaseId),
              eq(
                issueExecutionPromptCapabilities.leaseGeneration,
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
          .update(issueExecutionLeases)
          .set({ renewedAt: timestamp, expiresAt })
          .where(
            and(
              eq(issueExecutionLeases.id, prompt.identity.leaseId),
              eq(issueExecutionLeases.attemptId, prompt.identity.attemptId),
              eq(
                issueExecutionLeases.leaseGeneration,
                prompt.identity.leaseGeneration,
              ),
              eq(issueExecutionLeases.state, "active"),
              sql`${issueExecutionLeases.expiresAt} > ${timestamp}`,
            ),
          )
          .returning({ id: issueExecutionLeases.id });
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
            .update(issueExecutionPromptCapabilities)
            .set({ expiresAt: capabilityExpiresAt })
            .where(
              and(
                eq(
                  issueExecutionPromptCapabilities.capabilityConnectionId,
                  liveCapability.capabilityConnectionId,
                ),
                eq(
                  issueExecutionPromptCapabilities.capabilityGeneration,
                  liveCapability.capabilityGeneration,
                ),
                inArray(issueExecutionPromptCapabilities.state, [
                  "pending_setup",
                  "active",
                ]),
                sql`${issueExecutionPromptCapabilities.expiresAt} > ${timestamp}`,
              ),
            )
            .returning({
              capabilityConnectionId:
                issueExecutionPromptCapabilities.capabilityConnectionId,
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
              issueExecutionPromptCapabilities.capabilityGeneration,
          })
          .from(issueExecutionPromptCapabilities)
          .where(eq(issueExecutionPromptCapabilities.runId, prompt.identity.runId))
          .orderBy(desc(issueExecutionPromptCapabilities.capabilityGeneration))
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
              .update(issueExecutionRunRefs)
              .set({
                attemptId: prompt.identity.attemptId,
                capabilityConnectionId,
                capabilityGeneration,
              })
              .where(
                and(
                  eq(issueExecutionRunRefs.runId, prompt.identity.runId),
                  eq(issueExecutionRunRefs.refId, prompt.identity.refId),
                  eq(issueExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
                  sql`${issueExecutionRunRefs.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: issueExecutionRunRefs.runId })
          : await transaction
              .update(issueExecutionPromptSegments)
              .set({
                attemptId: prompt.identity.attemptId,
                capabilityConnectionId,
                capabilityGeneration,
              })
              .where(
                and(
                  eq(issueExecutionPromptSegments.runId, prompt.identity.runId),
                  eq(issueExecutionPromptSegments.refId, prompt.identity.refId),
                  eq(
                    issueExecutionPromptSegments.refOrdinal,
                    prompt.identity.refOrdinal,
                  ),
                  eq(
                    issueExecutionPromptSegments.segmentOrdinal,
                    prompt.identity.segmentOrdinal,
                  ),
                  eq(issueExecutionPromptSegments.steeringState, "resumed"),
                  sql`${issueExecutionPromptSegments.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: issueExecutionPromptSegments.runId });
        if (ownerRows.length !== 1) reject("capability mint lost its prompt owner");
        await transaction.insert(issueExecutionPromptCapabilities).values({
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
          issueId: prompt.identity.issueId,
          ownershipEpoch: prompt.identity.ownershipEpoch,
          targetAgentId: prompt.identity.targetAgentId,
          laneKind: prompt.identity.laneKind,
          executionMode: prompt.identity.laneKind,
          issueExecutionAuthorityId:
            prompt.identity.issueExecutionAuthorityId,
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
        await fenceCompanySkillMaterializationReferenceInTransaction(
          transaction,
          {
            companyId: prompt.identity.companyId,
            agentId: prompt.identity.targetAgentId,
            adapterConfigRevisionId:
              prompt.identity.adapterConfigRevisionId,
          },
        );
        const old = await selectCurrentCorrelation(transaction, {
          identity: prompt.identity,
          carryContext: prompt.carryContext,
          effectiveContextExposureDigest:
            prompt.effectiveContextExposureDigest,
          targetFingerprint: scope.targetFingerprint,
        });
        const incompatibleCarryRows = !prompt.carryContext
          ? await transaction
              .select({ id: issueExecutionSessions.id })
              .from(issueExecutionSessions)
              .where(
                and(
                  eq(issueExecutionSessions.companyId, prompt.identity.companyId),
                  eq(issueExecutionSessions.issueId, prompt.identity.issueId),
                  eq(
                    issueExecutionSessions.ownershipEpoch,
                    prompt.identity.ownershipEpoch,
                  ),
                  eq(
                    issueExecutionSessions.targetAgentId,
                    prompt.identity.targetAgentId,
                  ),
                  eq(
                    issueExecutionSessions.adapterConfigIdentity,
                    prompt.identity.adapterConfigRevisionId,
                  ),
                  eq(
                    issueExecutionSessions.workspaceIdentity,
                    prompt.identity.executionWorkspaceBindingId,
                  ),
                  eq(issueExecutionSessions.purpose, "carry"),
                  eq(issueExecutionSessions.state, "eligible"),
                  eq(issueExecutionSessions.laneKind, prompt.identity.laneKind),
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
              .from(issueExecutionSessions)
              .where(eq(issueExecutionSessions.id, cursorSourceId))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const correlationId = idFactory();
        await transaction.insert(issueExecutionSessions).values({
          id: correlationId,
          companyId: prompt.identity.companyId,
          issueId: prompt.identity.issueId,
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
          .update(issueExecutionPromptCapabilities)
          .set({
            state: "active",
            targetSessionCorrelationId: correlationId,
            activatedAt: timestamp,
          })
          .where(
            and(
              eq(
                issueExecutionPromptCapabilities.capabilityConnectionId,
                capability.capabilityConnectionId,
              ),
              eq(
                issueExecutionPromptCapabilities.capabilityGeneration,
                capability.capabilityGeneration,
              ),
              eq(issueExecutionPromptCapabilities.state, "pending_setup"),
            ),
          )
          .returning({
            capabilityConnectionId:
              issueExecutionPromptCapabilities.capabilityConnectionId,
          });
        if (activated.length !== 1) reject("prompt activation lost its capability");
        if (prompt.identity.promptKind === "steering") {
          const updated = await transaction
            .update(issueExecutionPromptSegments)
            .set({
              targetSessionGeneration: scope.correlationGeneration,
              resumedAt: sql`coalesce(
                ${issueExecutionPromptSegments.resumedAt},
                greatest(
                  ${timestamp},
                  ${issueExecutionPromptSegments.createdAt} + interval '1 millisecond'
                )
              )`,
            })
            .where(
              and(
                eq(issueExecutionPromptSegments.runId, prompt.identity.runId),
                eq(issueExecutionPromptSegments.refId, prompt.identity.refId),
                eq(
                  issueExecutionPromptSegments.refOrdinal,
                  prompt.identity.refOrdinal,
                ),
                eq(
                  issueExecutionPromptSegments.segmentOrdinal,
                  prompt.identity.segmentOrdinal,
                ),
                eq(issueExecutionPromptSegments.attemptId, prompt.identity.attemptId),
              ),
            )
            .returning({
              runId: issueExecutionPromptSegments.runId,
              sourceInputId: issueExecutionPromptSegments.sourceInputId,
            });
          if (updated.length !== 1) reject("steering activation lost its segment");
          if (updated[0]!.sourceInputId === null) {
            await recordIssueLivenessActionInTransaction(
              transaction,
              `issue_execution_prompt_segment:${prompt.identity.runId}:${prompt.identity.refId}:${prompt.identity.segmentOrdinal}`,
            );
          }
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
              .update(issueExecutionRunRefs)
              .set({ promptTransmissionPhase: "transmitted" })
              .where(
                and(
                  eq(issueExecutionRunRefs.runId, prompt.identity.runId),
                  eq(issueExecutionRunRefs.refId, prompt.identity.refId),
                  eq(issueExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
                  eq(issueExecutionRunRefs.attemptId, prompt.identity.attemptId),
                  eq(issueExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
                  sql`${issueExecutionRunRefs.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: issueExecutionRunRefs.runId })
          : await transaction
              .update(issueExecutionPromptSegments)
              .set({ promptTransmissionPhase: "transmitted" })
              .where(
                and(
                  eq(issueExecutionPromptSegments.runId, prompt.identity.runId),
                  eq(issueExecutionPromptSegments.refId, prompt.identity.refId),
                  eq(
                    issueExecutionPromptSegments.refOrdinal,
                    prompt.identity.refOrdinal,
                  ),
                  eq(
                    issueExecutionPromptSegments.segmentOrdinal,
                    prompt.identity.segmentOrdinal,
                  ),
                  eq(issueExecutionPromptSegments.attemptId, prompt.identity.attemptId),
                  eq(
                    issueExecutionPromptSegments.promptTransmissionPhase,
                    "not_transmitted",
                  ),
                  sql`${issueExecutionPromptSegments.protocolSettlementState} is null`,
                ),
              )
              .returning({ runId: issueExecutionPromptSegments.runId });
        if (changed.length !== 1) reject("prompt transmission was not monotonic");
      });
    },

    async recordSubprocessStarted(input) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          input.prompt.identity,
        );
        const capability = await lockCapability(
          transaction,
          input.prompt.identity,
          input.capability,
        );
        const timestamp = await transactionClockTimestamp(
          transaction,
          "subprocess start time",
        );
        if (
          lease.expiresAt <= timestamp ||
          capability.state !== "pending_setup" ||
          capability.expiresAt <= timestamp ||
          input.processId < 1 ||
          input.processGroupId < 1 ||
          input.supervisorLocator.trim().length === 0
        ) {
          reject("subprocess start crossed capability or process identity");
        }
        await transaction.insert(issueExecutionProcessFacts).values({
          companyId: input.prompt.identity.companyId,
          issueId: input.prompt.identity.issueId,
          runId: input.prompt.identity.runId,
          attemptId: input.prompt.identity.attemptId,
          leaseId: input.prompt.identity.leaseId,
          processId: input.processId,
          processGroupId: input.processGroupId,
          supervisorLocator: input.supervisorLocator,
          state: "running",
          startedAt: timestamp,
          settledAt: null,
          exitCode: null,
          exitSignal: null,
          createdAt: timestamp,
        });
      });
    },

    async closePrompt({ prompt, capability, outcome }) {
      let budgetScopes: readonly BudgetEnforcementScope[] = Object.freeze([]);
      const result = await options.database.transaction(async (transaction) => {
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
        if (
          lease.expiresAt <= timestamp ||
          (currentCapability.state !== "pending_setup" &&
            currentCapability.state !== "active") ||
          currentCapability.expiresAt <= timestamp
        ) {
          reject("prompt closure requires one live capability generation");
        }
        if (outcome.kind === "target_not_found") {
          if (
            prompt.sessionOperation !== "resume" &&
            prompt.sessionOperation !== "steer_resume"
          ) {
            reject("target_not_found is valid only for a frozen resume operation");
          }
          await revokeCapability(
            transaction,
            prompt.identity,
            capability,
            "target_not_found",
            timestamp,
          );
          await supersedeCorrelation(
            transaction,
            prompt.storedCorrelation?.id ?? null,
            "target_not_found",
            timestamp,
          );
          return {
            kind: "dispatch" as const,
            result: {
              kind: "retry" as const,
              reason: "target_not_found_new_session" as const,
              retryAt: timestamp,
            },
          };
        }
        if (outcome.kind === "settled") {
          if (currentCapability.state !== "active") {
            reject("protocol settlement requires an active capability");
          }
          const assistantMessageId = await ensureAssistantStarted(
            transaction,
            prompt.identity,
            timestamp,
          );
          const { seq } = await reserveIssueSessionEventSequence(transaction, {
            companyId: prompt.identity.companyId,
            issueId: prompt.identity.issueId,
            sessionId: prompt.identity.sessionId,
          });
          const settlementReferenceId = deterministicUuid(
            "paperclip-acp-prompt-settlement",
            `${prompt.identity.attemptId}:${capability.capabilityGeneration}`,
          );
          const settled = await settleAcpPromptInTransaction(transaction, {
            identity: prompt.identity.promptKind === "base" ? {
              companyId: prompt.identity.companyId,
              issueId: prompt.identity.issueId,
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
              issueId: prompt.identity.issueId,
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
            settlement: outcome.settlement,
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
          if (
            outcome.settlement.stopReason === "cancelled" &&
            !outcome.cancellationNotificationFailed
          ) {
            await transaction
              .update(issueExecutionCancellationIntents)
              .set({ sessionCancelSentAt: timestamp })
              .where(
                and(
                  eq(
                    issueExecutionCancellationIntents.attemptId,
                    prompt.identity.attemptId,
                  ),
                  eq(issueExecutionCancellationIntents.state, "acknowledged"),
                  sql`${issueExecutionCancellationIntents.sessionCancelSentAt} is null`,
                ),
              );
          }
          await revokeCapability(
            transaction,
            prompt.identity,
            capability,
            outcome.cancellationNotificationFailed
              ? "protocol_settled_cancel_notification_failed"
              : "protocol_settled",
            timestamp,
          );
          const finalText = await terminalAssistantText(
            transaction,
            prompt.identity,
            assistantMessageId,
          );
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: terminalOutcome(outcome.settlement.stopReason),
              reason: outcome.settlement.stopReason,
              finalText,
            },
          };
        }
        const correlationId = currentCapability.targetSessionCorrelationId;
        if (!outcome.promptTransmitted) {
          const retryable =
            outcome.failure === "runtime" &&
            currentCapability.state === "pending_setup";
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
          await supersedeCorrelation(
            transaction,
            correlationId,
            "pre_send_failure",
            timestamp,
          );
          await settleNonProtocolPrompt(transaction, prompt.identity, {
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
        const cancelled = outcome.message.includes("cancel");
        await settleNonProtocolPrompt(transaction, prompt.identity, {
          state: "incomplete",
          outcome: cancelled ? "cancelled" : "failed",
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
          cancelled ? "prompt_cancelled_incomplete" : "prompt_failed_incomplete",
          timestamp,
        );
        await supersedeCorrelation(
          transaction,
          correlationId,
          cancelled ? "prompt_cancelled_incomplete" : "prompt_failed_incomplete",
          timestamp,
        );
        return {
          kind: "dispatch" as const,
          result: {
            kind: "terminal" as const,
            outcome: cancelled ? "cancelled" as const : "failed" as const,
            reason: boundedReason(outcome.message, "post_send_incomplete"),
          },
        };
      });
      if (budgetScopes.length > 0) {
        await options.suspendBudgetScopes?.(budgetScopes);
      }
      return result;
    },

    async recordSubprocessTeardown({ prompt, observation }) {
      await options.database.transaction(async (transaction) => {
        const timestamp = validDate(now(), "subprocess teardown time");
        const rows = await transaction
          .select()
          .from(issueExecutionProcessFacts)
          .where(
            and(
              eq(issueExecutionProcessFacts.runId, prompt.identity.runId),
              eq(issueExecutionProcessFacts.attemptId, prompt.identity.attemptId),
              eq(issueExecutionProcessFacts.leaseId, prompt.identity.leaseId),
            ),
          )
          .limit(2)
          .for("update");
        // A subprocess can be reaped after spawn but before its process fact
        // commits (invalid PID, lost prompt authority, or an ambiguous commit
        // failure). With no durable fact there is nothing to settle.
        if (rows.length === 0) return;
        const process = exactlyOne(rows, "subprocess teardown lost its process fact");
        if (!["starting", "running"].includes(process.state)) {
          if (["exited", "terminated", "lost"].includes(process.state)) return;
          reject("subprocess fact has an invalid teardown state");
        }
        const terminal = processTerminalColumns(observation, timestamp);
        const changed = await transaction
          .update(issueExecutionProcessFacts)
          .set(terminal)
          .where(
            and(
              eq(issueExecutionProcessFacts.id, process.id),
              inArray(issueExecutionProcessFacts.state, ["starting", "running"]),
            ),
          )
          .returning({ id: issueExecutionProcessFacts.id });
        if (changed.length !== 1) reject("subprocess teardown lost its monotonic state");
      });
    },

    async recordProtocolViolation({ prompt, capability }) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const current = await lockCapability(
          transaction,
          prompt.identity,
          capability,
        );
        const timestamp = await transactionClockTimestamp(
          transaction,
          "protocol violation time",
        );
        if (
          lease.expiresAt <= timestamp ||
          (current.state !== "pending_setup" && current.state !== "active") ||
          current.expiresAt <= timestamp
        ) {
          reject("protocol violation crossed an inactive capability");
        }
      });
    },
  };
  return Object.freeze(repository);
}

function processTerminalColumns(
  observation: IssueExecutionSubprocessObservation,
  at: Date,
) {
  if (observation.teardown.kind !== "reaped") {
    return {
      state: "lost" as const,
      settledAt: at,
      exitCode: null,
      exitSignal: null,
    };
  }
  if (observation.teardown.signal) {
    return {
      state: "terminated" as const,
      settledAt: at,
      exitCode: null,
      exitSignal: observation.teardown.signal,
    };
  }
  if (observation.teardown.exitCode !== null) {
    return {
      state: "exited" as const,
      settledAt: at,
      exitCode: observation.teardown.exitCode,
      exitSignal: null,
    };
  }
  return {
    state: "lost" as const,
    settledAt: at,
    exitCode: null,
    exitSignal: null,
  };
}
