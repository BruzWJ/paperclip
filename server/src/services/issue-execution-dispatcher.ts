import type {
  IssueExecutionRef,
  IssueExecutionSessionOperation,
} from "@paperclipai/shared";
import { createTargetLaneRunCoordinator } from "./agent-execution/session-runner/coordinator.js";
import type {
  ReapedCompanySkillMaterialization,
} from "./company-skill-materialization-lifecycle.js";
import type {
  IssueExecutionSteeringResultBroker,
} from "./issue-execution-steering-results.js";

export interface LeasedIssueExecutionRef {
  ref: IssueExecutionRef;
  /** Exact canonical run identity, repeated here for closed service fences. */
  companyId: string;
  issueId: string;
  /**
   * Immutable productive/consult run created by the same transaction as this
   * lease.
   */
  runId: string;
  /** Canonical issue_execution_attempts identity; never the lease id. */
  attemptId: string;
  promptKind: "base" | "steering";
  /** Immutable ACP session operation frozen by this attempt generation. */
  sessionOperation: IssueExecutionSessionOperation;
  refOrdinal: number;
  segmentOrdinal: number;
  leaseId: string;
  leaseGeneration: number;
  attemptNumber: number;
  /**
   * One provider invocation may carry an ordered creator-update batch. The
   * first member is always `ref`; every member shares the lease/run/scope and
   * retains its own immutable source/ref identity and fencing generation.
   */
  batch: readonly {
    ref: IssueExecutionRef;
    leaseGeneration: number;
    attemptNumber: number;
  }[];
}

/** Exact consult-run provenance returned with a newly attached consult lease. */
export interface LeasedIssueExecutionConsultRun {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly retryOfRunId: string | null;
  readonly sessionId: string;
  readonly kind: "consult";
  readonly executionScopeId: string;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly executionMode: "consult";
  readonly issueExecutionAuthorityId: null;
  readonly consultExecutionId: string;
  readonly parentRunId: string;
  readonly currentAttemptId: string;
  readonly currentLeaseId: string;
}

export interface IssueExecutionAttemptCancellationSignal {
  companyId: string;
  issueId: string;
  sessionId: string;
  executionScopeId: string;
  refId: string;
  runId: string;
  attemptId: string | null;
  leaseGeneration: number;
}

export interface IssueExecutionRetry {
  kind: "retry";
  reason:
    | "process_loss"
    | "transport_transient"
    | "provider_quota"
    | "target_not_found_new_session";
  retryAt: Date;
}

export interface IssueExecutionTerminal {
  kind: "terminal";
  outcome: "succeeded" | "failed" | "cancelled";
  reason: string | null;
  /**
   * Exact normalized provider final for an inline consult. Owner dispatch
   * ignores this field because the outcome translator owns its projection.
   */
  finalText?: string | null;
}

export type IssueExecutionDispatchResult =
  | IssueExecutionRetry
  | IssueExecutionTerminal;

export interface IssueExecutionLaneSettlement {
  readonly laneReleased: boolean;
}

/** One durable per-target execution lane inside an issue ownership epoch. */
export type IssueExecutionTargetLaneIdentity = Readonly<
  Pick<
    IssueExecutionRef,
    | "companyId"
    | "issueId"
    | "sessionId"
    | "ownershipEpoch"
    | "targetAgentId"
  >
>;

export interface IssueExecutionDispatcherRepository {
  recoverExpiredLeases(input: {
    now: Date;
    limit: number;
  }): Promise<{
    ownerRefIds: string[];
    releasedConsultRefIds: string[];
  }>;
  listDispatchableOwnerRefIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]>;
  resolveLaneForPersistedRef(refId: string): Promise<{
    lane: IssueExecutionTargetLaneIdentity;
    mode: IssueExecutionRef["mode"];
    disposition: IssueExecutionRef["disposition"];
    leaseState:
      | "available"
      | "leased"
      | "retryable"
      | "completed"
      | "failed";
    leaseExpiresAt: Date | null;
  } | null>;
  leaseNextOwnerRef(input: {
    lane: IssueExecutionTargetLaneIdentity;
    workerId: string;
    now: Date;
  }): Promise<LeasedIssueExecutionRef | null>;
  assertLeaseCurrent(lease: LeasedIssueExecutionRef): Promise<void>;
  markRetryable(input: {
    lease: LeasedIssueExecutionRef;
    reason: IssueExecutionRetry["reason"];
    retryAt: Date;
    materialization: ReapedCompanySkillMaterialization | null;
  }): Promise<void>;
  markTerminal(input: {
    lease: LeasedIssueExecutionRef;
    outcome: IssueExecutionTerminal["outcome"];
    reason: string | null;
    finishedAt: Date;
    materialization: ReapedCompanySkillMaterialization | null;
  }): Promise<IssueExecutionLaneSettlement>;
}

export interface IssueExecutionAttemptExecutor {
  execute(
    lease: LeasedIssueExecutionRef,
    signal: AbortSignal,
    settle: (input: {
      readonly result: IssueExecutionDispatchResult;
      readonly materialization: ReapedCompanySkillMaterialization | null;
    }) => Promise<void>,
  ): Promise<IssueExecutionDispatchResult>;
}

export class IssueExecutionDispatchRejected extends Error {
  readonly code = "issue_execution_dispatch_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionDispatchRejected";
  }
}

export type PersistedRefNotificationOutcome =
  | "notified"
  | "already_scheduled"
  | "running"
  | "settled";

function assertOwnerLeaseBatch(
  lease: LeasedIssueExecutionRef,
  lane: IssueExecutionTargetLaneIdentity,
): void {
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
        member.ref.mode !== "owner" ||
        member.ref.disposition !== "active" ||
        member.ref.companyId !== lease.ref.companyId ||
        member.ref.issueId !== lease.ref.issueId ||
        member.ref.ownershipEpoch !== lease.ref.ownershipEpoch ||
        member.ref.executionScopeId !==
          lease.ref.executionScopeId ||
        member.ref.executionLineageId !==
          lease.ref.executionLineageId ||
        member.ref.targetAgentId !== lease.ref.targetAgentId ||
        member.ref.issueExecutionAuthorityId !==
          lease.ref.issueExecutionAuthorityId ||
        member.ref.adapterConfigRevisionId !==
          lease.ref.adapterConfigRevisionId ||
        member.ref.contextEpoch !== lease.ref.contextEpoch,
    )
  ) {
    throw new IssueExecutionDispatchRejected(
      "Repository leased refs outside one active owner execution batch",
    );
  }
}

function sameTargetLane(
  ref: IssueExecutionTargetLaneIdentity,
  lane: IssueExecutionTargetLaneIdentity,
): boolean {
  return ref.companyId === lane.companyId &&
    ref.issueId === lane.issueId &&
    ref.sessionId === lane.sessionId &&
    ref.ownershipEpoch === lane.ownershipEpoch &&
    ref.targetAgentId === lane.targetAgentId;
}

/** Session is validation context; the durable lane discriminator is four-part. */
function targetLaneCoordinatorKey(
  lane: IssueExecutionTargetLaneIdentity,
): string {
  return JSON.stringify([
    lane.companyId,
    lane.issueId,
    lane.ownershipEpoch,
    lane.targetAgentId,
  ]);
}

function cancellationMatchesLease(
  input: IssueExecutionAttemptCancellationSignal,
  lease: LeasedIssueExecutionRef,
): boolean {
  if (
    !input.attemptId ||
    input.attemptId !== lease.attemptId ||
    input.runId !== lease.runId ||
    input.companyId !== lease.ref.companyId ||
    input.issueId !== lease.ref.issueId ||
    input.sessionId !== lease.ref.sessionId ||
    input.executionScopeId !== lease.ref.executionScopeId
  ) {
    return false;
  }
  const members = lease.batch;
  return members.some(
    (member) =>
      member.ref.id === input.refId &&
      member.leaseGeneration === input.leaseGeneration,
  );
}

export function createIssueExecutionDispatcher(options: {
  repository: IssueExecutionDispatcherRepository;
  executor: IssueExecutionAttemptExecutor;
  steeringResults: Pick<IssueExecutionSteeringResultBroker, "publish">;
  workerId: string;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const activeAttempts = new Map<
    string,
    {
      lease: LeasedIssueExecutionRef;
      controller: AbortController;
    }
  >();

  const coordinator = createTargetLaneRunCoordinator<
    IssueExecutionTargetLaneIdentity,
    string
  >({
    keyOf: targetLaneCoordinatorKey,
    async drain(lane, _force, signal) {
      while (!signal.aborted) {
        const lease = await options.repository.leaseNextOwnerRef({
          lane,
          workerId: options.workerId,
          now: now(),
        });
        if (!lease) return;
        if (
          !sameTargetLane(lease.ref, lane) ||
          lease.ref.mode !== "owner" ||
          lease.ref.disposition !== "active"
        ) {
          throw new IssueExecutionDispatchRejected(
            "Repository leased a non-active owner ref into the target-lane drain",
          );
        }
        assertOwnerLeaseBatch(lease, lane);
        await options.repository.assertLeaseCurrent(lease);
        if (activeAttempts.has(lease.attemptId)) {
          throw new IssueExecutionDispatchRejected(
            "Issue-execution attempt identity is already active",
          );
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
          const result = await options.executor.execute(
            lease,
            controller.signal,
            async ({ result: settled, materialization }) => {
              await options.repository.assertLeaseCurrent(lease);
              if (settled.kind === "retry") {
                await options.repository.markRetryable({
                  lease,
                  reason: settled.reason,
                  retryAt: settled.retryAt,
                  materialization,
                });
                return;
              }
              await options.repository.markTerminal({
                lease,
                outcome: settled.outcome,
                reason: settled.reason,
                finishedAt: now(),
                materialization,
              });
            },
          );
          if (lease.promptKind === "steering" && result.kind === "terminal") {
            options.steeringResults.publish({
              companyId: lease.companyId,
              issueId: lease.issueId,
              runId: lease.runId,
              refId: lease.ref.id,
              refOrdinal: lease.refOrdinal,
              segmentOrdinal: lease.segmentOrdinal,
              outcome: result.outcome,
              response: result.finalText ?? "",
              reason: result.reason,
            });
          }
          if (result.kind === "retry") {
            // A target-not-found resume probe is an already-closed pre-send
            // predecessor. Its monotonic fresh-session successor remains in
            // this target-lane drain; all backoff retries wait for their persisted
            // due time and a later scheduler notification.
            if (result.reason === "target_not_found_new_session") continue;
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

  async function resolveOwnerLane(refId: string): Promise<{
    lane: IssueExecutionTargetLaneIdentity;
    disposition: IssueExecutionRef["disposition"];
    leaseState:
      | "available"
      | "leased"
      | "retryable"
      | "completed"
      | "failed";
    leaseExpiresAt: Date | null;
  }> {
    const persisted =
      await options.repository.resolveLaneForPersistedRef(refId);
    if (!persisted) {
      throw new IssueExecutionDispatchRejected(
        "Dispatcher accepts only a persisted IssueExecutionRef",
      );
    }
    if (persisted.mode !== "owner") {
      throw new IssueExecutionDispatchRejected(
        "Consult refs execute synchronously inside their caller-owned execution path",
      );
    }
    return persisted;
  }

  async function resolveReleasedConsultLane(
    refId: string,
  ): Promise<IssueExecutionTargetLaneIdentity> {
    const persisted =
      await options.repository.resolveLaneForPersistedRef(refId);
    if (!persisted) {
      throw new IssueExecutionDispatchRejected(
        "Dispatcher accepts only a persisted IssueExecutionRef",
      );
    }
    if (persisted.mode !== "consult") {
      throw new IssueExecutionDispatchRejected(
        "Released-lane notification accepts only a consult ref",
      );
    }
    if (
      persisted.disposition !== "terminal" ||
      !["completed", "failed"].includes(persisted.leaseState)
    ) {
      throw new IssueExecutionDispatchRejected(
        "Released consult ref must already be terminal and settled",
      );
    }
    return persisted.lane;
  }

  async function notifyPersistedRef(
    refId: string,
  ): Promise<PersistedRefNotificationOutcome> {
    const persisted = await resolveOwnerLane(refId);
    if (
      persisted.disposition === "terminal" ||
      persisted.leaseState === "completed" ||
      persisted.leaseState === "failed"
    ) {
      return "settled";
    }
    if (persisted.disposition !== "active") {
      throw new IssueExecutionDispatchRejected(
        "Invalidated refs cannot be scheduled",
      );
    }
    if (
      persisted.leaseState === "leased" &&
      (!persisted.leaseExpiresAt ||
        persisted.leaseExpiresAt > now())
    ) {
      return "running";
    }
    const alreadyScheduled = coordinator.isActive(persisted.lane);
    coordinator.wake(persisted.lane);
    return alreadyScheduled ? "already_scheduled" : "notified";
  }

  async function notifyReleasedConsultRef(refId: string): Promise<void> {
    coordinator.wake(await resolveReleasedConsultLane(refId));
  }

  return {
    /**
     * Internal causal-source hook. There is intentionally no prompt, agent,
     * issue selector, arbitrary payload, or generic wake API.
     */
    notifyPersistedRef,

    /**
     * Post-settlement signal from the synchronous consult executor. It can
     * wake only the exact persisted target lane after that consult released
     * its durable lane claim; consult execution remains caller-owned.
     */
    notifyReleasedConsultRef,

    async runPersistedRef(refId: string): Promise<void> {
      const persisted = await resolveOwnerLane(refId);
      if (
        persisted.disposition !== "active" ||
        !(
          ["available", "retryable"].includes(
            persisted.leaseState,
          ) ||
          (persisted.leaseState === "leased" &&
            persisted.leaseExpiresAt !== null &&
            persisted.leaseExpiresAt <= now())
        )
      ) {
        throw new IssueExecutionDispatchRejected(
          "Dispatcher can run only a persisted active leaseable IssueExecutionRef",
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
      for (const refId of recovered.releasedConsultRefIds) {
        await notifyReleasedConsultRef(refId);
      }
      const discovered =
        await options.repository.listDispatchableOwnerRefIds({
          now: now(),
          limit: boundedLimit,
        });
      const refIds = [
        ...new Set([...recovered.ownerRefIds, ...discovered]),
      ].slice(0, boundedLimit);
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
    signalAttemptCancellation(
      input: IssueExecutionAttemptCancellationSignal,
    ): boolean {
      if (!input.attemptId) return false;
      const active = activeAttempts.get(input.attemptId);
      if (!active || !cancellationMatchesLease(input, active.lease)) {
        return false;
      }
      active.controller.abort("issue_execution_attempt_cancelled");
      return true;
    },

    /**
     * Exact, read-only worker-local presence check used by the durable
     * cancellation reconciler. Dispatcher lease identity remains independent
     * from the provider command executionId (`runId`).
     */
    isAttemptActive(
      input: IssueExecutionAttemptCancellationSignal,
    ): boolean {
      if (!input.attemptId) return false;
      const active = activeAttempts.get(input.attemptId);
      return Boolean(
        active && cancellationMatchesLease(input, active.lease),
      );
    },

    async shutdown(): Promise<void> {
      await Promise.all(
        [...coordinator.active()].map((lane) =>
          coordinator.interrupt(lane),
        ),
      );
    },
  };
}

export type IssueExecutionDispatcher = ReturnType<
  typeof createIssueExecutionDispatcher
>;
