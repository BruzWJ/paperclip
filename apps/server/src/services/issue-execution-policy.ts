import { createHash, randomUUID } from "node:crypto";
import {
  issueExecutionDecisions,
  issueUpdates,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  IssueExecutionDecision,
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
  IssueOwnerKind,
} from "@paperclipai/shared";
import { issueExecutionPolicySchema, issueExecutionStateSchema } from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../errors.js";
import { recordNamedBoardLifecycleCommandInTransaction } from "./issue-board-lifecycle-command.js";

type OwnerLike = {
  ownerKind?: IssueOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

type IssueLike = OwnerLike & {
  boardPresentationStatus: string;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: IssueExecutionState | Record<string, unknown> | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedOwnerPatch = {
  ownerKind?: IssueOwnerKind | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
};

type TransitionInput = {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  requestedStatus?: string;
  requestedOwnerPatch: RequestedOwnerPatch;
  actor: ActorLike;
  commentBody?: string | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
};

const COMPLETED_STATUS: IssueExecutionState["status"] = "completed";
const PENDING_STATUS: IssueExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: IssueExecutionState["status"] = "changes_requested";

export function normalizeIssueExecutionPolicy(input: unknown): IssueExecutionPolicy | null {
  if (input == null) return null;
  const parsed = issueExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: IssueExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: IssueExecutionStage["participants"] = [];
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

  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;

  if (stages.length === 0 && !reviewPreset && !authorizationPolicy) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
  };
}

export function parseIssueExecutionState(input: unknown): IssueExecutionState | null {
  if (input == null) return null;
  const parsed = issueExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function ownerPrincipal(input: OwnerLike): IssueExecutionStagePrincipal | null {
  if (input.ownerKind === "agent" && input.ownerAgentId) {
    return { type: "agent", agentId: input.ownerAgentId, userId: null };
  }
  if (input.ownerKind === "user" && input.ownerUserId) {
    return { type: "user", userId: input.ownerUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): IssueExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: IssueExecutionStagePrincipal | null, b: IssueExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function findStageById(policy: IssueExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: IssueExecutionPolicy, state: IssueExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function nextPendingStageAfter(
  policy: IssueExecutionPolicy,
  completedStage: IssueExecutionStage,
  state: IssueExecutionState | null,
) {
  const completed = new Set(state?.completedStageIds ?? []);
  const completedIndex = policy.stages.findIndex((stage) => stage.id === completedStage.id);
  return policy.stages.find((stage, index) => index > completedIndex && !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: IssueExecutionStage,
  opts?: {
    preferred?: IssueExecutionStagePrincipal | null;
    exclude?: IssueExecutionStagePrincipal | null;
  },
): IssueExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function stageHasParticipant(stage: IssueExecutionStage, participant: IssueExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

function buildCompletedState(previous: IssueExecutionState | null, currentStage: IssueExecutionStage): IssueExecutionState {
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
  };
}

function buildStateWithCompletedStages(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnOwner: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
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
  };
}

function buildSkippedStageCompletedState(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnOwner: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
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
  };
}

function buildPendingState(input: {
  previous: IssueExecutionState | null;
  stage: IssueExecutionStage;
  stageIndex: number;
  participant: IssueExecutionStagePrincipal;
  returnOwner: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
}): IssueExecutionState {
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
  };
}

function buildChangesRequestedState(previous: IssueExecutionState, currentStage: IssueExecutionStage): IssueExecutionState {
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
  previous: IssueExecutionState | null;
  policy: IssueExecutionPolicy;
  stage: IssueExecutionStage;
  participant: IssueExecutionStagePrincipal;
  returnOwner: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
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
  issueStatus: string;
  requestedStatus?: string;
  returnOwner: IssueExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.issueStatus === "in_review" && input.returnOwner) {
    input.patch.status = "in_progress";
  }
}

function canAutoSkipPendingStage(input: {
  stage: IssueExecutionStage;
  returnOwner: IssueExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnOwner) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnOwner));
}

function applyIssueExecutionStageTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentOwner = ownerPrincipal(input.issue);
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
        input.issue.boardPresentationStatus === "in_review" &&
        existingState.returnOwner
      ) {
        patch.status = "in_progress";
      }
    }
    return { patch };
  }

  if (
    (input.issue.boardPresentationStatus === "done" ||
      input.issue.boardPresentationStatus === "cancelled") &&
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
      issueStatus: input.issue.boardPresentationStatus,
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
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this issue`);
    }

    if (!stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: existingState?.currentParticipant ?? null,
        exclude: existingState?.returnOwner ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          issueStatus: input.issue.boardPresentationStatus,
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
          throw unprocessable(`No eligible ${nextStage.type} participant is configured for this issue`);
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
      input.issue.boardPresentationStatus !== "in_review" ||
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
  // closing the issue must not restart the chain at the first stage (#7893).
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
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this issue`);
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

export function applyIssueExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  return applyIssueExecutionStageTransition(input);
}

type IssueExecutionPolicyActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type IssueExecutionPolicyControlResult = {
  issue: typeof issues.$inferSelect;
  decision: typeof issueExecutionDecisions.$inferSelect;
  retried: boolean;
};

function deterministicExecutionPolicyDecisionId(input: {
  companyId: string;
  issueId: string;
  idempotencyKey: string;
}) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`issue-execution-policy-decision\0${input.companyId}\0${input.issueId}\0${input.idempotencyKey}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUnchangedIssueOwnership(patch: Record<string, unknown>) {
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

export function issueExecutionPolicyPersistencePatch(patch: Record<string, unknown>) {
  assertUnchangedIssueOwnership(patch);
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
  };
}

function assertExecutionPolicyActor(actor: IssueExecutionPolicyActor) {
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

function issuePatchChangesPersistedState(
  issue: typeof issues.$inferSelect,
  patch: Record<string, unknown>,
): boolean {
  const current = issue as unknown as Record<string, unknown>;
  return Object.entries(patch).some(
    ([key, value]) => !persistedValueEqual(current[key], value),
  );
}

async function lockIssueForExecutionPolicy(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string,
  issueId: string,
) {
  await tx.execute(
    sql`select ${issues.id} from ${issues}
        where ${issues.companyId} = ${companyId}
          and ${issues.id} = ${issueId}
        for update`,
  );
  const issue = await tx
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    throw conflict("Issue changed or was removed while applying its execution policy");
  }
  return issue;
}

/**
 * The board execution-policy control plane is intentionally separate from
 * generic issue metadata mutation. It can configure policy and append stage
 * decisions, but it never owns an issue, advances its ownership epoch, writes
 * a provider message, or dispatches an execution.
 */
export function issueExecutionPolicyControlService(
  db: Db,
  options: { clock?: () => Date } = {},
) {
  const clock = options.clock ?? (() => new Date());

  return {
    async configure(input: {
      companyId: string;
      issueId: string;
      executionPolicy: unknown;
      actorUserId: string;
    }) {
      return db.transaction(async (tx) => {
        const issue = await lockIssueForExecutionPolicy(
          tx,
          input.companyId,
          input.issueId,
        );
        const normalizedPolicy = normalizeIssueExecutionPolicy(
          input.executionPolicy,
        );
        const transition = applyIssueExecutionPolicyTransition({
          issue,
          policy: normalizedPolicy,
          requestedOwnerPatch: {},
          actor: { userId: input.actorUserId },
        });
        const transitionPatch = issueExecutionPolicyPersistencePatch(
          transition.patch,
        );
        const persistencePatch = {
          executionPolicy:
            normalizedPolicy as Record<string, unknown> | null,
          ...transitionPatch,
        };
        if (!issuePatchChangesPersistedState(issue, persistencePatch)) {
          return issue;
        }
        const now = clock();
        const sourceCommandId = randomUUID();
        const updated = await tx
          .update(issues)
          .set({
            ...persistencePatch,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Issue changed while applying its execution policy");
        }
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId: input.companyId,
          affectedIssues: [
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
      issueId: string;
      outcome: IssueExecutionDecision["outcome"];
      body: string;
      reviewRequest?: IssueExecutionState["reviewRequest"] | null;
      idempotencyKey: string;
      actor: IssueExecutionPolicyActor;
    }): Promise<IssueExecutionPolicyControlResult> {
      assertExecutionPolicyActor(input.actor);
      const body = input.body.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      const decisionId = deterministicExecutionPolicyDecisionId({
        companyId: input.companyId,
        issueId: input.issueId,
        idempotencyKey,
      });

      return db.transaction(async (tx) => {
        const issue = await lockIssueForExecutionPolicy(
          tx,
          input.companyId,
          input.issueId,
        );
        const existingDecision = await tx
          .select()
          .from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.id, decisionId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingDecision) {
          if (
            existingDecision.companyId !== input.companyId ||
            existingDecision.issueId !== input.issueId ||
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
              affectedIssues: [
                { id: issue.id, ownershipEpoch: issue.ownershipEpoch },
              ],
              actorUserId: input.actor.userId,
              subtype: "execution_policy_decision",
              sourceCommandId: existingDecision.id,
              idempotencyKey,
              committedAt: existingDecision.createdAt,
            });
          }
          return {
            issue,
            decision: existingDecision,
            retried: true,
          };
        }

        if (
          issue.lifecycleStatus !== "open" &&
          issue.lifecycleStatus !== "blocked"
        ) {
          throw conflict("A terminal issue rejects execution-policy decisions");
        }
        const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
        if (!policy) {
          throw unprocessable("Issue has no execution policy to decide");
        }
        const transition = applyIssueExecutionPolicyTransition({
          issue,
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
        const nextState = parseIssueExecutionState(nextStateRaw);
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

        let terminalUpdate: typeof issueUpdates.$inferSelect | null = null;
        if (finalApproval) {
          terminalUpdate = await tx
            .select()
            .from(issueUpdates)
            .where(
              and(
                eq(issueUpdates.companyId, input.companyId),
                eq(issueUpdates.issueId, input.issueId),
                eq(issueUpdates.ownershipEpoch, issue.ownershipEpoch!),
                eq(issueUpdates.form, "owner"),
                eq(issueUpdates.status, "done"),
              ),
            )
            .orderBy(
              desc(issueUpdates.createdAt),
              desc(issueUpdates.runSequence),
              desc(issueUpdates.id),
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
          .insert(issueExecutionDecisions)
          .values({
            id: decisionId,
            companyId: input.companyId,
            issueId: input.issueId,
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

        const transitionPatch = issueExecutionPolicyPersistencePatch(
          transition.patch,
        );
        const now = clock();
        const updated = await tx
          .update(issues)
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
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
              eq(issues.ownershipEpoch, issue.ownershipEpoch!),
              inArray(issues.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict(
            "Issue lifecycle or ownership changed during its execution-policy decision",
          );
        }

        if (input.actor.userId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId: input.companyId,
            affectedIssues: [
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
          issue: updated,
          decision: insertedDecision,
          retried: false,
        };
      });
    },
  };
}
