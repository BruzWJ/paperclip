import { randomUUID } from "node:crypto";

import {
  taskExecutionPolicySchema,
  taskExecutionStateSchema,
  type TaskExecutionPolicy,
  type TaskExecutionStage,
  type TaskExecutionStagePrincipal,
  type TaskExecutionState,
  type TaskMonitorScheduledBy,
} from "@paperclipai/shared";

import { unprocessable } from "../errors.js";

import {
  type ActorLike,
  type OwnerLike,
  CHANGES_REQUESTED_STATUS,
  COMPLETED_STATUS,
  PENDING_STATUS,
  normalizeMonitorNotes,
  redactTaskMonitorExternalRef,
} from "./task-execution-policy-part-1.js";

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
          agentId: participant.type === "agent" ? (participant.agentId ?? null) : null,
          userId: participant.type === "user" ? (participant.userId ?? null) : null,
        }))
        .filter((participant) =>
          participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId),
        );

      const dedupedParticipants: TaskExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key =
          participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
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
        serviceName: parsed.data.monitor.serviceName ?? null,
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

export function actorPrincipal(actor: ActorLike): TaskExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

export function principalsEqual(
  a: TaskExecutionStagePrincipal | null,
  b: TaskExecutionStagePrincipal | null,
): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

export function findStageById(policy: TaskExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

export function nextPendingStage(policy: TaskExecutionPolicy, state: TaskExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

export function nextPendingStageAfter(
  policy: TaskExecutionPolicy,
  completedStage: TaskExecutionStage,
  state: TaskExecutionState | null,
) {
  const completed = new Set(state?.completedStageIds ?? []);
  const completedIndex = policy.stages.findIndex((stage) => stage.id === completedStage.id);
  return policy.stages.find((stage, index) => index > completedIndex && !completed.has(stage.id)) ?? null;
}

export function selectStageParticipant(
  stage: TaskExecutionStage,
  opts?: {
    preferred?: TaskExecutionStagePrincipal | null;
    exclude?: TaskExecutionStagePrincipal | null;
  },
): TaskExecutionStagePrincipal | null {
  const participants = stage.participants.filter(
    (participant) => !principalsEqual(participant, opts?.exclude ?? null),
  );
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) =>
      principalsEqual(participant, opts.preferred ?? null),
    );
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first
    ? {
        type: first.type,
        agentId: first.agentId ?? null,
        userId: first.userId ?? null,
      }
    : null;
}

export function stageHasParticipant(
  stage: TaskExecutionStage,
  participant: TaskExecutionStagePrincipal | null,
): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

export function buildCompletedState(
  previous: TaskExecutionState | null,
  currentStage: TaskExecutionStage,
): TaskExecutionState {
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

export function buildStateWithCompletedStages(input: {
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

export function buildSkippedStageCompletedState(input: {
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

export function buildPendingState(input: {
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

export function buildChangesRequestedState(
  previous: TaskExecutionState,
  currentStage: TaskExecutionStage,
): TaskExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

export function buildPendingStagePatch(input: {
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

export function clearExecutionStatePatch(input: {
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

export function canAutoSkipPendingStage(input: {
  stage: TaskExecutionStage;
  returnOwner: TaskExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnOwner) {
    return false;
  }
  return (
    input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnOwner))
  );
}
