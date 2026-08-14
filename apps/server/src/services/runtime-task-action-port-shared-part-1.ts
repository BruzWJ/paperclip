import {
  taskExecutionAuthorities,
  taskSessionContextEpochs,
  taskSessions,
  tasks,
  type agents,
  type companies,
  type taskExecutionRefs,
} from "@paperclipai/db";
import { type AgentVisibleTaskStatus } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { TaskExecutionWorkspaceReservationRejected } from "./execution-workspaces.js";
import { type PaperclipMessageActor, type PaperclipMessageAgent } from "./paperclip-agent-message.js";
import type { AgentRunManagedActionInvocation } from "./paperclip-managed-tool-router.js";
import { type RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import type {
  CanonicalCreatorFormAuthority,
  CanonicalOwnerFormAuthority,
} from "./runtime-task-action-port-shared-part-4.js";
import type { TaskExecutionCancellationService } from "./task-execution-cancellation.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export const STATUSES = new Set<AgentVisibleTaskStatus>(["open", "blocked", "done", "cancelled"]);

export type RuntimeTaskOwnerChoice = { kind: "self" } | { kind: "agent"; agentId: string };

export type AgentRunCapability = AgentRunManagedActionInvocation["authority"]["capability"];

export type AgentRunMentionCommit =
  AgentRunManagedActionInvocation["authority"]["invocation"]["commitMentionAction"];

export type RuntimeTaskOwnerUpdateBase = {
  capability: AgentRunCapability;
  invocationId: string;
  message: string;
};

export type RuntimeTaskUpdateInput =
  | (RuntimeTaskOwnerUpdateBase & {
      /** Omitted targets the active task; supplied targets an exact child. */
      taskId?: string;
      status?: undefined;
      structuredResult?: never;
    })
  | (RuntimeTaskOwnerUpdateBase & {
      taskId?: string;
      status: "open" | "blocked";
      structuredResult?: never;
    })
  | (RuntimeTaskOwnerUpdateBase & {
      /** Terminal disposition is restricted to the active current-owner task. */
      taskId?: never;
      status: "done" | "cancelled";
      structuredResult?: unknown;
    });

export interface RuntimeTaskActionService {
  create(input: {
    capability: AgentRunCapability;
    invocationId: string;
    request: string;
    title?: string;
    priority?: "critical" | "high" | "medium" | "low";
    owner: RuntimeTaskOwnerChoice;
  }): Promise<unknown>;
  assign(input: {
    capability: AgentRunCapability;
    invocationId: string;
    taskId: string;
    owner: RuntimeTaskOwnerChoice;
  }): Promise<unknown>;
  update(input: RuntimeTaskUpdateInput): Promise<unknown>;
  mention(input: {
    capability: AgentRunCapability;
    invocationId: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction: AgentRunMentionCommit;
    targetAgentId: string;
    message: string;
  }): Promise<unknown>;
  mentionBoard(input: {
    capability: AgentRunCapability;
    invocationId: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction: AgentRunMentionCommit;
    message: string;
  }): Promise<unknown>;
  listAgents(input: {
    capability: AgentRunCapability;
    invocationId: string;
    agentId?: string;
  }): Promise<unknown>;
  agentRead(input: {
    capability: AgentRunCapability;
    invocationId: string;
    agentId: string;
  }): Promise<unknown>;
}

export class RuntimeTaskActionDenied extends Error {
  readonly code = "runtime_task_action_denied";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "RuntimeTaskActionDenied";
  }
}

export class RuntimeTaskActionConflict extends Error {
  readonly code = "runtime_task_action_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeTaskActionConflict";
  }
}

export async function withRuntimeWorkspaceReservationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw new RuntimeTaskActionConflict(error.message);
    }
    throw error;
  }
}

export type RuntimeTaskScopeCancellationPort = Pick<
  TaskExecutionCancellationService,
  "requestScopeCancellationsInTransaction" | "reconcileRequestedCancellations"
>;

export interface PostgresRuntimeTaskActionServiceOptions {
  clock?: () => Date;
  /**
   * Prepares and notifies an owner ref only after its causal action
   * transaction has committed. Retrying the action supplies the same
   * persisted ref again; the composition/dispatcher boundary owns
   * idempotent preparation and drain coalescing.
   */
  dispatchPersistedRef(refId: string): Promise<void>;
  /** Canonical transactional authority fence plus post-commit cancellation. */
  taskExecutionCancellation: RuntimeTaskScopeCancellationPort;
}

export type CompanyRow = typeof companies.$inferSelect;

export type AgentRow = typeof agents.$inferSelect;

export type TaskRow = typeof tasks.$inferSelect;

export type SessionRow = typeof taskSessions.$inferSelect;

export type RefRow = typeof taskExecutionRefs.$inferSelect;

export interface AuthorizedRuntimeAction {
  company: CompanyRow;
  companyAgents: AgentRow[];
  task: TaskRow;
  taskSession: SessionRow;
  contextGeneration: number;
  ref: RefRow;
  catalog: RuntimeInterfaceCompileInput;
}

export function messageAgent(companyAgents: readonly AgentRow[], agentId: string): PaperclipMessageAgent {
  const agent = companyAgents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new RuntimeTaskActionConflict("Canonical agent message lost its company agent identity");
  }
  return { id: agent.id, name: agent.name };
}

export function taskUpdateMessageActor(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
  authorizedRuntime: AuthorizedRuntimeAction | null,
): PaperclipMessageActor {
  switch (authority.kind) {
    case "agent-execution":
      if (!authorizedRuntime) {
        throw new RuntimeTaskActionConflict("Canonical task update lost its agent identity");
      }
      return messageAgent(authorizedRuntime.companyAgents, authority.capability.targetAgentId);
    case "system-escalation-human":
    case "user-creator-withdrawal":
    case "board":
      return { id: authority.actorUserId, name: "Paperclip Board user" };
    case "user/board":
      return { id: authority.userId, name: "Paperclip Board user" };
    case "plugin":
      return {
        id: authority.pluginInstallationId,
        name: `Paperclip plugin ${authority.pluginKey}`,
      };
    case "routine":
      return { id: authority.routineId, name: "Paperclip routine" };
    case "system":
      return {
        id: authority.sourceId,
        name: `Paperclip system ${authority.sourceKind}`,
      };
  }
}

export async function lockTaskSessionState(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<{
  task: TaskRow;
  session: SessionRow;
  contextGeneration: number;
} | null> {
  return tx
    .select({
      task: tasks,
      session: taskSessions,
      contextGeneration: taskSessionContextEpochs.generation,
    })
    .from(taskSessions)
    .innerJoin(tasks, and(eq(tasks.companyId, taskSessions.companyId), eq(tasks.id, taskSessions.taskId)))
    .innerJoin(
      taskSessionContextEpochs,
      and(
        eq(taskSessionContextEpochs.companyId, taskSessions.companyId),
        eq(taskSessionContextEpochs.taskId, taskSessions.taskId),
        eq(taskSessionContextEpochs.sessionId, taskSessions.id),
      ),
    )
    .where(and(eq(taskSessions.companyId, companyId), eq(taskSessions.taskId, taskId)))
    .for("update")
    .then((rows) => rows[0] ?? null);
}

export type AgentCounterpartTarget = {
  taskId: string;
  sessionId: string;
  ownershipEpoch: number;
  agentId: string;
  authorityId: string;
  adapterConfigRevisionId: string;
  contextGeneration: number;
};

export type TaskUpdateTarget = Pick<AgentCounterpartTarget, "taskId" | "sessionId" | "ownershipEpoch">;

export async function lockTaskUpdateTarget(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<TaskUpdateTarget> {
  const sessionState = await lockTaskSessionState(tx, companyId, taskId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeTaskActionConflict("Task-update counterpart has no receivable canonical Session");
  }
  return {
    taskId,
    sessionId: sessionState.session.id,
    ownershipEpoch: sessionState.task.ownershipEpoch,
  };
}

export async function lockAgentCounterpartTarget(
  tx: TaskSessionDbTransaction,
  companyId: string,
  authorityId: string,
): Promise<AgentCounterpartTarget> {
  const authority = await tx
    .select()
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, companyId),
        eq(taskExecutionAuthorities.id, authorityId),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!authority) {
    throw new RuntimeTaskActionConflict("Task-update counterpart has no current execution authority");
  }
  const sessionState = await lockTaskSessionState(tx, companyId, authority.taskId);
  if (
    !sessionState ||
    sessionState.session.id !== authority.sessionId ||
    sessionState.session.integrityState !== "ready"
  ) {
    throw new RuntimeTaskActionConflict("Task-update counterpart has no receivable canonical Session");
  }
  return {
    taskId: authority.taskId,
    sessionId: authority.sessionId,
    ownershipEpoch: authority.ownershipEpoch,
    agentId: authority.agentId,
    authorityId: authority.id,
    adapterConfigRevisionId: authority.auditAdapterConfigRevisionId,
    contextGeneration: sessionState.contextGeneration,
  };
}
