import {
  taskComments,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionPromptSegments,
  taskExecutionRunControls,
  taskSessionMessages,
} from "@paperclipai/db";
import {
  TaskExecutionSteeringRejected,
  type RequestedTaskExecutionSteering,
  type RequestTaskExecutionSteeringInput,
  type SteerableTaskExecutionRun,
  type TaskExecutionRunEnvelope,
  type TaskExecutionSteeringRepository,
} from "./task-execution-run-service.js";
import { decodeStoredTaskSessionMessage } from "./task-session/store.js";

export interface PostgresTaskExecutionSteeringRepositoryOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly settlementTimeoutMs?: number;
  readonly settlementPollIntervalMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export type RunControlRow = typeof taskExecutionRunControls.$inferSelect;

export function reject(message: string): never {
  throw new TaskExecutionSteeringRejected(message, "invalid_request");
}

export function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

export function noPromptAttachments(prompt: unknown): prompt is {
  readonly text: string;
  readonly files?: readonly never[];
  readonly agents?: readonly never[];
} {
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return false;
  }
  const value = prompt as Record<string, unknown>;
  return (
    typeof value.text === "string" &&
    (value.files === undefined || (Array.isArray(value.files) && value.files.length === 0)) &&
    (value.agents === undefined || (Array.isArray(value.agents) && value.agents.length === 0))
  );
}

export function sourceMessageText(
  row: typeof taskSessionMessages.$inferSelect,
): { readonly kind: "user" | "synthetic"; readonly text: string } | null {
  const message = decodeStoredTaskSessionMessage(row);
  if (message.type === "user") {
    if (
      (message.files !== undefined && message.files.length !== 0) ||
      (message.agents !== undefined && message.agents.length !== 0)
    ) {
      return null;
    }
    return { kind: "user", text: message.text };
  }
  return message.type === "synthetic" ? { kind: "synthetic", text: message.text } : null;
}

export function terminalSteeringResult(input: {
  readonly run: Pick<
    TaskExecutionRunEnvelope,
    "companyId" | "taskId" | "runId" | "targetAgentId" | "adapterConfigRevisionId"
  >;
  readonly segment: typeof taskExecutionPromptSegments.$inferSelect;
  readonly assistant: typeof taskSessionMessages.$inferSelect | null;
}) {
  const { run, segment } = input;
  if (
    segment.protocolSettlementState === null ||
    segment.outcome === null ||
    segment.settlementVersion < 1 ||
    segment.settledAt === null
  ) {
    return null;
  }
  let response = "";
  let terminalReason: string | null = null;
  if (segment.protocolSettlementState === "settled") {
    if (!input.assistant || input.assistant.id !== segment.terminalSessionMessageId) {
      return null;
    }
    const message = decodeStoredTaskSessionMessage(input.assistant);
    if (
      message.type !== "assistant" ||
      message.time.completed === undefined ||
      input.assistant.runId !== run.runId ||
      input.assistant.agentId !== run.targetAgentId ||
      input.assistant.adapterConfigRevisionId !== run.adapterConfigRevisionId
    ) {
      return null;
    }
    response = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    terminalReason = message.finish ?? null;
  } else if (segment.terminalSessionMessageId !== null || input.assistant) {
    return null;
  }
  const outcome =
    segment.outcome === "succeeded" || segment.outcome === "refused"
      ? ("succeeded" as const)
      : segment.outcome === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);
  return Object.freeze({
    companyId: run.companyId,
    taskId: run.taskId,
    runId: run.runId,
    refId: segment.refId,
    refOrdinal: segment.refOrdinal,
    segmentOrdinal: segment.segmentOrdinal,
    outcome,
    response,
    reason:
      terminalReason ??
      (segment.protocolSettlementState === "not_sent"
        ? "Steering continuation was released before ACP transmission"
        : segment.protocolSettlementState === "incomplete"
          ? "Steering continuation ended without complete ACP settlement"
          : `Steering continuation ended with ${segment.outcome}`),
  });
}

export function activePromptMemberMatches(input: {
  readonly run: SteerableTaskExecutionRun;
  readonly control: RunControlRow;
  readonly attempt: typeof taskExecutionAttempts.$inferSelect;
  readonly lease: typeof taskExecutionLeases.$inferSelect;
}): boolean {
  const { run, control, attempt, lease } = input;
  return (
    run.currentAttemptId === attempt.id &&
    run.currentLeaseId === lease.id &&
    attempt.companyId === run.companyId &&
    attempt.taskId === run.taskId &&
    attempt.sessionId === run.sessionId &&
    attempt.runId === run.runId &&
    attempt.runKind === run.kind &&
    attempt.refId === control.currentRefId &&
    attempt.refOrdinal === control.currentOrdinal &&
    attempt.segmentOrdinal === control.currentSegmentOrdinal &&
    attempt.promptKind === (control.currentSegmentOrdinal === 0 ? "base" : "steering") &&
    attempt.state === "running" &&
    lease.companyId === run.companyId &&
    lease.taskId === run.taskId &&
    lease.runId === run.runId &&
    lease.attemptId === attempt.id &&
    lease.state === "active"
  );
}

export function actorMatchesComment(
  input: RequestTaskExecutionSteeringInput,
  comment: typeof taskComments.$inferSelect,
): boolean {
  return input.actor.kind === "user"
    ? comment.authorType === "user" && comment.authorUserId === input.actor.userId
    : comment.authorType === "agent" && comment.authorAgentId === input.actor.agentId;
}

export function requestedResult(input: {
  readonly request: RequestTaskExecutionSteeringInput;
  readonly run: SteerableTaskExecutionRun;
  readonly control: RunControlRow;
  readonly segmentOrdinal: number;
  readonly cancellationIntentId: string;
  readonly attempt: typeof taskExecutionAttempts.$inferSelect;
  readonly lease: typeof taskExecutionLeases.$inferSelect;
}): RequestedTaskExecutionSteering {
  return Object.freeze({
    companyId: input.run.companyId,
    taskId: input.run.taskId,
    ownershipEpoch: input.run.ownershipEpoch,
    runId: input.run.runId,
    targetAgentId: input.run.targetAgentId,
    refId: input.control.currentRefId!,
    refOrdinal: input.control.currentOrdinal!,
    interruptedSegmentOrdinal: input.control.currentSegmentOrdinal!,
    segmentOrdinal: input.segmentOrdinal,
    sourceCommentId: input.request.sourceCommentId,
    sourceMessageId: input.request.sourceMessageId,
    sourceInputId: input.request.sourceInputId,
    cancellationIntentId: input.cancellationIntentId,
    cancellation: Object.freeze({
      companyId: input.run.companyId,
      taskId: input.run.taskId,
      sessionId: input.run.sessionId,
      executionScopeId: input.run.executionScopeId,
      refId: input.control.currentRefId!,
      runId: input.run.runId,
      attemptId: input.attempt.id,
      leaseGeneration: input.lease.leaseGeneration,
    }),
  });
}

export function sameRequestIdentity(
  request: RequestedTaskExecutionSteering,
  input: {
    companyId: string;
    taskId: string;
    runId: string;
    refId: string;
    refOrdinal: number;
    segmentOrdinal: number;
    cancellationIntentId?: string | null;
  },
): boolean {
  return (
    request.companyId === input.companyId &&
    request.taskId === input.taskId &&
    request.runId === input.runId &&
    request.refId === input.refId &&
    request.refOrdinal === input.refOrdinal &&
    request.segmentOrdinal === input.segmentOrdinal &&
    (input.cancellationIntentId === undefined || request.cancellationIntentId === input.cancellationIntentId)
  );
}

export function boundedPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

export type CreatePostgresTaskExecutionSteeringRepositoryResult = TaskExecutionSteeringRepository;
