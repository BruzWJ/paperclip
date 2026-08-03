import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { EnvironmentRunOrchestrator } from "./environment-run-orchestrator.js";
import {
  createIssueExecutionAttemptExecutor,
  createIssueExecutionMentionExecutor,
  type IssueExecutionMentionExecutor,
} from "./issue-execution-attempt-executor.js";
import { createPostgresIssueExecutionAcpEventSink } from "./issue-execution-acp-events-postgres.js";
import { createIssueExecutionCancellationService } from "./issue-execution-cancellation.js";
import {
  createIssueExecutionDispatcher,
  type IssueExecutionDispatcher,
} from "./issue-execution-dispatcher.js";
import {
  createPostgresIssueExecutionDispatcherRepository,
  projectPersistedIssueExecutionRef,
} from "./issue-execution-dispatcher-postgres.js";
import { createPostgresIssueExecutionFinalizationWriter } from "./issue-execution-finalization-postgres.js";
import { createIssueLivenessReconciliationService } from "./issue-liveness-reconciliation.js";
import { createPostgresIssueExecutionPromptCycleRepository } from "./issue-execution-prompt-cycle-postgres.js";
import { createIssueExecutionTargetAcquirer } from "./issue-execution-provider-configuration.js";
import { createPostgresIssueExecutionSteeringRepository } from "./issue-execution-run-postgres.js";
import { createIssueExecutionRunService } from "./issue-execution-run-service.js";
import type { IssueExecutionSteeringResultBroker } from "./issue-execution-steering-results.js";
import { createPostgresIssueSessionTargetNotFoundRecovery } from "./issue-session-recovery-postgres.js";
import {
  createPostgresIssueSessionCompactionRuntime,
  type PostgresIssueSessionCompactionRuntime,
} from "./issue-session-compaction-postgres.js";
import type { createPostgresSessionCompactionProvider } from "./issue-session-compaction-provider.js";
import type { IssueSessionStore } from "./issue-session/store.js";
import { createAuthenticatedNativeCorrelationProtector } from "./native-correlation-postgres.js";
import { createNativeCorrelationService } from "./native-correlation.js";
import {
  createPostgresPromptCapabilityRuntime,
  type PostgresPromptCapabilityRuntime,
} from "./run-interface-runtime.js";
import type {
  RuntimeActionPort,
  RuntimeCompanyToolPort,
} from "./runtime-tool-executor.js";

export interface PostgresIssueExecutionProductionRuntimeOptions {
  readonly workerId: string;
  readonly targetSessionProtectionSecret: string | Uint8Array;
  readonly issueSessionStore: IssueSessionStore;
  readonly environmentOrchestrator: Pick<
    EnvironmentRunOrchestrator,
    "acquireExecutionTargetForRun"
  >;
  readonly capabilityEndpoint: string;
  readonly capabilityCursorSecret: string;
  readonly actions: RuntimeActionPort;
  readonly companyTools: RuntimeCompanyToolPort;
  readonly steeringResults: IssueExecutionSteeringResultBroker;
  readonly prepareAndNotifyPersistedRef: (
    refId: string,
    dispatcher: IssueExecutionDispatcher,
  ) => Promise<void>;
  /**
   * The provider boundary resolves and executes the configured compaction
   * model. The production assembly owns the durable compaction runtime so it
   * shares this worker, run service, and finalization writer.
   */
  readonly compactionProvider: ReturnType<
    typeof createPostgresSessionCompactionProvider
  >;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseTtlMs?: number;
}

export interface PostgresIssueExecutionProductionRuntime {
  readonly runService: ReturnType<typeof createIssueExecutionRunService>;
  readonly promptCapabilities: PostgresPromptCapabilityRuntime;
  readonly repository: ReturnType<
    typeof createPostgresIssueExecutionDispatcherRepository
  >;
  readonly attemptExecutor: ReturnType<
    typeof createIssueExecutionAttemptExecutor
  >;
  readonly dispatcher: IssueExecutionDispatcher;
  readonly targetSessionAcquirer: ReturnType<
    typeof createIssueExecutionTargetAcquirer
  >;
  readonly eventProjector: ReturnType<
    typeof createPostgresIssueExecutionAcpEventSink
  >;
  readonly mentionExecutor: IssueExecutionMentionExecutor;
  readonly cancellation: ReturnType<
    typeof createIssueExecutionCancellationService
  >;
  readonly finalizer: ReturnType<
    typeof createPostgresIssueExecutionFinalizationWriter
  >;
  readonly liveness: ReturnType<
    typeof createIssueLivenessReconciliationService
  >;
  readonly compaction: PostgresIssueSessionCompactionRuntime;
}

/**
 * Sole production assembly for issue execution. Every provider prompt is a
 * fresh ACP subprocess attempt; PostgreSQL owns the run/control/attempt/lease,
 * capability, target-session correlation, Session projection, and settlement.
 */
export function createPostgresIssueExecutionProductionRuntime(
  database: Db,
  options: PostgresIssueExecutionProductionRuntimeOptions,
): PostgresIssueExecutionProductionRuntime {
  if (!options.workerId.trim()) {
    throw new Error("Issue-execution worker identity is required");
  }
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  let dispatcher: IssueExecutionDispatcher | null = null;
  let mentionExecutor: IssueExecutionMentionExecutor | null = null;
  let cancellation: ReturnType<
    typeof createIssueExecutionCancellationService
  > | null = null;

  const steeringRepository = createPostgresIssueExecutionSteeringRepository(
    database,
    { now, idFactory },
  );
  const runService = createIssueExecutionRunService({
    database,
    issueSessionStore: options.issueSessionStore,
    repository: steeringRepository,
    cancellation: {
      signalAttemptCancellation(input) {
        return Boolean(
          dispatcher?.signalAttemptCancellation(input) ||
            mentionExecutor?.signalAttemptCancellation(input),
        );
      },
    },
    resume: {
      async resumeSteering(input) {
        const run = await runService.readRun({
          companyId: input.companyId,
          issueId: input.issueId,
          runId: input.runId,
        });
        if (
          !run ||
          run.status !== "running" ||
          run.ownershipEpoch !== input.ownershipEpoch ||
          run.targetAgentId !== input.targetAgentId
        ) {
          throw new Error("Steering resume lost its canonical active run");
        }
        if (run.executionMode === "consult") {
          if (!mentionExecutor) {
            throw new Error("Issue-execution mention executor is not initialized");
          }
          if (!mentionExecutor.notifySteeringResumed(input)) {
            throw new Error("Steering resume lost its active consult executor");
          }
          return;
        }
        if (run.executionMode !== "owner" || !dispatcher) {
          throw new Error("Issue-execution dispatcher is not initialized");
        }
        await dispatcher.notifyPersistedRef(input.refId);
      },
    },
    steeringResults: options.steeringResults,
  });
  const promptCapabilities = createPostgresPromptCapabilityRuntime(database, {
    runService,
    cursorSecret: options.capabilityCursorSecret,
    actions: options.actions,
    companyTools: options.companyTools,
    now,
  });
  const liveness = createIssueLivenessReconciliationService(database, {
    runService,
    now,
    idFactory,
    postCommit: {
      async dispatchFollowup(work) {
        if (work.kind === "owner_followup") {
          if (!dispatcher) {
            throw new Error("Issue-execution dispatcher is not initialized");
          }
          await options.prepareAndNotifyPersistedRef(
            work.refId,
            dispatcher,
          );
          return;
        }
        if (!mentionExecutor) {
          throw new Error("Issue-execution mention executor is not initialized");
        }
        await mentionExecutor.executeMention({
          companyId: work.consult.companyId,
          issueId: work.consult.issueId,
          sessionId: work.consult.sessionId,
          ownershipEpoch: work.consult.ownershipEpoch,
          consultExecutionId: work.consult.id,
          sourceRunId: work.consult.sourceRunId,
          sourceRefId: work.consult.sourceRefId,
          targetAgentId: work.consult.targetAgentId,
          adapterConfigRevisionId:
            work.consult.adapterConfigRevisionId,
          chainToken: work.consult.chainToken,
          ref: projectPersistedIssueExecutionRef(work.ref),
        });
      },
      async notifyAttention() {
        // Attention is a read derivation of the committed reconciliation.
        // No second durable item, queue, or provider invocation is created.
      },
    },
  });
  const finalizer = createPostgresIssueExecutionFinalizationWriter({
    database,
    runService,
    liveness,
  });
  const repository = createPostgresIssueExecutionDispatcherRepository({
    database,
    runService,
    compiler: promptCapabilities.compiler,
    finalizer,
    leaseTtlMs: options.leaseTtlMs,
    now,
    idFactory,
  });
  const compaction = createPostgresIssueSessionCompactionRuntime(database, {
    workerId: options.workerId,
    ...options.compactionProvider,
    finalizationWriter: finalizer,
    blockedPromptFailure: repository,
    budgetHooks: {
      async suspendWorkForScope(scope) {
        if (!cancellation) {
          throw new Error("Issue-execution cancellation is not initialized");
        }
        await cancellation.suspendBudgetScopeWork(scope);
      },
      async resumeWorkForScope(scope) {
        if (!cancellation) {
          throw new Error("Issue-execution cancellation is not initialized");
        }
        await cancellation.resumeBudgetScopeWork(scope);
      },
    },
    now,
    idFactory,
  });
  const targetSessionAcquirer = createIssueExecutionTargetAcquirer({
    environmentOrchestrator: options.environmentOrchestrator,
  });
  const targetSessions = createNativeCorrelationService({
    protector: createAuthenticatedNativeCorrelationProtector({
      secret: options.targetSessionProtectionSecret,
    }),
  });
  const eventProjector = createPostgresIssueExecutionAcpEventSink({
    database,
    runService,
    now,
  });
  const recovery = createPostgresIssueSessionTargetNotFoundRecovery(database, {
    compaction,
    idFactory,
  });
  const promptCycle = createPostgresIssueExecutionPromptCycleRepository({
    database,
    runService,
    compiler: promptCapabilities.compiler,
    capabilityEndpoint: options.capabilityEndpoint,
    leaseTtlMs: options.leaseTtlMs,
    now,
    idFactory,
    async suspendBudgetScopes(scopes) {
      if (!cancellation) {
        throw new Error("Issue-execution cancellation is not initialized");
      }
      for (const scope of scopes) {
        await cancellation.suspendBudgetScopeWork(scope);
      }
    },
  });
  const attemptExecutor = createIssueExecutionAttemptExecutor({
    repository: promptCycle,
    targetAcquirer: targetSessionAcquirer,
    sessionCorrelations: targetSessions,
    recovery,
    events: eventProjector,
  });
  dispatcher = createIssueExecutionDispatcher({
    repository,
    executor: attemptExecutor,
    steeringResults: options.steeringResults,
    workerId: options.workerId,
    now,
  });
  mentionExecutor = createIssueExecutionMentionExecutor({
    workerId: options.workerId,
    repository,
    executor: attemptExecutor,
    steeringResults: options.steeringResults,
    async notifyReleasedConsultRef(refId) {
      if (!dispatcher) {
        throw new Error("Issue-execution dispatcher is not initialized");
      }
      await dispatcher.notifyReleasedConsultRef(refId);
    },
    now,
  });
  cancellation = createIssueExecutionCancellationService({
    database,
    runService,
    dispatcher,
    compaction,
    settlement: repository,
    now,
    idFactory,
  });

  return Object.freeze({
    runService,
    promptCapabilities,
    repository,
    attemptExecutor,
    dispatcher,
    targetSessionAcquirer,
    eventProjector,
    mentionExecutor,
    cancellation,
    finalizer,
    liveness,
    compaction,
  });
}
