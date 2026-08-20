import {
  taskComments,
  taskCreatorEdgeReceivability,
  taskExecutionRefs,
  taskSessions,
  taskUpdates,
} from "@paperclipai/db";
import { and, eq, max } from "drizzle-orm";
import { promptCapabilityGenerationIdentity } from "./prompt-capability-gateway.js";
import {
  type AgentRunCapability,
  type RuntimeTaskScopeCancellationPort,
  type TaskRow,
  RuntimeTaskActionConflict,
} from "./runtime-task-action-port-shared-part-1.js";
import {
  canonicalJson,
  deterministicUuid,
  runtimeInvocationKey,
} from "./runtime-task-action-port-shared-part-2.js";
import { type TaskSessionProjectedCommentAttribution } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function creatorEndpoint(task: TaskRow): {
  endpointKind: "agent-execution" | "user/board" | "plugin" | "routine" | "system";
  endpointId: string | null;
  endpointSnapshot: Record<string, unknown>;
} {
  switch (task.creatorKind) {
    case "agent-execution":
      if (!task.creatorAuthorityId || !task.creatorAdapterConfigRevisionId) {
        break;
      }
      return {
        endpointKind: "agent-execution",
        endpointId: task.creatorAuthorityId,
        endpointSnapshot: {
          authorityId: task.creatorAuthorityId,
          originatingAdapterConfigRevisionId: task.creatorAdapterConfigRevisionId,
        },
      };
    case "user/board":
      return {
        endpointKind: "user/board",
        endpointId: task.creatorUserId,
        endpointSnapshot: {
          userId: task.creatorUserId,
          recipient: task.creatorUserId ? "named-user" : "company-board",
        },
      };
    case "plugin":
      if (
        !task.creatorPluginInstallationId ||
        !task.creatorPluginKey ||
        !task.creatorCallbackKey ||
        !task.creatorCallbackVersion
      ) {
        break;
      }
      return {
        endpointKind: "plugin",
        endpointId: task.creatorPluginInstallationId,
        endpointSnapshot: {
          pluginInstallationId: task.creatorPluginInstallationId,
          pluginKey: task.creatorPluginKey,
          callbackKey: task.creatorCallbackKey,
          callbackVersion: task.creatorCallbackVersion,
        },
      };
    case "routine":
      if (!task.creatorRoutineId || !task.creatorRoutineDispatchId) break;
      return {
        endpointKind: "routine",
        endpointId: task.creatorRoutineId,
        endpointSnapshot: {
          routineId: task.creatorRoutineId,
          routineDispatchId: task.creatorRoutineDispatchId,
        },
      };
    case "system":
      if (!task.creatorSystemSourceKind || !task.creatorSystemSourceId) break;
      return {
        endpointKind: "system",
        endpointId: task.creatorSystemSourceId,
        endpointSnapshot: {
          sourceKind: task.creatorSystemSourceKind,
          sourceId: task.creatorSystemSourceId,
          recipient: "company-board",
        },
      };
  }
  throw new RuntimeTaskActionConflict("Task creator endpoint is incomplete");
}

export async function insertCreatorEdge(tx: TaskSessionDbTransaction, task: TaskRow, now: Date) {
  if (!task.ownershipEpoch) {
    throw new RuntimeTaskActionConflict("Task ownership epoch is missing");
  }
  const endpoint = creatorEndpoint(task);
  const rows = await tx
    .insert(taskCreatorEdgeReceivability)
    .values({
      id: deterministicUuid("creator-edge", `${task.companyId}:${task.id}:${task.ownershipEpoch}`),
      companyId: task.companyId,
      taskId: task.id,
      sessionId: await tx
        .select({ id: taskSessions.id })
        .from(taskSessions)
        .where(and(eq(taskSessions.companyId, task.companyId), eq(taskSessions.taskId, task.id)))
        .limit(1)
        .then((sessionRows) => {
          const session = sessionRows[0];
          if (!session) {
            throw new RuntimeTaskActionConflict("Canonical task Session is missing");
          }
          return session.id;
        }),
      ownershipEpoch: task.ownershipEpoch,
      creatorKind: task.creatorKind!,
      ...endpoint,
      endpointTombstone: null,
      state: "receivable",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return rows[0];
  const existing = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, task.companyId),
        eq(taskCreatorEdgeReceivability.taskId, task.id),
        eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch),
      ),
    )
    .limit(1)
    .then((existingRows) => existingRows[0] ?? null);
  if (
    !existing ||
    existing.creatorKind !== task.creatorKind ||
    existing.endpointKind !== endpoint.endpointKind ||
    existing.endpointId !== endpoint.endpointId ||
    canonicalJson(existing.endpointSnapshot) !== canonicalJson(endpoint.endpointSnapshot)
  ) {
    throw new RuntimeTaskActionConflict("Creator-edge identity conflicts with the immutable task creator");
  }
  return existing;
}

export async function nextRunUpdateSequence(
  tx: TaskSessionDbTransaction,
  companyId: string,
  runId: string,
): Promise<number> {
  const rows = await tx
    .select({ sequence: max(taskUpdates.runSequence) })
    .from(taskUpdates)
    .where(and(eq(taskUpdates.companyId, companyId), eq(taskUpdates.runId, runId)));
  return Number(rows[0]?.sequence ?? -1) + 1;
}

export async function loadUpdateRetry(
  tx: TaskSessionDbTransaction,
  companyId: string,
  gatewayInvocationId: string,
) {
  const update = await tx
    .select()
    .from(taskUpdates)
    .where(
      and(eq(taskUpdates.companyId, companyId), eq(taskUpdates.gatewayInvocationId, gatewayInvocationId)),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!update) return null;
  const comment = await tx
    .select()
    .from(taskComments)
    .where(eq(taskComments.id, update.commentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!comment) {
    throw new RuntimeTaskActionConflict("Accepted task update is missing its canonical comment");
  }
  const ref = comment.canonicalSourceId
    ? await tx
        .select()
        .from(taskExecutionRefs)
        .where(
          and(
            eq(taskExecutionRefs.companyId, companyId),
            eq(taskExecutionRefs.sessionId, comment.sessionId),
            eq(taskExecutionRefs.sourceId, comment.canonicalSourceId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  return { update, comment, ref, retried: true as const };
}

export type CanonicalCreatorFormUpdate =
  | {
      message: string;
      status?: undefined;
      structuredResult?: never;
    }
  | {
      message: string;
      status: "open" | "blocked";
      structuredResult?: never;
    };

export type CanonicalOwnerFormUpdate =
  | CanonicalCreatorFormUpdate
  | {
      message: string;
      status: "done" | "cancelled";
      structuredResult?: unknown;
    };

/**
 * A creator update always targets an exact child. It may keep that child open
 * or blocked, but terminal disposition remains current-owner authority because
 * it ends the receiving owner's execution epoch.
 */
export type CanonicalOwnerFormAuthority =
  | {
      kind: "agent-execution";
      capability: AgentRunCapability;
      invocationId: string;
    }
  | {
      /** A directly authenticated Board lifecycle action. */
      kind: "board";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
      recipient: "owner" | "creator";
    };

export type CanonicalCreatorFormAuthority =
  | {
      kind: "agent-execution";
      capability: AgentRunCapability;
      invocationId: string;
    }
  | {
      kind: "plugin";
      companyId: string;
      pluginInstallationId: string;
      pluginKey: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "routine";
      companyId: string;
      routineId: string;
      routineDispatchId: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "system";
      companyId: string;
      sourceKind: string;
      sourceId: string;
      gatewayInvocationId: string;
    };

export interface TaskFormCommitRuntimeOptions {
  clock?: () => Date;
  dispatchPersistedRef(refId: string): Promise<void>;
  taskExecutionCancellation: RuntimeTaskScopeCancellationPort;
}

export function authorityCompanyId(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): string {
  return authority.kind === "agent-execution" ? authority.capability.companyId : authority.companyId;
}

export function ownerGatewayInvocationId(authority: CanonicalOwnerFormAuthority): string {
  return authority.kind === "agent-execution"
    ? runtimeInvocationKey(
        "owner-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

export function creatorGatewayInvocationId(authority: CanonicalCreatorFormAuthority): string {
  return authority.kind === "agent-execution"
    ? runtimeInvocationKey(
        "creator-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

export function ownerSourceIdentity(authority: CanonicalOwnerFormAuthority): {
  sourceKind: "agent-execution" | "user/board";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: TaskSessionProjectedCommentAttribution;
} {
  if (authority.kind === "agent-execution") {
    return {
      sourceKind: "agent-execution",
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
  }
  return {
    sourceKind: "user/board",
    sourceAuthorityId: null,
    sourceIdentity: {
      userId: authority.actorUserId,
      authorityKind: "board",
      recipient: authority.recipient,
    },
    runId: null,
    comment: {
      author: {
        kind: "user",
        userId: authority.actorUserId,
      },
      producingRun: null,
    },
  };
}
