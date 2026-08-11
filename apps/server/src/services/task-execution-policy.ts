import { createHash, randomUUID } from "node:crypto";
import {
  taskExecutionDecisions,
  taskUpdates,
  tasks,
  type Db,
} from "@paperclipai/db";
import type {
  TaskExecutionDecision,
  TaskExecutionMonitorClearReason,
  TaskExecutionMonitorPolicy,
  TaskExecutionMonitorState,
  TaskExecutionPolicy,
  TaskExecutionStage,
  TaskExecutionStagePrincipal,
  TaskExecutionState,
  TaskMonitorScheduledBy,
  TaskOwnerKind,
} from "@paperclipai/shared";
import { taskExecutionPolicySchema, taskExecutionStateSchema } from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../errors.js";
import { recordNamedBoardLifecycleCommandInTransaction } from "./task-board-lifecycle-command.js";

type OwnerLike = {
  ownerKind?: TaskOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

type TaskLike = OwnerLike & {
  boardPresentationStatus: string;
  executionPolicy?: TaskExecutionPolicy | Record<string, unknown> | null;
  executionState?: TaskExecutionState | Record<string, unknown> | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number | null;
  monitorNotes?: string | null;
  monitorScheduledBy?: string | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedOwnerPatch = {
  ownerKind?: TaskOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

type TransitionInput = {
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

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<TaskExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
};

const COMPLETED_STATUS: TaskExecutionState["status"] = "completed";
const PENDING_STATUS: TaskExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: TaskExecutionState["status"] = "changes_requested";
const MONITOR_INVALID_MESSAGE = "Monitor can only be scheduled on tasks owned by an agent in in_progress or in_review";
const MONITOR_BOUNDS_EXHAUSTED_MESSAGE = "Monitor bounds are already exhausted";
export const REDACTED_TASK_MONITOR_EXTERNAL_REF = "[redacted]";

function normalizeMonitorNotes(notes: string | null | undefined) {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMonitorText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function redactTaskMonitorExternalRef(value: string | null | undefined) {
  return normalizeMonitorText(value) ? REDACTED_TASK_MONITOR_EXTERNAL_REF : null;
}

function monitorMetadataFromPolicy(monitor: TaskExecutionMonitorPolicy) {
  return {
    kind: monitor.kind ?? null,
    serviceName: normalizeMonitorText(monitor.serviceName),
    externalRef: redactTaskMonitorExternalRef(monitor.externalRef),
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
}

function monitorMetadataFromState(state: TaskExecutionMonitorState | null | undefined) {
  return {
    kind: state?.kind ?? null,
    serviceName: normalizeMonitorText(state?.serviceName),
    externalRef: redactTaskMonitorExternalRef(state?.externalRef),
    timeoutAt: state?.timeoutAt ?? null,
    maxAttempts: state?.maxAttempts ?? null,
    recoveryPolicy: state?.recoveryPolicy ?? null,
  };
}

function blankExecutionState(): TaskExecutionState {
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

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function monitorStatesEqual(left: TaskExecutionMonitorState | null, right: TaskExecutionMonitorState | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function executionStateWithMonitor(
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

function derivePersistedMonitorState(input: {
  task: TaskLike;
  state: TaskExecutionState | null;
  policy: TaskExecutionPolicy | null;
}): TaskExecutionMonitorState | null {
  const fromState = input.state?.monitor ?? null;
  const scheduledMonitor = input.policy?.monitor ?? null;
  const nextCheckAt = isoString(input.task.monitorNextCheckAt) ?? scheduledMonitor?.nextCheckAt ?? fromState?.nextCheckAt ?? null;
  const lastTriggeredAt = isoString(input.task.monitorLastTriggeredAt) ?? fromState?.lastTriggeredAt ?? null;
  const attemptCount = input.task.monitorAttemptCount ?? fromState?.attemptCount ?? 0;
  const notes = scheduledMonitor?.notes ?? normalizeMonitorNotes(input.task.monitorNotes) ?? fromState?.notes ?? null;
  const scheduledByRaw = input.task.monitorScheduledBy ?? scheduledMonitor?.scheduledBy ?? fromState?.scheduledBy ?? null;
  const scheduledBy =
    scheduledByRaw === "owner" || scheduledByRaw === "board" ? scheduledByRaw : null;
  const metadata = scheduledMonitor ? monitorMetadataFromPolicy(scheduledMonitor) : monitorMetadataFromState(fromState);

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

function buildScheduledMonitorState(
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

function buildClearedMonitorState(input: {
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

function taskAllowsMonitor(
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

function monitorClearReasonForTask(
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

function parseMonitorDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exhaustedMonitorClearReason(input: {
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

function nextOwner(input: {
  task: TaskLike;
  requestedOwnerPatch: RequestedOwnerPatch;
}) {
  const ownerKind = input.requestedOwnerPatch.ownerKind !== undefined
    ? input.requestedOwnerPatch.ownerKind
    : input.task.ownerKind ?? null;
  const ownerAgentId =
    input.requestedOwnerPatch.ownerAgentId !== undefined
      ? input.requestedOwnerPatch.ownerAgentId ?? null
      : input.task.ownerAgentId ?? null;
  const ownerUserId =
    input.requestedOwnerPatch.ownerUserId !== undefined
      ? input.requestedOwnerPatch.ownerUserId ?? null
      : input.task.ownerUserId ?? null;
  return { ownerKind, ownerAgentId, ownerUserId };
}

export function stripMonitorFromExecutionPolicy(policy: TaskExecutionPolicy | null): TaskExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  if (policy.stages.length === 0) return null;
  return {
    mode: policy.mode,
    commentRequired: policy.commentRequired,
    stages: policy.stages,
  };
}

export function setTaskExecutionPolicyMonitorScheduledBy(
  policy: TaskExecutionPolicy | null,
  scheduledBy: TaskMonitorScheduledBy,
): TaskExecutionPolicy | null {
  if (!policy?.monitor) return policy;
  return {
    ...policy,
    monitor: {
      ...policy.monitor,
      scheduledBy,
    },
  };
}

export function normalizeTaskExecutionPolicy(input: unknown): TaskExecutionPolicy | null {
  if (input == null) return null;
  const parsed = taskExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: TaskExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: TaskExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key = participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedParticipants.push(participant);
      }

      if (dedupedParticipants.length === 0) return null;
      return {
        id: stage.id ?? randomUUID(),
        type: stage.type,
        approvalsNeeded: 1 as const,
        participants: dedupedParticipants,
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

  const monitor = parsed.data.monitor
    ? {
      nextCheckAt: parsed.data.monitor.nextCheckAt,
      notes: normalizeMonitorNotes(parsed.data.monitor.notes),
      scheduledBy: parsed.data.monitor.scheduledBy,
      kind: parsed.data.monitor.kind ?? null,
      serviceName: normalizeMonitorText(parsed.data.monitor.serviceName),
      externalRef: redactTaskMonitorExternalRef(parsed.data.monitor.externalRef),
      timeoutAt: parsed.data.monitor.timeoutAt ?? null,
      maxAttempts: parsed.data.monitor.maxAttempts ?? null,
      recoveryPolicy: parsed.data.monitor.recoveryPolicy ?? null,
    }
    : null;

  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;

  if (stages.length === 0 && !monitor && !reviewPreset && !authorizationPolicy) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
  };
}

export function parseTaskExecutionState(input: unknown): TaskExecutionState | null {
  if (input == null) return null;
  const parsed = taskExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function ownerPrincipal(input: OwnerLike): TaskExecutionStagePrincipal | null {
  if (input.ownerKind === "agent" && input.ownerAgentId) {
    return { type: "agent", agentId: input.ownerAgentId, userId: null };
  }
  if (input.ownerKind === "user" && input.ownerUserId) {
    return { type: "user", userId: input.ownerUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): TaskExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: TaskExecutionStagePrincipal | null, b: TaskExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function findStageById(policy: TaskExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: TaskExecutionPolicy, state: TaskExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function nextPendingStageAfter(
  policy: TaskExecutionPolicy,
  completedStage: TaskExecutionStage,
  state: TaskExecutionState | null,
) {
  const completed = new Set(state?.completedStageIds ?? []);
  const completedIndex = policy.stages.findIndex((stage) => stage.id === completedStage.id);
  return policy.stages.find((stage, index) => index > completedIndex && !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: TaskExecutionStage,
  opts?: {
    preferred?: TaskExecutionStagePrincipal | null;
    exclude?: TaskExecutionStagePrincipal | null;
  },
): TaskExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function stageHasParticipant(stage: TaskExecutionStage, participant: TaskExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

function buildCompletedState(previous: TaskExecutionState | null, currentStage: TaskExecutionStage): TaskExecutionState {
  const completedStageIds = Array.from(new Set([...(previous?.completedStageIds ?? []), currentStage.id]));
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnOwner: previous?.returnOwner ?? null,
    reviewRequest: null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
    monitor: previous?.monitor ?? null,
  };
}

function buildStateWithCompletedStages(input: {
  previous: TaskExecutionState | null;
  completedStageIds: string[];
  returnOwner: TaskExecutionStagePrincipal | null;
}): TaskExecutionState {
  return {
    status: input.previous?.status ?? PENDING_STATUS,
    currentStageId: input.previous?.currentStageId ?? null,
    currentStageIndex: input.previous?.currentStageIndex ?? null,
    currentStageType: input.previous?.currentStageType ?? null,
    currentParticipant: input.previous?.currentParticipant ?? null,
    returnOwner: input.previous?.returnOwner ?? input.returnOwner,
    reviewRequest: input.previous?.reviewRequest ?? null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildSkippedStageCompletedState(input: {
  previous: TaskExecutionState | null;
  completedStageIds: string[];
  returnOwner: TaskExecutionStagePrincipal | null;
}): TaskExecutionState {
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnOwner: input.previous?.returnOwner ?? input.returnOwner,
    reviewRequest: null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildPendingState(input: {
  previous: TaskExecutionState | null;
  stage: TaskExecutionStage;
  stageIndex: number;
  participant: TaskExecutionStagePrincipal;
  returnOwner: TaskExecutionStagePrincipal | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
}): TaskExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnOwner: input.returnOwner,
    reviewRequest: input.reviewRequest ?? null,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildChangesRequestedState(previous: TaskExecutionState, currentStage: TaskExecutionStage): TaskExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

function buildPendingStagePatch(input: {
  patch: Record<string, unknown>;
  previous: TaskExecutionState | null;
  policy: TaskExecutionPolicy;
  stage: TaskExecutionStage;
  participant: TaskExecutionStagePrincipal;
  returnOwner: TaskExecutionStagePrincipal | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
}) {
  input.patch.status = "in_review";
  input.patch.executionState = buildPendingState({
    previous: input.previous,
    stage: input.stage,
    stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === input.stage.id),
    participant: input.participant,
    returnOwner: input.returnOwner,
    reviewRequest: input.reviewRequest,
  });
}

function clearExecutionStatePatch(input: {
  patch: Record<string, unknown>;
  taskStatus: string;
  requestedStatus?: string;
  returnOwner: TaskExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.taskStatus === "in_review" && input.returnOwner) {
    input.patch.status = "in_progress";
  }
}

function canAutoSkipPendingStage(input: {
  stage: TaskExecutionStage;
  returnOwner: TaskExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnOwner) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnOwner));
}

function applyTaskExecutionStageTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseTaskExecutionState(input.task.executionState);
  const currentOwner = ownerPrincipal(input.task);
  const actor = actorPrincipal(input.actor);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;
  const activeStage = currentStage && existingState?.status === PENDING_STATUS ? currentStage : null;
  const effectiveReviewRequest = input.reviewRequest === undefined
    ? existingState?.reviewRequest ?? null
    : input.reviewRequest;

  if (!input.policy) {
    if (existingState) {
      patch.executionState = null;
      if (
        input.task.boardPresentationStatus === "in_review" &&
        existingState.returnOwner
      ) {
        patch.status = "in_progress";
      }
    }
    return { patch };
  }

  if (
    (input.task.boardPresentationStatus === "done" ||
      input.task.boardPresentationStatus === "cancelled") &&
    requestedStatus &&
    requestedStatus !== "done" &&
    requestedStatus !== "cancelled"
  ) {
    patch.executionState = null;
    return { patch };
  }

  if (existingState?.currentStageId && !currentStage) {
    clearExecutionStatePatch({
      patch,
      taskStatus: input.task.boardPresentationStatus,
      requestedStatus,
      returnOwner: existingState.returnOwner,
    });
    return { patch };
  }

  if (activeStage) {
    const currentParticipant =
      existingState?.currentParticipant ??
      selectStageParticipant(activeStage, {
        exclude: existingState?.returnOwner ?? null,
      });
    if (!currentParticipant) {
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this task`);
    }

    if (!stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: existingState?.currentParticipant ?? null,
        exclude: existingState?.returnOwner ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          taskStatus: input.task.boardPresentationStatus,
          requestedStatus,
          returnOwner: existingState?.returnOwner ?? null,
        });
        return { patch };
      }

      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant,
        returnOwner: existingState?.returnOwner ?? currentOwner ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return { patch };
    }

    if (principalsEqual(currentParticipant, actor)) {
      if (requestedStatus === "done") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Approving a review or approval stage requires a comment");
        }
        const approvedState = buildCompletedState(existingState, activeStage);
        // Only stages after the stage being approved are advance candidates.
        // Scanning the whole policy could wrap back to the first stage when
        // earlier completedStageIds no longer match the policy (e.g. stage ids
        // were regenerated by a mid-flow policy edit), turning a final-stage
        // approval into an endless re-review loop (#7893).
        const nextStage = nextPendingStageAfter(input.policy, activeStage, approvedState);

        if (!nextStage) {
          patch.executionState = approvedState;
          return {
            patch,
            decision: {
              stageId: activeStage.id,
              stageType: activeStage.type,
              outcome: "approved",
              body: input.commentBody.trim(),
            },
          };
        }

        const participant = selectStageParticipant(nextStage, {
          exclude: existingState?.returnOwner ?? null,
        });
        if (!participant) {
          throw unprocessable(`No eligible ${nextStage.type} participant is configured for this task`);
        }

        buildPendingStagePatch({
          patch,
          previous: approvedState,
          policy: input.policy,
          stage: nextStage,
          participant,
          returnOwner: existingState?.returnOwner ?? currentOwner ?? actor,
          reviewRequest: input.reviewRequest ?? null,
        });
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
        };
      }

      if (requestedStatus && requestedStatus !== "in_review") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Requesting changes requires a comment");
        }
        if (!existingState?.returnOwner) {
          throw unprocessable("This execution stage has no return owner");
        }
        patch.status = "in_progress";
        patch.executionState = buildChangesRequestedState(existingState, activeStage);
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "changes_requested",
            body: input.commentBody.trim(),
          },
        };
      }
    }

    const attemptedStageAdvance =
      requestedStatus !== undefined && requestedStatus !== "in_review";
    const stageStateDrifted =
      input.task.boardPresentationStatus !== "in_review" ||
      !principalsEqual(existingState?.currentParticipant ?? null, currentParticipant);

    if (attemptedStageAdvance && !stageStateDrifted) {
      throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
    }

    if (stageStateDrifted) {
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant: currentParticipant,
        returnOwner: existingState?.returnOwner ?? currentOwner ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return { patch };
    }

    return { patch };
  }

  const shouldStartWorkflow =
    requestedStatus === "done" ||
    requestedStatus === "in_review";

  if (!shouldStartWorkflow) {
    return { patch };
  }

  // A workflow whose execution already completed is terminal for approve/done:
  // closing the task must not restart the chain at the first stage (#7893).
  if (requestedStatus === "done" && existingState?.status === COMPLETED_STATUS) {
    return { patch };
  }

  let pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnOwner = existingState?.returnOwner ?? currentOwner;
  const skippedStageIds = [...(existingState?.completedStageIds ?? [])];
  let participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? existingState.currentParticipant ?? null
        : null,
    exclude: returnOwner,
  });
  while (!participant && canAutoSkipPendingStage({ stage: pendingStage, returnOwner, requestedStatus })) {
    skippedStageIds.push(pendingStage.id);
    pendingStage = nextPendingStage(
      input.policy,
      buildStateWithCompletedStages({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnOwner,
      }),
    );
    if (!pendingStage) {
      patch.executionState = buildSkippedStageCompletedState({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnOwner,
      });
      return { patch };
    }
    participant = selectStageParticipant(pendingStage, {
      preferred:
        existingState?.status === CHANGES_REQUESTED_STATUS
          ? existingState.currentParticipant ?? null
          : null,
      exclude: returnOwner,
    });
  }
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this task`);
  }

  buildPendingStagePatch({
    patch,
    previous:
      skippedStageIds.length === (existingState?.completedStageIds ?? []).length
        ? existingState
        : buildStateWithCompletedStages({
            previous: existingState,
            completedStageIds: skippedStageIds,
            returnOwner,
          }),
    policy: input.policy,
    stage: pendingStage,
    participant,
    returnOwner,
    reviewRequest: input.reviewRequest ?? null,
  });
  return { patch };
}

function applyMonitorTransition(input: TransitionInput, stagePatch: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  const previousPolicy = input.previousPolicy ?? normalizeTaskExecutionPolicy(input.task.executionPolicy ?? null);
  const existingState = parseTaskExecutionState(input.task.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    task: input.task,
    state: existingState,
    policy: previousPolicy,
  });
  const nextStatus =
    typeof stagePatch.status === "string"
      ? (stagePatch.status as string)
      : input.requestedStatus ?? input.task.boardPresentationStatus;
  const { ownerKind, ownerAgentId, ownerUserId } = nextOwner({
    task: input.task,
    requestedOwnerPatch: input.requestedOwnerPatch,
  });
  const stageState =
    stagePatch.executionState !== undefined
      ? parseTaskExecutionState(stagePatch.executionState)
      : existingState;
  const invalidReason = input.policy?.monitor
    ? monitorClearReasonForTask(nextStatus, ownerKind, ownerAgentId, ownerUserId)
    : null;

  let targetMonitorState = currentMonitorState;

  if (input.policy?.monitor) {
    if (invalidReason) {
      if (input.monitorExplicitlyUpdated) {
        throw unprocessable(MONITOR_INVALID_MESSAGE);
      }
      patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
      patch.monitorNextCheckAt = null;
      targetMonitorState = buildClearedMonitorState({
        previous: currentMonitorState,
        clearReason: invalidReason,
        clearedAt: new Date(),
      });
    } else {
      const exhaustedReason = exhaustedMonitorClearReason({
        monitor: input.policy.monitor,
        attemptCount: currentMonitorState?.attemptCount ?? 0,
        now: new Date(),
      });
      if (exhaustedReason) {
        if (input.monitorExplicitlyUpdated) {
          throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
        }
        patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
        patch.monitorNextCheckAt = null;
        targetMonitorState = buildClearedMonitorState({
          previous: currentMonitorState,
          clearReason: exhaustedReason,
          clearedAt: new Date(),
        });
      } else {
        patch.monitorNextCheckAt = new Date(input.policy.monitor.nextCheckAt);
        patch.monitorNotes = input.policy.monitor.notes ?? null;
        patch.monitorScheduledBy = input.policy.monitor.scheduledBy;
        targetMonitorState = buildScheduledMonitorState(currentMonitorState, input.policy.monitor);
      }
    }
  } else if (previousPolicy?.monitor) {
    patch.monitorNextCheckAt = null;
    targetMonitorState = buildClearedMonitorState({
      previous: currentMonitorState,
      clearReason:
        input.monitorExplicitlyUpdated
          ? "manual"
          : monitorClearReasonForTask(nextStatus, ownerKind, ownerAgentId, ownerUserId) ?? "manual",
      clearedAt: new Date(),
    });
  }

  if (stagePatch.executionState !== undefined || !monitorStatesEqual(currentMonitorState, targetMonitorState)) {
    patch.executionState = executionStateWithMonitor(stageState, targetMonitorState);
  }

  return patch;
}

export function buildInitialTaskMonitorFields(input: {
  policy: TaskExecutionPolicy | null;
  status: string;
  ownerKind: TaskOwnerKind;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
}) {
  if (!input.policy?.monitor) return {};
  if (!taskAllowsMonitor(
    input.status,
    input.ownerKind,
    input.ownerAgentId ?? null,
    input.ownerUserId ?? null,
  )) {
    throw unprocessable(MONITOR_INVALID_MESSAGE);
  }
  const exhaustedReason = exhaustedMonitorClearReason({
    monitor: input.policy.monitor,
    attemptCount: 0,
    now: new Date(),
  });
  if (exhaustedReason) {
    throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
  }

  const monitorState = buildScheduledMonitorState(null, input.policy.monitor);
  return {
    monitorNextCheckAt: new Date(input.policy.monitor.nextCheckAt),
    monitorNotes: input.policy.monitor.notes ?? null,
    monitorScheduledBy: input.policy.monitor.scheduledBy,
    executionState: executionStateWithMonitor(null, monitorState) as Record<string, unknown> | null,
  };
}

export function applyTaskExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const stageResult = applyTaskExecutionStageTransition(input);
  const monitorPatch = applyMonitorTransition(input, stageResult.patch);
  Object.assign(stageResult.patch, monitorPatch);
  return stageResult;
}

type TaskExecutionPolicyActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type TaskExecutionPolicyControlResult = {
  task: typeof tasks.$inferSelect;
  decision: typeof taskExecutionDecisions.$inferSelect;
  retried: boolean;
};

function deterministicExecutionPolicyDecisionId(input: {
  companyId: string;
  taskId: string;
  idempotencyKey: string;
}) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`task-execution-policy-decision\0${input.companyId}\0${input.taskId}\0${input.idempotencyKey}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUnchangedTaskOwnership(patch: Record<string, unknown>) {
  const forbiddenKeys = [
    "ownerKind",
    "ownerAgentId",
    "ownerUserId",
    "ownerAssignmentSource",
    "ownershipEpoch",
  ];
  const emitted = forbiddenKeys.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (emitted.length > 0) {
    throw new Error(`Execution-policy transition attempted to mutate canonical ownership: ${emitted.join(", ")}`);
  }
}

export function taskExecutionPolicyPersistencePatch(patch: Record<string, unknown>) {
  assertUnchangedTaskOwnership(patch);
  return {
    ...(typeof patch.status === "string"
      ? {
          boardPresentationStatus: patch.status as
            | "backlog"
            | "todo"
            | "in_progress"
            | "in_review"
            | "done"
            | "blocked"
            | "cancelled",
        }
      : {}),
    ...(patch.executionPolicy !== undefined
      ? {
          executionPolicy:
            patch.executionPolicy === null
              ? null
              : patch.executionPolicy as Record<string, unknown>,
        }
      : {}),
    ...(patch.executionState !== undefined
      ? {
          executionState:
            patch.executionState === null
              ? null
              : patch.executionState as Record<string, unknown>,
        }
      : {}),
    ...(patch.monitorNextCheckAt !== undefined
      ? { monitorNextCheckAt: patch.monitorNextCheckAt as Date | null }
      : {}),
    ...(patch.monitorLastTriggeredAt !== undefined
      ? { monitorLastTriggeredAt: patch.monitorLastTriggeredAt as Date | null }
      : {}),
    ...(patch.monitorAttemptCount !== undefined
      ? { monitorAttemptCount: patch.monitorAttemptCount as number }
      : {}),
    ...(patch.monitorNotes !== undefined
      ? { monitorNotes: patch.monitorNotes as string | null }
      : {}),
    ...(patch.monitorScheduledBy !== undefined
      ? { monitorScheduledBy: patch.monitorScheduledBy as string | null }
      : {}),
  };
}

function assertExecutionPolicyActor(actor: TaskExecutionPolicyActor) {
  const hasAgent = Boolean(actor.agentId);
  const hasUser = Boolean(actor.userId);
  if (hasAgent === hasUser) {
    throw unprocessable("An execution-policy decision requires exactly one participant identity");
  }
}

function persistedValueEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (
    (left !== null && typeof left === "object") ||
    (right !== null && typeof right === "object")
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

function taskPatchChangesPersistedState(
  task: typeof tasks.$inferSelect,
  patch: Record<string, unknown>,
): boolean {
  const current = task as unknown as Record<string, unknown>;
  return Object.entries(patch).some(
    ([key, value]) => !persistedValueEqual(current[key], value),
  );
}

async function lockTaskForExecutionPolicy(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string,
  taskId: string,
) {
  await tx.execute(
    sql`select ${tasks.id} from ${tasks}
        where ${tasks.companyId} = ${companyId}
          and ${tasks.id} = ${taskId}
        for update`,
  );
  const task = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!task) {
    throw conflict("Task changed or was removed while applying its execution policy");
  }
  return task;
}

/**
 * The board execution-policy control plane is intentionally separate from
 * generic task metadata mutation. It can configure policy and append stage
 * decisions, but it never owns a task, advances its ownership epoch, writes
 * a provider message, or dispatches an execution.
 */
export function taskExecutionPolicyControlService(
  db: Db,
  options: { clock?: () => Date } = {},
) {
  const clock = options.clock ?? (() => new Date());

  return {
    async configure(input: {
      companyId: string;
      taskId: string;
      executionPolicy: unknown;
      actorUserId: string;
    }) {
      return db.transaction(async (tx) => {
        const task = await lockTaskForExecutionPolicy(
          tx,
          input.companyId,
          input.taskId,
        );
        const previousPolicy = normalizeTaskExecutionPolicy(
          task.executionPolicy,
        );
        const normalizedPolicy = setTaskExecutionPolicyMonitorScheduledBy(
          normalizeTaskExecutionPolicy(input.executionPolicy),
          "board",
        );
        const monitorChanged =
          JSON.stringify(previousPolicy?.monitor ?? null) !==
          JSON.stringify(normalizedPolicy?.monitor ?? null);
        const transition = applyTaskExecutionPolicyTransition({
          task,
          policy: normalizedPolicy,
          previousPolicy,
          requestedOwnerPatch: {},
          actor: { userId: input.actorUserId },
          monitorExplicitlyUpdated: monitorChanged,
        });
        const transitionPatch = taskExecutionPolicyPersistencePatch(
          transition.patch,
        );
        const persistencePatch = {
          executionPolicy:
            normalizedPolicy as Record<string, unknown> | null,
          ...transitionPatch,
        };
        if (!taskPatchChangesPersistedState(task, persistencePatch)) {
          return task;
        }
        const now = clock();
        const sourceCommandId = randomUUID();
        const updated = await tx
          .update(tasks)
          .set({
            ...persistencePatch,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Task changed while applying its execution policy");
        }
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId: input.companyId,
          affectedTasks: [
            { id: updated.id, ownershipEpoch: updated.ownershipEpoch },
          ],
          actorUserId: input.actorUserId,
          subtype: "execution_policy_configure",
          sourceCommandId,
          idempotencyKey: `execution-policy-configure:${sourceCommandId}`,
          committedAt: now,
        });
        return updated;
      });
    },

    async decide(input: {
      companyId: string;
      taskId: string;
      outcome: TaskExecutionDecision["outcome"];
      body: string;
      reviewRequest?: TaskExecutionState["reviewRequest"] | null;
      idempotencyKey: string;
      actor: TaskExecutionPolicyActor;
    }): Promise<TaskExecutionPolicyControlResult> {
      assertExecutionPolicyActor(input.actor);
      const body = input.body.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      const decisionId = deterministicExecutionPolicyDecisionId({
        companyId: input.companyId,
        taskId: input.taskId,
        idempotencyKey,
      });

      return db.transaction(async (tx) => {
        const task = await lockTaskForExecutionPolicy(
          tx,
          input.companyId,
          input.taskId,
        );
        const existingDecision = await tx
          .select()
          .from(taskExecutionDecisions)
          .where(eq(taskExecutionDecisions.id, decisionId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingDecision) {
          if (
            existingDecision.companyId !== input.companyId ||
            existingDecision.taskId !== input.taskId ||
            existingDecision.actorAgentId !== (input.actor.agentId ?? null) ||
            existingDecision.actorUserId !== (input.actor.userId ?? null) ||
            existingDecision.createdByRunId !== (input.actor.runId ?? null) ||
            existingDecision.outcome !== input.outcome ||
            existingDecision.body !== body
          ) {
            throw conflict(
              "Execution-policy decision idempotency key was retried with different immutable arguments",
            );
          }
          if (input.actor.userId) {
            await recordNamedBoardLifecycleCommandInTransaction(tx, {
              companyId: input.companyId,
              affectedTasks: [
                { id: task.id, ownershipEpoch: task.ownershipEpoch },
              ],
              actorUserId: input.actor.userId,
              subtype: "execution_policy_decision",
              sourceCommandId: existingDecision.id,
              idempotencyKey,
              committedAt: existingDecision.createdAt,
            });
          }
          return {
            task,
            decision: existingDecision,
            retried: true,
          };
        }

        if (
          task.lifecycleStatus !== "open" &&
          task.lifecycleStatus !== "blocked"
        ) {
          throw conflict("A terminal task rejects execution-policy decisions");
        }
        const policy = normalizeTaskExecutionPolicy(task.executionPolicy);
        if (!policy) {
          throw unprocessable("Task has no execution policy to decide");
        }
        const transition = applyTaskExecutionPolicyTransition({
          task,
          policy,
          requestedStatus:
            input.outcome === "approved" ? "done" : "in_progress",
          requestedOwnerPatch: {},
          actor: input.actor,
          commentBody: body,
          reviewRequest: input.reviewRequest,
        });
        if (
          !transition.decision ||
          transition.decision.outcome !== input.outcome
        ) {
          throw unprocessable(
            "Only the active execution-policy participant can record this decision",
          );
        }
        const nextStateRaw = transition.patch.executionState;
        if (
          !nextStateRaw ||
          typeof nextStateRaw !== "object" ||
          Array.isArray(nextStateRaw)
        ) {
          throw new Error(
            "Execution-policy decision transition is missing executionState",
          );
        }
        const nextState = parseTaskExecutionState(nextStateRaw);
        if (!nextState) {
          throw new Error(
            "Execution-policy decision transition produced invalid executionState",
          );
        }
        transition.patch.executionState = {
          ...nextState,
          lastDecisionId: decisionId,
        };
        const finalApproval =
          input.outcome === "approved" &&
          nextState.status === COMPLETED_STATUS;

        let terminalUpdate: typeof taskUpdates.$inferSelect | null = null;
        if (finalApproval) {
          terminalUpdate = await tx
            .select()
            .from(taskUpdates)
            .where(
              and(
                eq(taskUpdates.companyId, input.companyId),
                eq(taskUpdates.taskId, input.taskId),
                eq(taskUpdates.ownershipEpoch, task.ownershipEpoch!),
                eq(taskUpdates.form, "owner"),
                eq(taskUpdates.status, "done"),
              ),
            )
            .orderBy(
              desc(taskUpdates.createdAt),
              desc(taskUpdates.runSequence),
              desc(taskUpdates.id),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            !terminalUpdate?.disposition ||
            !terminalUpdate.runId
          ) {
            throw unprocessable(
              "Final approval requires a canonical current-owner done update",
            );
          }
        }

        const insertedDecision = await tx
          .insert(taskExecutionDecisions)
          .values({
            id: decisionId,
            companyId: input.companyId,
            taskId: input.taskId,
            stageId: transition.decision.stageId,
            stageType: transition.decision.stageType,
            actorAgentId: input.actor.agentId ?? null,
            actorUserId: input.actor.userId ?? null,
            outcome: transition.decision.outcome,
            body: transition.decision.body,
            createdByRunId: input.actor.runId ?? null,
            createdAt: clock(),
            updatedAt: clock(),
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!insertedDecision) {
          throw conflict("Execution-policy decision was not persisted");
        }

        const transitionPatch = taskExecutionPolicyPersistencePatch(
          transition.patch,
        );
        const now = clock();
        const updated = await tx
          .update(tasks)
          .set({
            ...transitionPatch,
            ...(finalApproval
              ? {
                  lifecycleStatus: "done" as const,
                  boardPresentationStatus: "done",
                  disposition: terminalUpdate!.disposition,
                  completedAt: now,
                  cancelledAt: null,
                }
              : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
              eq(tasks.ownershipEpoch, task.ownershipEpoch!),
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict(
            "Task lifecycle or ownership changed during its execution-policy decision",
          );
        }

        if (input.actor.userId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId: input.companyId,
            affectedTasks: [
              { id: updated.id, ownershipEpoch: updated.ownershipEpoch },
            ],
            actorUserId: input.actor.userId,
            subtype: "execution_policy_decision",
            sourceCommandId: insertedDecision.id,
            idempotencyKey,
            committedAt: insertedDecision.createdAt,
          });
        }

        return {
          task: updated,
          decision: insertedDecision,
          retried: false,
        };
      });
    },
  };
}
