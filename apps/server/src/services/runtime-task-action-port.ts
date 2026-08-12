import { createHash } from "node:crypto";
import {
  agentActionGrants,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  companies,
  taskComments,
  taskBoardMentions,
  taskCreateIdempotencyKeys,
  taskCreatorEdgeReceivability,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionLanes,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskSessionContextEpochs,
  taskSessionEvents,
  taskSessions,
  taskUpdates,
  tasks,
  routineRuns,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  type AgentVisibleTaskStatus,
  type PaperclipActionKey,
  type PaperclipRuntimeActionKey,
  isCanonicalUuid,
} from "@paperclipai/shared";
import { and, asc, eq, inArray, max, or, sql } from "drizzle-orm";
import {
  evaluateAgentInvokability,
  InvokableTaskOwnerRejected,
  resolveInvokableTaskOwnerInTransaction,
} from "./agent-invokability.js";
import {
  createTaskSessionAdmissionService,
  type DispatchingExecutionSourceInput,
  type TaskSessionAdmissionService,
  type TaskSessionExecutionActor,
  type TaskSessionProjectedCommentSource,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  allocateCanonicalTaskIdentityInTx,
  persistCanonicalTaskAggregateInTx,
} from "./canonical-task-aggregate.js";
import { type AgentRunNonAgentActionPort } from "./runtime-agent-action-port.js";
import type {
  AgentRunManagedActionInvocation,
} from "./paperclip-managed-tool-router.js";
import { createPostgresRuntimeInterfaceCompiler } from "./runtime-interface-compiler-db.js";
import {
  type RuntimeInterfaceCompileInput,
} from "./runtime-interface-compiler.js";
import {
  promptCapabilityGenerationIdentity,
} from "./prompt-capability-gateway.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import { terminalizeCreatorEdgeInTransaction } from "./system-escalation-postgres.js";
import type {
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
  RequestedScopedRunCancellations,
} from "./task-execution-cancellation.js";
import {
  lockTaskExecutionRunIfPresentInTransaction,
} from "./task-execution-run-service.js";
import {
  TaskConsultChainInvalid,
  lockAndValidateTaskConsultChain,
} from "./task-consult-chain-postgres.js";
import {
  activeTaskTreePauseHoldExistsSql,
  lockTaskTreeExecutionGate,
} from "./task-execution-lifecycle-gate.js";
import {
  applyTaskExecutionPolicyTransition,
  taskExecutionPolicyPersistencePatch,
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
} from "./task-execution-policy.js";
import {
  TaskExecutionWorkspaceReservationRejected,
  reserveTaskExecutionWorkspaceBinding,
} from "./execution-workspaces.js";
import {
  resolvePluginPermittedTaskOwnerCatalogInTransaction,
} from "./plugin-task-authorization.js";
import {
  paperclipEnvelopeHasBody,
  renderPaperclipManagedToolPrompt,
  type PaperclipManagedToolPrompt,
  type PaperclipMessageActor,
  type PaperclipMessageAgent,
} from "./paperclip-agent-message.js";

const STATUSES = new Set<AgentVisibleTaskStatus>([
  "open",
  "blocked",
  "done",
  "cancelled",
]);

export type RuntimeTaskOwnerChoice =
  { kind: "self" } | { kind: "agent"; agentId: string };

type AgentRunCapability =
  AgentRunManagedActionInvocation["authority"]["capability"];
type AgentRunMentionCommit =
  AgentRunManagedActionInvocation["authority"]["invocation"]["commitMentionAction"];

type RuntimeTaskOwnerUpdateBase = {
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

async function withRuntimeWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
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
  | "requestScopeCancellationsInTransaction"
  | "reconcileRequestedCancellations"
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

type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type SessionRow = typeof taskSessions.$inferSelect;
type RefRow = typeof taskExecutionRefs.$inferSelect;

interface AuthorizedRuntimeAction {
  company: CompanyRow;
  companyAgents: AgentRow[];
  task: TaskRow;
  taskSession: SessionRow;
  contextGeneration: number;
  ref: RefRow;
  catalog: RuntimeInterfaceCompileInput;
}

function messageAgent(
  companyAgents: readonly AgentRow[],
  agentId: string,
): PaperclipMessageAgent {
  const agent = companyAgents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new RuntimeTaskActionConflict(
      "Canonical agent message lost its company agent identity",
    );
  }
  return { id: agent.id, name: agent.name };
}

function taskUpdateMessageActor(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
  authorizedRuntime: AuthorizedRuntimeAction | null,
): PaperclipMessageActor {
  switch (authority.kind) {
    case "agent-execution":
      if (!authorizedRuntime) {
        throw new RuntimeTaskActionConflict(
          "Canonical task update lost its agent identity",
        );
      }
      return messageAgent(
        authorizedRuntime.companyAgents,
        authority.capability.targetAgentId,
      );
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

async function lockTaskSessionState(
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
    .innerJoin(
      tasks,
      and(
        eq(tasks.companyId, taskSessions.companyId),
        eq(tasks.id, taskSessions.taskId),
      ),
    )
    .innerJoin(
      taskSessionContextEpochs,
      and(
        eq(taskSessionContextEpochs.companyId, taskSessions.companyId),
        eq(taskSessionContextEpochs.taskId, taskSessions.taskId),
        eq(taskSessionContextEpochs.sessionId, taskSessions.id),
      ),
    )
    .where(
      and(
        eq(taskSessions.companyId, companyId),
        eq(taskSessions.taskId, taskId),
      ),
    )
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

export type TaskUpdateTarget = Pick<
  AgentCounterpartTarget,
  "taskId" | "sessionId" | "ownershipEpoch"
>;

export async function lockTaskUpdateTarget(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<TaskUpdateTarget> {
  const sessionState = await lockTaskSessionState(tx, companyId, taskId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeTaskActionConflict(
      "Task-update counterpart has no receivable canonical Session",
    );
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
    throw new RuntimeTaskActionConflict(
      "Task-update counterpart has no current execution authority",
    );
  }
  const sessionState = await lockTaskSessionState(
    tx,
    companyId,
    authority.taskId,
  );
  if (
    !sessionState ||
    sessionState.session.id !== authority.sessionId ||
    sessionState.session.integrityState !== "ready"
  ) {
    throw new RuntimeTaskActionConflict(
      "Task-update counterpart has no receivable canonical Session",
    );
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

export type TaskMentionRecipient =
  | { kind: "agent"; target: AgentCounterpartTarget }
  | { kind: "board"; target: TaskUpdateTarget };

export async function lockTaskMentionRecipient(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<TaskMentionRecipient> {
  const sessionState = await lockTaskSessionState(tx, companyId, taskId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeTaskActionConflict(
      "Mention target has no receivable canonical Session",
    );
  }
  const target = {
    taskId,
    sessionId: sessionState.session.id,
    ownershipEpoch: sessionState.task.ownershipEpoch,
  };
  if (
    sessionState.task.ownerKind !== "agent" ||
    !sessionState.task.ownerAgentId
  ) {
    return { kind: "board", target };
  }
  const authority = await tx
    .select()
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, companyId),
        eq(taskExecutionAuthorities.taskId, taskId),
        eq(
          taskExecutionAuthorities.ownershipEpoch,
          sessionState.task.ownershipEpoch,
        ),
        eq(
          taskExecutionAuthorities.agentId,
          sessionState.task.ownerAgentId,
        ),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!authority || authority.sessionId !== sessionState.session.id) {
    throw new RuntimeTaskActionConflict(
      "Mention target agent has no current task authority",
    );
  }
  return {
    kind: "agent",
    target: {
      ...target,
      agentId: authority.agentId,
      authorityId: authority.id,
      adapterConfigRevisionId: authority.auditAdapterConfigRevisionId,
      contextGeneration: sessionState.contextGeneration,
    },
  };
}

async function lockOwnerUpdateRecipient(
  tx: TaskSessionDbTransaction,
  companyId: string,
  task: TaskRow,
  creatorEdge: {
    endpointKind: string;
    endpointId: string | null;
  },
): Promise<TaskMentionRecipient> {
  if (task.parentId) {
    return lockTaskMentionRecipient(tx, companyId, task.parentId);
  }

  const sameTask = await lockTaskUpdateTarget(tx, companyId, task.id);
  if (
    creatorEdge.endpointKind === "agent-execution" &&
    creatorEdge.endpointId
  ) {
    try {
      return {
        kind: "agent",
        target: await lockAgentCounterpartTarget(
          tx,
          companyId,
          creatorEdge.endpointId,
        ),
      };
    } catch (error) {
      if (!(error instanceof RuntimeTaskActionConflict)) throw error;
    }
  }
  return { kind: "board", target: sameTask };
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function runtimeInvocationKey(
  kind:
    | "create"
    | "assign"
    | "owner-update"
    | "creator-update"
    | "mention"
    | "mention-board"
    | "list-agents",
  capabilityIdentity: string,
  invocationId: string,
): string {
  return `runtime:${kind}:${capabilityIdentity}:${invocationId}`;
}

function grantMap(rows: readonly { key: string }[]): Record<string, true> {
  return Object.fromEntries(rows.map((row) => [row.key, true]));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function terminalStatus(status: AgentVisibleTaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

function boardPresentationStatusFor(
  status: AgentVisibleTaskStatus,
): "in_progress" | "blocked" | "done" | "cancelled" {
  if (status === "open") return "in_progress";
  return status;
}

function assertLifecycleTransition(
  current: AgentVisibleTaskStatus | null,
  requested: AgentVisibleTaskStatus,
): asserts current is AgentVisibleTaskStatus {
  if (current === "done" || current === "cancelled") {
    throw new RuntimeTaskActionConflict(
      "A terminal task rejects later owner updates",
    );
  }
  const legal =
    (current === "open" &&
      (requested === "blocked" ||
        requested === "done" ||
        requested === "cancelled")) ||
    (current === "blocked" &&
      (requested === "open" ||
        requested === "done" ||
        requested === "cancelled"));
  if (!legal) {
    throw new RuntimeTaskActionConflict(
      "Task lifecycle transition is invalid",
    );
  }
}

function assertTaskNonterminal(
  task: TaskRow,
): asserts task is TaskRow & { lifecycleStatus: "open" | "blocked" } {
  if (task.lifecycleStatus !== "open" && task.lifecycleStatus !== "blocked") {
    throw new RuntimeTaskActionConflict(
      "The target task is not open or blocked",
    );
  }
}

async function lockRuntimeActionHierarchy(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
  now: Date,
  options: { readonly additionalLaneTargetAgentId?: string },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${capability.companyId}, 0))`,
  );
  const companyRows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, capability.companyId))
    .limit(2)
    .for("update");
  if (companyRows.length !== 1) {
    throw new RuntimeTaskActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
  await lockTaskTreeExecutionGate(
    tx,
    capability.companyId,
    capability.taskId,
  );
  const taskRows = await tx
    .select({
      id: tasks.id,
      lifecycleStatus: tasks.lifecycleStatus,
      executionPaused: activeTaskTreePauseHoldExistsSql(
        tasks.companyId,
        tasks.id,
      ),
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, capability.companyId),
        eq(tasks.id, capability.taskId),
      ),
    )
    .limit(2)
    .for("update");
  if (taskRows.length !== 1) {
    throw new RuntimeTaskActionDenied(
      "Task ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  const task = taskRows[0]!;
  if (!["open", "blocked"].includes(task.lifecycleStatus)) {
    throw new RuntimeTaskActionDenied(
      "Task lifecycle is terminal",
      "task_lifecycle_terminal",
    );
  }
  if (task.executionPaused) {
    throw new RuntimeTaskActionDenied(
      "Task execution is paused",
      "task_execution_paused",
    );
  }
  const sessionRows = await tx
    .select({ id: taskSessions.id })
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.companyId, capability.companyId),
        eq(taskSessions.taskId, capability.taskId),
        eq(taskSessions.id, capability.sessionId),
      ),
    )
    .limit(2)
    .for("update");
  if (sessionRows.length !== 1) {
    throw new RuntimeTaskActionDenied(
      "Task Session is not ready",
      "task_session_invalid",
    );
  }
  const companyAgents = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, capability.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const laneTargetAgentIds = [...new Set([
    capability.targetAgentId,
    ...(options.additionalLaneTargetAgentId
      ? [options.additionalLaneTargetAgentId]
      : []),
  ])].sort();
  const knownAgentIds = new Set(companyAgents.map((agent) => agent.id));
  if (laneTargetAgentIds.some((agentId) => !knownAgentIds.has(agentId))) {
    throw new RuntimeTaskActionDenied(
      "Mention target is no longer in the current reach catalog",
      "mention_catalog_changed",
    );
  }
  for (const targetAgentId of laneTargetAgentIds) {
    await tx
      .insert(taskExecutionLanes)
      .values({
        companyId: capability.companyId,
        taskId: capability.taskId,
        ownershipEpoch: capability.ownershipEpoch,
        targetAgentId,
        nextOrdinal: 0,
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          taskExecutionLanes.companyId,
          taskExecutionLanes.taskId,
          taskExecutionLanes.ownershipEpoch,
          taskExecutionLanes.targetAgentId,
        ],
      });
  }
  for (const targetAgentId of laneTargetAgentIds) {
    const laneRows = await tx
      .select({ targetAgentId: taskExecutionLanes.targetAgentId })
      .from(taskExecutionLanes)
      .where(
        and(
          eq(taskExecutionLanes.companyId, capability.companyId),
          eq(taskExecutionLanes.taskId, capability.taskId),
          eq(
            taskExecutionLanes.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(taskExecutionLanes.targetAgentId, targetAgentId),
        ),
      )
      .limit(2)
      .for("update");
    if (laneRows.length !== 1) {
      throw new RuntimeTaskActionConflict(
        "Runtime action lost its exact target-agent execution lane",
      );
    }
  }
}

async function lockRuntimeActionRun(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
): Promise<void> {
  const run = await lockTaskExecutionRunIfPresentInTransaction(tx, {
    companyId: capability.companyId,
    taskId: capability.taskId,
    runId: capability.runId,
  });
  if (
    !run ||
    run.status !== "running" ||
    run.sessionId !== capability.sessionId ||
    run.ownershipEpoch !== capability.ownershipEpoch ||
    run.targetAgentId !== capability.targetAgentId ||
    run.executionMode !== capability.executionMode ||
    run.taskExecutionAuthorityId !== capability.taskExecutionAuthorityId ||
    run.consultExecutionId !== capability.consultExecutionId ||
    run.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    run.executionWorkspaceBindingId !== capability.workspaceIdentity ||
    run.currentAttemptId !== capability.attemptId ||
    run.currentLeaseId !== capability.leaseId ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null
  ) {
    throw new RuntimeTaskActionDenied(
      "Run is no longer active in this execution scope",
      "run_scope_changed",
    );
  }
}

const PERSISTENT_GRANT_BY_RUNTIME_ACTION = {
  task_create: "task_create",
  task_assign: "task_create",
  task_update: null,
  mention_agent: null,
  mention_board: "mention_board",
  agent_hire: "agent_hire",
  agent_configure: "agent_configure",
  list_agents: null,
  agent_read: "agent_configure",
} as const satisfies Record<PaperclipRuntimeActionKey, PaperclipActionKey | null>;

function actionRemainsAvailableInCatalog(
  catalog: RuntimeInterfaceCompileInput,
  action: PaperclipRuntimeActionKey,
  persistentGrant: PaperclipActionKey | null,
): boolean {
  if (persistentGrant) {
    return catalog.actionGrants[persistentGrant] === true;
  }
  // task_update is emitted from relationship-derived authority, never a
  // stored action grant. Form-specific target validation happens at the
  // owner/creator commit boundary below.
  if (action === "task_update") {
    return (
      catalog.isCurrentOwner || catalog.creatorUpdateTargets.length > 0
    );
  }
  // mention_agent is dynamically compiled from reachable targets, not a
  // persisted action grant. The tool is only compiled when targets exist.
  if (action === "mention_agent") {
    return catalog.mentionTargets.length > 0;
  }
  // list_agents and any future null-grant actions pass through the
  // catalog check. Each handler performs its own secondary grant recheck
  // when needed.
  return true;
}

async function lockRuntimeActionAuthority(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
  action: PaperclipRuntimeActionKey,
  now: Date,
  options: {
    requireOwner: boolean;
    additionalLaneTargetAgentId?: string;
  },
): Promise<AuthorizedRuntimeAction> {
  if (options.requireOwner && capability.executionMode !== "owner") {
    throw new RuntimeTaskActionDenied(
      "This action requires an active owner execution",
      "owner_execution_required",
    );
  }

  await lockRuntimeActionHierarchy(tx, capability, now, {
    additionalLaneTargetAgentId: options.additionalLaneTargetAgentId,
  });
  // Run transitions own their attempt and lease projections. The canonical
  // hierarchy/Session lock above matches every lifecycle producer; the run
  // and capability locks below recheck the exact prompt authority.
  await lockRuntimeActionRun(tx, capability);
  try {
    await lockActivePromptCapabilityBinding(tx, capability, now);
  } catch {
    throw new RuntimeTaskActionDenied(
      "Prompt capability is inactive, expired, or no longer exact",
      "prompt_capability_invalid",
    );
  }
  await tx.execute(
    sql`select ${taskExecutionRefs.id} from ${taskExecutionRefs} where ${taskExecutionRefs.id} = ${capability.refId} for update`,
  );

  const [companyRows, companyAgents, sessionRows, refRows, taskRows] =
    await Promise.all([
      tx
        .select()
        .from(companies)
        .where(eq(companies.id, capability.companyId))
        .limit(1),
      tx
        .select()
        .from(agents)
        .where(eq(agents.companyId, capability.companyId))
        .orderBy(asc(agents.id)),
      tx
        .select({
          session: taskSessions,
          contextGeneration: taskSessionContextEpochs.generation,
        })
        .from(taskSessions)
        .innerJoin(
          taskSessionContextEpochs,
          and(
            eq(taskSessionContextEpochs.companyId, taskSessions.companyId),
            eq(taskSessionContextEpochs.taskId, taskSessions.taskId),
            eq(taskSessionContextEpochs.sessionId, taskSessions.id),
          ),
        )
        .where(eq(taskSessions.id, capability.sessionId))
        .limit(1),
      tx
        .select()
        .from(taskExecutionRefs)
        .where(eq(taskExecutionRefs.id, capability.refId))
        .limit(1),
      tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, capability.taskId))
        .limit(1),
    ]);
  const company = companyRows[0];
  const sessionState = sessionRows[0];
  const taskSession = sessionState?.session;
  const ref = refRows[0];
  const task = taskRows[0];

  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
  if (
    !taskSession ||
    taskSession.companyId !== capability.companyId ||
    taskSession.taskId !== capability.taskId ||
    taskSession.integrityState !== "ready" ||
    taskSession.refAdmittableAt === null ||
    taskSession.timeArchived !== null ||
    taskSession.purgeFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied(
      "Task Session is not ready",
      "task_session_invalid",
    );
  }
  if (
    !ref ||
    ref.companyId !== capability.companyId ||
    ref.taskId !== capability.taskId ||
    ref.sessionId !== capability.sessionId ||
    ref.mode !== capability.executionMode ||
    ref.ownershipEpoch !== capability.ownershipEpoch ||
    ref.targetAgentId !== capability.targetAgentId ||
    ref.taskExecutionAuthorityId !== capability.taskExecutionAuthorityId ||
    ref.consultExecutionId !== capability.consultExecutionId ||
    ref.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    ref.disposition !== "active"
  ) {
    throw new RuntimeTaskActionDenied(
      "Task-execution reference is no longer exact",
      "execution_ref_invalid",
    );
  }
  if (
    !task ||
    task.companyId !== capability.companyId ||
    task.ownershipEpoch !== capability.ownershipEpoch ||
    task.hiddenAt !== null
  ) {
    throw new RuntimeTaskActionDenied(
      "Task ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  if (
    capability.executionMode === "owner" &&
    (task.ownerKind !== "agent" ||
      task.ownerAgentId !== capability.targetAgentId)
  ) {
    throw new RuntimeTaskActionDenied(
      "Run no longer owns the task",
      "owner_changed",
    );
  }

  if (capability.executionMode === "owner") {
    if (!capability.taskExecutionAuthorityId) {
      throw new RuntimeTaskActionDenied(
        "Owner run has no execution authority",
        "execution_authority_invalid",
      );
    }
    const authority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(
            taskExecutionAuthorities.id,
            capability.taskExecutionAuthorityId,
          ),
          eq(taskExecutionAuthorities.companyId, capability.companyId),
          eq(taskExecutionAuthorities.taskId, capability.taskId),
          eq(taskExecutionAuthorities.sessionId, capability.sessionId),
          eq(
            taskExecutionAuthorities.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(taskExecutionAuthorities.agentId, capability.targetAgentId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!authority) {
      throw new RuntimeTaskActionDenied(
        "Task-execution authority is no longer current",
        "execution_authority_invalid",
      );
    }
  } else {
    if (!capability.consultExecutionId) {
      throw new RuntimeTaskActionDenied(
        "Consult run has no consult execution",
        "consult_execution_invalid",
      );
    }
    const consult = await tx
      .select()
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.id, capability.consultExecutionId),
          eq(taskConsultExecutions.companyId, capability.companyId),
          eq(taskConsultExecutions.taskId, capability.taskId),
          eq(taskConsultExecutions.sessionId, capability.sessionId),
          eq(
            taskConsultExecutions.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(
            taskConsultExecutions.targetAgentId,
            capability.targetAgentId,
          ),
          eq(
            taskConsultExecutions.adapterConfigRevisionId,
            capability.adapterConfigIdentity,
          ),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!consult) {
      throw new RuntimeTaskActionDenied(
        "Consult execution is no longer active",
        "consult_execution_invalid",
      );
    }
  }

  const caller = companyAgents.find(
    (candidate) => candidate.id === capability.targetAgentId,
  );
  const invokability = evaluateAgentInvokability(caller, companyAgents);
  if (!invokability.invokable) {
    throw new RuntimeTaskActionDenied(
      invokability.message,
      `agent_not_invokable:${invokability.reason}`,
    );
  }

  const persistentGrant = PERSISTENT_GRANT_BY_RUNTIME_ACTION[action];
  if (persistentGrant) {
    const grantRows = await tx
      .select({ id: agentActionGrants.id })
      .from(agentActionGrants)
      .where(
        and(
          eq(agentActionGrants.companyId, capability.companyId),
          eq(agentActionGrants.agentId, capability.targetAgentId),
          eq(agentActionGrants.key, persistentGrant),
        ),
      )
      .for("update");
    if (grantRows.length !== 1) {
      throw new RuntimeTaskActionDenied(
        `Current run no longer has ${persistentGrant} required for ${action}`,
        "action_grant_missing",
      );
    }
  }

  let catalog: RuntimeInterfaceCompileInput;
  try {
    catalog = await createPostgresRuntimeInterfaceCompiler(
      tx as unknown as Db,
    ).resolve(capability);
  } catch (error) {
    throw new RuntimeTaskActionDenied(
      error instanceof Error
        ? error.message
        : "Runtime interface could not be recompiled",
      "catalog_revalidation_failed",
    );
  }
  if (!actionRemainsAvailableInCatalog(catalog, action, persistentGrant)) {
    throw new RuntimeTaskActionDenied(
      persistentGrant
        ? `Current runtime catalog no longer grants ${persistentGrant} required for ${action}`
        : `Current runtime catalog no longer exposes ${action}`,
      persistentGrant ? "action_grant_missing" : "runtime_action_unavailable",
    );
  }
  return {
    company,
    companyAgents,
    task,
    taskSession,
    contextGeneration: sessionState.contextGeneration,
    ref,
    catalog,
  };
}
function ownerAgentId(
  owner: RuntimeTaskOwnerChoice,
  callerAgentId: string,
): string {
  return owner.kind === "self" ? callerAgentId : owner.agentId;
}

async function assertTargetAdapterRevision(
  tx: TaskSessionDbTransaction,
  companyId: string,
  targetAgentId: string,
): Promise<string> {
  try {
    const resolved = await resolveInvokableTaskOwnerInTransaction(tx, {
      companyId,
      ownerAgentId: targetAgentId,
    });
    return resolved.revisionId;
  } catch (error) {
    if (error instanceof InvokableTaskOwnerRejected) {
      const reason = error.reason.startsWith("owner_not_invokable:")
        ? `target_not_invokable:${error.reason.slice("owner_not_invokable:".length)}`
        : "target_revision_missing";
      throw new RuntimeTaskActionDenied(error.message, reason);
    }
    throw error;
  }
}

function assertCreateOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  owner: RuntimeTaskOwnerChoice,
): string {
  if (owner.kind === "self") return authorized.ref.targetAgentId;
  if (
    !authorized.catalog.taskCreateDirectChildren.some(
      (candidate) => candidate.id === owner.agentId,
    )
  ) {
    throw new RuntimeTaskActionDenied(
      "The selected owner is no longer a direct eligible child",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}

function assertAssignOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  taskId: string,
  owner: RuntimeTaskOwnerChoice,
): string {
  const target = authorized.catalog.taskAssignTargets.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!target) {
    throw new RuntimeTaskActionDenied(
      "The task is no longer in the caller's creator catalog",
      "creator_catalog_changed",
    );
  }
  if (owner.kind === "self") {
    if (!target.owners.some((candidate) => candidate.kind === "self")) {
      throw new RuntimeTaskActionDenied(
        "Self ownership is no longer available",
        "owner_catalog_changed",
      );
    }
    return authorized.ref.targetAgentId;
  }
  if (
    !target.owners.some(
      (candidate) =>
        candidate.kind === "agent" && candidate.id === owner.agentId,
    )
  ) {
    throw new RuntimeTaskActionDenied(
      "The selected owner is no longer in the target's owner catalog",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}

function creatorEndpoint(task: TaskRow): {
  endpointKind:
    "agent-execution" | "user/board" | "plugin" | "routine" | "system";
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
          originatingAdapterConfigRevisionId:
            task.creatorAdapterConfigRevisionId,
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

async function insertCreatorEdge(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
  now: Date,
) {
  if (!task.ownershipEpoch) {
    throw new RuntimeTaskActionConflict("Task ownership epoch is missing");
  }
  const endpoint = creatorEndpoint(task);
  const rows = await tx
    .insert(taskCreatorEdgeReceivability)
    .values({
      id: deterministicUuid(
        "creator-edge",
        `${task.companyId}:${task.id}:${task.ownershipEpoch}`,
      ),
      companyId: task.companyId,
      taskId: task.id,
      sessionId: await tx
        .select({ id: taskSessions.id })
        .from(taskSessions)
        .where(
          and(
            eq(taskSessions.companyId, task.companyId),
            eq(taskSessions.taskId, task.id),
          ),
        )
        .limit(1)
        .then((sessionRows) => {
          const session = sessionRows[0];
          if (!session) {
            throw new RuntimeTaskActionConflict(
              "Canonical task Session is missing",
            );
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
    canonicalJson(existing.endpointSnapshot) !==
      canonicalJson(endpoint.endpointSnapshot)
  ) {
    throw new RuntimeTaskActionConflict(
      "Creator-edge identity conflicts with the immutable task creator",
    );
  }
  return existing;
}

async function nextRunUpdateSequence(
  tx: TaskSessionDbTransaction,
  companyId: string,
  runId: string,
): Promise<number> {
  const rows = await tx
    .select({ sequence: max(taskUpdates.runSequence) })
    .from(taskUpdates)
    .where(
      and(eq(taskUpdates.companyId, companyId), eq(taskUpdates.runId, runId)),
    );
  return Number(rows[0]?.sequence ?? -1) + 1;
}

async function loadUpdateRetry(
  tx: TaskSessionDbTransaction,
  companyId: string,
  gatewayInvocationId: string,
) {
  const update = await tx
    .select()
    .from(taskUpdates)
    .where(
      and(
        eq(taskUpdates.companyId, companyId),
        eq(taskUpdates.gatewayInvocationId, gatewayInvocationId),
      ),
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
    throw new RuntimeTaskActionConflict(
      "Accepted task update is missing its canonical comment",
    );
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
      kind: "system-escalation-human";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
    }
  | {
      /**
       * A directly authenticated Board control-plane action. This is full
       * task-owner lifecycle authority, distinct from the narrow documented
       * human escalation and creator-withdrawal forms below.
       */
      kind: "board";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "user-creator-withdrawal";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
    };

export type CanonicalCreatorFormAuthority =
  | {
      kind: "agent-execution";
      capability: AgentRunCapability;
      invocationId: string;
    }
  | {
      kind: "user/board";
      companyId: string;
      userId: string;
      gatewayInvocationId: string;
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

function authorityCompanyId(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): string {
  return authority.kind === "agent-execution"
    ? authority.capability.companyId
    : authority.companyId;
}

function ownerGatewayInvocationId(
  authority: CanonicalOwnerFormAuthority,
): string {
  return authority.kind === "agent-execution"
      ? runtimeInvocationKey(
        "owner-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

function creatorGatewayInvocationId(
  authority: CanonicalCreatorFormAuthority,
): string {
  return authority.kind === "agent-execution"
      ? runtimeInvocationKey(
        "creator-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

function ownerSourceIdentity(
  authority: CanonicalOwnerFormAuthority,
): {
  sourceKind: "agent-execution" | "user/board";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: TaskSessionProjectedCommentSource;
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
        capabilityConnectionId:
          authority.capability.capabilityConnectionId,
        capabilityGeneration:
          authority.capability.capabilityGeneration,
      },
      runId: authority.capability.runId,
      comment: {
        author: {
          kind: "agent",
          agentId: authority.capability.targetAgentId,
        },
        producingRun: {
          runId: authority.capability.runId,
          adapterConfigRevisionId:
            authority.capability.adapterConfigIdentity,
        },
      },
    };
  }
  return {
    sourceKind: "user/board",
    sourceAuthorityId: null,
    sourceIdentity: {
      userId: authority.actorUserId,
      authorityKind: authority.kind,
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

function creatorSourceIdentity(
  authority: CanonicalCreatorFormAuthority,
): {
  sourceKind:
    | "agent-execution"
    | "user/board"
    | "plugin"
    | "routine"
    | "system";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: TaskSessionProjectedCommentSource;
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
          capabilityConnectionId:
            authority.capability.capabilityConnectionId,
          capabilityGeneration:
            authority.capability.capabilityGeneration,
        },
        runId: authority.capability.runId,
        comment: {
          author: {
            kind: "agent",
            agentId: authority.capability.targetAgentId,
          },
          producingRun: {
            runId: authority.capability.runId,
            adapterConfigRevisionId:
              authority.capability.adapterConfigIdentity,
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

function executionActorForCapability(
  capability: AgentRunCapability,
): Extract<TaskSessionExecutionActor, { kind: "agent-execution" }> {
  const executionAuthorityId =
    capability.taskExecutionAuthorityId ?? capability.consultExecutionId;
  if (!executionAuthorityId) {
    throw new RuntimeTaskActionConflict(
      "Agent harness delivery requires immutable execution authority",
    );
  }
  return {
    kind: "agent-execution",
    agentId: capability.targetAgentId,
    authorityId: executionAuthorityId,
  };
}

function taskUpdateActor(
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

function updateCounterpart(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): {
  counterpartTaskId: string;
  counterpartAuthorityId: string;
  counterpartOwnershipEpoch: number;
} | undefined {
  if (
    authority.kind !== "agent-execution" ||
    !authority.capability.taskExecutionAuthorityId
  ) {
    return undefined;
  }
  return {
    counterpartTaskId: authority.capability.taskId,
    counterpartAuthorityId:
      authority.capability.taskExecutionAuthorityId,
    counterpartOwnershipEpoch: authority.capability.ownershipEpoch,
  };
}

function sameTaskAgentTarget(
  sourceAgentTarget: { taskId: string; agentId: string } | null | undefined,
  target: AgentCounterpartTarget,
): boolean {
  // The only self-mention dedupe key is the exact (taskId, agentId) pair.
  return (
    sourceAgentTarget?.taskId === target.taskId &&
    sourceAgentTarget.agentId === target.agentId
  );
}

async function canDispatchAgentCounterpartTarget(
  tx: TaskSessionDbTransaction,
  companyId: string,
  target: AgentCounterpartTarget,
): Promise<boolean> {
  try {
    return (await assertTargetAdapterRevision(
      tx,
      companyId,
      target.agentId,
    )) === target.adapterConfigRevisionId;
  } catch (error) {
    if (error instanceof RuntimeTaskActionDenied) return false;
    throw error;
  }
}

async function admitAgentTextInTransaction(
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
    throw new RuntimeTaskActionConflict(
      "Canonical agent mention did not reserve its ref and comment",
    );
  }
  return admission;
}

type PaperclipManagedToolAdmissionInput =
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "task_request" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"task_create"> })
  | (Omit<
      Extract<
        DispatchingExecutionSourceInput,
        { sourceKind: "task_reassignment" }
      >,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"task_assign"> })
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "task_update" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"task_update"> })
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "consult_mention" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"mention_agent"> });

export async function mentionAgentInTransaction(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: PaperclipManagedToolAdmissionInput,
) {
  const { prompt, ...source } = input;
  return admitAgentTextInTransaction(sessionAdmission, tx, {
    ...source,
    exactText: renderPaperclipManagedToolPrompt(prompt),
  });
}

export async function mentionBoardInTransaction(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: {
    companyId: string;
    target: TaskUpdateTarget;
    actor: TaskSessionExecutionActor;
    comment: TaskSessionProjectedCommentSource;
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
  if (
    input.comment.author.kind !== "agent" ||
    input.comment.producingRun === null
  ) {
    throw new RuntimeTaskActionConflict(
      "Canonical Board mention requires an agent producing run",
    );
  }
  const counterpart = input.counterpart ?? {};
  const admission = await sessionAdmission.appendNonDispatchSyntheticComment(
    {
      companyId: input.companyId,
      taskId: input.target.taskId,
      sessionId: input.target.sessionId,
      sourceKind: input.sourceKind,
      projectionKind: "task_update",
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: input.message,
      ownershipEpoch: input.target.ownershipEpoch,
      agentId: input.comment.author.agentId,
      adapterConfigRevisionId:
        input.comment.producingRun.adapterConfigRevisionId,
      runId: input.comment.producingRun.runId,
      actor: input.actor,
      ...counterpart,
      comment: input.comment,
    },
    tx,
  );
  if (!admission.comment) {
    throw new RuntimeTaskActionConflict(
      "Canonical Board mention did not reserve its comment",
    );
  }
  const mentionId = deterministicUuid(
    "task-board-mention",
    input.immutableSourceKey,
  );
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
      target: [
        taskBoardMentions.companyId,
        taskBoardMentions.idempotencyKey,
      ],
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  const mention = inserted ?? await tx
    .select()
    .from(taskBoardMentions)
    .where(and(
      eq(taskBoardMentions.companyId, input.companyId),
      eq(taskBoardMentions.idempotencyKey, input.immutableSourceKey),
    ))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!mention || mention.commentId !== admission.comment.id) {
    throw new RuntimeTaskActionConflict(
      "Canonical Board mention was retried with different immutable arguments",
    );
  }
  return { ...admission, boardMention: mention };
}

export async function admitCounterpartTaskUpdate(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: {
    companyId: string;
    target: TaskMentionRecipient;
    actor: TaskSessionExecutionActor;
    comment: TaskSessionProjectedCommentSource;
    counterpart?: {
      counterpartTaskId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    };
    sourceAgentTarget?: { taskId: string; agentId: string } | null;
    immutableSourceKey: string;
    sourceRecordId: string;
  } & (
    | {
        sourceKind: "task_update";
        prompt: PaperclipManagedToolPrompt<"task_update">;
        message?: never;
      }
    | {
        sourceKind: "task_update";
        prompt?: never;
        message: string;
      }
  ),
) {
  const counterpart = input.counterpart ?? {};
  const sourceKind = "task_update" as const;
  const exactMessage = input.message === undefined
    ? renderPaperclipManagedToolPrompt(input.prompt)
    : input.message;
  const selfTarget =
    input.target.kind === "agent" &&
    sameTaskAgentTarget(input.sourceAgentTarget, input.target.target);
  const dispatchTarget =
    input.target.kind === "agent" &&
    !selfTarget &&
    await canDispatchAgentCounterpartTarget(
      tx,
      input.companyId,
      input.target.target,
    );
  if (dispatchTarget && input.target.kind === "agent") {
    const target = input.target.target;
    const dispatchScope = {
      companyId: input.companyId,
      taskId: target.taskId,
      sessionId: target.sessionId,
      ownershipEpoch: target.ownershipEpoch,
      targetAgentId: target.agentId,
      taskExecutionAuthorityId: target.authorityId,
      consultExecutionId: null,
      adapterConfigRevisionId: target.adapterConfigRevisionId,
      contextEpoch: target.contextGeneration,
      mode: "owner" as const,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      comment: input.comment,
      idempotencyKey: input.immutableSourceKey,
    };
    if (input.message !== undefined) {
      if (input.actor.kind !== "system") {
        throw new RuntimeTaskActionConflict(
          "System recovery task updates require a system actor",
        );
      }
      return admitAgentTextInTransaction(sessionAdmission, tx, {
        ...dispatchScope,
        sourceKind: "task_update",
        actor: input.actor,
        exactText: input.message,
      });
    }
    return mentionAgentInTransaction(sessionAdmission, tx, {
      ...dispatchScope,
      sourceKind: "task_update",
      actor: input.actor,
      prompt: input.prompt,
    });
  }
  if (
    input.actor.kind === "agent-execution" &&
    (input.target.kind === "board" || !selfTarget)
  ) {
    return mentionBoardInTransaction(sessionAdmission, tx, {
      companyId: input.companyId,
      target: input.target.target,
      actor: input.actor,
      comment: input.comment,
      counterpart: input.counterpart,
      sourceKind,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      message: `@board ${exactMessage}`,
    });
  }
  const target = input.target.target;
  return sessionAdmission.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      taskId: target.taskId,
      sessionId: target.sessionId,
      sourceKind,
      actor: input.actor,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: exactMessage,
      comment: input.comment,
      allowTerminal: false,
    },
    tx,
  );
}

async function lockReadyCompany(
  tx: TaskSessionDbTransaction,
  companyId: string,
): Promise<void> {
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
}

/**
 * One canonical transaction owner for both provider and documented human
 * task forms. Human callers receive no execution authority, provider ref, or
 * generic assignment capability: their authority is re-proved against the
 * immutable task owner/creator columns while the task epoch is locked.
 */
export function createTaskFormCommitRuntime(
  db: Db,
  options: TaskFormCommitRuntimeOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });

  async function commitOwnerFormUpdate(
    taskId: string,
    input: CanonicalOwnerFormUpdate,
    ownerAuthority: CanonicalOwnerFormAuthority,
  ) {
    if (!input.message.trim()) {
      throw new RuntimeTaskActionConflict(
        "Owner-form task_update requires a non-empty message",
      );
    }
    if (input.status !== undefined && !STATUSES.has(input.status)) {
      throw new RuntimeTaskActionConflict(
        "Owner-form task_update status is invalid",
      );
    }
    if (
      (input.status === undefined || !terminalStatus(input.status)) &&
      Object.hasOwn(input, "structuredResult")
    ) {
      throw new RuntimeTaskActionConflict(
        "Nonterminal owner updates cannot carry structuredResult",
      );
    }
    if (
      input.status !== undefined &&
      terminalStatus(input.status) &&
      Object.hasOwn(input, "structuredResult") &&
      input.structuredResult === undefined
    ) {
      throw new RuntimeTaskActionConflict(
        "structuredResult must be omitted rather than undefined",
      );
    }
    if (
      ownerAuthority.kind === "user-creator-withdrawal" &&
      (input.status !== "cancelled" ||
        Object.hasOwn(input, "structuredResult"))
    ) {
      throw new RuntimeTaskActionDenied(
        "A named-user withdrawal owner may only cancel with a message",
        "user_withdrawal_cancel_only",
      );
    }

    const companyId = authorityCompanyId(ownerAuthority);
    const gatewayInvocationId =
      ownerGatewayInvocationId(ownerAuthority);
    const disposition =
      input.status !== undefined && terminalStatus(input.status)
        ? {
            message: input.message,
            ...(Object.hasOwn(input, "structuredResult")
              ? { structuredResult: input.structuredResult }
              : {}),
          }
        : null;

    const committed = await db.transaction(async (tx) => {
      const now = clock();
      let task: TaskRow;
      let authorizedRuntime: AuthorizedRuntimeAction | null = null;
      if (ownerAuthority.kind === "agent-execution") {
        authorizedRuntime = await lockRuntimeActionAuthority(
          tx,
          ownerAuthority.capability,
          "task_update",
          now,
          { requireOwner: true },
        );
        if (
          taskId !== ownerAuthority.capability.taskId ||
          !ownerAuthority.capability.taskExecutionAuthorityId ||
          !authorizedRuntime.catalog.isCurrentOwner
        ) {
          throw new RuntimeTaskActionDenied(
            "Owner-form task_update requires the current owner authority",
            "owner_authority_invalid",
          );
        }
        task = authorizedRuntime.task;
      } else {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${taskId}`}, 0))`,
        );
        await lockReadyCompany(tx, companyId);
        const locked = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, companyId),
              eq(tasks.id, taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked || !locked.ownershipEpoch) {
          throw new RuntimeTaskActionDenied(
            "Owner-form task target does not exist",
            "owner_target_missing",
          );
        }
        const escalationOwner =
          locked.creatorKind === "system" &&
          locked.escalatedFromAffectedTaskId !== null &&
          ((locked.ownerKind === "user" &&
            locked.ownerUserId === ownerAuthority.actorUserId) ||
            locked.ownerKind === "board");
        const withdrawalOwner =
          locked.creatorKind === "user/board" &&
          locked.creatorUserId === ownerAuthority.actorUserId &&
          locked.ownerKind === "user" &&
          locked.ownerUserId === ownerAuthority.actorUserId &&
          locked.ownerAssignmentSource === "user_creator_withdrawal";
        if (
          (ownerAuthority.kind === "system-escalation-human" &&
            !escalationOwner) ||
          (ownerAuthority.kind === "user-creator-withdrawal" &&
            !withdrawalOwner)
        ) {
          throw new RuntimeTaskActionDenied(
            "Authenticated user is not the documented human owner",
            "owner_authority_invalid",
          );
        }
        // A named Board principal is already authenticated at ingress and is
        // the control-plane owner. It intentionally does not inherit either
        // narrow human-form relationship check above.
        task = locked;
      }

      const retry = await loadUpdateRetry(
        tx,
        companyId,
        gatewayInvocationId,
      );
      const source = ownerSourceIdentity(ownerAuthority);
      if (retry) {
        if (
          retry.update.form !== "owner" ||
          retry.update.taskId !== taskId ||
          retry.update.sourceKind !== source.sourceKind ||
          retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
          canonicalJson(retry.update.sourceIdentity) !==
            canonicalJson(source.sourceIdentity) ||
          retry.update.runId !== source.runId ||
          retry.update.message !== input.message ||
          retry.update.status !== (input.status ?? null) ||
          canonicalJson(retry.update.disposition) !==
            canonicalJson(disposition)
        ) {
          throw new RuntimeTaskActionConflict(
            "owner task_update invocation was retried with different immutable arguments",
          );
        }
        return { ...retry, cancellations: null };
      }

      assertTaskNonterminal(task);
      const previousStatus = task.lifecycleStatus;
      if (input.status !== undefined) {
        assertLifecycleTransition(task.lifecycleStatus, input.status);
      }
      const executionPolicyTransition =
        input.status === undefined
          ? null
          : applyTaskExecutionPolicyTransition({
              task,
              policy: normalizeTaskExecutionPolicy(
                task.executionPolicy,
              ),
              requestedStatus: boardPresentationStatusFor(input.status),
              requestedOwnerPatch: {},
              actor:
                ownerAuthority.kind === "agent-execution"
                  ? { agentId: ownerAuthority.capability.targetAgentId }
                  : { userId: ownerAuthority.actorUserId },
              commentBody: input.message,
            });
      const executionPolicyPatch = executionPolicyTransition
        ? taskExecutionPolicyPersistencePatch(
            executionPolicyTransition.patch,
          )
        : {};
      const nextExecutionState =
        executionPolicyTransition?.patch.executionState !== undefined
          ? parseTaskExecutionState(
              executionPolicyTransition.patch.executionState,
            )
          : parseTaskExecutionState(task.executionState);
      const gated =
        input.status === "done" && nextExecutionState?.status === "pending";
      const edge = await tx
        .select()
        .from(taskCreatorEdgeReceivability)
        .where(
          and(
            eq(taskCreatorEdgeReceivability.companyId, companyId),
            eq(taskCreatorEdgeReceivability.taskId, task.id),
            eq(
              taskCreatorEdgeReceivability.ownershipEpoch,
              task.ownershipEpoch!,
            ),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!edge) {
        throw new RuntimeTaskActionConflict(
          "Current ownership epoch has no eager creator edge",
        );
      }
      const runSequence =
        source.runId === null
          ? 0
          : await nextRunUpdateSequence(tx, companyId, source.runId);
      const updateId = deterministicUuid(
        "task-update",
        gatewayInvocationId,
      );
      const humanSessionState =
        ownerAuthority.kind === "agent-execution"
          ? null
          : await lockTaskSessionState(tx, companyId, task.id);
      if (
        ownerAuthority.kind !== "agent-execution" &&
        !humanSessionState
      ) {
        throw new RuntimeTaskActionConflict(
          "Human owner-form target has no canonical Session",
        );
      }
      const sourceSessionId =
        ownerAuthority.kind === "agent-execution"
          ? ownerAuthority.capability.sessionId
          : humanSessionState!.session.id;
      const target = await lockOwnerUpdateRecipient(
        tx,
        companyId,
        task,
        edge,
      );
      const updatePrompt = {
        toolName: "task_update",
        arguments: {
          ...(input.status === undefined ? {} : { status: input.status }),
          message: input.message,
          ...(Object.hasOwn(input, "structuredResult")
            ? { structuredResult: input.structuredResult }
            : {}),
        },
        context: {
          task,
          from: taskUpdateMessageActor(ownerAuthority, authorizedRuntime),
          sourceRole: "task owner",
          previousStatus,
          effectiveStatus:
            input.status === undefined || gated ? previousStatus : input.status,
          ...(gated ? { pendingReview: true } : {}),
        },
      } satisfies PaperclipManagedToolPrompt<"task_update">;
      const admission = await admitCounterpartTaskUpdate(sessionAdmission, tx, {
        companyId,
        sourceKind: "task_update",
        target,
        actor: taskUpdateActor(ownerAuthority),
        comment: source.comment,
        counterpart: updateCounterpart(ownerAuthority),
        sourceAgentTarget:
          ownerAuthority.kind === "agent-execution"
            ? {
                taskId: ownerAuthority.capability.taskId,
                agentId: ownerAuthority.capability.targetAgentId,
              }
            : null,
        immutableSourceKey: gatewayInvocationId,
        sourceRecordId: updateId,
        prompt: updatePrompt,
      });
      if (!admission.comment) {
        throw new RuntimeTaskActionConflict(
          "Owner update projector did not create its comment-of-record",
        );
      }
      const update = await tx
        .insert(taskUpdates)
        .values({
          id: updateId,
          companyId,
          taskId: task.id,
          sessionId: sourceSessionId,
          ownershipEpoch: task.ownershipEpoch!,
          form: "owner",
          sourceKind: source.sourceKind,
          sourceAuthorityId: source.sourceAuthorityId,
          sourceIdentity: source.sourceIdentity,
          runId: source.runId,
          gatewayInvocationId,
          runSequence,
          message: input.message,
          status: input.status ?? null,
          disposition,
          commentId: admission.comment.id,
          creatorEdgeId: edge.id,
          createdAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!update) {
        throw new RuntimeTaskActionConflict(
          "Owner update ledger row was not persisted",
        );
      }
      const updatedTask =
        input.status === undefined
          ? await tx
              .select()
              .from(tasks)
              .where(
                and(
                  eq(tasks.companyId, companyId),
                  eq(tasks.id, task.id),
                  eq(tasks.ownershipEpoch, task.ownershipEpoch!),
                  inArray(tasks.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : await tx
              .update(tasks)
              .set({
                ...executionPolicyPatch,
                lifecycleStatus: gated
                  ? task.lifecycleStatus
                  : input.status,
                boardPresentationStatus:
                  executionPolicyPatch.boardPresentationStatus ??
                  boardPresentationStatusFor(input.status),
                disposition: gated ? null : disposition,
                completedAt:
                  !gated && input.status === "done" ? now : null,
                cancelledAt:
                  !gated && input.status === "cancelled" ? now : null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(tasks.companyId, companyId),
                  eq(tasks.id, task.id),
                  eq(tasks.ownershipEpoch, task.ownershipEpoch!),
                  inArray(tasks.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
      if (!updatedTask) {
        throw new RuntimeTaskActionConflict(
          "Task lifecycle changed during owner update",
        );
      }
      const cancellations =
        !gated && input.status === "cancelled"
          ? await options.taskExecutionCancellation
              .requestScopeCancellationsInTransaction(tx, {
                companyId,
                taskId: task.id,
                selector: {
                  kind: "ownership_epoch",
                  ownershipEpoch: task.ownershipEpoch!,
                },
                reason: "task_cancelled",
                actor:
                  ownerAuthority.kind === "agent-execution"
                    ? {
                        kind: "agent",
                        agentId:
                          ownerAuthority.capability.targetAgentId,
                      }
                    : {
                        kind: "user",
                        userId: ownerAuthority.actorUserId,
                      },
                now,
              })
          : null;
      return {
        task: updatedTask,
        update,
        comment: admission.comment,
        ref: admission.ref,
        gated,
        cancellations,
        retried: false as const,
      };
    });
    if (committed.ref) {
      await options.dispatchPersistedRef(committed.ref.id);
    }
    if (committed.cancellations) {
      void options.taskExecutionCancellation
        .reconcileRequestedCancellations(committed.cancellations)
        .catch(() => {
          // The durable cancellation-intent reconciler retries this signal.
        });
    }
    const { cancellations: _, ...result } = committed;
    return result;
  }

  async function commitCreatorFormUpdate(
    taskId: string,
    input: string | CanonicalCreatorFormUpdate,
    creatorAuthority: CanonicalCreatorFormAuthority,
  ) {
    const updateInput: CanonicalCreatorFormUpdate =
      typeof input === "string" ? { message: input } : input;
    const { message } = updateInput;
    if (!message.trim()) {
      throw new RuntimeTaskActionConflict(
        "Creator-form task_update requires a non-empty message",
      );
    }
    if (
      updateInput.status !== undefined &&
      !STATUSES.has(updateInput.status)
    ) {
      throw new RuntimeTaskActionConflict(
        "Creator-form task_update status is invalid",
      );
    }
    if (Object.hasOwn(updateInput, "structuredResult")) {
      throw new RuntimeTaskActionConflict(
        "Creator task_update cannot carry structuredResult",
      );
    }
    if (
      updateInput.status !== undefined &&
      terminalStatus(updateInput.status)
    ) {
      throw new RuntimeTaskActionDenied(
        "Terminal done or cancelled updates require current-owner authority",
        "creator_terminal_status_forbidden",
      );
    }
    if (
      updateInput.status !== undefined &&
      creatorAuthority.kind !== "agent-execution"
    ) {
      throw new RuntimeTaskActionDenied(
        "Only an exact agent execution creator may transition task lifecycle",
        "creator_lifecycle_agent_execution_required",
      );
    }
    const disposition = null;
    const companyId = authorityCompanyId(creatorAuthority);
    const gatewayInvocationId =
      creatorGatewayInvocationId(creatorAuthority);
    const committed = await db.transaction(async (tx) => {
      const now = clock();
      let authorizedRuntime: AuthorizedRuntimeAction | null = null;
      if (creatorAuthority.kind === "agent-execution") {
        authorizedRuntime = await lockRuntimeActionAuthority(
          tx,
          creatorAuthority.capability,
          "task_update",
          now,
          { requireOwner: true },
        );
        if (!creatorAuthority.capability.taskExecutionAuthorityId) {
          throw new RuntimeTaskActionDenied(
            "Creator-form update requires a stable creator execution",
            "execution_authority_invalid",
          );
        }
        if (
          !authorizedRuntime.catalog.creatorUpdateTargets.some(
            (candidate) => candidate.taskId === taskId,
          )
        ) {
          throw new RuntimeTaskActionDenied(
            "Target is no longer in the caller's creator-update catalog",
            "creator_catalog_changed",
          );
        }
      } else {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${taskId}`}, 0))`,
        );
        if (creatorAuthority.kind === "plugin") {
          await resolvePluginPermittedTaskOwnerCatalogInTransaction(
            tx,
            {
              companyId,
              pluginInstallationId:
                creatorAuthority.pluginInstallationId,
              pluginKey: creatorAuthority.pluginKey,
              operation: "tasks.update",
            },
          );
        } else if (creatorAuthority.kind === "routine") {
          const routine = await tx
            .select()
            .from(routines)
            .where(
              and(
                eq(routines.companyId, companyId),
                eq(routines.id, creatorAuthority.routineId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          const hook = await tx
            .select()
            .from(routineRuns)
            .where(
              and(
                eq(routineRuns.companyId, companyId),
                eq(routineRuns.id, creatorAuthority.routineDispatchId),
                eq(routineRuns.routineId, creatorAuthority.routineId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!routine || routine.status !== "active" || !hook) {
            throw new RuntimeTaskActionDenied(
              "Routine creator hook is not active",
              "creator_authority_mismatch",
            );
          }
        }
        await lockReadyCompany(tx, companyId);
      }

      await tx.execute(
        sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${taskId} and ${tasks.companyId} = ${companyId} for update`,
      );
      const task = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.id, taskId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!task || !task.ownershipEpoch) {
        throw new RuntimeTaskActionDenied(
          "Creator-update target no longer exists",
          "target_task_missing",
        );
      }
      const creatorMatches = (() => {
        switch (creatorAuthority.kind) {
          case "agent-execution":
            return (
              task.parentId === creatorAuthority.capability.taskId &&
              task.creatorKind === "agent-execution" &&
              task.creatorAuthorityId ===
                creatorAuthority.capability.taskExecutionAuthorityId
            );
          case "user/board":
            return (
              task.creatorKind === "user/board" &&
              task.creatorUserId === creatorAuthority.userId
            );
          case "plugin":
            return (
              task.creatorKind === "plugin" &&
              task.creatorPluginInstallationId ===
                creatorAuthority.pluginInstallationId &&
              task.creatorPluginKey === creatorAuthority.pluginKey
            );
          case "routine":
            return (
              task.creatorKind === "routine" &&
              task.creatorRoutineId === creatorAuthority.routineId &&
              task.creatorRoutineDispatchId ===
                creatorAuthority.routineDispatchId
            );
          case "system":
            return (
              task.creatorKind === "system" &&
              task.creatorSystemSourceKind ===
                creatorAuthority.sourceKind &&
              task.creatorSystemSourceId === creatorAuthority.sourceId
            );
        }
      })();
      if (!creatorMatches) {
        throw new RuntimeTaskActionDenied(
          "Creator-update authority does not match the immutable target creator",
          "creator_authority_mismatch",
        );
      }
      if (creatorAuthority.kind === "routine") {
        const hook = await tx
          .select({ linkedTaskId: routineRuns.linkedTaskId })
          .from(routineRuns)
          .where(eq(routineRuns.id, creatorAuthority.routineDispatchId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (hook?.linkedTaskId !== task.id) {
          throw new RuntimeTaskActionDenied(
            "Routine creator hook does not target this task",
            "creator_authority_mismatch",
          );
        }
      }
      const sessionState = await lockTaskSessionState(
        tx,
        companyId,
        task.id,
      );
      if (!sessionState) {
        throw new RuntimeTaskActionConflict(
          "Creator-update target has no canonical Session",
        );
      }
      const edge = await tx
        .select()
        .from(taskCreatorEdgeReceivability)
        .where(
          and(
            eq(taskCreatorEdgeReceivability.companyId, companyId),
            eq(taskCreatorEdgeReceivability.taskId, task.id),
            eq(
              taskCreatorEdgeReceivability.ownershipEpoch,
              task.ownershipEpoch,
            ),
            eq(taskCreatorEdgeReceivability.state, "receivable"),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const expectedEndpoint = creatorEndpoint(task);
      if (
        !edge ||
        edge.endpointKind !== expectedEndpoint.endpointKind ||
        edge.endpointId !== expectedEndpoint.endpointId ||
        canonicalJson(edge.endpointSnapshot) !==
          canonicalJson(expectedEndpoint.endpointSnapshot)
      ) {
        throw new RuntimeTaskActionDenied(
          "Immutable creator edge is no longer receivable",
          "creator_edge_terminal",
        );
      }

      const source = creatorSourceIdentity(creatorAuthority);
      const retry = await loadUpdateRetry(
        tx,
        companyId,
        gatewayInvocationId,
      );
      if (retry) {
        if (
          retry.update.form !== "creator" ||
          retry.update.taskId !== task.id ||
          retry.update.sourceKind !== source.sourceKind ||
          retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
          canonicalJson(retry.update.sourceIdentity) !==
            canonicalJson(source.sourceIdentity) ||
          retry.update.runId !== source.runId ||
          retry.update.message !== message ||
          retry.update.status !== (updateInput.status ?? null) ||
          canonicalJson(retry.update.disposition) !== canonicalJson(disposition)
        ) {
          throw new RuntimeTaskActionConflict(
            "creator task_update invocation was retried with different immutable arguments",
          );
        }
        return { ...retry, cancellations: null };
      }

      // Idempotent retries must be recognized before checking the current
      // lifecycle state: a successful open -> blocked creator update now sees
      // the child as blocked on its exact replay.
      assertTaskNonterminal(task);
      const previousStatus = task.lifecycleStatus;
      if (updateInput.status !== undefined) {
        assertLifecycleTransition(task.lifecycleStatus, updateInput.status);
      }

      const executionPolicyTransition =
        updateInput.status === undefined
          ? null
          : (() => {
              if (creatorAuthority.kind !== "agent-execution") {
                throw new RuntimeTaskActionDenied(
                  "Only an exact agent execution creator may transition task lifecycle",
                  "creator_lifecycle_agent_execution_required",
                );
              }
              return applyTaskExecutionPolicyTransition({
                task,
                policy: normalizeTaskExecutionPolicy(
                  task.executionPolicy,
                ),
                requestedStatus: boardPresentationStatusFor(
                  updateInput.status,
                ),
                requestedOwnerPatch: {},
                actor: {
                  agentId: creatorAuthority.capability.targetAgentId,
                },
                commentBody: message,
              });
            })();
      const executionPolicyPatch = executionPolicyTransition
        ? taskExecutionPolicyPersistencePatch(
            executionPolicyTransition.patch,
          )
        : {};

      const target = await lockTaskMentionRecipient(
        tx,
        companyId,
        task.id,
      );
      const updateId = deterministicUuid(
        "task-update",
        gatewayInvocationId,
      );
      const updatePrompt = {
        toolName: "task_update",
        arguments: {
          taskId,
          ...(updateInput.status === undefined
            ? {}
            : { status: updateInput.status }),
          message,
        },
        context: {
          task,
          from: taskUpdateMessageActor(creatorAuthority, authorizedRuntime),
          sourceRole: "task creator",
          previousStatus,
          effectiveStatus: updateInput.status ?? previousStatus,
        },
      } satisfies PaperclipManagedToolPrompt<"task_update">;
      const admission = await admitCounterpartTaskUpdate(sessionAdmission, tx, {
        companyId,
        sourceKind: "task_update",
        target,
        actor: taskUpdateActor(creatorAuthority),
        comment: source.comment,
        counterpart: updateCounterpart(creatorAuthority),
        sourceAgentTarget:
          creatorAuthority.kind === "agent-execution"
            ? {
                taskId: creatorAuthority.capability.taskId,
                agentId: creatorAuthority.capability.targetAgentId,
              }
            : null,
        immutableSourceKey: gatewayInvocationId,
        sourceRecordId: updateId,
        prompt: updatePrompt,
      });
      if (!admission.comment) {
        throw new RuntimeTaskActionConflict(
          "Creator update did not persist its canonical comment",
        );
      }
      const runSequence =
        source.runId === null
          ? 0
          : await nextRunUpdateSequence(tx, companyId, source.runId);
      const update = await tx
        .insert(taskUpdates)
        .values({
          id: updateId,
          companyId,
          taskId: task.id,
          sessionId: sessionState.session.id,
          ownershipEpoch: task.ownershipEpoch,
          form: "creator",
          sourceKind: source.sourceKind,
          sourceAuthorityId: source.sourceAuthorityId,
          sourceIdentity: source.sourceIdentity,
          runId: source.runId,
          gatewayInvocationId,
          runSequence,
          message,
          status: updateInput.status ?? null,
          disposition,
          commentId: admission.comment.id,
          creatorEdgeId: edge.id,
          createdAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!update) {
        throw new RuntimeTaskActionConflict(
          "Creator update ledger row was not persisted",
        );
      }
      const updatedTask =
        updateInput.status === undefined
          ? await tx
              .select()
              .from(tasks)
              .where(
                and(
                  eq(tasks.companyId, companyId),
                  eq(tasks.id, task.id),
                  eq(tasks.ownershipEpoch, task.ownershipEpoch),
                  inArray(tasks.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : await tx
              .update(tasks)
              .set({
                ...executionPolicyPatch,
                lifecycleStatus: updateInput.status,
                boardPresentationStatus:
                  executionPolicyPatch.boardPresentationStatus ??
                  boardPresentationStatusFor(updateInput.status),
                disposition: null,
                completedAt: null,
                cancelledAt: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(tasks.companyId, companyId),
                  eq(tasks.id, task.id),
                  eq(tasks.ownershipEpoch, task.ownershipEpoch),
                  inArray(tasks.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
      if (!updatedTask) {
        throw new RuntimeTaskActionConflict(
          "Task lifecycle changed during creator update",
        );
      }
      return {
        task: updatedTask,
        update,
        comment: admission.comment,
        ref: admission.ref,
        gated: false,
        cancellations: null,
        retried: false as const,
      };
    });
    if (committed.ref) {
      await options.dispatchPersistedRef(committed.ref.id);
    }
    const { cancellations: _, ...result } = committed;
    return result;
  }

  return {
    commitOwnerFormUpdate,
    commitCreatorFormUpdate,
  };
}

export interface OutgoingOwnershipEpochRevocation {
  readonly escalationDispatchRefIds: readonly string[];
  readonly cancellations: RequestedScopedRunCancellations;
}

export async function revokeOutgoingOwnershipEpoch(
  tx: TaskSessionDbTransaction,
  sessionAdmission: TaskSessionAdmissionService,
  taskExecutionCancellation: Pick<
    TaskExecutionCancellationService,
    "requestScopeCancellationsInTransaction"
  >,
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
    throw new RuntimeTaskActionConflict(
      "Outgoing task-execution authority is missing or already revoked",
    );
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
        eq(
          taskExecutionPromptCapabilities.ownershipEpoch,
          input.ownershipEpoch,
        ),
        inArray(taskExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    );
  const cancellations =
    await taskExecutionCancellation.requestScopeCancellationsInTransaction(
      tx,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        selector: {
          kind: "ownership_epoch",
          ownershipEpoch: input.ownershipEpoch,
        },
        reason: "ownership_epoch_advanced",
        actor: input.cancellationActor,
        now: input.now,
      },
    );

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
          eq(
            taskCreatorEdgeReceivability.ownershipEpoch,
            child.ownershipEpoch,
          ),
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

function assertOwnerExecution(
  input: Pick<AgentRunManagedActionInvocation, "authority">,
): void {
  if (input.authority.capability.executionMode !== "owner") {
    throw new RuntimeTaskActionDenied(
      "Consult executions cannot mutate task ownership or lifecycle",
      "owner_execution_required",
    );
  }
}

function requireRuntimeMessage(command: {
  message?: string;
}): string {
  if (command.message === undefined) {
    throw new RuntimeTaskActionConflict(
      "Normalized runtime action is missing its required message",
    );
  }
  return command.message;
}

function runtimeTaskUpdateTarget(
  command: AgentRunManagedActionInvocation<"task_update">["command"],
): { taskId?: string } {
  if (command.taskTarget === "active") return {};
  if (command.taskTarget === "explicit") return { taskId: command.taskId };
  throw new RuntimeTaskActionConflict(
    "Runtime task_update lost its canonical active-versus-explicit target intent",
  );
}

/**
 * Closed adapter for the four task action descriptors. It accepts exactly
 * one normalized managed-tool command and leaves catalog/authority/epoch
 * revalidation to the canonical transactional service.
 */
export function createRuntimeTaskActionPort(
  service: RuntimeTaskActionService,
): AgentRunNonAgentActionPort {
  return {
    async taskCreate(input) {
      assertOwnerExecution(input);
      const { command, authority } = input;
      return service.create({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        request: command.request,
        title: command.title ?? undefined,
        priority: command.priority,
        owner: ownerChoiceFromCanonical(
          command.ownerAgentId,
          authority.capability,
        ),
      });
    },

    async taskAssign(input) {
      assertOwnerExecution(input);
      const { command, authority } = input;
      return service.assign({
        capability: authority.capability,
        invocationId: authority.invocation.id,
        taskId: command.taskId,
        owner: ownerChoiceFromCanonical(
          command.ownerAgentId,
          authority.capability,
        ),
      });
    },

    async taskUpdate(input) {
      assertOwnerExecution(input);
      const { command, authority } = input;
      const target = runtimeTaskUpdateTarget(command);
      const message = requireRuntimeMessage(command);
      if (command.status === undefined) {
        return service.update({
          capability: authority.capability,
          invocationId: authority.invocation.id,
          ...target,
          message,
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
          message,
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
          message,
        });
      }
      throw new RuntimeTaskActionConflict(
        "Runtime task_update has an unsupported canonical status",
      );
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

/**
 * Canonical PostgreSQL implementation for the provider-visible task actions.
 * Every method treats the bearer as a claimed binding only: the company,
 * gateway, lease, run, authority/consult, action grant, and dynamic catalog
 * are locked and re-read in the commit transaction.
 */
export function createPostgresRuntimeTaskActionService(
  db: Db,
  options: PostgresRuntimeTaskActionServiceOptions,
): RuntimeTaskActionService {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });
  const taskForms = createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchPersistedRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  return {
    async create(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "task_create",
          now,
          { requireOwner: true },
        );
        const key = runtimeInvocationKey(
          "create",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = ownerAgentId(
          input.owner,
          input.capability.targetAgentId,
        );
        const prior = await tx
          .select({
            key: taskCreateIdempotencyKeys,
            task: tasks,
          })
          .from(taskCreateIdempotencyKeys)
          .innerJoin(tasks, eq(tasks.id, taskCreateIdempotencyKeys.taskId))
          .where(
            and(
              eq(taskCreateIdempotencyKeys.companyId, input.capability.companyId),
              eq(taskCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (prior) {
          if (
            prior.task.parentId !== input.capability.taskId ||
            prior.task.request !== input.request ||
            prior.task.title !== (input.title ?? null) ||
            prior.task.priority !== (input.priority ?? "medium") ||
            prior.task.ownerKind !== "agent" ||
            prior.task.ownerAgentId !== requestedOwnerId ||
            prior.task.creatorKind !== "agent-execution" ||
            prior.task.creatorAuthorityId !==
              input.capability.taskExecutionAuthorityId
          ) {
            throw new RuntimeTaskActionConflict(
              "task_create invocation was retried with different immutable arguments",
            );
          }
          const ref = await tx
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.companyId, input.capability.companyId),
                eq(taskExecutionRefs.deliveryIdempotencyKey, key),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!ref) {
            throw new RuntimeTaskActionConflict(
              "Accepted task_create is missing its owner ref",
            );
          }
          return { task: prior.task, ref, retried: true };
        }

        const targetAgentId = assertCreateOwnerCatalog(authorized, input.owner);
        const targetRevisionId = await assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        if (!input.capability.taskExecutionAuthorityId) {
          throw new RuntimeTaskActionDenied(
            "task_create requires a stable parent execution authority",
            "execution_authority_invalid",
          );
        }
        const { taskNumber, identifier } =
          await allocateCanonicalTaskIdentityInTx(
            tx,
            input.capability.companyId,
            now,
          );

        const taskId = deterministicUuid("runtime-task-create", key);
        const sessionId = stableSessionId(`runtime-task-create:${key}`);
        const authorityId = deterministicUuid(
          "task-execution-authority",
          `${taskId}:1:${targetAgentId}`,
        );
        const aggregate = await withRuntimeWorkspaceReservationErrors(() =>
          persistCanonicalTaskAggregateInTx(tx, {
            task: {
              id: taskId,
              companyId: input.capability.companyId,
              projectId: authorized.task.projectId,
              projectWorkspaceId: authorized.task.projectWorkspaceId,
              goalId: authorized.task.goalId,
              parentId: input.capability.taskId,
              title: input.title ?? null,
              request: input.request,
              boardPresentationStatus: "todo",
              lifecycleStatus: "open",
              disposition: null,
              priority: input.priority ?? "medium",
              ownerKind: "agent",
              ownerAgentId: targetAgentId,
              ownerUserId: null,
              ownerAssignmentSource: null,
              ownershipEpoch: 1,
              creatorKind: "agent-execution",
              creatorAuthorityId: input.capability.taskExecutionAuthorityId,
              creatorAdapterConfigRevisionId:
                input.capability.adapterConfigIdentity,
              taskNumber,
              identifier,
              originKind: "agent_task_create",
              originId: input.capability.taskId,
              originRunId: input.capability.runId,
              originFingerprint: key,
              requestDepth: authorized.task.requestDepth + 1,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: sessionId,
              parentSessionId: input.capability.sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: input.capability.targetAgentId,
                userId: null,
              },
            },
            authority: {
              id: authorityId,
              agentId: targetAgentId,
              auditAdapterConfigRevisionId: targetRevisionId,
              createdAt: now,
            },
            idempotency: {
              id: deterministicUuid("task-create-idempotency", key),
              key,
            },
          }),
        );
        const created = aggregate.task;
        const sessionRoot = aggregate.sessionRoot;
        const edge = aggregate.creatorEdge;
        if (!edge) {
          throw new RuntimeTaskActionConflict(
            "task_create did not persist its creator edge",
          );
        }
        const assignmentPrompt = {
          toolName: "task_create",
          arguments: {
            request: input.request,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.priority === undefined
              ? {}
              : { priority: input.priority }),
            owner: input.owner,
          },
          context: {
            task: created,
            from: messageAgent(
              authorized.companyAgents,
              input.capability.targetAgentId,
            ),
            owner: messageAgent(authorized.companyAgents, targetAgentId),
            status: "open",
          },
        } satisfies PaperclipManagedToolPrompt<"task_create">;
        const admission = await admitTaskExecutionInTransaction({
          sessionAdmission,
          transaction: tx,
          work: {
            companyId: created.companyId,
            taskId: created.id,
            sessionId,
            ownershipEpoch: 1,
            targetAgentId,
            taskExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: targetRevisionId,
            contextEpoch: sessionRoot.contextEpoch.generation,
            mode: "owner",
            counterpartTaskId: input.capability.taskId,
            counterpartAuthorityId: input.capability.taskExecutionAuthorityId,
            counterpartOwnershipEpoch: input.capability.ownershipEpoch,
            sourceKind: "task_request",
            actor: executionActorForCapability(input.capability),
            immutableSourceKey: key,
            sourceRecordId: created.id,
            exactText: renderPaperclipManagedToolPrompt(assignmentPrompt),
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId:
                  input.capability.adapterConfigIdentity,
              },
            },
            idempotencyKey: key,
          },
        });
        if (!admission.ref) {
          throw new RuntimeTaskActionConflict(
            "task_create did not reserve an owner execution ref",
          );
        }
        return {
          task: created,
          sessionId,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          retried: false,
        };
      });
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },

    async assign(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "task_assign",
          now,
          { requireOwner: true },
        );
        if (!input.capability.taskExecutionAuthorityId) {
          throw new RuntimeTaskActionDenied(
            "task_assign requires the caller's stable creator authority",
            "execution_authority_invalid",
          );
        }
        await tx.execute(
          sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${input.taskId} and ${tasks.companyId} = ${input.capability.companyId} for update`,
        );
        const targetTask = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.capability.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!targetTask || !targetTask.ownershipEpoch) {
          throw new RuntimeTaskActionDenied(
            "Target task does not exist in the caller's company",
            "target_task_missing",
          );
        }
        const targetSessionState = await lockTaskSessionState(
          tx,
          input.capability.companyId,
          input.taskId,
        );
        if (!targetSessionState) {
          throw new RuntimeTaskActionConflict(
            "Target task has no canonical Session",
          );
        }
        const { session: targetSession } = targetSessionState;
        const key = runtimeInvocationKey(
          "assign",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = ownerAgentId(
          input.owner,
          input.capability.targetAgentId,
        );
        const priorEvent = await tx
          .select()
          .from(taskSessionEvents)
          .where(
            and(
              eq(taskSessionEvents.sessionId, targetSession.id),
              eq(taskSessionEvents.sourceKind, "task_reassignment"),
              eq(taskSessionEvents.immutableSourceKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorEvent) {
          const priorRef = await tx
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.sessionId, targetSession.id),
                eq(taskExecutionRefs.sourceId, priorEvent.sourceId!),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            priorEvent.sourceRecordId !== targetTask.id ||
            priorEvent.data === null ||
            !priorRef ||
            priorRef.targetAgentId !== requestedOwnerId ||
            !paperclipEnvelopeHasBody(
              priorRef.exactMessage,
              "[Paperclip task assignment]",
              targetTask.request,
            )
          ) {
            throw new RuntimeTaskActionConflict(
              "task_assign invocation was retried with different immutable arguments",
            );
          }
          return {
            task: targetTask,
            authorityId: priorRef.taskExecutionAuthorityId,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }

        const targetAgentId = assertAssignOwnerCatalog(
          authorized,
          input.taskId,
          input.owner,
        );
        assertTaskNonterminal(targetTask);
        if (
          targetTask.parentId !== input.capability.taskId ||
          targetTask.creatorKind !== "agent-execution" ||
          targetTask.creatorAuthorityId !==
            input.capability.taskExecutionAuthorityId ||
          targetTask.ownerKind !== "agent" ||
          !targetTask.ownerAgentId ||
          !targetTask.request
        ) {
          throw new RuntimeTaskActionDenied(
            "Target is not an exact direct task of this creator execution",
            "creator_authority_mismatch",
          );
        }
        if (
          targetSession.integrityState !== "ready" ||
          targetSession.refAdmittableAt === null ||
          targetSession.timeArchived !== null ||
          targetSession.purgeFencedAt !== null
        ) {
          throw new RuntimeTaskActionConflict(
            "Target task Session is lifecycle-fenced",
          );
        }
        const targetRevisionId = await assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        const outgoingAuthority = await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.capability.companyId),
              eq(taskExecutionAuthorities.taskId, targetTask.id),
              eq(
                taskExecutionAuthorities.ownershipEpoch,
                targetTask.ownershipEpoch,
              ),
              eq(taskExecutionAuthorities.agentId, targetTask.ownerAgentId),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new RuntimeTaskActionConflict(
            "Target task has no current outgoing owner authority",
          );
        }
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessionAdmission,
            options.taskExecutionCancellation,
            {
              companyId: input.capability.companyId,
              taskId: targetTask.id,
              sessionId: targetSession.id,
              ownershipEpoch: targetTask.ownershipEpoch,
              authorityId: outgoingAuthority.id,
              sourceAuthorityId:
                input.capability.taskExecutionAuthorityId,
              triggeringRunId: input.capability.runId,
              cancellationActor: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              now,
            },
          );

        const ownershipEpoch = targetTask.ownershipEpoch + 1;
        const authorityId = deterministicUuid(
          "task-execution-authority",
          `${targetTask.id}:${ownershipEpoch}:${targetAgentId}`,
        );
        const reassigned = await tx
          .update(tasks)
          .set({
            ownerKind: "agent",
            ownerAgentId: targetAgentId,
            ownerUserId: null,
            ownerAssignmentSource: null,
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.capability.companyId),
              eq(tasks.id, targetTask.id),
              eq(tasks.ownershipEpoch, targetTask.ownershipEpoch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new RuntimeTaskActionConflict(
            "Target ownership epoch changed during reassignment",
          );
        }
        const workspaceReservation =
          await withRuntimeWorkspaceReservationErrors(() =>
            reserveTaskExecutionWorkspaceBinding(tx, {
              task: reassigned,
              session: {
                id: targetSession.id,
                now,
              },
              provenance: {
                agentId: input.capability.targetAgentId,
                userId: null,
              },
            }),
          );
        await tx.insert(taskExecutionAuthorities).values({
          id: authorityId,
          companyId: reassigned.companyId,
          taskId: reassigned.id,
          sessionId: targetSession.id,
          ownershipEpoch,
          agentId: targetAgentId,
          auditAdapterConfigRevisionId: targetRevisionId,
          state: "current",
          createdAt: now,
        });
        const edge = await insertCreatorEdge(tx, reassigned, now);
        const admission = await mentionAgentInTransaction(
          sessionAdmission,
          tx,
          {
            companyId: reassigned.companyId,
            taskId: reassigned.id,
            sessionId: targetSession.id,
            ownershipEpoch,
            targetAgentId,
            taskExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: targetRevisionId,
            contextEpoch: workspaceReservation.contextEpochGeneration,
            mode: "owner",
            counterpartTaskId: input.capability.taskId,
            counterpartAuthorityId: input.capability.taskExecutionAuthorityId,
            counterpartOwnershipEpoch: input.capability.ownershipEpoch,
            sourceKind: "task_reassignment",
            actor: executionActorForCapability(input.capability),
            previousOwnershipEpoch: targetTask.ownershipEpoch,
            immutableSourceKey: key,
            sourceRecordId: reassigned.id,
            prompt: {
              toolName: "task_assign",
              arguments: {
                taskId: input.taskId,
                owner: input.owner,
              },
              context: {
                task: reassigned,
                from: messageAgent(
                  authorized.companyAgents,
                  input.capability.targetAgentId,
                ),
                owner: messageAgent(authorized.companyAgents, targetAgentId),
                status: targetTask.lifecycleStatus,
                request: reassigned.request!,
              },
            },
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId:
                  input.capability.adapterConfigIdentity,
              },
            },
            idempotencyKey: key,
          },
        );
        if (!admission.ref) {
          throw new RuntimeTaskActionConflict(
            "task_assign did not reserve the new owner ref",
          );
        }
        return {
          task: reassigned,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false,
        };
      });
      if (committed.cancellations) {
        await options.taskExecutionCancellation
          .reconcileRequestedCancellations(
            committed.cancellations,
          );
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await options.dispatchPersistedRef(refId);
      }
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },

    async update(input) {
      const authority = {
        kind: "agent-execution" as const,
        capability: input.capability,
        invocationId: input.invocationId,
      };
      // `taskId` is deliberately a relationship selector, not a generic
      // task mutation target. The underlying creator form re-proves exact
      // parent/creator authority in the same transaction.
      if (input.taskId === undefined) {
        const ownerUpdate = {
          message: input.message,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(Object.hasOwn(input, "structuredResult")
            ? { structuredResult: input.structuredResult }
            : {}),
        } as CanonicalOwnerFormUpdate;
        return taskForms.commitOwnerFormUpdate(
          input.capability.taskId,
          ownerUpdate,
          authority,
        );
      }
      const creatorUpdate = {
        message: input.message,
        ...(input.status === undefined ? {} : { status: input.status }),
      } as CanonicalCreatorFormUpdate;
      return taskForms.commitCreatorFormUpdate(
        input.taskId,
        creatorUpdate,
        authority,
      );
    },

    async mentionBoard(input) {
      const key = runtimeInvocationKey(
        "mention-board",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      );
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "mention_board",
          now,
          { requireOwner: false },
        );
        const admission = await mentionBoardInTransaction(
          sessionAdmission,
          tx,
          {
            companyId: input.capability.companyId,
            target: {
              taskId: input.capability.taskId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
            },
            actor: executionActorForCapability(input.capability),
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId: input.capability.adapterConfigIdentity,
              },
            },
            sourceKind: "mention_board",
            immutableSourceKey: key,
            sourceRecordId: deterministicUuid("task-board-mention", key),
            message: input.message,
          },
        );
        return input.commitMentionAction(tx, {
          accepted: true,
          id: admission.boardMention.id,
          commentId: admission.boardMention.commentId,
          retried: admission.retried,
        });
      });
      return committed;
    },

    async listAgents(input) {
      return db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "list_agents",
          now,
          { requireOwner: false },
        );
        const [allRows, grantRows] = await Promise.all([
          tx
            .select({
              id: agents.id,
              name: agents.name,
              title: agents.title,
              capabilities: agents.capabilities,
              status: agents.status,
              reportsTo: agents.reportsTo,
            })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, input.capability.companyId),
                or(
                  eq(agents.status, "idle"),
                  eq(agents.status, "paused"),
                  eq(agents.status, "pending_approval"),
                ),
              ),
            )
            .orderBy(asc(agents.name)),
          tx
            .select({ key: agentActionGrants.key })
            .from(agentActionGrants)
            .where(
              and(
                eq(agentActionGrants.companyId, input.capability.companyId),
                eq(agentActionGrants.agentId, input.capability.targetAgentId),
              ),
            ),
        ]);
        const grantKeys = new Set(grantRows.map((r) => r.key));
        const hasListAll = grantKeys.has("list_all_agents");
        const hasListParent = grantKeys.has("list_parent_agents");
        if (!hasListAll && !hasListParent) {
          throw new RuntimeTaskActionDenied(
            "Agent lacks list_all_agents and list_parent_agents grants",
            "grant_required",
          );
        }

        const mapped = allRows.map((row) => ({
          id: row.id,
          name: row.name,
          title: row.title,
          capabilities: row.capabilities,
          status: row.status,
          reportsTo: row.reportsTo,
        }));

        const childrenByParent = new Map<string, typeof mapped>();
        for (const agent of mapped) {
          if (!agent.reportsTo) continue;
          const list = childrenByParent.get(agent.reportsTo);
          if (list) {
            list.push(agent);
          } else {
            childrenByParent.set(agent.reportsTo, [agent]);
          }
        }

        function collectDescendants(rootId: string): Set<string> {
          const ids = new Set<string>([rootId]);
          const stack = [rootId];
          while (stack.length > 0) {
            const parentId = stack.pop()!;
            for (const child of childrenByParent.get(parentId) ?? []) {
              if (!ids.has(child.id)) {
                ids.add(child.id);
                stack.push(child.id);
              }
            }
          }
          return ids;
        }

        if (hasListAll) {
          if (!input.agentId) {
            return { agents: mapped };
          }
          const root = mapped.find((a) => a.id === input.agentId);
          if (!root) {
            throw new RuntimeTaskActionDenied(
              "Agent not found in this company",
              "agent_not_found",
            );
          }
          const descendantIds = collectDescendants(root.id);
          return {
            agents: mapped.filter((a) => descendantIds.has(a.id)),
          };
        }

        const currentAgent = mapped.find(
          (a) => a.id === input.capability.targetAgentId,
        );
        if (!currentAgent?.reportsTo) {
          throw new RuntimeTaskActionDenied(
            "Current agent has no parent for team-scoped listing",
            "no_parent_agent",
          );
        }
        const parentAgentId = currentAgent.reportsTo;
        const teamIds = collectDescendants(parentAgentId);

        const effectiveAgentId = input.agentId ?? parentAgentId;
        if (!teamIds.has(effectiveAgentId)) {
          throw new RuntimeTaskActionDenied(
            "Agent is not within the current agent's parent team",
            "outside_team_scope",
          );
        }
        const descendantIds = collectDescendants(effectiveAgentId);
        return {
          agents: mapped.filter(
            (a) => descendantIds.has(a.id) && teamIds.has(a.id),
          ),
        };
      });
    },

    async agentRead(input) {
      return db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "agent_read",
          now,
          { requireOwner: false },
        );
        const [agentRow] = await tx
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            capabilities: agents.capabilities,
            instruction: agents.instruction,
            status: agents.status,
            reportsTo: agents.reportsTo,
          })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.capability.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .limit(1);
        if (!agentRow) {
          throw new RuntimeTaskActionDenied(
            "Agent not found in this company",
            "agent_not_found",
          );
        }
        const [contextRows, actionRows, mentionRows] = await Promise.all([
          tx
            .select({ key: agentContextGrants.key })
            .from(agentContextGrants)
            .where(
              and(
                eq(agentContextGrants.companyId, input.capability.companyId),
                eq(agentContextGrants.agentId, input.agentId),
              ),
            ),
          tx
            .select({ key: agentActionGrants.key })
            .from(agentActionGrants)
            .where(
              and(
                eq(agentActionGrants.companyId, input.capability.companyId),
                eq(agentActionGrants.agentId, input.agentId),
              ),
            ),
          tx
            .select({ key: agentMentionReachGrants.key })
            .from(agentMentionReachGrants)
            .where(
              and(
                eq(agentMentionReachGrants.companyId, input.capability.companyId),
                eq(agentMentionReachGrants.agentId, input.agentId),
              ),
            ),
        ]);
        return {
          id: agentRow.id,
          name: agentRow.name,
          title: agentRow.title,
          capabilities: agentRow.capabilities,
          instruction: agentRow.instruction,
          status: agentRow.status,
          reportsTo: agentRow.reportsTo,
          contextGrants: grantMap(contextRows),
          actionGrants: grantMap(actionRows),
          mentionReachGrants: grantMap(mentionRows),
        };
      });
    },

    async mention(input) {
      if (
        input.runInterfaceToolCallId.length === 0 ||
        input.runInterfaceToolCallId !== input.runInterfaceToolCallId.trim() ||
        !isCanonicalUuid(input.runInterfaceToolCallId)
      ) {
        throw new RuntimeTaskActionConflict(
          "Mention admission requires its exact run-interface tool-call identity",
        );
      }
      if (
        !Number.isSafeInteger(input.ingressOrdinal) ||
        input.ingressOrdinal < 0
      ) {
        throw new RuntimeTaskActionConflict(
          "Mention admission requires its immutable nonnegative ingress ordinal",
        );
      }
      const key = `${runtimeInvocationKey(
        "mention",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      )}:tool-call:${input.runInterfaceToolCallId}:ingress:${input.ingressOrdinal}`;
      const committed = await db.transaction(async (tx) => {
          const now = clock();
          const authorized = await lockRuntimeActionAuthority(
            tx,
            input.capability,
            "mention_agent",
            now,
            {
              requireOwner: false,
              additionalLaneTargetAgentId: input.targetAgentId,
            },
          );
          if (
            !authorized.catalog.mentionTargets.some(
              (candidate) => candidate.id === input.targetAgentId,
            )
          ) {
            throw new RuntimeTaskActionDenied(
              "Mention target is no longer in the current reach catalog",
              "mention_catalog_changed",
            );
          }
          const priorEvent = await tx
            .select()
            .from(taskSessionEvents)
            .where(
              and(
                eq(taskSessionEvents.companyId, input.capability.companyId),
                eq(taskSessionEvents.taskId, input.capability.taskId),
                eq(taskSessionEvents.sessionId, input.capability.sessionId),
                eq(
                  taskSessionEvents.ownershipEpoch,
                  input.capability.ownershipEpoch,
                ),
                eq(taskSessionEvents.sourceKind, "consult_mention"),
                eq(taskSessionEvents.immutableSourceKey, key),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (priorEvent) {
            const priorRef = await tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.capability.companyId),
                  eq(taskExecutionRefs.taskId, input.capability.taskId),
                  eq(taskExecutionRefs.sessionId, input.capability.sessionId),
                  eq(
                    taskExecutionRefs.ownershipEpoch,
                    input.capability.ownershipEpoch,
                  ),
                  eq(taskExecutionRefs.sourceId, priorEvent.sourceId!),
                ),
              )
              .limit(1)
              .for("update")
              .then((rows) => rows[0] ?? null);
            const consult = priorRef?.consultExecutionId
              ? await tx
                  .select()
                  .from(taskConsultExecutions)
                  .where(
                    eq(
                      taskConsultExecutions.id,
                      priorRef.consultExecutionId,
                    ),
                  )
                  .limit(1)
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            if (
              !priorRef ||
              priorRef.mode !== "consult" ||
              priorRef.sourceKind !== "consult_mention" ||
              priorRef.consultCallerRefId !== input.capability.refId ||
              priorRef.targetAgentId !== input.targetAgentId ||
              !paperclipEnvelopeHasBody(
                priorRef.exactMessage,
                "[Paperclip agent message]",
                input.message,
              ) ||
              !consult ||
              consult.state !== "active" ||
              consult.sourceRunId !== input.capability.runId ||
              consult.sourceRefId !== input.capability.refId ||
              consult.targetAgentId !== input.targetAgentId ||
              priorEvent.sourceRecordId !== consult.id
            ) {
              throw new RuntimeTaskActionConflict(
                "mention invocation was retried with different immutable arguments",
              );
            }
            return input.commitMentionAction(tx, {
              accepted: true,
              consultExecutionId: consult.id,
              refId: priorRef.id,
              commentId: null,
              retried: true,
            });
          }

          const targetRevisionId = await assertTargetAdapterRevision(
            tx,
            input.capability.companyId,
            input.targetAgentId,
          );
          let chain;
          try {
            chain = await lockAndValidateTaskConsultChain(tx, {
              ref: authorized.ref,
              requireLiveAncestors: false,
              leafState: "active",
            });
          } catch (error) {
            if (error instanceof TaskConsultChainInvalid) {
              throw new RuntimeTaskActionDenied(
                error.message,
                error.reason === "cycle"
                  ? "mention_chain_cycle"
                  : "mention_chain_invalid",
              );
            }
            throw error;
          }
          if (chain.agentIds.has(input.targetAgentId)) {
            throw new RuntimeTaskActionDenied(
              "Mention target would loop within its active mention chain",
              "mention_chain_loop",
            );
          }

          const consultId = deterministicUuid("task-consult", key);
          const consult = await tx
            .insert(taskConsultExecutions)
            .values({
              id: consultId,
              companyId: input.capability.companyId,
              taskId: input.capability.taskId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
              sourceRunId: input.capability.runId,
              sourceRefId: input.capability.refId,
              callerExecutionScopeId: authorized.ref.executionScopeId,
              targetAgentId: input.targetAgentId,
              adapterConfigRevisionId: targetRevisionId,
              chainToken: chain.chainToken,
              state: "active",
              createdAt: now,
            })
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!consult) {
            throw new RuntimeTaskActionConflict(
              "Mention execution binding was not persisted",
            );
          }
          const admission = await mentionAgentInTransaction(
            sessionAdmission,
            tx,
            {
              companyId: input.capability.companyId,
              taskId: input.capability.taskId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
              targetAgentId: input.targetAgentId,
              taskExecutionAuthorityId: null,
              consultExecutionId: consult.id,
              adapterConfigRevisionId: targetRevisionId,
              contextEpoch: authorized.contextGeneration,
              mode: "consult",
              executionLineageId: authorized.ref.executionLineageId,
              consultCallerRefId: authorized.ref.id,
              consultChainToken: chain.chainToken,
              sourceKind: "consult_mention",
              actor: executionActorForCapability(input.capability),
              immutableSourceKey: key,
              sourceRecordId: consult.id,
              prompt: {
                toolName: "mention_agent",
                arguments: {
                  agentId: input.targetAgentId,
            message: `@board ${input.message}`,
                },
                context: {
                  task: authorized.task,
                  from: messageAgent(
                    authorized.companyAgents,
                    input.capability.targetAgentId,
                  ),
                  to: messageAgent(
                    authorized.companyAgents,
                    input.targetAgentId,
                  ),
                },
              },
              comment: {
                author: {
                  kind: "agent",
                  agentId: input.capability.targetAgentId,
                },
                producingRun: {
                  runId: input.capability.runId,
                  adapterConfigRevisionId:
                    input.capability.adapterConfigIdentity,
                },
              },
              idempotencyKey: key,
            },
          );
          if (!admission.ref || !admission.comment) {
            throw new RuntimeTaskActionConflict(
              "Mention did not reserve its canonical ref and comment",
            );
          }
          return input.commitMentionAction(tx, {
            accepted: true,
            consultExecutionId: consult.id,
            refId: admission.ref.id,
            commentId: admission.comment.id,
            retried: false,
          });
      });
      await options.dispatchPersistedRef(committed.refId);
      return committed;
    },
  };
}
