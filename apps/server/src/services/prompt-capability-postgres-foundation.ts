import { taskExecutionPromptCapabilities, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import {
  PromptCapabilityAuthorityError,
  type PromptCapabilityAuthenticationResult,
  type PromptCapabilityBinding,
  type PromptCapabilityCompileScope,
} from "./prompt-capability-gateway.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function createPromptCapabilityGatewayPostgresContext(
  db: Db,
  compiler: PromptCapabilityCompiler,
  runService: Pick<TaskExecutionRunService, "readRun">,
) {
  return { db, compiler, runService };
}

export type PromptCapabilityGatewayPostgresContext = ReturnType<
  typeof createPromptCapabilityGatewayPostgresContext
>;

export interface PromptCapabilityCompiler {
  resolve(capability: PromptCapabilityCompileScope): Promise<RuntimeInterfaceCompileInput>;
}

export type PromptCapabilityRow = typeof taskExecutionPromptCapabilities.$inferSelect;

export async function transactionClockTimestamp(transaction: TaskSessionDbTransaction): Promise<Date> {
  const rows = Array.from(
    await transaction.execute(sql<{ timestampMs: number }>`
      select (extract(epoch from clock_timestamp()) * 1000)::double precision
        as "timestampMs"
    `),
  );
  const timestamp = new Date(Number(rows[0]?.timestampMs));
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new PromptCapabilityAuthorityError("database_clock_invalid");
  }
  return timestamp;
}

export function inactive(): PromptCapabilityAuthenticationResult {
  return { kind: "inactive" };
}

export function invalid(reason: string): PromptCapabilityAuthenticationResult {
  return { kind: "authority_invalid", reason };
}

export function sameBinding(left: PromptCapabilityBinding, right: PromptCapabilityBinding): boolean {
  return (
    left.companyId === right.companyId &&
    left.capabilityConnectionId === right.capabilityConnectionId &&
    left.capabilityGeneration === right.capabilityGeneration &&
    left.runId === right.runId &&
    left.runBatchDigest === right.runBatchDigest &&
    left.refId === right.refId &&
    left.refOrdinal === right.refOrdinal &&
    left.segmentOrdinal === right.segmentOrdinal &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.workerProcessIdentity === right.workerProcessIdentity &&
    left.taskId === right.taskId &&
    left.sessionId === right.sessionId &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.targetAgentId === right.targetAgentId &&
    left.laneKind === right.laneKind &&
    left.executionMode === right.executionMode &&
    left.taskExecutionAuthorityId === right.taskExecutionAuthorityId &&
    left.consultExecutionId === right.consultExecutionId &&
    left.adapterConfigIdentity === right.adapterConfigIdentity &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.targetSessionCorrelationId === right.targetSessionCorrelationId &&
    left.effectiveContextExposureDigest === right.effectiveContextExposureDigest &&
    left.effectiveToolsDigest === right.effectiveToolsDigest &&
    left.activatedAt.getTime() === right.activatedAt.getTime() &&
    left.createdAt.getTime() === right.createdAt.getTime()
  );
}

export function runMatchesCapability(
  run: NonNullable<Awaited<ReturnType<TaskExecutionRunService["readRun"]>>>,
  row: PromptCapabilityRow,
): boolean {
  return (
    run.status === "running" &&
    run.sessionId.length > 0 &&
    run.ownershipEpoch === row.ownershipEpoch &&
    run.targetAgentId === row.targetAgentId &&
    run.executionMode === row.executionMode &&
    run.taskExecutionAuthorityId === row.taskExecutionAuthorityId &&
    run.consultExecutionId === row.consultExecutionId &&
    run.adapterConfigRevisionId === row.adapterConfigIdentity &&
    run.executionWorkspaceBindingId === row.workspaceIdentity &&
    run.currentAttemptId === row.attemptId &&
    run.currentLeaseId === row.leaseId &&
    run.cancellationIntentId === null &&
    run.terminalFinalizationId === null
  );
}

export function rowMatchesBinding(row: PromptCapabilityRow, capability: PromptCapabilityBinding): boolean {
  return (
    row.companyId === capability.companyId &&
    row.capabilityConnectionId === capability.capabilityConnectionId &&
    row.capabilityGeneration === capability.capabilityGeneration &&
    row.runId === capability.runId &&
    row.runBatchDigest === capability.runBatchDigest &&
    row.refId === capability.refId &&
    row.refOrdinal === capability.refOrdinal &&
    row.segmentOrdinal === capability.segmentOrdinal &&
    row.attemptId === capability.attemptId &&
    row.leaseId === capability.leaseId &&
    row.leaseGeneration === capability.leaseGeneration &&
    row.workerProcessIdentity === capability.workerProcessIdentity &&
    row.taskId === capability.taskId &&
    row.ownershipEpoch === capability.ownershipEpoch &&
    row.targetAgentId === capability.targetAgentId &&
    row.laneKind === capability.laneKind &&
    row.executionMode === capability.executionMode &&
    row.taskExecutionAuthorityId === capability.taskExecutionAuthorityId &&
    row.consultExecutionId === capability.consultExecutionId &&
    row.adapterConfigIdentity === capability.adapterConfigIdentity &&
    row.workspaceIdentity === capability.workspaceIdentity &&
    row.targetSessionCorrelationId === capability.targetSessionCorrelationId &&
    row.effectiveContextExposureDigest === capability.effectiveContextExposureDigest &&
    row.effectiveToolsDigest === capability.effectiveToolsDigest &&
    row.activatedAt?.getTime() === capability.activatedAt.getTime() &&
    row.createdAt.getTime() === capability.createdAt.getTime()
  );
}

/**
 * Mutation-side fence for an already authenticated capability. The gateway
 * performs the full canonical run/ref/attempt/lease/correlation revalidation;
 * action transactions lock this exact generation so revocation/finalization
 * cannot race the protected mutation.
 */
export async function lockActivePromptCapabilityBinding(
  transaction: TaskSessionDbTransaction,
  capability: PromptCapabilityBinding,
  _at: Date,
): Promise<void> {
  const row = await transaction
    .select()
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
        eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const timestamp = await transactionClockTimestamp(transaction);
  if (!row || row.state !== "active" || row.expiresAt <= timestamp || !rowMatchesBinding(row, capability)) {
    throw new PromptCapabilityAuthorityError("capability_generation_changed");
  }
}

export function projectBinding(row: PromptCapabilityRow, sessionId: string): PromptCapabilityBinding | null {
  if (
    row.state !== "active" ||
    row.targetSessionCorrelationId === null ||
    row.activatedAt === null ||
    (row.executionMode !== "owner" && row.executionMode !== "consult") ||
    row.executionMode !== row.laneKind
  ) {
    return null;
  }
  return projectIngressBinding(row, sessionId) as PromptCapabilityBinding;
}

export function projectIngressBinding(row: PromptCapabilityRow, sessionId: string) {
  return Object.freeze({
    companyId: row.companyId,
    capabilityConnectionId: row.capabilityConnectionId,
    capabilityGeneration: row.capabilityGeneration,
    runId: row.runId,
    runBatchDigest: row.runBatchDigest,
    refId: row.refId,
    refOrdinal: row.refOrdinal,
    segmentOrdinal: row.segmentOrdinal,
    attemptId: row.attemptId,
    leaseId: row.leaseId,
    leaseGeneration: row.leaseGeneration,
    workerProcessIdentity: row.workerProcessIdentity,
    taskId: row.taskId,
    sessionId,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    laneKind: row.laneKind,
    executionMode: row.executionMode,
    taskExecutionAuthorityId: row.taskExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    adapterConfigIdentity: row.adapterConfigIdentity,
    workspaceIdentity: row.workspaceIdentity,
    targetSessionCorrelationId: row.targetSessionCorrelationId,
    effectiveContextExposureDigest: row.effectiveContextExposureDigest,
    effectiveToolsDigest: row.effectiveToolsDigest,
    expiresAt: row.expiresAt,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  });
}
