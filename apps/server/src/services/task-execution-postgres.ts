import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { LocalExecutionOrchestrator } from "./local-execution-orchestrator.js";
import { createTaskExecutionAttemptExecutor } from "./task-execution-attempt-executor.js";
import { createPostgresTaskExecutionAcpEventSink } from "./task-execution-acp-events-postgres.js";
import { createTaskExecutionCancellationService } from "./task-execution-cancellation.js";
import { createTaskExecutionDispatcher, type TaskExecutionDispatcher } from "./task-execution-dispatcher.js";
import { createPostgresTaskExecutionDispatcherRepository } from "./task-execution-dispatcher-postgres.js";
import { createPostgresTaskExecutionFinalizationWriter } from "./task-execution-finalization-postgres.js";
import { createPostgresTaskExecutionPromptCycleRepository } from "./task-execution-prompt-cycle-postgres.js";
import { createTaskExecutionTargetAcquirer } from "./task-execution-provider-configuration.js";
import { createPostgresTaskExecutionSteeringRepository } from "./task-execution-run-postgres.js";
import { createTaskExecutionRunService } from "./task-execution-run-service.js";
import type { TaskExecutionSteeringResultBroker } from "./task-execution-steering-results.js";
import type { TaskSessionStore } from "./task-session/store.js";
import { createAuthenticatedNativeCorrelationProtector } from "./native-correlation-postgres.js";
import { createNativeCorrelationService } from "./native-correlation.js";
import {
  createPostgresPromptCapabilityRuntime,
  type PostgresPromptCapabilityRuntime,
} from "./run-interface-runtime.js";
import type { RuntimePluginToolPort } from "./runtime-tool-gateway.js";
import type { PaperclipManagedToolRouter } from "./paperclip-managed-tool-router.js";
import type { PluginBeforePromptDispatcher } from "./plugin-before-prompt-dispatcher.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";

export interface PostgresTaskExecutionProductionRuntimeOptions {
  readonly workerId: string;
  readonly targetSessionProtectionSecret: string | Uint8Array;
  readonly taskSessionStore: TaskSessionStore;
  readonly localExecutionOrchestrator: Pick<LocalExecutionOrchestrator, "acquireExecutionTargetForRun">;
  readonly capabilityEndpoint: string;
  readonly capabilityCursorSecret: string;
  readonly managedTools: PaperclipManagedToolRouter;
  readonly pluginTools: RuntimePluginToolPort;
  /** App-owned, awaited post-commit plugin event publisher. */
  readonly pluginDomainEvents: PluginDomainEventPublisher;
  /** Generic blocking plugin lifecycle run before every provider prompt. */
  readonly beforePrompt: PluginBeforePromptDispatcher;
  readonly steeringResults: TaskExecutionSteeringResultBroker;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseTtlMs?: number;
  readonly dispatchRef?: (refId: string) => Promise<void>;
}

export interface PostgresTaskExecutionProductionRuntime {
  readonly runService: ReturnType<typeof createTaskExecutionRunService>;
  readonly promptCapabilities: PostgresPromptCapabilityRuntime;
  readonly repository: ReturnType<typeof createPostgresTaskExecutionDispatcherRepository>;
  readonly attemptExecutor: ReturnType<typeof createTaskExecutionAttemptExecutor>;
  readonly dispatcher: TaskExecutionDispatcher;
  readonly targetSessionAcquirer: ReturnType<typeof createTaskExecutionTargetAcquirer>;
  readonly eventProjector: ReturnType<typeof createPostgresTaskExecutionAcpEventSink>;
  readonly cancellation: ReturnType<typeof createTaskExecutionCancellationService>;
  readonly finalizer: ReturnType<typeof createPostgresTaskExecutionFinalizationWriter>;
}

/**
 * Sole production assembly for task execution. Every provider prompt is a
 * fresh ACPX runtime attempt; PostgreSQL owns the run/control/attempt/lease,
 * capability, target-session correlation, Session projection, and settlement.
 */
export function createPostgresTaskExecutionProductionRuntime(
  database: Db,
  options: PostgresTaskExecutionProductionRuntimeOptions,
): PostgresTaskExecutionProductionRuntime {
  if (!options.workerId.trim()) {
    throw new Error("Task-execution worker identity is required");
  }
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  let dispatcher: TaskExecutionDispatcher | null = null;
  let cancellation: ReturnType<typeof createTaskExecutionCancellationService> | null = null;

  const steeringRepository = createPostgresTaskExecutionSteeringRepository(database, { now, idFactory });
  const runService = createTaskExecutionRunService({
    database,
    taskSessionStore: options.taskSessionStore,
    repository: steeringRepository,
    cancellation: {
      signalAttemptCancellation(input) {
        return Boolean(dispatcher?.signalAttemptCancellation(input));
      },
    },
    resume: {
      async resumeSteering(input) {
        const run = await runService.readRun({
          companyId: input.companyId,
          taskId: input.taskId,
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
          throw new Error("Task-execution dispatcher is not initialized");
        }
        await dispatcher.notifyPersistedRef(input.refId);
      },
    },
    steeringResults: options.steeringResults,
  });
  const promptCapabilities = createPostgresPromptCapabilityRuntime(database, {
    runService,
    cursorSecret: options.capabilityCursorSecret,
    taskSessionStore: options.taskSessionStore,
    managedTools: options.managedTools,
    pluginTools: options.pluginTools,
    now,
  });
  const finalizer = createPostgresTaskExecutionFinalizationWriter({
    database,
    runService,
  });
  const repository = createPostgresTaskExecutionDispatcherRepository({
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
  const targetSessionAcquirer = createTaskExecutionTargetAcquirer({
    localExecutionOrchestrator: options.localExecutionOrchestrator,
  });
  const targetSessions = createNativeCorrelationService({
    protector: createAuthenticatedNativeCorrelationProtector({
      secret: options.targetSessionProtectionSecret,
    }),
  });
  const eventProjector = createPostgresTaskExecutionAcpEventSink({
    database,
    runService,
    now,
  });
  const promptCycle = createPostgresTaskExecutionPromptCycleRepository({
    database,
    runService,
    compiler: promptCapabilities.compiler,
    capabilityEndpoint: options.capabilityEndpoint,
    leaseTtlMs: options.leaseTtlMs,
    idFactory,
    async suspendBudgetScopes(scopes) {
      if (!cancellation) {
        throw new Error("Task-execution cancellation is not initialized");
      }
      for (const scope of scopes) {
        await cancellation.suspendBudgetScopeWork(scope);
      }
    },
  });
  const attemptExecutor = createTaskExecutionAttemptExecutor({
    repository: promptCycle,
    beforePrompt: options.beforePrompt,
    targetAcquirer: targetSessionAcquirer,
    sessionCorrelations: targetSessions,
    events: eventProjector,
  });
  dispatcher = createTaskExecutionDispatcher({
    repository,
    executor: attemptExecutor,
    steeringResults: options.steeringResults,
    workerId: options.workerId,
    now,
  });
  cancellation = createTaskExecutionCancellationService({
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
