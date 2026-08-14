import {
  agents,
  plugins,
  routines,
  systemEscalationIdentities,
  taskBoardReopenCommands,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  taskExecutionPromptCapabilities,
  taskExecutionSessions,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  type CreatorEdgeRow,
  type ReopenCreatorEndpointState,
  type SystemEscalationIdentityRow,
  type TaskRow,
  OrdinaryTaskRuntimeRejected,
} from "./ordinary-task-runtime-shared-part-1.js";
import { creatorEndpoint, insertCreatorEdge } from "./ordinary-task-runtime-shared-part-2.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function inspectCreatorEndpoint(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
): Promise<ReopenCreatorEndpointState> {
  switch (task.creatorKind) {
    case "agent-execution": {
      const authority = task.creatorAuthorityId
        ? await tx
            .select()
            .from(taskExecutionAuthorities)
            .where(
              and(
                eq(taskExecutionAuthorities.companyId, task.companyId),
                eq(taskExecutionAuthorities.id, task.creatorAuthorityId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!authority || authority.state !== "current") {
        return {
          terminalReason: "creator_execution_superseded",
          endpointTombstone: {
            authorityId: task.creatorAuthorityId,
            state: authority?.state ?? "missing",
            revocationReason: authority?.revocationReason ?? null,
            revokedAt: authority?.revokedAt ?? null,
          },
        };
      }
      const creatorAgent = await tx
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, task.companyId), eq(agents.id, authority.agentId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!creatorAgent || creatorAgent.status === "terminated") {
        return {
          terminalReason: creatorAgent ? "agent_terminated" : "agent_deleted",
          endpointTombstone: {
            authorityId: authority.id,
            agentId: authority.agentId,
            status: creatorAgent?.status ?? "deleted",
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "plugin": {
      const plugin = task.creatorPluginInstallationId
        ? await tx
            .select()
            .from(plugins)
            .where(eq(plugins.id, task.creatorPluginInstallationId))
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!plugin || plugin.pluginKey !== task.creatorPluginKey) {
        return {
          terminalReason: "plugin_uninstalled",
          endpointTombstone: {
            pluginInstallationId: task.creatorPluginInstallationId,
            pluginKey: task.creatorPluginKey,
            status: plugin?.status ?? "missing",
          },
        };
      }
      if (plugin.status === "disabled") {
        return {
          terminalReason: "plugin_disabled",
          endpointTombstone: {
            pluginInstallationId: plugin.id,
            pluginKey: plugin.pluginKey,
            status: plugin.status,
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "routine": {
      const routine = task.creatorRoutineId
        ? await tx
            .select()
            .from(routines)
            .where(and(eq(routines.companyId, task.companyId), eq(routines.id, task.creatorRoutineId)))
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!routine || routine.status === "archived") {
        return {
          terminalReason: "routine_deleted",
          endpointTombstone: {
            routineId: task.creatorRoutineId,
            status: routine?.status ?? "missing",
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "user/board":
    case "system":
      return { terminalReason: null, endpointTombstone: null };
    default:
      throw new OrdinaryTaskRuntimeRejected(
        "Task creator endpoint is incomplete",
        "creator_endpoint_incomplete",
      );
  }
}

export async function lockReopenCreatorEdge(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
): Promise<CreatorEdgeRow | null> {
  const endpoint = creatorEndpoint(task);
  const existing = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, task.companyId),
        eq(taskCreatorEdgeReceivability.taskId, task.id),
        eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch!),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    existing &&
    (existing.creatorKind !== task.creatorKind ||
      existing.endpointKind !== endpoint.endpointKind ||
      existing.endpointId !== endpoint.endpointId)
  ) {
    throw new OrdinaryTaskRuntimeRejected(
      "Creator-edge identity conflicts with the immutable task creator",
      "creator_edge_identity_conflict",
    );
  }
  return existing;
}

export async function ensureReopenCreatorEdge(
  tx: TaskSessionDbTransaction,
  input: {
    task: TaskRow;
    sessionId: string;
    existing: CreatorEdgeRow | null;
    endpointState: ReopenCreatorEndpointState;
    commandId: string;
    actorUserId: string;
    reason: string;
    now: Date;
  },
): Promise<CreatorEdgeRow> {
  const existing = input.existing;
  const endpointState = input.endpointState;
  if (existing?.state === "terminal") {
    return existing;
  }
  const terminalAudit = {
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  if (existing) {
    if (endpointState.terminalReason === null) return existing;
    const terminalized = await tx
      .update(taskCreatorEdgeReceivability)
      .set({
        state: "terminal",
        terminalReason: endpointState.terminalReason,
        terminalSourceKind: "board_reopen",
        terminalSourceId: input.commandId,
        terminalAudit,
        endpointTombstone: endpointState.endpointTombstone,
        terminalizedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskCreatorEdgeReceivability.id, existing.id),
          eq(taskCreatorEdgeReceivability.state, "receivable"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!terminalized) {
      throw new OrdinaryTaskRuntimeRejected(
        "Creator edge changed while reopening",
        "creator_edge_reopen_conflict",
      );
    }
    return terminalized;
  }

  return insertCreatorEdge(tx, input.task, input.sessionId, input.now, {
    terminalReason: endpointState.terminalReason,
    terminalSourceKind: "board_reopen",
    terminalSourceId: input.commandId,
    terminalAudit,
    endpointTombstone: endpointState.endpointTombstone,
  });
}

export function invalidSystemEscalationReopen(message: string): never {
  throw new OrdinaryTaskRuntimeRejected(message, "board_reopen_escalation_invalid");
}

export function exactSystemEscalationProvenance(
  task: TaskRow,
  identity: SystemEscalationIdentityRow,
  terminalEdge: CreatorEdgeRow,
): void {
  const source = identity.immutableSource;
  const expectedSourceKeys = [
    "contract",
    "initialCausalSourceId",
    "reason",
    "systemSource",
    "terminalCreatorEdgeId",
    "terminalSourceId",
    "terminalSourceKind",
    "triggeringRunId",
  ];
  if (
    task.creatorKind !== "system" ||
    task.creatorSystemSourceKind !== identity.systemSource ||
    task.creatorSystemSourceId !== `system-escalation:${identity.id}` ||
    task.escalatedFromAffectedTaskId !== identity.affectedTaskId ||
    task.affectedOwnershipEpoch !== identity.affectedOwnershipEpoch ||
    task.escalatedFromTriggeringRunId !== identity.triggeringRunId ||
    identity.escalationTaskId !== task.id ||
    terminalEdge.companyId !== identity.companyId ||
    terminalEdge.taskId !== identity.affectedTaskId ||
    terminalEdge.ownershipEpoch !== identity.affectedOwnershipEpoch ||
    terminalEdge.id !== identity.terminalCreatorEdgeId ||
    terminalEdge.state !== "terminal" ||
    terminalEdge.terminalReason === null ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    Object.keys(source).sort().join("\0") !== expectedSourceKeys.sort().join("\0") ||
    source.contract !== "system-escalation/v1" ||
    source.reason !== terminalEdge.terminalReason ||
    source.reason !== task.escalatedFromReason ||
    source.terminalCreatorEdgeId !== terminalEdge.id ||
    source.terminalSourceKind !== terminalEdge.terminalSourceKind ||
    source.terminalSourceId !== terminalEdge.terminalSourceId ||
    source.systemSource !== identity.systemSource ||
    source.triggeringRunId !== identity.triggeringRunId ||
    typeof source.initialCausalSourceId !== "string" ||
    source.initialCausalSourceId.trim().length === 0
  ) {
    invalidSystemEscalationReopen("Board-only reopen requires exact immutable system-escalation provenance");
  }
}

export async function lockSystemEscalationReopenIdentity(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
): Promise<SystemEscalationIdentityRow> {
  const identities = await tx
    .select()
    .from(systemEscalationIdentities)
    .where(
      and(
        eq(systemEscalationIdentities.companyId, task.companyId),
        eq(systemEscalationIdentities.escalationTaskId, task.id),
      ),
    )
    .limit(2)
    .for("update");
  if (identities.length !== 1) {
    invalidSystemEscalationReopen("Board-only reopen requires one exact system-escalation identity");
  }
  const identity = identities[0]!;
  const terminalEdges = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, identity.companyId),
        eq(taskCreatorEdgeReceivability.id, identity.terminalCreatorEdgeId),
      ),
    )
    .limit(2)
    .for("update");
  if (terminalEdges.length !== 1) {
    invalidSystemEscalationReopen("System-escalation identity lost its exact terminal creator edge");
  }
  exactSystemEscalationProvenance(task, identity, terminalEdges[0]!);
  return identity;
}

export async function applyBoardReopenContinuityFence(
  tx: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    ownershipEpoch: number;
    at: Date;
  },
): Promise<number> {
  const correlations = await tx
    .select({
      generation: taskExecutionSessions.correlationGeneration,
    })
    .from(taskExecutionSessions)
    .where(
      and(
        eq(taskExecutionSessions.companyId, input.companyId),
        eq(taskExecutionSessions.taskId, input.taskId),
        eq(taskExecutionSessions.ownershipEpoch, input.ownershipEpoch),
      ),
    )
    .for("update");
  const liveCapabilities = await tx
    .select({
      connectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
      generation: taskExecutionPromptCapabilities.capabilityGeneration,
    })
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        eq(taskExecutionPromptCapabilities.taskId, input.taskId),
        eq(taskExecutionPromptCapabilities.ownershipEpoch, input.ownershipEpoch),
        inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
      ),
    )
    .for("update");
  const priorFences = await tx
    .select({
      generation: taskBoardReopenCommands.continuityFenceGeneration,
    })
    .from(taskBoardReopenCommands)
    .where(
      and(
        eq(taskBoardReopenCommands.companyId, input.companyId),
        eq(taskBoardReopenCommands.taskId, input.taskId),
        eq(taskBoardReopenCommands.ownershipEpoch, input.ownershipEpoch),
      ),
    )
    .for("update");

  const continuityFenceGeneration =
    Math.max(0, ...correlations.map((row) => row.generation), ...priorFences.map((row) => row.generation)) +
    1;
  if (!Number.isSafeInteger(continuityFenceGeneration) || continuityFenceGeneration > 2_147_483_647) {
    throw new OrdinaryTaskRuntimeRejected(
      "Board reopen exhausted the epoch-local continuity generation",
      "board_reopen_continuity_exhausted",
    );
  }

  const revoked = await tx
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: "board_reopen_terminal_continuity_fence",
      revokedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        eq(taskExecutionPromptCapabilities.taskId, input.taskId),
        eq(taskExecutionPromptCapabilities.ownershipEpoch, input.ownershipEpoch),
        inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
      ),
    )
    .returning({
      connectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
      generation: taskExecutionPromptCapabilities.capabilityGeneration,
    });
  if (revoked.length !== liveCapabilities.length) {
    throw new OrdinaryTaskRuntimeRejected(
      "Board reopen lost a locked prompt-capability fence winner",
      "board_reopen_capability_conflict",
    );
  }
  return continuityFenceGeneration;
}
