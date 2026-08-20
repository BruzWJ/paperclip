import type { TaskExecutionRef, TaskExecutionSessionOperation } from "@paperclipai/shared";
import { createTargetLaneRunCoordinator } from "./agent-execution/session-runner/coordinator.js";

export interface LeasedTaskExecutionRef {
  ref: TaskExecutionRef;
  /** Exact canonical run identity, repeated here for closed service fences. */
  companyId: string;
  taskId: string;
  /**
   * Immutable productive/consult run created by the same transaction as this
   * lease.
   */
  runId: string;
  /** Canonical task_execution_attempts identity; never the lease id. */
  attemptId: string;
  /** Immutable ACP session operation frozen by this attempt generation. */
  sessionOperation: TaskExecutionSessionOperation;
  refOrdinal: number;
  leaseId: string;
  leaseGeneration: number;
  attemptNumber: number;
  /**
   * One provider invocation may carry an ordered creator-update batch. The
   * first member is always `ref`; every member shares the lease/run/scope and
   * retains its own immutable source/ref identity and fencing generation.
   */
  batch: readonly {
    ref: TaskExecutionRef;
    leaseGeneration: number;
    attemptNumber: number;
  }[];
}

export interface TaskExecutionAttemptCancellationSignal {
  companyId: string;
  taskId: string;
  sessionId: string;
  executionScopeId: string;
  refId: string;
  runId: string;
  attemptId: string | null;
  leaseGeneration: number;
}

export interface TaskExecutionRetry {
  kind: "retry";
  reason: "transport_transient";
  retryAt: Date;
}

export interface TaskExecutionTerminal {
  kind: "terminal";
  outcome: "succeeded" | "failed" | "cancelled";
  reason: string | null;
  /**
   * Exact normalized provider final for an inline consult. Owner dispatch
   * ignores this field because the outcome translator owns its projection.
   */
  finalText?: string | null;
}

export type TaskExecutionDispatchResult = TaskExecutionRetry | TaskExecutionTerminal;

export interface TaskExecutionLaneSettlement {
  readonly laneReleased: boolean;
}

/** One durable per-target execution lane inside a task ownership epoch. */
export type TaskExecutionTargetLaneIdentity = Readonly<
  Pick<TaskExecutionRef, "companyId" | "taskId" | "sessionId" | "ownershipEpoch" | "targetAgentId">
>;

export interface TaskExecutionDispatcherRepository {
  recoverExpiredLeases(input: { now: Date; limit: number }): Promise<{ refIds: string[] }>;
  listDispatchableRefIds(input: { now: Date; limit: number }): Promise<string[]>;
  resolveLaneForPersistedRef(refId: string): Promise<{
    lane: TaskExecutionTargetLaneIdentity;
    mode: TaskExecutionRef["mode"];
    disposition: TaskExecutionRef["disposition"];
    leaseState: "available" | "leased" | "retryable" | "completed" | "failed";
    leaseExpiresAt: Date | null;
  } | null>;
  leaseNextRef(input: {
    lane: TaskExecutionTargetLaneIdentity;
    workerId: string;
    now: Date;
  }): Promise<LeasedTaskExecutionRef | null>;
  assertLeaseCurrent(lease: LeasedTaskExecutionRef): Promise<void>;
  markRetryable(input: {
    lease: LeasedTaskExecutionRef;
    reason: TaskExecutionRetry["reason"];
    retryAt: Date;
  }): Promise<void>;
  markTerminal(input: {
    lease: LeasedTaskExecutionRef;
    outcome: TaskExecutionTerminal["outcome"];
    reason: string | null;
    finishedAt: Date;
  }): Promise<TaskExecutionLaneSettlement>;
}

export interface TaskExecutionAttemptExecutor {
  execute(
    lease: LeasedTaskExecutionRef,
    signal: AbortSignal,
    settle: (result: TaskExecutionDispatchResult) => Promise<void>,
  ): Promise<TaskExecutionDispatchResult>;
}

export class TaskExecutionDispatchRejected extends Error {
  readonly code = "task_execution_dispatch_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionDispatchRejected";
  }
}

export type PersistedRefNotificationOutcome = "notified" | "already_scheduled" | "running" | "settled";

function assertLeaseBatch(lease: LeasedTaskExecutionRef, lane: TaskExecutionTargetLaneIdentity): void {
  const members = lease.batch;
  const first = members[0];
  if (
    !lease.runId ||
    !lease.attemptId ||
    !lease.leaseId ||
    !first ||
    first.ref.id !== lease.ref.id ||
    first.leaseGeneration !== lease.leaseGeneration ||
    first.attemptNumber !== lease.attemptNumber ||
    members.some(
      (member) =>
        !sameTargetLane(member.ref, lane) ||
        member.ref.mode !== lease.ref.mode ||
        member.ref.disposition !== "active" ||
        member.ref.companyId !== lease.ref.companyId ||
        member.ref.taskId !== lease.ref.taskId ||
        member.ref.ownershipEpoch !== lease.ref.ownershipEpoch ||
        member.ref.executionScopeId !== lease.ref.executionScopeId ||
        member.ref.executionLineageId !== lease.ref.executionLineageId ||
        member.ref.targetAgentId !== lease.ref.targetAgentId ||
        member.ref.taskExecutionAuthorityId !== lease.ref.taskExecutionAuthorityId ||
        member.ref.adapterConfigRevisionId !== lease.ref.adapterConfigRevisionId ||
        member.ref.contextEpoch !== lease.ref.contextEpoch,
    ) ||
    (lease.ref.mode === "consult" && members.length !== 1)
  ) {
    throw new TaskExecutionDispatchRejected("Repository leased refs outside one active execution batch");
  }
}

function sameTargetLane(
  ref: TaskExecutionTargetLaneIdentity,
  lane: TaskExecutionTargetLaneIdentity,
): boolean {
  return (
    ref.companyId === lane.companyId &&
    ref.taskId === lane.taskId &&
    ref.sessionId === lane.sessionId &&
    ref.ownershipEpoch === lane.ownershipEpoch &&
    ref.targetAgentId === lane.targetAgentId
  );
}

/** Session is validation context; the durable lane discriminator is four-part. */
function targetLaneCoordinatorKey(lane: TaskExecutionTargetLaneIdentity): string {
  return JSON.stringify([lane.companyId, lane.taskId, lane.ownershipEpoch, lane.targetAgentId]);
}

function cancellationMatchesLease(
  input: TaskExecutionAttemptCancellationSignal,
  lease: LeasedTaskExecutionRef,
): boolean {
  if (
    !input.attemptId ||
    input.attemptId !== lease.attemptId ||
    input.runId !== lease.runId ||
    input.companyId !== lease.ref.companyId ||
    input.taskId !== lease.ref.taskId ||
    input.sessionId !== lease.ref.sessionId ||
    input.executionScopeId !== lease.ref.executionScopeId
  ) {
    return false;
  }
  const members = lease.batch;
  return members.some(
    (member) => member.ref.id === input.refId && member.leaseGeneration === input.leaseGeneration,
  );
}

export function createTaskExecutionDispatcher(options: {
  repository: TaskExecutionDispatcherRepository;
  executor: TaskExecutionAttemptExecutor;
  workerId: string;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const activeAttempts = new Map<
    string,
    {
      lease: LeasedTaskExecutionRef;
      controller: AbortController;
    }
  >();

  const coordinator = createTargetLaneRunCoordinator<TaskExecutionTargetLaneIdentity, string>({
    keyOf: targetLaneCoordinatorKey,
    async drain(lane, _force, signal) {
      while (!signal.aborted) {
        const lease = await options.repository.leaseNextRef({
          lane,
          workerId: options.workerId,
          now: now(),
        });
        if (!lease) return;
        if (!sameTargetLane(lease.ref, lane) || lease.ref.disposition !== "active") {
          throw new TaskExecutionDispatchRejected(
            "Repository leased a non-active ref into the target-lane drain",
          );
        }
        assertLeaseBatch(lease, lane);
        await options.repository.assertLeaseCurrent(lease);
        if (activeAttempts.has(lease.attemptId)) {
          throw new TaskExecutionDispatchRejected("Task-execution attempt identity is already active");
        }
        const controller = new AbortController();
        const abortFromLane = () => controller.abort(signal.reason);
        if (signal.aborted) {
          abortFromLane();
        } else {
          signal.addEventListener("abort", abortFromLane, {
            once: true,
          });
        }
        const activeAttempt = { lease, controller };
        activeAttempts.set(lease.attemptId, activeAttempt);
        try {
          const result = await options.executor.execute(lease, controller.signal, async (settled) => {
            await options.repository.assertLeaseCurrent(lease);
            if (settled.kind === "retry") {
              await options.repository.markRetryable({
                lease,
                reason: settled.reason,
                retryAt: settled.retryAt,
              });
              return;
            }
            await options.repository.markTerminal({
              lease,
              outcome: settled.outcome,
              reason: settled.reason,
              finishedAt: now(),
            });
          });
          if (result.kind === "retry") {
            return;
          }
        } finally {
          signal.removeEventListener("abort", abortFromLane);
          if (activeAttempts.get(lease.attemptId) === activeAttempt) {
            activeAttempts.delete(lease.attemptId);
          }
        }
      }
    },
  });

  async function resolvePersistedLane(refId: string): Promise<{
    lane: TaskExecutionTargetLaneIdentity;
    disposition: TaskExecutionRef["disposition"];
    leaseState: "available" | "leased" | "retryable" | "completed" | "failed";
    leaseExpiresAt: Date | null;
  }> {
    const persisted = await options.repository.resolveLaneForPersistedRef(refId);
    if (!persisted) {
      throw new TaskExecutionDispatchRejected("Dispatcher accepts only a persisted TaskExecutionRef");
    }
    return persisted;
  }

  async function notifyPersistedRef(refId: string): Promise<PersistedRefNotificationOutcome> {
    const persisted = await resolvePersistedLane(refId);
    if (
      persisted.disposition === "terminal" ||
      persisted.leaseState === "completed" ||
      persisted.leaseState === "failed"
    ) {
      return "settled";
    }
    if (persisted.disposition !== "active") {
      throw new TaskExecutionDispatchRejected("Invalidated refs cannot be scheduled");
    }
    if (
      persisted.leaseState === "leased" &&
      (!persisted.leaseExpiresAt || persisted.leaseExpiresAt > now())
    ) {
      return "running";
    }
    const alreadyScheduled = coordinator.isActive(persisted.lane);
    coordinator.wake(persisted.lane);
    return alreadyScheduled ? "already_scheduled" : "notified";
  }

  return {
    /**
     * Internal causal-source hook. There is intentionally no prompt, agent,
     * task selector, arbitrary payload, or generic wake API.
     */
    notifyPersistedRef,

    async runPersistedRef(refId: string): Promise<void> {
      const persisted = await resolvePersistedLane(refId);
      if (
        persisted.disposition !== "active" ||
        !(
          ["available", "retryable"].includes(persisted.leaseState) ||
          (persisted.leaseState === "leased" &&
            persisted.leaseExpiresAt !== null &&
            persisted.leaseExpiresAt <= now())
        )
      ) {
        throw new TaskExecutionDispatchRejected(
          "Dispatcher can run only a persisted active leaseable TaskExecutionRef",
        );
      }
      await coordinator.run(persisted.lane);
    },

    /**
     * Restart/periodic recovery discovers only already-prepared persisted refs.
     * The repository owns the full lifecycle/view/promotion/leaseability
     * predicate; this loop cannot manufacture a ref or bypass composition.
     */
    async reconcilePersistedRefs(limit = 100): Promise<{
      discovered: number;
      notified: number;
      refIds: string[];
    }> {
      const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
      const recovered = await options.repository.recoverExpiredLeases({
        now: now(),
        limit: boundedLimit,
      });
      const discovered = await options.repository.listDispatchableRefIds({
        now: now(),
        limit: boundedLimit,
      });
      const refIds = [...new Set([...recovered.refIds, ...discovered])].slice(0, boundedLimit);
      for (const refId of refIds) {
        await notifyPersistedRef(refId);
      }
      return {
        discovered: refIds.length,
        notified: refIds.length,
        refIds,
      };
    },

    /**
     * Post-commit operational signal for one already-fenced durable attempt.
     * It never reads or writes persistence and never interrupts a whole
     * Session. A stale signal cannot reach a later lease/run.
     */
    signalAttemptCancellation(input: TaskExecutionAttemptCancellationSignal): boolean {
      if (!input.attemptId) return false;
      const active = activeAttempts.get(input.attemptId);
      if (!active || !cancellationMatchesLease(input, active.lease)) {
        return false;
      }
      active.controller.abort("task_execution_attempt_cancelled");
      return true;
    },

    /**
     * Exact, read-only worker-local presence check used by the durable
     * cancellation reconciler. Dispatcher lease identity remains independent
     * from ACPX's opaque runtime state.
     */
    isAttemptActive(input: TaskExecutionAttemptCancellationSignal): boolean {
      if (!input.attemptId) return false;
      const active = activeAttempts.get(input.attemptId);
      return Boolean(active && cancellationMatchesLease(input, active.lease));
    },

    async shutdown(): Promise<void> {
      await Promise.all([...coordinator.active()].map((lane) => coordinator.interrupt(lane)));
    },
  };
}

export type TaskExecutionDispatcher = ReturnType<typeof createTaskExecutionDispatcher>;
