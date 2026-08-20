import { taskCreatorEdgeReceivability, taskSessionContextEpochs, taskSessions, tasks } from "@paperclipai/db";
import type { TaskExecutionRefSourceKind } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
export { canonicalJson } from "./canonical-json.js";
import { TaskExecutionWorkspaceReservationRejected } from "./execution-workspaces.js";
import type {
  RequestedScopedRunCancellations,
  TaskExecutionCancellationService,
} from "./task-execution-cancellation.js";
import { type TaskSessionAdmissionResult } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export type TaskRow = typeof tasks.$inferSelect;

export type CreatorEdgeRow = typeof taskCreatorEdgeReceivability.$inferSelect;

export type TaskSessionRow = typeof taskSessions.$inferSelect;

export const NONTERMINAL = new Set(["open", "blocked"]);

export const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

export async function lockTaskSessionState(
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
    .where(and(eq(taskSessions.companyId, companyId), eq(taskSessions.taskId, taskId)))
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

export type PluginWithdrawalCommitOutcome =
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

export const TASK_ROW_DATE_KEYS = [
  "monitorNextCheckAt",
  "monitorLastTriggeredAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "hiddenAt",
  "createdAt",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof TaskRow>;

export function pluginWithdrawalTaskSnapshot(task: TaskRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...task };
  for (const key of TASK_ROW_DATE_KEYS) {
    const value = task[key];
    snapshot[key] = value instanceof Date ? value.toISOString() : value;
  }
  return snapshot;
}

export function recordedPluginWithdrawalTask(result: unknown): TaskRow | null {
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

export function recordedPluginWithdrawalRejection(result: unknown): {
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
  companyId: string;
  request: string;
  ownerAgentId: string;
  creator: OrdinaryTaskCreator;
  idempotencyKey: string;
  sourceKind?: Extract<TaskExecutionRefSourceKind, "task_request" | "routine_dispatch">;
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
  creator: {
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
  taskExecutionCancellation: Pick<
    TaskExecutionCancellationService,
    "requestScopeCancellationsInTransaction" | "reconcileRequestedCancellations"
  >;
  /**
   * The only execution trigger exposed to causal producers. Implementations
   * must prepare composition and notify the dispatcher for this persisted ref.
   */
  dispatchRef(refId: string): Promise<void>;
}

export { deterministicUuid } from "./deterministic-uuid.js";

export function stableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

export async function withOrdinaryWorkspaceReservationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}
