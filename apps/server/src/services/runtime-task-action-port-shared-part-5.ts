import { taskBoardMentions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  renderPaperclipCommentMention,
  renderPaperclipManagedAgentMessage,
  type PaperclipMessageAgent,
  type PaperclipManagedAgentMessage,
} from "./paperclip-agent-message.js";
import {
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  type AgentCounterpartTarget,
  type AgentRunCapability,
  type TaskUpdateTarget,
} from "./runtime-task-action-port-shared-part-1.js";
import type {
  CanonicalCreatorFormAuthority,
  CanonicalOwnerFormAuthority,
} from "./runtime-task-action-port-shared-part-4.js";
import { assertTargetAdapterRevision } from "./runtime-task-action-port-shared-part-3.js";
import { deterministicUuid } from "./runtime-task-action-port-shared-part-2.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  type DispatchingExecutionSourceInput,
  type TaskSessionAdmissionService,
  type TaskSessionExecutionActor,
  type TaskSessionProjectedCommentAttribution,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function creatorSourceIdentity(authority: CanonicalCreatorFormAuthority): {
  sourceKind: "agent-execution" | "user/board" | "plugin" | "routine" | "system";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: TaskSessionProjectedCommentAttribution;
} {
  switch (authority.kind) {
    case "agent-execution":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: authority.capability.taskExecutionAuthorityId,
        sourceIdentity: {
          authorityId: authority.capability.taskExecutionAuthorityId,
          agentId: authority.capability.targetAgentId,
          taskId: authority.capability.taskId,
          ownershipEpoch: authority.capability.ownershipEpoch,
          runId: authority.capability.runId,
          capabilityConnectionId: authority.capability.capabilityConnectionId,
          capabilityGeneration: authority.capability.capabilityGeneration,
        },
        runId: authority.capability.runId,
        comment: {
          author: {
            kind: "agent",
            agentId: authority.capability.targetAgentId,
          },
          producingRun: {
            runId: authority.capability.runId,
            adapterConfigRevisionId: authority.capability.adapterConfigIdentity,
          },
        },
      };
    case "user/board":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: { userId: authority.userId },
        runId: null,
        comment: {
          author: { kind: "user", userId: authority.userId },
          producingRun: null,
        },
      };
    case "plugin":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          pluginInstallationId: authority.pluginInstallationId,
          pluginKey: authority.pluginKey,
        },
        runId: null,
        comment: {
          author: {
            kind: "plugin",
            pluginInstallationId: authority.pluginInstallationId,
            pluginKey: authority.pluginKey,
          },
          producingRun: null,
        },
      };
    case "routine":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          routineId: authority.routineId,
          routineDispatchId: authority.routineDispatchId,
        },
        runId: null,
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
      };
    case "system":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          sourceKind: authority.sourceKind,
          sourceId: authority.sourceId,
        },
        runId: null,
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
      };
  }
}

export function executionActorForCapability(
  capability: AgentRunCapability,
): Extract<TaskSessionExecutionActor, { kind: "agent-execution" }> {
  const executionAuthorityId = capability.taskExecutionAuthorityId ?? capability.consultExecutionId;
  if (!executionAuthorityId) {
    throw new RuntimeTaskActionConflict("Agent harness delivery requires immutable execution authority");
  }
  return {
    kind: "agent-execution",
    agentId: capability.targetAgentId,
    authorityId: executionAuthorityId,
  };
}

export function taskUpdateActor(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): TaskSessionExecutionActor {
  switch (authority.kind) {
    case "agent-execution":
      return executionActorForCapability(authority.capability);
    case "system-escalation-human":
    case "user-creator-withdrawal":
    case "board":
      return { kind: "user/board", userId: authority.actorUserId };
    case "user/board":
      return { kind: "user/board", userId: authority.userId };
    case "plugin":
      return {
        kind: "plugin",
        pluginInstallationId: authority.pluginInstallationId,
        pluginKey: authority.pluginKey,
      };
    case "routine":
      return {
        kind: "routine",
        routineId: authority.routineId,
        routineDispatchId: authority.routineDispatchId,
      };
    case "system":
      return {
        kind: "system",
        sourceKind: authority.sourceKind,
        sourceId: authority.sourceId,
      };
  }
}

export function updateCounterpart(authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority):
  | {
      counterpartTaskId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    }
  | undefined {
  if (authority.kind !== "agent-execution" || !authority.capability.taskExecutionAuthorityId) {
    return undefined;
  }
  return {
    counterpartTaskId: authority.capability.taskId,
    counterpartAuthorityId: authority.capability.taskExecutionAuthorityId,
    counterpartOwnershipEpoch: authority.capability.ownershipEpoch,
  };
}

export function sameTaskAgentTarget(
  sourceAgentTarget: { taskId: string; agentId: string } | null | undefined,
  target: AgentCounterpartTarget,
): boolean {
  // The only self-mention dedupe key is the exact (taskId, agentId) pair.
  return sourceAgentTarget?.taskId === target.taskId && sourceAgentTarget.agentId === target.agentId;
}

export async function canDispatchAgentCounterpartTarget(
  tx: TaskSessionDbTransaction,
  companyId: string,
  target: AgentCounterpartTarget,
): Promise<boolean> {
  try {
    return (
      (await assertTargetAdapterRevision(tx, companyId, target.agentId)) === target.adapterConfigRevisionId
    );
  } catch (error) {
    if (error instanceof RuntimeTaskActionDenied) return false;
    throw error;
  }
}

export async function admitAgentTextInTransaction(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
) {
  const admission = await admitTaskExecutionInTransaction({
    sessionAdmission,
    transaction: tx,
    work: input,
  });
  if (!admission.ref || (input.comment && !admission.comment)) {
    throw new RuntimeTaskActionConflict("Canonical agent mention did not reserve its ref and comment");
  }
  return admission;
}

export type PaperclipManagedToolAdmissionInput = (
  | (Omit<Extract<DispatchingExecutionSourceInput, { sourceKind: "task_request" }>, "exactText" | "comment"> & {
      delivery: PaperclipManagedAgentMessage<"task_create">;
    })
  | (Omit<Extract<DispatchingExecutionSourceInput, { sourceKind: "task_reassignment" }>, "exactText" | "comment"> & {
      delivery: PaperclipManagedAgentMessage<"task_assign">;
    })
  | (Omit<Extract<DispatchingExecutionSourceInput, { sourceKind: "task_update" }>, "exactText" | "comment"> & {
      delivery: PaperclipManagedAgentMessage<"task_update">;
    })
  | (Omit<Extract<DispatchingExecutionSourceInput, { sourceKind: "consult_mention" }>, "exactText" | "comment"> & {
      delivery: PaperclipManagedAgentMessage<"mention_agent">;
    })
) & {
  comment: TaskSessionProjectedCommentAttribution;
  recipient: PaperclipMessageAgent;
};

export async function admitManagedAgentMessageInTransaction(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: PaperclipManagedToolAdmissionInput,
) {
  const { delivery, recipient, ...source } = input;
  if (recipient.id !== source.targetAgentId) {
    throw new RuntimeTaskActionConflict(
      "Canonical managed-tool recipient does not match its agent delivery target",
    );
  }
  const rendered = renderPaperclipManagedAgentMessage(delivery, recipient);
  return admitAgentTextInTransaction(sessionAdmission, tx, {
    ...source,
    exactText: rendered.agentText,
    comment: {
      ...source.comment,
      body: rendered.commentBody,
    },
  });
}

export async function mentionBoardInTransaction(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: {
    companyId: string;
    target: TaskUpdateTarget;
    actor: TaskSessionExecutionActor;
    comment: TaskSessionProjectedCommentAttribution;
    counterpart?: {
      counterpartTaskId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    };
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
    message: string;
  },
) {
  if (input.comment.author.kind !== "agent" || input.comment.producingRun === null) {
    throw new RuntimeTaskActionConflict("Canonical Board mention requires an agent producing run");
  }
  const counterpart = input.counterpart ?? {};
  const commentBody = renderPaperclipCommentMention({ kind: "board" }, input.message);
  const admission = await sessionAdmission.appendNonDispatchSyntheticComment(
    {
      companyId: input.companyId,
      taskId: input.target.taskId,
      sessionId: input.target.sessionId,
      sourceKind: input.sourceKind,
      projectionKind: "task_update",
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: commentBody,
      ownershipEpoch: input.target.ownershipEpoch,
      agentId: input.comment.author.agentId,
      adapterConfigRevisionId: input.comment.producingRun.adapterConfigRevisionId,
      runId: input.comment.producingRun.runId,
      actor: input.actor,
      ...counterpart,
      comment: {
        ...input.comment,
        body: commentBody,
      },
    },
    tx,
  );
  if (!admission.comment) {
    throw new RuntimeTaskActionConflict("Canonical Board mention did not reserve its comment");
  }
  const mentionId = deterministicUuid("task-board-mention", input.immutableSourceKey);
  const inserted = await tx
    .insert(taskBoardMentions)
    .values({
      id: mentionId,
      companyId: input.companyId,
      taskId: input.target.taskId,
      ownershipEpoch: input.target.ownershipEpoch,
      agentId: input.comment.author.agentId,
      runId: input.comment.producingRun.runId,
      idempotencyKey: input.immutableSourceKey,
      commentId: admission.comment.id,
    })
    .onConflictDoNothing({
      target: [taskBoardMentions.companyId, taskBoardMentions.idempotencyKey],
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  const mention =
    inserted ??
    (await tx
      .select()
      .from(taskBoardMentions)
      .where(
        and(
          eq(taskBoardMentions.companyId, input.companyId),
          eq(taskBoardMentions.idempotencyKey, input.immutableSourceKey),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null));
  if (!mention || mention.commentId !== admission.comment.id) {
    throw new RuntimeTaskActionConflict(
      "Canonical Board mention was retried with different immutable arguments",
    );
  }
  return { ...admission, boardMention: mention };
}
