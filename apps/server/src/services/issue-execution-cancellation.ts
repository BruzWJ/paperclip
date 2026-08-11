import { randomUUID } from "node:crypto";
import {
  companies,
  issueExecutionAttempts,
  issueExecutionCancellationIntents,
  issueExecutionLeases,
  type Db,
} from "@paperclipai/db";
import type { IssueExecutionRunStatus } from "@paperclipai/shared";
import { and, eq, inArray } from "drizzle-orm";
import type {
  IssueExecutionAttemptCancellationSignal,
} from "./issue-execution-dispatcher.js";
import {
  resolveIssueExecutionRunIdentityById,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";
import {
  acknowledgeCompanyCancellationIntentsInTx,
  failCompanyCancellationIntentInTx,
  reconcileCompanyCancellationIntentInTx,
  reconcileCompanySessionLifecycleOperationInTx,
} from "./issue-session-lifecycle.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TERMINAL_RUN_STATUSES = new Set<IssueExecutionRunStatus>([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

type CancellationRow = typeof issueExecutionCancellationIntents.$inferSelect;

export interface IssueExecutionCancellationDispatcherPort {
  signalAttemptCancellation(
    input: IssueExecutionAttemptCancellationSignal,
  ): boolean;
  isAttemptActive(input: IssueExecutionAttemptCancellationSignal): boolean;
}

export interface IssueExecutionCancelledRunSettlementPort {
  terminalizeCancelledRun(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly runId: string;
    readonly reason: string;
    readonly finishedAt: Date;
  }): Promise<void>;
  terminalizeDetachedCancelledRunInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ): Promise<boolean>;
  fenceRevokedExecutionAuthorityInTransaction(
    transaction: IssueSessionDbTransaction,
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
            readonly issueId: string;
            readonly ownershipEpoch: number;
          }
        | {
            readonly kind: "refs";
            readonly issueId: string;
            readonly refIds: readonly string[];
          }
        | {
            readonly kind: "budget_scope";
            readonly scopeType: "company" | "project" | "agent";
            readonly scopeId: string;
          };
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<IssueExecutionAuthorityFenceResult>;
}

export interface IssueExecutionCancellationServiceOptions {
  readonly database: Db;
  readonly runService: Pick<
    IssueExecutionRunService,
    | "readRun"
    | "lockRun"
    | "attachCancellation"
    | "listForActivity"
    | "lockActiveRunsForAgentsInTransaction"
    | "lockActiveRunsForScopeInTransaction"
    | "lockActiveRunsForBudgetScopeInTransaction"
  >;
  readonly dispatcher: IssueExecutionCancellationDispatcherPort;
  readonly settlement: IssueExecutionCancelledRunSettlementPort;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pluginDomainEvents: PluginDomainEventPublisher;
}

export interface IssueExecutionCancellationResult {
  readonly runId: string;
  readonly alreadyTerminal: boolean;
  readonly cancellationIntentId: string | null;
  readonly state:
    | "terminal"
    | "terminalized"
    | "requested"
    | "acknowledged"
    | "completed"
    | "failed";
}

export type IssueExecutionCancellationActor =
  | { readonly kind: "system" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string };

export type RequestedRunCancellation = {
  readonly companyId: string;
  readonly issueId: string;
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

export interface IssueExecutionAuthorityFenceResult {
  readonly refIds: readonly string[];
  readonly correlationIds: readonly string[];
}

export interface RequestedAgentRunCancellations {
  readonly companyId: string;
  readonly agentIds: readonly string[];
  readonly reason: string;
  readonly fence: IssueExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

export interface RequestedBudgetScopeSuspension {
  readonly companyId: string;
  readonly scopeType: "company" | "project" | "agent";
  readonly scopeId: string;
  readonly reason: string;
  readonly fence: IssueExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

export interface RequestedScopedRunCancellations {
  readonly companyId: string;
  readonly issueId: string;
  readonly selector:
    | { readonly kind: "ownership_epoch"; readonly ownershipEpoch: number }
    | { readonly kind: "refs"; readonly refIds: readonly string[] };
  readonly reason: string;
  readonly fence: IssueExecutionAuthorityFenceResult;
  readonly requests: readonly RequestedRunCancellation[];
}

/** Running attempts interrupted by a pause without revoking queued authority. */
export interface RequestedRunningIssueInterruptions {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly reason: string;
  readonly requests: readonly RequestedRunCancellation[];
}

export class IssueExecutionCancellationRejected extends Error {
  readonly code = "issue_execution_cancellation_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionCancellationRejected";
  }
}

function reject(message: string): never {
  throw new IssueExecutionCancellationRejected(message);
}

function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
}

function boundedReason(value: string | undefined, defaultReason: string): string {
  const reason = (value ?? "").trim().slice(0, 200);
  return reason || defaultReason;
}

function exactDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} must be a valid date`);
  }
  return value;
}

async function terminalizedCancellationResult(
  publisher: PluginDomainEventPublisher,
  request: Extract<RequestedRunCancellation, { state: "terminalized" }>,
): Promise<IssueExecutionCancellationResult> {
  if (
    request.terminalEvent.companyId !== request.companyId
    || request.terminalEvent.issueId !== request.issueId
    || request.terminalEvent.runId !== request.runId
    || request.terminalEvent.outcome !== "cancelled"
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

function cancellationActorColumns(actor: IssueExecutionCancellationActor) {
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

function attemptSignal(input: {
  readonly run: IssueExecutionRunEnvelope;
  readonly attempt: typeof issueExecutionAttempts.$inferSelect;
  readonly lease: typeof issueExecutionLeases.$inferSelect | null;
}): IssueExecutionAttemptCancellationSignal | null {
  if (!input.attempt.refId || !input.lease) return null;
  return Object.freeze({
    companyId: input.run.companyId,
    issueId: input.run.issueId,
    sessionId: input.run.sessionId,
    executionScopeId: input.run.executionScopeId,
    refId: input.attempt.refId,
    runId: input.run.runId,
    attemptId: input.attempt.id,
    leaseGeneration: input.lease.leaseGeneration,
  });
}

async function pageActiveRuns(
  runService: Pick<IssueExecutionRunService, "listForActivity">,
  companyId: string,
): Promise<IssueExecutionRunEnvelope[]> {
  const runs: IssueExecutionRunEnvelope[] = [];
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

export function createIssueExecutionCancellationService(
  options: IssueExecutionCancellationServiceOptions,
) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  /**
   * Shared per-run cancellation step used by the locked-run and agent-fence
   * paths. Returns the request entry the caller records for this run.
   */
  async function processCancellableRun(
    transaction: IssueSessionDbTransaction,
    run: {
      readonly companyId: string;
      readonly issueId: string;
      readonly runId: string;
      readonly targetAgentId: string;
      readonly cancellationIntentId: string | null;
      readonly currentAttemptId: string | null;
      readonly currentLeaseId: string | null;
    },
    params: {
      readonly reason: string;
      readonly at: Date;
      readonly reasonKind: "authority" | "lifecycle";
      readonly actor: ReturnType<typeof cancellationActorColumns>;
    },
  ): Promise<RequestedRunCancellation> {
    if (run.cancellationIntentId !== null) {
      return {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
        cancellationIntentId: run.cancellationIntentId,
        state: "intent_requested",
      };
    }
    if (run.currentAttemptId === null && run.currentLeaseId === null) {
      const terminalized = await options.settlement.terminalizeDetachedCancelledRunInTransaction(
        transaction,
        {
          companyId: run.companyId,
          issueId: run.issueId,
          runId: run.runId,
          reason: params.reason,
          finishedAt: params.at,
        },
      );
      if (!terminalized) {
        reject("detached cancellation lost its nonterminal run");
      }
      return {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: run.runId,
        cancellationIntentId: null,
        state: "terminalized",
        terminalEvent: {
          companyId: run.companyId,
          issueId: run.issueId,
          runId: run.runId,
          agentId: run.targetAgentId,
          outcome: "cancelled",
          reason: params.reason,
          occurredAt: params.at,
        },
      };
    }
    if (run.currentAttemptId === null || run.currentLeaseId === null) {
      reject("active run has a partial prompt-attempt attachment");
    }
    const [attemptRows, leaseRows] = await Promise.all([
      transaction
        .select()
        .from(issueExecutionAttempts)
        .where(eq(issueExecutionAttempts.id, run.currentAttemptId))
        .limit(2)
        .for("update"),
      transaction
        .select()
        .from(issueExecutionLeases)
        .where(eq(issueExecutionLeases.id, run.currentLeaseId))
        .limit(2)
        .for("update"),
    ]);
    if (attemptRows.length !== 1 || leaseRows.length !== 1) {
      reject("active run has an ambiguous attempt or lease");
    }
    const attempt = attemptRows[0]!;
    const lease = leaseRows[0]!;
    if (
      attempt.runId !== run.runId ||
      lease.runId !== run.runId ||
      lease.attemptId !== attempt.id ||
      lease.id !== run.currentLeaseId ||
      attempt.id !== run.currentAttemptId ||
      lease.state !== "active"
    ) {
      reject("active run cancellation crossed its exact attempt lease");
    }
    const cancellationIntentId = idFactory();
    await transaction.insert(issueExecutionCancellationIntents).values({
      id: cancellationIntentId,
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      attemptId: attempt.id,
      leaseId: lease.id,
      reasonKind: params.reasonKind,
      ...params.actor,
      state: "requested",
      requestedAt: params.at,
      acknowledgedAt: null,
      nativeCancellationSettledAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      createdAt: params.at,
    });
    await options.runService.attachCancellation(transaction, {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      expectedAttemptId: attempt.id,
      expectedLeaseId: lease.id,
      cancellationIntentId,
      at: params.at,
    });
    return {
      companyId: run.companyId,
      issueId: run.issueId,
      runId: run.runId,
      cancellationIntentId,
      state: "intent_requested",
    };
  }

  async function requestLockedRunCancellationsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly runs: readonly IssueExecutionRunEnvelope[];
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly at: Date;
      readonly reasonKind?: "authority" | "lifecycle";
    },
  ): Promise<readonly RequestedRunCancellation[]> {
    const actor = cancellationActorColumns(input.actor);
    const requests: RequestedRunCancellation[] = [];
    for (const run of input.runs) {
      requests.push(
        await processCancellableRun(transaction, run, {
          reason: input.reason,
          at: input.at,
          reasonKind: input.reasonKind ?? "authority",
          actor,
        }),
      );
    }
    return Object.freeze(requests);
  }

  /**
   * Graph-locked agent termination boundary. The caller mutates agent
   * authority and requests every exact prompt cancellation in the same DB
   * transaction, then reconciles the returned identities after commit.
   */
  async function requestAgentCancellationsWithFenceInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
    fenceKind: "agents" | "suspended_agents",
  ): Promise<RequestedAgentRunCancellations> {
    exactIdentifier(input.companyId, "company id");
    const agentIds = [...new Set(input.agentIds)];
    for (const agentId of agentIds) {
      exactIdentifier(agentId, "cancelled agent id");
    }
    const reason = boundedReason(input.reason, "agent_authority_revoked");
    const at = exactDate(input.now, "agent cancellation request time");
    const actor = cancellationActorColumns(input.actor);
    if (agentIds.length === 0) {
      return Object.freeze({
        companyId: input.companyId,
        agentIds: Object.freeze([]),
        reason,
        fence: Object.freeze({
          refIds: Object.freeze([]),
          correlationIds: Object.freeze([]),
        }),
        requests: Object.freeze([]),
      });
    }

    const fence = await options.settlement
      .fenceRevokedExecutionAuthorityInTransaction(transaction, {
        companyId: input.companyId,
        selector: { kind: fenceKind, agentIds },
        reason,
        at,
      });
    const runRows = await options.runService
      .lockActiveRunsForAgentsInTransaction(transaction, {
        companyId: input.companyId,
        agentIds,
      });
    const requests: RequestedRunCancellation[] = [];
    for (const run of runRows) {
      requests.push(
        await processCancellableRun(transaction, run, {
          reason,
          at,
          reasonKind: "authority",
          actor,
        }),
      );
    }
    return Object.freeze({
      companyId: input.companyId,
      agentIds: Object.freeze(agentIds),
      reason,
      fence,
      requests: Object.freeze(requests),
    });
  }

  /** Permanent authority revocation for the selected tombstoned agent. */
  function requestAgentCancellationsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedAgentRunCancellations> {
    return requestAgentCancellationsWithFenceInTransaction(
      transaction,
      input,
      "agents",
    );
  }

  /**
   * System-pause fence for descendants. Their queued execution refs and
   * target-session correlations are invalidated.
   */
  function requestAgentSuspensionsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedAgentRunCancellations> {
    return requestAgentCancellationsWithFenceInTransaction(
      transaction,
      input,
      "suspended_agents",
    );
  }

  function validateBudgetScope(input: {
    readonly companyId: string;
    readonly scopeType: "company" | "project" | "agent";
    readonly scopeId: string;
  }): void {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.scopeId, "budget scope id");
    if (input.scopeType === "company" && input.scopeId !== input.companyId) {
      reject("company budget scope must target its exact company");
    }
  }

  async function requestBudgetScopeSuspensionInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
      readonly reason?: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedBudgetScopeSuspension> {
    validateBudgetScope(input);
    const at = exactDate(input.now, "budget suspension time");
    const reason = boundedReason(input.reason, "budget_hard_stop");
    const fence = await options.settlement
      .fenceRevokedExecutionAuthorityInTransaction(transaction, {
        companyId: input.companyId,
        selector: {
          kind: "budget_scope",
          scopeType: input.scopeType,
          scopeId: input.scopeId,
        },
        reason,
        at,
      });
    const runs = await options.runService
      .lockActiveRunsForBudgetScopeInTransaction(transaction, {
        companyId: input.companyId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      });
    const requests = await requestLockedRunCancellationsInTransaction(
      transaction,
      {
        runs,
        reason,
        actor: input.actor,
        at,
        reasonKind: "lifecycle",
      },
    );
    return Object.freeze({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      reason,
      fence,
      requests,
    });
  }

  async function requestScopeCancellationsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly selector:
        | { readonly kind: "ownership_epoch"; readonly ownershipEpoch: number }
        | { readonly kind: "refs"; readonly refIds: readonly string[] };
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedScopedRunCancellations> {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.issueId, "issue id");
    const reason = boundedReason(input.reason, "execution_authority_revoked");
    const at = exactDate(input.now, "scope cancellation request time");
    const selector = input.selector.kind === "ownership_epoch"
      ? (() => {
          if (
            !Number.isSafeInteger(input.selector.ownershipEpoch) ||
            input.selector.ownershipEpoch < 1
          ) {
            reject("ownership epoch must be a positive integer");
          }
          return Object.freeze({
            kind: "ownership_epoch" as const,
            ownershipEpoch: input.selector.ownershipEpoch,
          });
        })()
      : (() => {
          const refIds = [...new Set(input.selector.refIds)];
          for (const refId of refIds) {
            exactIdentifier(refId, "execution ref id");
          }
          return Object.freeze({
            kind: "refs" as const,
            refIds: Object.freeze(refIds),
          });
        })();
    // Finalization owns the run row before it can publish a routed ref. Keep
    // the same run -> ref lock order here so the fence observes every ref
    // committed by a finalizer that was already in flight.
    const runs = await options.runService.lockActiveRunsForScopeInTransaction(
      transaction,
      selector.kind === "ownership_epoch"
        ? {
            companyId: input.companyId,
            issueId: input.issueId,
            ownershipEpoch: selector.ownershipEpoch,
          }
        : {
            companyId: input.companyId,
            issueId: input.issueId,
            refIds: selector.refIds,
          },
    );
    const fence = await options.settlement
      .fenceRevokedExecutionAuthorityInTransaction(
        transaction,
        selector.kind === "ownership_epoch"
          ? {
              companyId: input.companyId,
              selector: {
                kind: "ownership_epoch",
                issueId: input.issueId,
                ownershipEpoch: selector.ownershipEpoch,
              },
              reason,
              at,
            }
          : {
              companyId: input.companyId,
              selector: {
                kind: "refs",
                issueId: input.issueId,
                refIds: selector.refIds,
              },
              reason,
              at,
            },
      );
    const requests = await requestLockedRunCancellationsInTransaction(
      transaction,
      { runs, reason, actor: input.actor, at },
    );
    return Object.freeze({
      companyId: input.companyId,
      issueId: input.issueId,
      selector,
      reason,
      fence,
      requests,
    });
  }

  async function requestRunningIssueInterruptionsInTransaction(
    transaction: IssueSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
      readonly reason: string;
      readonly actor: IssueExecutionCancellationActor;
      readonly now: Date;
    },
  ): Promise<RequestedRunningIssueInterruptions> {
    exactIdentifier(input.companyId, "company id");
    exactIdentifier(input.issueId, "issue id");
    if (
      !Number.isSafeInteger(input.ownershipEpoch) ||
      input.ownershipEpoch < 1
    ) {
      reject("ownership epoch must be a positive integer");
    }
    const reason = boundedReason(input.reason, "issue_execution_paused");
    const at = exactDate(input.now, "running issue interruption time");
    const runs = await options.runService.lockActiveRunsForScopeInTransaction(
      transaction,
      {
        companyId: input.companyId,
        issueId: input.issueId,
        ownershipEpoch: input.ownershipEpoch,
      },
    );
    const requests = await requestLockedRunCancellationsInTransaction(
      transaction,
      {
        runs: runs.filter((run) => run.status === "running"),
        reason,
        actor: input.actor,
        at,
        reasonKind: "lifecycle",
      },
    );
    return Object.freeze({
      companyId: input.companyId,
      issueId: input.issueId,
      ownershipEpoch: input.ownershipEpoch,
      reason,
      requests,
    });
  }

  async function reconcileRequestedCancellations(requested: {
    readonly companyId: string;
    readonly requests: readonly RequestedRunCancellation[];
  }): Promise<readonly IssueExecutionCancellationResult[]> {
    exactIdentifier(requested.companyId, "company id");
    const results: IssueExecutionCancellationResult[] = [];
    for (const request of requested.requests) {
      if (request.companyId !== requested.companyId) {
        reject("cancellation bundle crossed its company");
      }
      if (request.state === "terminalized") {
        results.push(await terminalizedCancellationResult(
          options.pluginDomainEvents,
          request,
        ));
        continue;
      }
      if (request.cancellationIntentId === null) {
        reject("requested prompt cancellation lost its durable intent");
      }
      const result = await reconcileIntent(request.cancellationIntentId);
      if (!result || result.runId !== request.runId) {
        reject("cancellation reconciliation crossed its requested run");
      }
      results.push(result);
    }
    return Object.freeze(results);
  }

  async function reconcileAcknowledgedIntent(
    intent: CancellationRow,
  ): Promise<IssueExecutionCancellationResult> {
    const run = await options.runService.readRun({
      companyId: intent.companyId,
      issueId: intent.issueId,
      runId: intent.runId,
    });
    if (!run) reject("cancellation intent lost its canonical run");
    if (intent.reasonKind === "steering") {
      return {
        runId: run.runId,
        alreadyTerminal: false,
        cancellationIntentId: intent.id,
        state: intent.state,
      };
    }
    const [attemptRows, leaseRows] = await Promise.all([
      options.database
        .select()
        .from(issueExecutionAttempts)
        .where(eq(issueExecutionAttempts.id, intent.attemptId))
        .limit(2),
      intent.leaseId
        ? options.database
            .select()
            .from(issueExecutionLeases)
            .where(eq(issueExecutionLeases.id, intent.leaseId))
            .limit(2)
        : Promise.resolve([]),
    ]);
    if (attemptRows.length !== 1 || leaseRows.length > 1) {
      reject("cancellation intent has an ambiguous attempt or lease");
    }
    const attempt = attemptRows[0]!;
    const lease = leaseRows[0] ?? null;
    const signal = attemptSignal({ run, attempt, lease });
    if (signal) {
      options.dispatcher.signalAttemptCancellation(signal);
    }
    const workerActive = signal
      ? options.dispatcher.isAttemptActive(signal)
      : false;
    if (workerActive) {
      return {
        runId: run.runId,
        alreadyTerminal: false,
        cancellationIntentId: intent.id,
        state: "acknowledged",
      };
    }
    const reconciliationAt = now();
    const cancellationReason = `${intent.reasonKind}_cancellation`;
    const completion = await options.database.transaction((transaction) =>
      reconcileCompanyCancellationIntentInTx(transaction, {
        intentId: intent.id,
        now: reconciliationAt,
      }));
    if (!completion) {
      return {
        runId: run.runId,
        alreadyTerminal: false,
        cancellationIntentId: intent.id,
        state: "acknowledged",
      };
    }
    await options.settlement.terminalizeCancelledRun({
      companyId: intent.companyId,
      issueId: intent.issueId,
      runId: intent.runId,
      reason: cancellationReason,
      finishedAt: reconciliationAt,
    });
    if (completion.operation) {
      await options.database.transaction((transaction) =>
        reconcileCompanySessionLifecycleOperationInTx(transaction, {
          companyId: intent.companyId,
          lifecycleOperationId: completion.operation!.id,
          now: reconciliationAt,
        }));
    }
    return {
      runId: run.runId,
      alreadyTerminal: false,
      cancellationIntentId: intent.id,
      state: "completed",
    };
  }

  async function reconcileIntent(
    intentId: string,
  ): Promise<IssueExecutionCancellationResult | null> {
    exactIdentifier(intentId, "cancellation intent id");
    const initial = await options.database
      .select()
      .from(issueExecutionCancellationIntents)
      .where(eq(issueExecutionCancellationIntents.id, intentId))
      .limit(2);
    if (initial.length === 0) return null;
    if (initial.length !== 1) reject("cancellation intent identity is ambiguous");
    const intent = initial[0]!;
    if (intent.state === "completed" || intent.state === "failed") {
      return {
        runId: intent.runId,
        alreadyTerminal: intent.state === "completed",
        cancellationIntentId: intent.id,
        state: intent.state,
      };
    }
    const acknowledged = await options.database.transaction((transaction) =>
      acknowledgeCompanyCancellationIntentsInTx(transaction, {
        companyId: intent.companyId,
        intentIds: [intent.id],
        limit: 1,
        now: now(),
      }));
    if (acknowledged.length !== 1) return null;
    try {
      return await reconcileAcknowledgedIntent(acknowledged[0]!);
    } catch (error) {
      const failureCode = boundedReason(
        error instanceof Error ? error.message : String(error),
        "cancellation_reconcile_failed",
      );
      await options.database.transaction((transaction) =>
        failCompanyCancellationIntentInTx(transaction, {
          intentId: intent.id,
          failureCode,
          now: now(),
        }));
      throw error;
    }
  }

  async function cancelRun(
    runId: string,
    reason = "Issue execution was cancelled",
  ): Promise<IssueExecutionCancellationResult | null> {
    exactIdentifier(runId, "run id");
    const identity = await resolveIssueExecutionRunIdentityById(
      options.database,
      runId,
    );
    if (!identity) return null;
    const cancellationReason = boundedReason(reason, "authority_cancellation");
    const created = await options.database.transaction(async (transaction) => {
      const run = await options.runService.lockRun(transaction, identity);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return { kind: "terminal" as const, run };
      }
      return {
        kind: "request" as const,
        request: await processCancellableRun(transaction, run, {
          reason: cancellationReason,
          at: now(),
          reasonKind: "authority",
          actor: cancellationActorColumns({ kind: "system" }),
        }),
      };
    });
    if (created.kind === "terminal") {
      return {
        runId,
        alreadyTerminal: true,
        cancellationIntentId: null,
        state: "terminal",
      };
    }
    if (created.request.state === "terminalized") {
      const result = await terminalizedCancellationResult(
        options.pluginDomainEvents,
        created.request,
      );
      return { ...result, alreadyTerminal: false };
    }
    return reconcileIntent(created.request.cancellationIntentId);
  }

  async function cancelRunIds(runIds: readonly string[], reason: string) {
    const results = await Promise.all(
      [...new Set(runIds)].map((runId) => cancelRun(runId, reason)),
    );
    return results.filter(
      (result): result is IssueExecutionCancellationResult => result !== null,
    );
  }

  return Object.freeze({
    cancelRun,
    reconcileIntent,
    requestAgentCancellationsInTransaction,
    requestAgentSuspensionsInTransaction,
    requestBudgetScopeSuspensionInTransaction,
    requestRunningIssueInterruptionsInTransaction,
    requestScopeCancellationsInTransaction,
    reconcileRequestedCancellations,

    async reconcilePending(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const rows = await options.database
        .select({ id: issueExecutionCancellationIntents.id })
        .from(issueExecutionCancellationIntents)
        .where(
          and(
            inArray(issueExecutionCancellationIntents.state, ["requested", "acknowledged"]),
            inArray(issueExecutionCancellationIntents.reasonKind, [
              "lifecycle",
              "authority",
              "timeout",
              "lease_expired",
            ]),
          ),
        )
        .limit(boundedLimit);
      const results = [];
      for (const row of rows) results.push(await reconcileIntent(row.id));
      return results.filter(
        (result): result is IssueExecutionCancellationResult => result !== null,
      );
    },

    async reconcileCompanyLifecycle(input: {
      companyId: string;
      lifecycleOperationId: string;
      intentIds: readonly string[];
      runIds: readonly string[];
    }) {
      for (const intentId of input.intentIds) await reconcileIntent(intentId);
      for (const runId of input.runIds) {
        const identity = await resolveIssueExecutionRunIdentityById(options.database, runId);
        if (!identity || identity.companyId !== input.companyId) continue;
        const run = await options.runService.readRun(identity);
        if (
          run &&
          !TERMINAL_RUN_STATUSES.has(run.status) &&
          run.currentAttemptId === null &&
          run.currentLeaseId === null &&
          run.cancellationIntentId === null
        ) {
          await options.settlement.terminalizeCancelledRun({
            ...identity,
            reason: "lifecycle_cancellation",
            finishedAt: now(),
          });
        }
      }
      return options.database.transaction((transaction) =>
        reconcileCompanySessionLifecycleOperationInTx(transaction, {
          companyId: input.companyId,
          lifecycleOperationId: input.lifecycleOperationId,
          now: now(),
        }));
    },

    async suspendBudgetScopeWork(scope: {
      companyId: string;
      scopeType: "company" | "project" | "agent";
      scopeId: string;
    }) {
      const requested = await options.database.transaction((transaction) =>
        requestBudgetScopeSuspensionInTransaction(transaction, {
          ...scope,
          reason: "budget_hard_stop",
          actor: { kind: "system" },
          now: now(),
      }));
      const settlements =
        await reconcileRequestedCancellations(requested);
      return { requested, settlements };
    },

    async drainRunningRunsForShutdown(signal = "paperclip_worker_shutdown") {
      const companyRows = await options.database
        .select({ id: companies.id })
        .from(companies);
      const results = [];
      for (const company of companyRows) {
        const runs = await pageActiveRuns(options.runService, company.id);
        results.push(...await cancelRunIds(
          runs.map((run) => run.runId),
          signal,
        ));
      }
      return results;
    },
  });
}

export type IssueExecutionCancellationService = ReturnType<
  typeof createIssueExecutionCancellationService
>;
