import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  type Db,
} from "@paperclipai/db";
import type { TaskExecutionRunStatus } from "@paperclipai/shared";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import type { TaskExecutionAttemptCancellationSignal } from "./task-execution-dispatcher.js";
import { type TaskExecutionRunEnvelope, type TaskExecutionRunService } from "./task-execution-run-service.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
export const TERMINAL_RUN_STATUSES = new Set<TaskExecutionRunStatus>([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export type CancellationRow = typeof taskExecutionCancellationIntents.$inferSelect;

export interface TaskExecutionCancellationDispatcherPort {
  signalAttemptCancellation(input: TaskExecutionAttemptCancellationSignal): boolean;
  isAttemptActive(input: TaskExecutionAttemptCancellationSignal): boolean;
}

export interface TaskExecutionCancelledRunSettlementPort {
  terminalizeCancelledRun(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
    readonly finishedAt: Date;
  }): Promise<void>;
  terminalizeDetachedCancelledRunInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ): Promise<boolean>;
  fenceRevokedExecutionAuthorityInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector:
        | { readonly kind: "agents"; readonly agentIds: readonly string[] }
        | {
            readonly kind: "suspended_agents";
            readonly agentIds: readonly string[];
          }
        | {
            readonly kind: "ownership_epoch";
            readonly taskId: string;
            readonly ownershipEpoch: number;
          }
        | {
            readonly kind: "refs";
            readonly taskId: string;
            readonly refIds: readonly string[];
          }
        | {
            readonly kind: "budget_scope";
            readonly scopeType: "company" | "project" | "agent";
            readonly scopeId: string;
          };
      readonly reason: string;
      readonly at: Date;
      readonly nativeContinuity: "revoke" | "preserve_carry";
    },
  ): Promise<TaskExecutionAuthorityFenceResult>;
}

export interface TaskExecutionCancellationServiceOptions {
  readonly database: Db;
  readonly runService: Pick<
    TaskExecutionRunService,
    | "readRun"
    | "lockRun"
    | "attachCancellation"
    | "listForActivity"
    | "lockActiveRunsForAgentsInTransaction"
    | "lockActiveRunsForScopeInTransaction"
    | "lockActiveRunsForBudgetScopeInTransaction"
  >;
  readonly dispatcher: TaskExecutionCancellationDispatcherPort;
  readonly settlement: TaskExecutionCancelledRunSettlementPort;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pluginDomainEvents: PluginDomainEventPublisher;
}

export interface TaskExecutionCancellationResult {
  readonly runId: string;
  readonly alreadyTerminal: boolean;
  readonly cancellationIntentId: string | null;
  readonly state: "terminal" | "terminalized" | "requested" | "acknowledged" | "completed" | "failed";
}

export type TaskExecutionCancellationActor =
  | { readonly kind: "system" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string };

export type RequestedRunCancellation = {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
} & (
  | {
      readonly cancellationIntentId: string;
      readonly state: "intent_requested";
    }
  | {
      readonly cancellationIntentId: null;
      readonly state: "terminalized";
      /** Required post-commit plugin event owned by reconciliation. */
      readonly terminalEvent: AgentRunTerminalPluginEventInput;
    }
);

export interface TaskExecutionAuthorityFenceResult {
  readonly refIds: readonly string[];
  readonly correlationIds: readonly string[];
}

export interface RequestedAgentRunCancellations {
  readonly companyId: string;
  readonly agentIds: readonly string[];
  readonly reason: string;
  readonly fence: TaskExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

export interface RequestedBudgetScopeSuspension {
  readonly companyId: string;
  readonly scopeType: "company" | "project" | "agent";
  readonly scopeId: string;
  readonly reason: string;
  readonly fence: TaskExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

export interface RequestedScopedRunCancellations {
  readonly companyId: string;
  readonly taskId: string;
  readonly selector:
    | { readonly kind: "ownership_epoch"; readonly ownershipEpoch: number }
    | { readonly kind: "refs"; readonly refIds: readonly string[] };
  readonly reason: string;
  readonly fence: TaskExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

/** Running attempts interrupted by a pause without revoking queued authority. */
export interface RequestedRunningTaskInterruptions {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly reason: string;
  readonly requests: readonly RequestedRunCancellation[];
}

export class TaskExecutionCancellationRejected extends Error {
  readonly code = "task_execution_cancellation_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionCancellationRejected";
  }
}

export function reject(message: string): never {
  throw new TaskExecutionCancellationRejected(message);
}

export function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
}

export function boundedReason(value: string | undefined, defaultReason: string): string {
  const reason = (value ?? "").trim().slice(0, 200);
  return reason || defaultReason;
}

export function exactDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} must be a valid date`);
  }
  return value;
}

export async function terminalizedCancellationResult(
  publisher: PluginDomainEventPublisher,
  request: Extract<RequestedRunCancellation, { state: "terminalized" }>,
): Promise<TaskExecutionCancellationResult> {
  if (
    request.terminalEvent.companyId !== request.companyId ||
    request.terminalEvent.taskId !== request.taskId ||
    request.terminalEvent.runId !== request.runId ||
    request.terminalEvent.outcome !== "cancelled"
  ) {
    reject("terminalized cancellation plugin event crossed its exact run");
  }
  await publishAgentRunTerminalEvent(publisher, request.terminalEvent);
  return {
    runId: request.runId,
    alreadyTerminal: true,
    cancellationIntentId: null,
    state: "terminalized",
  };
}

export function cancellationActorColumns(actor: TaskExecutionCancellationActor) {
  if (actor.kind === "user") {
    exactIdentifier(actor.userId, "cancellation actor user id");
    return {
      actorKind: "user" as const,
      actorUserId: actor.userId,
      actorAgentId: null,
    };
  }
  if (actor.kind === "agent") {
    exactIdentifier(actor.agentId, "cancellation actor agent id");
    return {
      actorKind: "agent" as const,
      actorUserId: null,
      actorAgentId: actor.agentId,
    };
  }
  return {
    actorKind: "system" as const,
    actorUserId: null,
    actorAgentId: null,
  };
}

export function attemptSignal(input: {
  readonly run: TaskExecutionRunEnvelope;
  readonly attempt: typeof taskExecutionAttempts.$inferSelect;
  readonly lease: typeof taskExecutionLeases.$inferSelect | null;
}): TaskExecutionAttemptCancellationSignal | null {
  if (!input.attempt.refId || !input.lease) return null;
  return Object.freeze({
    companyId: input.run.companyId,
    taskId: input.run.taskId,
    sessionId: input.run.sessionId,
    executionScopeId: input.run.executionScopeId,
    refId: input.attempt.refId,
    runId: input.run.runId,
    attemptId: input.attempt.id,
    leaseGeneration: input.lease.leaseGeneration,
  });
}

export async function pageActiveRuns(
  runService: Pick<TaskExecutionRunService, "listForActivity">,
  companyId: string,
): Promise<TaskExecutionRunEnvelope[]> {
  const runs: TaskExecutionRunEnvelope[] = [];
  let cursor = null;
  do {
    const page = await runService.listForActivity({
      companyId,
      statuses: [...ACTIVE_RUN_STATUSES],
      cursor,
      limit: 200,
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return runs;
}

export type TaskExecutionCancellationServiceContext = TaskExecutionCancellationServiceOptions & {
  readonly now: () => Date;
  readonly idFactory: () => string;
};
