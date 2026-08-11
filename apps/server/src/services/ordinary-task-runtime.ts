import { createHash } from "node:crypto";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  taskCreateIdempotencyKeys,
  taskBoardReopenCommands,
  taskBoardUserComments,
  taskCommentProjectionSources,
  taskComments,
  taskCreatorEdgeReceivability,
  taskCreatorWithdrawalCommands,
  taskExecutionAuthorities,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionSessions,
  taskLabels,
  taskSessionContextEpochs,
  taskSessions,
  taskUpdates,
  tasks,
  labels,
  pluginWithdrawalOperations,
  plugins,
  projects,
  routines,
  systemEscalationIdentities,
  type Db,
} from "@paperclipai/db";
import type {
  TaskBoardReopenDispatch,
  TaskCreatorEdgeTerminalReason,
  TaskExecutionRefSourceKind,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  InvokableTaskOwnerRejected,
  resolveInvokableTaskOwnerInTransaction,
} from "./agent-invokability.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  createTaskSessionAdmissionService,
  type TaskSessionAdmissionResult,
  type TaskSessionExecutionActor,
  type TaskSessionExecutionSource,
  type TaskSessionProjectedCommentSource,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { persistCanonicalTaskAggregateInTx } from "./canonical-task-aggregate.js";
import {
  createTaskFormCommitRuntime,
  revokeOutgoingOwnershipEpoch,
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  type CanonicalCreatorFormAuthority,
  type CanonicalOwnerFormAuthority,
  type CanonicalOwnerFormUpdate,
} from "./runtime-task-action-port.js";
import { ensureSystemEscalationInTransaction } from "./system-escalation-postgres.js";
import {
  TaskExecutionWorkspaceReservationRejected,
  reserveTaskExecutionWorkspaceBinding,
} from "./execution-workspaces.js";
import {
  assertPluginPermittedTaskOwnerInTransaction,
} from "./plugin-task-authorization.js";
import {
  TaskExecutionRunInvariantViolation,
  TaskExecutionSteeringRejected,
  type TaskExecutionRunService,
} from "./task-execution-run-service.js";
import { projectPersistedTaskExecutionRef } from "./task-execution-dispatcher-postgres.js";
import type {
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
  RequestedScopedRunCancellations,
} from "./task-execution-cancellation.js";

type TaskRow = typeof tasks.$inferSelect;
type CreatorEdgeRow = typeof taskCreatorEdgeReceivability.$inferSelect;
type TaskSessionRow = typeof taskSessions.$inferSelect;
type BoardReopenCommandRow = typeof taskBoardReopenCommands.$inferSelect;
type SystemEscalationIdentityRow =
  typeof systemEscalationIdentities.$inferSelect;
type ReopenCreatorEndpointState = {
  terminalReason: TaskCreatorEdgeTerminalReason | null;
  endpointTombstone: Record<string, unknown> | null;
};

const NONTERMINAL = new Set(["open", "blocked"]);
const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

async function lockTaskSessionState(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<{
  session: TaskSessionRow;
  contextGeneration: number;
} | null> {
  return tx
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
    .where(
      and(
        eq(taskSessions.companyId, companyId),
        eq(taskSessions.taskId, taskId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
}

export class OrdinaryTaskRuntimeRejected extends Error {
  readonly code = "ordinary_task_runtime_rejected";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "OrdinaryTaskRuntimeRejected";
  }
}

type PluginWithdrawalCommitOutcome =
  | {
      kind: "accepted";
      operationId: string;
      task: TaskRow;
      escalationDispatchRefIds: readonly string[];
      cancellations: RequestedScopedRunCancellations | null;
      retried: boolean;
    }
  | {
      kind: "rejected";
      message: string;
      reason: string;
    };

const TASK_ROW_DATE_KEYS = [
  "monitorNextCheckAt",
  "monitorLastTriggeredAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "hiddenAt",
  "createdAt",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof TaskRow>;

function pluginWithdrawalTaskSnapshot(task: TaskRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...task };
  for (const key of TASK_ROW_DATE_KEYS) {
    const value = task[key];
    snapshot[key] = value instanceof Date ? value.toISOString() : value;
  }
  return snapshot;
}

function recordedPluginWithdrawalTask(result: unknown): TaskRow | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const task = (result as Record<string, unknown>).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const snapshot = { ...(task as Record<string, unknown>) };
  for (const key of TASK_ROW_DATE_KEYS) {
    const value = snapshot[key];
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return null;
      snapshot[key] = parsed;
    }
  }
  return snapshot as unknown as TaskRow;
}

function recordedPluginWithdrawalRejection(result: unknown): {
  message: string;
  reason: string;
} | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  return typeof record.message === "string" && typeof record.reason === "string"
    ? { message: record.message, reason: record.reason }
    : null;
}

export type OrdinaryTaskCreator =
  | {
      kind: "user/board";
      userId: string;
    }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
      callbackKey: string;
      callbackVersion: string;
      callbackRegistrationActive: true;
    }
  | {
      kind: "routine";
      routineId: string;
      routineDispatchId: string;
    };

export interface OrdinaryTaskCreateInput {
  /** Caller-reserved UUID for an atomically correlated producer row. */
  taskId?: string;
  companyId: string;
  request: string;
  ownerAgentId: string;
  creator: OrdinaryTaskCreator;
  idempotencyKey: string;
  sourceKind?: Extract<
    TaskExecutionRefSourceKind,
    "task_request" | "routine_dispatch"
  >;
  title?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  priority?: "critical" | "high" | "medium" | "low";
  labelIds?: string[];
  responsibleUserId?: string | null;
  originKind?: string | null;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  billingCode?: string | null;
  workMode?: string;
  harnessKind?: string | null;
  /**
   * Optional producer-side correlation written in the same transaction as
   * the task, Session, authority, and initial execution ref.
   */
  correlate?: (
    tx: TaskSessionDbTransaction,
    persisted: {
      task: TaskRow;
      sessionId: string;
      authorityId: string;
      ref: NonNullable<TaskSessionAdmissionResult["ref"]>;
    },
  ) => Promise<void>;
}

export interface OrdinaryTaskCreateResult {
  task: TaskRow;
  sessionId: string;
  authorityId: string;
  ref: NonNullable<TaskSessionAdmissionResult["ref"]>;
  retried: boolean;
}

export interface OrdinaryTaskBoardReopenInput {
  companyId: string;
  taskId: string;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
}

export interface OrdinaryTaskUserCommentInput {
  companyId: string;
  taskId: string;
  actorUserId: string;
  message: string;
  idempotencyKey: string;
  /**
   * Dispatch is authorized only by this explicit, complete tuple. Prose is
   * never inspected for an @mention.
   */
  mention?: {
    targetAgentId: string;
    ownershipEpoch: number;
  } | null;
  /** Canonical persisted comment target; mutually exclusive with mention. */
  replyToCommentId?: string | null;
}

export interface OrdinaryTaskReassignInput {
  companyId: string;
  taskId: string;
  ownerAgentId: string;
  idempotencyKey: string;
  creator:
    | { kind: "user/board"; userId: string }
    | {
        kind: "plugin";
        pluginInstallationId: string;
        pluginKey: string;
      };
}

export interface OrdinaryTaskBoardReassignInput {
  companyId: string;
  taskId: string;
  ownerAgentId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OrdinaryTaskUserWithdrawalSelfAssignmentInput {
  companyId: string;
  taskId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OrdinaryPluginWithdrawalPrepareInput {
  companyId: string;
  taskId: string;
  message: string;
  operationId: string;
  pluginInstallationId: string;
  pluginKey: string;
}

export interface OrdinaryPluginWithdrawalInput {
  companyId: string;
  operationId: string;
  pluginInstallationId: string;
  pluginKey: string;
}

export interface OrdinaryTaskRuntimeOptions {
  clock?: () => Date;
  taskExecutionRunService: Pick<
    TaskExecutionRunService,
    | "requestSteeringInTransaction"
    | "continuePendingSteeringForSource"
  >;
  taskExecutionCancellation: Pick<
    TaskExecutionCancellationService,
    | "requestScopeCancellationsInTransaction"
    | "reconcileRequestedCancellations"
  >;
  /**
   * The only execution trigger exposed to causal producers. Implementations
   * must prepare composition and notify the dispatcher for this persisted ref.
   */
  dispatchRef(refId: string): Promise<void>;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function withOrdinaryWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}

async function withOrdinaryTaskFormErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeTaskActionDenied) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    if (error instanceof RuntimeTaskActionConflict) {
      throw new OrdinaryTaskRuntimeRejected(
        error.message,
        "task_form_conflict",
      );
    }
    throw error;
  }
}

async function withOrdinaryHumanSteeringErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof TaskExecutionSteeringRejected ||
      error instanceof TaskExecutionRunInvariantViolation
    ) {
      throw new OrdinaryTaskRuntimeRejected(
        error.message,
        error instanceof TaskExecutionSteeringRejected &&
            error.reason !== "invalid_request"
          ? "human_reply_steering_ambiguous"
          : "human_reply_run_not_steerable",
      );
    }
    throw error;
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OrdinaryTaskRuntimeRejected(`${label} is required`, `${label}_required`);
  }
  return normalized;
}

function nonBlankPreservingBytes(value: string, label: string): string {
  if (!value.trim()) {
    throw new OrdinaryTaskRuntimeRejected(
      `${label} is required`,
      `${label}_required`,
    );
  }
  return value;
}

function creatorColumns(creator: OrdinaryTaskCreator) {
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

function projectedCommentSource(
  creator: OrdinaryTaskCreator,
): TaskSessionProjectedCommentSource {
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

function executionActorForOrdinaryCreator(
  creator: OrdinaryTaskCreator,
): TaskSessionExecutionActor {
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

function executionSourceForOrdinaryCreate(
  input: Pick<OrdinaryTaskCreateInput, "creator" | "sourceKind">,
):
  | Extract<TaskSessionExecutionSource, { sourceKind: "task_request" }>
  | Extract<TaskSessionExecutionSource, { sourceKind: "routine_dispatch" }> {
  const sourceKind =
    input.sourceKind ??
    (input.creator.kind === "routine"
      ? "routine_dispatch"
      : "task_request");
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

function creatorEndpoint(task: TaskRow): {
  endpointKind:
    | "agent-execution"
    | "user/board"
    | "plugin"
    | "routine"
    | "system";
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
        originatingAdapterConfigRevisionId:
          task.creatorAdapterConfigRevisionId,
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
  if (
    task.creatorKind === "routine" &&
    task.creatorRoutineId &&
    task.creatorRoutineDispatchId
  ) {
    return {
      endpointKind: "routine",
      endpointId: task.creatorRoutineId,
      endpointSnapshot: {
        routineId: task.creatorRoutineId,
        routineDispatchId: task.creatorRoutineDispatchId,
      },
    };
  }
  if (
    task.creatorKind === "system" &&
    task.creatorSystemSourceKind &&
    task.creatorSystemSourceId
  ) {
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
  throw new OrdinaryTaskRuntimeRejected(
    "Task creator endpoint is incomplete",
    "creator_endpoint_incomplete",
  );
}

async function insertCreatorEdge(
  tx: TaskSessionDbTransaction,
  task: TaskRow,
  sessionId: string,
  now: Date,
  options: {
    terminalReason?: TaskCreatorEdgeTerminalReason | null;
    terminalSourceKind?: string | null;
    terminalSourceId?: string | null;
    terminalAudit?: Record<string, unknown> | null;
    endpointTombstone?: Record<string, unknown> | null;
  } = {},
): Promise<CreatorEdgeRow> {
  const endpoint = creatorEndpoint(task);
  const terminalReason = options.terminalReason ?? null;
  const terminal = terminalReason !== null;
  const edge = await tx
    .insert(taskCreatorEdgeReceivability)
    .values({
      id: deterministicUuid(
        "creator-edge",
        `${task.companyId}:${task.id}:${task.ownershipEpoch}`,
      ),
      companyId: task.companyId,
      taskId: task.id,
      sessionId,
      ownershipEpoch: task.ownershipEpoch!,
      creatorKind: task.creatorKind!,
      ...endpoint,
      endpointTombstone: options.endpointTombstone ?? null,
      state: terminal ? "terminal" : "receivable",
      terminalReason,
      terminalSourceKind: terminal
        ? options.terminalSourceKind ?? "board_reopen"
        : null,
      terminalSourceId: terminal
        ? options.terminalSourceId ?? task.id
        : null,
      terminalAudit: terminal ? options.terminalAudit ?? {} : null,
      terminalizedAt: terminal ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!edge) {
    throw new OrdinaryTaskRuntimeRejected(
      "Creator edge was not persisted",
      "creator_edge_missing",
    );
  }
  return edge;
}

async function inspectCreatorEndpoint(
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
                eq(
                  taskExecutionAuthorities.companyId,
                  task.companyId,
                ),
                eq(
                  taskExecutionAuthorities.id,
                  task.creatorAuthorityId,
                ),
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
        .where(
          and(
            eq(agents.companyId, task.companyId),
            eq(agents.id, authority.agentId),
          ),
        )
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
      if (
        !plugin ||
        plugin.pluginKey !== task.creatorPluginKey
      ) {
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
            .where(
              and(
                eq(routines.companyId, task.companyId),
                eq(routines.id, task.creatorRoutineId),
              ),
            )
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

async function lockReopenCreatorEdge(
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
        eq(
          taskCreatorEdgeReceivability.ownershipEpoch,
          task.ownershipEpoch!,
        ),
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

async function ensureReopenCreatorEdge(
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

function invalidSystemEscalationReopen(message: string): never {
  throw new OrdinaryTaskRuntimeRejected(
    message,
    "board_reopen_escalation_invalid",
  );
}

function exactSystemEscalationProvenance(
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
    Object.keys(source).sort().join("\0") !==
      expectedSourceKeys.sort().join("\0") ||
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
    invalidSystemEscalationReopen(
      "Board-only reopen requires exact immutable system-escalation provenance",
    );
  }
}

async function lockSystemEscalationReopenIdentity(
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
    invalidSystemEscalationReopen(
      "Board-only reopen requires one exact system-escalation identity",
    );
  }
  const identity = identities[0]!;
  const terminalEdges = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(
          taskCreatorEdgeReceivability.companyId,
          identity.companyId,
        ),
        eq(
          taskCreatorEdgeReceivability.id,
          identity.terminalCreatorEdgeId,
        ),
      ),
    )
    .limit(2)
    .for("update");
  if (terminalEdges.length !== 1) {
    invalidSystemEscalationReopen(
      "System-escalation identity lost its exact terminal creator edge",
    );
  }
  exactSystemEscalationProvenance(task, identity, terminalEdges[0]!);
  return identity;
}

async function applyBoardReopenContinuityFence(
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
        eq(
          taskExecutionSessions.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .for("update");
  const liveCapabilities = await tx
    .select({
      connectionId:
        taskExecutionPromptCapabilities.capabilityConnectionId,
      generation:
        taskExecutionPromptCapabilities.capabilityGeneration,
    })
    .from(taskExecutionPromptCapabilities)
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
    Math.max(
      0,
      ...correlations.map((row) => row.generation),
      ...priorFences.map((row) => row.generation),
    ) + 1;
  if (
    !Number.isSafeInteger(continuityFenceGeneration) ||
    continuityFenceGeneration > 2_147_483_647
  ) {
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
        eq(
          taskExecutionPromptCapabilities.ownershipEpoch,
          input.ownershipEpoch,
        ),
        inArray(taskExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    )
    .returning({
      connectionId:
        taskExecutionPromptCapabilities.capabilityConnectionId,
      generation:
        taskExecutionPromptCapabilities.capabilityGeneration,
    });
  if (revoked.length !== liveCapabilities.length) {
    throw new OrdinaryTaskRuntimeRejected(
      "Board reopen lost a locked prompt-capability fence winner",
      "board_reopen_capability_conflict",
    );
  }
  return continuityFenceGeneration;
}

/**
 * The ordinary-task boundary preserves its public rejection shape while the
 * actual owner/revision predicate is shared with every catalog and owner
 * configuration surface.
 */
async function resolveOrdinaryTaskOwner(
  tx: TaskSessionDbTransaction,
  companyId: string,
  ownerAgentId: string,
): Promise<Awaited<ReturnType<typeof resolveInvokableTaskOwnerInTransaction>>> {
  try {
    return await resolveInvokableTaskOwnerInTransaction(tx, {
      companyId,
      ownerAgentId,
    });
  } catch (error) {
    if (error instanceof InvokableTaskOwnerRejected) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}

async function assertCreateReferences(
  tx: TaskSessionDbTransaction,
  input: OrdinaryTaskCreateInput,
): Promise<void> {
  if (input.labelIds?.length) {
    const existingLabels = await tx
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.companyId, input.companyId),
          inArray(labels.id, input.labelIds),
        ),
      );
    if (existingLabels.length !== input.labelIds.length) {
      throw new OrdinaryTaskRuntimeRejected(
        "One or more labels are invalid for this company",
        "labels_invalid",
      );
    }
  }
  if (input.parentId) {
    const parent = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, input.companyId),
          eq(tasks.id, input.parentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!parent) {
      throw new OrdinaryTaskRuntimeRejected(
        "Parent task is not in this company",
        "parent_task_invalid",
      );
    }
  }
  if (input.projectId) {
    const project = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, input.companyId),
          eq(projects.id, input.projectId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!project) {
      throw new OrdinaryTaskRuntimeRejected(
        "Project is not in this company",
        "project_invalid",
      );
    }
  }
}

function sameCreator(
  task: TaskRow,
  creator: OrdinaryTaskCreator,
): boolean {
  if (creator.kind === "user/board") {
    return (
      task.creatorKind === creator.kind &&
      task.creatorUserId === creator.userId
    );
  }
  if (creator.kind === "plugin") {
    return (
      task.creatorKind === creator.kind &&
      task.creatorPluginInstallationId === creator.pluginInstallationId &&
      task.creatorPluginKey === creator.pluginKey &&
      task.creatorCallbackKey === creator.callbackKey &&
      task.creatorCallbackVersion === creator.callbackVersion
    );
  }
  return (
    task.creatorKind === creator.kind &&
    task.creatorRoutineId === creator.routineId &&
    task.creatorRoutineDispatchId === creator.routineDispatchId
  );
}

export function createOrdinaryTaskRuntime(
  db: Db,
  options: OrdinaryTaskRuntimeOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createTaskSessionAdmissionService(db, { clock });
  const taskForms = createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  async function dispatch(refId: string): Promise<void> {
    await options.dispatchRef(refId);
  }

  async function commitAgentOwnerReassignmentInTransaction(
    tx: TaskSessionDbTransaction,
    input: {
      task: TaskRow;
      ownerAgentId: string;
      idempotencyKey: string;
      sourceAuthorityId: string;
      cancellationActor: TaskExecutionCancellationActor;
      comment: TaskSessionProjectedCommentSource;
      sourceActor: Extract<
        TaskSessionExecutionActor,
        { kind: "user/board" | "agent-execution" | "plugin" }
      >;
      provenanceUserId: string | null;
      ownerResolution: Awaited<
        ReturnType<typeof resolveOrdinaryTaskOwner>
      >;
    },
  ) {
    const task = input.task;
    if (
      !task.ownershipEpoch ||
      task.ownerKind !== "agent" ||
      !task.ownerAgentId ||
      !task.request ||
      !task.lifecycleStatus ||
      !NONTERMINAL.has(task.lifecycleStatus)
    ) {
      throw new OrdinaryTaskRuntimeRejected(
        "Reassignment requires a nonterminal agent-owned task",
        "reassignment_target_invalid",
      );
    }
    if (task.ownerAgentId === input.ownerAgentId) {
      throw new OrdinaryTaskRuntimeRejected(
        "Selected owner already owns this task",
        "reassignment_owner_unchanged",
      );
    }
    const sessionState = await lockTaskSessionState(
      tx,
      task.companyId,
      task.id,
    );
    if (!sessionState) {
      throw new OrdinaryTaskRuntimeRejected(
        "Reassignment target Session is missing",
        "reassignment_session_missing",
      );
    }
    const { session } = sessionState;
    const outgoingAuthority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, task.companyId),
          eq(taskExecutionAuthorities.taskId, task.id),
          eq(
            taskExecutionAuthorities.ownershipEpoch,
            task.ownershipEpoch,
          ),
          eq(
            taskExecutionAuthorities.agentId,
            task.ownerAgentId,
          ),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!outgoingAuthority) {
      throw new OrdinaryTaskRuntimeRejected(
        "Outgoing owner authority is missing",
        "reassignment_authority_missing",
      );
    }
    const now = clock();
    const revocation =
      await revokeOutgoingOwnershipEpoch(
        tx,
        sessions,
        options.taskExecutionCancellation,
        {
          companyId: task.companyId,
          taskId: task.id,
          sessionId: session.id,
          ownershipEpoch: task.ownershipEpoch,
          authorityId: outgoingAuthority.id,
          sourceAuthorityId: input.sourceAuthorityId,
          cancellationActor: input.cancellationActor,
          now,
        },
      );
    const ownershipEpoch = task.ownershipEpoch + 1;
    const authorityId = deterministicUuid(
      "task-execution-authority",
      `${task.id}:${ownershipEpoch}:${input.ownerAgentId}`,
    );
    const reassigned = await tx
      .update(tasks)
      .set({
        ownerKind: "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        ownerAssignmentSource: null,
        ownershipEpoch,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.companyId, task.companyId),
          eq(tasks.id, task.id),
          eq(tasks.ownershipEpoch, task.ownershipEpoch),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!reassigned) {
      throw new OrdinaryTaskRuntimeRejected(
        "Ownership epoch changed during reassignment",
        "reassignment_epoch_conflict",
      );
    }
    const workspaceReservation =
      await withOrdinaryWorkspaceReservationErrors(() =>
        reserveTaskExecutionWorkspaceBinding(tx, {
          task: reassigned,
          session: {
            id: session.id,
            now,
          },
          provenance: {
            agentId: null,
            userId: input.provenanceUserId,
          },
        }),
      );
    await tx.insert(taskExecutionAuthorities).values({
      id: authorityId,
      companyId: task.companyId,
      taskId: task.id,
      sessionId: session.id,
      ownershipEpoch,
      agentId: input.ownerAgentId,
      auditAdapterConfigRevisionId:
        input.ownerResolution.revisionId,
      state: "current",
      createdAt: now,
    });
    await insertCreatorEdge(tx, reassigned, session.id, now);
    const admission = await admitTaskExecutionInTransaction({
      sessionAdmission: sessions,
      transaction: tx,
      work: {
        companyId: task.companyId,
        taskId: task.id,
        sessionId: session.id,
        ownershipEpoch,
        targetAgentId: input.ownerAgentId,
        taskExecutionAuthorityId: authorityId,
        consultExecutionId: null,
        adapterConfigRevisionId:
          input.ownerResolution.revisionId,
        contextEpoch:
          workspaceReservation.contextEpochGeneration,
        mode: "owner",
        sourceKind: "task_reassignment",
        actor: input.sourceActor,
        previousOwnershipEpoch: task.ownershipEpoch,
        immutableSourceKey: input.idempotencyKey,
        sourceRecordId: task.id,
        exactText: task.request,
        comment: input.comment,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!admission.ref) {
      throw new OrdinaryTaskRuntimeRejected(
        "Reassignment did not persist an owner execution ref",
        "reassignment_ref_missing",
      );
    }
    return {
      task: reassigned,
      ref: admission.ref,
      escalationDispatchRefIds:
        revocation.escalationDispatchRefIds,
      cancellations: revocation.cancellations,
      retried: false as const,
    };
  }

  return {
    dispatchRef: dispatch,
    async create(
      rawInput: OrdinaryTaskCreateInput,
    ): Promise<OrdinaryTaskCreateResult> {
      const input = {
        ...rawInput,
        request: nonBlankPreservingBytes(rawInput.request, "request"),
        ownerAgentId: nonEmpty(rawInput.ownerAgentId, "ownerAgentId"),
        idempotencyKey: nonEmpty(rawInput.idempotencyKey, "idempotencyKey"),
        labelIds: [...new Set(rawInput.labelIds ?? [])],
      };
      if (input.priority && !PRIORITIES.has(input.priority)) {
        throw new OrdinaryTaskRuntimeRejected(
          "Task priority is invalid",
          "priority_invalid",
        );
      }
      const key = `ordinary-task-create:${input.companyId}:${input.idempotencyKey}`;
      const taskId = input.taskId?.trim() || deterministicUuid("ordinary-task", key);
      const sessionId = stableSessionId(key);

      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
        );
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedTaskOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId:
                  input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "tasks.create",
                ownerAgentId: input.ownerAgentId,
              })
            : null;
        const existing = await tx
          .select({ task: tasks })
          .from(taskCreateIdempotencyKeys)
          .innerJoin(
            tasks,
            eq(tasks.id, taskCreateIdempotencyKeys.taskId),
          )
          .where(
            and(
              eq(taskCreateIdempotencyKeys.companyId, input.companyId),
              eq(taskCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]?.task ?? null);
        if (existing) {
          if (
            existing.id !== taskId ||
            existing.request !== input.request ||
            existing.ownerAgentId !== input.ownerAgentId ||
            existing.title !== (input.title ?? null) ||
            existing.projectId !== (input.projectId ?? null) ||
            (input.projectWorkspaceId != null &&
              existing.projectWorkspaceId !== input.projectWorkspaceId) ||
            existing.goalId !== (input.goalId ?? null) ||
            existing.parentId !== (input.parentId ?? null) ||
            existing.priority !== (input.priority ?? "medium") ||
            existing.responsibleUserId !==
              (input.responsibleUserId ?? null) ||
            existing.originKind !== (input.originKind ?? "manual") ||
            existing.originId !== (input.originId ?? null) ||
            existing.originRunId !== (input.originRunId ?? null) ||
            existing.originFingerprint !==
              (input.originFingerprint ?? key) ||
            existing.billingCode !== (input.billingCode ?? null) ||
            !sameCreator(existing, input.creator)
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Task creation idempotency key was retried with different immutable input",
              "create_idempotency_conflict",
            );
          }
          const [session, authority, ref] = await Promise.all([
            tx
              .select()
              .from(taskSessions)
              .where(eq(taskSessions.taskId, existing.id))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskExecutionAuthorities)
              .where(
                and(
                  eq(taskExecutionAuthorities.taskId, existing.id),
                  eq(taskExecutionAuthorities.ownershipEpoch, 1),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.companyId),
                  eq(taskExecutionRefs.deliveryIdempotencyKey, key),
                ),
              )
              .then((rows) => rows[0] ?? null),
          ]);
          if (!session || !authority || !ref) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted task creation is missing canonical runtime records",
              "canonical_create_incomplete",
            );
          }
          return {
            task: existing,
            sessionId: session.id,
            authorityId: authority.id,
            ref,
            retried: true,
          };
        }

        await tx.execute(
          sql`select ${companies.id} from ${companies} where ${companies.id} = ${input.companyId} for update`,
        );
        const company = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, input.companyId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (
          !company ||
          company.status !== "active" ||
          company.sessionIntegrityState !== "ready" ||
          company.hardDeleteFencedAt !== null
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Company Session lifecycle is not ready",
            "company_inactive",
          );
        }
        if (input.creator.kind === "plugin") {
          if (input.creator.callbackRegistrationActive !== true) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin creator callback is not registered",
              "plugin_callback_missing",
            );
          }
        }
        await assertCreateReferences(tx, input);
        const { owner, revisionId } =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await resolveOrdinaryTaskOwner(
                tx,
                input.companyId,
                input.ownerAgentId,
              );
        const now = clock();
        const maxTaskNumber = await tx
          .select({
            value: sql<number>`coalesce(max(${tasks.taskNumber}), 0)`,
          })
          .from(tasks)
          .where(eq(tasks.companyId, input.companyId))
          .then((rows) => rows[0]?.value ?? 0);
        const taskNumber =
          Math.max(company.taskCounter, maxTaskNumber) + 1;
        await tx
          .update(companies)
          .set({ taskCounter: taskNumber, updatedAt: now })
          .where(eq(companies.id, input.companyId));
        const identifier = `${company.taskPrefix}-${taskNumber}`;
        const authorityId = deterministicUuid(
          "task-execution-authority",
          `${taskId}:1:${owner.id}`,
        );
        const aggregate =
          await withOrdinaryWorkspaceReservationErrors(() =>
            persistCanonicalTaskAggregateInTx(tx, {
            task: {
            id: taskId,
            companyId: input.companyId,
            projectId: input.projectId ?? null,
            projectWorkspaceId: input.projectWorkspaceId ?? null,
            goalId: input.goalId ?? null,
            parentId: input.parentId ?? null,
            title: input.title?.trim() || null,
            request: input.request,
            boardPresentationStatus: "todo",
            lifecycleStatus: "open",
            disposition: null,
            workMode: input.workMode ?? "standard",
            harnessKind: input.harnessKind ?? null,
            priority: input.priority ?? "medium",
            ownerKind: "agent",
            ownerAgentId: owner.id,
            ownerUserId: null,
            ownerAssignmentSource: null,
            ownershipEpoch: 1,
            ...creatorColumns(input.creator),
            responsibleUserId: input.responsibleUserId ?? null,
            taskNumber,
            identifier,
            originKind: input.originKind ?? "manual",
            originId: input.originId ?? null,
            originRunId: input.originRunId ?? null,
            originFingerprint: input.originFingerprint ?? key,
            billingCode: input.billingCode ?? null,
            requestDepth: input.parentId ? 1 : 0,
            createdAt: now,
            updatedAt: now,
            },
            session: {
              id: sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: null,
                userId:
                input.creator.kind === "user/board"
                  ? input.creator.userId
                  : null,
              },
            },
            authority: {
              id: authorityId,
              agentId: owner.id,
              auditAdapterConfigRevisionId: revisionId,
              createdAt: now,
            },
            idempotency: { key },
            }),
          );
        const created = aggregate.task;
        if (input.labelIds.length > 0) {
          await tx.insert(taskLabels).values(
            input.labelIds.map((labelId) => ({
              taskId: created.id,
              labelId,
              companyId: input.companyId,
            })),
          );
        }
        const sessionRoot = aggregate.sessionRoot;
        const executionSource = executionSourceForOrdinaryCreate(input);
        const scope = {
          companyId: created.companyId,
          taskId: created.id,
          sessionId,
          ownershipEpoch: 1,
          targetAgentId: owner.id,
          taskExecutionAuthorityId: authorityId,
          consultExecutionId: null,
          adapterConfigRevisionId: revisionId,
          contextEpoch: sessionRoot.contextEpoch.generation,
          mode: "owner" as const,
        };
        const work = {
          ...scope,
          ...executionSource,
          immutableSourceKey: key,
          sourceRecordId: created.id,
          exactText: input.request,
          comment: projectedCommentSource(input.creator),
          idempotencyKey: key,
        };
        const admission = await admitTaskExecutionInTransaction({
          sessionAdmission: sessions,
          transaction: tx,
          work,
        });
        if (!admission.ref) {
          throw new OrdinaryTaskRuntimeRejected(
            "Initial owner execution ref was not persisted",
            "initial_ref_missing",
          );
        }
        await input.correlate?.(tx, {
          task: created,
          sessionId,
          authorityId,
          ref: admission.ref,
        });
        return {
          task: created,
          sessionId,
          authorityId,
          ref: admission.ref,
          retried: false,
        };
      });
      await dispatch(result.ref.id);
      return result;
    },

    async boardReopen(input: OrdinaryTaskBoardReopenInput) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const reason = nonBlankPreservingBytes(input.reason, "reason");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const commandId = deterministicUuid(
        "board-reopen-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            contract: "ordinary-board-reopen/v2",
            companyId: input.companyId,
            taskId: input.taskId,
            actorUserId,
            reason,
            idempotencyKey,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reopen:${idempotencyKey}`}, 0))`,
        );
        const actor = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.id, actorUserId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!actor) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen requires an authenticated named board user",
            "board_reopen_actor_invalid",
          );
        }
        const priorCommands = await tx
          .select()
          .from(taskBoardReopenCommands)
          .where(
            and(
              eq(taskBoardReopenCommands.companyId, input.companyId),
              eq(
                taskBoardReopenCommands.idempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(2)
          .for("update");
        if (priorCommands.length > 1) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen idempotency identity is ambiguous",
            "board_reopen_incomplete",
          );
        }
        const priorCommand = priorCommands[0] ?? null;
        if (priorCommand) {
          if (
            priorCommand.identityDigest !== identityDigest ||
            priorCommand.taskId !== input.taskId ||
            priorCommand.actorUserId !== actorUserId ||
            priorCommand.reason !== reason
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board reopen idempotency key changed immutable input",
              "board_reopen_idempotency_conflict",
            );
          }
          const taskRows = await tx
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, input.companyId),
                eq(tasks.id, priorCommand.taskId),
              ),
            )
            .limit(2)
            .for("update");
          const edgeRows = await tx
            .select()
            .from(taskCreatorEdgeReceivability)
            .where(
              and(
                eq(
                  taskCreatorEdgeReceivability.companyId,
                  input.companyId,
                ),
                eq(
                  taskCreatorEdgeReceivability.taskId,
                  priorCommand.taskId,
                ),
                eq(
                  taskCreatorEdgeReceivability.ownershipEpoch,
                  priorCommand.ownershipEpoch,
                ),
                eq(
                  taskCreatorEdgeReceivability.id,
                  priorCommand.creatorEdgeId,
                ),
              ),
            )
            .limit(2)
            .for("update");
          if (
            taskRows.length !== 1 ||
            edgeRows.length !== 1 ||
            priorCommand.continuityFenceGeneration <= 0
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board reopen is missing canonical records",
              "board_reopen_incomplete",
            );
          }
          const task = taskRows[0]!;
          const edge = edgeRows[0]!;
          if (priorCommand.branch === "agent_execution") {
            if (
              priorCommand.preservedOwnerKind !== "agent" ||
              !priorCommand.executionRefId ||
              priorCommand.systemEscalationIdentityId !== null
            ) {
              throw new OrdinaryTaskRuntimeRejected(
                "Accepted agent board reopen has an invalid checked branch",
                "board_reopen_incomplete",
              );
            }
            const refs = await tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.companyId),
                  eq(taskExecutionRefs.taskId, priorCommand.taskId),
                  eq(taskExecutionRefs.id, priorCommand.executionRefId),
                ),
              )
              .limit(2)
              .for("update");
            const executionRef = refs[0] ?? null;
            if (
              refs.length !== 1 ||
              !executionRef ||
              executionRef.ownershipEpoch !== priorCommand.ownershipEpoch ||
              executionRef.mode !== "owner" ||
              executionRef.sourceKind !== "task_reopen" ||
              executionRef.sourceRecordId !== priorCommand.id ||
              executionRef.exactMessage !== task.request ||
              executionRef.deliveryIdempotencyKey !==
                `board-reopen:${input.companyId}:${idempotencyKey}` ||
              executionRef.taskExecutionAuthorityId === null
            ) {
              throw new OrdinaryTaskRuntimeRejected(
                "Accepted agent board reopen lost its exact execution ref",
                "board_reopen_incomplete",
              );
            }
            return {
              task,
              edge,
              command: priorCommand,
              dispatch: {
                kind: "agent_execution",
                executionRef:
                  projectPersistedTaskExecutionRef(executionRef),
              } satisfies TaskBoardReopenDispatch,
              escalationDispatchRefId: null,
              cancellations: null,
              retried: true as const,
            };
          }
          if (
            priorCommand.branch !== "board_only" ||
            !["user", "board"].includes(
              priorCommand.preservedOwnerKind,
            ) ||
            priorCommand.executionRefId !== null ||
            !priorCommand.systemEscalationIdentityId
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board-only reopen has an invalid checked branch",
              "board_reopen_incomplete",
            );
          }
          const escalationIdentity =
            await lockSystemEscalationReopenIdentity(tx, task);
          if (
            escalationIdentity.id !==
            priorCommand.systemEscalationIdentityId
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board-only reopen lost its exact escalation identity",
              "board_reopen_incomplete",
            );
          }
          return {
            task,
            edge,
            command: priorCommand,
            dispatch: { kind: "board_only" } satisfies TaskBoardReopenDispatch,
            escalationDispatchRefId: null,
            cancellations: null,
            retried: true as const,
          };
        }

        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !Number.isInteger(task.ownershipEpoch) ||
          task.ownershipEpoch <= 0 ||
          (task.lifecycleStatus !== "done" &&
            task.lifecycleStatus !== "cancelled") ||
          !task.disposition
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen requires a terminal task with a disposition",
            "board_reopen_target_invalid",
          );
        }
        const priorStatus = task.lifecycleStatus;
        const priorDisposition = task.disposition;
        const sessionState = await lockTaskSessionState(
          tx,
          input.companyId,
          task.id,
        );
        if (
          !sessionState ||
          sessionState.session.integrityState !== "ready" ||
          sessionState.session.timeArchived !== null ||
          sessionState.session.purgeFencedAt !== null
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen target Session is lifecycle-fenced",
            "board_reopen_session_invalid",
          );
        }
        const { session, contextGeneration } = sessionState;
        const existingEdge = await lockReopenCreatorEdge(tx, task);
        const endpointState = await inspectCreatorEndpoint(tx, task);

        let branch: "agent_execution" | "board_only";
        let preservedOwnerKind: "agent" | "user" | "board";
        let authority: typeof taskExecutionAuthorities.$inferSelect | null =
          null;
        let revisionId: string | null = null;
        let ownerAgentId: string | null = null;
        let escalationIdentity: SystemEscalationIdentityRow | null = null;
        if (task.ownerKind === "agent" && task.ownerAgentId) {
          const resolution = await resolveOrdinaryTaskOwner(
            tx,
            input.companyId,
            task.ownerAgentId,
          );
          const authorities = await tx
            .select()
            .from(taskExecutionAuthorities)
            .where(
              and(
                eq(taskExecutionAuthorities.companyId, input.companyId),
                eq(taskExecutionAuthorities.taskId, task.id),
                eq(
                  taskExecutionAuthorities.ownershipEpoch,
                  task.ownershipEpoch,
                ),
                eq(
                  taskExecutionAuthorities.agentId,
                  task.ownerAgentId,
                ),
                eq(taskExecutionAuthorities.state, "current"),
              ),
            )
            .limit(2)
            .for("update");
          if (
            authorities.length !== 1 ||
            authorities[0]!.sessionId !== session.id
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board reopen owner authority is missing",
              "board_reopen_authority_missing",
            );
          }
          branch = "agent_execution";
          preservedOwnerKind = "agent";
          authority = authorities[0]!;
          revisionId = resolution.revisionId;
          ownerAgentId = task.ownerAgentId;
        } else if (
          task.ownerKind === "user" &&
          task.ownerAssignmentSource === "user_creator_withdrawal"
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "A named-user creator withdrawal cannot be reopened",
            "board_reopen_target_invalid",
          );
        } else if (
          (task.ownerKind === "user" && task.ownerUserId) ||
          task.ownerKind === "board"
        ) {
          if (
            task.ownerAssignmentSource !== null ||
            task.creatorKind !== "system"
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Only a valid named-user or collective-board system escalation reopens without execution",
              "board_reopen_target_invalid",
            );
          }
          escalationIdentity =
            await lockSystemEscalationReopenIdentity(tx, task);
          branch = "board_only";
          preservedOwnerKind = task.ownerKind;
        } else {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen owner is outside the two canonical branches",
            "board_reopen_target_invalid",
          );
        }

        const now = clock();
        const cancellations =
          await options.taskExecutionCancellation
            .requestScopeCancellationsInTransaction(tx, {
              companyId: input.companyId,
              taskId: task.id,
              selector: {
                kind: "ownership_epoch",
                ownershipEpoch: task.ownershipEpoch,
              },
              reason: "board_reopen_continuity_fence",
              actor: { kind: "user", userId: actorUserId },
              now,
            });
        const continuityFenceGeneration =
          await applyBoardReopenContinuityFence(tx, {
            companyId: input.companyId,
            taskId: task.id,
            ownershipEpoch: task.ownershipEpoch,
            at: now,
          });
        const reopened = await tx
          .update(tasks)
          .set({
            lifecycleStatus: "open",
            disposition: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, task.id),
              eq(tasks.ownershipEpoch, task.ownershipEpoch),
              eq(tasks.lifecycleStatus, priorStatus),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reopened) {
          throw new OrdinaryTaskRuntimeRejected(
            "Task changed while reopening",
            "board_reopen_lifecycle_conflict",
          );
        }
        const edge = await ensureReopenCreatorEdge(tx, {
          task: reopened,
          sessionId: session.id,
          existing: existingEdge,
          endpointState,
          commandId,
          actorUserId,
          reason,
          now,
        });
        let executionRef: typeof taskExecutionRefs.$inferSelect | null = null;
        if (branch === "agent_execution") {
          if (!authority || !revisionId || !ownerAgentId) {
            throw new OrdinaryTaskRuntimeRejected(
              "Agent board reopen lost its locked owner authority",
              "board_reopen_authority_missing",
            );
          }
          const sourceKey =
            `board-reopen:${input.companyId}:${idempotencyKey}`;
          const admission = await sessions.admitExecutionSource(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch: task.ownershipEpoch,
              targetAgentId: ownerAgentId,
              taskExecutionAuthorityId: authority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "task_reopen",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: task.request,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
              },
              idempotencyKey: sourceKey,
            },
            tx,
          );
          if (!admission.ref) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board reopen did not persist an execution ref",
              "board_reopen_ref_missing",
            );
          }
          executionRef = admission.ref;
        }
        const command = await tx
          .insert(taskBoardReopenCommands)
          .values({
            id: commandId,
            companyId: input.companyId,
            taskId: task.id,
            actorUserId,
            reason,
            idempotencyKey,
            identityDigest,
            priorStatus,
            priorDisposition,
            ownershipEpoch: task.ownershipEpoch,
            branch,
            preservedOwnerKind,
            continuityFenceGeneration,
            creatorEdgeId: edge.id,
            executionRefId: executionRef?.id ?? null,
            systemEscalationIdentityId: escalationIdentity?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reopen audit command was not persisted",
            "board_reopen_audit_missing",
          );
        }
        const escalation =
          edge.state === "terminal" && reopened.creatorKind !== "system"
            ? await ensureSystemEscalationInTransaction(
                tx,
                sessions,
                {
                  companyId: input.companyId,
                  affectedTaskId: reopened.id,
                  affectedOwnershipEpoch: reopened.ownershipEpoch,
                  terminalCreatorEdgeId: edge.id,
                  systemSource: "recovery",
                  triggeringRunId: null,
                  causalSourceId: command.id,
                },
                clock,
              )
            : null;
        if (branch === "agent_execution") {
          if (!executionRef) {
            throw new OrdinaryTaskRuntimeRejected(
              "Agent board reopen lost its checked execution ref",
              "board_reopen_ref_missing",
            );
          }
          return {
            task: reopened,
            edge,
            command,
            dispatch: {
              kind: "agent_execution",
              executionRef:
                projectPersistedTaskExecutionRef(executionRef),
            } satisfies TaskBoardReopenDispatch,
            escalationDispatchRefId: escalation?.dispatchRefId ?? null,
            cancellations,
            retried: false as const,
          };
        }
        return {
          task: reopened,
          edge,
          command,
          dispatch: { kind: "board_only" } satisfies TaskBoardReopenDispatch,
          escalationDispatchRefId: escalation?.dispatchRefId ?? null,
          cancellations,
          retried: false as const,
        };
      });
      if (result.cancellations) {
        void options.taskExecutionCancellation
          .reconcileRequestedCancellations(result.cancellations)
          .catch(() => {
            // The committed lifecycle fence keeps the prior refs ineligible.
          });
      }
      if (result.dispatch.kind === "agent_execution") {
        await dispatch(result.dispatch.executionRef.id);
      }
      if (result.escalationDispatchRefId) {
        await dispatch(result.escalationDispatchRefId);
      }
      const {
        escalationDispatchRefId: _,
        cancellations: __,
        ...publicResult
      } = result;
      return publicResult;
    },

    async userComment(input: OrdinaryTaskUserCommentInput) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const message = nonBlankPreservingBytes(input.message, "message");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const mention =
        input.mention == null
          ? null
          : {
              targetAgentId: nonEmpty(
                input.mention.targetAgentId,
                "mention.targetAgentId",
              ),
              ownershipEpoch: input.mention.ownershipEpoch,
            };
      const replyToCommentId = input.replyToCommentId == null
        ? null
        : nonEmpty(input.replyToCommentId, "replyToCommentId");
      if (mention && replyToCommentId) {
        throw new OrdinaryTaskRuntimeRejected(
          "A board comment cannot mention an agent and reply to a comment at the same time",
          "human_comment_target_conflict",
        );
      }
      if (
        mention &&
        (!Number.isInteger(mention.ownershipEpoch) ||
          mention.ownershipEpoch <= 0)
      ) {
        throw new OrdinaryTaskRuntimeRejected(
          "Mention ownership epoch must be a positive integer",
          "human_mention_epoch_invalid",
        );
      }
      const commandId = deterministicUuid(
        "board-user-comment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            contract: "ordinary-board-user-comment/v2",
            companyId: input.companyId,
            taskId: input.taskId,
            actorUserId,
            message,
            idempotencyKey,
            mention,
            replyToCommentId,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-user-comment:${idempotencyKey}`}, 0))`,
        );
        const priorCommand = await tx
          .select()
          .from(taskBoardUserComments)
          .where(
            and(
              eq(taskBoardUserComments.companyId, input.companyId),
              eq(taskBoardUserComments.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorCommand) {
          if (
            priorCommand.identityDigest !== identityDigest ||
            priorCommand.taskId !== input.taskId ||
            priorCommand.actorUserId !== actorUserId
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board comment idempotency key changed immutable input",
              "board_comment_idempotency_conflict",
            );
          }
          const [task, comment, ref, commentSource] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(
                and(
                  eq(tasks.companyId, input.companyId),
                  eq(tasks.id, priorCommand.taskId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskComments)
              .where(eq(taskComments.id, priorCommand.commentId))
              .then((rows) => rows[0] ?? null),
            priorCommand.executionRefId
              ? tx
                  .select()
                  .from(taskExecutionRefs)
                  .where(
                    eq(
                      taskExecutionRefs.id,
                      priorCommand.executionRefId,
                    ),
                  )
                  .then((rows) => rows[0] ?? null)
              : Promise.resolve(null),
            tx
              .select()
              .from(taskCommentProjectionSources)
              .where(
                eq(
                  taskCommentProjectionSources.commentId,
                  priorCommand.commentId,
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !task ||
            !comment ||
            !commentSource ||
            (priorCommand.executionRefId !== null && !ref)
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board comment is missing canonical records",
              "board_comment_incomplete",
            );
          }
          return {
            task,
            comment,
            ref,
            command: priorCommand,
            steeringSourceCommentId:
              commentSource.steeringTargetRunId === null
                ? null
                : comment.id,
            retried: true,
          };
        }

        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!task || !task.lifecycleStatus || !task.ownershipEpoch) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board comments require a canonical ordinary task",
            "board_comment_target_invalid",
          );
        }
        const sessionState = await lockTaskSessionState(
          tx,
          input.companyId,
          task.id,
        );
        if (!sessionState) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board comment target Session is missing",
            "board_comment_session_missing",
          );
        }
        const { session, contextGeneration } = sessionState;
        const replyParent = replyToCommentId
          ? await tx
              .select()
              .from(taskComments)
              .where(
                and(
                  eq(taskComments.companyId, input.companyId),
                  eq(taskComments.taskId, task.id),
                  eq(taskComments.id, replyToCommentId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
        if (replyToCommentId && !replyParent) {
          throw new OrdinaryTaskRuntimeRejected(
            "Reply target is not a persisted comment on this task",
            "human_reply_parent_missing",
          );
        }
        const sourceKey = `board-user-comment:${input.companyId}:${idempotencyKey}`;
        let admission: TaskSessionAdmissionResult;
        let steeringRequested = false;
        if (mention) {
          if (
            !NONTERMINAL.has(task.lifecycleStatus) ||
            task.ownerKind !== "agent" ||
            !task.ownerAgentId ||
            task.ownerAgentId !== mention.targetAgentId ||
            task.ownershipEpoch !== mention.ownershipEpoch
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Mention target must be the exact current owner and ownership epoch",
              "human_mention_scope_invalid",
            );
          }
          const { revisionId } = await resolveOrdinaryTaskOwner(
            tx,
            input.companyId,
            task.ownerAgentId,
          );
          const authority = await tx
            .select()
            .from(taskExecutionAuthorities)
            .where(
              and(
                eq(
                  taskExecutionAuthorities.companyId,
                  input.companyId,
                ),
                eq(taskExecutionAuthorities.taskId, task.id),
                eq(
                  taskExecutionAuthorities.ownershipEpoch,
                  mention.ownershipEpoch,
                ),
                eq(
                  taskExecutionAuthorities.agentId,
                  mention.targetAgentId,
                ),
                eq(taskExecutionAuthorities.state, "current"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!authority) {
            throw new OrdinaryTaskRuntimeRejected(
              "Mention target authority is missing",
              "human_mention_authority_missing",
            );
          }
          admission = await sessions.admitExecutionSource(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch: mention.ownershipEpoch,
              targetAgentId: mention.targetAgentId,
              taskExecutionAuthorityId: authority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "human_comment_mention",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
              },
              idempotencyKey: sourceKey,
            },
            tx,
          );
        } else if (replyParent?.runId) {
          if (!replyParent.authorAgentId) {
            throw new OrdinaryTaskRuntimeRejected(
              "A run-attributed reply target must have one canonical producing agent",
              "human_reply_run_not_steerable",
            );
          }
          admission = await sessions.admitSteeringComment(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              sourceKind: "human_comment",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
              },
            },
            tx,
          );
          if (!admission.comment || !admission.input || admission.ref) {
            throw new OrdinaryTaskRuntimeRejected(
              "Run steering did not persist its canonical comment and Session input",
              "board_comment_projection_missing",
            );
          }
          await withOrdinaryHumanSteeringErrors(() =>
            options.taskExecutionRunService.requestSteeringInTransaction(
              tx,
              {
                companyId: input.companyId,
                taskId: task.id,
                ownershipEpoch: task.ownershipEpoch,
                runId: replyParent.runId!,
                targetAgentId: replyParent.authorAgentId!,
                exactMessage: message,
                sourceCommentId: admission.comment!.id,
                sourceMessageId: admission.source.messageId,
                sourceInputId: admission.input!.id,
                actor: { kind: "user", userId: actorUserId },
              },
            ),
          );
          steeringRequested = true;
        } else {
          admission = await sessions.appendNonDispatchUserComment(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              sourceKind: "human_comment",
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              delivery: "queue",
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
              },
            },
            tx,
          );
        }
        if (
          !admission.comment ||
          (mention !== null && !admission.ref) ||
          (steeringRequested && (!admission.input || admission.ref !== null))
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board comment did not persist its canonical projection",
            "board_comment_projection_missing",
          );
        }
        const now = clock();
        const command = await tx
          .insert(taskBoardUserComments)
          .values({
            id: commandId,
            companyId: input.companyId,
            taskId: task.id,
            ownershipEpoch: task.ownershipEpoch,
            actorUserId,
            idempotencyKey,
            identityDigest,
            mentionTargetAgentId: mention?.targetAgentId ?? null,
            commentId: admission.comment.id,
            executionRefId: admission.ref?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board comment command was not persisted",
            "board_comment_audit_missing",
          );
        }
        return {
          task,
          comment: admission.comment,
          ref: admission.ref,
          command,
          steeringSourceCommentId: steeringRequested
            ? admission.comment.id
            : null,
          retried: false,
        };
      });
      if (result.ref) {
        await dispatch(result.ref.id);
      }
      if (result.steeringSourceCommentId) {
        await withOrdinaryHumanSteeringErrors(() =>
          options.taskExecutionRunService.continuePendingSteeringForSource({
            companyId: result.task.companyId,
            taskId: result.task.id,
            sourceCommentId: result.steeringSourceCommentId!,
          }),
        );
      }
      return result;
    },

    async commitOwnerFormUpdate(
      taskId: string,
      input: CanonicalOwnerFormUpdate,
      ownerAuthority: CanonicalOwnerFormAuthority,
    ) {
      return withOrdinaryTaskFormErrors(() =>
        taskForms.commitOwnerFormUpdate(
          taskId,
          input,
          ownerAuthority,
        ),
      );
    },

    async commitCreatorFormUpdate(
      taskId: string,
      message: string,
      creatorAuthority: CanonicalCreatorFormAuthority,
    ) {
      return withOrdinaryTaskFormErrors(() =>
        taskForms.commitCreatorFormUpdate(
          taskId,
          message,
          creatorAuthority,
        ),
      );
    },

    async reassign(input: OrdinaryTaskReassignInput) {
      const ownerAgentId = nonEmpty(input.ownerAgentId, "ownerAgentId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.taskId}`}, 0))`,
        );
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedTaskOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId:
                  input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "tasks.update",
                ownerAgentId,
              })
            : null;
        const priorRef = await tx
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, input.companyId),
              eq(taskExecutionRefs.sourceKind, "task_reassignment"),
              eq(
                taskExecutionRefs.deliveryIdempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (
            priorRef.taskId !== input.taskId ||
            priorRef.targetAgentId !== ownerAgentId
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const task = await tx
            .select()
            .from(tasks)
            .where(eq(tasks.id, input.taskId))
            .then((rows) => rows[0] ?? null);
          return {
            task,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !task.ownershipEpoch ||
          task.ownerKind !== "agent" ||
          !task.ownerAgentId ||
          !task.request ||
          !task.lifecycleStatus ||
          !NONTERMINAL.has(task.lifecycleStatus)
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Reassignment requires a nonterminal agent-owned task",
            "reassignment_target_invalid",
          );
        }
        const creatorMatches =
          input.creator.kind === "user/board"
            ? task.creatorKind === "user/board" &&
              task.creatorUserId === input.creator.userId
            : task.creatorKind === "plugin" &&
              task.creatorPluginInstallationId ===
                input.creator.pluginInstallationId &&
              task.creatorPluginKey === input.creator.pluginKey;
        if (!creatorMatches) {
          throw new OrdinaryTaskRuntimeRejected(
            "Creator identity does not match this task",
            "creator_authority_mismatch",
          );
        }
        const ownerResolution =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await resolveOrdinaryTaskOwner(
                tx,
                input.companyId,
                ownerAgentId,
              );
        return commitAgentOwnerReassignmentInTransaction(tx, {
          task,
          ownerAgentId,
          idempotencyKey,
          sourceAuthorityId:
            input.creator.kind === "plugin"
              ? input.creator.pluginInstallationId
              : input.creator.userId,
          cancellationActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user",
                  userId: input.creator.userId,
                }
              : { kind: "system" },
          comment:
            input.creator.kind === "plugin"
              ? {
                  author: {
                    kind: "plugin",
                    pluginInstallationId:
                      input.creator.pluginInstallationId,
                    pluginKey: input.creator.pluginKey,
                  },
                  producingRun: null,
                }
              : {
                  author: {
                    kind: "user",
                    userId: input.creator.userId,
                  },
                  producingRun: null,
                },
          provenanceUserId:
            input.creator.kind === "user/board"
              ? input.creator.userId
              : null,
          sourceActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user/board",
                  userId: input.creator.userId,
                }
              : {
                  kind: "plugin",
                  pluginInstallationId:
                    input.creator.pluginInstallationId,
                  pluginKey: input.creator.pluginKey,
                },
          ownerResolution,
        });
      });
      if (result.cancellations) {
        await options.taskExecutionCancellation
          .reconcileRequestedCancellations(
            result.cancellations,
          );
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      return result;
    },

    async boardReassign(input: OrdinaryTaskBoardReassignInput) {
      const ownerAgentId = nonEmpty(input.ownerAgentId, "ownerAgentId");
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const auditId = deterministicUuid(
        "board-task-reassignment-audit",
        `${input.companyId}:${idempotencyKey}`,
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reassign:${idempotencyKey}`}, 0))`,
        );
        const priorRef = await tx
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, input.companyId),
              eq(taskExecutionRefs.sourceKind, "task_reassignment"),
              eq(
                taskExecutionRefs.deliveryIdempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (
            priorRef.taskId !== input.taskId ||
            priorRef.targetAgentId !== ownerAgentId
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const [task, audit] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(
                and(
                  eq(tasks.companyId, input.companyId),
                  eq(tasks.id, input.taskId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(activityLog)
              .where(eq(activityLog.id, auditId))
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !task ||
            !audit ||
            audit.actorId !== actorUserId ||
            audit.action !== "task.board_reassigned"
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board reassignment is missing its audit record",
              "reassignment_audit_missing",
            );
          }
          return {
            task,
            ref: priorRef,
            auditId,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true as const,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!task) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reassignment target does not exist",
            "reassignment_target_invalid",
          );
        }
        const ownerResolution = await resolveOrdinaryTaskOwner(
          tx,
          input.companyId,
          ownerAgentId,
        );
        const previousOwnerAgentId = task.ownerAgentId;
        const previousOwnershipEpoch = task.ownershipEpoch;
        const reassigned =
          await commitAgentOwnerReassignmentInTransaction(tx, {
            task,
            ownerAgentId,
            idempotencyKey,
            sourceAuthorityId: actorUserId,
            cancellationActor: {
              kind: "user",
              userId: actorUserId,
            },
            comment: {
              author: { kind: "user", userId: actorUserId },
              producingRun: null,
            },
            sourceActor: {
              kind: "user/board",
              userId: actorUserId,
            },
            provenanceUserId: actorUserId,
            ownerResolution,
          });
        await tx.insert(activityLog).values({
          id: auditId,
          companyId: input.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.board_reassigned",
          entityType: "task",
          entityId: task.id,
          responsibleUserId: actorUserId,
          details: {
            contract: "board-task-reassignment/v1",
            idempotencyKey,
            previousOwnerAgentId,
            previousOwnershipEpoch,
            ownerAgentId,
            ownershipEpoch: reassigned.task.ownershipEpoch,
            executionRefId: reassigned.ref.id,
          },
          createdAt: clock(),
        });
        return { ...reassigned, auditId };
      });
      if (result.cancellations) {
        await options.taskExecutionCancellation
          .reconcileRequestedCancellations(
            result.cancellations,
          );
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      return result;
    },

    async userCreatorWithdrawalSelfAssign(
      input: OrdinaryTaskUserWithdrawalSelfAssignmentInput,
    ) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const auditId = deterministicUuid(
        "user-creator-withdrawal-self-assignment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const withdrawalCommandId = deterministicUuid(
        "user-creator-withdrawal-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const committed = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:user-creator-withdrawal:${idempotencyKey}`}, 0))`,
        );
        const priorAudit = await tx
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, auditId))
          .then((rows) => rows[0] ?? null);
        if (priorAudit) {
          if (
            priorAudit.companyId !== input.companyId ||
            priorAudit.entityId !== input.taskId ||
            priorAudit.actorId !== actorUserId ||
            priorAudit.action !==
              "task.user_creator_withdrawal_self_assigned"
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Withdrawal self-assignment idempotency key changed immutable input",
              "withdrawal_self_assignment_idempotency_conflict",
            );
          }
          const [task, command] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(
                and(
                  eq(tasks.companyId, input.companyId),
                  eq(tasks.id, input.taskId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskCreatorWithdrawalCommands)
              .where(
                eq(
                  taskCreatorWithdrawalCommands.id,
                  withdrawalCommandId,
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !task ||
            !command ||
            command.companyId !== input.companyId ||
            command.taskId !== input.taskId ||
            command.actorKind !== "user" ||
            command.actorUserId !== actorUserId ||
            command.resultingCreatorEdgeId === null ||
            command.resultingOwnershipEpoch !== task.ownershipEpoch ||
            command.outgoingOwnershipEpoch + 1 !==
              command.resultingOwnershipEpoch
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted withdrawal self-assignment lost its canonical command",
              "withdrawal_self_assignment_incomplete",
            );
          }
          return {
            task,
            auditId,
            command,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true as const,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !task.ownershipEpoch ||
          !task.lifecycleStatus ||
          !NONTERMINAL.has(task.lifecycleStatus) ||
          task.creatorKind !== "user/board" ||
          task.creatorUserId !== actorUserId ||
          task.ownerKind !== "agent" ||
          !task.ownerAgentId
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Only the exact named-user creator may self-assign a nonterminal agent-owned task for withdrawal",
            "withdrawal_self_assignment_target_invalid",
          );
        }
        const sessionState = await lockTaskSessionState(
          tx,
          input.companyId,
          task.id,
        );
        if (!sessionState) {
          throw new OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment target Session is missing",
            "withdrawal_self_assignment_session_missing",
          );
        }
        const outgoingAuthority = await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.companyId),
              eq(taskExecutionAuthorities.taskId, task.id),
              eq(
                taskExecutionAuthorities.ownershipEpoch,
                task.ownershipEpoch,
              ),
              eq(
                taskExecutionAuthorities.agentId,
                task.ownerAgentId,
              ),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment has no outgoing owner authority",
            "withdrawal_self_assignment_authority_missing",
          );
        }
        const now = clock();
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessions,
            options.taskExecutionCancellation,
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: sessionState.session.id,
              ownershipEpoch: task.ownershipEpoch,
              authorityId: outgoingAuthority.id,
              sourceAuthorityId: actorUserId,
              cancellationActor: {
                kind: "user",
                userId: actorUserId,
              },
              now,
            },
          );
        const ownershipEpoch = task.ownershipEpoch + 1;
        const reassigned = await tx
          .update(tasks)
          .set({
            ownerKind: "user",
            ownerAgentId: null,
            ownerUserId: actorUserId,
            ownerAssignmentSource: "user_creator_withdrawal",
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, task.id),
              eq(tasks.ownershipEpoch, task.ownershipEpoch),
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new OrdinaryTaskRuntimeRejected(
            "Ownership epoch changed during withdrawal self-assignment",
            "withdrawal_self_assignment_epoch_conflict",
          );
        }
        await withOrdinaryWorkspaceReservationErrors(() =>
          reserveTaskExecutionWorkspaceBinding(tx, {
            task: reassigned,
            session: {
              id: sessionState.session.id,
              now,
            },
            provenance: {
              agentId: null,
              userId: actorUserId,
            },
          }),
        );
        const resultingEdge = await insertCreatorEdge(
          tx,
          reassigned,
          sessionState.session.id,
          now,
        );
        const command = await tx
          .insert(taskCreatorWithdrawalCommands)
          .values({
            id: withdrawalCommandId,
            companyId: input.companyId,
            taskId: task.id,
            outgoingOwnershipEpoch: task.ownershipEpoch,
            resultingOwnershipEpoch: ownershipEpoch,
            resultingCreatorEdgeId: resultingEdge.id,
            actorKind: "user",
            actorUserId,
            actorPluginInstallationId: null,
            actorPluginKey: null,
            pluginWithdrawalOperationId: null,
            taskUpdateId: null,
            acceptedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment command was not persisted",
            "withdrawal_self_assignment_command_missing",
          );
        }
        await tx.insert(activityLog).values({
          id: auditId,
          companyId: input.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.user_creator_withdrawal_self_assigned",
          entityType: "task",
          entityId: task.id,
          responsibleUserId: actorUserId,
          details: {
            contract: "user-creator-withdrawal-self-assignment/v1",
            idempotencyKey,
            outgoingOwnerAgentId: task.ownerAgentId,
            outgoingOwnershipEpoch: task.ownershipEpoch,
            ownershipEpoch,
            ownerAssignmentSource: "user_creator_withdrawal",
          },
          createdAt: now,
        });
        return {
          task: reassigned,
          auditId,
          command,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false as const,
        };
      });
      if (committed.cancellations) {
        await options.taskExecutionCancellation
          .reconcileRequestedCancellations(
            committed.cancellations,
          );
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      return committed;
    },

    async preparePluginWithdrawal(
      input: OrdinaryPluginWithdrawalPrepareInput,
    ) {
      const message = nonBlankPreservingBytes(input.message, "message");
      const operationId = nonEmpty(input.operationId, "operationId");
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            companyId: input.companyId,
            taskId: input.taskId,
            message,
            operationId,
            pluginInstallationId: input.pluginInstallationId,
            pluginKey: input.pluginKey,
          }),
        )
        .digest("hex");
      const inserted = await db
        .insert(pluginWithdrawalOperations)
        .values({
          companyId: input.companyId,
          pluginInstallationId: input.pluginInstallationId,
          pluginKey: input.pluginKey,
          hostRpcOperationId: operationId,
          identityDigest,
          taskId: input.taskId,
          message,
          state: "pending",
          result: null,
          taskUpdateId: null,
          mutationCommentId: null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      const operation =
        inserted ??
        (await db
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(
                pluginWithdrawalOperations.pluginInstallationId,
                input.pluginInstallationId,
              ),
              eq(
                pluginWithdrawalOperations.hostRpcOperationId,
                operationId,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null));
      if (
        !operation ||
        operation.identityDigest !== identityDigest ||
        operation.companyId !== input.companyId ||
        operation.taskId !== input.taskId ||
        operation.pluginKey !== input.pluginKey ||
        operation.message !== message
      ) {
        throw new OrdinaryTaskRuntimeRejected(
          "Plugin withdrawal operation changed immutable input",
          "plugin_withdrawal_idempotency_conflict",
        );
      }
      return { operationId };
    },

    async withdrawPluginTask(input: OrdinaryPluginWithdrawalInput) {
      const operationId = nonEmpty(input.operationId, "operationId");
      const outcome: PluginWithdrawalCommitOutcome = await db.transaction(
        async (tx): Promise<PluginWithdrawalCommitOutcome> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.pluginInstallationId}:${operationId}`}, 0))`,
        );
        const operation = await tx
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(
                pluginWithdrawalOperations.pluginInstallationId,
                input.pluginInstallationId,
              ),
              eq(
                pluginWithdrawalOperations.hostRpcOperationId,
                operationId,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !operation ||
          operation.companyId !== input.companyId ||
          operation.pluginKey !== input.pluginKey
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal operation was not prepared by this installation",
            "plugin_withdrawal_not_prepared",
          );
        }
        const withdrawalCommandId = deterministicUuid(
          "plugin-creator-withdrawal-command",
          operation.id,
        );
        if (operation.state === "accepted") {
          const task = recordedPluginWithdrawalTask(operation.result);
          const command = await tx
            .select()
            .from(taskCreatorWithdrawalCommands)
            .where(
              eq(
                taskCreatorWithdrawalCommands.id,
                withdrawalCommandId,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            !task ||
            !command ||
            command.companyId !== input.companyId ||
            command.taskId !== operation.taskId ||
            command.actorKind !== "plugin" ||
            command.actorUserId !== null ||
            command.actorPluginInstallationId !==
              input.pluginInstallationId ||
            command.actorPluginKey !== input.pluginKey ||
            command.pluginWithdrawalOperationId !== operation.id ||
            command.taskUpdateId !== operation.taskUpdateId ||
            command.resultingCreatorEdgeId !== null ||
            command.resultingOwnershipEpoch !== task.ownershipEpoch ||
            command.outgoingOwnershipEpoch + 1 !==
              command.resultingOwnershipEpoch
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted plugin withdrawal is missing its canonical command",
              "plugin_withdrawal_result_missing",
            );
          }
          return {
            kind: "accepted",
            operationId,
            task,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }
        if (operation.state === "rejected") {
          const rejection = recordedPluginWithdrawalRejection(operation.result);
          if (!rejection) {
            throw new OrdinaryTaskRuntimeRejected(
              "Rejected plugin withdrawal is missing its recorded result",
              "plugin_withdrawal_result_missing",
            );
          }
          return { kind: "rejected", ...rejection };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, operation.taskId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !task.ownershipEpoch ||
          task.creatorKind !== "plugin" ||
          task.creatorPluginInstallationId !==
            input.pluginInstallationId ||
          task.creatorPluginKey !== input.pluginKey ||
          task.ownerKind !== "agent" ||
          !task.ownerAgentId ||
          !task.lifecycleStatus ||
          !NONTERMINAL.has(task.lifecycleStatus)
        ) {
          const now = clock();
          const rejection = {
            message:
              "Task is not a matching nonterminal plugin-created task",
            reason: "plugin_withdrawal_target_invalid",
          };
          await tx
            .update(pluginWithdrawalOperations)
            .set({
              state: "rejected",
              result: { kind: "rejected", ...rejection },
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(pluginWithdrawalOperations.id, operation.id));
          return { kind: "rejected", ...rejection };
        }
        const session = await tx
          .select()
          .from(taskSessions)
          .where(
            and(
              eq(taskSessions.companyId, input.companyId),
              eq(taskSessions.taskId, task.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const authority = await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.companyId),
              eq(taskExecutionAuthorities.taskId, task.id),
              eq(
                taskExecutionAuthorities.ownershipEpoch,
                task.ownershipEpoch,
              ),
              eq(
                taskExecutionAuthorities.agentId,
                task.ownerAgentId,
              ),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!session || !authority) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal target has no current Session authority",
            "plugin_withdrawal_authority_missing",
          );
        }
        const now = clock();
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessions,
            options.taskExecutionCancellation,
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch: task.ownershipEpoch,
              authorityId: authority.id,
              sourceAuthorityId: input.pluginInstallationId,
              cancellationActor: { kind: "system" },
              now,
            },
          );
        const ownershipEpoch = task.ownershipEpoch + 1;
        const withdrawn = await tx
          .update(tasks)
          .set({
            boardPresentationStatus: "cancelled",
            lifecycleStatus: "cancelled",
            disposition: {
              message: operation.message,
              structuredResult: {
                reason: "plugin_creator_withdrawal",
                outgoingOwnershipEpoch: task.ownershipEpoch,
              },
            },
            ownershipEpoch,
            cancelledAt: now,
            completedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.id, task.id),
              eq(tasks.ownershipEpoch, task.ownershipEpoch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!withdrawn) {
          throw new OrdinaryTaskRuntimeRejected(
            "Ownership epoch changed during plugin withdrawal",
            "plugin_withdrawal_epoch_conflict",
          );
        }
        await withOrdinaryWorkspaceReservationErrors(() =>
          reserveTaskExecutionWorkspaceBinding(tx, {
            task: withdrawn,
            session: {
              id: session.id,
              now,
            },
          }),
        );
        const comment = await sessions.appendNonDispatchControlNotice(
          {
            companyId: input.companyId,
            taskId: task.id,
            sessionId: session.id,
            sourceKind: "plugin_withdrawal",
            immutableSourceKey: operation.id,
            sourceRecordId: operation.id,
            exactText: operation.message,
            comment: {
              author: {
                kind: "plugin",
                pluginInstallationId: input.pluginInstallationId,
                pluginKey: input.pluginKey,
              },
              producingRun: null,
            },
            allowTerminal: true,
          },
          tx,
        );
        if (!comment.comment) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal comment was not persisted",
            "plugin_withdrawal_comment_missing",
          );
        }
        const update = await tx
          .insert(taskUpdates)
          .values({
            id: deterministicUuid(
              "plugin-withdrawal-update",
              operation.id,
            ),
            companyId: input.companyId,
            taskId: task.id,
            sessionId: session.id,
            ownershipEpoch,
            form: "owner",
            sourceKind: "plugin",
            sourceAuthorityId: null,
            sourceIdentity: {
              pluginInstallationId: input.pluginInstallationId,
              pluginKey: input.pluginKey,
              withdrawalOperationId: operation.id,
            },
            runId: null,
            gatewayInvocationId: `plugin-withdrawal:${operation.id}`,
            runSequence: 0,
            message: operation.message,
            status: "cancelled",
            disposition: withdrawn.disposition,
            commentId: comment.comment.id,
            creatorEdgeId: null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!update) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal update was not persisted",
            "plugin_withdrawal_update_missing",
          );
        }
        const acceptedOperation = await tx
          .update(pluginWithdrawalOperations)
          .set({
            state: "accepted",
            result: {
              kind: "accepted",
              operationId,
              taskId: task.id,
              ownershipEpoch,
              status: "cancelled",
              task: pluginWithdrawalTaskSnapshot(withdrawn),
            },
            taskUpdateId: update.id,
            mutationCommentId: comment.comment.id,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(pluginWithdrawalOperations.id, operation.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!acceptedOperation) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal operation was not accepted",
            "plugin_withdrawal_operation_missing",
          );
        }
        const command = await tx
          .insert(taskCreatorWithdrawalCommands)
          .values({
            id: withdrawalCommandId,
            companyId: input.companyId,
            taskId: task.id,
            outgoingOwnershipEpoch: task.ownershipEpoch,
            resultingOwnershipEpoch: ownershipEpoch,
            resultingCreatorEdgeId: null,
            actorKind: "plugin",
            actorUserId: null,
            actorPluginInstallationId: input.pluginInstallationId,
            actorPluginKey: input.pluginKey,
            pluginWithdrawalOperationId: operation.id,
            taskUpdateId: update.id,
            acceptedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryTaskRuntimeRejected(
            "Plugin withdrawal command was not persisted",
            "plugin_withdrawal_command_missing",
          );
        }
        return {
          kind: "accepted",
          operationId,
          task: withdrawn,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false,
        };
        },
      );
      if (outcome.kind === "rejected") {
        throw new OrdinaryTaskRuntimeRejected(
          outcome.message,
          outcome.reason,
        );
      }
      if (outcome.cancellations) {
        await options.taskExecutionCancellation
          .reconcileRequestedCancellations(
            outcome.cancellations,
          );
      }
      for (const refId of outcome.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      return {
        operationId: outcome.operationId,
        task: outcome.task,
        retried: outcome.retried,
      };
    },

  };
}

export type OrdinaryTaskRuntime = ReturnType<
  typeof createOrdinaryTaskRuntime
>;
