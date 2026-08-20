import { taskCreatorEdgeReceivability } from "@paperclipai/db";
import {
  OrdinaryTaskRuntimeRejected,
  deterministicUuid,
  type CreatorEdgeRow,
  type OrdinaryTaskCreateInput,
  type OrdinaryTaskCreator,
  type TaskRow,
} from "./ordinary-task-runtime-shared-part-1.js";
import { RuntimeTaskActionConflict, RuntimeTaskActionDenied } from "./runtime-task-action-port.js";
import {
  type TaskSessionExecutionActor,
  type TaskSessionExecutionSource,
  type TaskSessionProjectedCommentAttribution,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function withOrdinaryTaskFormErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeTaskActionDenied) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    if (error instanceof RuntimeTaskActionConflict) {
      throw new OrdinaryTaskRuntimeRejected(error.message, "task_form_conflict");
    }
    throw error;
  }
}

export function exactNonBlank(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw new OrdinaryTaskRuntimeRejected(`${label} must be exact and non-blank`, `${label}_required`);
  }
  return value;
}

export function nonBlankPreservingBytes(value: string, label: string): string {
  if (!value.trim()) {
    throw new OrdinaryTaskRuntimeRejected(`${label} is required`, `${label}_required`);
  }
  return value;
}

export function creatorColumns(creator: OrdinaryTaskCreator) {
  switch (creator.kind) {
    case "user/board":
      return {
        creatorKind: creator.kind,
        creatorUserId: creator.userId,
      } as const;
    case "plugin":
      return {
        creatorKind: creator.kind,
        creatorPluginInstallationId: creator.pluginInstallationId,
        creatorPluginKey: creator.pluginKey,
        creatorCallbackKey: creator.callbackKey,
        creatorCallbackVersion: creator.callbackVersion,
      } as const;
    case "routine":
      return {
        creatorKind: creator.kind,
        creatorRoutineId: creator.routineId,
        creatorRoutineDispatchId: creator.routineDispatchId,
      } as const;
  }
}

export function projectedCommentAttribution(
  creator: OrdinaryTaskCreator,
): TaskSessionProjectedCommentAttribution {
  if (creator.kind === "user/board") {
    return {
      author: { kind: "user", userId: creator.userId },
      producingRun: null,
    };
  }
  if (creator.kind === "plugin") {
    return {
      author: {
        kind: "plugin",
        pluginInstallationId: creator.pluginInstallationId,
        pluginKey: creator.pluginKey,
      },
      producingRun: null,
    };
  }
  return {
    author: { kind: "system", source: "control" },
    producingRun: null,
  };
}

export function executionActorForOrdinaryCreator(creator: OrdinaryTaskCreator): TaskSessionExecutionActor {
  switch (creator.kind) {
    case "user/board":
      return { kind: creator.kind, userId: creator.userId };
    case "plugin":
      return {
        kind: creator.kind,
        pluginInstallationId: creator.pluginInstallationId,
        pluginKey: creator.pluginKey,
      };
    case "routine":
      return {
        kind: creator.kind,
        routineId: creator.routineId,
        routineDispatchId: creator.routineDispatchId,
      };
  }
}

export function executionSourceForOrdinaryCreate(
  input: Pick<OrdinaryTaskCreateInput, "creator" | "sourceKind">,
):
  | Extract<TaskSessionExecutionSource, { sourceKind: "task_request" }>
  | Extract<TaskSessionExecutionSource, { sourceKind: "routine_dispatch" }> {
  const sourceKind =
    input.sourceKind ?? (input.creator.kind === "routine" ? "routine_dispatch" : "task_request");
  if (sourceKind === "routine_dispatch") {
    if (input.creator.kind !== "routine") {
      throw new OrdinaryTaskRuntimeRejected(
        "Routine dispatch creation requires immutable routine provenance",
        "routine_dispatch_creator_invalid",
      );
    }
    return {
      sourceKind,
      actor: {
        kind: "routine",
        routineId: input.creator.routineId,
        routineDispatchId: input.creator.routineDispatchId,
      },
    };
  }
  return {
    sourceKind: "task_request",
    actor: executionActorForOrdinaryCreator(input.creator),
  };
}

export function creatorEndpoint(task: TaskRow): {
  endpointKind: "agent-execution" | "user/board" | "plugin" | "routine" | "system";
  endpointId: string | null;
  endpointSnapshot: Record<string, unknown>;
} {
  if (
    task.creatorKind === "agent-execution" &&
    task.creatorAuthorityId &&
    task.creatorAdapterConfigRevisionId
  ) {
    return {
      endpointKind: "agent-execution",
      endpointId: task.creatorAuthorityId,
      endpointSnapshot: {
        authorityId: task.creatorAuthorityId,
        originatingAdapterConfigRevisionId: task.creatorAdapterConfigRevisionId,
      },
    };
  }
  if (task.creatorKind === "user/board") {
    return {
      endpointKind: "user/board",
      endpointId: task.creatorUserId,
      endpointSnapshot: {
        userId: task.creatorUserId,
        recipient: "named-user",
      },
    };
  }
  if (
    task.creatorKind === "plugin" &&
    task.creatorPluginInstallationId &&
    task.creatorPluginKey &&
    task.creatorCallbackKey &&
    task.creatorCallbackVersion
  ) {
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
  }
  if (task.creatorKind === "routine" && task.creatorRoutineId && task.creatorRoutineDispatchId) {
    return {
      endpointKind: "routine",
      endpointId: task.creatorRoutineId,
      endpointSnapshot: {
        routineId: task.creatorRoutineId,
        routineDispatchId: task.creatorRoutineDispatchId,
      },
    };
  }
  if (task.creatorKind === "system" && task.creatorSystemSourceKind && task.creatorSystemSourceId) {
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
  throw new OrdinaryTaskRuntimeRejected("Task creator endpoint is incomplete", "creator_endpoint_incomplete");
}

export async function insertCreatorEdge(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
  sessionId: string,
  now: Date,
): Promise<CreatorEdgeRow> {
  const endpoint = creatorEndpoint(task);
  const edge = await tx
    .insert(taskCreatorEdgeReceivability)
    .values({
      id: deterministicUuid("creator-edge", `${task.companyId}:${task.id}:${task.ownershipEpoch}`),
      companyId: task.companyId,
      taskId: task.id,
      sessionId,
      ownershipEpoch: task.ownershipEpoch!,
      creatorKind: task.creatorKind!,
      ...endpoint,
      endpointTombstone: null,
      state: "receivable",
      terminalReason: null,
      terminalSourceKind: null,
      terminalSourceId: null,
      terminalAudit: null,
      terminalizedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!edge) {
    throw new OrdinaryTaskRuntimeRejected("Creator edge was not persisted", "creator_edge_missing");
  }
  return edge;
}
