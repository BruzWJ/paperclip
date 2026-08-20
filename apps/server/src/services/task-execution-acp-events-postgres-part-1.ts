import { createHash } from "node:crypto";

import {
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRunControls,
  taskExecutionRunRefs,
} from "@paperclipai/db";

import { and, eq } from "drizzle-orm";

import { redactSensitiveText } from "../redaction.js";

import type {
  TaskExecutionPromptCapabilityIdentity,
  TaskExecutionPromptIdentity,
} from "./task-execution-attempt-executor.js";

import type { TaskExecutionRunService } from "./task-execution-run-service.js";

import { type TaskSessionDbTransaction } from "./task-session/event-store.js";

import {
  publishTaskSessionEventInTx,
  type TaskSessionPublicationCompanions,
  type TaskSessionPublicationRedactor,
} from "./task-session/publication.js";

export class PostgresTaskExecutionAcpEventRejected extends Error {
  readonly code = "postgres_task_execution_acp_event_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionAcpEventRejected";
  }
}

export function reject(message: string): never {
  throw new PostgresTaskExecutionAcpEventRejected(message);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const PAPERCLIP_MCP_SERVER_NAME = "paperclip";

export const PAPERCLIP_MCP_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Extracts the exact Paperclip MCP identity retained in normalized ACP raw
 * input. A Paperclip-marked envelope must be exact; display titles are never
 * parsed as aliases for canonical tool names.
 */
export function canonicalPaperclipMcpToolName(value: unknown): string | null {
  if (!isPlainRecord(value) || value.server !== PAPERCLIP_MCP_SERVER_NAME) {
    return null;
  }
  if (
    Object.keys(value).sort().join("\n") !== ["arguments", "server", "tool"].sort().join("\n") ||
    typeof value.tool !== "string" ||
    !PAPERCLIP_MCP_TOOL_NAME.test(value.tool)
  ) {
    reject("Paperclip MCP tool input has no exact canonical identity");
  }
  return value.tool;
}

/**
 * Projects one ACP tool label into a collision-free Session name. Paperclip
 * MCP tools retain their exact compiler-owned name; every other tool is kept
 * in the separate provider display namespace and can never masquerade as a
 * Paperclip capability.
 */
export function projectedAcpToolName(rawInput: unknown, providerTitle: string): string {
  const paperclipToolName = canonicalPaperclipMcpToolName(rawInput);
  if (paperclipToolName !== null) return paperclipToolName;
  if (providerTitle.length === 0) {
    reject("ACP provider tool has no display title");
  }
  return `provider-tool:${providerTitle}`;
}

export function redactValue<T>(
  value: T,
  redactText: (text: string) => string,
  ancestors: ReadonlySet<object> = new Set(),
): T {
  if (typeof value === "string") {
    return redactSensitiveText(redactText(value)) as T;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      reject("ACP event contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    reject("ACP event contains a non-JSON value");
  }
  if (ancestors.has(value)) reject("ACP event contains a cycle");
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactText, nextAncestors)) as T;
  }
  if (!isPlainRecord(value)) reject("ACP event contains a non-JSON object");
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key !== "_meta" && entry !== undefined)
      .map(([key, entry]) => [key, redactValue(entry, redactText, nextAncestors)]),
  ) as T;
}

export function publicationRedactor(redactText: (text: string) => string): TaskSessionPublicationRedactor {
  return {
    redactText: (value) => redactSensitiveText(redactText(value)),
    redactValue: (value) => redactValue(value, redactText),
  };
}

export function exactCapability(
  row: typeof taskExecutionPromptCapabilities.$inferSelect,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
): void {
  if (
    row.capabilityConnectionId !== capability.capabilityConnectionId ||
    row.capabilityGeneration !== capability.capabilityGeneration ||
    row.companyId !== prompt.companyId ||
    row.taskId !== prompt.taskId ||
    row.runId !== prompt.runId ||
    row.runBatchDigest !== prompt.runBatchDigest ||
    row.refId !== prompt.refId ||
    row.refOrdinal !== prompt.refOrdinal ||
    row.attemptId !== prompt.attemptId ||
    row.leaseId !== prompt.leaseId ||
    row.leaseGeneration !== prompt.leaseGeneration ||
    row.ownershipEpoch !== prompt.ownershipEpoch ||
    row.targetAgentId !== prompt.targetAgentId ||
    row.laneKind !== prompt.laneKind ||
    row.executionMode !== prompt.laneKind ||
    row.taskExecutionAuthorityId !== prompt.taskExecutionAuthorityId ||
    row.consultExecutionId !== prompt.consultExecutionId ||
    row.adapterConfigIdentity !== prompt.adapterConfigRevisionId ||
    row.workspaceIdentity !== prompt.executionWorkspaceBindingId
  ) {
    reject("ACP update crossed its exact prompt capability identity");
  }
}

export async function lockCurrentPrompt(
  transaction: TaskSessionDbTransaction,
  runService: Pick<TaskExecutionRunService, "lockRun">,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
  now: Date,
): Promise<typeof taskExecutionPromptCapabilities.$inferSelect> {
  const run = await runService.lockRun(transaction, {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
    runId: prompt.runId,
  });
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
    run.terminalFinalizationId !== null
  ) {
    reject("ACP update does not belong to the current running envelope");
  }
  const control = await transaction
    .select()
    .from(taskExecutionRunControls)
    .where(eq(taskExecutionRunControls.runId, prompt.runId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !control ||
    control.currentRefId !== prompt.refId ||
    control.currentOrdinal !== prompt.refOrdinal
  ) {
    reject("ACP update crossed the run's current prompt pointer");
  }
  const attempt = await transaction
    .select()
    .from(taskExecutionAttempts)
    .where(eq(taskExecutionAttempts.id, prompt.attemptId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !attempt ||
    attempt.companyId !== prompt.companyId ||
    attempt.taskId !== prompt.taskId ||
    attempt.sessionId !== prompt.sessionId ||
    attempt.runId !== prompt.runId ||
    attempt.runKind !== prompt.runKind ||
    attempt.refId !== prompt.refId ||
    attempt.refOrdinal !== prompt.refOrdinal ||
    attempt.attemptGeneration !== prompt.attemptGeneration ||
    attempt.state !== "running"
  ) {
    reject("ACP update does not belong to the current running attempt");
  }
  const lease = await transaction
    .select()
    .from(taskExecutionLeases)
    .where(eq(taskExecutionLeases.id, prompt.leaseId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !lease ||
    lease.companyId !== prompt.companyId ||
    lease.taskId !== prompt.taskId ||
    lease.runId !== prompt.runId ||
    lease.attemptId !== prompt.attemptId ||
    lease.leaseGeneration !== prompt.leaseGeneration ||
    lease.state !== "active" ||
    lease.expiresAt <= now
  ) {
    reject("ACP update does not belong to a live exact lease");
  }
  const capabilityRow = await transaction
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
  if (
    !capabilityRow ||
    capabilityRow.state !== "active" ||
    capabilityRow.targetSessionCorrelationId === null ||
    capabilityRow.expiresAt <= now
  ) {
    reject("ACP update arrived outside an active prompt capability");
  }
  exactCapability(capabilityRow, prompt, capability);

  const owner = await transaction
    .select({
      attemptId: taskExecutionRunRefs.attemptId,
      capabilityConnectionId: taskExecutionRunRefs.capabilityConnectionId,
      capabilityGeneration: taskExecutionRunRefs.capabilityGeneration,
      protocolSettlementState: taskExecutionRunRefs.protocolSettlementState,
    })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.runId, prompt.runId),
        eq(taskExecutionRunRefs.refId, prompt.refId),
        eq(taskExecutionRunRefs.refOrdinal, prompt.refOrdinal),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !owner ||
    owner.attemptId !== prompt.attemptId ||
    owner.capabilityConnectionId !== capability.capabilityConnectionId ||
    owner.capabilityGeneration !== capability.capabilityGeneration ||
    owner.protocolSettlementState !== null
  ) {
    reject("ACP update crossed its current ref owner");
  }
  return capabilityRow;
}

export interface PromptPublication {
  readonly assistantMessageId: string;
  readonly timestamp: Date;
  nextSourceOrdinal: number;
  publish(
    type: Parameters<typeof publishTaskSessionEventInTx>[1]["event"]["type"],
    data: Record<string, unknown>,
    companions?: TaskSessionPublicationCompanions,
  ): Promise<string>;
}
