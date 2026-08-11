import type { TaskExecutionRunProgressPhase } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

export const TASK_EXECUTION_RUN_PROGRESS_TTL_MS = 90_000;
export const MAX_TASK_EXECUTION_RUN_PROGRESS_MESSAGE_CHARS = 180;
export const MAX_TASK_EXECUTION_RUN_PROGRESS_TOOL_NAME_CHARS = 80;
export const MAX_TASK_EXECUTION_RUN_PROGRESS_ASSISTANT_SNIPPET_CHARS = 220;

export interface TaskExecutionRunProgress {
  companyId: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  phase: TaskExecutionRunProgressPhase;
  message: string;
  updatedAt: Date;
  currentToolName: string | null;
  lastAssistantSnippet: string | null;
  lastEventAt: Date | null;
}

const runtimeStatusesByRunId = new Map<string, TaskExecutionRunProgress>();

function cloneStatus(status: TaskExecutionRunProgress): TaskExecutionRunProgress {
  return {
    ...status,
    updatedAt: new Date(status.updatedAt),
    lastEventAt: status.lastEventAt ? new Date(status.lastEventAt) : null,
  };
}

function sanitizeRuntimeStatusText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const redacted = redactSensitiveText(normalized);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars - 3)}...`;
}

export function sanitizeTaskExecutionRunProgressMessage(message: string): string {
  return sanitizeRuntimeStatusText(message, MAX_TASK_EXECUTION_RUN_PROGRESS_MESSAGE_CHARS);
}

export function sanitizeTaskExecutionRunProgressToolName(toolName: string): string {
  return sanitizeRuntimeStatusText(toolName, MAX_TASK_EXECUTION_RUN_PROGRESS_TOOL_NAME_CHARS);
}

export function sanitizeTaskExecutionRunProgressAssistantSnippet(snippet: string): string {
  return sanitizeRuntimeStatusText(snippet, MAX_TASK_EXECUTION_RUN_PROGRESS_ASSISTANT_SNIPPET_CHARS);
}

function isExpired(status: TaskExecutionRunProgress, now: Date, ttlMs: number) {
  return now.getTime() - status.updatedAt.getTime() > ttlMs;
}

export function setTaskExecutionRunProgress(
  input: Omit<
    TaskExecutionRunProgress,
    "message" | "updatedAt" | "currentToolName" | "lastAssistantSnippet" | "lastEventAt"
  > & {
    message: string;
    updatedAt?: Date;
    currentToolName?: string | null;
    lastAssistantSnippet?: string | null;
    lastEventAt?: Date | null;
  },
): TaskExecutionRunProgress | null {
  const message = sanitizeTaskExecutionRunProgressMessage(input.message);
  if (!message) {
    clearTaskExecutionRunProgress(input.runId);
    return null;
  }

  const status: TaskExecutionRunProgress = {
    companyId: input.companyId,
    taskId: input.taskId,
    agentId: input.agentId,
    runId: input.runId,
    phase: input.phase,
    message,
    updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    currentToolName: input.currentToolName
      ? sanitizeTaskExecutionRunProgressToolName(input.currentToolName)
      : null,
    lastAssistantSnippet: input.lastAssistantSnippet
      ? sanitizeTaskExecutionRunProgressAssistantSnippet(input.lastAssistantSnippet)
      : null,
    lastEventAt: input.lastEventAt ? new Date(input.lastEventAt) : null,
  };
  runtimeStatusesByRunId.set(status.runId, status);
  return cloneStatus(status);
}

/**
 * Refresh the activity timestamps of an existing runtime status without
 * discarding its message/tool context, so streamed run-log output keeps the
 * "Working... / X ago" line fresh between structured events. When no live
 * status exists (first output, or the previous one expired past the TTL), a
 * fallback `run_activity` status is created instead.
 */
export function touchTaskExecutionRunProgress(input: {
  companyId: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  at?: Date;
  fallbackPhase?: TaskExecutionRunProgressPhase;
  fallbackMessage?: string;
}): TaskExecutionRunProgress | null {
  const at = input.at ?? new Date();
  const existing = runtimeStatusesByRunId.get(input.runId);
  if (
    existing &&
    !isExpired(existing, at, TASK_EXECUTION_RUN_PROGRESS_TTL_MS) &&
    existing.companyId === input.companyId &&
    existing.agentId === input.agentId
  ) {
    if (at.getTime() > existing.updatedAt.getTime()) {
      existing.updatedAt = new Date(at);
    }
    if (!existing.lastEventAt || at.getTime() > existing.lastEventAt.getTime()) {
      existing.lastEventAt = new Date(at);
    }
    return cloneStatus(existing);
  }
  return setTaskExecutionRunProgress({
    companyId: input.companyId,
    taskId: input.taskId,
    agentId: input.agentId,
    runId: input.runId,
    phase: input.fallbackPhase ?? "run_activity",
    message: input.fallbackMessage ?? "Receiving agent output",
    updatedAt: at,
    lastEventAt: at,
  });
}

export function getTaskExecutionRunProgress(
  runId: string,
  expected?: {
    companyId?: string | null;
    taskId?: string | null;
    agentId?: string | null;
    now?: Date;
    ttlMs?: number;
  },
): TaskExecutionRunProgress | null {
  const status = runtimeStatusesByRunId.get(runId);
  if (!status) return null;

  const now = expected?.now ?? new Date();
  const ttlMs = expected?.ttlMs ?? TASK_EXECUTION_RUN_PROGRESS_TTL_MS;
  if (isExpired(status, now, ttlMs)) {
    runtimeStatusesByRunId.delete(runId);
    return null;
  }

  if (expected?.companyId !== undefined && status.companyId !== expected.companyId) return null;
  if (expected?.taskId !== undefined && status.taskId !== expected.taskId) return null;
  if (expected?.agentId !== undefined && status.agentId !== expected.agentId) return null;

  return cloneStatus(status);
}

export function clearTaskExecutionRunProgress(runId: string): boolean {
  return runtimeStatusesByRunId.delete(runId);
}

export function clearAllTaskExecutionRunProgresses(): void {
  runtimeStatusesByRunId.clear();
}

export function sweepExpiredTaskExecutionRunProgresses(
  now = new Date(),
  ttlMs = TASK_EXECUTION_RUN_PROGRESS_TTL_MS,
): number {
  let swept = 0;
  for (const [runId, status] of runtimeStatusesByRunId) {
    if (!isExpired(status, now, ttlMs)) continue;
    runtimeStatusesByRunId.delete(runId);
    swept += 1;
  }
  return swept;
}
