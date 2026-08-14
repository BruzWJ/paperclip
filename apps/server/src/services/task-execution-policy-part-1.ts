import type {
  TaskExecutionDecision,
  TaskExecutionMonitorClearReason,
  TaskExecutionMonitorPolicy,
  TaskExecutionMonitorState,
  TaskExecutionPolicy,
  TaskExecutionState,
  TaskOwnerKind,
} from "@paperclipai/shared";

export type OwnerLike = {
  ownerKind?: TaskOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

export type TaskLike = OwnerLike & {
  boardPresentationStatus: string;
  executionPolicy?: TaskExecutionPolicy | Record<string, unknown> | null;
  executionState?: TaskExecutionState | Record<string, unknown> | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number | null;
  monitorNotes?: string | null;
  monitorScheduledBy?: string | null;
};

export type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

export type RequestedOwnerPatch = {
  ownerKind?: TaskOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

export type TransitionInput = {
  task: TaskLike;
  policy: TaskExecutionPolicy | null;
  previousPolicy?: TaskExecutionPolicy | null;
  requestedStatus?: string;
  requestedOwnerPatch: RequestedOwnerPatch;
  actor: ActorLike;
  commentBody?: string | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
  monitorExplicitlyUpdated?: boolean;
};

export type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<TaskExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
};

export const COMPLETED_STATUS: TaskExecutionState["status"] = "completed";

export const PENDING_STATUS: TaskExecutionState["status"] = "pending";

export const CHANGES_REQUESTED_STATUS: TaskExecutionState["status"] = "changes_requested";

export const MONITOR_INVALID_MESSAGE =
  "Monitor can only be scheduled on tasks owned by an agent in in_progress or in_review";

export const MONITOR_BOUNDS_EXHAUSTED_MESSAGE = "Monitor bounds are already exhausted";

export const REDACTED_TASK_MONITOR_EXTERNAL_REF = "[redacted]";

export function normalizeMonitorNotes(notes: string | null | undefined) {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function exactMonitorTextOrNull(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  return value.length > 0 && value.trim() === value ? value : null;
}

export function redactTaskMonitorExternalRef(value: string | null | undefined) {
  return exactMonitorTextOrNull(value) ? REDACTED_TASK_MONITOR_EXTERNAL_REF : null;
}

export function monitorMetadataFromPolicy(monitor: TaskExecutionMonitorPolicy) {
  return {
    kind: monitor.kind ?? null,
    serviceName: exactMonitorTextOrNull(monitor.serviceName),
    externalRef: redactTaskMonitorExternalRef(monitor.externalRef),
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
}

export function monitorMetadataFromState(state: TaskExecutionMonitorState | null | undefined) {
  return {
    kind: state?.kind ?? null,
    serviceName: exactMonitorTextOrNull(state?.serviceName),
    externalRef: redactTaskMonitorExternalRef(state?.externalRef),
    timeoutAt: state?.timeoutAt ?? null,
    maxAttempts: state?.maxAttempts ?? null,
    recoveryPolicy: state?.recoveryPolicy ?? null,
  };
}

export function blankExecutionState(): TaskExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnOwner: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  };
}

export function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function monitorStatesEqual(
  left: TaskExecutionMonitorState | null,
  right: TaskExecutionMonitorState | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function executionStateWithMonitor(
  stageState: TaskExecutionState | null,
  monitorState: TaskExecutionMonitorState | null,
): TaskExecutionState | null {
  if (!stageState && !monitorState) return null;
  const base = stageState ? { ...stageState } : blankExecutionState();
  return {
    ...base,
    monitor: monitorState,
  };
}

export function derivePersistedMonitorState(input: {
  task: TaskLike;
  state: TaskExecutionState | null;
  policy: TaskExecutionPolicy | null;
}): TaskExecutionMonitorState | null {
  const fromState = input.state?.monitor ?? null;
  const scheduledMonitor = input.policy?.monitor ?? null;
  const nextCheckAt =
    isoString(input.task.monitorNextCheckAt) ??
    scheduledMonitor?.nextCheckAt ??
    fromState?.nextCheckAt ??
    null;
  const lastTriggeredAt = isoString(input.task.monitorLastTriggeredAt) ?? fromState?.lastTriggeredAt ?? null;
  const attemptCount = input.task.monitorAttemptCount ?? fromState?.attemptCount ?? 0;
  const notes =
    scheduledMonitor?.notes ?? normalizeMonitorNotes(input.task.monitorNotes) ?? fromState?.notes ?? null;
  const scheduledByRaw =
    input.task.monitorScheduledBy ?? scheduledMonitor?.scheduledBy ?? fromState?.scheduledBy ?? null;
  const scheduledBy = scheduledByRaw === "owner" || scheduledByRaw === "board" ? scheduledByRaw : null;
  const metadata = scheduledMonitor
    ? monitorMetadataFromPolicy(scheduledMonitor)
    : monitorMetadataFromState(fromState);

  if (nextCheckAt) {
    return {
      status: "scheduled",
      nextCheckAt,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      clearedAt: null,
      clearReason: null,
    };
  }

  if (fromState?.status === "cleared") {
    return {
      ...fromState,
      notes,
      scheduledBy,
      attemptCount,
      lastTriggeredAt,
      ...metadata,
    };
  }

  if (fromState?.status === "triggered" || lastTriggeredAt || attemptCount > 0) {
    return {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      clearedAt: null,
      clearReason: null,
    };
  }

  return null;
}

export function buildScheduledMonitorState(
  previous: TaskExecutionMonitorState | null,
  monitor: TaskExecutionMonitorPolicy,
): TaskExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: monitor.nextCheckAt,
    lastTriggeredAt: previous?.lastTriggeredAt ?? null,
    attemptCount: previous?.attemptCount ?? 0,
    notes: monitor.notes ?? null,
    scheduledBy: monitor.scheduledBy,
    ...monitorMetadataFromPolicy(monitor),
    clearedAt: null,
    clearReason: null,
  };
}

export function buildClearedMonitorState(input: {
  previous: TaskExecutionMonitorState | null;
  clearReason: TaskExecutionMonitorClearReason;
  clearedAt: Date;
}): TaskExecutionMonitorState {
  return {
    status: "cleared",
    nextCheckAt: null,
    lastTriggeredAt: input.previous?.lastTriggeredAt ?? null,
    attemptCount: input.previous?.attemptCount ?? 0,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    clearedAt: input.clearedAt.toISOString(),
    clearReason: input.clearReason,
  };
}

export function taskAllowsMonitor(
  status: string,
  ownerKind: TaskOwnerKind | null,
  ownerAgentId: string | null,
  ownerUserId: string | null,
) {
  return (
    ownerKind === "agent" &&
    Boolean(ownerAgentId) &&
    !ownerUserId &&
    (status === "in_progress" || status === "in_review")
  );
}

export function monitorClearReasonForTask(
  status: string,
  ownerKind: TaskOwnerKind | null,
  ownerAgentId: string | null,
  ownerUserId: string | null,
): TaskExecutionMonitorClearReason | null {
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (!taskAllowsMonitor(status, ownerKind, ownerAgentId, ownerUserId)) {
    if (ownerKind !== "agent" || ownerUserId || !ownerAgentId) return "invalid_owner";
    return "invalid_status";
  }
  return null;
}

export function parseMonitorDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function exhaustedMonitorClearReason(input: {
  monitor: TaskExecutionMonitorPolicy;
  attemptCount: number;
  now: Date;
}): TaskExecutionMonitorClearReason | null {
  const timeoutAt = parseMonitorDate(input.monitor.timeoutAt ?? null);
  if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
    return "timeout_exceeded";
  }
  const maxAttempts = input.monitor.maxAttempts ?? null;
  if (maxAttempts !== null && input.attemptCount >= maxAttempts) {
    return "max_attempts_exhausted";
  }
  return null;
}

export function nextOwner(input: { task: TaskLike; requestedOwnerPatch: RequestedOwnerPatch }) {
  const ownerKind =
    input.requestedOwnerPatch.ownerKind !== undefined
      ? input.requestedOwnerPatch.ownerKind
      : (input.task.ownerKind ?? null);
  const ownerAgentId =
    input.requestedOwnerPatch.ownerAgentId !== undefined
      ? (input.requestedOwnerPatch.ownerAgentId ?? null)
      : (input.task.ownerAgentId ?? null);
  const ownerUserId =
    input.requestedOwnerPatch.ownerUserId !== undefined
      ? (input.requestedOwnerPatch.ownerUserId ?? null)
      : (input.task.ownerUserId ?? null);
  return { ownerKind, ownerAgentId, ownerUserId };
}

export function stripMonitorFromExecutionPolicy(
  policy: TaskExecutionPolicy | null,
): TaskExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  if (policy.stages.length === 0) return null;
  return {
    mode: policy.mode,
    commentRequired: policy.commentRequired,
    stages: policy.stages,
  };
}
