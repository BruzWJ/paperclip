import { taskSessionEvents } from "@paperclipai/db";

import { type TaskSessionEventType } from "@paperclipai/shared/task-session";

import { REDACTED_EVENT_VALUE, redactSensitiveText, sanitizeRecord } from "../../redaction.js";

import { type TaskSessionProjectionInput } from "./projector.js";

import { type TaskSessionSourceUserExecutionInput } from "./source-user-execution.js";

import { TaskSessionLifecycleConflict } from "./store.js";

export type EventEnvelope = Omit<
  typeof taskSessionEvents.$inferInsert,
  "id" | "sessionId" | "seq" | "type" | "data"
>;

export interface TaskSessionPublicationRedactor {
  redactText(value: string): string;
  redactValue<T>(value: T): T;
}

export interface TaskSessionDurableCandidate {
  id: string;
  sessionId: string;
  seq: number;
  type: TaskSessionEventType;
  data: unknown;
  /**
   * Event-level metadata is deliberately accepted by the runtime guard only
   * so it can fail closed with a useful lifecycle error. It is never persisted.
   */
  metadata?: Record<string, unknown>;
}

export interface TaskSessionPublicationCompanions {
  sourceUserExecution?: Omit<TaskSessionSourceUserExecutionInput, "companyId" | "taskId" | "sessionId">;
}

export interface PublishTaskSessionEventInput {
  event: TaskSessionDurableCandidate;
  envelope: EventEnvelope;
  projection?: Omit<TaskSessionProjectionInput, "eventId">;
  companions?: TaskSessionPublicationCompanions;
  redactor?: TaskSessionPublicationRedactor;
}

export const PUBLICATION_INPUT_KEYS = new Set(["event", "envelope", "projection", "companions", "redactor"]);

export const DURABLE_CANDIDATE_KEYS = new Set(["id", "sessionId", "seq", "type", "data", "metadata"]);

export const EVENT_ENVELOPE_KEYS = new Set([
  "companyId",
  "taskId",
  "runId",
  "ownershipEpoch",
  "agentId",
  "adapterConfigRevisionId",
  "sourceKind",
  "sourceId",
  "immutableSourceKey",
  "sourceRecordId",
  "sourceIdentityDigest",
  "createdAt",
]);

export const PROJECTION_KEYS = new Set(["inputBinding", "comment"]);

export const COMMENT_PROJECTION_KEYS = new Set([
  "phase",
  "sourceKind",
  "sourceId",
  "messageId",
  "steeringSegment",
  "comment",
]);

export const COMMENT_KEYS = new Set([
  "id",
  "body",
  "authorType",
  "authorAgentId",
  "authorUserId",
  "authorPluginInstallationId",
  "authorPluginKey",
  "replyToCommentId",
  "replyToProjectedEventSeq",
  "threadRootCommentId",
  "threadRootProjectedEventSeq",
  "presentation",
  "metadata",
  "sourceTrust",
]);

export const COMMENT_PHASES = new Set(["admitted", "promoted", "direct"]);

export const COMMENT_SOURCE_KINDS = new Set([
  "task_request",
  "human_comment",
  "harness_delivery",
  "system_control",
  "run_output",
  "run_progress",
  "task_update",
  "plugin_withdrawal",
]);

export const STEERING_SEGMENT_KEYS = new Set([
  "steeringTargetRunId",
  "refId",
  "refOrdinal",
  "segmentOrdinal",
]);

export const INPUT_BINDING_KEYS = new Set(["sourceRefId", "dispositionId"]);

export const PUBLICATION_COMPANION_KEYS = new Set(["sourceUserExecution"]);

export const SOURCE_USER_EXECUTION_KEYS = new Set([
  "messageId",
  "sourceAgentId",
  "providerId",
  "modelId",
  "variant",
  "createdAt",
]);

export const NUMERIC_SESSION_ACCOUNTING_KEYS = new Set(["maxOutputTokens"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys<T>(
  value: T,
  allowed: ReadonlySet<string>,
  label: string,
): asserts value is T & Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TaskSessionLifecycleConflict(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TaskSessionLifecycleConflict(`${label} contains unknown durable fields`, {
      unknownFields: unknown.sort(),
    });
  }
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskSessionLifecycleConflict(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TaskSessionLifecycleConflict(`${label} must be a string`);
  }
  return value;
}

export function requireValidDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TaskSessionLifecycleConflict(`${label} must be a valid timestamp`);
  }
  return value;
}

export function requireOptionalNonEmptyString(value: unknown, label: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  return requireNonEmptyString(value, label);
}

/**
 * Applies a literal-aware run redactor when one is available, then always
 * applies Paperclip's structural and textual secret rules recursively.
 * Dates and other non-JSON runtime values are retained for typed companions;
 * event data is separately forced through Paperclip's canonical Session codec.
 */
export function redactTaskSessionPublicationValue<T>(value: T, redactor?: TaskSessionPublicationRedactor): T {
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      const literalText = redactor ? redactor.redactText(candidate) : candidate;
      return redactSensitiveText(literalText);
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isPlainObject(candidate)) return candidate;
    return Object.fromEntries(
      Object.entries(candidate).map(([key, entry]) => {
        const secretShapedKey =
          sanitizeRecord({ [key]: "__paperclip_probe__" })[key] === REDACTED_EVENT_VALUE;
        if (!secretShapedKey) {
          if (Array.isArray(entry) && /^(commandArgs|command_?args|argv)$/i.test(key)) {
            return [key, visit(sanitizeRecord({ [key]: entry })[key])];
          }
          if (typeof entry === "string") {
            return [key, visit(sanitizeRecord({ value: entry }).value)];
          }
          return [key, visit(entry)];
        }
        // Paperclip Session `tokens` and source token counters are accounting,
        // not credentials. Every other
        // secret-shaped value—including numeric credentials—remains redacted.
        if (
          entry === null ||
          (typeof entry === "number" && NUMERIC_SESSION_ACCOUNTING_KEYS.has(key)) ||
          (key === "tokens" && isPlainObject(entry))
        ) {
          return [key, visit(entry)];
        }
        return [key, REDACTED_EVENT_VALUE];
      }),
    );
  };

  return visit(value) as T;
}
