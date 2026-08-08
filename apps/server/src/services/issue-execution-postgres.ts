import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { EnvironmentRunOrchestrator } from "./environment-run-orchestrator.js";
import { createIssueExecutionAttemptExecutor } from "./issue-execution-attempt-executor.js";
import { createPostgresIssueExecutionAcpEventSink } from "./issue-execution-acp-events-postgres.js";
import { createIssueExecutionCancellationService } from "./issue-execution-cancellation.js";
import {
  createIssueExecutionDispatcher,
  type IssueExecutionDispatcher,
} from "./issue-execution-dispatcher.js";
import {
  createPostgresIssueExecutionDispatcherRepository,
} from "./issue-execution-dispatcher-postgres.js";
import { createPostgresIssueExecutionFinalizationWriter } from "./issue-execution-finalization-postgres.js";
import { createPostgresIssueExecutionPromptCycleRepository } from "./issue-execution-prompt-cycle-postgres.js";
import { createIssueExecutionTargetAcquirer } from "./issue-execution-provider-configuration.js";
import { createPostgresIssueExecutionSteeringRepository } from "./issue-execution-run-postgres.js";
import { createIssueExecutionRunService } from "./issue-execution-run-service.js";
import type { IssueExecutionSteeringResultBroker } from "./issue-execution-steering-results.js";
import type { IssueSessionStore } from "./issue-session/store.js";
import { createAuthenticatedNativeCorrelationProtector } from "./native-correlation-postgres.js";
import { createNativeCorrelationService } from "./native-correlation.js";
import {
  createPostgresPromptCapabilityRuntime,
  type PostgresPromptCapabilityRuntime,
} from "./run-interface-runtime.js";
import type {
  RuntimePluginToolPort,
} from "./runtime-tool-gateway.js";
import type { PaperclipManagedToolRouter } from "./paperclip-managed-tool-router.js";
import type { PluginBeforePromptDispatcher } from "./plugin-before-prompt-dispatcher.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";

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
  readonly managedTools: PaperclipManagedToolRouter;
  readonly pluginTools: RuntimePluginToolPort;
  /** App-owned, awaited post-commit plugin event publisher. */
  readonly pluginDomainEvents: PluginDomainEventPublisher;
  /** Generic blocking plugin lifecycle run before every provider prompt. */
  readonly beforePrompt: PluginBeforePromptDispatcher;
  readonly steeringResults: IssueExecutionSteeringResultBroker;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseTtlMs?: number;
  readonly dispatchRef?: (refId: string) => Promise<void>;
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
  readonly cancellation: ReturnType<
    typeof createIssueExecutionCancellationService
  >;
  readonly finalizer: ReturnType<
    typeof createPostgresIssueExecutionFinalizationWriter
  >;
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
          dispatcher?.signalAttemptCancellation(input),
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
        if (!dispatcher) {
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
    issueSessionStore: options.issueSessionStore,
    managedTools: options.managedTools,
    pluginTools: options.pluginTools,
    now,
  });
  const finalizer = createPostgresIssueExecutionFinalizationWriter({
    database,
    runService,
  });
  const repository = createPostgresIssueExecutionDispatcherRepository({
    database,
    runService,
    compiler: promptCapabilities.compiler,
    finalizer,
    leaseTtlMs: options.leaseTtlMs,
    now,
    idFactory,
    pluginDomainEvents: options.pluginDomainEvents,
    dispatchRef: options.dispatchRef,
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
    beforePrompt: options.beforePrompt,
    targetAcquirer: targetSessionAcquirer,
    sessionCorrelations: targetSessions,
    events: eventProjector,
  });
  dispatcher = createIssueExecutionDispatcher({
    repository,
    executor: attemptExecutor,
    steeringResults: options.steeringResults,
    workerId: options.workerId,
    now,
  });
  cancellation = createIssueExecutionCancellationService({
    database,
    runService,
    dispatcher,
    settlement: repository,
    now,
    idFactory,
    pluginDomainEvents: options.pluginDomainEvents,
  });

  return Object.freeze({
    runService,
    promptCapabilities,
    repository,
    attemptExecutor,
    dispatcher,
    targetSessionAcquirer,
    eventProjector,
    cancellation,
    finalizer,
  });
}
