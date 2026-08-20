import {
  type Db,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  taskExecutionPromptCapabilities,
  tasks,
} from "@paperclipai/db";
import { commitCreatorFormUpdateImplementation } from "./runtime-task-action-port-shared-commitCreatorFormUpdate.js";
import { commitOwnerFormUpdateImplementation } from "./runtime-task-action-port-shared-commitOwnerFormUpdate.js";
import type {
  CanonicalCreatorFormAuthority,
  CanonicalCreatorFormUpdate,
  CanonicalOwnerFormAuthority,
  CanonicalOwnerFormUpdate,
  TaskFormCommitRuntimeOptions,
} from "./runtime-task-action-port-shared-part-4.js";
import { createTaskFormCommitRuntimeContext } from "./runtime-task-action-port-shared-part-6.js";

import { type AgentRunNonAgentActionPort } from "./runtime-agent-action-port.js";
import type { AgentRunManagedActionInvocation } from "./paperclip-managed-tool-router.js";
import {
  RuntimeTaskActionConflict,
  type AgentRunCapability,
  type RuntimeTaskActionService,
  type RuntimeTaskOwnerChoice,
} from "./runtime-task-action-port-shared-part-1.js";

import { and, eq, inArray, sql } from "drizzle-orm";
import { type TaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { terminalizeCreatorEdgeInTransaction } from "./system-escalation-postgres.js";
import type {
  RequestedScopedRunCancellations,
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
} from "./task-execution-cancellation.js";

export interface OutgoingOwnershipEpochRevocation {
  readonly escalationDispatchRefIds: readonly string[];
  readonly cancellations: RequestedScopedRunCancellations;
}

export async function revokeOutgoingOwnershipEpoch(
  tx: TaskSessionDbTransaction,
  sessionAdmission: TaskSessionAdmissionService,
  taskExecutionCancellation: Pick<TaskExecutionCancellationService, "requestScopeCancellationsInTransaction">,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
    ownershipEpoch: number;
    authorityId: string;
    sourceAuthorityId: string;
    triggeringRunId?: string | null;
    cancellationActor: TaskExecutionCancellationActor;
    now: Date;
  },
): Promise<OutgoingOwnershipEpochRevocation> {
  await tx.execute(
    sql`select ${taskExecutionAuthorities.id} from ${taskExecutionAuthorities} where ${taskExecutionAuthorities.id} = ${input.authorityId} for update`,
  );
  const authority = await tx
    .select()
    .from(taskExecutionAuthorities)
    .where(eq(taskExecutionAuthorities.id, input.authorityId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !authority ||
    authority.companyId !== input.companyId ||
    authority.taskId !== input.taskId ||
    authority.sessionId !== input.sessionId ||
    authority.ownershipEpoch !== input.ownershipEpoch ||
    authority.state !== "current"
  ) {
    throw new RuntimeTaskActionConflict("Outgoing task-execution authority is missing or already revoked");
  }

  await tx
    .update(taskExecutionAuthorities)
    .set({
      state: "revoked",
      revocationReason: "ownership_epoch_advanced",
      revokedAt: input.now,
    })
    .where(eq(taskExecutionAuthorities.id, input.authorityId));
  await tx
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: "ownership_epoch_advanced",
      revokedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        eq(taskExecutionPromptCapabilities.taskId, input.taskId),
        eq(taskExecutionPromptCapabilities.ownershipEpoch, input.ownershipEpoch),
        inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
      ),
    );
  const cancellations = await taskExecutionCancellation.requestScopeCancellationsInTransaction(tx, {
    companyId: input.companyId,
    taskId: input.taskId,
    selector: {
      kind: "ownership_epoch",
      ownershipEpoch: input.ownershipEpoch,
    },
    reason: "ownership_epoch_advanced",
    actor: input.cancellationActor,
    now: input.now,
    nativeContinuity: "revoke",
  });

  const directChildren = await tx
    .select({
      id: tasks.id,
      ownershipEpoch: tasks.ownershipEpoch,
      lifecycleStatus: tasks.lifecycleStatus,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.parentId, input.taskId),
        eq(tasks.creatorKind, "agent-execution"),
        eq(tasks.creatorAuthorityId, input.authorityId),
        inArray(tasks.lifecycleStatus, ["open", "blocked"]),
      ),
    )
    .for("update");
  const dispatchRefIds: string[] = [];
  for (const child of directChildren) {
    if (!child.ownershipEpoch) continue;
    const edge = await tx
      .select()
      .from(taskCreatorEdgeReceivability)
      .where(
        and(
          eq(taskCreatorEdgeReceivability.companyId, input.companyId),
          eq(taskCreatorEdgeReceivability.taskId, child.id),
          eq(taskCreatorEdgeReceivability.ownershipEpoch, child.ownershipEpoch),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!edge) {
      throw new RuntimeTaskActionConflict(
        "Direct child lost its eager creator edge during authority revocation",
      );
    }
    const terminalized = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessionAdmission,
      {
        companyId: input.companyId,
        taskId: child.id,
        ownershipEpoch: child.ownershipEpoch,
        creatorEdgeId: edge.id,
        reason: "creator_execution_superseded",
        sourceKind: "task_reassignment",
        sourceId: input.sourceAuthorityId,
        systemSource: "recovery",
        triggeringRunId: input.triggeringRunId ?? null,
        endpointTombstone: {
          authorityId: input.authorityId,
          state: "revoked",
          reason: "ownership_epoch_advanced",
        },
        audit: {
          revokedAuthorityId: input.authorityId,
          parentTaskId: input.taskId,
          parentOwnershipEpoch: input.ownershipEpoch,
        },
      },
      () => input.now,
    );
    if (terminalized.escalation?.dispatchRefId) {
      dispatchRefIds.push(terminalized.escalation.dispatchRefId);
    }
  }
  return {
    escalationDispatchRefIds: Object.freeze(dispatchRefIds),
    cancellations,
  };
}

function ownerChoiceFromCanonical(
  ownerAgentId: string,
  capability: AgentRunCapability,
): RuntimeTaskOwnerChoice {
  return ownerAgentId === capability.targetAgentId
    ? { kind: "self" }
    : { kind: "agent", agentId: ownerAgentId };
}

function runtimeTaskUpdateTarget(command: AgentRunManagedActionInvocation<"task_update">["command"]): {
  taskId?: string;
} {
  return command.taskTarget === "explicit" ? { taskId: command.taskId } : {};
}

/** Closed adapter from normalized managed-tool commands to the transactional service. */
export function createRuntimeTaskActionPort(service: RuntimeTaskActionService): AgentRunNonAgentActionPort {
  return {
    async taskCreate(input) {
      const { command, authority } = input;
      return service.create({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        request: command.request,
        title: command.title ?? undefined,
        priority: command.priority,
        owner: ownerChoiceFromCanonical(command.ownerAgentId, authority.capability),
      });
    },

    async taskAssign(input) {
      const { command, authority } = input;
      return service.assign({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        taskId: command.taskId,
        owner: ownerChoiceFromCanonical(command.ownerAgentId, authority.capability),
      });
    },

    async taskUpdate(input) {
      const { command, authority } = input;
      const target = runtimeTaskUpdateTarget(command);
      if (command.status === undefined) {
        return service.update({
          capability: authority.capability,
          invocationId: authority.invocation.id,
          ...target,
          message: command.message,
        });
      }
      if (command.status === "done" || command.status === "cancelled") {
        if (command.taskTarget !== "active") {
          throw new RuntimeTaskActionConflict(
            "Terminal done or cancelled updates require the active-owner form",
          );
        }
        return service.update({
          capability: authority.capability,
          invocationId: authority.invocation.id,
          status: command.status,
          message: command.message,
          ...(Object.hasOwn(command, "structuredResult")
            ? { structuredResult: command.structuredResult }
            : {}),
        });
      }
      if (command.status === "open" || command.status === "blocked") {
        return service.update({
          capability: authority.capability,
          invocationId: authority.invocation.id,
          ...target,
          status: command.status,
          message: command.message,
        });
      }
      throw new RuntimeTaskActionConflict("Runtime task_update has an unsupported canonical status");
    },

    async mentionAgent(input) {
      const { command, authority } = input;
      return service.mention({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        runInterfaceToolCallId: authority.invocation.runInterfaceToolCallId,
        ingressOrdinal: authority.invocation.ingressOrdinal,
        commitMentionAction: authority.invocation.commitMentionAction,
        targetAgentId: command.agentId,
        message: command.message,
      });
    },

    async mentionBoard(input) {
      const { command, authority } = input;
      return service.mentionBoard({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        runInterfaceToolCallId: authority.invocation.runInterfaceToolCallId,
        ingressOrdinal: authority.invocation.ingressOrdinal,
        commitMentionAction: authority.invocation.commitMentionAction,
        message: command.message,
      });
    },

    async listAgents(input) {
      const { command, authority } = input;
      return service.listAgents({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        agentId: command.agentId,
      });
    },

    async agentRead(input) {
      const { command, authority } = input;
      return service.agentRead({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        agentId: command.agentId,
      });
    },
  };
}

/** Composes owner- and creator-authority form commits over one runtime context. */
export function createTaskFormCommitRuntime(db: Db, options: TaskFormCommitRuntimeOptions) {
  const context = createTaskFormCommitRuntimeContext(db, options);
  return {
    commitOwnerFormUpdate: (
      taskId: string,
      input: CanonicalOwnerFormUpdate,
      ownerAuthority: CanonicalOwnerFormAuthority,
    ) => commitOwnerFormUpdateImplementation(context, taskId, input, ownerAuthority),
    commitCreatorFormUpdate: (
      taskId: string,
      input: string | CanonicalCreatorFormUpdate,
      creatorAuthority: CanonicalCreatorFormAuthority,
    ) => commitCreatorFormUpdateImplementation(context, taskId, input, creatorAuthority),
  };
}
export * from "./runtime-task-action-port-shared-part-1.js";
export * from "./runtime-task-action-port-shared-part-2.js";
export * from "./runtime-task-action-port-shared-part-3.js";
export * from "./runtime-task-action-port-shared-part-4.js";
export * from "./runtime-task-action-port-shared-part-5.js";
export * from "./runtime-task-action-port-shared-part-6.js";
